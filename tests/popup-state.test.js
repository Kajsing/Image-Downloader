const assert = require('node:assert/strict');
const test = require('node:test');

const PopupState = require('../popup-state.js');

test('old v2.0 progress state migrates without losing aggregate counts', () => {
  const progress = PopupState.normalizeProgress({
    sessionId: 'old-session',
    queued: 12,
    done: 5,
    failed: 1,
    active: false
  });

  assert.equal(progress.sessionId, 'old-session');
  assert.equal(progress.done, 5);
  assert.equal(progress.failed, 1);
  assert.deepEqual(progress.itemIds, []);
  assert.deepEqual(progress.completedItemIds, []);
  assert.equal(progress.phase, 'idle');
});

test('terminal outcomes are idempotent and mutually exclusive', () => {
  const progress = PopupState.normalizeProgress({ itemIds: ['a', 'b'] });

  PopupState.recordOutcome(progress, 'a', 'completed');
  PopupState.recordOutcome(progress, 'a', 'completed');
  assert.equal(progress.done, 1);

  PopupState.recordOutcome(progress, 'a', 'cancelled');
  assert.equal(progress.done, 0);
  assert.equal(progress.cancelled, 1);
  assert.deepEqual(PopupState.remainingItemIds(progress), ['b']);
});

test('large batches require confirmation at the 50 item boundary', () => {
  assert.equal(PopupState.needsLargeBatchConfirmation(49), false);
  assert.equal(PopupState.needsLargeBatchConfirmation(50), true);
  assert.equal(PopupState.needsLargeBatchConfirmation(300), true);
});
