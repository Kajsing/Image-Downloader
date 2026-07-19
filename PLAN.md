# MVP Plan

## Goal

Turn the old batch downloader into a guided media collector for wallpaper-style
images and videos. The extension should scan the active page, show useful
candidates, let the user filter and select them, and download only the selected
files with clear progress.

## Visual Direction

Use the MVP mockup at `docs/mockups/guided-media-collector-mvp.png` as the
design reference while building the popup. Treat it as direction, not a
pixel-perfect spec: compact tool UI, scan summary, filters, selectable media
previews, a "Select likely wallpapers" action, and selected-download progress.

The v2.1 redesign is captured in
`docs/mockups/safer-batch-downloads-v2.html`. It replaces the old two-column
cards with compact filename-first rows and adds destination, confirmation, and
Abort states.

## Non-Goals

- No backend service.
- No accounts, sync, or telemetry.
- No cloud storage.
- No paid dependency.
- No broad crawling across unrelated pages.
- No bypassing site access controls.

## Milestone 1: Stabilize Existing Extension

Status: complete

- Define or remove the broken countdown behavior.
- Fix the 48px icon mismatch.
- Validate manifest JSON and JavaScript syntax.
- Smoke-test current popup manually if possible.

Done when:

- Existing scan/download behavior still works.
- No known runtime error from missing constants.
- Extension package assets match manifest expectations.

## Milestone 2: Unified Scan Model

Status: complete

- Replace separate image/WebM scan state with one media candidate model.
- Scan images from `img[src]`, `img[srcset]`, and direct media anchors.
- Scan videos from `video`, `source`, and direct media anchors.
- Add support for `webp` and `mp4`.
- Dedupe by normalized URL.

Done when:

- One scan action returns mixed image/video candidates.
- Candidates include type, extension, URL, source, and dimensions when known.
- Existing 4chan-style image and WebM links are still found.

## Milestone 3: Guided Popup UI

Status: complete

- Replace separate sections with a single scan/filter/select/download flow.
- Add filters for type, extension, same-origin, minimum dimension, and likely
  wallpapers.
- Add compact preview list/grid with select all, select none, and visible count.
- Persist selection and filters per tab.

Done when:

- User can inspect results before downloading.
- User can quickly select likely wallpaper media.
- Popup remains readable and efficient at extension-popup size.

## Milestone 4: Selected Downloads With Progress

Status: complete

- Download only selected candidates.
- Generate safe folder and filenames.
- Show queued, completed, failed counts, and latest error.
- Preserve conflict handling with unique filenames.
- Add adaptive download speed modes that reduce concurrency and retry when a
  host stalls, times out, or interrupts downloads.

Done when:

- Download action never downloads unselected files.
- User sees clear progress.
- Failed downloads are reported without stopping the whole batch.

## Milestone 5: Polish And Documentation

Status: complete

- Update README with installation and usage.
- Document permissions and privacy.
- Add manual test checklist.
- Run final validation.

Done when:

- README describes the new guided workflow.
- Validation steps and limitations are documented.
- MVP is ready to load as an unpacked Chrome extension.

## Next Release: Safer Batch Downloads

The next release should make large batches safer to control, produce more
predictable folders and filenames, and simplify the popup around the user's
actual workflow: scan, narrow, verify, and download.

This remains a local-first Chrome extension. The work must not add a backend,
accounts, telemetry, broad host permissions, or multi-page crawling.

### Product Decisions

- A running batch gets a prominent `Abort` action. Aborting stops pending work,
  cancels active Chrome downloads where possible, stops retries, and ignores
  late page-fetch results. Files that already completed remain on disk.
- Large batches get a confirmation step before they start. The confirmation
  shows the exact item count, destination, and speed mode.
- Downloads stay below the fixed `ImageDownloader/` root. The default
  destination is page/thread-specific and can be edited for each batch.
- Filename discovery follows one deterministic priority order. A generated
  fallback is used only after all available metadata has been checked.
- The redesigned popup must show the proposed filename and destination before
  download so naming mistakes are visible early.

## Milestone 6: Abortable Download Sessions

Status: complete

- Add an explicit session state: preparing, downloading, aborting, completed,
  completed-with-errors, and aborted.
- Add a `cancelDownloadSession` message handled by the background worker.
- On abort, mark the session stopped before cancelling work so interrupted
  downloads cannot be retried.
- Remove pending queue items, clear pump and retry timers, abort in-progress
  extension fetches, and call `chrome.downloads.cancel` for active download ids
  owned by the session.
- Stop scheduling new page-attachment batches in the popup. If the currently
  injected fetch batch cannot be interrupted immediately, discard its late
  result and never append it to the Chrome queue.
- Report completed, failed, and cancelled counts separately. Keep the final
  aborted state visible when the popup is reopened.
- Replace `Download selected` with a clearly distinct `Abort` action while a
  session is active, and prevent scans or selection mutations that would make
  the active session ambiguous.

Done when:

- Pressing Abort prevents any pending item from starting after the cancellation
  has been acknowledged.
- Active downloads are cancelled on a best-effort basis and never retried.
- Late progress events cannot reactivate or corrupt an aborted session.
- A batch can be started normally after an aborted batch.

