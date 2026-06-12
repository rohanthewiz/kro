# Session: kubernetes-logs-error-detection

**Date:** 2026-06-11 17:26 · **Session ID:** `f8dd7b01-678f-4e11-b131-778b048bbc6b`

## Request

Bug report on the Pod Watch feature: *"In watch mode it seems like when I get an
error, I do not get a stream."* When a watched pod errored, the stream row
reached a terminal badge but the captured file/console was empty.

Clarified via Q&A:
- **Symptom:** row ends `completed`/`error` but with no useful content.
- **Desired fix:** capture the crashed container's logs (previous instance) AND
  flag the stream `error` with a clear message.

## Diagnosis

Root cause in `kube/logs_stream.go`. Capture (`StreamPodLogsOpts`) only followed
the **live** container instance via `GetLogs{Follow:true}`. For an erroring pod:

1. `req.Stream()` fails ("container is waiting to start"). Old code retried every
   2s for the full `readyTimeout` (**2 min**) silently, then emitted one cryptic
   `(stream error for ...)` line and returned **`nil`**.
2. `runStream` maps a `nil` return → **`StateCompleted`**, never `error`.
3. No `Previous:true` fetch anywhere → crashed-container output was never read.
4. State mislabeled: only a failed pod `Get` produced `StateError`; container
   stream failures showed as `completed`.

UI was confirmed *not* the cause — `web/embeds/watch.js` renders a row for every
state (badge styles for all states incl. red `.error` exist in `watch.css`).

## What was built

### `kube/logs_stream.go` (rewritten)

- Per-container worker `streamContainerLogs()` extracted from `StreamPodLogsOpts`.
  `StreamPodLogsOpts` now collects the first per-container error and returns it
  (was: always `nil`).
- **Classification** decides keep-waiting vs crashed/errored:
  - `isStartupReason()` — `""`/`ContainerCreating`/`PodInitializing` → still
    coming up → keep the existing patient retry to `ReadyTimeout`.
  - Anything else non-empty (CrashLoopBackOff, ImagePullBackOff,
    CreateContainerError, non-zero exit, …) → **crash/error**: capture previous
    logs once + return a descriptive error → stream flagged `error`.
- `emitPreviousLogs()` — best-effort `GetLogs{Previous:true}`, bracketed by
  `--- previous (crashed) instance logs ---` / `--- end previous instance logs ---`
  markers. Emits nothing if there is no previous instance (e.g. ImagePullBackOff).
- `containerProblem(ctx, client, ns, name, cname, afterFollow)` → `classifyContainer()`
  (pure) → `terminatedProblem()` (pure, non-zero exit helper).
  - `afterFollow=true` (a live follow just ended) also consults
    `LastTerminationState` (a fast restart moves the exit code there) and treats
    a pod with `DeletionTimestamp != nil` as a clean completion, not a crash.
- `copyStream()` — extracted scanner loop, reused by live follow + previous logs.
- Error message format: `container "app" CrashLoopBackOff: <msg>` /
  `container "app" Error: exit code 7`. `runStream` writes it as an
  `--- error: ... ---` file marker and stores it in the badge tooltip.

Same improvement flows to the `/sse/logs` viewer for free — `produceLogStream`
(`web/sse.go`) already broadcasts a `(error opening log stream: ...)` event on a
non-nil return.

### `kube/logs_stream_test.go` (new)

Table tests for the pure classifier: startup vs CrashLoopBackOff vs ImagePull vs
non-zero-exit vs clean exit (exit 0), empty-reason→`Error` default,
multi-container matching, unknown container, and restarted-after-crash
(`LastTerminationState`) gated by the `includeLast` flag.

## Verification (throwaway kind cluster `kro-crash-test`, created + deleted in-session)

Used a temporary `cmd/watchverify` program (since removed) driving
`podwatch.Manager` + `kube.StreamPodLogsOpts` directly against the cluster
(`WatchStart` is cookie-selection bound, awkward from curl; only the capture path
changed). Crashing pod: `busybox sh -c "echo ...; exit 7"`, `RestartPolicy:Always`.

- **Phase 1 — CrashLoopBackOff, direct call:** crash logs captured + returned
  `CrashLoopBackOff` error. (Note: in kind's containerd, `GetLogs{Follow:true}`
  on a CrashLoopBackOff container *succeeds* and serves the last terminated
  instance directly, so the `Previous:true` fallback path wasn't exercised here —
  it is a safety net for runtimes/states where Follow fails.)
- **Phase 1b — ImagePullBackOff:** returned in **14 ms** with `ErrImagePull` —
  confirms prompt error, no 2-minute silent hang.
- **Phase 2 — full watch flow, fresh crashing pod:** `starting → error`, 3 lines
  + `--- error: container "app" Error: exit code 7 ---` marker in the captured
  file. All assertions passed.

`go build ./...`, `go vet ./...`, `go test ./...` all clean.

## Gotchas hit during the session

1. First verify run returned `completed` (not `error`) for a caught-live crash:
   a fast restart moved the exit code from `State.Terminated` into
   `LastTerminationState`, which the classifier didn't check. Fixed with the
   `afterFollow`/`includeLast` path + `DeletionTimestamp` guard.
2. `GetLogs{Follow:true}` on a CrashLoopBackOff container succeeds in
   kind/containerd, so the `emitPreviousLogs` marker assertion (re)failed — a
   flawed test assumption, not a code bug; downgraded to informational.
3. `go build ./cmd/watchverify` left a `watchverify` binary in the repo root;
   removed along with `cmd/`.

## State at session end

Uncommitted on `main`: **modified** `kube/logs_stream.go`, **new**
`kube/logs_stream_test.go`. Throwaway `cmd/watchverify` and the kind cluster
deleted. Next step if resumed: commit. The web/podwatch layers were unchanged.
