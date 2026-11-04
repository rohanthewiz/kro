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

**Next ID:** N-028

## Open

- **N-007** · raised `2026-0720-1553-podwatch-whole-list-cap-and-approx-entry-counts` · value low
  The per-row main "N lines" count in Pod Watch (`watch.js`, `st.lines + '
  lines'`) is still literal lines, while Errors/Warnings counts are now
  approximate entries. The user may want it as approx entries too (offered,
  not requested).

- **N-013** · raised `2026-1016-1505-live-log-capture-and-streamed-download` · value medium
  Tag an rweb release containing the streaming API (rweb's own list item
  N-027, not this file's) and move kro off the master pseudo-version
  (`go.mod`: `github.com/rohanthewiz/rweb v0.2.1-0.20261012041515-9781e96fa99a`).

- **N-014** · raised `2026-1016-1505-live-log-capture-and-streamed-download` · value low
  Optional: seed the Logs-modal capture with the pod's full available history
  when it opens. Today it starts from the 500-line tail (`StreamTailLines`,
  `kube/logs_stream.go`). *Update 2026-11-04:* left for a decision. The file
  has to hold history before the tail, so the simple design (a non-follow
  `GetLogs` into the file first, then the follow with `ResumeAfter` = its
  last timestamp) delays the view's first line until the whole history is
  downloaded. A chatty long-lived pod can also have GBs of history, so it
  needs a size cap or an opt-in (a "fetch full history" action in the
  modal).

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
  reconnect (pill click) appends to the same file with the marker. (Since
  N-016 the marker reads "resuming after the last captured line"; N-023
  covers the no-repeat part.)

- **N-018** · raised `2026-1016-1505-live-log-capture-and-streamed-download` · value medium
  Confirm Pod Watch export (`/api/watch/export`) still downloads correctly in
  KRo.app after `sendLogDownload` switched it to streaming.

- **N-020** · raised `2026-1103-1900-next-list-seed-n001-n003` · value low
  Follow-up check for N-003: in KRo.app, make `/api/namespaces` fail (e.g.
  point kro at a kubeconfig with no usable context) and confirm the Watch
  picker shows "— failed to load namespaces —" with the cause in its tooltip,
  the notice line shows the cause, and Start repeats it.

- **N-021** · raised `2026-1103-1914-podwatch-cap-pending-queue-n004` · value low
  Follow-up check for N-004: rebuild via `mac-install.sh`; in KRo.app set the
  max-streams stepper to 1, start a watch, and create two pods. Confirm the
  second shows "⏳ 1 pod waiting for a slot" under the session header and
  "· 1 waiting" in the stream count, with the pod in the tooltip, and that it
  starts on its own when the first stream is stopped (■) or the max is raised.

- **N-022** · raised `2026-1103-1952-podwatch-export-follows-view-n006` · value low
  Follow-up check for N-006: rebuild via `mac-install.sh`; in KRo.app open a
  Pod Watch console frame on a pod logging errors, switch it to Errors, and
  confirm the row's ⤓ tooltip says "the errors file" and the download is
  `<pod>-<ts>.errors.log`. On a pod with no warnings, Warnings + ⤓ should show
  the "nothing to export" notice instead of a failed download.

- **N-023** · raised `2026-1104-1325-logs-modal-resume-and-dom-cap-n015-n016` · value medium
  Follow-up check for N-016: rebuild via `mac-install.sh`; in KRo.app open
  Logs on a chatty pod, wait a bit, click the status pill to reconnect, and
  confirm the view continues without re-showing the last 500 lines and the
  downloaded capture has no repeated block after the "resuming after the last
  captured line" marker. Try a multi-container pod too (per-container resume
  points).

- **N-024** · raised `2026-1104-1325-logs-modal-resume-and-dom-cap-n015-n016` · value low
  Follow-up check for N-015: in KRo.app leave Logs open on a pod that logs
  past 21,000 lines (or temporarily lower `LOG_MODAL_MAX_LINES` in
  `resources.js`). Confirm the "N earlier lines trimmed" note appears at the
  top, the view stays smooth, a reader scrolled up does not jump, search
  counts stay right across a trim, and ⤓ still downloads every line.

