# Image Downloader

Image Downloader is a Manifest V3 Chrome Extension for collecting images and
video files from the active browser tab.

The extension was originally built for downloading wallpaper images and WebM
files from media-heavy pages. The current MVP keeps that use case, but makes the
workflow guided: scan the page, filter candidates, preview/select files, then
download only the selected media.

## Features

- Unified page scan for images and videos.
- Finds media from `img`, `srcset`, direct media links, `video`, and `source`
  elements.
- Prioritizes 4chan-style original file links over their thumbnail previews.
- Detects Pixiv/pximg original images from `img-master`, cached `square1200`
  thumbnails, and `img-original` links.
- Fetches pximg originals in the extension background with a narrow request rule
  that supplies the current Pixiv artwork page as the referer expected by
  `i.pximg.net`, then saves the fetched image bytes through Chrome downloads.
- Uses visible-tab snapshot crops for pximg previews that cannot be loaded
  directly inside the extension popup, with an on-demand background fetch
  fallback for offscreen pximg thumbnails.
- Keeps thumbnail and snapshot preview sizes from overwriting original media
  dimensions.
- Detects BBCode/forum attachment originals from `data-fullsize-url`, thumbnail
  links, and SMF-style `dlattach` image attachment blocks.
- Preserves attachment filenames when forum metadata or download headers expose
  them.
- Uses same-page thumbnail snapshots and timeout-protected page-session fetch
  batches for attachment endpoints that need the page session, then saves
  through Chrome downloads.
- Supports `jpg`, `png`, `gif`, `webp`, `svg`, `webm`, and `mp4`.
- Filters by media type, extension, same-origin, and minimum dimension.
- Defaults the minimum-size filter to 65px to avoid most icons while keeping
  normal thumbnails visible.
- Supports a local ignore list for repeatedly unwanted media, keyed by stable
  media fingerprints so ignored items stay hidden on future scans.
- Selection helpers for visible results and likely wallpapers.
- Per-tab state stored in `chrome.storage.local`, restored only when the current
  page URL still matches the saved scan.
- Suggests a stable page/thread-specific subfolder for each batch and lets the
  user edit it before download. All paths remain below `ImageDownloader/`.
- Resolves filenames from response headers, attachment and DOM metadata, final
  or original URLs, then a stable page-based fallback. Duplicate names are
  resolved before Chrome's final conflict handling.
- Shows proposed filenames and the destination before download.
- Requires an inline confirmation before batches of 50 or more files start.
- Provides a prominent Abort action that clears pending work, stops retries,
  aborts forum and Pixiv fetches, and cancels active Chrome downloads when
  possible. Completed files remain on disk.
- Download progress reports queued, completed, failed, and cancelled items.
- Keeps lightweight active-session metadata in `chrome.storage.session`, so a
  reopened popup can rediscover or safely reconcile background downloads.
- Adaptive download speed modes. Fast mode starts with more parallel downloads,
  then retries slower when downloads time out or are interrupted.

## Install Locally

1. Open Chrome or a Chromium-based browser.
2. Go to `chrome://extensions`.
3. Enable Developer mode.
4. Choose Load unpacked.
5. Select this repository folder.

## Usage

1. Open a page with images or videos.
2. Open the Image Downloader extension.
3. Click Scan page.
4. Use filters or Select likely to refine the result set.
5. Select the media you want and check the proposed filenames.
6. Review or edit the destination subfolder and choose a speed.
7. Click Download. Batches of 50 or more require one inline confirmation.
8. Use Abort batch to stop pending and active work when needed.

## Permissions

- `activeTab`: access the current tab after user interaction.
- `declarativeNetRequestWithHostAccess`: set the Pixiv referer only for
  `i.pximg.net` original image downloads.
- `scripting`: run the scanner in the active page.
- `downloads`: save selected media through Chrome downloads.
- `host_permissions` for `https://i.pximg.net/*`: allow the narrow Pixiv
  referer rule to apply to pximg originals.
- `storage`: restore scan results and selection state per tab.

The extension has no backend, no accounts, no telemetry, and no cloud storage.

## Validation

Current local validation uses Codex's bundled Node runtime when `node` is not on
PATH:

```powershell
& 'C:\Users\ckajs\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check popup.js
& 'C:\Users\ckajs\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check background.js
& 'C:\Users\ckajs\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check download-utils.js
& 'C:\Users\ckajs\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check popup-state.js
& 'C:\Users\ckajs\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest.json OK')"
& 'C:\Users\ckajs\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test tests/*.test.js
```

The Node suite covers cancellation races, worker restart reconciliation,
filename and folder resolution, duplicate handling, and the popup's DOM
contract. A full browser smoke test should still be done by loading the
extension unpacked in Chrome and checking direct media, forum attachments,
Pixiv, a 200+ item Abort, and narrow popup layout.

Use [`docs/v2.1-validation.md`](docs/v2.1-validation.md) for the complete
release matrix and pass criteria.
