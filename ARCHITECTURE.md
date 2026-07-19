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
- `chrome.storage.session` for lightweight active download ids, terminal item
  ledgers, and cancellation tombstones that must survive service-worker restarts.
- `download-utils.js` for shared destination and filename rules used by both the
  popup and background worker.
- `popup-state.js` for progress-state migration, terminal outcome ledgers, and
  the large-batch confirmation threshold.

## Popup UI

The popup is the command surface:

- Starts active-tab page scans.
- Renders scan summary counts for all media, images, and videos.
- Renders filters for media type, extension, same-origin, and minimum size.
- Defaults the minimum-size filter to 65px, which removes most icons without
  hiding ordinary thumbnails. Users can switch back to any size when needed.
- Renders a compact selectable one-column media list with proposed filenames.
- Provides selection helpers for visible results and likely wallpapers.
- Shows and edits the current batch's page/thread-specific destination.
- Confirms batches of 50 or more files before starting them.
- Starts or aborts the current selected-download session.
- Displays queued, completed, failed, cancelled, and latest-error status.
- On a terminal batch, removes completed items from selection and retains only
  failed/cancelled items for a precise retry.

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
- For inferred Pixiv originals, retain alternate original extensions and the
  known master preview. The worker follows that fallback chain only after a 404
  and derives the saved extension from the successful response.
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
- Keep encoded same-page attachment previews in a bounded registry inside the
  active page. The scan result contains only a small `pagePreviewKey`; the popup
  retrieves one preview at a time after a remote thumbnail fails to render.
  This keeps the `chrome.scripting.executeScript` result below Chrome's message
  quota on large forum pages.
- Dedupe candidates by normalized URL.

The scanner does not crawl unrelated pages in the MVP.

## Media Model

Each candidate uses this shape in popup state:

```js
{
  id: string,
  url: string,
  previewUrl: string,
  previewSourceUrl: string,
  pagePreviewKey: string,
  type: "image" | "video",
  extension: string,
  source: string,
  filename: string,
  filenameHints: string[],
  fallbackUrls: string[],
  downloadMode: "chrome" | "page",
  pageHost: string,
  sameOrigin: boolean,
  width: number | null,
  height: number | null,
  ignored: boolean,
  ignoreFingerprints: string[],
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
- Download destination settings and per-item terminal outcome ledgers.

Temporary `data:` and `blob:` preview URLs are stripped before persistence. At
most eight recent per-tab scan states are retained, with the active tab always
preserved. If a page is reloaded and its in-page preview registry disappears,
the user can rescan to rebuild those authenticated attachment previews.

A separate global ignore list is stored under `guided_media_ignore_list`.
Ignored media is matched by stable fingerprints derived from canonical media URL
and, when available, filename plus dimensions. The MVP does not hash every file's
contents during scan because that would require fetching many large or
cross-origin files before the user chooses what to keep.

## Background Service Worker

The background worker owns downloads.

Responsibilities:

- Receive selected media candidates from the popup.
- Generate safe filenames and page/thread folders through the shared resolver.
- Start downloads with `conflictAction: "uniquify"`.
- Track active Chrome download ids in memory and mirror the minimum recoverable
  session state in `chrome.storage.session`.
- Restore active ids and recoverable queued URL downloads after a service-worker
  restart before accepting new session commands.
- Record items that are transitioning into Chrome's download API. If the worker
  restarts before Chrome returns a download id, report that indeterminate item
  as failed instead of risking a duplicate download.
- Cancel pending work, active downloads, retries, and Pixiv fetch controllers
  for an aborted session.
- Dedupe terminal events by item id and report completed, failed, and cancelled
  outcomes back to the popup.

Downloads are saved under:

```text
ImageDownloader/{host}/{page-or-thread-identity}/
```

The popup may replace the suggested subfolder for a batch. Every segment is
sanitized and traversal segments are discarded before the path reaches the
downloads API.

## Filename Resolution

The shared resolver tries response `Content-Disposition`, explicit attachment
and DOM metadata, final/original URL basenames, then a stable page-based name.
Route-like values such as `fetch`, `download`, and `index.php` are rejected as
filenames. Duplicate names receive deterministic `_02`, `_03`, and later
suffixes before Chrome's `uniquify` behavior remains as the last safety net.

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
- A page-session attachment batch is owned by the injected page context while it
  is being prepared. Abort signals its registered controllers; if the page or
  popup disappears first, the batch is reconciled as interrupted and is never
  appended late to Chrome downloads.
- Prepared `data:` payloads are intentionally not persisted across a worker
  restart because they can exceed session-storage quota. Page batches are kept
  at or below the active concurrency so those payloads are handed directly to
  Chrome instead of accumulating in the recoverable queue.
- Chrome's downloads UI remains the final source of truth for files that finish
  exactly while the extension worker is being terminated.

## Stabilization Notes

- Milestone 1 defined the old popup countdown behavior and fixed the 48px icon
  asset mismatch.
- The MVP replaces the old separate image/WebM batch flows with one guided media
  collector flow.
