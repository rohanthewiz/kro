# Next list

The single living list of follow-ups for kro. Sessions edit this file in place
(`/sess-save`) instead of copying a Next section forward from the previous
session doc, so an item can only leave the list as a visible edit in git
history. Seeded 2026-11-03 by `/next-list seed` from the last 15 session docs
(`2026-0710-1847-preserve-log-selection-while-streaming` →
`2026-1016-1505-live-log-capture-and-streamed-download`).

## Conventions

- **IDs** (`N-001`…) are permanent and never reused, even after an item closes.
- **raised** is the session-doc stem (in `ai_docs/claude_sessions/`) where the
  item first appeared. A re-raise names the earlier doc in the item text.
- **Age** is computed, never stored: the number of session docs written since
  `raised` (an item raised in the newest doc has age 0).
- **Value** is the payoff of doing it, not the effort:
  - `high`: something is being worked around today, or a second independent
    consumer has arrived
  - `medium`: it blocks one named thing, or it is a visible defect nobody has
    to route around yet
  - `low`: a gap nobody has bumped into, or contingent on something that does
    not exist yet
- **Sections**:
  - **Open**: the next build work (code to write, a defect to fix, a decision
    to make).
  - **Validate**: the next testing. What remains is only a check (run, look,
    measure, or write or repair a test); no product change is planned unless
    the check finds a defect.
  - **Roadmap**: wanted, but later. Parked, not declined.
  - **Non-goals**: likely never, kept so it stays visibly declined.
  - **Closed**: done, merged, or overtaken, newest first.
- Nothing leaves Open, Validate or Roadmap without a line in another section.
- Open, Validate and Roadmap each stay in ID order.

**Next ID:** N-021

## Open

- **N-004** · raised `2026-0715-1327-podwatch-watch-timeout-and-sse-dot-flex` · value low
  At the max-streams cap (`podwatch/stream.go`, `startStream`) a new pod is
  skipped and only a transient `limit_reached` SSE notice is sent.
  *Corrected premise:* the original note said "never retried", but
  `relistAndCatchUp` (`podwatch/watch_loop.go`) calls `startStream` for every
  non-baseline pod, so a skipped pod is picked up at the next re-list (about
  every 4–5 min) if a slot has freed. What remains: the retry is incidental and
  silent, and there is no persistent "N pods waiting for a slot" indicator.

- **N-006** · raised `2026-0720-1434-podwatch-errors-warnings-files-and-view-dropdown` · value low
  Pod Watch export/download (`WatchExport`) always serves the full main log,
  whatever the per-frame view dropdown shows (Errors/Warnings). Copy already
  copies the on-screen view. Related to the deliberate trade-off in
  `2026-0610-1325-log-view-level-filtering` (export includes filter-hidden
  lines), but that was the level filter, not the view dropdown.

- **N-007** · raised `2026-0720-1553-podwatch-whole-list-cap-and-approx-entry-counts` · value low
  The per-row main "N lines" count in Pod Watch (`watch.js`, `st.lines + '
  lines'`) is still literal lines, while Errors/Warnings counts are now
  approximate entries. The user may want it as approx entries too (offered,
  not requested).

- **N-008** · raised `2026-0818-1749-favorite-cluster-namespace-combos` · value low
  Favorite chips can only be reordered by dragging (`favorites.js`); there is
  no keyboard path to reorder.

- **N-009** · raised `2026-0818-1749-favorite-cluster-namespace-combos` · value low
  The quick-switcher palette lists only pinned/known namespaces; it never asks
  a cluster for its full namespace list (no `Namespaces().List` call anywhere).
  Ad-hoc `ctx/ns` typing covers the gap. *Re-raise:* first written down in
  `2026-0428-2031-kro-build` as a "Browse all namespaces" one-off picker for
  clusters where the user has list permission.

- **N-010** · raised `2026-0826-1817-all-pods-filter-and-orphan-reconcile` · value low
  The `kro_collapsed_pods-orphan` localStorage key is inert now that no tab
  mounts `pods-orphan` (the section builder remains in `resources.js` for
  re-mounting). A cleanup pass could drop the key. Harmless; candidate for
  Non-goals.

- **N-011** · raised `2026-0826-1817-all-pods-filter-and-orphan-reconcile` · value low
  Keyboard shortcut to focus the pods filter box (`/` is the obvious one). Not
  requested.

