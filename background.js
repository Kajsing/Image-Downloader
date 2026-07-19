// background.js

importScripts('download-utils.js');

const activeDownloads = new Map();
const downloadSessions = new Map();
const cancelledSessions = new Set();
const processingDownloadIds = new Set();
const MAX_CANCELLED_SESSION_TOMBSTONES = 100;
const SESSION_STORAGE_PREFIX = 'guided_download_session_';
const ACTIVE_DOWNLOAD_STORAGE_PREFIX = 'guided_download_active_';
const CANCELLED_SESSIONS_STORAGE_KEY = 'guided_download_cancelled_sessions';
let sessionStorageWriteChain = Promise.resolve();
let sessionRestorePromise = null;
const PXIMG_REFERER_RULE_ID = 1001;
const PXIMG_FALLBACK_REFERER = 'https://www.pixiv.net/';
const PXIMG_PREVIEW_TIMEOUT_MS = 15000;

const SPEED_PROFILES = {
  conservative: {
    label: 'Careful',
    initialConcurrency: 1,
    minConcurrency: 1,
    launchDelayMs: 750,
    timeoutMs: 45000,
    retryDelayMs: 3000,
    maxRetries: 2
  },
  normal: {
    label: 'Balanced',
    initialConcurrency: 3,
    minConcurrency: 1,
    launchDelayMs: 350,
    timeoutMs: 40000,
    retryDelayMs: 2500,
    maxRetries: 2
  },
  fast: {
    label: 'Fast',
    initialConcurrency: 6,
    minConcurrency: 2,
    launchDelayMs: 150,
    timeoutMs: 30000,
    retryDelayMs: 3000,
    maxRetries: 2
  }
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'fetchPximgPreview') {
    handlePximgPreviewRequest(request, sendResponse);
    return true;
  }

  if (request.action === 'cancelDownloadSession') {
    cancelDownloadSession(request.sessionId)
      .then(sendResponse)
      .catch((error) => sendResponse({ cancelled: false, error: error.message }));
    return true;
  }

  if (request.action === 'getDownloadSessionStatus') {
    getDownloadSessionStatus(request.sessionId)
      .then(sendResponse)
      .catch((error) => sendResponse({ active: false, status: 'error', error: error.message }));
    return true;
  }

  if (request.action !== 'downloadSelectedMedia') {
    return false;
  }

  handleDownloadRequest(request)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message || 'Could not queue downloads.' }));
  return true;
});

async function handleDownloadRequest(request) {
  await waitForSessionRestore();
  const items = Array.isArray(request.items) ? request.items : [];
  const sessionId = request.sessionId;
  const page = request.page || {};

  if (!sessionId || items.length === 0) {
    return { status: 'No selected media to download.' };
  }

  if (await isSessionCancelled(sessionId)) {
    return { cancelled: true, status: 'Download session was aborted.' };
  }

  const profileName = normalizeSpeedMode(request.downloadSettings?.speedMode);
  const previousSession = await loadSession(sessionId);
  const session = queueDownloads(
    sessionId,
    page,
    items,
    profileName,
    request.downloadSettings?.subfolder,
    previousSession
  );
  await persistSession(session);
  return {
    status: `${items.length} downloads queued in Chrome (${session.profile.label}, up to ${session.concurrency} at a time).`
  };
}

function handlePximgPreviewRequest(request, sendResponse) {
  if (!isPximgUrl(request.url)) {
    sendResponse({ error: 'Preview URL is not a pximg image.' });
    return;
  }

  ensurePximgRefererRule(pximgRefererForPage(request.page), async () => {
    try {
      sendResponse({
        dataUrl: await fetchPximgDataUrl(request.url, PXIMG_PREVIEW_TIMEOUT_MS)
      });
    } catch (error) {
      sendResponse({
        error: error.message || 'Could not fetch Pixiv preview.'
      });
    }
  });
}

chrome.downloads.onChanged.addListener((delta) => {
  handleDownloadChanged(delta);
});

sessionRestorePromise = restoreDownloadSessions();

