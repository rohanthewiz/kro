# Session: Reliability / performance / usability review; live resources stream, request guard, KRo.app dialogs (N-028 to N-046)

Session ID: `c2eda5cd-90fc-4f30-950f-87c2be36d949`

## Summary

The user asked for a deep look at kro for reliability, performance and
usability, a plan broken into next-list items, and a start on it. The review
read the whole Go backend, the resources page script and the macOS wrapper.
It raised N-028 to N-046 in `ai_docs/todo/next-list.md`; ten of them were
built and tested in the same session.

What the review found, in order of weight:

- **The resources stream never streamed (N-028).** `SSE()` closed its stop
  channel when `svr.SetupSSE` returned, but rweb's `SetupSSE` only records
  the channel; the pump runs later. On the previous commit a 35s connection
  got zero events. The page only refreshed on its own 60s watchdog
  reconnect. This was noted in `2026-0430-1902-sse-logs-streaming` and never
  listed.
- **Listing was sequential, unbounded and mislabeled (N-029).** 13 List
  calls in a row on `context.Background()`, every failure reported as
  "check RBAC permissions", never an error.
- **Every snapshot reset the page (N-030).** Wholesale `innerHTML`
  replacement collapsed expanded rows, dropped filter focus and wiped
  selections. Fixing N-028 without this would have made the page worse.
- **Any web page could run kubectl (N-031).** No login, every interface,
  and `GET /sse/term?cmd=…` needs no cookie.
- **Dialogs did nothing in KRo.app (N-032).** No `WKUIDelegate`, so
  `confirm()` answered false, `prompt()` null, `alert()` was dropped and
  file inputs were ignored: Delete, remove namespace, favorite rename and
  ＋ Kube Config were silent no-ops in the app.
- **A terminal command could run twice (N-033)**, on an EventSource
  reconnect.
- **The Cluster dropdown switch was broken (N-042)** whenever a `kro_ns`
  cookie existed: blank NS dropdown, old namespace name listed in the new
  cluster. Reproduced on the previous commit.
- Smaller: default client rate limits and missing deadlines (N-034),
  listing while hidden (N-035), no flush on shutdown (N-036).

