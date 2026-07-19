const assert = require('node:assert/strict');
const test = require('node:test');

const DownloadUtils = require('../download-utils.js');

test('empty filename stays empty until fallback resolution', () => {
  assert.equal(DownloadUtils.sanitizePathSegment(''), '');

  const filename = DownloadUtils.resolveFilename({
    url: 'https://forum.test/filedata/fetch?id=42',
    type: 'image',
    extension: 'jpg'
  }, 0, {
    title: 'Pocket Computers',
    url: 'https://forum.test/topic/42'
  });

  assert.match(filename, /^topic-42_image_001_[a-z0-9]{6}\.jpg$/);
});

test('response filename wins and MIME-derived extension is preserved', () => {
  const filename = DownloadUtils.resolveFilename({
    responseFilename: 'original wallpaper.png',
    filename: 'attachment_42',
    url: 'data:image/jpeg;base64,abc',
    type: 'image',
    extension: 'jpg'
  }, 0, {});

  assert.equal(filename, 'original wallpaper.jpg');
});

test('explicit DOM metadata beats a generic attachment fallback', () => {
  const filename = DownloadUtils.resolveFilename({
    filename: 'attachment_42',
    filenameHints: ['camera-original'],
    url: 'https://forum.test/index.php?action=dlattach;attach=42',
    type: 'image',
    extension: 'png'
  }, 0, {});

  assert.equal(filename, 'camera-original.png');
});

test('route-like URL names fall through to a stable descriptive filename', () => {
  const item = {
    url: 'https://forum.test/index.php?action=dlattach;attach=29332;image',
    type: 'image',
    extension: 'png'
  };
  const page = {
    title: 'Rory Mercury gallery',
    url: 'https://forum.test/topic/77'
  };

  const first = DownloadUtils.resolveFilename(item, 3, page);
  const second = DownloadUtils.resolveFilename(item, 3, page);
  assert.equal(first, second);
  assert.match(first, /^topic-77_image_004_[a-z0-9]{6}\.png$/);
});

test('thread destinations are stable and traversal stays below the root', () => {
  const page = {
    url: 'https://boards.4chan.org/wg/thread/8098766/pocket-computers',
    host: 'boards.4chan.org',
    title: 'Pocket computers'
  };

  assert.equal(
    DownloadUtils.buildSuggestedSubfolder(page),
    'boards.4chan.org/wg-thread-8098766-pocket-computers'
  );
  assert.equal(
    DownloadUtils.buildDownloadFolder(page, '../../custom\\batch'),
    'ImageDownloader/custom/batch'
  );
});

test('Windows reserved path names are made safe', () => {
  assert.equal(DownloadUtils.sanitizePathSegment('CON'), '_CON');
  assert.equal(DownloadUtils.sanitizePathSegment('nul.jpg'), '_nul.jpg');
  assert.equal(DownloadUtils.sanitizeSubfolder('AUX/COM1'), '_AUX/_COM1');
});

test('duplicate filenames are resolved before Chrome conflict handling', () => {
  const items = [
    { id: 'a', filename: 'wallpaper.jpg', extension: 'jpg', type: 'image', url: 'https://a.test/1' },
    { id: 'b', filename: 'wallpaper.jpg', extension: 'jpg', type: 'image', url: 'https://a.test/2' },
    { id: 'c', filename: 'wallpaper.jpg', extension: 'jpg', type: 'image', url: 'https://a.test/3' }
  ];

  assert.deepEqual(
    DownloadUtils.prepareDownloadItems(items).map((item) => item.filename),
    ['wallpaper.jpg', 'wallpaper_02.jpg', 'wallpaper_03.jpg']
  );
});
