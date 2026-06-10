# Session: log-view-level-filtering

**Date:** 2026-06-10 13:25 · **Session ID:** 93c902fe-2fc8-4d6d-819a-f9c6423db9f2

## Goal

Add log-level filtering (Deb / Inf / Wrn / Err / Ftl) to the common log viewer —
both the Logs modal and the Pod Watch console frames — with minimal performance
impact. Each level individually togglable via a small colored button.

## Design (the key insight)

The shared colorizer `highlightLogLine()` in `web/embeds/resources.js` (exported
as `window.kroHighlight`, used by both viewers) already regex-matches level
tokens to colorize them. So:

1. **Classify once at render time, for free.** While colorizing, record the
   first level token found as a bucket (`deb|inf|wrn|err|ftl`) in
   `highlightLogLine.lastLevel`. Both flush paths stamp `class="lvl-<bucket>"`
   on the line's existing per-line `<span>` — one string assignment per line.
2. **Filter with pure CSS.** A toggle flips one `hide-<level>` class on the
   scroll container; `.hide-err .lvl-err { display: none }` does the rest.
   No re-render, no per-line JS on toggle, hidden lines stay in the DOM so
   retention/trim/copy semantics are unchanged and toggling back is instant.

Server-side filtering was considered and rejected: it complicates ring-buffer
replay and per-subscriber tee fan-out, and the bottleneck is DOM work, not SSE
bytes.

## Changes

### `web/embeds/resources.js` (+~170 lines)

- `LEVEL_BUCKETS` map: full words, logrus 4-char console truncations
  (`DEBU/ERRO/FATA/TRAC/PANI`), 3-char short forms (`Deb/Inf/Wrn/Err/Ftl`),
  plus `dbg/trc`. Trace→deb, panic→ftl. `LEVEL_CANON` maps buckets back to the
  existing `.log-level-*` CSS color suffixes.
- `highlightLogLine()`: bare-token alternation widened (longer tokens before
  prefixes, e.g. `ERROR|ERRO|ERR|Err`); sets `highlightLogLine.lastLevel` as a
  side effect (null when no level recognized).
- `flushLogLines()`: tags spans `lvl-<bucket>`; unleveled lines inherit
  `modalLastLvl` (keeps stack traces with their error); reset per stream in
  `startLogStream()`.
- Meta lines: `appendLogLine(content, line, isMeta)` uses the `\u0000` prefix
  (same trick as watch.js) → `class="log-meta"`, never colorized, never
  filtered. The "— disconnected, retrying —" notice now uses this (also fixes
  a latent issue where it could have inherited a hidden level).
- **Shared filter helper `window.kroLogFilter`** = `{ getHidden, buttonsHTML,
  apply, wire }`. Hidden set persisted as JSON array in localStorage key
  `kro_log_lvl_hidden`; seeds every new viewer, toggles act per-view only.
  `wireLevelButtons` uses event delegation so innerHTML refreshes are safe.
- Modal header: `<span class="log-lvl-btns" id="modal-lvl-btns">` added before
  the search toggle; shown only for stream modals; wired once at overlay
  creation, repopulated from persisted state on each `openModal`.
- Search integration: `runSearch()` now iterates `content.children` and skips
  lines hidden by the filter (`lineSpanHidden()` — pure string check, no layout
  read); the per-batch search in `flushLogLines` does the same; level toggle
  re-runs an active search. Match count and prev/next stay honest.

### `web/embeds/watch.js` (+~20 lines)

- Frame head gets `<span class="log-lvl-btns">` between status and copy button;
  populated/wired via `window.kroLogFilter` at `openFrame` (resources.js loads
  first on the single page — confirmed in `web/pages.go`).
- `flushFrame()`: same `lvl-<bucket>` tagging with per-frame `frame.lastLvl`
  inheritance.

### `web/embeds/resources.css` (+~50 lines)

- Hide rules: `.hide-deb .lvl-deb, … .hide-ftl .lvl-ftl { display: none }`.
- `.log-meta` (italic gray, never filtered).
- `.log-lvl-btn` styles: filled colored background when on (deb #636e72,
  inf #0a7ea4, wrn #b6701a, err #c0392b, ftl #7b241c), dimmed outline when
  `.off`; dark-mode off-state color variants.

### `README.md`

- Feature bullet describing the level filter in both viewers.

## Verification

- Node harness (extracted `highlightLogLine` + deps from the IIFE via marker
  slicing): 15 classification cases pass — logrus structured (`level=info`),
  truncated (`ERRO[0042]`), short tokens (`Wrn`, `Ftl`), bare words, PANIC,
  no-level → null, unknown `level=verbose` → null; plus color-class and
  `log-msg-err` spot checks.
- `node --check` on both JS files; `go build ./...` clean.
- Smoke test: ran server on a test port, curled `/`, confirmed buttons, hide
  rules, `kroLogFilter`, and `modal-lvl-btns` are in the served page.

## Gotchas / notes for future sessions

- A literal NUL byte briefly landed in resources.js via the Edit tool when
  writing `'\u0000'`; fixed with perl to the escaped form. Watch for this when
  editing strings containing `\u0000`.
- Behavior notes (accepted tradeoffs):
  - A level word mid-message ("retrying after ERROR") classifies the line as
    that level — same tradeoff the colorizer always had; first token wins.
  - `TRACE` now colors with the debug gray (#636e72) instead of
    `.log-level-trace` (#8395a7) since classes canonicalize through buckets.
  - Copy/export still includes filter-hidden lines (filter is a view; the
    buffer/file is the record).
  - Hidden lines still count toward the frame's retention trim.
- `resources.js` is one big IIFE; function declarations hoist, so helpers
  defined late in the file are callable from `flushLogLines` earlier in it.
