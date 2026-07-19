(function attachPopupState(root) {
  const LARGE_BATCH_CONFIRMATION_THRESHOLD = 50;

  function normalizeDownloadSettings(saved = {}) {
    const source = saved && typeof saved === 'object' ? saved : {};
    const subfolder = typeof source.subfolder === 'string' ? source.subfolder : '';
    return {
      speedMode: ['conservative', 'normal', 'fast'].includes(source.speedMode)
        ? source.speedMode
        : 'normal',
      subfolder,
      autoSubfolder: typeof source.autoSubfolder === 'boolean'
        ? source.autoSubfolder
        : !subfolder
    };
  }

  function normalizeProgress(saved = {}) {
    const source = saved && typeof saved === 'object' ? saved : {};
    return {
      sessionId: null,
      queued: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
      itemIds: [],
      completedItemIds: [],
      failedItemIds: [],
      cancelledItemIds: [],
      latestError: '',
      phase: 'idle',
      active: false,
      ...source,
      itemIds: arrayOfStrings(source.itemIds),
      completedItemIds: arrayOfStrings(source.completedItemIds),
      failedItemIds: arrayOfStrings(source.failedItemIds),
      cancelledItemIds: arrayOfStrings(source.cancelledItemIds)
    };
  }

  function recordOutcome(progress, itemId, outcome) {
    if (!itemId || !['completed', 'failed', 'cancelled'].includes(outcome)) {
      return progress;
    }

    const completed = new Set(progress.completedItemIds || []);
    const failed = new Set(progress.failedItemIds || []);
    const cancelled = new Set(progress.cancelledItemIds || []);
    completed.delete(itemId);
    failed.delete(itemId);
    cancelled.delete(itemId);
    ({ completed, failed, cancelled })[outcome].add(itemId);
    progress.completedItemIds = Array.from(completed);
    progress.failedItemIds = Array.from(failed);
    progress.cancelledItemIds = Array.from(cancelled);
    progress.done = completed.size;
    progress.failed = failed.size;
    progress.cancelled = cancelled.size;
    return progress;
  }

  function remainingItemIds(progress) {
    const terminalIds = new Set([
      ...(progress.completedItemIds || []),
      ...(progress.failedItemIds || []),
      ...(progress.cancelledItemIds || [])
    ]);
    return (progress.itemIds || []).filter((itemId) => !terminalIds.has(itemId));
  }

  function needsLargeBatchConfirmation(count) {
    return Number(count) >= LARGE_BATCH_CONFIRMATION_THRESHOLD;
  }

  function arrayOfStrings(value) {
    return Array.isArray(value) ? value.map(String) : [];
  }

  const api = {
    LARGE_BATCH_CONFIRMATION_THRESHOLD,
    needsLargeBatchConfirmation,
    normalizeDownloadSettings,
    normalizeProgress,
    recordOutcome,
    remainingItemIds
  };

  root.PopupState = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
