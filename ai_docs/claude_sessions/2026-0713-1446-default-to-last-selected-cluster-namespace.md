# Session: Default to last selected cluster & namespace on startup

- Session ID: `6b88c576-76fc-456f-b1fb-234fbbf0f5f4`
- Date: 2026-07-13 14:46
- Branch: `main`

## Summary

On startup the app now resumes the **last-used cluster (context) and namespace**, even
from a fresh/cleared browser or a different browser after a restart.

Previously the "last selected" selection lived **only in browser cookies** (`kro_ctx` /
`kro_ns`). So any session without those cookies fell back to the kubeconfig
`current-context` and default namespace — not where the user left off. The fix adds
**server-side persistence** of the last selection to the existing on-disk state store and
uses it as a fallback in `ResolveSelection`. Cookies still take precedence, so per-browser
behavior is unchanged; the persisted value only fills in when there is no cookie.

## Architecture recap (pre-existing)

- Selection is resolved **per-request** in `kube/selector.go:ResolveSelection`, not at
  startup. `main.go` only loads the kubeconfig; the "default cluster" was just the
  kubeconfig `current-context`.
- `state/store.go` persists a small versioned JSON file
  (`$KRO_STATE_FILE`, else `~/.config/kro/state.json`) that held **only** the pinned
  namespace lists per context (`Namespaces map[string][]string`).
- `web/handlers.go:resolve` invokes `ResolveSelection`, passing `store.Namespaces` as the
  pinned-list source.

## Changes

### `state/store.go`
Extended the persisted `data` struct with two fields (both `omitempty`, so existing
state files load unchanged):

```go
LastContext   string            `json:"lastContext,omitempty"`   // global last-used context
LastNamespace map[string]string `json:"lastNamespace,omitempty"` // ctx -> last-used ns
```

- Initialized `LastNamespace` in `Open` (both the constructor literal and the post-decode
  nil-guard, mirroring the existing `Namespaces` handling).
- Added methods:
  - `LastContext() string`
  - `LastNamespace(ctx string) string`
  - `SetLast(ctx, ns string) error` — records `ctx` as last context and, when `ns` is
    non-empty, `ns` as last namespace within `ctx`. Empty args ignored (so callers can
    update just one axis); persists only when something changed.

### `kube/selector.go`
Added a nil-safe fallback source and threaded it into `ResolveSelection`:

```go
type Last struct {
    Context   string                  // global last-used context ("" if none)
    Namespace func(ctx string) string // last-used namespace for a context ("" if none)
}

func ResolveSelection(c rweb.Context, reg *ClientRegistry, pinned PinnedFn, last *Last) (Selection, error)
```

New precedence:
- **context:** `kro_ctx` cookie (validated) → **last-used context** (validated) → kubeconfig current-context
- **namespace:** `kro_ns` cookie → **last-used namespace for this ctx** → first pinned → kubeconfig default → `"default"`

### `web/handlers.go`
- `resolve` now builds a `kube.Last{Context: store.LastContext(), Namespace: store.LastNamespace}`
  and passes it to `ResolveSelection`.
- Persist the selection at the three places that change the active selection via cookie:
  - `Select` — after computing the effective selection. Uses `body.Namespace` (not the
    resolved namespace) so a bare context switch doesn't mis-record the previous context's
    namespace against the new context. `ctx` falls back to `sel.Context` when the body
    omits a context.
  - `AddNamespace` (when `select:true`) — `SetLast(sel.Context, body.Namespace)`.
  - `RemoveNamespace` — when the removed namespace was active, `SetLast(sel.Context, fallback)`
    for the non-empty fallback path.
  - All `SetLast` failures are logged via `logger.WarnF` (non-fatal).

### `kube/selector_test.go`
- Updated the two existing `ResolveSelection` callsites for the new 4-arg signature.
- Added tests:
  - `TestSelectionUsesLastWhenNoCookie` — last selection used when no cookie present.
  - `TestSelectionCookieBeatsLast` — cookie takes precedence over last.
  - `TestSelectionIgnoresUnknownLastContext` — an unknown last context is ignored, falls
    back to current-context.

## Verification

- `go build ./...` — clean
- `go vet ./...` — clean
- `go test ./kube ./state ./web` — pass (`web` has no test files)

## Follow-ups / not done

- Did not drive the running server end-to-end against a live kubeconfig (`/verify`); the
  resolution precedence and persistence are covered by unit tests. Offered to run it if
  desired.
- Pre-existing lint suggestion on `state/store.go` `Add` (loop could use `slices.Contains`)
  was left untouched — unrelated to this change.