async function handleDownloadChanged(delta) {
  await waitForSessionRestore();
  if (!delta.state || processingDownloadIds.has(delta.id)) {
    return;
  }
  processingDownloadIds.add(delta.id);

  try {
  if (!delta.state || !activeDownloads.has(delta.id)) {
    const restoredDownload = await loadActiveDownload(delta.id);
    if (!delta.state || !restoredDownload) {
      return;
    }

    activeDownloads.set(delta.id, restoredDownload);
  }

  const download = activeDownloads.get(delta.id);
  if (delta.state.current === 'complete') {
    clearTimeout(download.timeoutId);
    activeDownloads.delete(delta.id);
    await removeActiveDownload(delta.id);
    await recordSessionOutcome(download.sessionId, download.itemId, 'completed', delta.id);
    markSessionDownloadFinished(download.sessionId, true);
    sendDownloadProgress({
      sessionId: download.sessionId,
      itemId: download.itemId,
      status: 'complete'
    });
  }

  if (delta.state.current === 'interrupted') {
    clearTimeout(download.timeoutId);
    activeDownloads.delete(delta.id);
    await removeActiveDownload(delta.id);

    if (download.cancelled || await isSessionCancelled(download.sessionId)) {
      return;
    }

    if (!downloadSessions.has(download.sessionId) || !download.item) {
      await recordSessionOutcome(download.sessionId, download.itemId, 'failed', delta.id);
      sendDownloadProgress({
        sessionId: download.sessionId,
        itemId: download.itemId,
        status: 'failed',
        error: 'Download was interrupted after the extension worker restarted.'
      });
      return;
    }

    markSessionDownloadFinished(download.sessionId, false);
    retryOrFailDownload(download.sessionId, download.item, 'Download was interrupted.');
  }
  } finally {
    processingDownloadIds.delete(delta.id);
  }
}

function queueDownloads(sessionId, page, items, profileName = 'normal', subfolder = '', previousSession = null) {
  const profile = SPEED_PROFILES[profileName] || SPEED_PROFILES.normal;
  const existingSession = downloadSessions.get(sessionId);

  if (existingSession && !existingSession.stopped) {
    const startIndex = existingSession.nextIndex;
    existingSession.pending.push(
      ...items.map((item, index) => ({
        ...item,
        index: startIndex + index,
        attempts: 0
      }))
    );
    existingSession.nextIndex += items.length;
    persistSessionSoon(existingSession);
    pumpDownloads(existingSession);
    return existingSession;
  }

  const folder = DownloadUtils.buildDownloadFolder(page, subfolder);
  const session = {
    id: sessionId,
    page,
    folder,
    profileName,
    profile,
    concurrency: profile.initialConcurrency,
    pending: items.map((item, index) => ({
      ...item,
      index,
      attempts: 0
    })),
    nextIndex: items.length,
    activeCount: 0,
    pumpTimer: null,
    fetchControllers: new Map(),
    launchingItems: new Map(),
    usedFilenames: new Set(previousSession?.usedFilenames || []),
    completedItemIds: new Set(previousSession?.completedItemIds || []),
    failedItemIds: new Set(previousSession?.failedItemIds || []),
    cancelledItemIds: new Set(previousSession?.cancelledItemIds || []),
    status: 'downloading',
    stopped: false
  };

  downloadSessions.set(sessionId, session);
  persistSessionSoon(session);
  pumpDownloads(session);
  return session;
}

function pumpDownloads(session) {
  if (!session || session.stopped) {
    return;
  }

  if (!session.pending.length && session.activeCount === 0) {
    cleanupSession(session.id);
    return;
  }

  if (session.activeCount >= session.concurrency || !session.pending.length) {
    return;
  }

  const item = session.pending.shift();
  session.launchingItems.set(item.id, item);
  persistSessionSoon(session);
  startDownload(session, item);

  if (session.pending.length && session.activeCount < session.concurrency) {
    schedulePump(session, session.profile.launchDelayMs);
  }
}

function schedulePump(session, delayMs) {
  if (!session || session.stopped || session.pumpTimer) {
    return;
  }

  session.pumpTimer = setTimeout(() => {
    session.pumpTimer = null;
    pumpDownloads(session);
  }, delayMs);
}

function startDownload(session, item) {
  item.attempts += 1;
  session.activeCount += 1;

  if (isPximgUrl(item.url)) {
    startPximgDownload(session, item);
    return;
  }

  startDownloadRequest(session, item);
}

