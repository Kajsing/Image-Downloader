const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const backgroundSource = fs.readFileSync(
  path.join(__dirname, '..', 'background.js'),
  'utf8'
);
const downloadUtilsSource = fs.readFileSync(
  path.join(__dirname, '..', 'download-utils.js'),
  'utf8'
);

function createHarness(options = {}) {
  const sessionStore = options.sessionStore || {};
  const runtimeMessages = [];
  const downloadCalls = [];
  const downloadCallbacks = [];
  const cancelCalls = [];
  const downloadStates = options.downloadStates || {};
  let messageListener = null;
  let downloadChangedListener = null;
  let nextDownloadId = Math.max(0, ...Object.keys(downloadStates).map(Number).filter(Number.isFinite)) + 1;

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      },
      sendMessage(message, callback) {
        runtimeMessages.push(message);
        callback?.();
      }
    },
    downloads: {
      onChanged: {
        addListener(listener) {
          downloadChangedListener = listener;
        }
      },
      download(downloadOptions, callback) {
        downloadCalls.push(downloadOptions);
        downloadCallbacks.push(callback);
        if (!options.delayDownloadCallback) {
          const downloadId = nextDownloadId++;
          downloadStates[downloadId] = { id: downloadId, state: 'in_progress' };
          callback(downloadId);
        }
      },
      cancel(downloadId, callback) {
        cancelCalls.push(downloadId);
        if (downloadStates[downloadId]?.state !== 'complete') {
          downloadStates[downloadId] = { id: downloadId, state: 'interrupted' };
        }
        callback?.();
      },
      search(query, callback) {
        callback(downloadStates[query.id] ? [downloadStates[query.id]] : []);
      }
    },
    declarativeNetRequest: {
      updateSessionRules(_rules, callback) {
        callback?.();
      }
    },
    storage: {
      session: {
        get(key, callback) {
          callback(key === null ? { ...sessionStore } : { [key]: sessionStore[key] });
        },
        set(values, callback) {
          Object.assign(sessionStore, values);
          callback?.();
        },
        remove(key, callback) {
          delete sessionStore[key];
          callback?.();
        }
      }
    }
  };

  const context = vm.createContext({
    AbortController,
    URL,
    Uint8Array,
    btoa(value) {
      return Buffer.from(value, 'binary').toString('base64');
    },
    chrome,
    clearTimeout,
    fetch,
    setTimeout(callback, delay) {
      if (options.pauseWorkerTimers) {
        return { unref() {} };
      }
      const timeout = setTimeout(callback, delay);
      timeout.unref();
      return timeout;
    }
  });
  context.importScripts = (filename) => {
    if (filename !== 'download-utils.js') {
      throw new Error(`Unexpected import: ${filename}`);
    }
    vm.runInContext(downloadUtilsSource, context, { filename });
  };
  vm.runInContext(backgroundSource, context, { filename: 'background.js' });

  async function sendMessage(request) {
    return new Promise((resolve) => {
      const keepChannelOpen = messageListener(request, {}, resolve);
      if (keepChannelOpen !== true && request.action !== 'fetchPximgPreview') {
        return;
      }
    });
  }

  return {
    cancelCalls,
    downloadCallbacks,
    downloadCalls,
    runtimeMessages,
    sessionStore,
    sendMessage,
    triggerDownloadChanged(delta) {
      if (delta.state?.current) {
        downloadStates[delta.id] = { id: delta.id, state: delta.state.current };
      }
      downloadChangedListener(delta);
    }
  };
}

function mediaItem(id) {
  return {
    id,
    url: `https://example.test/media/${id}.jpg`,
    type: 'image',
    extension: 'jpg',
    filename: `${id}.jpg`
  };
}

