# Session: Re-read the kubeconfig when it changes on disk (N-039)

Session ID: `088dd968-fbb6-4daa-a6fc-b51c8dff4f3f`

## Summary

The user picked next-list item N-039. kro read the kubeconfig once at
startup (and again after a merge upload), so a context added from a shell
(`kind create cluster`, `aws eks update-kubeconfig`) only appeared after a
restart. Now:

- The registry records each kubeconfig file's mtime and size at load.
  `/api/contexts` and `/api/targets` re-read the kubeconfig when either has
  changed, or when a file has appeared or disappeared.
- The page re-fetches `/api/contexts` when the window regains focus or
  becomes visible. The usual flow (terminal, run the command, Cmd+Tab back)
  shows the new context with no reload. KRo.app has no reload button, so
  this is the part that matters there.
- If the context the page shows is no longer the one the server resolves
  (it was deleted, e.g. `kind delete cluster`), the page does a full switch
  to the server's context.

## Design decisions

- **Check on demand, not with a file watcher.** The check is one `os.Stat`
  per file in the precedence list (one or two in practice), run only when
  the UI asks for contexts, which is when a new one would be shown. fsnotify
  loses its watch when a tool replaces the file by renaming a temp file over
  it, and adds a goroutine and an extra dependency for a low-value item.
- **The stamp is mtime and size.** mtime is stored in nanoseconds so
  `fileStamp` is comparable and `slices.Equal` works. Size catches two quick
  writes that land on the same coarse timestamp. A missing or unreadable
  file is the zero stamp, so creating `~/.kube/config` after kro started
  counts as a change. `os.Stat` follows symlinks, so a kubeconfig linked
  into a dotfiles repo is stamped by its target.
- **Stat before loading.** If the file changes between the stat and the
  read, the newer content is loaded under the older stamp, and the next
  check reloads once more for nothing. Stat after loading could record the
  newer stamp against the older content and miss that write.
- **A file that fails to parse keeps the previous config.** Its stamp is
  still recorded, so a half-written or mid-edit file is not re-parsed (and
  re-logged) on every request. The write that completes or fixes it changes
  the stamp and triggers the next attempt. The handler logs one warning.
- **Only affected clientsets are dropped.** `Reload` used to clear the whole
  client cache, which was fine when only the merge upload called it. Now
  any tool that writes the kubeconfig triggers a reload: `kubectl config
  use-context` rewrites only `current-context`, `kubens` only a context's
  namespace (which the clientset never reads), and adding a cluster leaves
  the others alone. `sameConnection` compares, per cached context, the
  cluster and user names it points at and those entries (`reflect.DeepEqual`).
  `LocationOfOrigin` is included, so an entry that moved files rebuilds,
  which errs on the safe side.
- **A race in `Client` is closed.** A clientset built from the old config
  could be stored after a reload's invalidation pass had already run. The
  reload swaps `raw` before invalidating. `Client` re-checks `raw` after
  `LoadOrStore` and `CompareAndDelete`s its own entry if the pointer moved.
  So either the pass sees the entry or the check does. The race existed
  before but was much less likely with merge-only reloads.
- **`reloadMu` serialises reloads and guards the stamps.** Readers never
  take it. They read through the existing `atomic.Pointer`, so a reload in
  progress never blocks a request.
- **The page follows the server through `kroSwitchTarget`.** The first
  version only reloaded namespaces when the resolved context changed. The
  headless check caught a blank namespace dropdown. `ResolveSelection`
  falls back to another context when the `kro_ctx` cookie names a deleted
  one, but it still honors `kro_ns`, which belonged to the deleted context.
  A full switch (`/api/favorites/go` with an empty namespace) rewrites both
  cookies and lands on the cluster's own last-used namespace. The same
  quirk on a plain page load predates this change and is raised as N-050.
- **The page keeps its own `currentCtx` until the switch commits.**
  `renderContexts` would otherwise move it to the target first. A failed
  switch would then leave the page claiming a context it isn't showing, and
  the next focus would not retry.
- **No repaint when nothing changed.** The refresh compares the option list
  and the resolved context to what is shown, so a plain focus costs one
  small request and touches no DOM (verified: the option nodes survive).

## Changes

- `kube/registry.go`
  - `ClientRegistry` gains `reloadMu` and `stamps`; `NewRegistry` stats
    the paths.
  - `fileStamp` and `statPaths`.
  - `ReloadIfChanged() (bool, error)`.
  - `Reload` and `ReloadIfChanged` share `reloadLocked`, which swaps the
    config, records the stamps, and drops clientsets per `sameConnection`.
  - `Client` re-checks after `LoadOrStore` (the race above).
- `web/handlers.go`: `refreshKubeconfig` helper (logs a reload or a failed
  load); `Contexts` calls it.
- `web/handlers_favorites.go`: `Targets` calls it, so the palette lists a
  new context.
- `web/embeds/resources.js`
  - `loadContexts` is split into `resolvedContext` and `renderContexts`.
  - `refreshContexts` runs on window `focus` (target must be `window`) and
    from the existing `visibilitychange` handler when visible. An
    in-flight flag dedupes the two.
- `web/embeds/favorites.js`: `window.kroContextsChanged` drops the
  palette's cached targets.
- `README.md`: the Features line and the `/api/contexts` row.

## Verification

- `go vet ./...` and `go test -race ./...` pass. New tests in
  `kube/registry_test.go`:
  - `TestReloadIfChangedPicksUpNewContext`
  - `TestReloadKeepsClientsOfUnchangedContexts`: ctx-a's client survives a
    `current-context` and namespace change; ctx-b's is rebuilt when its
    server moves.
  - `TestReloadIfChangedKeepsConfigWhenFileIsBroken`
  - `TestReloadIfChangedSeesFileCreatedAfterStartup`
  - `TestReloadIfChangedWithNoPathsIsANoop`
- Built binary on :18239 with a throwaway `KUBECONFIG`, state file and watch
  dir in the scratchpad:
  - curl: `kubectl config set-context beta` showed in `/api/contexts` and
    `/api/targets`, with one "reloaded" log line and no reload on the
    repeat call.
- Headless WebKit (Playwright), 9 checks passed:
  - Initial contexts.
  - A focus with no change keeps the option nodes.
  - A context added from a shell appears on focus.
  - `/api/targets` lists it.
  - Switch to `beta`, delete it from a shell, then focus: the page lands
    on `alpha`/`ns-alpha` and the resources stream restarts for it.
  - A broken file leaves the list as is (one warning logged).
  - Restoring the file causes no spurious change.
  - The `visibilitychange` path picks up another added context.
- Not checked: KRo.app. Headless WebKit had the window `focus` event
  dispatched by hand. Whether WKWebView fires it on app activation needs a
  `mac-install.sh` rebuild; recorded as N-049.

## Next

Closed: N-039. Declined: None. Raised: N-049, N-050. Deferred: None.
Promoted: None. Moved: None. Updated: None.
Full list: `ai_docs/todo/next-list.md`.
