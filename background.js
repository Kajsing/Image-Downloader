// background.js

const activeDownloads = new Map();

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

  queueDownloads(sessionId, page, items);
  sendResponse({ status: `${items.length} downloads queued in Chrome.` });
  return false;
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || !activeDownloads.has(delta.id)) {
    return;
  }

  const download = activeDownloads.get(delta.id);
  if (delta.state.current === 'complete') {
    sendDownloadProgress({
      sessionId: download.sessionId,
      itemId: download.itemId,
      status: 'complete'
    });
    activeDownloads.delete(delta.id);
  }

  if (delta.state.current === 'interrupted') {
    sendDownloadProgress({
      sessionId: download.sessionId,
      itemId: download.itemId,
      status: 'failed',
      error: 'Download was interrupted.'
    });
    activeDownloads.delete(delta.id);
  }
});

function queueDownloads(sessionId, page, items) {
  const folder = buildDownloadFolder(page);

  items.forEach((item, index) => {
    const filename = buildFilename(item, index);
    const downloadPath = `${folder}/${filename}`;

    chrome.downloads.download(
      {
        url: item.url,
        filename: downloadPath,
        conflictAction: 'uniquify',
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          sendDownloadProgress({
            sessionId,
            itemId: item.id,
            status: 'failed',
            error: chrome.runtime.lastError?.message || 'Chrome could not start the download.'
          });
          return;
        }

        activeDownloads.set(downloadId, {
          sessionId,
          itemId: item.id
        });
      }
    );
  });
}

function buildDownloadFolder(page) {
  const host = sanitizePathPart(page.host || hostFromUrl(page.url) || 'active-tab');
  const today = new Date().toISOString().slice(0, 10);
  return `ImageDownloader/${host}_${today}`;
}

function buildFilename(item, index) {
  let filename = '';

  try {
    const pathname = new URL(item.url).pathname;
    filename = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
  } catch (error) {
    filename = '';
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
