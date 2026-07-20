# Session: Pod Watch — whole-list stream cap (default 15) + approximate entry counts

Session ID: 1418d1ef-a497-4032-8fab-5c735103e5bc
Date: 2026-07-20 15:53

Two Pod Watch changes from a bug report ("I don't think the stream limits are
being honored" — screenshot showed `0 / 10 streams` in the header but ~16 rows
in the list). Both touch backend logic plus the `go:embed`ed `web/embeds/*`
assets, so seeing them in KRo.app needs a rebuild + re-run of `mac-install.sh`.
(`mac-install.sh` does `git reset --hard origin/main` on `~/.kro`, so commit +
push before rebuilding or the edits are discarded.)

## Diagnosis first

The limit was **not** broken — it was a semantics mismatch. `defaultMaxStreams`
only capped *concurrently active* (`starting|running|paused`) streams:

- Header `0 / 10 streams` = `activeStreams / maxStreams` (`watch.js` renderStatus).
- Gate in `startStream` blocked a new stream only when
  `activeStreamCountLocked() >= maxStreamsNow()`; `activeStreamCountLocked`
  counts active only (`manager.go`).
- **Ended** streams (completed/stopped/error) stop counting but stay in the
  list forever — nothing auto-evicts them (`ClearTerminal` is manual-only;
  `Cleanup` in `cleanup.go` only touches on-disk files, never the in-memory
  map). So short-lived pods piled up 16 rows while active stayed at 0.

So the cap held (never >10 active at once), but "10 streams" read like a
list-length cap. User chose to make it actually cap the whole list.

## Feature 1 — Whole-list stream cap, default 15

**Committed + pushed** (see commit below).

Requested behavior: `max` now bounds the **total** list (active + ended). When
the list is full and a new pod arrives, evict the **oldest ended** stream to
admit it (rolling window of most-recent streams); active streams are never
evicted, so a list full of actives blocks the new pod (existing `limit_reached`
path, unchanged). Default bumped 10 → 15.

- `podwatch/manager.go`
  - `defaultMaxStreams` 10 → **15** (comment rewritten to describe the
    whole-list + oldest-ended-eviction semantics). `absMaxStreams` still 100.
  - `StatusPayload` gains `TotalStreams int` (`json:"totalStreams"`); `Status()`
    computes it via new `totalStreamCountLocked()`.
  - New `totalStreamCountLocked()` (sum of `len(sess.streams)` across sessions)
    and `evictOldestTerminalLocked(n int)` — collects terminal streams across
    all sessions, sorts by `StartedAt` ascending, deletes up to `n` oldest;
    active streams untouched; files kept. Reads `st.StartedAt` without `st.mu`
    (immutable after creation); reads `st.state` under `st.mu`. Lock order
    honored: caller holds `m.mu`, then `st.mu` per stream.
  - `SetMaxStreams` doc updated: lowering doesn't retroactively evict; the new
    cap takes hold on the next admission (each admission trims back within cap).
- `podwatch/stream.go` — `startStream` gate: keep the `active >= maxN` block
  (proven necessary: if active is already at max there's nothing evictable that
  helps), then `if over := totalStreamCountLocked() + 1 - maxN; over > 0 {
  evictOldestTerminalLocked(over) }`. Eviction + insertion are atomic under the
  same `m.mu` hold, so `Status()` never sees an over-cap list. The subsequent
  `stream_added` notify triggers the client's full refetch, which reflects the
  eviction and closes any evicted stream's frame via `reconcileFrames`.
- `web/embeds/watch.js`
  - Header now shows `totalStreams / maxStreams` (matches visible row count —
    fixes the reported mismatch). Active count moved into the count element's
    `title` tooltip.
  - Stepper tooltips reworded from "Max concurrent streams" to "Max streams
    kept in the list (active + ended)".
- `web/watch_handlers.go` — `WatchSetMax` doc comment updated (concurrent →
  whole-list).
- `podwatch/podwatch_test.go` — new `TestEvictOldestTerminalForCap`: mix of 3
  ended (varying age) + 2 active; `evictOldestTerminalLocked(2)` drops the two
  oldest ended, keeps newest-ended + both actives; a follow-up call asking for
  5 removes only the 1 remaining ended and leaves the 2 actives.
  `TestActiveStreamCountAndCap` unchanged and still passes (fills actives to
  cap → `limit_reached`, no admit).

Memory note (why the cap can never over-run): the new stream is always
`StateStarting` (active) when inserted, so `active <= total <= max` is an
invariant; blocking iff `active >= max` is exactly the condition under which no
eviction can make room.

## Feature 2 — Errors/Warnings counts as approximate *entries*, not lines

**Committed + pushed** (same commit). User: "maybe we should count log entries
instead of lines and label the numbers as approximate like (errors ~3)".

Scoped to the errors/warnings counts shown in each console frame's view
dropdown (the `(errors ~3)` example). The per-row main "N lines" was left as a
literal line count on purpose (honest; the main log isn't entry-grouped) —
flagged to the user for a possible follow-up.

Entry = a line carrying an explicit level token; inherited continuation lines
(stack traces, wrapped messages) belong to the entry above them and are written
to the companion file but **not** re-counted. So a 10-line stack trace counts
as 1.

- `podwatch/stream.go`
  - `routeLocked` now returns `(route string, entryStart bool)` — `true` only
    for explicit `err`/`wrn` classifications, `false` for `oth` and inherited
    continuations.
  - `emitLocked` threads `entryStart` into `writeIssueLocked`.
  - `writeIssueLocked(route, line, entryStart)` — always writes the line to the
    companion (multi-line entries stay intact), but only `ErrCount.Add(1)` /
    `WarnCount.Add(1)` when `entryStart`.
  - `status()` fills renamed fields `ErrEntries` / `WarnEntries`.
- `podwatch/manager.go`
  - `Stream.ErrCount` / `WarnCount` comments: now "approx. error/warning
    entries" instead of "== companion line count".
  - `StreamStatus`: `ErrLines`/`WarnLines` (`json:"errLines"`/`"warnLines"`)
    renamed to `ErrEntries`/`WarnEntries` (`json:"errEntries"`/`"warnEntries"`).
  - `runCountsTicker` payload keys renamed `errLines`/`warnLines` →
    `errEntries`/`warnEntries`.
- `web/embeds/watch.js` — all three `updateFrameViewCounts` call sites read
  `errEntries`/`warnEntries`; dropdown option label now `Errors (~3)` /
  `Warnings (~2)` (was `(3)`); comment updated to explain the `~`.
- `podwatch/podwatch_test.go` — the companion-file counting test: same input
  (`boom 1`, continuation `at stack.frame`, `boom 2..4`, one `warn`) now
  asserts **4** error *entries* (was 5 lines) while the companion file still
  holds **5** lines; warnings stay 1. Field refs updated to
  `ErrEntries`/`WarnEntries`.

## Verification

`go build ./...`, `go vet ./podwatch/ ./web/`, `go test ./...` all green. The
only lint noise (`podwatch_test.go` lines 59/363/420 "range over int") is
pre-existing, unrelated to these edits.

## Follow-ups / open

- Per-row main "N lines" left as literal lines — user may want it as approx
  entries too (offered).
- KRo.app won't show the JS changes until `mac-install.sh` rebuild (commit +
  push done first so the hard-reset doesn't drop them).