- **N-013** · raised `2026-1016-1505-live-log-capture-and-streamed-download` · value medium
  Tag an rweb release containing the streaming API (rweb's own list item
  N-027, not this file's) and move kro off the master pseudo-version
  (`go.mod`: `github.com/rohanthewiz/rweb v0.2.1-0.20261012041515-9781e96fa99a`).

- **N-014** · raised `2026-1016-1505-live-log-capture-and-streamed-download` · value low
  Optional: seed the Logs-modal capture with the pod's full available history
  when it opens. Today it starts from the 500-line tail (`streamTailLines`,
  `kube/logs_stream.go`).

- **N-015** · raised `2026-1016-1505-live-log-capture-and-streamed-download` · value low
  Optional: cap the Logs modal's DOM line count for very long sessions, now
  that the capture file holds everything. Confirmed: the modal's
  `flushLogLines` path has no trim (only the terminal has
  `TERM_MAX_OUTPUT_LINES`). Not requested.

- **N-016** · raised `2026-1016-1505-live-log-capture-and-streamed-download` · value medium
  On a manual reconnect (pill click), the Logs modal re-sends the 500-line tail
  into the same capture, behind a "lines below may repeat" marker
  (`podwatch/livecapture.go`). Resume with `SinceTime` instead. Prior art: the
  in-stream auto-reconnect in `kube/logs_stream.go` already uses `SinceTime`
  plus timestamp-based de-dup (`skipThrough`), and Pod Watch resume
  (`podwatch/manager.go`, `"resume"`) uses `LastLineAt`. The clock-skew care
  noted originally applies if the resume point is the local receive time; it
  does not apply if it is the API server's line timestamp, as `skipThrough`
  uses.

## Validate

Items whose remaining work is purely testing: run, look, measure, or write or
repair a test. No product change is planned unless the check finds a defect.

- **N-002** · raised `2026-0713-1446-default-to-last-selected-cluster-namespace` · value low
  Drive the running server end to end against a live kubeconfig to confirm
  startup defaults to the last selected cluster/namespace. Only unit tests
  cover it (`kube/selector_test.go`). No later doc records the check, but
  months of daily use since then likely cover it. Candidate to close.

- **N-012** · raised `2026-0826-1817-all-pods-filter-and-orphan-reconcile` · value medium
  Rebuild via `mac-install.sh` and eyeball the All Pods and Deployments tabs
  (filter box, orphan reconciliation, Deployments-scoped pods) against a real
  cluster in KRo.app.

- **N-017** · raised `2026-1016-1505-live-log-capture-and-streamed-download` · value medium
  Rebuild via `mac-install.sh`. In KRo.app, open Logs on a chatty pod and
  confirm: ⤓ enables, the download lands in ~/Downloads with all lines, and a
  reconnect (pill click) appends to the same file with the marker.

- **N-018** · raised `2026-1016-1505-live-log-capture-and-streamed-download` · value medium
  Confirm Pod Watch export (`/api/watch/export`) still downloads correctly in
  KRo.app after `sendLogDownload` switched it to streaming.

- **N-020** · raised `2026-1103-1900-next-list-seed-n001-n003` · value low
  Follow-up check for N-003: in KRo.app, make `/api/namespaces` fail (e.g.
  point kro at a kubeconfig with no usable context) and confirm the Watch
  picker shows "— failed to load namespaces —" with the cause in its tooltip,
  the notice line shows the cause, and Start repeats it.

## Roadmap

Wanted but deferred. Not "next"; promote to Open when its time comes.

- **N-005** · raised `2026-0715-1327-podwatch-watch-timeout-and-sse-dot-flex` · value low
  Pod Watch watches now re-establish and re-`List` the namespace every ~4–5
  min. If List load ever matters: on a *clean* close, re-`Watch` from the
  current `rv` (bookmarks keep it fresh, `AllowWatchBookmarks` is already set
  in `podwatch/watch_loop.go`) instead of a full re-list; re-list only after
  an error or a watchdog-forced stop. Deferred by that session as negligible
  at this tool's scale. Note: N-004's incidental retry relies on the re-list,
  so doing this would need an explicit retry for cap-skipped pods.

## Non-goals

- **N-019** · declined `2026-0818-1749-favorite-cluster-namespace-combos` — Per-browser favorites. Favorites are global to the kro instance, matching how pinned namespaces work.

## Closed

- **N-003** · raised `2026-0715-1327-podwatch-watch-timeout-and-sse-dot-flex` · closed 2026-11-03, `2026-1103-1900-next-list-seed-n001-n003`
  `loadWatchNamespaces()` now rejects on non-2xx/network/non-JSON (shared
  `jsonOrThrow`), shows a disabled "failed to load" picker entry with the
  cause as tooltip plus a notice, and Start repeats the cause. Confirmed the
  server's failure shape (503 `{"error":"no kubeconfig context available"}`),
  which previously rendered as "— no namespaces —". UI check is N-020.

- **N-001** · raised `2026-0713-1446-default-to-last-selected-cluster-namespace` · closed 2026-11-03, `2026-1103-1900-next-list-seed-n001-n003`
  `(*Store).Add` membership loop replaced with `slices.Contains`;
  `go test ./state/` passes.

Closures before this file existed live in the session docs under
`ai_docs/claude_sessions/`.
