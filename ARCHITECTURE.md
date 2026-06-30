# Architecture

## Current Shape

The extension is a Manifest V3 Chrome Extension with:

- `manifest.json` for permissions, popup registration, icons, and service worker.
- `popup.html`, `popup.css`, and `popup.js` for the user interface and page scan.
- `background.js` as the service worker that performs downloads through
  `chrome.downloads.download`.
- `chrome.storage.local` for per-tab scan/download state.

The current implementation has separate image and WebM flows. The MVP should
merge these into a single media-collection flow while preserving the simple
extension footprint.

## Proposed MVP Architecture

### Popup UI

The popup is the command surface:

- Starts page scans.
- Renders filters.
- Renders a compact preview/select list.
- Starts selected downloads.
- Displays scan and download status.

The popup should remain usable at extension-popup size. Prefer dense controls
over marketing-style layout.

### Page Scanner

The scanner runs in the active tab via `chrome.scripting.executeScript`.

Responsibilities:

- Collect image and video candidates from DOM elements.
- Normalize URLs to absolute URLs.
- Infer media type and extension.
- Mark candidates with source hints, such as `img`, `srcset`, `anchor`,
  `video`, or `source`.
- Prefer original media links when a thumbnail is wrapped in a direct media
  anchor.

The scanner should not download or crawl unrelated pages in the MVP.

### Media Model

Each candidate should use a stable shape:

```js
{
  id: string,
  url: string,
  type: "image" | "video",
  extension: string,
  source: string,
  pageHost: string,
  width: number | null,
  height: number | null,
  selected: boolean
}
```

`id` can be derived from normalized URL for the MVP.

### State

Use `chrome.storage.local` with a key scoped to the tab id.

State should include:

- Current candidates.
- Current filters.
- Current selection.
- Download progress.

### Background Service Worker

The background worker owns downloads.

Responsibilities:

- Receive selected candidates.
- Generate safe filenames and folder paths.
- Start downloads with `conflictAction: "uniquify"`.
- Return queued/download-start failures to the popup.

Long-term progress tracking can use `chrome.downloads.onChanged`, but MVP can
start with queued/completed-by-callback status if kept clear in the UI.

## Security Notes

- Avoid broad host permissions unless a milestone requires them.
- Do not execute remote code.
- Do not add telemetry.
- Download only media URLs surfaced from the active page and selected by the
  user.
- Keep filenames sanitized before passing them to `chrome.downloads.download`.

## Known Current Issues

- `COUNTDOWN_SECONDS` is referenced in `popup.js` but not defined.
- `icons/icon48.png` is 64x64 despite being used as the 48px icon.
- Current UI downloads batches without previewing individual files.
