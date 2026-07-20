# Session: Pod Watch errors/warnings companion files + per-frame view dropdown

Session ID: 53c9e7c1-9984-43b9-b2aa-1cd17700a8c9
Date: 2026-07-20 14:34

Feature request: in Pod Watch, when a stream has errors or warnings, capture
them into an associated file that is **never truncated**, and add a dropdown on
the far right of each console frame's toolbar to choose which file to view
(All / Errors / Warnings).

Design decision (asked the user): the dropdown lives **per console frame**, not
on the main page toolbar — each pod has its own log/errors/warnings files, so
"choose the file" maps to the pod you're viewing. User confirmed per-frame.

All backend + frontend; the `web/embeds/*` assets are `go:embed`ed into the
binary, so seeing this in KRo.app needs a rebuild + re-run of `mac-install.sh`.
(Did NOT run `mac-install.sh` — it `git reset --hard origin/main`s `~/.kro`
and would discard these uncommitted edits. Commit/push first.)

## What was built

For each pod stream, two companion files are written next to the main
`<pod>-<ts>.log`, created **lazily** only when the first matching line appears
(clean pods produce no extra files):

- `<pod>-<ts>.errors.log`   — error / fatal / panic lines
- `<pod>-<ts>.warnings.log` — warning lines

They are append-only and never truncated (unlike the console buffer, the 2000-
line ring, and the tail-replay caps). Continuation lines with no level of their
own (stack traces, wrapped messages) inherit the preceding line's level, so a
stack trace stays routed with the error that produced it — mirroring the
per-frame level inheritance the browser colorizer (`resources.js`) already does.

Each console frame header gets an **All / Errors / Warnings** `<select>` at the
far right (just before the × close). Switching it reloads that frame from the
chosen file: Errors/Warnings replay the *whole* companion file (no tail cap) and
then stream only that bucket's lines live; All is the existing full-log view.
Capture and the other files keep running untouched.

## Server changes

- `podwatch/classify.go` (NEW) — `classifyLine(line) -> "err"|"wrn"|"oth"|""`,
  mirroring the JS level detection: JSON `"level":"…"`, logfmt `level=…` /
  `level="…"`, then bare uppercase tokens (`ERROR|FATAL|PANIC|FTL|ERR`,
  `WARNING|WARN|WRN`, `INFO|INF|DEBUG|…`). `"oth"` = a recognized info/debug
  line (ends an error/warn run); `""` = no level (inherits).
- `podwatch/stream.go`
  - `startStream` sets `st.errPath`/`st.warnPath` (`companionPath`).
  - `emitLocked` now computes a route via `routeLocked` (carries `st.lastRoute`
    forward for inheritance), writes matching lines to companions via
    `writeIssueLocked` (lazy open, best-effort — a companion failure never
    disrupts capture, main log stays authoritative), and filters tee
    subscribers by their view.
  - `flushLocked` / `closeLocked` flush+close the companion writers alongside
    the main file.
- `podwatch/manager.go`
  - `Stream` gains `errPath/warnPath`, `errFile/errW`, `warnFile/warnW`,
    `lastRoute`; `subs` changed from `map[chan string]struct{}` to
    `map[chan string]string` (value = view filter: `""`=all, `"err"`, `"wrn"`).
  - `Subscribe(ctx, ns, pod, tail, view)` — new `view` param + `viewFilter`
    helper. For an issue view it flushes then reads the whole companion file for
    replay and registers the sub with a bucket filter, all under one `st.mu`
    hold so the replay→live boundary has no gap and no duplicate (same
    atomicity guarantee the ring path already had).
- `podwatch/files.go` — `companionPath(mainPath, kind)` (`<base>.log` ->
  `<base>.<kind>.log`) and `readLogLines(path)` (whole-file read; `nil` if
  absent).
- `podwatch/cleanup.go` — `trackedFiles()` now also protects `errPath`/
  `warnPath`, so a live/listed stream's companions are kept in lockstep with its
  main log by the retention janitor.
- `web/watch_sse.go` — `WatchLogsSSE` reads `?view=` and threads it to
  `Subscribe`; updated the endpoint doc comment.

## Frontend changes

- `web/embeds/watch.js`
  - Frame header: added `<select class="watch-frame-view">` (All/Errors/
    Warnings) before the close button; `frame.view` state (default `all`).
  - Refactored the inline EventSource setup out of `openFrame` into
    `connectFrame(frame)` (builds URL with `&view=`), and added
    `setFrameView(frame, view)` — clears the body/buf, resets `lastLvl`, resets
    an open search count, and reconnects.
- `web/embeds/watch.css` — `.watch-frame-view` styling (light + dark).

## Cleanup / retention (answered a follow-up)

Companions share the `*.log` suffix, so they ride the existing cleanup exactly:
janitor at startup + every 6h deletes `*.log` older than retention (default 7d,
`KRO_WATCH_LOG_RETENTION_DAYS`, `0`=off); the gear popover's manual "older than
N days" (`0`=all) hits the same `Cleanup()`. Tracked streams' files (active or
listed-terminal, pre-"Clear Streams") are never deleted regardless of age — now
including the companions. Eligibility is per-file mtime, so an errors file whose
last error predates the pod's last normal line can age out a cycle before the
main log (harmless).

## Out of scope (noted to user)

- Export/download still serves the full main log regardless of the dropdown; the
  Copy button already copies the on-screen view.

## Verification

- `go build ./...`, `go vet ./podwatch/ ./web/`, `go test ./...` all clean.
- Added tests: `TestClassifyLine` (level detection table) and
  `TestErrorsWarningsCompanionAndView` (routing + inheritance, errors/warnings
  replay from the untruncated files, live bucket filtering, companion file line
  counts). Updated existing `Subscribe` callers/`subs` literals for the new
  signature/type.
- `node --check` clean on `watch.js`.
- Ran the built binary on `KRO_PORT=8299`: page serves the new UI
  (`watch-frame-view` / `connectFrame` / `setFrameView` / `&view=` present) and
  `/sse/watch-logs?view=errors` returns 400 for missing context/ns/pod (route
  wired). A full live drive needs a cluster generating error/warn logs, not set
  up here.

## To take effect in KRo.app

Rebuild and re-run `mac-install.sh` (embeds are compiled into the binary).
