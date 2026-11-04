# Session: Quick switcher browses a cluster's namespaces; retired collapse key pruned (N-009, N-010)

Session ID: `07b671b3-25fa-4626-aad0-9c5b619d2dd5`

## Summary

Third and final wrap of the same session. Earlier wraps:
`2026-1104-1325-logs-modal-resume-and-dom-cap-n015-n016` and
`2026-1104-1328-keyboard-fav-reorder-and-pod-filter-slash-n008-n011`. The
user asked for as many next-list items as possible without their input.

- **N-009**: the quick switcher only knew pinned namespaces. It now has an
  on-demand "Browse all namespaces in <ctx>" row that lists the cluster's
  namespaces, so opening the palette still makes no cluster calls.
- **N-010**: the inert `kro_collapsed_pods-orphan` key is now dropped on
  page load while no tab mounts that section.

Items left for the user: N-007 and N-014 are product decisions, and N-013
is a release tag in the rweb repo. Everything in Validate is a hands-on
KRo.app check. N-014's text now records why it needs a decision.

## Changes

- `kube/namespaces.go` (new)
  - `ListNamespaceNames(ctx, kubernetes.Interface)` makes one
    `Namespaces().List` call with an 8s timeout (`namespaceListTimeout`) and
    returns the names only, sorted. It takes the interface rather than
    `*Clientset` so the fake clientset can test it.
  - A Forbidden response maps to `ErrNamespaceListForbidden`. Many
    namespace-scoped users can't list namespaces, and typing
    `cluster/namespace` still works for them.
- `kube/namespaces_test.go` (new)
  - `TestListNamespaceNamesSorted`.
  - `TestListNamespaceNamesForbidden`, using a fake-clientset reactor that
    returns 403.
- `web/handlers_favorites.go` — new `ClusterNamespaces` handler for
  `GET /api/targets/namespaces?context=` (defaults to the selected
  context).
  - Errors: 400 for an unknown context, 403 for forbidden, 502 for a
    client or cluster error, each with an `{"error"}` body.
  - It pins nothing. Choosing a listed row goes through `GoToTarget`, which
    pins as usual.
- `web/server.go` — route registered next to `/api/targets`.
- `web/embeds/favorites.js`
  - `clusterNs[ctx]` holds one of three states: `{names, at}`,
    `{loading}`, or `{error, at}`. A loaded list is reused for
    `CLUSTER_NS_TTL_MS` (5 min).
  - `paletteTargets()` feeds `filterTargets`. It adds fresh listed names
    not already in `targets` as `{rank: 3, listed: true}` rows, tagged "not
    pinned".
  - `browseRowFor(query)` picks the context for the row. It uses the
    query's `ctx/` part when that names exactly one context (an exact name
    beats several prefix matches), otherwise the current context. It
    returns null while that context's list is loaded and fresh.
  - The browse row is always last in `paletteRows`, so ↑↓/Enter/click work
    on it like any other row. `choosePalette` calls
    `browseNamespaces(ctx)` for it and keeps the palette open.
  - Row states: "Browse all namespaces in X" (tag "cluster call"), then
    "Listing namespaces in X…", then the merged rows. On failure it shows
    "Couldn't list namespaces in X: <error>" (tag "retry").
  - `repaintPalette()` re-renders from the current query and puts focus
    back in the input after a mouse click.
  - The empty-state message still renders, with the browse row below it.
- `web/embeds/favorites.css` — `.fav-palette-browse` styles (muted, with a
  red error variant), plus dark-mode variants.
- `web/embeds/resources.js`
  - `RETIRED_SECTION_SLUGS = ['pods-orphan']`.
  - `pruneRetiredCollapseKeys()` runs once at load. It removes
    `kro_collapsed_<slug>` for each retired slug that no `TAB_CONFIG` tab
    mounts, inside try/catch.
  - It deliberately uses an explicit list rather than "every prefixed key
    not in TAB_CONFIG": `terminal` (rendered by `pages.go`) uses the same
    prefix outside the tabs and must keep its state.
- `ai_docs/todo/next-list.md` — N-009 and N-010 closed, N-027 raised, and
  N-014 updated with the design trade-off.

## Verification

- `go build ./...` and `go test ./...` pass, including the two new kube
  tests. `node --check` passes on both JS files.
- Throwaway jsdom harnesses in the scratchpad (not committed):
  - Palette, with stubbed `/api/targets` and `/api/targets/namespaces`.
    Checked:
    - No cluster call when the palette opens. The browse row is last for
      the current context and follows a typed `stage/`.
    - ↑ then Enter shows the loading row. The merged rows then appear
      tagged "not pinned", with no duplicate of an already-pinned
      namespace, and the palette stays open.
    - Choosing a listed row switches to it.
    - A 403 renders the "not permitted" error row.
  - Prune, with a stubbed localStorage. Checked: `pods-orphan` is removed
    while unmounted and kept once mounted, and `terminal`/`jobs` are never
    touched.
- Not run in KRo.app. That check is N-027.

## Next

Closed: N-009, N-010. Declined: None. Raised: N-027.
Deferred: None. Promoted: None. Moved: None. Updated: N-014.
Full list: `ai_docs/todo/next-list.md`.
