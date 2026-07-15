# Session: Fix pod-watch going deaf on EKS + un-squish the SSE status dot

Session ID: 87dd8821-a307-432e-8e84-a54a298e4ab7
Date: 2026-07-15 13:27

Two independent fixes this session.

## 1. Connection indicator (green dot) squished on narrow screens

### Problem
The header's SSE connection-status dot (the little green dot between the "Kube
Config" and "Refresh" buttons) rendered as a vertical oval on narrower windows
instead of a circle.

### Root cause
`web/embeds/header.css` — `.log-status` is an 8x8 `inline-block` with
`border-radius: 50%`, living inside the flex `.header-actions` row. On narrow
screens flexbox shrank every child to fit, and horizontally shrinking a circle
turns it into a vertical oval.

### Fix
Added `flex: 0 0 auto` to `.log-status` so flexbox leaves its 8x8 size alone.

## 2. Pod watch "runs a while, then goes deaf"

### Problem
The user occasionally sees the pod watch stop picking up newly created pods
after it has been running for a while. The watch session still shows active,
but no new streams start. Confirmed symptom: "runs a while, then goes deaf"
(not a start-time failure).

### Root cause
`podwatch/watch_loop.go` — the `Watch` call had **no `TimeoutSeconds`**. The
reconnect logic (`needRelist` on channel close) is solid, but it only fires
*when the channel closes*. On EKS the API server sits behind an AWS Network
Load Balancer that silently blackholes a connection idle past 350s — no
FIN/RST reaches either side. With no client- or server-side timeout,
`for ev := range w.ResultChan()` then blocks forever: the watch is deaf, no
`Added` events arrive, no streams start.

### Fix
Two parts, both in `podwatch/watch_loop.go`:

1. **Bounded watch lifetime.** Each `Watch` now sends `TimeoutSeconds`,
   jittered to 240-300s via a new `watchTimeoutSecs()` (`math/rand/v2`). The
   server closes the watch cleanly well under the NLB's 350s idle blackhole,
   and the existing re-list-and-reconnect path handles the close. Jitter keeps
   many sessions from re-listing in lockstep.

2. **Client-side watchdog.** `time.AfterFunc(timeout + watchStallGrace, w.Stop)`
   (grace = 30s) as a backstop for the true half-open case where the server's
   close never reaches us. If the range hasn't exited by then, `w.Stop()`
   closes the channel and the loop re-lists/reconnects. Stopped normally after
   the range; `w.Stop()` is idempotent so the double-call is safe.

Worst-case recovery from a wedged watch drops from indefinite to <= ~330s.

### Trade-off noted (not acted on)
Watches now re-establish (and re-`List` the namespace) every ~4-5 min instead
of every ~30 min. Negligible at this tool's one-namespace-per-session scale.
Future optimization if List load ever matters: on a *clean* close, re-`Watch`
from the current `rv` (bookmarks keep it fresh) instead of a full re-list;
re-list only after an error or a watchdog-forced stop.

## Other reliability gaps found but left alone
These don't cause the "goes deaf" symptom, so they were surfaced but not
changed:
- `web/embeds/watch.js:~179` — `loadWatchNamespaces()` swallows fetch errors
  (`.catch(function(){})`); a failed `/api/namespaces` leaves the picker empty
  and Start says "Pick a namespace" with no cause shown.
- `podwatch/stream.go:~25` — at the max-streams cap a new pod is silently
  dropped (only a transient `limit_reached` SSE notice), never retried.

## Verification
- `go build ./...` — clean.
- `go vet ./podwatch/` — clean.
- CSS change is `go:embed`-ed; rebuild picks it up, no codegen step.
- Runtime confirmation deferred to the user's EKS cluster: the tell-tale is the
  watch quietly re-establishing every few minutes with new pods still picked up
  after a long-open session.

## Files changed
- `podwatch/watch_loop.go` — `TimeoutSeconds` + jitter helper + watchdog.
- `web/embeds/header.css` — `flex: 0 0 auto` on `.log-status`.
