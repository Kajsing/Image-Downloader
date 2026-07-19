const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const popupHtml = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
const popupStateJs = fs.readFileSync(path.join(__dirname, '..', 'popup-state.js'), 'utf8');

test('every popup element reference exists in the HTML', () => {
  const referencedIds = Array.from(
    popupJs.matchAll(/document\.getElementById\('([^']+)'\)/g),
    (match) => match[1]
  );
  const htmlIds = new Set(
    Array.from(popupHtml.matchAll(/\bid="([^"]+)"/g), (match) => match[1])
  );
  const missing = referencedIds.filter((id) => !htmlIds.has(id));

  assert.deepEqual(missing, []);
});

test('shared download utilities load before popup behavior', () => {
  assert.ok(
    popupHtml.indexOf('download-utils.js') < popupHtml.indexOf('popup.js'),
    'download-utils.js must load before popup.js'
  );
  assert.ok(
    popupHtml.indexOf('popup-state.js') < popupHtml.indexOf('popup.js'),
    'popup-state.js must load before popup.js'
  );
});

test('large-batch confirmation and abort controls are present', () => {
  assert.match(popupHtml, /id="confirmationPanel"/);
  assert.match(popupHtml, /id="confirmDownloadBtn"/);
  assert.match(popupHtml, /id="cancelledCount"/);
  assert.match(popupStateJs, /LARGE_BATCH_CONFIRMATION_THRESHOLD = 50/);
  assert.match(popupJs, /cancelDownloadSession/);
});

test('the popup stays below Chromes 600px extension-popup height limit', () => {
  const popupCss = fs.readFileSync(path.join(__dirname, '..', 'popup.css'), 'utf8');
  assert.match(popupCss, /height:\s*min\(590px,\s*100vh\)/);
  assert.match(popupCss, /grid-template-rows:\s*auto\s+auto\s+minmax\(0,\s*1fr\)\s+auto/);
});

test('the scanner returns preview keys instead of inline thumbnail bytes', () => {
  assert.match(popupJs, /__guidedMediaPreviewData/);
  assert.match(popupJs, /pagePreviewKey:\s*registerThumbnailPreview\(image\)/);
  assert.match(popupJs, /function readPagePreviewData\(/);
  assert.doesNotMatch(popupJs, /previewUrl:\s*thumbnailDataUrl\(/);
  assert.doesNotMatch(popupJs, /previewUrl:\s*image\s*\?\s*thumbnailDataUrl\(/);
});
