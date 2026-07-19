// popup.js

const STORAGE_PREFIX = 'guided_media_';
const IGNORE_LIST_KEY = `${STORAGE_PREFIX}ignore_list`;
const MAX_IGNORE_ENTRIES = 1000;
const EXTENSIONS = ['jpg', 'png', 'gif', 'webp', 'svg', 'webm', 'mp4'];
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg']);
const VIDEO_EXTENSIONS = new Set(['webm', 'mp4']);
const PAGE_FETCH_TIMEOUT_MS = 30000;
const PAGE_FETCH_CONCURRENCY = {
  conservative: 1,
  normal: 2,
  fast: 4
};
const DEFAULT_FILTERS = {
  type: 'all',
  extensions: EXTENSIONS,
  sameOriginOnly: false,
  minDimension: 65
};
const DEFAULT_DOWNLOAD_SETTINGS = PopupState.normalizeDownloadSettings();

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
  filterToggleBtn: document.getElementById('filterToggleBtn'),
  filterPanel: document.getElementById('filterPanel'),
  minDimension: document.getElementById('minDimension'),
  downloadSpeed: document.getElementById('downloadSpeed'),
  destinationFolder: document.getElementById('destinationFolder'),
  resetFiltersBtn: document.getElementById('resetFiltersBtn'),
  selectLikelyBtn: document.getElementById('selectLikelyBtn'),
  selectAllBtn: document.getElementById('selectAllBtn'),
  selectNoneBtn: document.getElementById('selectNoneBtn'),
  ignoreSelectedBtn: document.getElementById('ignoreSelectedBtn'),
  clearIgnoresBtn: document.getElementById('clearIgnoresBtn'),
  clearSelectionBtn: document.getElementById('clearSelectionBtn'),
  visibleCount: document.getElementById('visibleCount'),
  ignoredCount: document.getElementById('ignoredCount'),
  emptyState: document.getElementById('emptyState'),
  resultsList: document.getElementById('resultsList'),
  selectedCount: document.getElementById('selectedCount'),
  progressBar: document.getElementById('progressBar'),
  progressPercent: document.getElementById('progressPercent'),
  queuedCount: document.getElementById('queuedCount'),
  doneCount: document.getElementById('doneCount'),
  failedCount: document.getElementById('failedCount'),
  cancelledCount: document.getElementById('cancelledCount'),
  latestError: document.getElementById('latestError'),
  confirmationPanel: document.getElementById('confirmationPanel'),
  confirmationText: document.getElementById('confirmationText'),
  cancelConfirmBtn: document.getElementById('cancelConfirmBtn'),
  confirmDownloadBtn: document.getElementById('confirmDownloadBtn'),
  downloadBtn: document.getElementById('downloadBtn')
};

let state = createDefaultState();
let persistTimer = null;
let filtersOpen = false;
let confirmationOpen = false;

document.addEventListener('DOMContentLoaded', init);

function createDefaultState() {
  return {
    tabId: null,
    pageUrl: '',
    pageHost: 'Active tab',
    pageTitle: '',
    candidates: [],
    ignoreList: [],
    filters: { ...DEFAULT_FILTERS, extensions: [...DEFAULT_FILTERS.extensions] },
    downloadSettings: { ...DEFAULT_DOWNLOAD_SETTINGS },
    progress: PopupState.normalizeProgress(),
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
    await loadIgnoreList();
    await loadStateForTab(tab.id);
    applyIgnoreListToCandidates();
    render();
  } catch (error) {
    setStatus(`Error: ${error.message}`, 'Error');
    render();
  }
}

function wireEvents() {
  refs.scanBtn.addEventListener('click', scanPage);
  refs.filterToggleBtn.addEventListener('click', () => {
    filtersOpen = !filtersOpen;
    renderFilters();
  });
  refs.sameOriginOnly.addEventListener('change', () => {
    state.filters.sameOriginOnly = refs.sameOriginOnly.checked;
    persistState();
    render();
  });
  refs.minDimension.addEventListener('change', () => {
    state.filters.minDimension = Number(refs.minDimension.value) || 0;
    deselectCandidatesBelowMinimum();
    persistState();
    render();
  });
  refs.downloadSpeed.addEventListener('change', () => {
    state.downloadSettings.speedMode = normalizeDownloadSpeed(refs.downloadSpeed.value);
    persistState();
    render();
  });
  refs.destinationFolder.addEventListener('input', () => {
    state.downloadSettings.subfolder = DownloadUtils.sanitizeSubfolder(refs.destinationFolder.value);
    state.downloadSettings.autoSubfolder = false;
    refs.destinationFolder.value = state.downloadSettings.subfolder;
    renderConfirmationText();
    queuePersistState();
  });
  refs.resetFiltersBtn.addEventListener('click', resetFilters);
  refs.selectLikelyBtn.addEventListener('click', selectLikelyWallpapers);
  refs.selectAllBtn.addEventListener('click', () => setVisibleSelection(true));
  refs.selectNoneBtn.addEventListener('click', () => setVisibleSelection(false));
  refs.ignoreSelectedBtn.addEventListener('click', ignoreSelectedMedia);
  refs.clearIgnoresBtn.addEventListener('click', clearIgnoredMedia);
  refs.clearSelectionBtn.addEventListener('click', clearSelection);
  refs.cancelConfirmBtn.addEventListener('click', () => {
    confirmationOpen = false;
    renderFooter();
  });
  refs.confirmDownloadBtn.addEventListener('click', () => {
    confirmationOpen = false;
    downloadSelected();
  });
  refs.downloadBtn.addEventListener('click', () => {
    if (state.progress.active) {
      abortDownloadSession();
      return;
    }

    requestDownloadSelected();
  });

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
      confirmationOpen = false;
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
  if (state.progress.active) {
    return;
  }

  state.isScanning = true;
  confirmationOpen = false;
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
    updateSuggestedDestination();
    state.candidates = candidates.map(normalizeCandidate);
    const ignoredCount = applyIgnoreListToCandidates();
    await hydrateSnapshotPreviews(tab.windowId);
    state.isScanning = false;

    setStatus(
      state.candidates.length
        ? `Found ${activeCandidateCount()} media candidates${ignoredCount ? `; hid ${ignoredCount} ignored.` : '.'}`
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
  const normalizedCandidate = {
    id: `media_${index}_${hashString(candidate.url || String(index))}`,
    url: candidate.url,
    previewUrl: candidate.previewUrl || candidate.url,
    type: candidate.type,
    extension,
    source: candidate.source || 'page',
    filename: candidate.filename || '',
    filenameHints: Array.isArray(candidate.filenameHints) ? candidate.filenameHints : [],
    fallbackUrls: Array.isArray(candidate.fallbackUrls) ? candidate.fallbackUrls.filter(Boolean) : [],
    downloadMode: candidate.downloadMode || 'chrome',
    headers: Array.isArray(candidate.headers) ? candidate.headers : [],
    pageHost: candidate.pageHost || state.pageHost,
    sameOrigin: Boolean(candidate.sameOrigin),
    width: toPositiveNumber(candidate.width),
    height: toPositiveNumber(candidate.height),
    snapshotRect: candidate.snapshotRect || null,
    selected: true,
    ignored: false,
    ignoreFingerprints: [],
    warning: ''
  };

  normalizedCandidate.ignoreFingerprints = buildCandidateFingerprints(normalizedCandidate);
  normalizedCandidate.ignored = isCandidateIgnored(normalizedCandidate);
  if (normalizedCandidate.ignored) {
    normalizedCandidate.selected = false;
  }

  return normalizedCandidate;
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
      ? state.progress.phase === 'aborting' ? 'Aborting' : 'Downloading'
      : state.statusLabel;
  refs.tabStatus.classList.toggle('is-warning', ['Warning', 'Aborting'].includes(refs.tabStatus.textContent));
  refs.tabStatus.classList.toggle('is-danger', ['Error', 'Aborted'].includes(refs.tabStatus.textContent));
  refs.scanBtn.disabled = state.isScanning || state.progress.active;
  refs.scanBtn.textContent = state.isScanning
    ? 'Scanning...'
    : state.candidates.length ? 'Rescan' : 'Scan';
  refs.statusText.textContent = state.statusMessage;
}

function renderSummary() {
  const activeCandidates = getActiveCandidates();
  const imageCount = activeCandidates.filter((candidate) => candidate.type === 'image').length;
  const videoCount = activeCandidates.filter((candidate) => candidate.type === 'video').length;
  refs.totalCount.textContent = String(activeCandidates.length);
  refs.imageCount.textContent = String(imageCount);
  refs.videoCount.textContent = String(videoCount);
}

function renderFilters() {
  const locked = state.progress.active;
  refs.filterPanel.hidden = !filtersOpen;
  refs.filterToggleBtn.setAttribute('aria-expanded', String(filtersOpen));
  refs.filterToggleBtn.disabled = locked;
  const activeFilterCount = Number(state.filters.sameOriginOnly)
    + Number(state.filters.minDimension !== DEFAULT_FILTERS.minDimension)
    + Number(state.filters.extensions.length !== EXTENSIONS.length);
  refs.filterToggleBtn.textContent = activeFilterCount ? `Filters ${activeFilterCount}` : 'Filters';
  document.querySelectorAll('[data-type-filter]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.typeFilter === state.filters.type);
    button.disabled = locked;
  });

  refs.sameOriginOnly.checked = state.filters.sameOriginOnly;
  refs.sameOriginOnly.disabled = locked;
  refs.minDimension.value = String(state.filters.minDimension);
  refs.minDimension.disabled = locked;
  refs.downloadSpeed.value = normalizeDownloadSpeed(state.downloadSettings.speedMode);
  refs.downloadSpeed.disabled = locked;
  refs.resetFiltersBtn.disabled = locked;

  refs.extensionFilters.querySelectorAll('[data-extension]').forEach((button) => {
    button.classList.toggle('is-active', state.filters.extensions.includes(button.dataset.extension));
    button.disabled = locked;
  });
}

