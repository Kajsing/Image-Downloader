// popup.js

const STORAGE_PREFIX = 'guided_media_';
const EXTENSIONS = ['jpg', 'png', 'gif', 'webp', 'svg', 'webm', 'mp4'];
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg']);
const VIDEO_EXTENSIONS = new Set(['webm', 'mp4']);
const DEFAULT_FILTERS = {
  type: 'all',
  extensions: EXTENSIONS,
  sameOriginOnly: false,
  minDimension: 0
};

const refs = {
  scanBtn: document.getElementById('scanBtn'),
  statusText: document.getElementById('statusText'),
  pageHost: document.getElementById('pageHost'),
  tabStatus: document.getElementById('tabStatus'),
  totalCount: document.getElementById('totalCount'),
  imageCount: document.getElementById('imageCount'),
  videoCount: document.getElementById('videoCount'),
  sameOriginOnly: document.getElementById('sameOriginOnly'),
  extensionFilters: document.getElementById('extensionFilters'),
  minDimension: document.getElementById('minDimension'),
  resetFiltersBtn: document.getElementById('resetFiltersBtn'),
  selectLikelyBtn: document.getElementById('selectLikelyBtn'),
  selectAllBtn: document.getElementById('selectAllBtn'),
  selectNoneBtn: document.getElementById('selectNoneBtn'),
  clearSelectionBtn: document.getElementById('clearSelectionBtn'),
  visibleCount: document.getElementById('visibleCount'),
  emptyState: document.getElementById('emptyState'),
  resultsList: document.getElementById('resultsList'),
  selectedCount: document.getElementById('selectedCount'),
  progressBar: document.getElementById('progressBar'),
  progressPercent: document.getElementById('progressPercent'),
  queuedCount: document.getElementById('queuedCount'),
  doneCount: document.getElementById('doneCount'),
  failedCount: document.getElementById('failedCount'),
  latestError: document.getElementById('latestError'),
  downloadBtn: document.getElementById('downloadBtn')
};

let state = createDefaultState();
let persistTimer = null;

document.addEventListener('DOMContentLoaded', init);

function createDefaultState() {
  return {
    tabId: null,
    pageUrl: '',
    pageHost: 'Active tab',
    pageTitle: '',
    candidates: [],
    filters: { ...DEFAULT_FILTERS, extensions: [...DEFAULT_FILTERS.extensions] },
    progress: {
      sessionId: null,
      queued: 0,
      done: 0,
      failed: 0,
      latestError: '',
      active: false
    },
    statusMessage: 'Scan the active tab to collect media candidates.',
    statusLabel: 'Ready',
    isScanning: false,
    isDownloading: false
  };
}

async function init() {
  wireEvents();
  renderExtensionFilters();

  try {
    const tab = await getActiveTab();
    setTabInfo(tab);
    await loadStateForTab(tab.id);
    render();
  } catch (error) {
    setStatus(`Error: ${error.message}`, 'Error');
    render();
  }
}

function wireEvents() {
  refs.scanBtn.addEventListener('click', scanPage);
  refs.sameOriginOnly.addEventListener('change', () => {
    state.filters.sameOriginOnly = refs.sameOriginOnly.checked;
    persistState();
    render();
  });
  refs.minDimension.addEventListener('change', () => {
    state.filters.minDimension = Number(refs.minDimension.value) || 0;
    persistState();
    render();
  });
  refs.resetFiltersBtn.addEventListener('click', resetFilters);
  refs.selectLikelyBtn.addEventListener('click', selectLikelyWallpapers);
  refs.selectAllBtn.addEventListener('click', () => setVisibleSelection(true));
  refs.selectNoneBtn.addEventListener('click', () => setVisibleSelection(false));
  refs.clearSelectionBtn.addEventListener('click', clearSelection);
  refs.downloadBtn.addEventListener('click', downloadSelected);

  document.querySelectorAll('[data-type-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      state.filters.type = button.dataset.typeFilter;
      persistState();
      render();
    });
  });

  refs.extensionFilters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-extension]');
    if (!button) {
      return;
    }

    const extension = button.dataset.extension;
    const extensions = new Set(state.filters.extensions);
    if (extensions.has(extension)) {
      extensions.delete(extension);
    } else {
      extensions.add(extension);
    }

    state.filters.extensions = [...extensions];
    persistState();
    render();
  });

  refs.resultsList.addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-candidate-id]');
    if (!checkbox) {
      return;
    }

    const candidate = state.candidates.find((item) => item.id === checkbox.dataset.candidateId);
    if (candidate) {
      candidate.selected = checkbox.checked;
      persistState();
      renderFooter();
      renderVisibleCount();
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.action === 'downloadProgress') {
      handleDownloadProgress(message);
    }
  });
}

