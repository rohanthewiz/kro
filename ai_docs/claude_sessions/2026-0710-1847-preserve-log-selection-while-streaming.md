# Preserve log text selection while streaming (copy a line from a busy log)

**Date:** 2026-07-10 18:47 &nbsp;|&nbsp; **Session ID:** b92064c2-ccfd-43a4-984d-af1d4cb311ee

## Problem

Copying a line from a streaming log was nearly impossible: you'd drag-select a
line and the highlight would "quickly disappear" before you could copy it.

## Root cause

All three streaming panes — the pod **log modal**, **Pod Watch console
frames**, and the **terminal** — flush incoming lines once per animation frame
(rAF-batched append), and each flush did two things that destroy a selection on
a busy stream:

1. **Autoscroll** — when the pane is pinned to the bottom, every flush sets
   `scrollTop = scrollHeight`. Mid-drag, the content scrolls under the cursor
   so the selection endpoint jumps; after mouseup, the selected line races out
   of view.
2. **Trimming** — once a pane hits its line cap (2,000 lines per watch frame
   via `getWatchBufLines`, 5,000 in the terminal via `TERM_MAX_OUTPUT_LINES`),
   each flush removes the oldest `<span>` line elements from the front. The
   moment a selected node is removed from the DOM, the browser collapses the
   selection entirely — the literal "selection disappears" symptom.

Flush sites: `web/embeds/resources.js` `flushLogLines` (modal) and
`flushTermBlockOutput` (terminal), `web/embeds/watch.js` `flushFrame` /
`trimFrame` (watch frames).

## Fix

Standard log-viewer behavior: **while the user has an active (non-collapsed)
selection anchored inside a pane, that pane holds off autoscroll and
trimming**; both resume as soon as the selection is cleared. New lines still
arrive and render the whole time.

- `web/embeds/resources.js` — new shared helper `selectionActiveIn(el)`
  (checks `window.getSelection()` is non-collapsed and its `anchorNode` is
  inside `el`), exported as `window.kroSelActive` alongside `kroHighlight` /
  `kroLogSearch`. Guards added:
  - `flushLogLines` (log modal): skip autoscroll when a selection is active in
    `#modal-content` (the modal has no trim).
  - `flushTermBlockOutput` (terminal): skip `termTrimToLimit()` **and**
    autoscroll while a selection is active anywhere in `#term-blocks`
    (trim is global across blocks, so the guard is conservative).
- `web/embeds/watch.js` — `flushFrame`: compute
  `holdForSelection = window.kroSelActive && window.kroSelActive(body)` per
  flush; skip `trimFrame(frame)` and the at-bottom autoscroll while held.
  Guarded with `&&` since the helper lives in resources.js (which always loads
  first — both are embedded by `web/pages.go` in order: resources.js then
  watch.js, same page).

## Behavior notes / trade-offs

- Selecting text implicitly pauses "follow" — after clearing the selection the
  pane does not jump back to tailing (the at-bottom check no longer passes);
  scroll to the bottom to re-engage follow, same as after scrolling up
  manually.
- Trim is deferred (not skipped forever): a long-held selection lets the pane
  grow past its cap; the next flush after the selection clears trims back to
  the limit.
- Search-highlighting of newly arrived lines only rewrites the *new* spans'
  innerHTML, so it never touches selected existing lines — no guard needed.

## Verification

`node --check` on both JS files and `go build ./...` (embedded assets) pass.
Manual check: open a busy pod's logs, drag-select a line — the pane stops
following while the selection is live, copy works, click to resume.