function renderResults() {
  const visibleCandidates = getFilteredCandidates();
  const selectedFilenames = new Map(
    DownloadUtils.prepareDownloadItems(getSelectedCandidates(), currentPageInfo())
      .map((candidate) => [candidate.id, candidate.filename])
  );
  refs.resultsList.textContent = '';

  refs.emptyState.hidden = visibleCandidates.length > 0;
  refs.emptyState.textContent = getActiveCandidates().length
    ? 'No media match the current filters.'
    : state.candidates.length
      ? 'All scanned media are ignored.'
      : 'No media scanned yet.';

  visibleCandidates.forEach((candidate) => {
    refs.resultsList.appendChild(createMediaCard(candidate, selectedFilenames.get(candidate.id)));
  });

  renderVisibleCount();
}

function createMediaCard(candidate, selectedFilename = '') {
  const card = document.createElement('article');
  card.className = 'media-card';
  card.classList.toggle('is-selected', candidate.selected);
  card.classList.toggle('has-warning', Boolean(candidate.warning));

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'media-check';
  checkbox.checked = candidate.selected;
  checkbox.disabled = state.progress.active;
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
    image.addEventListener('error', () => handleImagePreviewError(candidate.id, image));
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

  const filename = document.createElement('span');
  filename.className = 'filename-text';
  filename.textContent = selectedFilename || proposedFilename(candidate);
  filename.title = filename.textContent;
  meta.appendChild(filename);

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
  if (!PopupState.needsLargeBatchConfirmation(selected.length) || state.progress.active) {
    confirmationOpen = false;
  }
  refs.destinationFolder.value = state.downloadSettings.subfolder || '';
  refs.destinationFolder.disabled = state.progress.active;
  refs.selectedCount.textContent = `${selected.length} selected`;
  refs.downloadBtn.disabled = state.progress.phase === 'aborting' || (!state.progress.active && selected.length === 0);
  refs.downloadBtn.textContent = state.progress.active
    ? state.progress.phase === 'aborting' ? 'Aborting...' : 'Abort batch'
    : selected.length
      ? `${isRetrySelection(selected) ? 'Retry' : 'Download'} ${selected.length} files`
      : 'Select files';
  refs.downloadBtn.classList.toggle('is-abort', state.progress.active);
  refs.downloadBtn.hidden = confirmationOpen;
  refs.confirmationPanel.hidden = !confirmationOpen;
  renderConfirmationText();
  refs.confirmDownloadBtn.textContent = `Start ${selected.length} downloads`;
  refs.ignoreSelectedBtn.disabled = selected.length === 0 || state.progress.active;
  refs.clearIgnoresBtn.disabled = state.ignoreList.length === 0 || state.progress.active;
  refs.selectAllBtn.disabled = state.progress.active;
  refs.selectNoneBtn.disabled = state.progress.active;
  refs.clearSelectionBtn.disabled = state.progress.active;
  refs.selectLikelyBtn.disabled = state.progress.active;
  refs.ignoredCount.textContent = `${state.ignoreList.length} ignored`;

  const queued = state.progress.queued || 0;
  const finished = state.progress.done + state.progress.failed + state.progress.cancelled;
  const percent = queued ? Math.round((finished / queued) * 100) : 0;
  refs.progressBar.style.width = `${Math.min(percent, 100)}%`;
  refs.progressPercent.textContent = `${Math.min(percent, 100)}%`;
  refs.queuedCount.textContent = String(queued);
  refs.doneCount.textContent = String(state.progress.done);
  refs.failedCount.textContent = String(state.progress.failed);
  refs.cancelledCount.textContent = String(state.progress.cancelled);

  refs.latestError.hidden = !state.progress.latestError;
  refs.latestError.textContent = state.progress.latestError;
}

function getFilteredCandidates() {
  return state.candidates.filter((candidate) => passesCurrentFilters(candidate));
}

function getActiveCandidates() {
  return state.candidates.filter((candidate) => !candidate.ignored);
}

function getSelectedCandidates() {
  return state.candidates.filter((candidate) => candidate.selected && passesCurrentFilters(candidate));
}

function passesCurrentFilters(candidate) {
  if (candidate.ignored) {
    return false;
  }

  if (state.filters.type !== 'all' && candidate.type !== state.filters.type) {
    return false;
  }

  if (!passesExtensionFilter(candidate)) {
    return false;
  }

  if (state.filters.sameOriginOnly && !candidate.sameOrigin) {
    return false;
  }

  if (state.filters.minDimension > 0 && candidate.width && candidate.height) {
    return Math.min(candidate.width, candidate.height) >= state.filters.minDimension;
  }

  return true;
}

function passesExtensionFilter(candidate) {
  if (state.filters.extensions.includes(candidate.extension)) {
    return true;
  }

  if (candidate.type === 'image' && !IMAGE_EXTENSIONS.has(candidate.extension)) {
    return allMediaTypeExtensionsSelected(IMAGE_EXTENSIONS);
  }

  if (candidate.type === 'video' && !VIDEO_EXTENSIONS.has(candidate.extension)) {
    return allMediaTypeExtensionsSelected(VIDEO_EXTENSIONS);
  }

  return false;
}