Left open: N-037 (list only the kinds the active tab needs), N-038 (bind to
loopback by default; the owner's decision), N-039 (kubeconfig auto-reload),
and roadmap items N-040, N-041.

## Changes

- `kube/resources.go`
  - `ListResources(ctx, kubernetes.Interface, ns)`: the 13 lists run
    concurrently (`sync.WaitGroup.Go`) under `ListTimeout` (15s). Each
    goroutine writes its own variable and its own slot of `errs`.
  - Error policy: a 403 is "Could not list X — check RBAC permissions";
    any other per-kind failure is "Could not list X — <cause>"; all kinds
    failing with no 403 returns `ErrClusterUnavailable` wrapping the cause
    (`describeListError`: plain wording for timeouts and 401, otherwise the
    error text, whitespace collapsed, 240 chars). A cancelled caller gets
    its own `ctx.Err()`.
  - ReplicaSets are emitted from the list order, never from the UID map.
    Under a Deployment: desired > 0 first, then newest first, then name.
  - No logging here any more; callers log transitions.
- `kube/registry.go`: `clientQPS` 50 / `clientBurst` 100 on every clientset;
  `RequestTimeout` (20s) for one-shot calls, with a comment on why it is not
  `rest.Config.Timeout` (that would cut log follows and watches).
- `kube/describe.go`, `kube/logs.go`, `kube/delete.go`: take a `ctx` instead
  of `context.Background()`.
- `web/sse.go`
  - `SSE()` passes `c.Request().Context()` to `produceSnapshots`; rweb keeps
    that context alive for the event stream and cancels it when the stream
    ends.
  - `produceSnapshots`: timer-driven rounds. Emits `resources_snapshot`
    when the SHA-256 of the marshalled tree differs from the last one sent,
    `resources_tick` otherwise, `resources_error` on a whole-cluster
    failure, doubling the wait up to `snapshotErrBackoffMax` (30s, kept
    under the page's 60s watchdog minus the list timeout). After an error
    the digest is forgotten so recovery always sends a full snapshot. Logs
    on transitions only.
- `web/handlers.go`
  - `Resources`: request-bound context; 503 for `ErrClusterUnavailable`.
  - `Describe`, `Logs`: `RequestTimeout` on the request context. `Delete`:
    `RequestTimeout` on a background context, so a confirmed delete is not
    abandoned by a page reload.
  - `clusterErrStatus`: the API's own status code when there is one, 504 on
    a deadline, 502 otherwise. These used to answer 404 or 500 for anything.
  - `handlers.snapshotEvery`: test override for the stream interval.
- `web/guard.go` (new): `requestGuard` middleware, first in the chain.
  `guardVerdict` is the pure decision: Host must be an IP literal,
  `localhost`, this machine's hostname (also short and `.local`), or in
  `KRO_ALLOWED_HOSTS`; `Sec-Fetch-Site` must be `same-origin` or `none`,
  or, when absent, `Origin` must be absent or equal to Host; a cross-site
  GET of `/` or `/health` is still allowed. Refusals are 403 and logged.
- `config/config.go`: `Host` (`KRO_HOST`, default empty = every interface),
  `AllowedHosts` (`KRO_ALLOWED_HOSTS`), `ListenAddr()`.
- `web/server.go`: listens on `cfg.ListenAddr()`, installs the guard.
- `main.go`: warns at startup when listening on every interface; calls
  `mgr.Shutdown()` after `srv.Run()` returns and logs "kro stopped".
- `podwatch/manager.go`: `Shutdown()` cancels every session and finalizes
  its streams with "stopped (kro shut down)". No events, no pending kicks.
- `podwatch/livecapture.go`: `flushAll(marker)` for open Logs-modal
  captures.
- `web/embeds/resources.js`
  - Render state: `lastTree`, `pendingTree`, `tabHtmlCache`,
    `expandedRows`. `applyTree(tree, force)` drops trees for a selection
    the user has left, holds a snapshot while a mouse button is down or
    text is selected inside `.tab-sections` (15s failsafe on the mouse
    flag), otherwise `renderTree`.
  - `rebuildTables` skips a tab whose HTML equals the cache;
    `captureFilterFocus` / `restoreFilterFocus` hand a focused pod filter
    its text and caret back. The filter bar's HTML no longer carries the
    query or the `filtering` class, so typing does not change the markup.
  - Rows are keyed `rowKey(scope, res)` = `<scope>/<Kind>:<name>`.
    `toggleChildren` flips `expandedRows` (clearing nested keys by prefix
    on collapse) and re-renders from `lastTree`. `getRowId` and
    `collapseDescendants` were removed as dead.
  - `showResourcesError`: banner over the last tables, or the error in
    place of the tables when nothing is rendered yet. `resetResourceView`
    and `reloadResources` replace the six `refreshResources();
    initResourcesStream();` pairs. `refreshResources` keeps populated
    tables and dims the button.
  - Stream client: listeners for the three event types, each feeding the
    watchdog; stragglers from a superseded EventSource are ignored; the
    dot's tooltip gives the state and last-checked time.
  - `visibilitychange`: close the stream 20s after hidden (`paused`),
    reopen when visible.
  - `onContextChange` calls `kroSwitchTarget(ctx, '')` and restores the
    dropdown if the switch is refused.
  - `termSource.onerror` closes the source while a command runs and marks
    the block "connection lost".
- `web/pages.go`, `web/header_component.go`, `web/embeds/resources.css`,
  `web/embeds/header.css`: `#resources-banner`, `#btn-refresh`, `.busy`,
  `.log-status.paused`.
- `mac-install.sh`: `AppDelegate` is a `WKUIDelegate` (alert, confirm,
  text-input and open-panel callbacks, all as sheets); the app starts its
  server with `KRO_HOST=127.0.0.1` unless the environment sets one.
- `README.md`: the live-update paragraph, `KRO_HOST` and
  `KRO_ALLOWED_HOSTS`, a new *Access* section, the stream's event types.

## Verification

- `go vet ./...` and `go test -race ./...` pass.
- New tests:
  - `kube/resources_test.go`: tree shape and ReplicaSet order, byte-stable
    output over 25 calls, partial failure wording, all-forbidden,
    cluster unavailable, concurrency (13 × 200ms lists in under 1s, over
    real HTTP because the fake clientset serializes calls), cancellation.
  - `web/sse_resources_test.go`: `TestResourcesStreamLifecycle` (snapshot,
    ticks, snapshot on change, error event, full snapshot on recovery, no
    further lists after disconnect) and
    `TestResourcesEndpointClusterUnavailable`.
  - `web/guard_test.go`: `TestGuardVerdict` (22 cases), `TestHostOnly`,
    `TestRequestGuardMiddleware` (the handler does not run for a refused
    request).
  - `podwatch/podwatch_test.go`: `TestShutdownFlushesEverything`.
- The built binary was run against a fake kube API (a stdlib Go server with
  canned lists and control endpoints) and the page driven with Playwright
  in headless WebKit and Chromium: 30 checks each, all passing. Covered:
  first render, expand state across a live snapshot, untouched DOM in an
  unchanged tab, collapse clearing nested state, filter focus/text/caret
  across a rebuild, snapshot held during a selection and applied on
  release, outage banner with tables kept and no invented RBAC warnings,
  recovery, cluster switch in both directions, pause while hidden and
  resume. The harness is not committed.
- Against the previous commit (built in a throwaway worktree): the stream
  delivered 0 events in 35s, and a cluster switch with `kro_ns` set left
  the NS dropdown blank with the terminal target reading `ctx-b / ?`.
- With curl: a `Sec-Fetch-Site: cross-site` GET of `/sse/term` and a
  request with `Host: evil.example` both answer 403.
- `swiftc -typecheck` passes on the Swift rendered from `mac-install.sh`.

Not verified:

- Nothing was run in KRo.app. The Swift delegates were typechecked, not
  executed. Whether WKWebView reports `document.hidden` for a covered
  window is unknown. Checks: N-043, N-044, N-045.
- Nothing was run against a real cluster. Check: N-046.
- The terminal change (N-033) has no test; it was read through only.

## Notes

- `mac-install.sh` builds from `origin/main`, so the wrapper and the
  `KRO_HOST` handling reach KRo.app only after a push and a re-run.
- The guard changes behavior for one setup: opening kro by a DNS name that
  is not this machine's hostname now answers `host not allowed` until
  `KRO_ALLOWED_HOSTS` is set. IP addresses and `localhost` are unaffected.
- The guard is not authentication. Another machine that can reach the port
  can still use kro; that is N-038.

## Next

Closed: N-028, N-029, N-030, N-031, N-032, N-033, N-034, N-035, N-036,
N-042. Declined: None. Raised: N-028 to N-046 (the ten above, plus N-037,
N-038, N-039 in Open, N-040, N-041 in Roadmap, N-043, N-044, N-045, N-046
in Validate). Deferred: None. Promoted: None. Moved: None. Updated: N-025.
Full list: `ai_docs/todo/next-list.md`.
