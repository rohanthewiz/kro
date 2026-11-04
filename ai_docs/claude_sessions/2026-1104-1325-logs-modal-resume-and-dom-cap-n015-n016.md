# Session: Logs modal resumes reconnects without repeats, and caps its DOM (N-016, N-015)

Session ID: `07b671b3-25fa-4626-aad0-9c5b619d2dd5`

## Summary

The user asked for as many next-list items as could be done without their
input, with a sess-wrap every couple of items. This is the first wrap and
covers two Open items about the plain Logs modal (`/sse/logs`).

- **N-016**: a reconnect (pill click, or EventSource's own retry) used to
  re-send the pod's 500-line tail into the same capture file and the same
  view, behind a "lines below may repeat" marker. It now resumes right after
  the last captured line, per container, using the API server's line
  timestamps.
- **N-015**: the modal's DOM had no line cap. It now trims to 20,000 lines,
  in batches, with a note at the top pointing to ⤓ for the full capture.

## Changes

- `kube/logs_stream.go`
  - `LogLine.TS`: the API timestamp of the line (from `Timestamps=true`).
    Zero for lines without one (kro markers, previous-instance logs).
    `copyTimestampedStream` stamps each line with its own timestamp only. An
    unstamped line does not inherit the previous line's.
  - `StreamOpts.ResumeAfter map[string]time.Time`, keyed by the
    `LogLine.Container` tag (`""` for single-container pods). A named
    container's first follow starts at `SinceTime = ts` truncated to 1s,
    with `lastTS = ts` as the `skipThrough` cutoff. This is the same
    mechanism the in-stream auto-reconnect already used, now seeded from
    outside. It overrides `TailLines`/`SinceTime` only for the containers
    it names.
  - `streamTailLines` → exported `StreamTailLines` so `/sse/logs` can build
    its own `StreamOpts` with the same tail.
- `podwatch/livecapture.go`
  - `LiveCapture.lastTS`: a per-container high-water mark.
  - `WriteStamped(tag, ts, line) bool` records the mark and drops a stamped
    line at or before it. That covers the old and new producers overlapping
    during a manual reconnect. `WriteLine` stays and delegates with a zero
    ts.
  - `ResumeAfter()` returns a copy of the marks (nil when empty).
  - Re-`Acquire` with marks writes "kro: log stream reconnected; resuming
    after the last captured line". Without marks (nothing stamped yet) it
    keeps the old "lines below may repeat" marker, because that path still
    re-sends the tail.
  - The package comment explains the resume and de-dup design and why clock
    skew doesn't apply: the cutoffs are API timestamps, never local time.
- `web/sse.go` — `produceLogStream` calls `StreamPodLogsOpts` with
  `ResumeAfter: capture.ResumeAfter()` and writes through `WriteStamped`.
  Lines the capture drops as repeats are still broadcast to the browser. The
  browser closed its old EventSource before opening the new one, so it may
  not have received them.
- `web/embeds/resources.js`
  - `trimModalLog(content, body, atBottom)` runs from `flushLogLines` after
    each batch is appended. `LOG_MODAL_MAX_LINES = 20000` and
    `LOG_MODAL_TRIM_SLACK = 1000`: nothing happens until the view is 1,000
    lines over the cap, then it drops back to exactly the cap. That way the
    cost (span removal plus a scrollHeight read) is paid about once per
    1,000 lines instead of every frame.
  - The trim note is one `.log-meta.log-trim-note` span kept as the first
    child. It counts trimmed lines in `data-trimmed`. `runSearch` skips it,
    since its text is rewritten via `textContent`.
  - Search bookkeeping: distinct `data-mi` groups in the removed lines come
    off `matchCount`. If the current match was removed, `currentIndex`
    resets to 0. Otherwise it shifts down by the number removed.
  - A reader scrolled up gets a scrollTop correction equal to the removed
    height. Trimming is deferred while a text selection is active in the
    view, in line with `2026-0710-1847-preserve-log-selection-while-streaming`.
- Tests:
  - `TestLiveCaptureResumeAfterAndDedup`: per-container marks, copy
    semantics, overlap de-dup, resume marker.
  - `TestLiveCaptureResumeWithoutStampsWarnsOfRepeats`.
  - `TestCopyTimestampedStreamStampsEachLine`.
  - `TestCopyTimestampedStreamSkipsReplayedLines` now also asserts `TS` is
    set.

## Verification

- `go build ./...`, `go vet ./kube ./podwatch ./web`, and `go test ./...`
  all pass.
- `node --check web/embeds/resources.js` passes.
- `trimModalLog` was exercised in a throwaway jsdom harness in the
  scratchpad (not committed), with the cap lowered to 10 and the slack to 3.
  It checked: no trim at cap + slack, deferral while a selection is active,
  trim back to the cap with the note first, `data-trimmed` accumulating
  across trims, a single note, and the search count and index adjusting.
- Not run in KRo.app. Those checks are N-023 and N-024.

## Design notes

- The resume point lives server-side, on the capture, rather than in the
  browser. The browser only ever sees stripped lines, and the capture is
  already keyed by the ID that EventSource's auto-reconnect and the pill
  both reuse. So both kinds of reconnect resume with no client change.
- Without a capture (Acquire failed) there's no resume. The follow falls
  back to the tail as before.
- Lines with identical nanosecond timestamps at a resume boundary would be
  dropped. That's the same trade-off `skipThrough` already makes in-stream.

## Next

Closed: N-015, N-016. Declined: None. Raised: N-023, N-024.
Deferred: None. Promoted: None. Moved: None.
Updated: N-014 (`StreamTailLines` rename), N-017 (new marker text).
Full list: `ai_docs/todo/next-list.md`.