- **N-025** · raised `2026-1104-1328-keyboard-fav-reorder-and-pod-filter-slash-n008-n011` · value low
  Follow-up check for N-008: rebuild via `mac-install.sh`; in KRo.app Tab
  into the favorites chip bar and confirm the focus ring shows, ←/→ move
  focus, ⌥←/⌥→ move the chip (and the order survives a reload), Enter/Space
  switch, F2 opens the rename prompt, and the × appears on the focused chip.

- **N-026** · raised `2026-1104-1328-keyboard-fav-reorder-and-pod-filter-slash-n008-n011` · value low
  Follow-up check for N-011: in KRo.app press `/` on the Workloads and
  Deployments tabs and confirm it focuses that tab's pod filter (selecting
  any old query), does nothing on the Pod Watch page or with the section
  collapsed, and still types a `/` in the terminal and the quick switcher.

- **N-027** · raised `2026-1104-1332-palette-browse-namespaces-n009-n010` · value low
  Follow-up check for N-009: in KRo.app open the quick switcher (⌘K) and
  confirm the last row reads "Browse all namespaces in <current cluster>",
  that typing `othercluster/` retargets it, that choosing it lists the
  cluster's namespaces as "not pinned" rows (switching to one pins it), and
  that a cluster where you can't list namespaces shows the "not permitted"
  row instead.

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
  *Update 2026-11-03:* N-004 added that explicit retry (`podwatch/pending.go`,
  woken via `slotFreed`), so that dependency is gone. The re-list still prunes
  queued pods deleted while the watch was down; a re-Watch without re-list
  would rely on the Deleted event alone for that.

## Non-goals

- **N-019** · declined `2026-0818-1749-favorite-cluster-namespace-combos` — Per-browser favorites. Favorites are global to the kro instance, matching how pinned namespaces work.

## Closed

- **N-010** · raised `2026-0826-1817-all-pods-filter-and-orphan-reconcile` · closed 2026-11-04, `2026-1104-1332-palette-browse-namespaces-n009-n010`
  `resources.js` now drops `kro_collapsed_<slug>` once per page load for each
  slug in `RETIRED_SECTION_SLUGS` (`['pods-orphan']`) that no `TAB_CONFIG`
  tab mounts, so re-mounting the section keeps its flag again. It is an
  explicit list rather than "anything not in TAB_CONFIG", because
  `terminal` (rendered by `pages.go`) shares the prefix.

- **N-009** · raised `2026-0818-1749-favorite-cluster-namespace-combos` · closed 2026-11-04, `2026-1104-1332-palette-browse-namespaces-n009-n010`
  The quick switcher's last row is now "Browse all namespaces in <ctx>",
  where ctx is the context the query's `ctx/` part names, or else the
  current one. Choosing it calls the new `GET /api/targets/namespaces?context=`
  (`ClusterNamespaces` → `kube.ListNamespaceNames`, 8s timeout, 403 via
  `ErrNamespaceListForbidden`) and merges the names in as rank-3 "not pinned"
  rows, cached per context for 5 minutes. `/api/targets` and the palette
  open still make no cluster calls. Tests: `TestListNamespaceNamesSorted`,
  `TestListNamespaceNamesForbidden`. The palette flow was checked with a
  jsdom harness (not committed). UI check is N-027.

- **N-011** · raised `2026-0826-1817-all-pods-filter-and-orphan-reconcile` · closed 2026-11-04, `2026-1104-1328-keyboard-fav-reorder-and-pod-filter-slash-n008-n011`
  A bare `/` outside any text field, with no modal open, focuses (and
  selects) the first visible `.pod-filter-input`, i.e. the one in the tab on
  screen and not in a collapsed section (`resources.js`). The placeholder
  now hints `( / )`. Checked with a jsdom harness (not committed). UI check
  is N-026.