function renderExtensionFilters() {
  refs.extensionFilters.textContent = '';
  EXTENSIONS.forEach((extension) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.dataset.extension = extension;
    button.textContent = extension.toUpperCase();
    refs.extensionFilters.appendChild(button);
  });
}

async function scanPage() {
  state.isScanning = true;
  state.progress = createDefaultState().progress;
  setStatus('Scanning page...', 'Scanning');
  render();

  try {
    const tab = await getActiveTab();
    setTabInfo(tab);

    const results = await executeScript(tab.id, collectMediaCandidates);
    const scanResult = results?.[0]?.result || {};
    const candidates = Array.isArray(scanResult.candidates) ? scanResult.candidates : [];

    state.pageUrl = scanResult.pageUrl || tab.url || '';
    state.pageHost = scanResult.pageHost || state.pageHost;
    state.pageTitle = scanResult.pageTitle || tab.title || '';
    state.candidates = candidates.map(normalizeCandidate);
    state.isScanning = false;

    setStatus(
      state.candidates.length
        ? `Found ${state.candidates.length} media candidates.`
        : 'No supported media found on this page.',
      'Ready'
    );
    await persistState();
    render();
  } catch (error) {
    state.isScanning = false;
    setStatus(`Scan failed: ${error.message}`, 'Error');
    render();
  }
}

function normalizeCandidate(candidate, index) {
  const extension = normalizeExtension(candidate.extension);
  return {
    id: `media_${index}_${hashString(candidate.url || String(index))}`,
    url: candidate.url,
    previewUrl: candidate.previewUrl || candidate.url,
    type: candidate.type,
    extension,
    source: candidate.source || 'page',
    filename: candidate.filename || '',
    pageHost: candidate.pageHost || state.pageHost,
    sameOrigin: Boolean(candidate.sameOrigin),
    width: toPositiveNumber(candidate.width),
    height: toPositiveNumber(candidate.height),
    selected: true,
    warning: ''
  };
}

function render() {
  renderHeader();
  renderSummary();
  renderFilters();
  renderResults();
  renderFooter();
}

function renderHeader() {
  refs.pageHost.textContent = state.pageHost || 'Active tab';
  refs.tabStatus.textContent = state.isScanning
    ? 'Scanning'
    : state.progress.active
      ? 'Downloading'
      : state.statusLabel;
  refs.scanBtn.disabled = state.isScanning;
  refs.statusText.textContent = state.statusMessage;
}

function renderSummary() {
  const imageCount = state.candidates.filter((candidate) => candidate.type === 'image').length;
  const videoCount = state.candidates.filter((candidate) => candidate.type === 'video').length;
  refs.totalCount.textContent = String(state.candidates.length);
  refs.imageCount.textContent = String(imageCount);
  refs.videoCount.textContent = String(videoCount);
}

function renderFilters() {
  document.querySelectorAll('[data-type-filter]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.typeFilter === state.filters.type);
  });

  refs.sameOriginOnly.checked = state.filters.sameOriginOnly;
  refs.minDimension.value = String(state.filters.minDimension);

  refs.extensionFilters.querySelectorAll('[data-extension]').forEach((button) => {
    button.classList.toggle('is-active', state.filters.extensions.includes(button.dataset.extension));
  });
}

