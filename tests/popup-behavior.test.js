const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const popupSource = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
const DownloadUtils = require('../download-utils.js');
const PopupState = require('../popup-state.js');

function createPopupContext() {
  const context = vm.createContext({
    console,
    document: {
      addEventListener() {},
      getElementById() {
        return {};
      }
    },
    DownloadUtils,
    PopupState,
    URL,
    URLSearchParams
  });
  vm.runInContext(popupSource, context, { filename: 'popup.js' });
  return context;
}

function evaluate(context, source) {
  return vm.runInContext(source, context);
}

test('downloads remain limited to selected candidates that pass active filters', () => {
  const context = createPopupContext();
  const candidates = [
    {
      id: 'wallpaper', selected: true, ignored: false, type: 'image',
      extension: 'jpg', sameOrigin: true, width: 1920, height: 1080
    },
    {
      id: 'clip', selected: true, ignored: false, type: 'video',
      extension: 'mp4', sameOrigin: true, width: 1920, height: 1080
    },
    {
      id: 'not-selected', selected: false, ignored: false, type: 'image',
      extension: 'jpg', sameOrigin: true, width: 2560, height: 1440
    },
    {
      id: 'ignored', selected: true, ignored: true, type: 'image',
      extension: 'jpg', sameOrigin: true, width: 2560, height: 1440
    }
  ];

  context.__fixture = candidates;
  evaluate(context, `
    state.candidates = __fixture;
    state.filters = { type: 'image', extensions: ['jpg'], sameOriginOnly: false, minDimension: 65 };
  `);

  assert.deepEqual(
    Array.from(evaluate(context, 'getSelectedCandidates().map((candidate) => candidate.id)')),
    ['wallpaper']
  );

  evaluate(context, "state.filters.extensions = ['png']");
  assert.deepEqual(
    Array.from(evaluate(context, 'getSelectedCandidates().map((candidate) => candidate.id)')),
    []
  );
});

test('ignore fingerprints still hide matching candidates and clear selection', () => {
  const context = createPopupContext();
  context.__fixture = [{
    id: 'repeat',
    url: 'https://example.test/media/repeat.jpg?cache=123',
    filename: 'repeat.jpg',
    type: 'image',
    extension: 'jpg',
    width: 800,
    height: 600,
    selected: true,
    ignored: false
  }];
  evaluate(context, 'state.candidates = __fixture');
  const fingerprint = evaluate(context, 'buildCandidateFingerprints(state.candidates[0])[0]');
  context.__fingerprint = fingerprint;
  evaluate(context, `state.ignoreList = [{ fingerprint: __fingerprint }]`);

  assert.equal(evaluate(context, 'applyIgnoreListToCandidates()'), 1);
  assert.equal(evaluate(context, 'state.candidates[0].ignored'), true);
  assert.equal(evaluate(context, 'state.candidates[0].selected'), false);
});

test('saved tab state is scoped to the full page URL apart from its hash', () => {
  const context = createPopupContext();

  assert.equal(evaluate(
    context,
    "isSamePageUrl('https://forum.test/thread/1#post-2', 'https://forum.test/thread/1#post-3')"
  ), true);
  assert.equal(evaluate(
    context,
    "isSamePageUrl('https://forum.test/thread/1?page=1', 'https://forum.test/thread/1?page=2')"
  ), false);
});

test('stored destinations are sanitized before they are shown again', () => {
  const context = createPopupContext();
  context.__settings = {
    speedMode: 'fast',
    subfolder: '../../forum\\thread-42',
    autoSubfolder: false
  };

  const settings = evaluate(context, 'normalizeStoredDownloadSettings(__settings)');
  assert.equal(settings.speedMode, 'fast');
  assert.equal(settings.subfolder, 'forum/thread-42');
  assert.equal(settings.autoSubfolder, false);
});

test('terminal batches deselect completed files and retain only retryable files', () => {
  const context = createPopupContext();
  context.__fixture = [
    { id: 'done', selected: true },
    { id: 'failed', selected: true },
    { id: 'cancelled', selected: true },
    { id: 'unrelated', selected: true }
  ];
  evaluate(context, `
    state.candidates = __fixture;
    state.progress = PopupState.normalizeProgress({
      phase: 'aborted',
      itemIds: ['done', 'failed', 'cancelled'],
      completedItemIds: ['done'],
      failedItemIds: ['failed'],
      cancelledItemIds: ['cancelled']
    });
    syncTerminalSelection();
  `);

  assert.deepEqual(
    Array.from(evaluate(context, 'state.candidates.filter((item) => item.selected).map((item) => item.id)')),
    ['failed', 'cancelled', 'unrelated']
  );
  assert.equal(evaluate(
    context,
    "isRetrySelection(state.candidates.filter((item) => ['failed', 'cancelled'].includes(item.id)))"
  ), true);
  assert.equal(evaluate(
    context,
    "isRetrySelection(state.candidates.filter((item) => ['failed', 'unrelated'].includes(item.id)))"
  ), false);
});

