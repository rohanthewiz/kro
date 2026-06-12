# Pod Watch Stream Control Tweaks

**Date:** 2026-06-11 21:20 · **Session ID:** f8ed0038-4522-4b13-a14a-1e037e4d4235

## Summary

UI refinement pass on the Pod Watch page (Watch tab): brought the regular pod-log
modal's in-log search into the per-frame console views, restructured the toolbar
(Stop Watch promoted, redundant session line removed, Clear Streams moved right),
replaced the max-streams slider with a compact stepper, and added a close button
to the settings popover.

## Changes

### 1. Per-frame log search in Pod Watch consoles

- `web/embeds/resources.js`
  - Refactored `buildSearchRegex()` into a generic `buildLogSearchRegex(query,
    caseSensitive, wholeWord, isRegex)` (returns `null` for empty query, `false`
    for invalid regex); the modal's version now delegates to it.
  - Exported shared helpers as `window.kroLogSearch = { buildRegex, clearMarks,
    highlightIn, lineHidden }` — same pattern as the existing `kroLogFilter`
    export used by watch.js.
- `web/embeds/watch.js`
  - Added `SEARCH_SVG` magnifier icon; search toggle button placed **before**
    the copy icon in each frame head.
  - Each frame gets its own search bar (reuses the modal's `.modal-search-bar` /
    `.modal-search-opt` / `.modal-search-nav` / `.modal-search-count` classes,
    no IDs — class queries scoped to the frame element) with input, `Aa` / `W` /
    `.*` options, match count, ↑/↓ navigation, and close.
  - Per-frame search state lives on the frame object (`frame.search`). Functions:
    `wireFrameSearch`, `toggleFrameSearch`, `frameSearchRegex`,
    `refreshFrameSearchCount`, `runFrameSearch`, `navigateFrameMatch`.
  - Enter / Shift+Enter navigate matches; Esc closes the bar and
    `stopPropagation()`s so it doesn't also exit fullscreen.
  - Search respects the per-frame level filter (hidden lines get no marks);
    level-button toggles re-run the search via the third arg to `LF.wire`.
  - `flushFrame` highlights matches in newly streamed lines, then **recounts
    marks from the DOM** (rather than incrementing) since `trimFrame` may drop
    marked lines — keeps the count honest.
- `web/embeds/watch.css`
  - `.watch-frame-search` shares the copy-button styling (grouped selectors),
    plus `.on` active state; `.watch-frame .modal-search-bar` gets tighter
    padding; dark-mode rules added.

### 2. Toolbar restructure

- Removed the redundant per-session head line (`cluster / namespace` +
  Stop Watch) from the stream list — the info is already in the page title.
  The `stop-session` branch of `onListClick` and `.watch-session-head` CSS
  were removed too.
- **Stop Watch** button now sits directly after Start Watch in the controls
  row. It acts on the session matching the current ctx/ns selection: enabled
  exactly when Start Watch is disabled. To stop a watch on another namespace,
  switch the selectors to it first.
- Stop Watch styling: solid red `#7b241c` (same shade as the "Ftl" log-level
  filter button), hover `#922b21`, light + dark mode.
- Start Watch text flips to "▶ Watching…" while the current selection is
  watched (set in `renderStatus()`, so it tracks selector changes and SSE
  updates), back to "▶ Start Watch" when stopped.
- Final toolbar order: **Start Watch · Stop Watch · notice (flex spacer via
  `margin-left:auto`) · n/m streams count · stepper · Clear Streams** (far
  right).

### 3. Max-streams stepper (replaced the slider)

- Compact control: the cap number (bold) with small ▲/▼ buttons stacked
  vertically to its right (`.watch-stepper`, `.watch-stepper-val`,
  `.watch-stepper-btns`).
- Clicks step by 1, clamped to `[1, getSliderMax()]`, update the display
  instantly; the POST to `/api/watch/maxstreams` is **debounced 350ms**
  (`maxPostTimer`, `bumpMaxStreams(delta)`) so click bursts land as one update.
- `renderStatus` syncs the stepper from `lastStatus.maxStreams` only when no
  post is pending.
- Settings field renamed "Stream slider maximum" → "Max streams upper limit";
  lowering it clamps the stepper display and pushes a lowered cap to the
  server (as before).
- Old `.watch-slider*` CSS removed.

### 4. Settings popover close button

- `×` button pinned top-right of `.watch-settings-pop`
  (`#watch-settings-close`); removes the `active` class. Gray → red on hover,
  dark-mode variants.

## Files touched

- `web/embeds/watch.js` — toolbar markup/order, stop button + Watching… state,
  session-head removal, stepper logic, per-frame search, settings close.
- `web/embeds/watch.css` — stop button red, stepper, frame-search button/bar,
  settings close, removed session-head and slider rules.
- `web/embeds/resources.js` — generic regex builder + `window.kroLogSearch`
  export (modal behavior unchanged).

## Verification

- `node --check` on watch.js and resources.js after each change — clean.
- `go build ./...` — clean (embeds compile in).
- No server/Go code changes; all endpoints (`/api/watch/maxstreams`,
  `/api/watch/stop`, etc.) used as-is.

## Notes / possible follow-ups

- With the per-session head removed, sessions for non-selected namespaces have
  no inline stop control — switching the ctx/ns selectors is the way to stop
  them. If multi-session use grows, consider surfacing per-session context in
  rows or a session picker.
- Frame search state is client-local like the frames themselves: survives tab
  switches, resets on reload.
