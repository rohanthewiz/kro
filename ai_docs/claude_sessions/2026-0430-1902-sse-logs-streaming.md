# SSE Pod Log Streaming + Modal Polish

**Date:** 2026-04-30 19:02
**Session ID:** c9d6f19a-379b-47ba-a03b-dbae1475265a

## Goal

Turn the kro pod-logs popup from a one-shot REST fetch into a live, terminal-style viewer:

1. Make the modal wider (up to 90% of window).
2. Stream logs over SSE for the lifetime of the popup, all containers, follow mode.
3. Add a font-size adjuster (`A−` / `A+`) with persistence.
4. Add a Connected pill (dot + label) like the edp_dataflow dashboard, clickable to force reconnect.

## What changed

### Server

- `kube/logs_stream.go` (new) — `StreamPodLogs(ctx, client, ns, name, out chan<- LogLine)` follows logs for every init+regular container concurrently with `Follow:true, TailLines:500`. Emits `LogLine{Container, Line}` on `out`. Container tag is empty for single-container pods so the web layer can skip the `[name]` prefix. Cancelling `ctx` tears every container's stream down.
- `web/sse.go:LogsSSE` — new SSE endpoint at `GET /sse/logs?name=<pod>`. Resolves cookie context/namespace, opens the kube streamer, pumps each line as a `log` SSE event.
- `web/server.go` — registers `/sse/logs`. Old `/api/logs` route is left in place but no longer called.

### The cancellation bug

First implementation cancelled the kube context the moment `SetupSSE` returned. That broke immediately:

```
(error opening log stream: client rate limiter Wait returned an error: context canceled)
```

Root cause: rweb's `SetupSSE` does **not** block until disconnect (despite a comment in the existing `/sse/resources` handler saying it does). It just sets `ctx.sseEventsChan` and returns; the actual SSE pump runs later in the response-writing phase via `sendSSE`. The kube `pod.Get` was hitting the client-go rate limiter, which checks `ctx.Err()` and returns `context canceled` because we'd already called `cancel()` after `SetupSSE` returned synchronously.

### Fix: per-request `SSEHub` with `OnDisconnect`

rweb v0.1.26 added `SSEHubOptions.OnDisconnect`, which fires when the SSE pump actually exits (i.e., the browser truly disconnected — detected via `connGone` read on the underlying TCP conn or a write error). That's the only public hook tying handler-level cleanup to real disconnect.

`web/sse.go:LogsSSE` now:

1. Creates `streamCtx, cancel`.
2. Creates a per-request `SSEHub` with `ChannelSize: 256`, `HeartbeatInterval: 30s`, and `OnDisconnect: { cancel(); hub.Close() }`.
3. Calls `hub.Handler(svr, "log")(c)` first — this registers the per-client buffered channel and the cleanup hook before the producer starts, so the producer's first lines aren't broadcast into an empty hub.
4. Spawns `produceLogStream(streamCtx, ..., hub)` which `BroadcastRaw`s each line as `SSEvent{Type:"log", Data:...}`.

When the client closes the modal/tab:

- `sendSSE`'s `connGone` channel fires → `sendSSE` returns → deferred `sseCleanup` runs `hub.Unregister(clientChan)` → `OnDisconnect` fires → `cancel()` tears down kube streams; `hub.Close()` stops heartbeat.

`BroadcastRaw` (not `Broadcast`) is used so the JS keeps using `addEventListener('log', ...)` instead of `onmessage` + JSON.parse.

### Client

`web/embeds/resources.js`:

- `viewLogs(name)` now opens the modal in **wide** + **stream** mode and starts an `EventSource('/sse/logs?name=...')`.
- Lines append to `<pre id="modal-content">`; autoscroll is suppressed if the user has scrolled up (>30px from bottom).
- `closeModal` (and `Esc`) closes the EventSource — stream lives only while the popup is open.
- Font-size buttons (`A−` / `A+`) adjust `.modal-content` between 9–22px, persisted in `localStorage` under `kro_modal_font_px`.
- Connection pill in the modal header:
  - `● Connecting…` (yellow) on open
  - `● Connected` (green) on `onopen` and on every received log line — covers browsers that emit `log` before `open`
  - `● Reconnecting…` (yellow) on `onerror` (EventSource auto-retries)
  - **Click** = force reconnect (close + reopen for the same pod)
- Pill only shows for log mode (`opts.stream`); hidden for Describe.

`web/embeds/resources.css`:

- `.modal-dialog.wide { width: 90vw; max-width: 90vw; max-height: 90vh; }`
- `.modal-stream-status` pill, reuses existing `.log-status` colors from `header.css`.
- `.modal-font` shares the icon-button styling with `.modal-copy`. Dark-mode variants for both.

## Files touched

```
M  web/server.go              -- /sse/logs route
M  web/sse.go                 -- LogsSSE + produceLogStream
A  kube/logs_stream.go        -- StreamPodLogs
M  web/embeds/resources.js    -- streaming, font sizer, status pill
M  web/embeds/resources.css   -- .modal-dialog.wide, .modal-stream-status, .modal-font
```

`kube/logs.go` (the original one-shot `PodLogs`) and the `/api/logs` REST route are left intact; no callers but harmless and cheap to keep around.

## Lifecycle, end-to-end

```
Browser opens modal
    │
    ├── new EventSource("/sse/logs?name=POD")
    │
LogsSSE handler
    ├── streamCtx, cancel := WithCancel(Background)
    ├── hub := NewSSEHub({ChannelSize:256, Heartbeat:30s, OnDisconnect:{cancel; hub.Close}})
    ├── hub.Handler(svr,"log")(c)        -- registers clientChan, sets sseCleanup
    └── go produceLogStream(streamCtx, ..., hub)
            └── go StreamPodLogs(streamCtx, ...)
                  └── one goroutine per container, Stream(ctx) with Follow:true

(rweb response phase)
    sendSSE(ctx) blocks pumping clientChan → wire
    ↑
    ↓ produceLogStream loop: <-lines → hub.BroadcastRaw → clientChan → sendSSE → wire

Browser closes tab / modal
    sendSSE detects connGone → returns → deferred sseCleanup
    └── hub.Unregister(clientChan) → OnDisconnect
            ├── cancel()      -- kube goroutines exit on ctx.Done
            └── hub.Close()   -- stops heartbeat
```

## Why not a single shared SSEHub

Each request targets a different pod (and different cluster/namespace), so per-request lifecycle and per-request kube context are required. The hub-per-request pattern is cheap (a handful of allocs, no goroutine cost beyond the heartbeat ticker that we close on disconnect) and is the cleanest way to get rweb's cleanup callback wired up.

## Caveats / followups

- The existing `/sse/resources` handler has the same conceptual bug (it cancels its producer immediately after `SetupSSE` returns, so each connection delivers exactly one snapshot, then idles). Browser side masks it via the 60s heartbeat-timeout reconnect → effectively poll-every-60s. Not fixed here — out of scope. Same `SSEHub` + `OnDisconnect` retrofit would fix it.
- Hub's `MaxDropped: 3` default could evict a slow client during burst log lines; bumped `ChannelSize` to 256 to compensate. If a pod is *very* chatty and the browser is slow, eviction is still possible — acceptable for now since the user can click the pill to reconnect.
- `bufio.Scanner` buffer is set to 1MB max line; a multi-MB single log line would be truncated. Practical for kubectl-style logs.