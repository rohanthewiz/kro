# Session: List only the active tab's resource kinds per snapshot (N-037)

Session ID: `76debe73-f61c-42ef-8b5f-89064e7e7e2d`

## Summary

The user picked next-list item N-037. Every resources snapshot listed all 13
kinds whichever tab was showing. That included full Secret and ConfigMap
objects (data included), fetched only to count their keys. Now:

- The **core kinds** are listed on every round: Jobs, Deployments,
  ReplicaSets, StatefulSets, DaemonSets, Pods and Services.
- The **on-demand kinds** are listed only while their tab is active:
  Ingresses (Networking), PVs, PVCs and StorageClasses (Storage), and
  ConfigMaps and Secrets (Config).
- The tree carries a `kinds` field naming what it was listed with. The page
  renders "Loading <kind>" for a kind the tree does not carry, never
  "No secrets found".

On the Pods, Deployments, Sets and Watch tabs, a round is now 7 List calls
instead of 13, and none of them returns Secret or ConfigMap data.

## Design decisions

- **Core kinds are forced server-side, in `ListResources`.** This is not
  only for the summary cards (jobs, deployments, pods, services sit above
  every tab). The pod tree places pods under owners by UID, so listing Pods
  without Jobs, ReplicaSets, StatefulSets, DaemonSets (and Deployments
  above the ReplicaSets) would misreport owned pods as orphans. Forcing the
  set in `ListResources` makes that impossible for any caller.
- **The page sends kinds, not a tab id.** N-037's text said "let the stream
  take the active tab". Sending `?kinds=configmaps,secrets` keeps tab names
  out of Go: a new tab that reuses existing kinds needs no server change.
  The page derives a tab's kinds from its sections
  (`SECTION_ON_DEMAND_KIND`), so the section builders and the request share
  one source of truth.
- **One name per kind serves both ends.** The kind name is the API resource
  name (`configmaps`, `persistentvolumeclaims`, …). It is also the
  `ResourceTree` JSON field for every kind that has one, so the page checks
  `tree.kinds` against the field it reads with one string.
- **An absent `kinds` parameter means every kind; `kinds=` (empty) means
  core only.** This keeps curl, and a page still open in KRo.app from before
  an upgrade (which knows nothing of `tree.kinds`), complete. rweb's
  `QueryParam` cannot tell absent from empty, so `requestedKinds` parses
  `Query()` with `net/url`. A malformed query falls back to every kind.
- **Unknown kind names are ignored, not a 400.** An `EventSource` that gets a
  non-200 fails without retrying. The tree's `kinds` already says what was
  actually listed, and that is what the page goes by.
- **`Kinds` is a `uint16` bitset.** The set is small and fixed, it compares
  with `==`, and its zero value is the empty set. `kindTable` holds each
  kind's resource name and warning label ("Could not list ConfigMaps") in
  the fixed listing/report order.
- **The stream is reopened only when the tab's kinds change.** Kinds are
  fixed for the life of a connection, and EventSource's own reconnects reuse
  the URL. Tabs that need the same kinds share one key (`""` for every
  core-only tab), so Pods → Deployments → Sets → Watch never reconnects. The
  new stream's first event is a full snapshot, so no one-shot fetch is added
  on a tab switch.

## Two page-side hazards handled

1. **A stale fetch could leave a tab stuck on Loading.** Say Refresh is
   clicked on Pods (a core-only fetch in flight) and then the user switches
   to Config. The retargeted stream's snapshot (with secrets) can land
   first. The late core-only response then repaints Config as Loading, and
   the stream only sends ticks after that (nothing changed on its side), so
   Config stays stuck. `applyTree` now drops a tree that lacks a kind the
   active tab renders; the open stream always lists what the tab needs.
   Proven necessary: with the guard disabled, the headless check reproduced
   the stuck Loading.
2. **The interaction hold could keep a new tab on Loading.** Text left
   selected in another tab holds back snapshots (the existing hold). A tree
   that brings a kind the screen has no rows for yet is let through.
   `rebuildTables` skips panels whose markup is unchanged, so the selection
   usually survives.

