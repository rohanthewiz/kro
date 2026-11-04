# Session: Pod Watch export follows the frame's view dropdown (N-006)

Session ID: `46d71e83-8d44-48f7-b848-463f2fbbecc4`

## Summary

Took N-006 from the next-list (dropped in from the cats-todo backlog). The
Pod Watch export (⤓ on a stream row, `GET /api/watch/export`) always served
the full main log, even when that pod's console frame was on the Errors or
Warnings view. Copy already copied the on-screen view. Now export follows the
frame's view dropdown too.

## Changes

- `podwatch/manager.go`
  - New sentinel `ErrNoIssueFile`: an errors/warnings export for a bucket
    with no captured lines. Companion files are created lazily on the first
    matching line, so "no file" means "nothing to export", not "pruned".
  - `ExportPath(ctx, ns, pod, view)`: new `view` param. Flushes all writers
    (main + both companions), then maps the view with the same `viewFilter`
    `Subscribe` uses. `errors` → `<base>.errors.log`, `warnings` →
    `<base>.warnings.log`, anything else (`all`, empty, unknown) → main log.
  - `issueExportPath` stats the companion under `st.mu` right after the
    flush and returns `ErrNoIssueFile` if it is absent.
- `web/watch_handlers.go`
  - `WatchExport` reads `?view=` and passes it through. The doc comment
    records that the level filter is still deliberately not applied
    (`2026-0610-1325-log-view-level-filtering`).
  - `watchErrStatus` maps `ErrNoIssueFile` → 404.
- `web/embeds/watch.js`
  - `exportLog` uses the open frame's view (`frames[key].view`). With no frame
    open it exports the full log. Sends `&view=`.
  - Empty bucket guard: shows a "nothing to export" notice instead of
    navigating to a 404 (a failed attachment navigation in WKWebView gives no
    feedback). The entry counts are pushed on an interval and can briefly read
    zero after a fresh error, so the guard needs both a zero count and a frame
    with no log lines (new `frameHasLogLines`: body spans plus queued `buf`,
    ignoring end-of-stream markers). Otherwise it defers to the server.
  - The row's ⤓ tooltip names the file the export will be ("the errors file
    (frame view)" etc.). `setFrameView` calls `renderStatus()` so the tooltip
    follows the dropdown.
- `podwatch/podwatch_test.go`: `TestExportPath` callers updated for the new
  signature. New `TestExportPathView` covers the warnings view before any
  warning (`ErrNoIssueFile`), the errors view (flushed companion holding only
  error lines), warnings becoming exportable after a warning, and
  `all`/empty/unknown → main log.

## Verification

- `go build ./...`, `go vet ./podwatch/ ./web/`, `go test ./...` all pass.
- `node --check web/embeds/watch.js` is clean.
- Not run in a browser or in KRo.app. Embeds are compiled in, so this needs
  a commit/push and a `mac-install.sh` rebuild. The UI check is N-022.

## Next

Closed: N-006. Declined: None. Raised: N-022.
Deferred: None. Promoted: None. Moved: None.
Updated: None. Full list: `ai_docs/todo/next-list.md`.
