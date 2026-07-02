# Architecture

## Current Shape

The extension is a Manifest V3 Chrome Extension with:

- `manifest.json` for permissions, popup registration, icons, version metadata,
  and service worker registration.
- `popup.html`, `popup.css`, and `popup.js` for the guided scan, filter,
  preview/select, and selected-download UI.
- `background.js` as the service worker that performs downloads through
  `chrome.downloads.download` and reports progress back to the popup.
- `chrome.storage.local` for per-tab candidate, filter, selection, and progress
  state. Saved scan state is restored only when the active tab still has the
  same page URL.

## Popup UI

The popup is the command surface:

- Starts active-tab page scans.
- Renders scan summary counts for all media, images, and videos.
- Renders filters for media type, extension, same-origin, and minimum size.
- Defaults the minimum-size filter to 65px, which removes most icons without
  hiding ordinary thumbnails. Users can switch back to any size when needed.
- Renders a compact selectable preview grid.
- Provides selection helpers for visible results and likely wallpapers.
- Starts selected downloads.
- Displays queued, completed, failed, and latest-error download status.

The popup is intentionally dense and practical. It should feel like a repeated
use tool, not a marketing page.

## Page Scanner

The scanner runs in the active tab via `chrome.scripting.executeScript`.

Responsibilities:

- Collect image and video candidates from DOM elements.
- Normalize URLs to absolute URLs.
- Infer media type and extension.
- Mark candidates with source hints, such as `image element`, `srcset`,
  `linked original`, `direct link`, `video element`, or `video source`.
- Prefer original media links when a thumbnail is wrapped in a direct media
  anchor.
- Treat Pixiv/pximg `img-master`, cached `square1200` thumbnails, and
  `img-original` links as original image records and download them through
  Chrome downloads while a narrow `declarativeNetRequest` rule supplies the
  Pixiv referer expected by `i.pximg.net`.
- Use visible-tab screenshot crops as popup previews for pximg images when the
  remote host refuses extension-popup image loads.
- Keep original-media dimensions separate from thumbnail and snapshot preview
  dimensions so popup previews do not overwrite source metadata.
- Treat 4chan `.file` blocks as original media records, using `.fileThumb` only
  as a preview and parsing dimensions from `.fileText`.
- Treat BBCode/forum attachment thumbnails with `data-fullsize-url` or
  attachment links as original media records, even when the original URL is a
  fetch endpoint without a file extension.
- Treat SMF-style `dlattach` image attachment blocks as original media records,
  using the thumb image as preview and nearby metadata for dimensions.
- Preserve attachment filenames from metadata or `Content-Disposition` headers
  when available so fetch endpoints still download with useful names.
- Use same-page thumbnail snapshots and timeout-protected page-session fetch
  batches for attachment endpoints that rely on page session or referer
  behavior, then append each prepared batch to Chrome downloads with
  `saveAs: false`.
- Dedupe candidates by normalized URL.

The scanner does not crawl unrelated pages in the MVP.

## Media Model

Each candidate uses this shape in popup state:

```js
{
  id: string,
  url: string,
  previewUrl: string,
  type: "image" | "video",
  extension: string,
  source: string,
  filename: string,
  downloadMode: "chrome" | "page",
  pageHost: string,
  sameOrigin: boolean,
  width: number | null,
  height: number | null,
  selected: boolean,
  warning: string
}
```

## State

State is stored with a key scoped to the tab id.

State includes:

- Current page metadata.
- Current candidates.
- Current filters.
- Current selection.
- Download progress.
- Last status message.

## Background Service Worker

The background worker owns downloads.

Responsibilities:

- Receive selected media candidates from the popup.
- Generate safe filenames and dated host folders.
- Start downloads with `conflictAction: "uniquify"`.
- Track active Chrome download ids while the service worker is alive.
- Report completed and failed downloads back to the popup.

Downloads are saved under:

```text
ImageDownloader/{host}_{yyyy-mm-dd}/
```

## Security Notes

- Avoid broad host permissions unless a future milestone requires them.
- Do not execute remote code.
- Do not add telemetry.
- Download only media URLs surfaced from the active page and selected by the
  user.
- Keep filenames sanitized before passing them to `chrome.downloads.download`.

## Known Current Issues

- A full manual Chrome smoke test should still be run after loading the
  extension unpacked.
- Download completion progress is best-effort while the popup and service worker
  are alive. Chrome's downloads UI remains the source of truth after that.

## Stabilization Notes

- Milestone 1 defined the old popup countdown behavior and fixed the 48px icon
  asset mismatch.
- The MVP replaces the old separate image/WebM batch flows with one guided media
  collector flow.