function renderResults() {
  const visibleCandidates = getFilteredCandidates();
  refs.resultsList.textContent = '';

  refs.emptyState.hidden = visibleCandidates.length > 0;
  refs.emptyState.textContent = state.candidates.length
    ? 'No media match the current filters.'
    : 'No media scanned yet.';

  visibleCandidates.forEach((candidate) => {
    refs.resultsList.appendChild(createMediaCard(candidate));
  });

  renderVisibleCount();
}

function createMediaCard(candidate) {
  const card = document.createElement('article');
  card.className = 'media-card';
  card.classList.toggle('is-selected', candidate.selected);
  card.classList.toggle('has-warning', Boolean(candidate.warning));

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'media-check';
  checkbox.checked = candidate.selected;
  checkbox.dataset.candidateId = candidate.id;
  checkbox.setAttribute('aria-label', `Select ${candidate.extension.toUpperCase()} media`);
  card.appendChild(checkbox);

  const body = document.createElement('div');
  body.className = 'media-body';

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'thumb-wrap';
  if (candidate.type === 'image') {
    const image = document.createElement('img');
    image.src = candidate.previewUrl;
    image.alt = '';
    image.loading = 'lazy';
    image.addEventListener('load', () => updateImageDimensions(candidate.id, image));
    image.addEventListener('error', () => markPreviewWarning(candidate.id, 'Preview failed'));
    thumbWrap.appendChild(image);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'thumb-placeholder';
    placeholder.textContent = 'VIDEO';
    thumbWrap.appendChild(placeholder);

    const playBadge = document.createElement('span');
    playBadge.className = 'play-badge';
    playBadge.setAttribute('aria-hidden', 'true');
    playBadge.textContent = '>';
    thumbWrap.appendChild(playBadge);
  }
  body.appendChild(thumbWrap);

  const meta = document.createElement('div');
  meta.className = 'media-meta';

  const metaTop = document.createElement('div');
  metaTop.className = 'meta-top';

  const extBadge = document.createElement('span');
  extBadge.className = 'ext-badge';
  extBadge.textContent = candidate.extension.toUpperCase();
  metaTop.appendChild(extBadge);

  if (candidate.warning) {
    const warning = document.createElement('span');
    warning.className = 'warning-badge';
    warning.textContent = '!';
    warning.title = candidate.warning;
    metaTop.appendChild(warning);
  }

  meta.appendChild(metaTop);

  const dimensions = document.createElement('span');
  dimensions.className = 'dimension-text';
  dimensions.dataset.dimensionFor = candidate.id;
  dimensions.textContent = formatDimensions(candidate);
  meta.appendChild(dimensions);

  const source = document.createElement('span');
  source.className = 'source-text';
  source.title = candidate.url;
  source.textContent = candidate.source;
  meta.appendChild(source);

  body.appendChild(meta);
  card.appendChild(body);

  return card;
}

function renderVisibleCount() {
  const visibleCandidates = getFilteredCandidates();
  const selectedVisible = visibleCandidates.filter((candidate) => candidate.selected).length;
  refs.visibleCount.textContent = `${selectedVisible}/${visibleCandidates.length} visible selected`;
}

function renderFooter() {
  const selected = getSelectedCandidates();
  refs.selectedCount.textContent = `${selected.length} selected`;
  refs.downloadBtn.disabled = selected.length === 0 || state.progress.active;

  const queued = state.progress.queued || 0;
  const finished = state.progress.done + state.progress.failed;
  const percent = queued ? Math.round((finished / queued) * 100) : 0;
  refs.progressBar.style.width = `${Math.min(percent, 100)}%`;
  refs.progressPercent.textContent = `${Math.min(percent, 100)}%`;
  refs.queuedCount.textContent = String(queued);
  refs.doneCount.textContent = String(state.progress.done);
  refs.failedCount.textContent = String(state.progress.failed);

  refs.latestError.hidden = !state.progress.latestError;
  refs.latestError.textContent = state.progress.latestError;
}