## Milestone 7: Destinations And Reliable Filenames

Status: complete

- Add per-batch destination settings with a visible path preview.
- Default to a page/thread folder derived from host plus the most useful stable
  page identity: thread id or route id when available, otherwise a shortened
  page-title slug plus a short URL fingerprint.
- Let the user edit the subfolder for the current batch. Sanitize each path
  segment, reject traversal such as `..`, and keep the result under
  `ImageDownloader/`.
- Persist the chosen destination with the current tab state, but regenerate the
  automatic suggestion after navigating to a different page.
- Separate filename sanitizing from fallback generation. An empty value must
  remain empty until every filename source has been tried.
- Resolve filenames in this order when the data exists:
  1. response `Content-Disposition` filename for media already fetched by the
     extension or active page;
  2. explicit attachment metadata and `download` attributes;
  3. original-link title/text and media `data-*`, `title`, or useful `alt`
     metadata;
  4. the final redirected response URL or original media URL basename;
  5. a readable page-based fallback with media type, sequence, and a short
     stable fingerprint.
- Reject route-like pseudo-filenames such as `fetch`, `download`, `index.php`,
  and empty extension-only values when better metadata is available.
- Preserve the extension inferred from the response MIME type or media URL and
  avoid duplicate extensions.
- Resolve duplicate names within a batch deterministically before handing them
  to Chrome; keep `conflictAction: "uniquify"` as the final safety net.

Done when:

- Separate threads/pages do not collapse into the same generic filename set.
- Forum attachment names prefer server-provided names when available.
- Generic names are descriptive and stable rather than `image_001` alone.
- The popup shows the exact proposed filename and destination for every batch.
- No extra host permission is needed merely to probe filenames.

## Milestone 8: Popup UI Rethink

Status: in progress

- Create and save a new compact mockup before implementation, using the current
  working extension as the functional baseline.
- Organize the popup into four clear regions: page/scan header, compact filter
  and selection toolbar, media results, and a sticky batch action area.
- Make the primary action contextual: `Scan page`, `Download N files`, or
  `Abort`, depending on state.
- Move secondary filters and speed controls into a compact settings/filter
  surface so the result grid gets more room without hiding active choices.
- Show a concise filename on each media result, with dimensions and source as
  secondary metadata. Keep URL details available by tooltip or details action.
- Put destination, selected count, speed, progress, failures, and cancelled
  count together in the sticky batch area.
- Add an inline confirmation state for unusually large batches before queueing
  begins; do not use a stream of browser dialogs.
- Keep ignore controls available but visually secondary to selection and
  download controls.
- Preserve keyboard access, clear focus states, readable contrast, stable card
  dimensions, and the dense tool-like character of the popup.
- Verify the layout at the popup's normal width and at a narrower Chromium
  popup width, including long filenames, long hosts, and three-digit counts.

Done when:

- The common path from scan to download needs fewer competing controls.
- The user can verify count, folder, and filenames before starting a batch.
- Abort remains visible without scrolling throughout an active batch.
- No text overlaps or causes controls to shift as progress changes.

## Milestone 9: Tests, Migration, And Release

Status: in progress

- Add focused tests for folder sanitizing, filename source priority, generated
  fallback names, duplicate resolution, and cancellation state transitions.
- Add background-worker tests with mocked Chrome download events for abort,
  retry suppression, and late completion/interruption events.
- Preserve existing saved candidates and filters. Add defaults for new
  destination and progress fields instead of invalidating old tab state.
- Run manifest parsing and JavaScript syntax checks after each implementation
  slice.
- Smoke-test unpacked Chrome flows for a direct-media page, 4chan-style thread,
  forum attachment page, Pixiv, a 200+ item batch, abort during preparation,
  and abort during active downloads.
- Update `README.md` and `ARCHITECTURE.md` after the behavior is implemented.

Done when:

- Automated checks pass and the manual matrix has no blocking failures.
- Existing scan/filter/ignore behavior remains intact.
- The extension can be upgraded without clearing local extension storage.

## Recommended Implementation Order

1. Implement the session state and Abort path first, because it changes the
   contract between popup and background worker.
2. Implement the destination and filename resolver as testable helpers.
3. Produce the new mockup against those real controls and states.
4. Rebuild the popup presentation without changing scanner behavior.
5. Run migration checks, the large-batch smoke test, and documentation updates.

## Validation Commands

Use the bundled Codex Node runtime if `node` is unavailable:

```powershell
& 'C:\Users\ckajs\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check popup.js
& 'C:\Users\ckajs\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check background.js
& 'C:\Users\ckajs\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check download-utils.js
& 'C:\Users\ckajs\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check popup-state.js
& 'C:\Users\ckajs\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest.json OK')"
& 'C:\Users\ckajs\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test tests/*.test.js
```

## Stop Conditions

Stop and ask before:

- Adding backend/cloud services.
- Adding broad host permissions.
- Adding paid dependencies.
- Changing from Chrome Extension to another platform.
- Expanding into multi-page crawling beyond the active tab.
- Implementing site-specific bypasses or behavior that changes the security
  model.