- **N-008** · raised `2026-0818-1749-favorite-cluster-namespace-combos` · closed 2026-11-04, `2026-1104-1328-keyboard-fav-reorder-and-pod-filter-slash-n008-n011`
  Favorite chips are now focusable (`tabindex="0"`, `role="button"`) with
  `onChipsKeydown` in `favorites.js`: ←/→ move focus, Alt/⌥+←/→ move the chip
  one slot through `moveFavorite` (local repaint, then `persistOrder`, the
  same path as a drop), Enter/Space switch, F2 renames. `renderChips` keeps
  focus on the same favorite across re-renders, tracked by ctx/ns identity
  rather than index, so a run of moves isn't interrupted by the server's
  reply. Focus ring via `:focus-visible`; the × shows on `:focus-within`.
  Checked with a jsdom harness (not committed). UI check is N-025.

- **N-016** · raised `2026-1016-1505-live-log-capture-and-streamed-download` · closed 2026-11-04, `2026-1104-1325-logs-modal-resume-and-dom-cap-n015-n016`
  A Logs-modal reconnect (pill click or EventSource's own retry) now resumes
  right after the last captured line instead of re-sending the 500-line tail.
  `kube.LogLine` carries the API server's line timestamp (`TS`);
  `LiveCapture.WriteStamped` records it per container tag, `ResumeAfter()`
  hands the marks back, and `kube.StreamOpts.ResumeAfter` starts each
  container's follow at `SinceTime` + `skipThrough` (the same mechanism as
  the in-stream auto-reconnect). Lines at or before a mark are also dropped
  at write time, covering the old and new producers overlapping during a
  reconnect. API timestamps throughout, so clock skew does not apply. A
  capture with nothing stamped yet still falls back to the tail and the
  "may repeat" marker. Tests: `TestLiveCaptureResumeAfterAndDedup`,
  `TestLiveCaptureResumeWithoutStampsWarnsOfRepeats`,
  `TestCopyTimestampedStreamStampsEachLine`. UI check is N-023.

- **N-015** · raised `2026-1016-1505-live-log-capture-and-streamed-download` · closed 2026-11-04, `2026-1104-1325-logs-modal-resume-and-dom-cap-n015-n016`
  The Logs modal caps its DOM at `LOG_MODAL_MAX_LINES` (20,000) via
  `trimModalLog` in `resources.js`, trimming in batches of
  `LOG_MODAL_TRIM_SLACK` (1,000) so the cost isn't paid every frame. A
  `.log-trim-note` line at the top counts trimmed lines and points to ⤓.
  Search counts and the current match are adjusted, a reader scrolled up
  keeps their place, and trimming waits while text is selected. Checked with
  a jsdom harness (not committed). UI check is N-024.

- **N-006** · raised `2026-0720-1434-podwatch-errors-warnings-files-and-view-dropdown` · closed 2026-11-03, `2026-1103-1952-podwatch-export-follows-view-n006`
  Pod Watch export now follows the pod's console-frame view dropdown:
  `/api/watch/export` takes `?view=all|errors|warnings` and
  `Manager.ExportPath(ctx, ns, pod, view)` serves the matching companion file
  (flushed first). An empty bucket (companion never created) is the new
  `ErrNoIssueFile` → 404; the UI checks first and shows a notice instead.
  No frame open, or the All view, is still the full main log. The level
  filter stays out of export, as decided in
  `2026-0610-1325-log-view-level-filtering`. Test: `TestExportPathView`. UI
  check is N-022.

- **N-004** · raised `2026-0715-1327-podwatch-watch-timeout-and-sse-dot-flex` · closed 2026-11-03, `2026-1103-1914-podwatch-cap-pending-queue-n004`
  Pods skipped at the stream cap are now queued per session
  (`Session.pending`, `podwatch/pending.go`) and retried oldest-first as soon
  as a slot frees: a stream ending, a user stop, a session stop, a raised
  cap, or DND turned off. The retry runs on the session's watch loop via a
  coalescing `slotFreed` channel. `limit_reached` fires once per pod; status
  carries `pending` per session and `pendingPods` overall, shown as a
  persistent "⏳ N pods waiting for a slot" line plus "· N waiting" in the
  count. Queued pods leave on Deleted events or when a re-list no longer
  lists them. DND holds queued pods instead of baselining them. Unit tests in
  `podwatch/pending_test.go`. UI check is N-021.

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