function getFilteredCandidates() {
  return state.candidates.filter((candidate) => {
    if (state.filters.type !== 'all' && candidate.type !== state.filters.type) {
      return false;
    }

    if (!state.filters.extensions.includes(candidate.extension)) {
      return false;
    }

    if (state.filters.sameOriginOnly && !candidate.sameOrigin) {
      return false;
    }

    if (state.filters.minDimension > 0 && candidate.width && candidate.height) {
      return Math.min(candidate.width, candidate.height) >= state.filters.minDimension;
    }

    return true;
  });
}

function getSelectedCandidates() {
  return state.candidates.filter((candidate) => candidate.selected);
}

function resetFilters() {
  state.filters = { ...DEFAULT_FILTERS, extensions: [...DEFAULT_FILTERS.extensions] };
  persistState();
  render();
}

function setVisibleSelection(selected) {
  getFilteredCandidates().forEach((candidate) => {
    candidate.selected = selected;
  });
  persistState();
  render();
}

function clearSelection() {
  state.candidates.forEach((candidate) => {
    candidate.selected = false;
  });
  persistState();
  render();
}

function selectLikelyWallpapers() {
  const visibleCandidates = getFilteredCandidates();
  const likelyIds = new Set(
    visibleCandidates
      .filter((candidate) => isLikelyWallpaper(candidate))
      .map((candidate) => candidate.id)
  );

  visibleCandidates.forEach((candidate) => {
    candidate.selected = likelyIds.has(candidate.id);
  });

  setStatus(
    likelyIds.size
      ? `Selected ${likelyIds.size} likely wallpaper candidates.`
      : 'No high-resolution candidates found in the current view.',
    'Ready'
  );
  persistState();
  render();
}

function isLikelyWallpaper(candidate) {
  if (candidate.width && candidate.height) {
    const longSide = Math.max(candidate.width, candidate.height);
    const shortSide = Math.min(candidate.width, candidate.height);
    return longSide >= 1920 && shortSide >= 1080;
  }

  return (
    candidate.source === 'linked original'
    || candidate.source === '4chan original'
    || candidate.source === 'attachment original'
  )
    && (candidate.type === 'image' || candidate.type === 'video');
}

