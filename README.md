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
- Supports `jpg`, `png`, `gif`, `webp`, `svg`, `webm`, and `mp4`.
- Filters by media type, extension, same-origin, and minimum dimension.
- Selection helpers for visible results and likely wallpapers.
- Per-tab state stored in `chrome.storage.local`.
- Selected downloads are saved under `ImageDownloader/{host}_{date}/`.
- Download progress reports queued, completed, and failed items while the popup
  is open.

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
5. Select the media you want.
6. Click Download selected.

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