function startPximgDownload(session, item) {
  sendDownloadProgress({
    sessionId: session.id,
    itemId: item.id,
    status: 'started',
    attempt: item.attempts,
    concurrency: session.concurrency
  });

  ensurePximgRefererRule(pximgRefererForSession(session), async () => {
    if (session.stopped) {
      return;
    }

    const controller = new AbortController();
    session.fetchControllers.set(item.id, controller);

    try {
      const dataUrl = await fetchPximgDataUrl(item.url, session.profile.timeoutMs, controller);
      session.fetchControllers.delete(item.id);
      if (session.stopped) {
        return;
      }

      startDownloadRequest(session, item, {
        url: dataUrl,
        headers: [],
        sendStarted: false
      });
    } catch (error) {
      session.fetchControllers.delete(item.id);
      session.launchingItems.delete(item.id);
      if (session.stopped) {
        return;
      }

      markSessionDownloadFinished(session.id, false);
      retryOrFailDownload(session.id, item, error.message || 'Could not fetch Pixiv image.');
    }
  });
}

function startDownloadRequest(session, item, options = {}) {
  if (session.stopped) {
    return;
  }

  const filename = DownloadUtils.resolveUniqueFilename(
    item,
    item.index,
    session.page,
    session.usedFilenames
  );
  const downloadPath = `${session.folder}/${filename}`;
  const downloadOptions = {
    url: options.url || item.url,
    filename: downloadPath,
    conflictAction: 'uniquify',
    saveAs: false
  };
  const headers = normalizeDownloadHeaders(options.headers ?? item.headers);

  if (headers.length) {
    downloadOptions.headers = headers;
  }

  if (options.sendStarted !== false) {
    sendDownloadProgress({
      sessionId: session.id,
      itemId: item.id,
      status: 'started',
      attempt: item.attempts,
      concurrency: session.concurrency
    });
  }

  chrome.downloads.download(
    downloadOptions,
    (downloadId) => {
      session.launchingItems.delete(item.id);
      if (session.stopped) {
        if (downloadId) {
          chrome.downloads.cancel(downloadId, () => {
            void chrome.runtime.lastError;
          });
        }
        return;
      }

      if (chrome.runtime.lastError || !downloadId) {
        markSessionDownloadFinished(session.id, false);
        retryOrFailDownload(
          session.id,
          item,
          chrome.runtime.lastError?.message || 'Chrome could not start the download.'
        );
        return;
      }

      const timeoutId = setTimeout(() => {
        handleDownloadTimeout(downloadId);
      }, session.profile.timeoutMs);

      activeDownloads.set(downloadId, {
        sessionId: session.id,
        itemId: item.id,
        item,
        timeoutId
      });
      Promise.all([
        persistActiveDownload(downloadId, session.id, item),
        persistSession(session)
      ]).catch(() => {});
    }
  );
}