async function downloadSelected() {
  const selected = getSelectedCandidates();
  if (!selected.length || state.progress.active) {
    return;
  }

  const sessionId = `download_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  state.progress = {
    sessionId,
    queued: selected.length,
    done: 0,
    failed: 0,
    latestError: '',
    active: true
  };
  state.isDownloading = true;
  setStatus(`Starting ${selected.length} downloads...`, 'Downloading');
  persistState();
  render();

  chrome.runtime.sendMessage(
    {
      action: 'downloadSelectedMedia',
      sessionId,
      page: {
        host: state.pageHost,
        title: state.pageTitle,
        url: state.pageUrl
      },
      items: selected.map((candidate) => ({
        id: candidate.id,
        url: candidate.url,
        type: candidate.type,
        extension: candidate.extension,
        filename: candidate.filename
      }))
    },
    (response) => {
      if (chrome.runtime.lastError) {
        state.progress.active = false;
        state.progress.latestError = chrome.runtime.lastError.message;
        setStatus(`Download failed: ${chrome.runtime.lastError.message}`, 'Error');
        persistState();
        render();
        return;
      }

      setStatus(response?.status || 'Downloads queued in Chrome.', 'Downloading');
      persistState();
      render();
    }
  );
}

function handleDownloadProgress(message) {
  if (!state.progress.sessionId || message.sessionId !== state.progress.sessionId) {
    return;
  }

  if (message.status === 'complete') {
    state.progress.done += 1;
  }

  if (message.status === 'failed') {
    state.progress.failed += 1;
    state.progress.latestError = message.error || 'A download failed.';
    const candidate = state.candidates.find((item) => item.id === message.itemId);
    if (candidate) {
      candidate.warning = state.progress.latestError;
    }
  }

  const finished = state.progress.done + state.progress.failed;
  if (state.progress.queued && finished >= state.progress.queued) {
    state.progress.active = false;
    state.isDownloading = false;
    setStatus(
      state.progress.failed
        ? `Finished with ${state.progress.failed} failed downloads.`
        : 'All selected downloads completed.',
      state.progress.failed ? 'Warning' : 'Ready'
    );
  }

  persistState();
  render();
}

function updateImageDimensions(candidateId, image) {
  const candidate = state.candidates.find((item) => item.id === candidateId);
  if (!candidate || !image.naturalWidth || !image.naturalHeight) {
    return;
  }

  if (candidate.width === image.naturalWidth && candidate.height === image.naturalHeight) {
    return;
  }

  candidate.width = image.naturalWidth;
  candidate.height = image.naturalHeight;

  if (state.filters.minDimension > 0) {
    renderResults();
  } else {
    const dimensionNode = refs.resultsList.querySelector(`[data-dimension-for="${candidateId}"]`);
    if (dimensionNode) {
      dimensionNode.textContent = formatDimensions(candidate);
    }
  }

  queuePersistState();
  renderFooter();
}

function markPreviewWarning(candidateId, warning) {
  const candidate = state.candidates.find((item) => item.id === candidateId);
  if (candidate && !candidate.warning) {
    candidate.warning = warning;
    renderResults();
    renderFooter();
    queuePersistState();
  }
}

function formatDimensions(candidate) {
  if (candidate.width && candidate.height) {
    return `${candidate.width} x ${candidate.height}`;
  }
  return 'Unknown size';
}

function setStatus(message, chipLabel) {
  state.statusMessage = message;
  state.statusLabel = chipLabel || state.statusLabel || 'Ready';
}

function setTabInfo(tab) {
  state.tabId = tab.id;
  state.pageUrl = tab.url || '';
  state.pageTitle = tab.title || '';
  state.pageHost = hostFromUrl(tab.url) || 'Active tab';
}

async function loadStateForTab(tabId) {
  const key = storageKey(tabId);
  const result = await storageGet(key);
  const savedState = result[key];

  if (!savedState || !Array.isArray(savedState.candidates)) {
    return;
  }

  state = {
    ...createDefaultState(),
    ...savedState,
    tabId,
    filters: {
      ...DEFAULT_FILTERS,
      ...(savedState.filters || {}),
      extensions: Array.isArray(savedState.filters?.extensions)
        ? savedState.filters.extensions
        : [...DEFAULT_FILTERS.extensions]
    },
    progress: {
      ...createDefaultState().progress,
      ...(savedState.progress || {}),
      active: false
    },
    isScanning: false,
    isDownloading: false
  };
  setStatus(
    state.candidates.length
      ? `Restored ${state.candidates.length} media candidates.`
      : 'Scan the active tab to collect media candidates.',
    'Ready'
  );
}

function persistState() {
  if (!state.tabId) {
    return Promise.resolve();
  }

  return storageSet({
    [storageKey(state.tabId)]: {
      pageUrl: state.pageUrl,
      pageHost: state.pageHost,
      pageTitle: state.pageTitle,
      candidates: state.candidates,
      filters: state.filters,
      progress: state.progress,
      statusMessage: state.statusMessage,
      statusLabel: state.statusLabel
    }
  });
}

function queuePersistState() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistState();
  }, 250);
}

function storageKey(tabId) {
  return `${STORAGE_PREFIX}${tabId}`;
}

function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!tabs || !tabs[0]) {
        reject(new Error('No active tab found.'));
        return;
      }
      resolve(tabs[0]);
    });
  });
}

function executeScript(tabId, func) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        function: func
      },
      (results) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(results);
      }
    );
  });
}

function storageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([key], (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function hostFromUrl(url) {
  try {
    return new URL(url).host;
  } catch (error) {
    return '';
  }
}

function normalizeExtension(extension) {
  const normalized = String(extension || '').toLowerCase();
  return normalized === 'jpeg' ? 'jpg' : normalized;
}

function toPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function collectMediaCandidates() {
  const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg']);
  const videoExtensions = new Set(['webm', 'mp4']);
  const pageUrl = new URL(window.location.href);
  const candidatesByUrl = new Map();

  function normalizeUrl(value) {
    if (!value) {
      return null;
    }

    try {
      return new URL(value, window.location.href).href;
    } catch (error) {
      return null;
    }
  }

  function extensionFromUrl(url) {
    try {
      const pathname = new URL(url).pathname;
      const match = pathname.match(/\.([a-z0-9]+)$/i);
      if (!match) {
        return '';
      }
      const extension = match[1].toLowerCase();
      return extension === 'jpeg' ? 'jpg' : extension;
    } catch (error) {
      return '';
    }
  }

  function extensionFromText(text) {
    const match = String(text || '').match(/\.([a-z0-9]{2,5})(?:\s|$)/i);
    if (!match) {
      return '';
    }

    const extension = match[1].toLowerCase();
    return extension === 'jpeg' ? 'jpg' : extension;
  }

  function filenameFromText(text) {
    const match = String(text || '').match(/Name:\s*([^\n\r]+)/i);
    return match ? match[1].trim() : '';
  }

  function typeFromExtension(extension) {
    if (imageExtensions.has(extension) || extension === 'jpg') {
      return 'image';
    }
    if (videoExtensions.has(extension)) {
      return 'video';
    }
    return '';
  }

  function isMediaUrl(url) {
    return Boolean(typeFromExtension(extensionFromUrl(url)));
  }

  function parseDimensions(text) {
    const match = String(text || '').match(/(\d{2,5})\s*x\s*(\d{2,5})/i);
    if (!match) {
      return { width: null, height: null };
    }

    return {
      width: Number(match[1]),
      height: Number(match[2])
    };
  }

  function sameOrigin(url) {
    try {
      return new URL(url).host === pageUrl.host;
    } catch (error) {
      return false;
    }
  }

  function addCandidate(input) {
    const url = normalizeUrl(input.url);
    if (!url) {
      return;
    }

    const extension = input.extension || extensionFromUrl(url);
    const type = input.type || typeFromExtension(extension);
    const hasKnownExtension = imageExtensions.has(extension) || videoExtensions.has(extension) || extension === 'jpg';
    if (!type || (!hasKnownExtension && !input.allowUnknownExtension)) {
      return;
    }

    const existing = candidatesByUrl.get(url);
    const candidate = {
      url,
      previewUrl: normalizeUrl(input.previewUrl) || url,
      type,
      extension: extension || type,
      source: input.source || 'page',
      filename: input.filename || '',
      pageHost: pageUrl.host,
      sameOrigin: sameOrigin(url),
      width: input.width || null,
      height: input.height || null
    };

    if (!existing) {
      candidatesByUrl.set(url, candidate);
      return;
    }

    if (!existing.width && candidate.width) {
      existing.width = candidate.width;
    }
    if (!existing.height && candidate.height) {
      existing.height = candidate.height;
    }
    if (!existing.filename && candidate.filename) {
      existing.filename = candidate.filename;
    }
    if (
      candidate.source === 'linked original'
      || candidate.source === '4chan original'
      || candidate.source === 'attachment original'
    ) {
      existing.source = candidate.source;
      existing.previewUrl = candidate.previewUrl;
    }
  }

  function parseSrcset(srcset) {
    return String(srcset || '')
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  function isPreviewForMediaLink(image) {
    const parentLink = image.closest ? image.closest('a[href]') : null;
    if (!parentLink) {
      return false;
    }

    const imageUrl = normalizeUrl(image.currentSrc || image.src);
    const linkedUrl = normalizeUrl(
      image.dataset?.fullsizeUrl
      || parentLink.dataset?.fullsizeUrl
      || parentLink.href
    );
    const isAttachmentPreview = Boolean(
      image.dataset?.fullsizeUrl
      || image.dataset?.size === 'thumb'
      || parentLink.classList?.contains('bbcode-attachment')
    );

    return Boolean(
      imageUrl
      && linkedUrl
      && imageUrl !== linkedUrl
      && (isMediaUrl(linkedUrl) || isAttachmentPreview)
    );
  }

  Array.from(document.querySelectorAll('a[href] img[data-fullsize-url], a[href].bbcode-attachment img, img[data-fullsize-url]')).forEach((image) => {
    const parentLink = image.closest ? image.closest('a[href]') : null;
    const fullsizeUrl = image.dataset?.fullsizeUrl || parentLink?.href;
    const previewUrl = image.dataset?.thumbUrl || image.currentSrc || image.src;
    const extension = extensionFromUrl(fullsizeUrl) || extensionFromText(image.alt);
    const dimensions = parseDimensions(image.alt);
    const filename = filenameFromText(image.alt);

    addCandidate({
      url: fullsizeUrl,
      previewUrl,
      type: 'image',
      extension,
      filename,
      source: 'attachment original',
      width: dimensions.width,
      height: dimensions.height,
      allowUnknownExtension: true
    });
  });

  Array.from(document.querySelectorAll('.file')).forEach((file) => {
    const fileLink = file.querySelector('.fileText a[href], a.fileThumb[href]');
    if (!fileLink) {
      return;
    }

    const href = normalizeUrl(fileLink.href);
    const type = typeFromExtension(extensionFromUrl(href));
    if (!href || !type) {
      return;
    }

    const thumbnail = file.querySelector('a.fileThumb img, img');
    const fileText = file.querySelector('.fileText');
    const dimensions = parseDimensions(fileText?.textContent || '');
    const filename = fileText?.querySelector('a[href]')?.title || fileText?.querySelector('a[href]')?.textContent || '';

    addCandidate({
      url: href,
      previewUrl: thumbnail ? thumbnail.currentSrc || thumbnail.src : href,
      type,
      source: '4chan original',
      filename,
      width: dimensions.width,
      height: dimensions.height
    });
  });

  Array.from(document.images).forEach((image) => {
    if (isPreviewForMediaLink(image)) {
      return;
    }

    const width = image.naturalWidth || image.width || null;
    const height = image.naturalHeight || image.height || null;
    addCandidate({
      url: image.currentSrc || image.src,
      type: 'image',
      source: 'image element',
      width,
      height
    });

    parseSrcset(image.srcset).forEach((srcsetUrl) => {
      addCandidate({
        url: srcsetUrl,
        type: 'image',
        source: 'srcset',
        width: null,
        height: null
      });
    });
  });

  Array.from(document.querySelectorAll('video')).forEach((video) => {
    addCandidate({
      url: video.currentSrc || video.src,
      type: 'video',
      source: 'video element',
      width: video.videoWidth || null,
      height: video.videoHeight || null
    });

    Array.from(video.querySelectorAll('source')).forEach((source) => {
      addCandidate({
        url: source.src,
        type: 'video',
        source: 'video source',
        width: video.videoWidth || null,
        height: video.videoHeight || null
      });
    });
  });

  Array.from(document.querySelectorAll('a[href]')).forEach((anchor) => {
    const href = normalizeUrl(anchor.href);
    if (!href) {
      return;
    }

    const extension = extensionFromUrl(href);
    const type = typeFromExtension(extension);
    if (!type) {
      return;
    }

    const linkedImage = anchor.querySelector('img');
    addCandidate({
      url: href,
      previewUrl: linkedImage ? linkedImage.currentSrc || linkedImage.src : href,
      type,
      source: linkedImage ? 'linked original' : 'direct link',
      width: null,
      height: null
    });
  });

  return {
    pageUrl: pageUrl.href,
    pageHost: pageUrl.host,
    pageTitle: document.title || pageUrl.host,
    candidates: Array.from(candidatesByUrl.values())
  };
}
