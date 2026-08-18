# Session: Favorite Cluster/Namespace combos + super-fast access

Session ID: ee047c71-bbc2-4a2f-8fc5-488752a84c4d
Date: 2026-08-18 17:49

Request: "Need a way to save favorite Cluster-Namespace combos and have
super-fast access to these."

Asked which access surface was wanted; answer was **all three**: chip bar,
Ctrl+1…9 hotkeys, and a Cmd/Ctrl+K quick switcher. Persistence in `state.json`
either way, with a ★ toggle for the current pair.

Touches `go:embed`ed `web/embeds/*`, so seeing it in KRo.app needs a rebuild +
re-run of `mac-install.sh`. (`mac-install.sh` does `git reset --hard
origin/main` on `~/.kro`, so commit + push before rebuilding or the edits are
discarded.)

## Design

Three access paths, one code path. Everything ends in
`window.kroSwitchTarget(ctx, ns)` → `POST /api/favorites/go`.

```
  ★ toggle ─┐
  chip click ┼─→ kroSwitchTarget() ─→ POST /api/favorites/go ─→ repaint header
  Ctrl+<n>  ─┤                          (one round trip)
  palette ⏎ ─┘
```

The one-round-trip endpoint is the whole point of "super-fast": the existing
dropdown flow needed three sequential fetches to change both axes
(`/api/select` context → `/api/namespaces` reload → `/api/select` namespace,
see `onContextChange` in `resources.js`). `/api/favorites/go` validates the
context, pins the namespace, writes **both** cookies, records last-used, and
returns the new namespace list — so the client repaints both dropdowns from
that single response.