test('abort cancels active work, clears pending work, and suppresses retries', async () => {
  const harness = createHarness();
  const sessionId = 'download_abort_queue';
  const items = Array.from({ length: 200 }, (_, index) => mediaItem(`item-${index + 1}`));

  await harness.sendMessage({
    action: 'downloadSelectedMedia',
    sessionId,
    page: { host: 'example.test', url: 'https://example.test/thread/1' },
    downloadSettings: { speedMode: 'normal' },
    items
  });

  assert.equal(harness.downloadCalls.length, 1);

  const response = await harness.sendMessage({
    action: 'cancelDownloadSession',
    sessionId
  });

  assert.equal(response.cancelled, true);
  assert.equal(response.cancelledCount, 200);
  assert.deepEqual(harness.cancelCalls, [1]);

  harness.triggerDownloadChanged({
    id: 1,
    state: { current: 'interrupted' }
  });

  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(harness.downloadCalls.length, 1);
  assert.equal(
    harness.runtimeMessages.some((message) => message.status === 'retry'),
    false
  );
});

test('an aborted session rejects late page batches', async () => {
  const harness = createHarness();
  const sessionId = 'download_late_batch';

  await harness.sendMessage({ action: 'cancelDownloadSession', sessionId });
  const response = await harness.sendMessage({
    action: 'downloadSelectedMedia',
    sessionId,
    page: { host: 'example.test', url: 'https://example.test/thread/2' },
    items: [mediaItem('late')]
  });

  assert.equal(response.cancelled, true);
  assert.equal(harness.downloadCalls.length, 0);
});

test('a download id returned after abort is cancelled immediately', async () => {
  const harness = createHarness({ delayDownloadCallback: true });
  const sessionId = 'download_callback_race';

  await harness.sendMessage({
    action: 'downloadSelectedMedia',
    sessionId,
    page: { host: 'example.test', url: 'https://example.test/thread/3' },
    items: [mediaItem('race')]
  });
  const response = await harness.sendMessage({ action: 'cancelDownloadSession', sessionId });

  harness.downloadCallbacks[0](77);
  assert.deepEqual(Array.from(response.cancelledItemIds), ['race']);
  assert.deepEqual(harness.cancelCalls, [77]);
});

test('abort restores active download ids after a service worker restart', async () => {
  const sessionStore = {};
  const downloadStates = {};
  const firstWorker = createHarness({ sessionStore, downloadStates });
  const sessionId = 'download_worker_restart';

  await firstWorker.sendMessage({
    action: 'downloadSelectedMedia',
    sessionId,
    page: { host: 'example.test', url: 'https://example.test/thread/4' },
    items: [mediaItem('persisted')]
  });

  const restartedWorker = createHarness({ sessionStore, downloadStates });
  const response = await restartedWorker.sendMessage({
    action: 'cancelDownloadSession',
    sessionId
  });

  assert.equal(response.cancelled, true);
  assert.deepEqual(restartedWorker.cancelCalls, [1]);
});

test('popup can rediscover an active session after a service worker restart', async () => {
  const sessionStore = {};
  const downloadStates = {};
  const firstWorker = createHarness({ sessionStore, downloadStates });
  const sessionId = 'download_status_restart';

  await firstWorker.sendMessage({
    action: 'downloadSelectedMedia',
    sessionId,
    page: { host: 'example.test', url: 'https://example.test/thread/5' },
    items: [mediaItem('active')]
  });

  const restartedWorker = createHarness({ sessionStore, downloadStates });
  const response = await restartedWorker.sendMessage({
    action: 'getDownloadSessionStatus',
    sessionId
  });

  assert.equal(response.active, true);
  assert.equal(response.status, 'downloading');
});