## Changes

- `kube/resources.go`
  - `Kinds` bitset, `Kind*` constants, `CoreKinds`, `AllKinds`,
    `kindTable` (resource name and warning label), `Has`, `Names`, `label`,
    and `ParseKinds` (comma-separated, case-insensitive, unknown names
    skipped).
  - `ResourceTree.Kinds` (`json:"kinds"`).
  - `ListResources(ctx, client, ns, kinds)` ORs in `CoreKinds`, builds the
    calls from the selected kinds only, and sets `tree.Kinds`. The
    "every kind failed" check for `ErrClusterUnavailable` counts only the
    calls that were made.
  - Comments that said "13 lists" now say "up to 13", in this file and in
    `kube/registry.go`.
- `web/handlers.go`: `requestedKinds(c)`; `/api/resources` passes it through.
- `web/sse.go`: `SSE` reads `requestedKinds(c)` once per connection;
  `produceSnapshots` takes `kinds`.
- `web/embeds/resources.js`
  - `SECTION_ON_DEMAND_KIND`, `activeTabId`, `tabKinds`, `activeKindsKey`,
    `kindsQuery`, `treeCarries`.
  - `switchTab` sets `activeTabId` and calls `retargetResourcesStream`. It
    reopens only an open stream whose kinds differ; before the first load,
    while paused, or with a heartbeat reconnect pending, whatever opens the
    stream next reads the active tab itself.
  - `initResourcesStream` and `refreshResources` send `?kinds=`.
    `resourcesStreamKinds` records the open stream's key.
  - `applyTree`: the stale-tree drop and the hold bypass described above.
  - The six on-demand sections render through `onDemandSection`: a Loading
    placeholder (count `…`) when the tree lacks the kind, otherwise
    `flatSection`.
- `README.md`: the `/api/resources` and `/sse/resources` rows document
  `kinds`.

## Verification

- `go vet ./...` and `go test -count=1 ./...` pass. New tests:
  - `kube`:
    - `TestListResourcesListsOnlySelectedKinds` checks which resources the
      fake clientset was asked to list, `tree.Kinds`, and that unselected
      fields stay empty.
    - `TestListResourcesKeepsPodTreeWhateverIsAsked` (no false orphans with
      only `KindSecrets` asked).
    - `TestListResourcesWarningLabelsWithSelection`.
    - `TestParseKinds`.
    - `TestListResourcesClusterUnavailable` now also runs core-only.
  - `web`: `fakeKubeAPI` counts lists per resource.
    - `TestResourcesStreamListsRequestedKinds` covers `?kinds=`,
      `?kinds=configmaps,secrets` and no parameter.
    - `TestResourcesEndpointListsRequestedKinds`.
- **Headless WebKit** (Playwright, see the project memory note) against the
  built binary on :8299 and a stdlib fake API on :8298 that counts lists per
  resource: all 14 checks passed.
  - The Pods tab lists no secrets or configmaps, and the fetch and the
    stream both send `kinds=`.
  - The hidden Config panel says Loading, not "none found".
  - There is no reconnect between core-only tabs.
  - Config fills with the configmap and the secret on a
    `kinds=configmaps%2Csecrets` stream, and the summary pod card stays
    filled.
  - Refresh on Config sends its kinds.
  - A stale slow core-only refresh is dropped.
  - After leaving Config, a 10s round lists core kinds only.
  - "No secrets/configmaps found" never reached the DOM.
- Negative control: a build with the `applyTree` drop guard disabled failed
  exactly the stale-refresh check (Config stuck on "Loading configmaps /
  Loading secrets").
- Not checked: KRo.app (WKWebView). It needs a `mac-install.sh` rebuild;
  recorded as N-048.

## Next

Closed: N-037. Declined: None. Raised: N-048. Deferred: None.
Promoted: None. Moved: None. Updated: None.
Full list: `ai_docs/todo/next-list.md`.