`/api/targets` (the palette's data source) is assembled purely from the
kubeconfig + `state.json` — **no cluster calls** — so opening the switcher is
instant even with a dozen clusters, several of which may be unreachable.

## Persistence — `state/store.go`

New `Favorite{Context, Namespace, Label}` and `data.Favorites []Favorite`
(`json:"favorites,omitempty"`, so existing state files migrate silently).

Deliberately **ordered, never sorted** — unlike `data.Namespaces`, which is
sorted on every `Add`. Order is user-controlled because the first nine chips
are the Ctrl+1…9 hotkeys; sorting would shift hotkey numbers under the user.
`AddFavorite` appends to the tail for the same reason.

Methods (all under the existing `sync.RWMutex`, all persisting via
`saveLocked`):

- `Favorites()`, `IsFavorite(ctx, ns)`
- `AddFavorite(ctx, ns, label)` — dedupes on `(ctx, ns)`; label is **not** part
  of identity, so re-adding edits in place. An empty label on re-add is a no-op
  rather than a wipe (re-starring must not silently erase a name the user
  typed). Errors when either field is empty.
- `RemoveFavorite`, `SetFavoriteLabel` (empty label clears the custom name)
- `ReorderFavorites(order []Favorite)` — **permute-only**: pairs in `order`
  that aren't favorites are ignored, duplicates collapse, and unmentioned
  entries keep their relative order at the tail. So a stale client (dragged a
  chip while another tab removed a favorite) can reorder but can never add or
  drop an entry through this path.
- `indexOfFavLocked(ctx, ns)` helper; `favKey(ctx, ns)` = `ctx + "\x00" + ns`
- `AllNamespaces()` — deep copy of the whole pinned map, for `/api/targets`.

Package doc comment updated to mention favorites.

### Tests — `state/store_test.go` (+5)

`TestFavoritesAppendInOrderAndDedup`, `TestFavoriteLabels` (incl. the
empty-label-doesn't-wipe rule and the error on renaming a non-favorite),
`TestReorderFavoritesPermutesOnly` (unknown pair ignored, duplicate collapsed,
unmentioned entries at tail), `TestFavoritesPersistAcrossReopen`,
`TestAddFavoriteRequiresBothFields`. Plus a `favKeys()` helper flattening to
`"ctx/ns"` for readable assertions.

## API — `web/handlers_favorites.go` (new, 266 lines)

| Method | Path | Notes |
|--------|------|-------|
| GET    | `/api/favorites` | list + `isFavorite` for the active pair |
| POST   | `/api/favorites` | `{context?, namespace?, label?}`, defaults to active selection |
| DELETE | `/api/favorites?context=&namespace=` | both default to active |
| POST   | `/api/favorites/label` | rename |
| POST   | `/api/favorites/reorder` | `{favorites:[{context,namespace}]}` |
| POST   | `/api/favorites/go` | the one-round-trip switch |
| GET    | `/api/targets` | every palette destination |

Details worth remembering:

- `favoritesPayload()` — every mutation answers with the **same** shape
  (`favorites`, `context`, `namespace`, `isFavorite`), so the client re-renders
  from the authoritative response and two open tabs converge instead of
  drifting.
- Starring also **pins** the namespace (`store.Add`) so the NS dropdown agrees
  with the chip bar after a switch. Unstarring deliberately does **not** unpin
  — yanking a namespace out of the dropdown the user is looking at would be
  surprising.
- `GoToTarget` answers from the values it just committed, not from a re-resolve
  — `SetCookie` writes `Set-Cookie` on the *response*, so the request cookies
  `resolve()` reads still hold the old values. Same trap already documented in
  `Select`.
- An empty namespace in `GoToTarget` = context-only jump: falls back to
  last-used ns for that ctx → first pinned → kubeconfig default.
- `Targets` ranks rows `0` favorite, `1` pinned, `2` cluster default, deduping
  on `(ctx, ns)`; favorites pointing at a context that has left the kubeconfig
  are skipped.

Routes registered in `web/server.go` between `/api/kubeconfig/merge` and
`/api/resources`.

## UI

### Markup — `web/favorites_component.go` (new)

`favoritesBar(b)` renders only the **shell** (star strip, `#fav-chips`
container, launcher button, and the hidden palette overlay); chips and palette
rows are painted by JS since both change without a page reload. Keeping the
containers in Go means no layout jump on first paint. Called from `pages.go`
between `HeaderBar` and `.summary-bar`; `favoritesCSS` / `favoritesJS` embedded
alongside the existing ones.

`web/header_component.go` — added the `#btn-fav-toggle` ★ button to
`.ns-controls`, after the `−` button (reuses `.btn-ns` sizing).

### Styles — `web/embeds/favorites.css` (new, 339 lines)

Follows the project convention exactly: **no CSS variables**, light rules
first, one `body.dark` block at the bottom. Chip bar is amber-accented (★),
chips carry the green NS accent with a blue hotkey badge, the current chip is
filled. `.fav-chip` truncates long context names (an EKS ARN) with
`text-overflow: ellipsis` and a `max-width`. Drag feedback via
`.drop-before`/`.drop-after` box-shadow rails. `@keyframes kroFavFlash` on
`.header-selectors.fav-flash` acknowledges a hotkey jump made with eyes
elsewhere.

### Behavior — `web/embeds/favorites.js` (new, 583 lines)

- Chips: click switches, `×` removes (stops propagation), double-click prompts
  for a label, HTML5 drag reorders. Drag repaints **locally first** then
  `persistOrder()` — a drag that visibly snaps back before the round trip feels
  broken; on error it re-pulls the server order. Drop index correction: after
  splicing the dragged chip out, a target to its right shifts one slot left.
- Hotkeys (`onGlobalKeydown` on `document`):
  - `Cmd+K` / `Ctrl+K` toggles the palette, works from inside text fields.
  - `Ctrl+1..9` via `e.code === 'Digit<n>'`, explicitly **not** Cmd — macOS
    browsers bind Cmd+digit to tab switching and the KRo.app WKWebView shell
    inherits enough of that to be unreliable. Verified `mac-install.sh`'s
    `NSMenu` defines no `k` or digit `keyEquivalent`, so both reach the page.
  - `Ctrl+Shift+D` stars/unstars without the mouse.
  - Returns early while the palette is open — the palette input owns the
    keyboard then.
- Palette `filterTargets()`: whitespace terms must **all** match somewhere in
  `"ctx/ns label"` (so `prod pay` finds `prod-us/payments`); a `/` switches to
  ctx-vs-ns scoring per side. Score is lower-is-better: `rank * 1000` +
  match offset + `length/100` tie-break, `+500` for where you already are (the
  least useful row). Capped at 60 rendered rows.
- Ad-hoc rows: typing `cluster/namespace` for something unpinned offers it as a
  row tagged `not pinned`; switching to it pins it server-side, so it's a
  normal row next time. Suppressed when a listed namespace already *contains*
  the typed text — otherwise mid-typing `stg/brand` on the way to `brand-new`
  showed a bogus second row (caught in the headless probe, then fixed).
- Palette Escape calls `stopPropagation()` so it doesn't also trip the global
  Escape handlers in `resources.js` (`closeModal`) and `watch.js` (exit
  fullscreen).
- `mousemove` on a row moves the ↑↓ cursor to it, so Enter never fires on a row
  the pointer isn't over.
- `window.kroFavoritesSelectionChanged` invalidates the cached `targets` — a
  jump can pin a namespace the palette hasn't seen (`/api/targets` is free, so
  nothing worth caching around).

### `web/embeds/resources.js` changes

- Factored `renderNsOptions(list, current)` out of `loadNamespaces()` so the
  jump path can repaint the NS dropdown from `/api/favorites/go`'s response
  without a second fetch.
- New `window.kroCurrentSelection()` and `window.kroSwitchTarget(ctx, ns)`
  (the latter also re-runs `loadContexts()` if the target context isn't in the
  `<select>` — the kubeconfig may have gained contexts via a merge in another
  tab, and a bare `.value =` assignment would silently leave the select empty).
- `kroFavoritesSelectionChanged()` hook fired from `loadNamespaces()`,
  `selectAndReload()`, and the jump, so the ★ and the highlighted chip stay
  truthful no matter which surface caused the change.

## Verification

`go vet ./...` and `go test ./...` pass. (`gofmt -l .` still lists
`kube/selector.go`, `kube/term.go`, `kube/term_test.go`,
`podwatch/manager.go` — all pre-existing, untouched here.)

Ran the server on port 8299 against a **synthetic 3-context kubeconfig** in the
scratchpad with `KRO_STATE_FILE` redirected, so nothing touched `~/.kube/config`
or the real state file, and no real cluster was contacted. Exercised every
endpoint with curl: add (current + explicit + labeled), rename, delete,
reorder, `go` (favorite, unpinned ns, context-only, unknown context → 400),
`targets`, and confirmed the resulting `state.json` on disk.

Then drove the **real page** in headless Chrome. Two obstacles worth recording:

1. `--screenshot` / `--dump-dom` against the live page **hangs** — the SSE
   stream keeps the virtual clock advancing, so `--virtual-time-budget` never
   expires.
2. Fix: a small python proxy (port 8300) that serves the page with
   `window.EventSource` stubbed to a no-op and injects a probe script, and
   proxies everything else to 8299. `chromium_headless_shell-1228` from
   `~/Library/Caches/ms-playwright` + `perl -e 'alarm N; exec @ARGV'` as a
   timeout (no coreutils `timeout` on macOS).

Probe result (final run):

```
CHIPS: 0:dev-local/tools | 1:stg-eu/api*
STAR: ★ on=true
PALETTE OPEN: true
ROWS(api): ★stg-eu/api·EU staging
ROWS(stg/brand): stg-eu/brand-new          <- ad-hoc noise gone after the fix
ROWS(adhoc): stg-eu/nope-new
AFTER ENTER ctx/ns: {"context":"stg-eu","namespace":"nope-new"}
PALETTE OPEN: false
AFTER CTRL+2: {"context":"stg-eu","namespace":"api"}
CHIPS: dev-local/tools | stg-eu/api*
ERRORS:
DONE
```

Layout checked via screenshots of a static harness (page HTML with scripts
stripped, chips/palette rows hand-injected) in dark and light, including a long
EKS ARN context name — truncates cleanly, bar fits on one row.

## README

Feature bullet describing all three access paths + the persistence/one-request
notes; seven new rows in the API table; `KRO_STATE_FILE` description updated to
"Pinned namespaces + favorites JSON file".

## Files

New: `web/handlers_favorites.go`, `web/favorites_component.go`,
`web/embeds/favorites.js`, `web/embeds/favorites.css`.
Modified: `state/store.go`, `state/store_test.go`, `web/server.go`,
`web/pages.go`, `web/header_component.go`, `web/embeds/resources.js`,
`README.md`.

## Follow-ups (not done)

- No keyboard path to *reorder* chips (drag only).
- Palette lists pinned/known namespaces only; it never asks a cluster for its
  full namespace list. Ad-hoc `ctx/ns` typing covers the gap.
- Favorites are global to the kro instance, not per-browser — matches how
  pinned namespaces already work.
