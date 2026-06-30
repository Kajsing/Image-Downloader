# AGENTS.md

## Repository

This is a Manifest V3 Chrome Extension for finding and downloading images and
video files from the active browser tab.

## Product Direction

The current goal is described in `PLAN.md`: evolve the old batch downloader into
a guided media collector with scan, filter, preview/select, and selected
download flow.

Keep the project local-first:

- No backend service.
- No account system.
- No telemetry.
- No paid or cloud dependency.
- No broad host permissions unless the active milestone explicitly requires it.
- No crawling beyond the active page for the MVP.

## Validation

After meaningful changes, run the best relevant checks available:

- Parse `manifest.json`.
- Run JavaScript syntax checks for changed scripts.
- Smoke-test the unpacked extension when UI or browser behavior changes.

Use Codex's bundled Node runtime if `node` is not on PATH.

## Style

- Prefer clear, small modules over clever abstractions.
- Keep the popup fast and understandable.
- Keep UI dense and practical; this is a tool, not a landing page.
- Avoid broad rewrites unless the current milestone calls for them.
- Keep user-visible text concise and practical.