test('a file completed immediately before abort remains completed', async () => {
  const harness = createHarness();
  const sessionId = 'download_complete_abort_race';

  await harness.sendMessage({
    action: 'downloadSelectedMedia',
    sessionId,
    page: { host: 'example.test', url: 'https://example.test/thread/6' },
    downloadSettings: { speedMode: 'normal' },
    items: [mediaItem('complete'), mediaItem('pending')]
  });

  harness.triggerDownloadChanged({ id: 1, state: { current: 'complete' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const response = await harness.sendMessage({ action: 'cancelDownloadSession', sessionId });

  assert.deepEqual(Array.from(response.completedItemIds), ['complete']);
  assert.deepEqual(Array.from(response.cancelledItemIds), ['pending']);
});

test('duplicate terminal events are emitted only once', async () => {
  const harness = createHarness();
  const sessionId = 'download_duplicate_terminal';

  await harness.sendMessage({
    action: 'downloadSelectedMedia',
    sessionId,
    page: { host: 'example.test', url: 'https://example.test/thread/7' },
    items: [mediaItem('once')]
  });

  harness.triggerDownloadChanged({ id: 1, state: { current: 'complete' } });
  harness.triggerDownloadChanged({ id: 1, state: { current: 'complete' } });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(
    harness.runtimeMessages.filter((message) => message.status === 'complete').length,
    1
  );
});

test('abort classifies a completed download even if its active record raced away', async () => {
  const sessionStore = {};
  const downloadStates = {};
  const firstWorker = createHarness({ sessionStore, downloadStates });
  const sessionId = 'download_persisted_complete_race';

  await firstWorker.sendMessage({
    action: 'downloadSelectedMedia',
    sessionId,
    page: { host: 'example.test', url: 'https://example.test/thread/8' },
    items: [mediaItem('raced-complete')]
  });

  delete sessionStore.guided_download_active_1;
  downloadStates[1] = { id: 1, state: 'complete' };
  const restartedWorker = createHarness({ sessionStore, downloadStates });
  const response = await restartedWorker.sendMessage({ action: 'cancelDownloadSession', sessionId });

  assert.deepEqual(Array.from(response.completedItemIds), ['raced-complete']);
  assert.deepEqual(Array.from(response.cancelledItemIds), []);
});

test('recoverable pending items resume after a service worker restart', async () => {
  const sessionStore = {};
  const downloadStates = {};
  const firstWorker = createHarness({ sessionStore, downloadStates, pauseWorkerTimers: true });
  const sessionId = 'download_pending_restart';

  await firstWorker.sendMessage({
    action: 'downloadSelectedMedia',
    sessionId,
    page: { host: 'example.test', url: 'https://example.test/thread/9' },
    downloadSettings: { speedMode: 'normal' },
    items: [mediaItem('active'), mediaItem('resume-one'), mediaItem('resume-two')]
  });

  assert.equal(sessionStore[`guided_download_session_${sessionId}`].pendingItems.length, 2);

  const restartedWorker = createHarness({ sessionStore, downloadStates });
  await restartedWorker.sendMessage({ action: 'getDownloadSessionStatus', sessionId });
  restartedWorker.triggerDownloadChanged({ id: 1, state: { current: 'complete' } });
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(restartedWorker.downloadCalls.length, 2);
  assert.match(restartedWorker.downloadCalls[0].url, /resume-one\.jpg$/);
  assert.match(restartedWorker.downloadCalls[1].url, /resume-two\.jpg$/);
});

test('an indeterminate launch is not duplicated after a service worker restart', async () => {
  const sessionStore = {};
  const downloadStates = {};
  const firstWorker = createHarness({
    sessionStore,
    downloadStates,
    delayDownloadCallback: true
  });
  const sessionId = 'download_launching_restart';

  await firstWorker.sendMessage({
    action: 'downloadSelectedMedia',
    sessionId,
    page: { host: 'example.test', url: 'https://example.test/thread/10' },
    items: [mediaItem('indeterminate')]
  });

  const snapshot = sessionStore[`guided_download_session_${sessionId}`];
  assert.deepEqual(Array.from(snapshot.launchingItemIds), ['indeterminate']);

  const restartedWorker = createHarness({ sessionStore, downloadStates });
  const response = await restartedWorker.sendMessage({
    action: 'getDownloadSessionStatus',
    sessionId
  });

  assert.equal(restartedWorker.downloadCalls.length, 0);
  assert.deepEqual(Array.from(response.failedItemIds), ['indeterminate']);
});
