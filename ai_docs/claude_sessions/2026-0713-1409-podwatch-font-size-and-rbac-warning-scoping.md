# Session: Pod Watch log font size + RBAC warning scoping

- Session ID: `7696df54-877b-4b96-96f3-df55fd82a513`
- Date: 2026-07-13 14:09
- Branch: `main`

## Summary

Two independent UI fixes to the kro web frontend (both in `go:embed`-ed static assets):

1. Added font size increase/decrease (`A−` / `A+`) controls to **Pod Watch** log frames,
   matching the feature that already exists on the standard pod-log modal. Transparency /
   opacity control was intentionally **not** included (per user request).
2. Fixed **RBAC "Could not list …" warnings** leaking onto the Pods view. Storage-scoped
   warnings (PersistentVolumes, StorageClasses) were showing on the Pods panel; now each
   warning is routed to the tab that owns that resource kind.

## Change 1 — Pod Watch log font size controls

Committed as `731fd96` "Add font size inc/dec controls to Pod Watch log frames".

### Reference implementations already in the codebase
- Standard log modal: `web/embeds/resources.js` — `MODAL_FONT_KEY = 'kro_modal_font_px'`,
  `getModalFontSize` / `applyModalFontSize` / `window.adjustModalFont` (~line 1703-1724).
  Buttons in the modal header markup (~line 1511-1512).
- Terminal blocks (multi-block, persisted globally): `web/embeds/resources.js` ~line 2203-2220,
  `TERM_FONT_KEY = 'kro_term_block_font_px'`. This was the closer analogue since Pod Watch
  can have multiple open frames sharing one size.

### Files changed
- `web/embeds/watch.js`
  - Added two buttons to the frame head markup (in `openFrame`), between the search and
    copy buttons:
    ```js
    '<button type="button" class="watch-frame-font" data-act="font-down" title="Decrease font size">A−</button>' +
    '<button type="button" class="watch-frame-font" data-act="font-up" title="Increase font size">A+</button>' +
    ```
  - New "Frame font size" section (after `copyFrame`): persisted globally under
    `kro_watch_frame_font_px`, range 9–22px, default **11.5px** (matches the existing
    `.watch-frame-body` CSS `font-size`). Uses `parseFloat` (not `parseInt`) to preserve the
    `.5`. `adjustWatchFrameFont(delta)` updates every open frame via
    `document.querySelectorAll('#watch-frames .watch-frame-body')`.
  - In `openFrame`, after `wireFrameSearch(frame)`: `applyWatchFrameFont(frame.body)` +
    wired both buttons via their `data-act` selectors.
- `web/embeds/watch.css`
  - Added `.watch-frame-font` to the shared `.watch-frame-copy, .watch-frame-search` button
    rule (plus `font-weight: 600` and `:hover` color), for both light and dark mode
    (`body.dark .watch-frame-font`).

### Behavior
Size is shared across all open frames and remembered across sessions — same model as the
modal and terminal blocks. Adjusting on one frame updates every frame and any newly teed one.

## Change 2 — Scope RBAC warnings to their owning tab

Not yet committed at time of writing this doc (will be committed with the session wrap).

### Root cause
`web/embeds/resources.js` `rebuildTables()` built one `warningsHTML` string from
`tree.warnings` and injected it only at the top of the **first** tab (workloads / Pods).
So storage warnings ("Could not list PersistentVolumes / StorageClasses") appeared on the
Pods view even though those resources live on the Storage tab.

Backend (`kube/resources.go` `ListResources`) emits a single flat `Warnings []string`, one
entry per resource kind whose `List` call fails (RBAC), messages of the form
`"Could not list <Kind> — check RBAC permissions"`. Left the backend unchanged.

### Fix (frontend only, `web/embeds/resources.js`)
- Added `WARNING_TAB_BY_KIND` mapping each kind → tab id, aligned with `TAB_CONFIG`:
  - `Jobs`, `Pods` → `workloads`
  - `Deployments`, `ReplicaSets` → `deployments`
  - `StatefulSets`, `DaemonSets` → `sets`
  - `Services`, `Ingresses` → `networking`
  - `ConfigMaps`, `Secrets` → `config`
  - `PersistentVolumes`, `PersistentVolumeClaims`, `StorageClasses` → `storage`
- `warningTabId(w)` extracts the kind via `/Could not list (\w+)/`; unknown kinds fall back
  to `TAB_CONFIG[0].id` so nothing is silently dropped.
- `warningsBarHTML(list)` factored out the bar markup.
- `rebuildTables()` now groups warnings into `warningsByTab` and prepends each tab's own
  warnings to that tab's panel.

Result: storage RBAC warnings show only on the Storage tab; Pods view stays clean unless a
workload kind (Jobs/Pods) actually fails to list.

## Notes / gotchas
- All touched files are `go:embed`-ed static assets → require a server rebuild/restart and a
  browser hard-refresh to take effect. `go build ./...` passes after each change.
- Minus glyph used in buttons is U+2212 (`−`), matching the existing modal buttons — not an
  ASCII hyphen.

## Verification
- `go build ./...` — clean after both changes.
- Not exercised in a live cluster this session (asset-only UI changes).