async function fetchPximgDataUrl(url, timeoutMs, suppliedController = null) {
  const controller = suppliedController || new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, Math.max(5000, Number(timeoutMs) || 30000));

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Pixiv fetch HTTP ${response.status}`);
    }

    const contentType = String(response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (contentType && !contentType.startsWith('image/')) {
      throw new Error(`Pixiv returned ${contentType} instead of an image.`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const mimeType = contentType || mimeTypeFromUrl(url) || 'application/octet-stream';
    return `data:${mimeType};base64,${arrayBufferToBase64(arrayBuffer)}`;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Pixiv fetch timed out.');
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function mimeTypeFromUrl(url) {
  const extension = extensionFromUrl(url);
  const mimeTypes = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml'
  };

  return mimeTypes[extension] || '';
}

function ensurePximgRefererRule(referer, callback) {
  if (!chrome.declarativeNetRequest?.updateSessionRules) {
    callback();
    return;
  }

  chrome.declarativeNetRequest.updateSessionRules(
    {
      removeRuleIds: [PXIMG_REFERER_RULE_ID],
      addRules: [
        {
          id: PXIMG_REFERER_RULE_ID,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              {
                header: 'Referer',
                operation: 'set',
                value: referer
              }
            ]
          },
          condition: {
            regexFilter: '^https://i\\.pximg\\.net/',
            resourceTypes: ['main_frame', 'sub_frame', 'image', 'media', 'xmlhttprequest', 'other']
          }
        }
      ]
    },
    () => {
      void chrome.runtime.lastError;
      callback();
    }
  );
}

function pximgRefererForSession(session) {
  return pximgRefererForPage(session.page);
}

function pximgRefererForPage(page) {
  try {
    const url = new URL(page?.url || '');
    if (url.host === 'www.pixiv.net') {
      return url.href;
    }
  } catch (error) {
    // Fall through to the generic Pixiv referer.
  }

  return PXIMG_FALLBACK_REFERER;
}

function normalizeDownloadHeaders(headers) {
  if (!Array.isArray(headers)) {
    return [];
  }

  return headers
    .filter((header) => header && header.name && typeof header.value === 'string')
    .filter((header) => isSafeDownloadHeaderName(header.name))
    .map((header) => ({
      name: String(header.name),
      value: header.value
    }));
}

function isSafeDownloadHeaderName(name) {
  return !['referer', 'referrer', 'user-agent', 'cookie', 'origin'].includes(String(name).toLowerCase());
}

function isPximgUrl(url) {
  try {
    return new URL(url).host === 'i.pximg.net';
  } catch (error) {
    return false;
  }
}

function handleDownloadTimeout(downloadId) {
  const download = activeDownloads.get(downloadId);
  if (!download) {
    return;
  }

  activeDownloads.delete(downloadId);
  removeActiveDownload(downloadId).catch(() => {});
  markSessionDownloadFinished(download.sessionId, false);

  chrome.downloads.cancel(downloadId, () => {
    void chrome.runtime.lastError;
  });

  if (!download.item) {
    recordSessionOutcome(download.sessionId, download.itemId, 'failed', downloadId).catch(() => {});
    sendDownloadProgress({
      sessionId: download.sessionId,
      itemId: download.itemId,
      status: 'failed',
      error: 'Download timed out after the extension worker restarted.'
    });
    return;
  }

  retryOrFailDownload(download.sessionId, download.item, 'Download timed out.');
}

async function cancelDownloadSession(sessionId) {
  await waitForSessionRestore();
  if (!sessionId) {
    return { cancelled: false, status: 'No download session to abort.' };
  }

  await rememberCancelledSession(sessionId);
  const session = downloadSessions.get(sessionId);
  const persistedSession = await loadSession(sessionId);
  const completedItemIds = new Set(persistedSession?.completedItemIds || []);
  const failedItemIds = new Set(persistedSession?.failedItemIds || []);
  const cancelledItemIds = new Set(persistedSession?.cancelledItemIds || []);
  const downloadsToCancel = new Map();

  (persistedSession?.pendingItemIds || []).forEach((itemId) => cancelledItemIds.add(itemId));
  (persistedSession?.launchingItemIds || []).forEach((itemId) => cancelledItemIds.add(itemId));

  if (session) {
    session.completedItemIds.forEach((itemId) => completedItemIds.add(itemId));
    session.failedItemIds.forEach((itemId) => failedItemIds.add(itemId));
    session.cancelledItemIds.forEach((itemId) => cancelledItemIds.add(itemId));
    session.stopped = true;
    clearTimeout(session.pumpTimer);
    session.pumpTimer = null;

    session.pending.forEach((item) => cancelledItemIds.add(item.id));
    session.pending.length = 0;

    session.fetchControllers.forEach((controller, itemId) => {
      cancelledItemIds.add(itemId);
      controller.abort();
    });
    session.fetchControllers.clear();
    session.launchingItems.forEach((_item, itemId) => cancelledItemIds.add(itemId));
    session.launchingItems.clear();
    downloadSessions.delete(sessionId);
  }

  activeDownloads.forEach((download, downloadId) => {
    if (download.sessionId !== sessionId) {
      return;
    }

    download.cancelled = true;
    clearTimeout(download.timeoutId);
    activeDownloads.delete(downloadId);
    downloadsToCancel.set(downloadId, download);
  });

  const knownActiveIds = Array.isArray(persistedSession?.activeDownloadIds)
    ? persistedSession.activeDownloadIds
    : [];
  for (const downloadId of knownActiveIds) {
    if (!downloadsToCancel.has(downloadId)) {
      const restoredDownload = await loadActiveDownload(downloadId);
      const persistedItemId = persistedSession?.activeDownloadItems?.[downloadId];
      if (restoredDownload || persistedItemId) {
        downloadsToCancel.set(downloadId, restoredDownload || {
          sessionId,
          itemId: persistedItemId,
          item: null
        });
      }
    }
  }

  for (const [downloadId, download] of downloadsToCancel) {
    await removeActiveDownload(downloadId);
    const finalState = await cancelAndInspectDownload(downloadId);
    if (finalState === 'complete') {
      completedItemIds.add(download.itemId);
      cancelledItemIds.delete(download.itemId);
    } else {
      cancelledItemIds.add(download.itemId);
    }
  }

  const abortedSnapshot = {
    id: sessionId,
    status: 'aborted',
    activeDownloadIds: [],
    activeDownloadItems: {},
    pendingItemIds: [],
    completedItemIds: Array.from(completedItemIds),
    failedItemIds: Array.from(failedItemIds),
    cancelledItemIds: Array.from(cancelledItemIds),
    updatedAt: Date.now()
  };
  await sessionStorageSet({ [sessionStorageKey(sessionId)]: abortedSnapshot });

  sendDownloadProgress({
    sessionId,
    status: 'aborted',
    completedItemIds: abortedSnapshot.completedItemIds,
    failedItemIds: abortedSnapshot.failedItemIds,
    cancelledItemIds: Array.from(cancelledItemIds)
  });

  return {
    cancelled: true,
    cancelledCount: cancelledItemIds.size,
    completedItemIds: abortedSnapshot.completedItemIds,
    failedItemIds: abortedSnapshot.failedItemIds,
    cancelledItemIds: abortedSnapshot.cancelledItemIds,
    status: 'Download session aborted.'
  };
}

function cancelAndInspectDownload(downloadId) {
  return new Promise((resolve) => {
    chrome.downloads.cancel(downloadId, () => {
      void chrome.runtime.lastError;
      if (!chrome.downloads.search) {
        resolve('cancelled');
        return;
      }

      chrome.downloads.search({ id: downloadId }, (results) => {
        void chrome.runtime.lastError;
        resolve(results?.[0]?.state === 'complete' ? 'complete' : 'cancelled');
      });
    });
  });
}

async function rememberCancelledSession(sessionId) {
  if (!cancelledSessions.size) {
    const stored = await sessionStorageGet(CANCELLED_SESSIONS_STORAGE_KEY);
    const ids = Array.isArray(stored[CANCELLED_SESSIONS_STORAGE_KEY])
      ? stored[CANCELLED_SESSIONS_STORAGE_KEY]
      : [];
    ids.forEach((id) => cancelledSessions.add(id));
  }

  cancelledSessions.add(sessionId);
  while (cancelledSessions.size > MAX_CANCELLED_SESSION_TOMBSTONES) {
    cancelledSessions.delete(cancelledSessions.values().next().value);
  }

  await sessionStorageSet({
    [CANCELLED_SESSIONS_STORAGE_KEY]: Array.from(cancelledSessions)
  });
}

async function isSessionCancelled(sessionId) {
  if (cancelledSessions.has(sessionId)) {
    return true;
  }

  const stored = await sessionStorageGet(CANCELLED_SESSIONS_STORAGE_KEY);
  const ids = Array.isArray(stored[CANCELLED_SESSIONS_STORAGE_KEY])
    ? stored[CANCELLED_SESSIONS_STORAGE_KEY]
    : [];
  ids.forEach((id) => cancelledSessions.add(id));
  return cancelledSessions.has(sessionId);
}

async function getDownloadSessionStatus(sessionId) {
  await waitForSessionRestore();
  if (!sessionId) {
    return { active: false, status: 'idle' };
  }

  const liveSession = downloadSessions.get(sessionId);
  if (liveSession && !liveSession.stopped) {
    return sessionStatusResponse(liveSession, true);
  }

  const storedSession = await loadSession(sessionId);
  if (await isSessionCancelled(sessionId)) {
    return storedSession
      ? sessionStatusResponse(storedSession, false, 'aborted')
      : { active: false, status: 'aborted' };
  }

  if (!storedSession) {
    return { active: false, status: 'inactive' };
  }

  if (['completed', 'completed-with-errors', 'aborted'].includes(storedSession.status)) {
    return sessionStatusResponse(storedSession, false);
  }

  const reconciled = await reconcileStoredSession(storedSession);
  return sessionStatusResponse(reconciled, reconciled.activeDownloadIds.length > 0);
}

function sessionStatusResponse(session, active, forcedStatus = '') {
  return {
    active,
    status: forcedStatus || session.status || 'downloading',
    completedItemIds: Array.from(session.completedItemIds || []),
    failedItemIds: Array.from(session.failedItemIds || []),
    cancelledItemIds: Array.from(session.cancelledItemIds || [])
  };
}

async function reconcileStoredSession(storedSession) {
  const activeDownloadIds = [];
  const activeDownloadItems = {};
  const completedItemIds = new Set(storedSession.completedItemIds || []);
  const failedItemIds = new Set(storedSession.failedItemIds || []);

  for (const downloadId of storedSession.activeDownloadIds || []) {
    const download = await findDownload(downloadId);
    const record = await loadActiveDownload(downloadId);
    const itemId = record?.itemId || storedSession.activeDownloadItems?.[downloadId];
    if (download?.state === 'in_progress') {
      activeDownloadIds.push(downloadId);
      if (itemId) {
        activeDownloadItems[downloadId] = itemId;
      }
      continue;
    }

    if (itemId) {
      if (download?.state === 'complete') {
        completedItemIds.add(itemId);
      } else {
        failedItemIds.add(itemId);
      }
    }
    await removeActiveDownload(downloadId);
  }

  (storedSession.pendingItemIds || []).forEach((itemId) => failedItemIds.add(itemId));
  const status = activeDownloadIds.length
    ? 'downloading'
    : failedItemIds.size ? 'completed-with-errors' : 'completed';
  const reconciled = {
    ...storedSession,
    status,
    activeDownloadIds,
    activeDownloadItems,
    pendingItemIds: [],
    completedItemIds: Array.from(completedItemIds),
    failedItemIds: Array.from(failedItemIds),
    updatedAt: Date.now()
  };
  await sessionStorageSet({ [sessionStorageKey(storedSession.id)]: reconciled });
  return reconciled;
}

function findDownload(downloadId) {
  if (!chrome.downloads.search) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    chrome.downloads.search({ id: downloadId }, (results) => {
      void chrome.runtime.lastError;
      resolve(results?.[0] || null);
    });
  });
}

function retryOrFailDownload(sessionId, item, error) {
  const session = downloadSessions.get(sessionId);
  if (!session || session.stopped) {
    sendDownloadProgress({
      sessionId,
      itemId: item.id,
      status: 'failed',
      error
    });
    return;
  }

  throttleSession(session, error);

  if (item.attempts <= session.profile.maxRetries) {
    session.pending.unshift(item);
    sendDownloadProgress({
      sessionId,
      itemId: item.id,
      status: 'retry',
      attempt: item.attempts + 1,
      concurrency: session.concurrency,
      error
    });
    schedulePump(session, session.profile.retryDelayMs);
    return;
  }

  sendDownloadProgress({
    sessionId,
    itemId: item.id,
    status: 'failed',
    error
  });
  recordSessionOutcome(sessionId, item.id, 'failed').catch(() => {});
  schedulePump(session, session.profile.launchDelayMs);
}

function throttleSession(session, error) {
  const nextConcurrency = Math.max(
    session.profile.minConcurrency,
    session.profileName === 'fast' ? 2 : Math.floor(session.concurrency / 2)
  );

  if (nextConcurrency >= session.concurrency) {
    return;
  }

  session.concurrency = nextConcurrency;
  sendDownloadProgress({
    sessionId: session.id,
    status: 'throttled',
    concurrency: session.concurrency,
    error
  });
}

function markSessionDownloadFinished(sessionId, shouldSchedule = true) {
  const session = downloadSessions.get(sessionId);
  if (!session) {
    return;
  }

  session.activeCount = Math.max(0, session.activeCount - 1);
  persistSessionSoon(session);
  if (shouldSchedule) {
    schedulePump(session, session.profile.launchDelayMs);
  }
}

function cleanupSession(sessionId) {
  const session = downloadSessions.get(sessionId);
  if (!session) {
    return;
  }

  session.stopped = true;
  session.status = session.failedItemIds.size ? 'completed-with-errors' : 'completed';
  clearTimeout(session.pumpTimer);
  downloadSessions.delete(sessionId);
  persistSessionSoon(session, true);
}

function waitForSessionRestore() {
  return sessionRestorePromise ? sessionRestorePromise.catch(() => {}) : Promise.resolve();
}

async function restoreDownloadSessions() {
  const storedValues = await sessionStorageGet(null);
  const storedCancelledIds = Array.isArray(storedValues[CANCELLED_SESSIONS_STORAGE_KEY])
    ? storedValues[CANCELLED_SESSIONS_STORAGE_KEY]
    : [];
  storedCancelledIds.forEach((sessionId) => cancelledSessions.add(sessionId));

  for (const [key, snapshot] of Object.entries(storedValues)) {
    if (!key.startsWith(SESSION_STORAGE_PREFIX)
      || !snapshot?.id
      || snapshot.status !== 'downloading'
      || cancelledSessions.has(snapshot.id)) {
      continue;
    }

    const profileName = normalizeSpeedMode(snapshot.profileName);
    const profile = SPEED_PROFILES[profileName];
    const pending = Array.isArray(snapshot.pendingItems) ? snapshot.pendingItems : [];
    const recoverablePendingIds = new Set(pending.map((item) => item.id));
    const completedItemIds = new Set(snapshot.completedItemIds || []);
    const failedItemIds = new Set(snapshot.failedItemIds || []);
    const cancelledItemIds = new Set(snapshot.cancelledItemIds || []);

    (snapshot.launchingItemIds || []).forEach((itemId) => {
      if (itemId) {
        failedItemIds.add(itemId);
      }
    });

    (snapshot.pendingItemIds || []).forEach((itemId) => {
      if (!recoverablePendingIds.has(itemId)) {
        failedItemIds.add(itemId);
      }
    });

    const session = {
      id: snapshot.id,
      page: snapshot.page || {},
      folder: snapshot.folder || DownloadUtils.buildDownloadFolder(snapshot.page || {}),
      profileName,
      profile,
      concurrency: Math.max(profile.minConcurrency, Number(snapshot.concurrency) || profile.initialConcurrency),
      pending,
      nextIndex: Math.max(Number(snapshot.nextIndex) || 0, pending.length),
      activeCount: 0,
      pumpTimer: null,
      fetchControllers: new Map(),
      launchingItems: new Map(),
      usedFilenames: new Set(snapshot.usedFilenames || []),
      completedItemIds,
      failedItemIds,
      cancelledItemIds,
      status: 'downloading',
      stopped: false
    };

    for (const downloadId of snapshot.activeDownloadIds || []) {
      const downloadState = await findDownload(downloadId);
      const restoredDownload = await loadActiveDownload(downloadId);
      const itemId = restoredDownload?.itemId || snapshot.activeDownloadItems?.[downloadId];
      if (downloadState?.state === 'in_progress' && itemId) {
        const timeoutId = setTimeout(() => handleDownloadTimeout(downloadId), profile.timeoutMs);
        activeDownloads.set(downloadId, {
          sessionId: snapshot.id,
          itemId,
          item: restoredDownload?.item || null,
          timeoutId
        });
        session.activeCount += 1;
        continue;
      }

      if (itemId) {
        if (downloadState?.state === 'complete') {
          completedItemIds.add(itemId);
        } else {
          failedItemIds.add(itemId);
        }
      }
      await removeActiveDownload(downloadId);
    }

    downloadSessions.set(session.id, session);
    persistSessionSoon(session);
    pumpDownloads(session);
  }
}

function persistSessionSoon(session, includeStopped = false) {
  persistSession(session, includeStopped).catch(() => {});
}

function persistSession(session, includeStopped = false) {
  if (!session || (session.stopped && !includeStopped)) {
    return Promise.resolve();
  }

  const activeDownloadIds = [];
  const activeDownloadItems = {};
  const pendingItems = session.pending.map(serializePendingItem).filter(Boolean);
  const recoverablePendingIds = new Set(pendingItems.map((item) => item.id));
  const unrecoverablePendingItemIds = session.pending
    .map((item) => item.id)
    .filter((itemId) => !recoverablePendingIds.has(itemId));
  activeDownloads.forEach((download, downloadId) => {
    if (download.sessionId === session.id) {
      activeDownloadIds.push(downloadId);
      activeDownloadItems[downloadId] = download.itemId;
    }
  });

  return sessionStorageSet({
    [sessionStorageKey(session.id)]: {
      id: session.id,
      status: session.status || 'downloading',
      page: session.page,
      folder: session.folder,
      profileName: session.profileName,
      concurrency: session.concurrency,
      nextIndex: session.nextIndex,
      activeDownloadIds,
      activeDownloadItems,
      pendingItemIds: session.pending.map((item) => item.id),
      pendingItems,
      launchingItemIds: Array.from(session.launchingItems.keys()),
      unrecoverablePendingItemIds,
      completedItemIds: Array.from(session.completedItemIds || []),
      failedItemIds: Array.from(session.failedItemIds || []),
      cancelledItemIds: Array.from(session.cancelledItemIds || []),
      usedFilenames: Array.from(session.usedFilenames || []),
      updatedAt: Date.now()
    }
  });
}

function serializePendingItem(item) {
  if (!item?.url || item.url.startsWith('data:') || item.url.length > 8192) {
    return null;
  }

  return {
    ...item,
    headers: Array.isArray(item.headers) ? item.headers : []
  };
}

async function recordSessionOutcome(sessionId, itemId, outcome, downloadId = null) {
  if (!itemId) {
    return;
  }

  const liveSession = downloadSessions.get(sessionId);
  if (liveSession) {
    liveSession.completedItemIds.delete(itemId);
    liveSession.failedItemIds.delete(itemId);
    liveSession.cancelledItemIds.delete(itemId);
    liveSession[`${outcome}ItemIds`].add(itemId);
    await persistSession(liveSession);
    return;
  }

  const stored = await loadSession(sessionId);
  if (!stored) {
    return;
  }

  const completed = new Set(stored.completedItemIds || []);
  const failed = new Set(stored.failedItemIds || []);
  const cancelled = new Set(stored.cancelledItemIds || []);
  completed.delete(itemId);
  failed.delete(itemId);
  cancelled.delete(itemId);
  ({ completed, failed, cancelled })[outcome].add(itemId);

  const activeDownloadIds = (stored.activeDownloadIds || []).filter((id) => id !== downloadId);
  const activeDownloadItems = { ...(stored.activeDownloadItems || {}) };
  if (downloadId !== null) {
    delete activeDownloadItems[downloadId];
  }
  const pendingItemIds = (stored.pendingItemIds || []).filter((id) => id !== itemId);
  await sessionStorageSet({
    [sessionStorageKey(sessionId)]: {
      ...stored,
      activeDownloadIds,
      activeDownloadItems,
      pendingItemIds,
      completedItemIds: Array.from(completed),
      failedItemIds: Array.from(failed),
      cancelledItemIds: Array.from(cancelled),
      status: activeDownloadIds.length || pendingItemIds.length
        ? 'downloading'
        : failed.size ? 'completed-with-errors' : 'completed',
      updatedAt: Date.now()
    }
  });
}

function loadSession(sessionId) {
  const key = sessionStorageKey(sessionId);
  return sessionStorageGet(key).then((stored) => stored[key] || null);
}

function persistActiveDownload(downloadId, sessionId, item) {
  const canRestoreItem = item?.url && item.url.length <= 8192 && !item.url.startsWith('data:');
  return sessionStorageSet({
    [activeDownloadStorageKey(downloadId)]: {
      sessionId,
      itemId: item.id,
      item: canRestoreItem ? item : null
    }
  });
}

function loadActiveDownload(downloadId) {
  const key = activeDownloadStorageKey(downloadId);
  return sessionStorageGet(key).then((stored) => stored[key] || null);
}

function removeActiveDownload(downloadId) {
  return sessionStorageRemove(activeDownloadStorageKey(downloadId));
}

function sessionStorageKey(sessionId) {
  return `${SESSION_STORAGE_PREFIX}${sessionId}`;
}

function activeDownloadStorageKey(downloadId) {
  return `${ACTIVE_DOWNLOAD_STORAGE_PREFIX}${downloadId}`;
}

function sessionStorageGet(key) {
  if (!chrome.storage?.session) {
    return Promise.resolve({});
  }

  return sessionStorageWriteChain.catch(() => {}).then(() => new Promise((resolve, reject) => {
    chrome.storage.session.get(key, (result) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(result || {});
    });
  }));
}

function sessionStorageSet(values) {
  if (!chrome.storage?.session) {
    return Promise.resolve();
  }

  return enqueueSessionStorageWrite(() => new Promise((resolve, reject) => {
    chrome.storage.session.set(values, () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve();
    });
  }));
}

function sessionStorageRemove(key) {
  if (!chrome.storage?.session) {
    return Promise.resolve();
  }

  return enqueueSessionStorageWrite(() => new Promise((resolve, reject) => {
    chrome.storage.session.remove(key, () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve();
    });
  }));
}

function enqueueSessionStorageWrite(operation) {
  const result = sessionStorageWriteChain.then(operation, operation);
  sessionStorageWriteChain = result.catch(() => {});
  return result;
}

function normalizeSpeedMode(speedMode) {
  return Object.prototype.hasOwnProperty.call(SPEED_PROFILES, speedMode) ? speedMode : 'normal';
}

function extensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : '';
  } catch (error) {
    return '';
  }
}

function sendDownloadProgress(message) {
  chrome.runtime.sendMessage(
    {
      action: 'downloadProgress',
      ...message
    },
    () => {
      // The popup may be closed; missing receivers are expected.
      void chrome.runtime.lastError;
    }
  );
}
