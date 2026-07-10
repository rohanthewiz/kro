# Log stream reconnect for long-running pods

**Date:** 2026-07-10 17:21 &nbsp;|&nbsp; **Session ID:** 83c63e45-a677-4c20-b297-9f3a1ebca968

## Problem

The log stream quits early for long-running pods (e.g. the platform coordinator
pod that runs 24/7). A Pod Watch capture (and the SSE live log view) would flip
to **completed** after a while even though the pod was still alive and logging.

## Root cause

In `kube/logs_stream.go` `streamContainerLogs`, when the follow stream hit EOF
the code only asked "did the container crash?" (`containerProblem`). If not, it
returned nil, which `runStream` (`podwatch/stream.go`) treats as a natural end →
`StateCompleted`. But Kubernetes severs long-lived follow streams routinely
while the container is still running:

- **kubelet log rotation** — the follow ends when the container's log file
  rotates (default every ~10MB of output). Guaranteed for chatty 24/7 pods.
- **apiserver connection recycling / proxy or LB idle timeouts** — kills quieter
  streams too (relevant on LKE behind its API-server load balancer).

Nothing ever checked "is the container actually still running?" before
completing, and nothing reconnected.

## Fix (all in `kube/logs_stream.go`)

1. **Reconnect on server-side disconnect.** After an EOF with no crash detected,
   new helper `containerStillRunning` fetches the pod: if the named container is
   `Running` (or `Waiting` with a startup reason), sleep `streamRetryInterval`
   (2s) and reconnect instead of returning. A pod that is gone, mid-deletion
   (`DeletionTimestamp` set), or whose container is terminated still completes
   normally.

2. **Precise resume with no duplicate lines.** Follow requests now set
   `Timestamps: true`. New `copyTimestampedStream` parses and strips the leading
   RFC3339Nano timestamp from each line (`splitLogTimestamp`, defensive
   fallback: unparseable lines pass through untouched) and returns the last
   line's timestamp. On reconnect, `SinceTime` = that timestamp truncated to the
   second (the API's granularity), and the sub-second overlap the server replays
   is dropped by timestamp comparison (`!ts.After(skipThrough)`). Result: no
   gaps, no duplicates in the capture file. `TailLines` is nilled on reconnect
   so the tail isn't re-applied. The original `copyStream` (no timestamps) is
   still used by `emitPreviousLogs` for crashed-instance capture.

3. **Established follows survive transient API errors.** Previously any
   `Stream()` failure after startup was governed by `ReadyTimeout`
   (default 10 min, long expired hours into a capture) → one API blip errored
   the stream. Now a `connected` flag routes reconnect failures to: pod
   NotFound (`apiErrors.IsNotFound`) → clean completion; anything else → retry
   every 2s until cancelled. `ReadyTimeout` now only governs initial startup.

4. **Stale-crash false-positive fix (latent bug, made hot by reconnects).** A
   container that crashed once keeps that crash in `LastTerminationState`
   forever. With `afterFollow=true`, the first EOF after recovery would report
   the old crash and flag the stream as `error`. `containerProblem` now takes a
   `followStart time.Time` instead of the bool (zero = not after a follow);
   `classifyContainer` gained a `crashesSince` param and ignores a
   last-termination that finished before `crashesSince - lastCrashSlack`
   (30s slack for node-vs-local clock skew). A crash that actually ended the
   just-followed run is still reported.

No changes needed in `podwatch/` or `web/` — both consume
`StreamPodLogs(Opts)` and now simply don't see premature EOFs. Doc comments on
`StreamPodLogs` updated to state the reconnect contract.

## Tests

`kube/logs_stream_test.go`:

- `TestClassifyContainer` updated for the new signature; added cases
  "crash during the follow is flagged" and "old crash predating the follow is
  ignored" (new helper `runningAfterCrashAt` sets `FinishedAt`).
- `TestSplitLogTimestamp` — normal line, empty log line (`"<ts> "`), and
  non-timestamp line passthrough.
- `TestCopyTimestampedStreamSkipsReplayedLines` — lines at/before `skipThrough`
  dropped, later lines delivered stripped, last-timestamp returned.

`go build ./...`, `go vet`, `go test ./kube ./podwatch` all pass.

## Verification note

Unit tests cover the dedupe/classification logic; the reconnect path itself
needs a live cluster. To confirm end-to-end: start a Pod Watch on the
coordinator's namespace and leave it running past a log rotation / idle window —
the stream should stay `running` indefinitely, with the capture file gapless
and duplicate-free across reconnects.

## Key files

- `kube/logs_stream.go` — all behavior changes
- `kube/logs_stream_test.go` — updated + new tests
- `podwatch/stream.go` `runStream` — unchanged, but is where nil/error return
  maps to completed/error state (context for why premature nil was the bug)
