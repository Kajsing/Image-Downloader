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
- Detects BBCode/forum attachment originals from `data-fullsize-url`, thumbnail
  links, and SMF-style `dlattach` image attachment blocks.
- Preserves attachment filenames when forum metadata exposes them.
- Uses same-page thumbnail snapshots and timeout-protected page-session fetch
  batches for attachment endpoints that need the page session, then saves
  through Chrome downloads.
- Supports `jpg`, `png`, `gif`, `webp`, `svg`, `webm`, and `mp4`.
- Filters by media type, extension, same-origin, and minimum dimension.
- Defaults the minimum-size filter to 65px to avoid most icons while keeping
  normal thumbnails visible.
- Selection helpers for visible results and likely wallpapers.
- Per-tab state stored in `chrome.storage.local`, restored only when the current
  page URL still matches the saved scan.
- Selected downloads are saved under `ImageDownloader/{host}_{date}/`.
- Download progress reports queued, completed, and failed items while the popup
  is open.
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
5. Pick a download speed if needed: Careful, Balanced, or Fast.
6. Select the media you want.
7. Click Download selected.

## Permissions

- `activeTab`: access the current tab after user interaction.
- `scripting`: run the scanner in the active page.
- `downloads`: save selected media through Chrome downloads.
- `storage`: restore scan results and selection state per tab.

The extension has no backend, no accounts, no telemetry, and no cloud storage.

## Validation

Current local validation uses Codex's bundled Node runtime when `node` is not on
PATH:

```powershell
& 'C:\Users\ckajs\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check popup.js
& 'C:\Users\ckajs\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check background.js
& 'C:\Users\ckajs\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest.json OK')"
```

The scanner also has a lightweight Node smoke test using a fake DOM. A full
browser smoke test should be done by loading the extension unpacked in Chrome.
