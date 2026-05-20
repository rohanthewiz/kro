# Session: ui-layout-improvement

**Date:** 2026-05-19 20:27
**Session ID:** c50017c2-2770-4335-a497-291ed478ce0c

## Goal

Split the single-tab "everything on one page" resource UI into a tabbed layout. Tabs render on the **left side, vertical**. The tab sidebar must be **collapsible** to a narrow icon strip. Section assignment is hardwired for now, but the structure should leave the door open for user-configurable tabs *and* user-configurable header cards per tab as a near-term follow-up.

## Tab composition (hardwired)

| Tab          | Sections                                            |
| ------------ | --------------------------------------------------- |
| Workloads    | Terminal, Jobs, All Pods (+ Pods orphan if any)     |
| Deployments  | Deployments & ReplicaSets, All Pods                 |
| Networking   | Services, Ingresses                                 |
| Sets         | StatefulSets, DaemonSets                            |
| Config       | ConfigMaps, Secrets                                 |

"All Pods" intentionally appears in two tabs. The collapse state is keyed by section slug, so toggling it in one tab toggles the mirror in the other.

## Design choices

- **Tab config is data-driven on both sides.** `pages.go` builds the sidebar + panel skeleton from a slice; `resources.js` keeps a parallel `TAB_CONFIG` array of `{id, sections: [...]}`. That's already the shape needed for the future "user picks which sections live on which tab in which order" feature — no rewrite required, just swap the literal config for a stored one.
- **Section builders are slug-keyed.** `SECTION_BUILDERS = { 'jobs': fn, 'all-pods': fn, ... }`. A tab is just a list of slugs that get rendered into its `#tab-sections-<id>` container. New section? Add a builder. Same pattern will accept future header-card builders.
- **Terminal lives statically in the Workloads panel DOM.** It's not in `SECTION_BUILDERS` because its DOM owns the SSE EventSource, per-(ctx, ns) block state, and resize handles that we don't want to teardown/recreate on every tree refresh. Hiding via `display:none` (i.e., switching tabs) is harmless — SSE continues to push, blocks keep accumulating, and they re-appear when the user returns.
- **"All Pods" duplicate handled in `toggleSection`.** Replaced `querySelector` with `querySelectorAll` and toggle every match. The localStorage flag is single-keyed by slug, so the next render keeps the two panels in sync.
- **Warnings render on the first tab only.** A cluster-level signal on every panel would be noise.
- **Collapsible sidebar: icon-only strip.**
  - Expanded (default): 180px, colored letter chip + label + subtitle.
  - Collapsed: 50px, just the chip. Subtitles + labels hidden via `display:none` on `.tab-btn-text`.
  - Each tab button has a `title` attribute carrying `"Label — sub"`, so the full context still surfaces on hover when collapsed.
  - Chevron rotates 180° in the toggle button.
  - State persists in `localStorage` under `kro_tab_sidebar_collapsed`.
- **Sub-900px fallback** ignores the collapsed state and lays the tabs out as a wrapping horizontal row, with the toggle button hidden.

## Files changed

- `web/pages.go` — replaced the single `terminalSection + resources-content` div with `tabLayout(b)`. New helper renders the sidebar (collapse toggle + 5 tab buttons with icon/label/sub spans) and 5 `.tab-panel` containers (`#tab-panel-<id>`, `#tab-sections-<id>`). Terminal is nested inside the Workloads panel.
- `web/embeds/resources.js`:
  - `TAB_CONFIG`, `SECTION_BUILDERS`, `buildAllPods(tree)` helper.
  - `switchTab(id)` + `initTabs()` + `kro_active_tab` persistence.
  - `toggleTabSidebar()` + `initTabSidebarCollapsed()` + `kro_tab_sidebar_collapsed` persistence.
  - Refactored `rebuildTables(tree)`: loops `TAB_CONFIG`, runs each section's builder into the right container.
  - `refreshResources()` shows the loading state on all 5 panels and `renderErrorAcrossTabs()` writes errors to all of them.
  - `toggleSection` now `querySelectorAll`s.
- `web/embeds/resources.css` — `.tab-layout`, sticky `.tab-sidebar` (transitions on `flex-basis` + `padding`), `.tab-collapse-toggle` with rotating chevron, two-line `.tab-btn` (icon chip + text), `.tab-sidebar.collapsed` rules that hide `.tab-btn-text` and shrink the bar, dark-mode overrides for every new selector, sub-900px wrap fallback.

## Build verification

`go build ./...` + `go vet ./...` both clean.

## Followups (not done)

- The "configurable per-tab" feature was explicitly deferred. The TAB_CONFIG + SECTION_BUILDERS shape is the seam for that work.
- The summary cards bar at the top is shared across all tabs. Eventually we'll want per-tab cards; today they're global.
- Could add keyboard shortcuts for tab switching (e.g., `1`–`5` or `Ctrl+Tab`) if needed.