test('the terminal state remains aborted and exposes only cancelled files for retry', () => {
  const context = createPopupContext();
  context.__fixture = [
    { id: 'done', selected: true },
    { id: 'cancelled', selected: true }
  ];
  evaluate(context, `
    state.candidates = __fixture;
    state.progress = PopupState.normalizeProgress({
      queued: 2,
      done: 1,
      cancelled: 1,
      active: true,
      phase: 'downloading',
      latestError: 'Old retry warning',
      itemIds: ['done', 'cancelled'],
      completedItemIds: ['done'],
      cancelledItemIds: ['cancelled']
    });
    finishDownloadSessionIfDone();
  `);

  assert.equal(evaluate(context, 'state.progress.phase'), 'aborted');
  assert.equal(evaluate(context, 'state.statusLabel'), 'Aborted');
  assert.equal(evaluate(context, 'state.progress.latestError'), '');
  assert.deepEqual(
    Array.from(evaluate(context, 'state.candidates.filter((item) => item.selected).map((item) => item.id)')),
    ['cancelled']
  );
});

test('a fully successful batch clears its completed selection', () => {
  const context = createPopupContext();
  context.__fixture = [{ id: 'done', selected: true }];
  evaluate(context, `
    state.candidates = __fixture;
    state.progress = PopupState.normalizeProgress({
      queued: 1,
      done: 1,
      active: true,
      phase: 'downloading',
      itemIds: ['done'],
      completedItemIds: ['done']
    });
    finishDownloadSessionIfDone();
  `);

  assert.equal(evaluate(context, 'state.progress.phase'), 'completed');
  assert.equal(evaluate(context, 'state.candidates[0].selected'), false);
});

test('Pixiv fallback sources are forwarded to the background worker', () => {
  const context = createPopupContext();
  context.__candidate = {
    id: 'pixiv',
    url: 'https://i.pximg.net/img-original/img/123_p0.jpg',
    previewUrl: 'https://i.pximg.net/img-master/img/123_p0_master1200.jpg',
    fallbackUrls: [
      'https://i.pximg.net/img-original/img/123_p0.png',
      'https://i.pximg.net/img-master/img/123_p0_master1200.jpg'
    ],
    filename: '123_p0.jpg',
    filenameHints: [],
    type: 'image',
    extension: 'jpg'
  };

  assert.deepEqual(
    Array.from(evaluate(context, 'toDownloadItem(__candidate).fallbackUrls')),
    context.__candidate.fallbackUrls
  );
});

test('ephemeral preview bytes are removed before candidate state is persisted', () => {
  const context = createPopupContext();
  context.__candidate = {
    id: 'attachment',
    url: 'https://forum.test/filedata/fetch?id=42',
    previewUrl: `data:image/jpeg;base64,${'a'.repeat(200000)}`,
    previewSourceUrl: 'https://forum.test/filedata/fetch?id=42&type=thumb',
    pagePreviewKey: 'preview_scan_42',
    previewFetchPending: true,
    selected: true
  };

  const stored = evaluate(context, 'serializeCandidateForStorage(__candidate)');
  assert.equal(stored.previewUrl, context.__candidate.previewSourceUrl);
  assert.equal(stored.previewSourceUrl, context.__candidate.previewSourceUrl);
  assert.equal(stored.pagePreviewKey, 'preview_scan_42');
  assert.equal('previewFetchPending' in stored, false);
  assert.equal(JSON.stringify(stored).includes('a'.repeat(1000)), false);
});

test('old persisted data previews fall back to the original URL during migration', () => {
  const context = createPopupContext();
  context.__candidate = {
    id: 'old-preview',
    url: 'https://forum.test/image/old.jpg',
    previewUrl: 'data:image/jpeg;base64,old-state'
  };

  const restored = evaluate(context, 'normalizeStoredCandidate(__candidate)');
  assert.equal(restored.previewUrl, context.__candidate.url);
  assert.equal(restored.previewSourceUrl, context.__candidate.url);
});

test('stale per-tab states are pruned without touching the ignore list', async () => {
  const context = createPopupContext();
  const removed = [];
  context.chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get(_keys, callback) {
          callback({
            guided_media_ignore_list: [{ fingerprint: 'keep-me' }],
            guided_media_1: { savedAt: 100 },
            guided_media_2: { savedAt: 200 },
            guided_media_3: { savedAt: 300 },
            guided_media_9: { savedAt: 50 }
          });
        },
        remove(keys, callback) {
          removed.push(...keys);
          callback();
        }
      }
    }
  };

  await evaluate(context, "pruneStoredTabStates('guided_media_9', 3)");
  assert.deepEqual(removed.sort(), ['guided_media_1']);
});