function allMediaTypeExtensionsSelected(extensionSet) {
  return EXTENSIONS
    .filter((extension) => extensionSet.has(extension))
    .every((extension) => state.filters.extensions.includes(extension));
}

function resetFilters() {
  state.filters = { ...DEFAULT_FILTERS, extensions: [...DEFAULT_FILTERS.extensions] };
  deselectCandidatesBelowMinimum();
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

async function ignoreSelectedMedia() {
  const selected = getSelectedCandidates();
  if (!selected.length) {
    return;
  }

  const entriesByFingerprint = new Map(
    state.ignoreList.map((entry) => [entry.fingerprint, entry])
  );
  let ignoredCount = 0;

  selected.forEach((candidate) => {
    candidate.ignoreFingerprints = buildCandidateFingerprints(candidate);
    candidate.ignoreFingerprints.forEach((fingerprint) => {
      entriesByFingerprint.set(fingerprint, buildIgnoreEntry(candidate, fingerprint));
    });
    candidate.ignored = true;
    candidate.selected = false;
    ignoredCount += 1;
  });

  state.ignoreList = Array.from(entriesByFingerprint.values()).slice(-MAX_IGNORE_ENTRIES);
  setStatus(`Ignored ${ignoredCount} selected media item${ignoredCount === 1 ? '' : 's'}.`, 'Ready');
  await persistIgnoreList();
  await persistState();
  render();
}

async function clearIgnoredMedia() {
  if (!state.ignoreList.length) {
    return;
  }

  const restoredCount = state.candidates.filter((candidate) => candidate.ignored).length;
  state.ignoreList = [];
  state.candidates.forEach((candidate) => {
    candidate.ignored = false;
  });
  setStatus(
    restoredCount
      ? `Cleared ignore list; restored ${restoredCount} current media items.`
      : 'Cleared ignore list.',
    'Ready'
  );
  await persistIgnoreList();
  await persistState();
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
  ensureDownloadDestination();
  const selected = DownloadUtils.prepareDownloadItems(
    getSelectedCandidates(),
    currentPageInfo()
  );
  if (!selected.length || state.progress.active) {
    return;
  }

  const sessionId = `download_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  state.progress = {
    sessionId,
    queued: selected.length,
    done: 0,
    failed: 0,
    cancelled: 0,
    itemIds: selected.map((candidate) => candidate.id),
    completedItemIds: [],
    failedItemIds: [],
    cancelledItemIds: [],
    latestError: '',
    phase: 'preparing',
    active: true
  };
  state.isDownloading = true;
  setStatus(`Starting ${selected.length} downloads...`, 'Downloading');
  persistState();
  render();

  const pageDownloads = selected.filter((candidate) => candidate.downloadMode === 'page' && !isPximgUrl(candidate.url));
  const chromeDownloads = selected.filter((candidate) => candidate.downloadMode !== 'page' || isPximgUrl(candidate.url));

  if (chromeDownloads.length) {
    await queuePreparedDownloads(sessionId, chromeDownloads);
  }

  if (pageDownloads.length && isCurrentDownloadSessionActive(sessionId)) {
    await prepareAndQueuePageDownloads(sessionId, pageDownloads);
  }

  finishDownloadSessionIfDone();
  persistState();
  render();
}

async function prepareAndQueuePageDownloads(sessionId, pageDownloads) {
  let fetchConcurrency = pageFetchConcurrencyForSpeed(state.downloadSettings.speedMode);
  let index = 0;

  while (index < pageDownloads.length && state.progress.active) {
    const batch = pageDownloads.slice(index, index + fetchConcurrency);
    const start = index + 1;
    const end = index + batch.length;
    setStatus(`Preparing forum attachments ${start}-${end}/${pageDownloads.length}...`, 'Downloading');
    persistState();
    render();

    try {
      const results = await executeScriptWithArgs(state.tabId, fetchMediaFromPage, [
        batch.map(toPageFetchItem),
        {
          concurrency: fetchConcurrency,
          timeoutMs: PAGE_FETCH_TIMEOUT_MS,
          sessionId
        }
      ]);
      const result = results?.[0]?.result || {};
      const fetchedItems = Array.isArray(result.items) ? result.items : [];
      const failed = Array.isArray(result.failed) ? result.failed : [];

      if (!isCurrentDownloadSessionActive(sessionId)) {
        return;
      }

      if (fetchedItems.length) {
        await queuePreparedDownloads(sessionId, fetchedItems);
      }

      if (failed.length) {
        markPreparedDownloadsFailed(failed, failed[0].error || 'An attachment fetch failed.');
        fetchConcurrency = reducePageFetchConcurrency(fetchConcurrency);
      }
    } catch (error) {
      if (!isCurrentDownloadSessionActive(sessionId)) {
        return;
      }

      markPreparedDownloadsFailed(batch, error.message || 'Could not prepare attachments.');
      fetchConcurrency = reducePageFetchConcurrency(fetchConcurrency);
    }

    index += batch.length;
    finishDownloadSessionIfDone();
    persistState();
    render();
  }

  if (state.progress.active) {
    setStatus('Forum attachments prepared; waiting for downloads...', 'Downloading');
  }
}

async function queuePreparedDownloads(sessionId, candidates) {
  if (!candidates.length || !isCurrentDownloadSessionActive(sessionId)) {
    return;
  }

  try {
    const response = await sendDownloadsToBackground(sessionId, candidates.map(toDownloadItem));
    if (response?.error) {
      throw new Error(response.error);
    }
    if (!isCurrentDownloadSessionActive(sessionId) || response?.cancelled) {
      return;
    }

    state.progress.phase = 'downloading';
    setStatus(response?.status || `${candidates.length} downloads queued in Chrome.`, 'Downloading');
  } catch (error) {
    markPreparedDownloadsFailed(candidates, error.message || 'Chrome could not start the downloads.');
  }

  finishDownloadSessionIfDone();
  persistState();
  render();
}

function renderConfirmationText() {
  if (!confirmationOpen) {
    refs.confirmationText.textContent = '';
    return;
  }

  const selectedCount = getSelectedCandidates().length;
  const speedLabels = { conservative: 'Careful', normal: 'Balanced', fast: 'Fast' };
  const speedLabel = speedLabels[normalizeDownloadSpeed(state.downloadSettings.speedMode)];
  refs.confirmationText.textContent = `Start ${selectedCount} downloads to ImageDownloader/${state.downloadSettings.subfolder} at ${speedLabel} speed?`;
}

function requestDownloadSelected() {
  const selected = getSelectedCandidates();
  if (!selected.length || state.progress.active) {
    return;
  }

  ensureDownloadDestination();
  renderFooter();

  if (PopupState.needsLargeBatchConfirmation(selected.length)) {
    confirmationOpen = true;
    renderFooter();
    refs.cancelConfirmBtn.focus();
    return;
  }

  downloadSelected();
}

async function abortDownloadSession() {
  const sessionId = state.progress.sessionId;
  if (!sessionId || !state.progress.active || state.progress.phase === 'aborting') {
    return;
  }

  state.progress.phase = 'aborting';
  setStatus('Aborting download batch...', 'Aborting');
  persistState();
  render();

  let response;
  try {
    response = await sendCancelToBackground(sessionId);
    if (!response?.cancelled) {
      throw new Error(response?.error || response?.status || 'Chrome did not confirm the abort request.');
    }
  } catch (error) {
    state.progress.latestError = error.message || 'Chrome could not confirm the abort request.';
    state.progress.phase = 'downloading';
    state.progress.active = true;
    setStatus(state.progress.latestError, 'Warning');
    await persistState();
    render();
    return;
  }

  if (state.progress.sessionId !== sessionId) {
    return;
  }

  await cancelPageFetchesInTab(sessionId);
  applyTerminalSummary(response);
  remainingProgressItemIds().forEach((itemId) => recordItemOutcome(itemId, 'cancelled'));
  state.progress.active = false;
  state.progress.phase = 'aborted';
  state.isDownloading = false;
  state.progress.latestError = '';
  syncTerminalSelection();
  setStatus(
    `Batch aborted. ${state.progress.done} completed before it stopped.`,
    'Aborted'
  );
  await persistState();
  render();
}

function sendCancelToBackground(sessionId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'cancelDownloadSession', sessionId },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(response || {});
      }
    );
  });
}

async function cancelPageFetchesInTab(sessionId) {
  if (!state.tabId) {
    return;
  }

  try {
    await executeScriptWithArgs(state.tabId, cancelPageFetchSession, [sessionId]);
  } catch (error) {
    // The page may have navigated or closed; background cancellation still stands.
  }
}

function isCurrentDownloadSessionActive(sessionId) {
  return state.progress.active
    && state.progress.phase !== 'aborting'
    && state.progress.sessionId === sessionId;
}

function sendDownloadsToBackground(sessionId, items) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        action: 'downloadSelectedMedia',
        sessionId,
        page: {
          host: state.pageHost,
          title: state.pageTitle,
          url: state.pageUrl
        },
        downloadSettings: {
          speedMode: normalizeDownloadSpeed(state.downloadSettings.speedMode),
          subfolder: DownloadUtils.sanitizeSubfolder(state.downloadSettings.subfolder)
        },
        items
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(response);
      }
    );
  });
}

function toDownloadItem(candidate) {
  return {
    id: candidate.id,
    url: candidate.url,
    type: candidate.type,
    extension: candidate.extension,
    filename: candidate.filename,
    filenameHints: candidate.filenameHints || [],
    fallbackUrls: candidate.fallbackUrls || [],
    responseFilename: candidate.responseFilename || '',
    finalUrl: candidate.finalUrl || '',
    headers: downloadHeadersForCandidate(candidate)
  };
}

function downloadHeadersForCandidate(candidate) {
  if (isPximgUrl(candidate.url)) {
    return [];
  }

  return candidate.headers || [];
}

function toPageFetchItem(candidate) {
  return {
    url: candidate.url,
    filename: candidate.filename || '',
    extension: candidate.extension,
    type: candidate.type,
    id: candidate.id
  };
}

function markPreparedDownloadsFailed(candidates, error) {
  state.progress.latestError = error;

  candidates.forEach((candidate) => {
    recordItemOutcome(candidate.id, 'failed');
    const item = state.candidates.find((stateCandidate) => stateCandidate.id === candidate.id);
    if (item) {
      item.warning = error;
    }
  });
}

function pageFetchConcurrencyForSpeed(speedMode) {
  return PAGE_FETCH_CONCURRENCY[normalizeDownloadSpeed(speedMode)] || PAGE_FETCH_CONCURRENCY.normal;
}

function reducePageFetchConcurrency(concurrency) {
  return Math.max(1, Math.min(2, Math.floor(concurrency / 2) || 1));
}

function finishDownloadSessionIfDone() {
  const finished = state.progress.done + state.progress.failed + state.progress.cancelled;
  if (state.progress.queued && finished >= state.progress.queued) {
    state.progress.active = false;
    state.progress.phase = state.progress.cancelled
      ? 'aborted'
      : state.progress.failed ? 'completed-with-errors' : 'completed';
    state.isDownloading = false;
    syncTerminalSelection();
    if (state.progress.cancelled) {
      state.progress.latestError = '';
      setStatus(`Batch aborted. ${state.progress.done} completed before it stopped.`, 'Aborted');
    } else if (state.progress.failed) {
      setStatus(`Finished with ${state.progress.failed} failed downloads.`, 'Warning');
    } else {
      state.progress.latestError = '';
      setStatus('All selected downloads completed.', 'Ready');
    }
  }
}

function syncTerminalSelection() {
  const sessionItemIds = new Set(state.progress.itemIds || []);
  const retryableItemIds = new Set(PopupState.retryableItemIds(state.progress));
  state.candidates.forEach((candidate) => {
    if (sessionItemIds.has(candidate.id)) {
      candidate.selected = retryableItemIds.has(candidate.id);
    }
  });
}

function isRetrySelection(selectedCandidates) {
  if (!['aborted', 'completed-with-errors'].includes(state.progress.phase)) {
    return false;
  }

  const retryableItemIds = new Set(PopupState.retryableItemIds(state.progress));
  return selectedCandidates.length > 0
    && selectedCandidates.every((candidate) => retryableItemIds.has(candidate.id));
}

function handleDownloadProgress(message) {
  if (!state.progress.sessionId || message.sessionId !== state.progress.sessionId) {
    return;
  }

  const terminalMessage = ['complete', 'failed', 'aborted'].includes(message.status);
  if ((state.progress.phase === 'aborting' || state.progress.phase === 'aborted') && !terminalMessage) {
    return;
  }

  if (message.status === 'started') {
    state.progress.phase = 'downloading';
  }

  if (message.status === 'aborted') {
    applyTerminalSummary(message);
    remainingProgressItemIds().forEach((itemId) => recordItemOutcome(itemId, 'cancelled'));
    state.progress.active = false;
    state.progress.phase = 'aborted';
    state.isDownloading = false;
    state.progress.latestError = '';
    syncTerminalSelection();
    setStatus(`Batch aborted. ${state.progress.done} completed before it stopped.`, 'Aborted');
  }

  if (message.status === 'complete') {
    recordItemOutcome(message.itemId, 'completed');
  }

  if (message.status === 'retry') {
    const concurrencyText = message.concurrency
      ? ` Retrying with ${message.concurrency} at a time.`
      : ' Retrying slower.';
    state.progress.latestError = `${message.error || 'Download stalled.'}${concurrencyText}`;
    setStatus(state.progress.latestError, 'Downloading');
  }

  if (message.status === 'throttled') {
    state.progress.latestError = message.concurrency
      ? `Host is slow; throttled to ${message.concurrency} downloads at a time.`
      : 'Host is slow; throttled downloads.';
    setStatus(state.progress.latestError, 'Downloading');
  }

  if (message.status === 'fallback') {
    state.progress.latestError = message.message || 'Original unavailable; using the best available Pixiv image.';
    setStatus(state.progress.latestError, 'Downloading');
  }

  if (message.status === 'failed') {
    recordItemOutcome(message.itemId, 'failed');
    state.progress.latestError = message.error || 'A download failed.';
    const candidate = state.candidates.find((item) => item.id === message.itemId);
    if (candidate) {
      candidate.warning = state.progress.latestError;
    }
  }

  finishDownloadSessionIfDone();

  persistState();
  render();
}

function updateImageDimensions(candidateId, image) {
  const candidate = state.candidates.find((item) => item.id === candidateId);
  if (!candidate || !image.naturalWidth || !image.naturalHeight) {
    return;
  }

  if (!shouldLearnDimensionsFromPreview(candidate)) {
    return;
  }

  if (candidate.width === image.naturalWidth && candidate.height === image.naturalHeight) {
    return;
  }

  candidate.width = image.naturalWidth;
  candidate.height = image.naturalHeight;

  deselectCandidateBelowMinimum(candidate);

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

function shouldLearnDimensionsFromPreview(candidate) {
  if (candidate.snapshotRect) {
    return false;
  }

  const previewUrl = candidate.previewUrl || '';
  const mediaUrl = candidate.url || '';
  const previewIsSeparateMedia = previewUrl && mediaUrl && previewUrl !== mediaUrl;
  const sourceUsesPreviewForOriginal = [
    'attachment original',
    '4chan original',
    'linked original',
    'pixiv original'
  ].includes(candidate.source);

  return !(previewIsSeparateMedia && sourceUsesPreviewForOriginal);
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

async function handleImagePreviewError(candidateId, image) {
  const candidate = state.candidates.find((item) => item.id === candidateId);
  if (!candidate) {
    return;
  }

  if (candidate.previewFetchPending) {
    return;
  }

  if (!isPximgUrl(candidate.previewUrl)) {
    markPreviewWarning(candidateId, 'Preview failed');
    return;
  }

  candidate.previewFetchPending = true;

  try {
    const dataUrl = await fetchPximgPreviewDataUrl(candidate.previewUrl);
    candidate.previewUrl = dataUrl;
    candidate.warning = '';
    image.src = dataUrl;
  } catch (error) {
    markPreviewWarning(candidateId, error.message || 'Preview failed');
  } finally {
    delete candidate.previewFetchPending;
  }

  queuePersistState();
  renderResults();
  renderFooter();
}

function fetchPximgPreviewDataUrl(url) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        action: 'fetchPximgPreview',
        url,
        page: {
          url: state.pageUrl
        }
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (response?.dataUrl) {
          resolve(response.dataUrl);
          return;
        }

        reject(new Error(response?.error || 'Preview failed'));
      }
    );
  });
}

async function hydrateSnapshotPreviews(windowId) {
  const candidates = state.candidates.filter((candidate) => hasUsableSnapshotRect(candidate.snapshotRect));
  if (!candidates.length) {
    return;
  }

  try {
    const screenshotUrl = await captureVisibleTab(windowId);
    const screenshot = await loadImage(screenshotUrl);

    candidates.forEach((candidate) => {
      const previewUrl = cropSnapshotPreview(screenshot, candidate.snapshotRect);
      if (previewUrl) {
        candidate.previewUrl = previewUrl;
      }
    });
  } catch (error) {
    candidates.forEach((candidate) => {
      candidate.warning = candidate.warning || 'Snapshot preview unavailable';
    });
  }
}

function hasUsableSnapshotRect(rect) {
  return rect
    && rect.width > 8
    && rect.height > 8
    && rect.viewportWidth > 0
    && rect.viewportHeight > 0;
}

function captureVisibleTab(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 82 }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        reject(new Error(chrome.runtime.lastError?.message || 'Could not capture tab preview.'));
        return;
      }
      resolve(dataUrl);
    });
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load captured preview.'));
    image.src = src;
  });
}

function cropSnapshotPreview(screenshot, rect) {
  const scaleX = screenshot.naturalWidth / rect.viewportWidth;
  const scaleY = screenshot.naturalHeight / rect.viewportHeight;
  const sourceX = Math.max(0, Math.round(rect.left * scaleX));
  const sourceY = Math.max(0, Math.round(rect.top * scaleY));
  const sourceWidth = Math.min(screenshot.naturalWidth - sourceX, Math.round(rect.width * scaleX));
  const sourceHeight = Math.min(screenshot.naturalHeight - sourceY, Math.round(rect.height * scaleY));

  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return '';
  }

  const maxSide = 260;
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext('2d');
  context.drawImage(screenshot, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.84);
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
  const previousPageUrl = state.pageUrl;
  state.tabId = tab.id;
  state.pageUrl = tab.url || '';
  state.pageTitle = tab.title || '';
  state.pageHost = hostFromUrl(tab.url) || 'Active tab';
  if (!isSamePageUrl(previousPageUrl, state.pageUrl)) {
    state.downloadSettings.autoSubfolder = true;
  }
  updateSuggestedDestination();
}

function updateSuggestedDestination() {
  if (!state.downloadSettings.autoSubfolder && state.downloadSettings.subfolder) {
    return;
  }

  state.downloadSettings.subfolder = DownloadUtils.buildSuggestedSubfolder(currentPageInfo());
  state.downloadSettings.autoSubfolder = true;
}

function ensureDownloadDestination() {
  state.downloadSettings.subfolder = DownloadUtils.sanitizeSubfolder(state.downloadSettings.subfolder);
  if (!state.downloadSettings.subfolder) {
    state.downloadSettings.autoSubfolder = true;
    updateSuggestedDestination();
  }
}

function currentPageInfo() {
  return {
    host: state.pageHost,
    title: state.pageTitle,
    url: state.pageUrl
  };
}

function proposedFilename(candidate) {
  const index = Math.max(0, state.candidates.indexOf(candidate));
  return DownloadUtils.resolveFilename(candidate, index, currentPageInfo());
}

async function loadStateForTab(tabId) {
  const key = storageKey(tabId);
  const result = await storageGet(key);
  const savedState = result[key];
  const ignoreList = state.ignoreList;

  if (!savedState || !Array.isArray(savedState.candidates)) {
    return;
  }

  if (!isSamePageUrl(savedState.pageUrl, state.pageUrl)) {
    await storageRemove(key);
    state.progress = createDefaultState().progress;
    state.candidates = [];
    setStatus('Scan the active tab to collect media candidates.', 'Ready');
    return;
  }

  state = {
    ...createDefaultState(),
    ...savedState,
    tabId,
    ignoreList,
    filters: {
      ...DEFAULT_FILTERS,
      ...(savedState.filters || {}),
      extensions: Array.isArray(savedState.filters?.extensions)
        ? savedState.filters.extensions
        : [...DEFAULT_FILTERS.extensions]
    },
    progress: PopupState.normalizeProgress(savedState.progress),
    downloadSettings: normalizeStoredDownloadSettings(savedState.downloadSettings),
    isScanning: false,
    isDownloading: false
  };
  updateSuggestedDestination();
  await reconcileRestoredDownloadSession();
  deselectCandidatesBelowMinimum();
  if (!state.progress.active && state.progress.phase !== 'aborted') {
    setStatus(
      state.candidates.length
        ? `Restored ${state.candidates.length} media candidates.`
        : 'Scan the active tab to collect media candidates.',
      'Ready'
    );
  }
}

function applyTerminalSummary(summary) {
  (summary.completedItemIds || []).forEach((itemId) => recordItemOutcome(itemId, 'completed'));
  (summary.failedItemIds || []).forEach((itemId) => recordItemOutcome(itemId, 'failed'));
  (summary.cancelledItemIds || []).forEach((itemId) => recordItemOutcome(itemId, 'cancelled'));
}

function recordItemOutcome(itemId, outcome) {
  PopupState.recordOutcome(state.progress, itemId, outcome);
}

function remainingProgressItemIds() {
  return PopupState.remainingItemIds(state.progress);
}

async function reconcileRestoredDownloadSession() {
  const sessionId = state.progress.sessionId;
  const activePhase = ['preparing', 'downloading', 'aborting'].includes(state.progress.phase);
  if (!sessionId || (!state.progress.active && !activePhase)) {
    return;
  }

  try {
    const status = await getBackgroundDownloadSessionStatus(sessionId);
    applyTerminalSummary(status);
    if (status.active) {
      state.progress.active = true;
      state.progress.phase = status.status === 'preparing' ? 'preparing' : 'downloading';
      state.isDownloading = true;
      setStatus('Download batch is still running.', 'Downloading');
      return;
    }

    state.progress.active = false;
    state.isDownloading = false;
    if (status.status === 'aborted') {
      state.progress.phase = 'aborted';
      remainingProgressItemIds().forEach((itemId) => recordItemOutcome(itemId, 'cancelled'));
      state.progress.latestError = '';
      syncTerminalSelection();
      setStatus(`Batch aborted. ${state.progress.done} completed before it stopped.`, 'Aborted');
      return;
    }

    if (['completed', 'completed-with-errors'].includes(status.status)) {
      remainingProgressItemIds().forEach((itemId) => recordItemOutcome(itemId, 'failed'));
      state.progress.phase = status.status;
      if (status.status === 'completed') {
        state.progress.latestError = '';
      }
      syncTerminalSelection();
      setStatus(
        status.status === 'completed'
          ? 'All selected downloads completed.'
          : `Finished with ${state.progress.failed} failed downloads.`,
        status.status === 'completed' ? 'Ready' : 'Warning'
      );
      return;
    }

    if (state.progress.phase === 'preparing') {
      await cancelPageFetchesInTab(sessionId);
    }
    state.progress.phase = 'interrupted';
    setStatus('The previous download session is no longer active.', 'Warning');
  } catch (error) {
    state.progress.active = false;
    state.progress.phase = 'interrupted';
    state.isDownloading = false;
    setStatus('Could not restore the previous download session.', 'Warning');
  }
}

function getBackgroundDownloadSessionStatus(sessionId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'getDownloadSessionStatus', sessionId },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(response || { active: false, status: 'inactive' });
      }
    );
  });
}

function deselectCandidatesBelowMinimum() {
  state.candidates.forEach((candidate) => {
    deselectCandidateBelowMinimum(candidate);
  });
}

function deselectCandidateBelowMinimum(candidate) {
  if (
    candidate.selected
    && state.filters.minDimension > 0
    && candidate.width
    && candidate.height
    && Math.min(candidate.width, candidate.height) < state.filters.minDimension
  ) {
    candidate.selected = false;
  }
}

function applyIgnoreListToCandidates() {
  let ignoredCount = 0;
  state.candidates.forEach((candidate) => {
    candidate.ignoreFingerprints = buildCandidateFingerprints(candidate);
    candidate.ignored = isCandidateIgnored(candidate);
    if (candidate.ignored) {
      candidate.selected = false;
      ignoredCount += 1;
    }
  });
  return ignoredCount;
}

function isCandidateIgnored(candidate) {
  const ignoredFingerprints = new Set(state.ignoreList.map((entry) => entry.fingerprint));
  return buildCandidateFingerprints(candidate).some((fingerprint) => ignoredFingerprints.has(fingerprint));
}

function buildCandidateFingerprints(candidate) {
  const materials = [];
  const canonicalUrl = canonicalMediaUrl(candidate.url);
  if (canonicalUrl) {
    materials.push(`url:${canonicalUrl}`);
  }

  const filename = normalizeFingerprintPart(candidate.filename || filenameFromUrl(candidate.url));
  if (filename && candidate.extension && candidate.width && candidate.height) {
    materials.push(`file:${normalizeExtension(candidate.extension)}:${candidate.width}x${candidate.height}:${filename}`);
  }

  return Array.from(new Set(materials.map((material) => `fp_${hashString(material)}`)));
}

function buildIgnoreEntry(candidate, fingerprint) {
  return {
    fingerprint,
    label: candidate.filename || filenameFromUrl(candidate.url) || candidate.source || candidate.type || 'media',
    url: candidate.url,
    type: candidate.type,
    extension: candidate.extension,
    ignoredAt: new Date().toISOString()
  };
}

function canonicalMediaUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();

    if (parsed.hostname === 'i.pximg.net') {
      parsed.search = '';
      return parsed.href;
    }

    const disposableParams = new Set([
      'cache',
      'cb',
      'd',
      'download',
      'hash',
      'height',
      'nc',
      'rnd',
      'size',
      'thumb',
      'thumbnail',
      'type',
      'width'
    ]);
    const keptParams = new URLSearchParams();
    Array.from(parsed.searchParams.keys()).sort().forEach((key) => {
      if (!disposableParams.has(key.toLowerCase())) {
        parsed.searchParams.getAll(key).forEach((value) => {
          keptParams.append(key, value);
        });
      }
    });
    parsed.search = keptParams.toString();
    return parsed.href;
  } catch (error) {
    return String(url || '').trim();
  }
}

function normalizeFingerprintPart(value) {
  return String(value || '').trim().toLowerCase();
}

function filenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    return decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
  } catch (error) {
    return '';
  }
}

function activeCandidateCount() {
  return getActiveCandidates().length;
}

async function loadIgnoreList() {
  const result = await storageGet(IGNORE_LIST_KEY);
  const entries = Array.isArray(result[IGNORE_LIST_KEY]) ? result[IGNORE_LIST_KEY] : [];
  state.ignoreList = entries
    .map(normalizeIgnoreEntry)
    .filter(Boolean)
    .slice(-MAX_IGNORE_ENTRIES);
}

function normalizeIgnoreEntry(entry) {
  if (typeof entry === 'string') {
    return { fingerprint: entry, label: 'media', ignoredAt: '' };
  }

  if (!entry || !entry.fingerprint) {
    return null;
  }

  return {
    fingerprint: String(entry.fingerprint),
    label: String(entry.label || 'media'),
    url: String(entry.url || ''),
    type: String(entry.type || ''),
    extension: String(entry.extension || ''),
    ignoredAt: String(entry.ignoredAt || '')
  };
}

function persistIgnoreList() {
  return storageSet({
    [IGNORE_LIST_KEY]: state.ignoreList
  });
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
      downloadSettings: state.downloadSettings,
      progress: state.progress,
      statusMessage: state.statusMessage,
      statusLabel: state.statusLabel
    }
  });
}

function storageRemove(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(key, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
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

function normalizeDownloadSpeed(speedMode) {
  return ['conservative', 'normal', 'fast'].includes(speedMode) ? speedMode : DEFAULT_DOWNLOAD_SETTINGS.speedMode;
}

function normalizeStoredDownloadSettings(savedSettings) {
  const settings = PopupState.normalizeDownloadSettings(savedSettings);
  settings.subfolder = DownloadUtils.sanitizeSubfolder(settings.subfolder);
  if (!settings.subfolder) {
    settings.autoSubfolder = true;
  }
  return settings;
}

function isPximgUrl(url) {
  try {
    return new URL(url).host === 'i.pximg.net';
  } catch (error) {
    return false;
  }
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

function executeScriptWithArgs(tabId, func, args) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        function: func,
        args
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

function isSamePageUrl(leftUrl, rightUrl) {
  try {
    const left = new URL(leftUrl);
    const right = new URL(rightUrl);
    return left.origin === right.origin
      && left.pathname === right.pathname
      && left.search === right.search;
  } catch (error) {
    return String(leftUrl || '') === String(rightUrl || '');
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
  const baseUrl = document.baseURI || window.location.href;
  const candidatesByUrl = new Map();

  function normalizeUrl(value) {
    if (!value) {
      return null;
    }

    try {
      return new URL(value, baseUrl).href;
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
    const value = String(text || '');
    const namedMatch = value.match(/(?:Name|Filename|File)\s*:\s*([^\n\r]+)/i);
    if (namedMatch) {
      return namedMatch[1].trim();
    }

    const mediaMatch = value.match(/([^/\\\n\r<>:"|?*]+\.(?:jpe?g|png|gif|webp|svg|webm|mp4))\b/i);
    return mediaMatch ? mediaMatch[1].trim() : '';
  }

  function filenameHintsForElement(element, anchor = null) {
    const explicitValues = [
      anchor?.getAttribute?.('download'),
      element?.dataset?.filename,
      element?.dataset?.fileName,
      element?.dataset?.originalFilename
    ].map((value) => String(value || '').trim()).filter(Boolean);
    const descriptiveValues = [
      element?.getAttribute?.('title'),
      element?.getAttribute?.('alt'),
      anchor?.getAttribute?.('title'),
      anchor?.textContent
    ];

    return Array.from(new Set([
      ...explicitValues,
      ...descriptiveValues.map(filenameFromText).filter(Boolean)
    ]));
  }

  function decodeFilename(value) {
    try {
      return decodeURIComponent(String(value || ''));
    } catch (error) {
      return String(value || '');
    }
  }

  function attachmentIdFromUrl(url) {
    const match = String(url || '').match(/(?:[?;&]|^)attach=(\d+)/i);
    return match ? match[1] : '';
  }

  function thumbnailDataUrl(image) {
    if (!image || !image.naturalWidth || !image.naturalHeight) {
      return '';
    }

    try {
      const canvas = document.createElement('canvas');
      const maxSide = 240;
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.82);
    } catch (error) {
      return '';
    }
  }

  function snapshotRectFromElement(element) {
    if (!element || !element.getBoundingClientRect) {
      return null;
    }

    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    const width = right - left;
    const height = bottom - top;

    if (width <= 8 || height <= 8) {
      return null;
    }

    return {
      left,
      top,
      width,
      height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    };
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

  function isPixivMediaUrl(url) {
    try {
      return new URL(url).host === 'i.pximg.net';
    } catch (error) {
      return false;
    }
  }

  function pixivOriginalFromPreview(url) {
    const normalized = normalizeUrl(url);
    if (!normalized || !isPixivMediaUrl(normalized)) {
      return '';
    }

    try {
      const parsed = new URL(normalized);
      const match = parsed.pathname.match(/^\/(?:c\/[^/]+\/)?img-master\/img\/(.+?)\/([^/]+)_(?:master|square)\d+\.(jpg|jpeg|png|gif|webp)$/i);
      if (!match) {
        return '';
      }

      const extension = match[3].toLowerCase() === 'jpeg' ? 'jpg' : match[3].toLowerCase();
      return `${parsed.origin}/img-original/img/${match[1]}/${match[2]}.${extension}`;
    } catch (error) {
      return '';
    }
  }

  function pixivFallbackUrls(originalUrl, previewUrl, includeAlternateOriginals) {
    const urls = [];
    if (includeAlternateOriginals) {
      try {
        const parsed = new URL(originalUrl);
        const extensionMatch = parsed.pathname.match(/\.([a-z0-9]+)$/i);
        if (extensionMatch) {
          ['jpg', 'png', 'gif', 'webp'].forEach((extension) => {
            const alternate = new URL(parsed.href);
            alternate.pathname = alternate.pathname.replace(/\.[a-z0-9]+$/i, `.${extension}`);
            const candidate = alternate.href;
            if (candidate !== originalUrl) {
              urls.push(candidate);
            }
          });
        }
      } catch (error) {
        // Keep the known preview as the final fallback.
      }
    }

    if (previewUrl && previewUrl !== originalUrl) {
      urls.push(previewUrl);
    }
    return Array.from(new Set(urls));
  }

  function isAttachmentUrl(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) {
      return false;
    }

    return /(?:[?;&]|^)action=dlattach\b/i.test(normalized)
      || /(?:[?;&]|^)attach=\d+/i.test(normalized)
      || /\/filedata\/fetch\b/i.test(new URL(normalized).pathname);
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

  function dimensionAttribute(element, name) {
    const value = Number(element?.getAttribute?.(name));
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
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
      filenameHints: Array.isArray(input.filenameHints) ? input.filenameHints.filter(Boolean) : [],
      fallbackUrls: Array.isArray(input.fallbackUrls) ? input.fallbackUrls.filter(Boolean) : [],
      downloadMode: input.downloadMode || 'chrome',
      headers: Array.isArray(input.headers) ? input.headers : [],
      pageHost: pageUrl.host,
      sameOrigin: sameOrigin(url),
      width: input.width || null,
      height: input.height || null,
      snapshotRect: input.snapshotRect || null
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
    if (!existing.snapshotRect && candidate.snapshotRect) {
      existing.snapshotRect = candidate.snapshotRect;
    }
    if ((!existing.headers || !existing.headers.length) && candidate.headers?.length) {
      existing.headers = candidate.headers;
    }
    if (!existing.filename && candidate.filename) {
      existing.filename = candidate.filename;
    }
    existing.filenameHints = Array.from(new Set([
      ...(existing.filenameHints || []),
      ...(candidate.filenameHints || [])
    ]));
    existing.fallbackUrls = Array.from(new Set([
      ...(existing.fallbackUrls || []),
      ...(candidate.fallbackUrls || [])
    ]));
    if (
      candidate.source === 'linked original'
      || candidate.source === '4chan original'
      || candidate.source === 'pixiv original'
      || candidate.source === 'attachment original'
    ) {
      if (sourcePriority(candidate.source) < sourcePriority(existing.source)) {
        return;
      }

      const candidateHasPreview = candidate.previewUrl && candidate.previewUrl !== candidate.url;
      const existingHasPreview = existing.previewUrl && existing.previewUrl !== existing.url;
      existing.source = candidate.source;
      if (candidateHasPreview || !existingHasPreview) {
        existing.previewUrl = candidate.previewUrl;
      }
    }
  }

  function sourcePriority(source) {
    if (source === 'attachment original' || source === '4chan original' || source === 'pixiv original') {
      return 4;
    }
    if (source === 'linked original') {
      return 3;
    }
    if (source === 'direct link') {
      return 2;
    }
    return 1;
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
      parentLink.href
      || image.dataset?.fullsizeUrl
      || parentLink.dataset?.fullsizeUrl
    );
    const isAttachmentPreview = Boolean(
      image.dataset?.fullsizeUrl
      || image.dataset?.size === 'thumb'
      || parentLink.classList?.contains('bbcode-attachment')
      || isAttachmentUrl(linkedUrl)
      || isPixivMediaUrl(linkedUrl)
    );

    return Boolean(
      imageUrl
      && linkedUrl
      && imageUrl !== linkedUrl
      && (isMediaUrl(linkedUrl) || isAttachmentPreview)
    );
  }

  Array.from(document.querySelectorAll('a[href] img, img[src*="i.pximg.net/img-master/"]')).forEach((image) => {
    const parentLink = image.closest ? image.closest('a[href]') : null;
    const linkedUrl = normalizeUrl(parentLink?.href);
    const previewUrl = normalizeUrl(image.currentSrc || image.src);
    const hasLinkedPixivOriginal = isPixivMediaUrl(linkedUrl);
    const originalUrl = hasLinkedPixivOriginal
      ? linkedUrl
      : pixivOriginalFromPreview(previewUrl);

    if (!originalUrl || !isPixivMediaUrl(originalUrl)) {
      return;
    }

    const extension = extensionFromUrl(originalUrl) || extensionFromUrl(previewUrl) || 'jpg';
    const width = dimensionAttribute(image, 'width') || image.naturalWidth || image.width || null;
    const height = dimensionAttribute(image, 'height') || image.naturalHeight || image.height || null;

    addCandidate({
      url: originalUrl,
      previewUrl: previewUrl || originalUrl,
      type: 'image',
      extension,
      filename: decodeFilename(originalUrl.split('/').pop() || ''),
      filenameHints: filenameHintsForElement(image, parentLink),
      fallbackUrls: pixivFallbackUrls(originalUrl, previewUrl, !hasLinkedPixivOriginal),
      downloadMode: 'chrome',
      source: 'pixiv original',
      width,
      height,
      snapshotRect: snapshotRectFromElement(image)
    });
  });

  Array.from(document.querySelectorAll('a[href] img[data-fullsize-url], a[href].bbcode-attachment img, img[data-fullsize-url]')).forEach((image) => {
    const parentLink = image.closest ? image.closest('a[href]') : null;
    const fullsizeUrl = parentLink?.href || image.dataset?.fullsizeUrl;
    const previewUrl = thumbnailDataUrl(image) || image.currentSrc || image.src || image.dataset?.thumbUrl;
    const extension = extensionFromUrl(fullsizeUrl) || extensionFromText(image.alt);
    const dimensions = parseDimensions(image.alt);
    const filename = filenameFromText(image.alt);

    addCandidate({
      url: fullsizeUrl,
      previewUrl,
      type: 'image',
      extension,
      filename,
      filenameHints: filenameHintsForElement(image, parentLink),
      downloadMode: 'page',
      source: 'attachment original',
      width: dimensions.width,
      height: dimensions.height,
      allowUnknownExtension: true
    });
  });

  Array.from(document.querySelectorAll('.attachments, [class*="attachments"]')).forEach((container) => {
    Array.from(container.querySelectorAll('a[href]')).forEach((anchor) => {
      const href = normalizeUrl(anchor.href);
      if (!href || !isAttachmentUrl(href) || /(?:[?;&]|;)thumb\b/i.test(href)) {
        return;
      }

      const attachmentId = attachmentIdFromUrl(href);
      const image = anchor.querySelector('img')
        || (attachmentId ? container.querySelector(`img[src*="attach=${attachmentId}"]`) : null)
        || container.querySelector('img.atc_img, img');
      const isImageAttachment = Boolean(image) || /(?:[?;&]|;)image\b/i.test(href);
      if (!isImageAttachment) {
        return;
      }

      const attachmentText = container.textContent || '';
      const dimensions = parseDimensions(attachmentText);
      const extension = extensionFromUrl(href)
        || extensionFromText(attachmentText)
        || extensionFromText(image?.alt);
      const filename = filenameFromText(attachmentText)
        || (attachmentId ? `attachment_${attachmentId}` : '');

      addCandidate({
        url: href,
        previewUrl: image ? thumbnailDataUrl(image) || image.currentSrc || image.src : href,
        type: 'image',
        extension,
        filename,
        filenameHints: filenameHintsForElement(image, anchor),
        downloadMode: 'page',
        source: 'attachment original',
        width: dimensions.width,
        height: dimensions.height,
        allowUnknownExtension: true
      });
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
      filenameHints: filenameHintsForElement(thumbnail, fileLink),
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
      filenameHints: filenameHintsForElement(image, image.closest?.('a[href]')),
      width,
      height
    });

    parseSrcset(image.srcset).forEach((srcsetUrl) => {
      addCandidate({
        url: srcsetUrl,
        type: 'image',
        source: 'srcset',
        filenameHints: filenameHintsForElement(image, image.closest?.('a[href]')),
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
      filenameHints: filenameHintsForElement(video, video.closest?.('a[href]')),
      width: video.videoWidth || null,
      height: video.videoHeight || null
    });

    Array.from(video.querySelectorAll('source')).forEach((source) => {
      addCandidate({
        url: source.src,
        type: 'video',
        source: 'video source',
        filenameHints: filenameHintsForElement(source, video.closest?.('a[href]')),
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
      filenameHints: filenameHintsForElement(linkedImage, anchor),
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

async function fetchMediaFromPage(items, options = {}) {
  const fetchedItems = [];
  const failed = [];
  const pendingItems = [...items];
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 1, pendingItems.length || 1));
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 30000);
  const sessionId = String(options.sessionId || 'page-fetch');
  const registryKey = '__guidedMediaFetchControllers';
  const registry = globalThis[registryKey] instanceof Map
    ? globalThis[registryKey]
    : new Map();
  globalThis[registryKey] = registry;
  const sessionControllers = registry.get(sessionId) || new Set();
  registry.set(sessionId, sessionControllers);

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read attachment data.'));
      reader.readAsDataURL(blob);
    });
  }

  function extensionFromMimeType(mimeType) {
    const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase();
    if (normalized === 'image/jpeg') {
      return 'jpg';
    }
    if (normalized === 'image/png') {
      return 'png';
    }
    if (normalized === 'image/gif') {
      return 'gif';
    }
    if (normalized === 'image/webp') {
      return 'webp';
    }
    if (normalized === 'image/svg+xml') {
      return 'svg';
    }
    if (normalized === 'video/webm') {
      return 'webm';
    }
    if (normalized === 'video/mp4') {
      return 'mp4';
    }
    return '';
  }

  function filenameFromContentDisposition(header) {
    const value = String(header || '');
    const encodedMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
    if (encodedMatch) {
      try {
        return decodeURIComponent(encodedMatch[1].trim().replace(/^["']|["']$/g, ''));
      } catch (error) {
        return encodedMatch[1].trim().replace(/^["']|["']$/g, '');
      }
    }

    const match = value.match(/filename=([^;]+)/i);
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
  }

  async function fetchItem(item) {
    const controller = new AbortController();
    sessionControllers.add(controller);
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(item.url, {
        credentials: 'include',
        cache: 'no-store',
        referrer: window.location.href,
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const dataUrl = await blobToDataUrl(blob);
      const responseFilename = filenameFromContentDisposition(response.headers.get('Content-Disposition'));
      const filename = responseFilename || item.filename;
      fetchedItems.push({
        id: item.id,
        url: dataUrl,
        filename,
        responseFilename,
        finalUrl: response.url || item.url,
        extension: extensionFromMimeType(blob.type) || item.extension,
        type: item.type
      });
    } catch (error) {
      failed.push({
        id: item.id,
        url: item.url,
        error: error.name === 'AbortError'
          ? 'Attachment fetch timed out.'
          : error.message || 'Could not fetch attachment.'
      });
    } finally {
      clearTimeout(timeoutId);
      sessionControllers.delete(controller);
    }
  }

  async function worker() {
    while (pendingItems.length) {
      const item = pendingItems.shift();
      await fetchItem(item);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  if (!sessionControllers.size) {
    registry.delete(sessionId);
  }

  return { items: fetchedItems, failed };
}

function cancelPageFetchSession(sessionId) {
  const registry = globalThis.__guidedMediaFetchControllers;
  const controllers = registry instanceof Map ? registry.get(String(sessionId || '')) : null;
  if (!controllers) {
    return { cancelled: 0 };
  }

  const count = controllers.size;
  controllers.forEach((controller) => controller.abort());
  registry.delete(String(sessionId || ''));
  return { cancelled: count };
}
