# Session: move-pod-watch-from-dialog-to-pg

**Date:** 2026-06-10 19:59 · **Session ID:** 228b65a2-afad-420c-80f0-90bb79736e65

## Goal

Promote Pod Watch from a modal dialog to its own page (tab), restructure the
left side menu, and reduce the container's side margins:

1. Left menu: change W (Workloads) → W (Watch) as the first item.
2. Pod Watch becomes the content of the new Watch tab (no longer a dialog).
3. The old Workloads page shifts down, relabeled P (Pods).
4. Reduce the container's left/right margins.

## What Was Done

Committed as `b51b58f` on `main` — 7 files, +102/−111.

### Menu & panels — `web/pages.go`

- New tabs order: `watch` (W, "Pod log capture"), `workloads` (P, "Pods"),
  deployments (D), networking (N), sets (S), config (C).
- The workloads tab **kept its internal id** (`workloads`) so localStorage
  keys, section routing, and JS `TAB_CONFIG` are untouched — only the label
  ("Pods") and icon ("P") changed.
- New panel `#tab-panel-watch` containing an empty `<div id="watch-page"
  class="watch-page">`; watch.js builds the UI into it on first activation.
- Server-side default-active is now keyed by `t.id == "workloads"` instead of
  index 0 (Pods remains the default tab; JS may switch to the last-used tab
  from localStorage right after load).

### Dialog → page — `web/embeds/watch.js`

- `buildModal()` → `buildWatchPage()`: renders the same UI (head row with
  title/sub/SSE dot/gear, settings popover, controls, stream list, tee
  frames + placeholder) into `#watch-page` instead of a `document.body`
  overlay. Tracked by a `pageBuilt` flag.
- **Removed**: modal overlay, `attachDrag()` (drag/clamp logic), close
  button, Escape-to-close, `openWatchModal`/`closeWatchModal`.
- **Added**: `window.watchPageActivate()` / `window.watchPageDeactivate()`,
  called from `switchTab()` in resources.js.
  - Activate: build page if needed, refresh title sub from ctx/ns selects,
    seed buffer input, `fetchWatchStatus()`, `connectStatusSSE()`.
  - Deactivate: close settings popover, disconnect status SSE only.
- Behavior change: **tee frames persist across tab switches** (their
  `/sse/watch-logs` EventSources stay open); previously modal close tore
  them down. They still reset on page reload. Background capture remains
  server-owned either way.

### Tab plumbing — `web/embeds/resources.js`

- `TAB_CONFIG` gained `{ id: 'watch', sections: [] }` appended **last** —
  `TAB_CONFIG[0]` is both the default tab and the warnings-bar target, so
  workloads must stay first. Loops over `tab-sections-<id>` already guard
  against the missing `tab-sections-watch` anchor.
- `switchTab(id)`: after toggling buttons/panels, calls
  `watchPageActivate()` when `id === 'watch'`, else `watchPageDeactivate()`.
- No load race: `initTabs()` runs on DOMContentLoaded, after both
  resources.js and watch.js (synchronous scripts) have executed.

### Styles — `web/embeds/watch.css`

- Replaced `#watch-overlay.modal-overlay` / `.modal-dialog.watch-dialog` /
  drag-cursor rules with:
  - `.watch-page`: relative (anchors the settings popover), flex column,
    `height: calc(100vh - 250px)`, `min-height: 420px`, translucent white
    bg, `border-top: 1.5px solid #0984e3`, radius 12px, overflow hidden.
  - `.watch-page-head` / `.watch-page-title`: replaces the modal header
    (mono 0.95rem bold title, bottom border).
- Dark-mode additions for `.watch-page`, `.watch-page-head`,
  `.watch-page-title`.

### Header & margins

- `web/header_component.go`: the ◉ Watch header button was removed —
  the Watch tab is the single entry point.
- `web/embeds/resources.css`: `body` padding `20px` → `20px 8px`;
  `.container` max-width `1720px` → `1920px`.

### README

- Pod Watch described as "the Watch tab"; "modal" → "page"; tab list
  updated to Watch, Pods, Deployments, Networking, Sets, Config.

## Verification

- `go build ./...` passes; `node --check` passes on watch.js and
  resources.js.
- Live smoke test on `:8199` (`KRO_PORT=8199 go run .`): rendered HTML shows
  tab order W/P/D/N/S/C with labels Watch/Pods/…, `tab-panel-watch` +
  `id="watch-page"` present, served CSS contains `max-width: 1920px` and
  `padding: 20px 8px`, and `watchPageActivate` appears in the served JS.
  Server stopped after the check.

## Key Decisions / Gotchas

- Kept `workloads` as the internal tab id to avoid breaking persisted
  `kro_active_tab` and section routing — display-only rename to "Pods".
- `TAB_CONFIG[0]` doubles as default-tab and warnings target; the watch
  entry must NOT be first there even though it's first in the sidebar.
- Tee frames intentionally survive tab switches now (page semantics);
  status SSE is the only thing torn down on deactivate.
- Not pushed — commit `b51b58f` is local on `main`.
