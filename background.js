// background.js

const activeDownloads = new Map();
const downloadSessions = new Map();
const PXIMG_REFERER_RULE_ID = 1001;
const PXIMG_FALLBACK_REFERER = 'https://www.pixiv.net/';

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
  if (request.action !== 'downloadSelectedMedia') {
    return false;
  }

  const items = Array.isArray(request.items) ? request.items : [];
  const sessionId = request.sessionId;
  const page = request.page || {};

  if (!sessionId || items.length === 0) {
    sendResponse({ status: 'No selected media to download.' });
    return false;
  }

  const profileName = normalizeSpeedMode(request.downloadSettings?.speedMode);
  const session = queueDownloads(sessionId, page, items, profileName);
  sendResponse({
    status: `${items.length} downloads queued in Chrome (${session.profile.label}, up to ${session.concurrency} at a time).`
  });
  return false;
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || !activeDownloads.has(delta.id)) {
    return;
  }

  const download = activeDownloads.get(delta.id);
  if (delta.state.current === 'complete') {
    clearTimeout(download.timeoutId);
    activeDownloads.delete(delta.id);
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
    markSessionDownloadFinished(download.sessionId, false);
    retryOrFailDownload(download.sessionId, download.item, 'Download was interrupted.');
  }
});

function queueDownloads(sessionId, page, items, profileName = 'normal') {
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
    pumpDownloads(existingSession);
    return existingSession;
  }

  const folder = buildDownloadFolder(page);
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
    stopped: false
  };

  downloadSessions.set(sessionId, session);
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
    try {
      const dataUrl = await fetchPximgDataUrl(item.url, session.profile.timeoutMs);
      startDownloadRequest(session, item, {
        url: dataUrl,
        headers: [],
        sendStarted: false
      });
    } catch (error) {
      markSessionDownloadFinished(session.id, false);
      retryOrFailDownload(session.id, item, error.message || 'Could not fetch Pixiv image.');
    }
  });
}

function startDownloadRequest(session, item, options = {}) {
  const filename = buildFilename(item, item.index);
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
    }
  );
}

async function fetchPximgDataUrl(url, timeoutMs) {
  const controller = new AbortController();
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
            regexFilter: '^https://i\\.pximg\\.net/img-original/',
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
  try {
    const url = new URL(session.page?.url || '');
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
  markSessionDownloadFinished(download.sessionId, false);

  chrome.downloads.cancel(downloadId, () => {
    void chrome.runtime.lastError;
  });

  retryOrFailDownload(download.sessionId, download.item, 'Download timed out.');
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
  clearTimeout(session.pumpTimer);
  downloadSessions.delete(sessionId);
}

function normalizeSpeedMode(speedMode) {
  return Object.prototype.hasOwnProperty.call(SPEED_PROFILES, speedMode) ? speedMode : 'normal';
}

function buildDownloadFolder(page) {
  const host = sanitizePathPart(page.host || hostFromUrl(page.url) || 'active-tab');
  const today = new Date().toISOString().slice(0, 10);
  return `ImageDownloader/${host}_${today}`;
}

function buildFilename(item, index) {
  let filename = sanitizePathPart(item.filename || '');

  if (!filename) {
    try {
      const pathname = new URL(item.url).pathname;
      filename = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
    } catch (error) {
      filename = '';
    }
  }

  if (!filename) {
    filename = `${item.type || 'media'}_${String(index + 1).padStart(3, '0')}`;
  }

  filename = sanitizePathPart(filename);
  const extension = sanitizePathPart(item.extension || extensionFromUrl(item.url));
  if (extension && !filename.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) {
    filename = `${filename}.${extension}`;
  }

  return filename.slice(0, 160);
}

function sanitizePathPart(value) {
  const cleaned = String(value || '')
    .replace(/[<>:"\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');

  return cleaned || 'media';
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

function hostFromUrl(url) {
  try {
    return new URL(url).host;
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
