# Session: Pod Watch stream-cap wait queue (N-004)

Session ID: `092f033a-9b36-480b-b581-e0e430d4bc1b`

## Summary

**N-004**: pods skipped at the max-streams cap used to be retried only by the
next re-list (~4–5 min), silently, with only a one-off `limit_reached` notice.
They are now queued per session, retried as soon as a slot frees, and shown
persistently in the Watch UI.

## Design

New file `podwatch/pending.go` holds the queue logic and a diagram.

```
slot frees (stream ends / user stop /     kickPending()           watch loop
session stop / cap raised / DND off) ───► non-blocking send ───► select on
                                          on each session's      sess.slotFreed
                                          slotFreed (cap 1)      → retryPending
```

- `Session.pending map[string]time.Time`: pod → when it first hit the cap.
  Guarded by `Manager.mu`.
- `Session.slotFreed chan struct{}` (buffered, cap 1): bursts coalesce into
  one wakeup; `retryPending` then admits as many pods as there are free slots,
  oldest first, stopping at the first still-full check.
- **Retry runs on the session's watch-loop goroutine.** `startStream` may
  write `sess.baseline` (DND), which the watch loop reads lock-free, so all
  `startStream` calls stay on that one goroutine. `runWatchLoop` now selects on
  `slotFreed` and `w.ResultChan()` instead of ranging over the channel.
- **The cap is global**, so a freed slot kicks every session with pods
  waiting. `startStream` re-checks the cap under `Manager.mu`; losers stay
  queued silently.
- Kick sites: `runStream` terminal path, `startStream` open-file error path,
  `StreamAction` stop, session `Stop`, `SetMaxStreams`, `SetNoNewStreams`
  turned off. All are called without holding `Stream.mu` (lock order).
- Removal from the queue: on admission (`startStream`), a watch `Deleted`
  event (`dropPending`), or a re-list that no longer lists the pod
  (`prunePendingNotIn`). `relistAndCatchUp` now prunes, then retries queued
  pods before new ones.
- **DND change:** a pod queued before "No more streams" went on stays queued
  (not baselined) and is released when DND is turned off. Previously a re-list
  under DND would baseline it permanently. New pods under DND are still
  baselined.
- `limit_reached` fires once per pod (first skip). New SSE event
  `pending_changed` on drops; admissions already emit `stream_added` or
  `stream_state`, which make the UI refetch.

## API / UI

- `SessionStatus.pending []PendingPod{pod, since}` (oldest first);
  `StatusPayload.pendingPods` (total).
- `web/embeds/watch.js`: `pendingLine(s)` renders an amber "⏳ N pods waiting
  for a slot" line under each session header (pods and wait times in the
  tooltip; says "held" under DND). The stream count gets "· N waiting".
  `limit_reached` now also refetches status. Style `.watch-pending` in
  `watch.css` (light/dark).

## Tests

`podwatch/pending_test.go`: once-per-pod notice and status contents; which
events kick (empty queue doesn't; raised cap, user stop, coalescing); admission
when a slot frees; DND hold/release; drop/prune with `pending_changed`. Tests
point `logDir` at a regular file so admission fails into an error row instead
of spawning `runStream` (no kube client in tests). One test first failed
because the whole-list cap evicted q1's error row when admitting q2, which is
correct; the test counts admissions via events instead.

`go test ./...` and `go test -race ./podwatch/` pass. Not yet checked in
KRo.app (N-021).

Incidental: `gofmt` realigned the existing `Stream` struct fields in
`manager.go` (whitespace only).

## Next

Closed: N-004. Declined: None. Raised: N-021.
Deferred: None. Promoted: None. Moved: None.
Updated: N-005. Full list: `ai_docs/todo/next-list.md`.
