# Optimize Terminal Output Batching

**Date:** 2026-05-19 18:32
**Session ID:** d3f8f4e8-f4b8-4d99-a533-8598dcd336da

## Problem reported

> In the Terminal `kubectl log` commands are hanging up the entire page. The logs work but it seems the logging code is taking all the focus and Chrome says the page is unresponsive.

The kubectl-style terminal panel (the one rendered by `terminalSection` in `web/pages.go`, not the per-pod Logs modal) becomes unresponsive when streaming logs from a noisy pod. Output appears, but the page locks up while it does.

## Investigation

Traced the SSE path:

- **Server**: `web/sse.go` `TermSSE` → `produceTermStream` → `kube/term.go` `RunKubectl`. Pipes stdout/stderr from `kubectl --context=... --namespace=... <args>` and forwards every line as an SSE event (`stdout` / `stderr` / `done`). No batching, no throttling — one SSE frame per line.
- **Client**: `web/embeds/resources.js` `termRun` opens an `EventSource('/sse/term?cmd=...')` and registers `stdout` / `stderr` / `done` listeners. Each `stdout`/`stderr` handler called `termAppendOutput(block, kind, e.data)`.

The hot path in the old `termAppendOutput` did, **synchronously per line**:

1. Read `out.scrollHeight`, `out.scrollTop`, `out.clientHeight` to detect "user is pinned to the bottom" — forces a layout.
2. Build a `<span>`, run `highlightLogLine(line)` (a regex pass with alternations for levels, dates, numbers, booleans), assign `innerHTML`, `appendChild` to the block's `<pre>`.
3. If a per-block search controller existed, call `ctl.onAppend(span)` to incrementally highlight matches.
4. Call `termTrimToLimit()`, which does `termBlocks.querySelectorAll('.term-block-out > span')` across **every block ever run in the current namespace**, then trims to `TERM_MAX_OUTPUT_LINES = 5000`. With many blocks accumulated, this is O(N) every line.
5. Write `out.scrollTop = out.scrollHeight` — forces another layout.

When a noisy pod fires hundreds of log lines per frame, that's hundreds of layout/queryAll cycles per frame on the main thread. Chrome's unresponsive-page heuristic trips.

`appendLogLine` in the pod-logs modal has a similar shape (synchronous per-line layout read + DOM insert + scroll write + per-line `refreshSearchCountLabel` if search is active). Initially left it alone since the user explicitly said "Terminal," but a follow-up message confirmed the modal locks up too — addressed in the second pass below.

## Fix

Coalesce all SSE events arriving in a frame into one DOM update via `requestAnimationFrame`.

### `web/embeds/resources.js`

1. **Added per-block render queue** to the object returned by `termAppendBlock` (around line 1702):
   - `outBuf: []` — flat array of alternating `kind`, `line` pairs (cheaper than allocating `{kind, line}` objects in a hot path).
   - `flushScheduled: false` — guard against scheduling multiple rAFs.

2. **Rewrote `termAppendOutput`** (around line 1912). It now just pushes onto the buffer and schedules `flushTermBlockOutput` via `requestAnimationFrame` if one isn't already pending.

3. **Added `flushTermBlockOutput`**: clears `flushScheduled`, snapshots the buffer, then in a single pass:
   - One `scrollHeight/scrollTop/clientHeight` read for the at-bottom check.
   - Builds a `DocumentFragment`, creates a span per line (with `stderr` / `info` classes as before), appends the whole fragment with one `out.appendChild(frag)`.
   - Walks the new spans once to call `ctl.onAppend(span)` for active search highlighting (preserves the existing incremental-highlight behavior).
   - One `termTrimToLimit()` call.
   - One `scrollTop = scrollHeight` write if previously at bottom.

4. **Drain on completion** — added `flushTermBlockOutput(block)` calls in:
   - The `termSource.addEventListener('done', ...)` handler in `termRun` — so the "exit 0/N" pill never flips before the last buffered lines render.
   - `window.termCancel` — same reason for the "canceled" pill.

### Second pass: pod-logs modal (`appendLogLine`)

User followed up saying the Logs modal hangs too. Applied the same rAF-coalescing pattern, structured a bit differently because the modal has a single global stream (one `logSource` at a time) rather than per-block state:

1. **Module-level queue** alongside `logSource` / `logSourcePod` (around line 588):
   - `logLineBuf = []` — pending lines.
   - `logFlushScheduled = false` — rAF guard.
   - `logContentEl = null` — captured at enqueue time so the flush knows where to append.

2. **Rewrote `appendLogLine`**: now just captures `content`, pushes the line, schedules `flushLogLines` via `requestAnimationFrame` if not already pending.

3. **Added `flushLogLines`**: single layout read for the at-bottom check, single `DocumentFragment` build, single `content.appendChild(frag)`, then if search is active, walks the new spans once and accumulates `searchState.matchCount` with **one** `refreshSearchCountLabel` call for the whole batch (previously fired per line). Single `scrollTop = scrollHeight` write at the end.

4. **Drop buffer on `closeLogStream`**: cleared `logLineBuf` and nulled `logContentEl`. `closeLogStream` runs both when the modal closes (via `closeModal`) and when the user switches pods (via `startLogStream` calling `closeLogStream` first), so stale lines from pod A can never land in pod B's modal. A pending rAF that fires after close will see `logContentEl === null` and bail.

UX side effect: the search-count label now updates ~60×/sec during a burst instead of once per arriving line, which is actually nicer — the previous behavior caused the count to thrash visibly under high log volume.

## Why it works

The trim work didn't go away, but it now runs at most once per animation frame (~60 Hz) regardless of incoming line rate. A burst of 500 lines that previously paid 500 × (layout + queryAll across all blocks + scroll) now pays 1 × (layout + 1 fragment append + queryAll + scroll). Layout reads/writes are no longer interleaved, so the browser doesn't have to flush layout between every line.

Highlighting cost (the regex in `highlightLogLine`) is unchanged — it's the same work, just batched into one task before the next paint, which keeps the main thread from being blocked long enough to trip Chrome's unresponsive-page warning.

## Verified

- `go build ./...` — clean.
- Did not test live; flagged to user that the JS is `//go:embed`-ed into the binary so the server must be restarted for the change to take effect.

## Files touched

- `web/embeds/resources.js` — five edits total:
  - `termAppendBlock` (added `outBuf` / `flushScheduled` to the returned block object).
  - `termAppendOutput` / new `flushTermBlockOutput` (rAF-batched terminal append).
  - `done` handler in `termRun` and `window.termCancel` (drain before flipping pills).
  - `appendLogLine` / new `flushLogLines` plus module-level `logLineBuf` / `logFlushScheduled` / `logContentEl` (rAF-batched modal append).
  - `closeLogStream` (drop pending buffer + content ref on close/pod-switch).

Both `go build ./...` runs after the terminal and modal passes were clean.

## Not done (deliberately)

- Did not change server-side coalescing in `produceTermStream` or `LogsSSE`. The client-side rAF batching is enough; server-side batching would add first-line latency for no real gain.
- Did not change `highlightLogLine`. Its regex isn't a backtracking hazard on typical log lines.
- Did not unify the two batching implementations behind a shared helper. They look similar but have different lifecycle assumptions (per-block state vs single global stream, different drain triggers) — premature abstraction risk outweighed the dedup win for ~40 LOC.