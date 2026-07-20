# Session: Pod Watch — lock level filters in issue views + dropdown counts/bold

Session ID: bcfb2083-b352-4c4d-9bb6-57d934ce7ed1
Date: 2026-07-20 15:27

Two related Pod Watch tweaks on top of the prior session's errors/warnings
companion-files + per-frame view dropdown work. Both are all frontend +
(feature 2) a small backend counter; the `web/embeds/*` assets are `go:embed`ed
into the binary, so seeing either in KRo.app needs a rebuild + re-run of
`mac-install.sh`. (`mac-install.sh` does `git reset --hard origin/main` on
`~/.kro`, so commit + push before rebuilding or the edits are discarded.)

## Feature 1 — Lock the level filter buttons in Errors/Warnings views

**Committed + pushed** as `0e182fb`
("Lock Pod Watch level filter buttons in errors/warnings views").

Request: while a console frame is showing the Errors or Warnings file, disable
the other level filter buttons (Deb/Inf/Wrn/Err/Ftl); disable the warning and
error buttons too, keeping only the current one at full color. User confirmed
(screenshot) only **Err** stays lit in the Errors view.

Reason it makes sense: those views show a single-level companion file, so the
per-frame level filter can't meaningfully subset it.

- `web/embeds/watch.js` — new `applyFrameViewLock(frame)`, called from
  `setFrameView`. Toggles `view-locked` on the frame's `.log-lvl-btns`, sets
  `disabled` on all five buttons, and adds `view-current` to the one matching
  the view (`errors`→`err`, `warnings`→`wrn`). Also re-applies the level filter
  via `window.kroLogFilter.apply`: **locked → clear all `hide-*`** (show the
  whole companion), **all → re-apply the persisted hidden set**. This closes a
  trap: if `err` was hidden globally and you opened the Errors file, the frame
  would show nothing — and with the buttons now disabled you couldn't un-hide
  it. Locked views always show the whole file.
- `web/embeds/resources.css` — `.log-lvl-btns.view-locked .log-lvl-btn` greys
  out + `cursor:default`; `.view-current` keeps its bucket color (`#c0392b`
  err / `#b6701a` wrn) and white text. Dark-mode grey is scoped to
  `:not(.view-current)` so the current button's white text isn't beaten on
  specificity (`body.dark …` adds an element to the selector, which would
  otherwise outrank the `view-current` color rule).

## Feature 2 — Count + bold the Errors/Warnings dropdown items

**NOT yet committed at time of writing this doc** (the /sess-wrap commit+push
that follows will include it).

Request: in the per-frame view dropdown, when errors/warnings exist show the
item in bold with a line count, e.g. `Errors (3)`. Keep a running counter as
lines are written so the count serves fast; user floated storing it as
frontmatter at the top of the file.

### Decisions
- **In-memory counter, not file frontmatter.** An append-only log can't cheaply
  rewrite a top-of-file header per write, and the only streams that can show a
  dropdown are ones the manager already holds in memory — so an `atomic.Int64`
  per stream *is* the running counter: O(1) to serve, no file scan. After a
  process restart those streams aren't listed at all, so there's nothing to
  persist.
- **Counts lines, not distinct events.** Each counter increments per line
  routed to its companion, so it equals the companion file's line count and
  exactly what replays when you pick that view (a stack-trace continuation that
  inherits `err` is counted). If distinct-event counts are wanted later, it's a
  one-line change: increment only on a *primary* classification in
  `routeLocked` instead of per written line. (Told the user this.)
- **Bold caveat.** Native `<select>` option styling is unreliable, especially
  in the macOS webview, so the count text is the always-visible signal; bold is
  applied to options (best-effort) and to the collapsed control via
  `.sel-issues` when an issue view is selected (reliable).

### Backend (`podwatch/`)
- `manager.go` — `Stream` gains `ErrCount` / `WarnCount` (`atomic.Int64`).
  `StreamStatus` gains `ErrLines` / `WarnLines` (`json:"errLines"`/`"warnLines"`).
  `runCountsTicker` adds `errLines`/`warnLines` to each `stream_counts` entry.
- `stream.go` — `writeIssueLocked` does `st.ErrCount.Add(1)` /
  `st.WarnCount.Add(1)` right after the successful companion write (so a
  failed/unopened companion isn't counted). `status()` populates the two new
  fields.
- No web-layer change needed: `/api/watch/status` serializes `mgr.Status()`
  as-is, and `stream_counts` already flows through the SSE hub.

### Frontend (`web/embeds/`)
- `watch.js`
  - `streamStatusFor(ctx,ns,pod)` — find a pod's latest `StreamStatus` in the
    cached `lastStatus`.
  - `updateFrameViewCounts(frame, errCount, warnCount)` — rewrite the three
    option labels (`All`, `Errors [ (N) ]`, `Warnings [ (N) ]`), toggle
    `has-issues` + inline `font-weight`, and toggle `sel-issues` on the select
    for the current selection.
  - `syncFrameCounts()` — refresh every open frame from `lastStatus`; called at
    the end of `reconcileFrames` (so every status render updates dropdowns).
  - `openFrame` seeds the labels from `streamStatusFor` right after registering
    the frame; `patchCounts` updates any open frame live from the SSE tick.
- `watch.css` — `.watch-frame-view option.has-issues { font-weight:700 }` and
  `.watch-frame-view.sel-issues { font-weight:700 }`.

## Verification
- `go build ./...`, `go vet ./podwatch/ ./web/`, `go test ./...` all clean.
- Extended `TestErrorsWarningsCompanionAndView` to assert `ErrCount==5`,
  `WarnCount==1`, and `status()` `ErrLines/WarnLines == 5/1` (the 5 counts
  include the inherited stack-trace continuation line).
- `node --check web/embeds/watch.js` clean.
- Built the binary, ran on `KRO_PORT=8299`: the served page contains
  `updateFrameViewCounts` / `syncFrameCounts` / `streamStatusFor` / `has-issues`
  / `sel-issues`; `/api/watch/status` serves the expected shape. A full live
  drive needs a cluster producing error/warn logs, not set up here.
- Pre-existing `rangeint` lint hints on `podwatch_test.go:59/312/369` are
  unrelated to these edits (left alone).

## To take effect in KRo.app
Rebuild and re-run `mac-install.sh` (embeds are compiled into the binary).
