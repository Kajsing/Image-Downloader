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

## Validation Commands

Use the bundled Codex Node runtime if `node` is unavailable:

```powershell
& 'C:\Users\ckajs\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check popup.js
& 'C:\Users\ckajs\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check background.js
& 'C:\Users\ckajs\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest.json OK')"
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
