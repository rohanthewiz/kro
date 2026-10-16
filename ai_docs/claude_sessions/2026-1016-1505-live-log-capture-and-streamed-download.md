# Live log capture + streamed download for the Logs modal

**Date:** 2026-10-16 15:05 &nbsp;|&nbsp; **Session ID:** 07b671b3-25fa-4626-aad0-9c5b619d2dd5

## Request

From the cats-todo backlog: when monitoring a long-running pod's log, earlier
lines are apparently thrown away. Preserve them into a file and offer a
download, possibly as a stream (latest `rohanthewiz/rweb` supports this).

## Findings

- **Pod Watch** already captured every line to disk and had an export button
  (`/api/watch/export`), but that export read the whole file into memory.
- The plain **Logs** modal (`viewLogs` → `/sse/logs`) had no file behind it:
  it showed the pod's last 500 lines (`streamTailLines`) plus whatever streamed
  while open, held only in the DOM. Kubelet log rotation discards older lines
  on the cluster side, so nothing anywhere kept the full history.
- rweb's streaming response API (`rweb.Stream`, `SendFile`, `SendFileAs`;
  commit `9781e96f`, "N-027") is on master **after** the `v0.2.0` tag.

## What was built

### Capture registry — `podwatch/livecapture.go` (new)

- `LiveCaptures` (owned by `podwatch.Manager`, reached via `mgr.Live()`) maps a
  **browser-minted capture ID** → `LiveCapture` (file + bufio writer).
- Files live in the Pod Watch tree with a `.live.log` suffix
  (`<logDir>/<ctx>/<ns>/<pod>-<ts>.live.log`, built via
  `companionPath(logFilePath(...), "live")`), so the existing janitor,
  manual cleanup and gear-popover usage cover them.
- `trackedFiles()` (cleanup.go) now also keeps **active** live captures, so
  `Cleanup(0)` can't unlink a file mid-write.
- Why a client-chosen ID: EventSource auto-reconnects with the exact URL it was
  created with, so `cap=<id>` in the URL lets reconnects append to the same
  file. The ID is validated (`^[A-Za-z0-9_-]{8,64}$`) and is only a map key —
  never part of a path. An ID already bound to a different ctx/ns/pod is
  refused.
- Refcounted writers (`Acquire`/`Release`): the file closes when the last SSE
  connection leaves; the entry stays addressable 24h (`liveCaptureIdle`) for
  downloads/reconnects. Lines written after the last release are dropped.
- Markers match Pod Watch's format: `--- kro: live log capture of … started <ts> ---`
  and, on resume, `--- kro: log stream reconnected; lines below may repeat <ts> ---`
  (the new follow re-sends the 500-line tail; duplicates chosen over gaps).
- Time-based flush every 2s; `ExportPath` flushes before a download.

### Web — `web/sse.go`, `web/watch_handlers.go`, `web/server.go`

- `LogsSSE` acquires the capture when `cap` is present (failure is logged and
  ignored — the live view never depends on disk), releases it in
  `OnDisconnect` after `cancel()`, and `produceLogStream` writes each line
  (container prefix included, i.e. exactly what's rendered) plus stream-open
  errors. A `capture` SSE event (`{"path": …}`) announces the open file.
- New `GET /api/logs/capture?id=` → `LogsCaptureDownload`.
- Shared `sendLogDownload`: `os.Stat` first (so errors are plain JSON, not a
  saved "attachment"), then `Content-Disposition: attachment` (rweb treats
  `.log` as viewable text and sets none) + `Cache-Control: no-store` (a growing
  file + rweb's `Last-Modified` could otherwise yield cached/304 repeats), then
  `rweb.SendFileAs` — streamed from disk, size fixed at stat → consistent
  snapshot with correct Content-Length.
- `WatchExport` switched to `sendLogDownload` (no more `os.ReadFile`).

### Frontend — `web/embeds/resources.js`, `resources.css`

- `viewLogs` mints `logCaptureId` once per modal open; `startLogStream` (also
  used by the reconnect pill) appends `&cap=<id>`.
- New ⤓ `#modal-download` button (styled as `.modal-copy`), shown only with the
  new `openModal` opt `download: true` (Metrics also uses `stream: true`, hence
  a separate flag). Disabled until the `capture` event; tooltip shows the
  on-disk path. `downloadLogCapture()` uses the anchor-click pattern that
  KRo.app's WKDownload delegate already handles.
- Disabled styles for light and dark themes.

### Dependency

- `github.com/rohanthewiz/rweb` v0.1.26 → `v0.2.1-0.20261012041515-9781e96fa99a`
  (pseudo-version of master). kro built and passed tests with no code changes
  needed for the jump.

## Tests

- `podwatch/livecapture_test.go`: write+export (flush of buffered tail),
  resume appends to same file with marker, post-release writes dropped,
  overlapping writers keep file open, bad/mismatched IDs, idle prune,
  cleanup keeps active capture but prunes it once released.
- `web/download_test.go`: real rweb server over TCP — attachment +
  `no-store` headers, Content-Length matches body, unflushed tail included;
  400/404 error responses carry no Content-Disposition.
- `go vet ./...` clean; `go test -race ./...` passes.

Not verified in a browser, in KRo.app, or against a live cluster.

## Notes

- `podwatch/manager.go` has pre-existing gofmt drift (the `Stream` struct
  field alignment) — present at HEAD, left untouched.
- gopls showed stale "`Live` undefined" diagnostics during the session; the
  compiler and tests were fine.

## Next

- Tag an rweb release containing the streaming API (N-027) and move kro off
  the master pseudo-version.
- Optional: seed the capture with the pod's full available history at open
  (today it starts from the 500-line tail).
- Optional: cap the Logs modal's DOM line count for very long sessions now
  that the file holds everything (not requested).
- Optional: on reconnect, resume with `SinceTime` instead of re-sending the
  tail, to avoid duplicate lines in the capture (needs care with clock skew).
- The old `kro_collapsed_pods-orphan` localStorage key is inert; a cleanup pass
  could drop it. (carried)
- Possible: `/` shortcut to focus the pods filter box — not requested. (carried)

**Validate**

- Rebuild via `mac-install.sh`; in KRo.app open Logs on a chatty pod, confirm
  ⤓ enables, the download lands in ~/Downloads with all lines, and a reconnect
  (pill click) appends to the same file with the marker.
- Confirm Pod Watch export still downloads correctly after the switch to
  streaming.
- Eyeball the All Pods / Deployments filter tabs against a real cluster.
  (carried)
