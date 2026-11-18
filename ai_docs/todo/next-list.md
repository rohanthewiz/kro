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

**Next ID:** N-047

## Open

Items N-028 to N-042 came out of the 2026-11-18 reliability / performance /
usability review (`2026-1118-1509-reliability-performance-usability-review`). N-028 to
N-036 and N-042 were done in that session and are under Closed; their in-app
checks are N-043 to N-046 under Validate.

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

- **N-037** · raised `2026-1118-1509-reliability-performance-usability-review` · value medium · performance
  Every snapshot lists all 13 kinds whatever tab is showing, including full
  Secret and ConfigMap objects (data included) just to count keys. Let the
  stream take the active tab and list only what that tab and the summary
  cards need: Jobs, Deployments, ReplicaSets, StatefulSets, DaemonSets, Pods
  and Services always; Ingresses, ConfigMaps, Secrets, PVs, PVCs and
  StorageClasses only for their own tab. The tree then needs to say which
  kinds it carries, so the page does not render "No secrets found" for a
  kind that was not asked for.

- **N-038** · raised `2026-1118-1509-reliability-performance-usability-review` · value medium · security · decision
  Change the default bind address from all interfaces to 127.0.0.1 (N-031
  adds `KRO_HOST` but keeps today's default). It would break anyone opening
  kro from another machine until they set `KRO_HOST=0.0.0.0`, and the
  Dockerfile would need that set. Recommended, but it is the owner's call.

- **N-039** · raised `2026-1118-1509-reliability-performance-usability-review` · value low · usability
  The kubeconfig is read once at startup (and after a merge upload). A
  context added from a shell (`aws eks update-kubeconfig`, `kind create
  cluster`) does not appear until kro restarts. Re-read when a kubeconfig
  file's mtime changes, checked on `/api/contexts`.

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
  *Update 2026-11-18:* the rename prompt could not appear in KRo.app when
  this was raised: the wrapper had no `WKUIDelegate`, so `prompt()` returned
  null (N-032). Run this after the rebuild N-044 asks for.

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

- **N-043** · raised `2026-1118-1509-reliability-performance-usability-review` · value high
  Follow-up check for N-028 / N-029 / N-030 / N-035: rebuild via
  `mac-install.sh`. In KRo.app against a real cluster confirm: a pod created
  or deleted from a shell shows up within ~10s without touching Refresh; an
  expanded Deployment (and a ReplicaSet inside it) stays expanded across
  updates; typing in the pod filter is not interrupted; selecting a pod name
  and copying it works, and the tables catch up once the selection is
  cleared. Hide the app for a minute and confirm the dot goes grey
  ("Paused…" tooltip) and returns to green with fresh data when shown. All of
  this passed in headless WebKit and Chromium against a fake API; what is
  untested is WKWebView itself, in particular whether it reports
  `document.hidden` when the window is merely covered.

- **N-044** · raised `2026-1118-1509-reliability-performance-usability-review` · value high
  Follow-up check for N-032: after the same rebuild, in KRo.app confirm
  Delete on a pod now asks and then deletes; the − (remove namespace) button
  asks and unpins; double-click / F2 on a favorite chip shows a text prompt
  and renames; ＋ Kube Config opens a file picker (hidden folders visible)
  and then asks before merging; a failing action (e.g. delete something you
  may not delete) shows its error. The Swift was typechecked with `swiftc`
  but never run. This also covers N-025's "F2 opens the rename prompt".

- **N-045** · raised `2026-1118-1509-reliability-performance-usability-review` · value medium
  Follow-up check for N-031: after the rebuild, confirm KRo.app loads and
  works (its requests are same-origin to 127.0.0.1), that
  `~/Library/Logs/KRo/kro.log` shows "listening on 127.0.0.1:8222" and no
  "refused" lines during normal use, and that downloads (⤓) still work. If
  kro is ever opened from another machine or by a DNS name, expect
  `host not allowed` until `KRO_ALLOWED_HOSTS` (and `KRO_HOST`) are set.

- **N-046** · raised `2026-1118-1509-reliability-performance-usability-review` · value medium
  Follow-up check for N-029: with the VPN down (or pointing at a stopped
  kind cluster), switch to that cluster and confirm the page shows one
  "cluster unavailable: …" message within ~15s rather than minutes of
  "Loading" followed by 13 RBAC warnings; with tables already on screen,
  confirm they stay under the red banner and it clears when the cluster is
  back. On a namespace where you lack cluster-scoped rights, confirm the
  Storage tab still shows "check RBAC permissions" for PersistentVolumes /
  StorageClasses.

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

- **N-040** · raised `2026-1118-1509-reliability-performance-usability-review` · value low · usability
  Replace the native `alert()` / `confirm()` / `prompt()` calls with in-page
  dialogs and a toast line for errors. N-032 makes the native ones work in
  KRo.app; this is about them blocking the page and looking foreign.

- **N-041** · raised `2026-1118-1509-reliability-performance-usability-review` · value low · performance
  One snapshot producer per (context, namespace) shared by every connected
  tab, instead of one per connection. Only matters with several windows on
  the same namespace.

## Non-goals

- **N-019** · declined `2026-0818-1749-favorite-cluster-namespace-combos` — Per-browser favorites. Favorites are global to the kro instance, matching how pinned namespaces work.

## Closed

- **N-042** · raised `2026-1118-1509-reliability-performance-usability-review` · closed 2026-11-18, `2026-1118-1509-reliability-performance-usability-review`
  Switching cluster with the Cluster dropdown left the NS dropdown blank and
  listed the *previous* cluster's namespace name in the new cluster.
  `/api/select` only writes the `kro_ns` cookie for a non-empty namespace, so
  the old one survived the switch and won the resolution. `onContextChange`
  (`resources.js`) now goes through `kroSwitchTarget(ctx, '')`, the same
  one-request path as a favorite chip (`/api/favorites/go`: last namespace
  used there, else first pinned, else the kubeconfig default). Reproduced on
  the previous commit and confirmed fixed in headless WebKit (it needs the
  cookie to be set, i.e. any earlier namespace pick or favorite jump).

- **N-036** · raised `2026-1118-1509-reliability-performance-usability-review` · closed 2026-11-18, `2026-1118-1509-reliability-performance-usability-review`
  `Manager.Shutdown()` (`podwatch/manager.go`) cancels every session and
  finalizes its streams with a "stopped (kro shut down)" marker, and
  `LiveCaptures.flushAll` flushes open Logs-modal captures. `main` calls it
  after `srv.Run()` returns (rweb returns on SIGINT/SIGTERM, which is what
  KRo.app sends on quit). Test: `TestShutdownFlushesEverything`.

- **N-035** · raised `2026-1118-1509-reliability-performance-usability-review` · closed 2026-11-18, `2026-1118-1509-reliability-performance-usability-review`
  `resources.js` closes the resources stream 20s after `visibilitychange` →
  hidden (dot goes grey, class `paused`) and reopens it when visible; the
  server's producer ends with the connection. Other streams are untouched.
  Checked in headless WebKit/Chromium with a simulated hidden state (no pod
  lists for 12s while hidden). Real-window check is N-043.

- **N-034** · raised `2026-1118-1509-reliability-performance-usability-review` · closed 2026-11-18, `2026-1118-1509-reliability-performance-usability-review`
  Clientsets are built with QPS 50 / burst 100 (`kube/registry.go`).
  `Describe`, `PodLogs` and `Delete` take a context; handlers give them
  `kube.RequestTimeout` (20s), tied to the request for the two reads and
  deliberately not for delete. Their failures now answer with the API's own
  status (404, 403…), 504 on a deadline, 502 otherwise (`clusterErrStatus`),
  where they used to answer 404 or 500 for everything.

- **N-033** · raised `2026-1118-1509-reliability-performance-usability-review` · closed 2026-11-18, `2026-1118-1509-reliability-performance-usability-review`
  `termSource.onerror` now closes the EventSource while a command is running
  (cancelling the process server-side), appends "connection to kro lost; the
  command was not re-run", and marks the block "connection lost". It used to
  leave EventSource to reconnect, which re-executed the command. Not
  exercised by a test: read-through only.

- **N-032** · raised `2026-1118-1509-reliability-performance-usability-review` · closed 2026-11-18, `2026-1118-1509-reliability-performance-usability-review`
  The wrapper in `mac-install.sh` is now a `WKUIDelegate`: `alert`,
  `confirm` and `prompt` are `NSAlert` sheets on the main window, and
  `<input type="file">` opens an `NSOpenPanel` (hidden files shown, for
  `~/.kube`). The rendered Swift typechecks (`swiftc -typecheck`); it has not
  been run. Takes effect on the next `mac-install.sh` run, which builds from
  `origin/main`, so this must be pushed first. App check is N-044.

- **N-031** · raised `2026-1118-1509-reliability-performance-usability-review` · closed 2026-11-18, `2026-1118-1509-reliability-performance-usability-review`
  `web/guard.go`: a middleware in front of every route refuses (403)
  cross-site browser requests (`Sec-Fetch-Site` other than
  `same-origin`/`none`, or a mismatched `Origin` when that header is absent),
  except a GET of `/` or `/health`, and refuses any `Host` that is not an IP
  literal, `localhost`, this machine's hostname, or in `KRO_ALLOWED_HOSTS`.
  Requests with neither header (curl, the app's health probe) pass as
  before. New `KRO_HOST` sets the bind address (default unchanged: every
  interface, now logged as a warning at startup); KRo.app starts its server
  with `KRO_HOST=127.0.0.1`. Tests: `TestGuardVerdict`, `TestHostOnly`,
  `TestRequestGuardMiddleware`. This is not authentication: another machine
  that can reach the port can still use kro (N-038). App check is N-045.

- **N-030** · raised `2026-1118-1509-reliability-performance-usability-review` · closed 2026-11-18, `2026-1118-1509-reliability-performance-usability-review`
  `resources.js`: expand state lives in `expandedRows`, keyed
  `<scope>/<Kind>:<name>`, and rendering is the only thing that applies it
  (`toggleChildren` flips the entry and re-renders from `lastTree`).
  `rebuildTables` skips a tab whose generated HTML equals `tabHtmlCache`, and
  hands a focused pod filter its text and caret back after a rewrite. A
  snapshot arriving while a mouse button is down in a resource panel, or
  text is selected there, is held in `pendingTree` and applied on release
  (the dot's tooltip says so). Trees for a selection the user has left are
  dropped. `refreshResources` no longer blanks populated tables. A failed
  refresh keeps the tables under `#resources-banner`. 30 checks in headless
  WebKit and Chromium against a fake API (harness not committed). App check
  is N-043.

- **N-029** · raised `2026-1118-1509-reliability-performance-usability-review` · closed 2026-11-18, `2026-1118-1509-reliability-performance-usability-review`
  `kube.ListResources(ctx, client, ns)` runs the 13 lists concurrently under
  `ListTimeout` (15s) and takes a `kubernetes.Interface`. Only a 403 is
  reported as "check RBAC permissions"; other per-kind failures carry their
  cause; when every list fails and none is a 403 it returns
  `ErrClusterUnavailable` with the cause (`/api/resources` answers 503). A
  cancelled caller gets `context.Canceled`, not a cluster verdict.
  ReplicaSets are emitted in list order, and under a Deployment live ones
  first, then newest first. It no longer logs; callers log transitions.
  Tests in `kube/resources_test.go` (tree shape, byte-stable output, partial
  failure, all-forbidden, unavailable, concurrency over real HTTP,
  cancellation). Real-cluster check is N-046.

- **N-028** · raised `2026-1118-1509-reliability-performance-usability-review` · closed 2026-11-18, `2026-1118-1509-reliability-performance-usability-review`
  The `/sse/resources` producer is tied to `c.Request().Context()`, which
  rweb keeps alive for the whole event stream and cancels when it ends,
  instead of a stop channel closed when the handler returned. It emits
  `resources_snapshot` when the marshalled tree differs from the last one
  sent, `resources_tick` otherwise, and `resources_error` when the list
  fails as a whole, backing off to 30s between attempts. On the previous
  commit a 35s connection received no events at all; now a snapshot then a
  tick every 10s. Test: `TestResourcesStreamLifecycle` (ticks, change,
  outage, recovery, and no further lists after disconnect).

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
