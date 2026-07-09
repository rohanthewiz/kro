# Pod Watch: fully multi-namespace start/stop

**Date:** 2026-07-09 12:02 &nbsp;|&nbsp; **Session ID:** 92fdd816-a5d4-4efb-9b1a-f7ec2d1827d1

## Goal

On the Pod Watch page you could start a watch on a namespace, switch to another
namespace, and start a watch there too — but starting always required the target
to be the *current* global namespace selection. Make the feature completely
multi-namespace: start and stop any namespace's watch at any time.

## Investigation findings

The backend was **already fully multi-namespace**. Key facts:

- `podwatch.Manager` keys sessions by `(context, namespace)` in a map
  (`sessKey(ctx, ns) = ctx + "\x00" + ns`, `podwatch/manager.go`). Each session has
  its own `context.Context`/`cancel`, its own watch-loop + counts-ticker
  goroutines, and its own `map[podName]*Stream`. There is **no single "current
  watch" variable**.
- `Stop`, `StreamAction`, and `Clear` already take explicit `{context, namespace}`
  in the request body, precisely because the cookie selection may have moved on
  since a watch was started.
- The UI (`web/embeds/watch.js` `renderStatus`) already rendered **one block per
  session**, each with its own `■ Stop` / `✕ Clear` buttons carrying
  `data-ctx`/`data-ns`. So stopping any watched namespace already worked.
- Namespace switching is cookie-based (`kube/selector.go` `ResolveSelection`,
  cookies `kro_ctx`/`kro_ns`) and does **not** touch running sessions.

**The only selection-bound gap:** the toolbar `▶ Start Watch` button. `watchStart()`
posted no body, and `WatchStart` used the cookie selection — so you could only
start a watch for whatever the global namespace dropdown currently pointed at.

## Decision

Asked the user how the Start control should work. They chose **"Namespace picker +
Start"**: a namespace dropdown in the watch toolbar, populated from the current
context's pinned namespaces, driving Start/Stop independent of the global
selection. (Other options offered: free-text namespace input; picker-with-context
for cross-context watches — declined for now.)

## Changes

**Backend — `web/watch_handlers.go`**

`WatchStart` now decodes an optional `{context, namespace}` body (mirroring
`WatchStop`) and falls back to the cookie selection for any empty field:

```go
func (h *handlers) WatchStart(c rweb.Context) error {
    var body watchSessionBody
    if raw := c.Request().Body(); len(bytes.TrimSpace(raw)) > 0 {
        if err := json.NewDecoder(bytes.NewReader(raw)).Decode(&body); err != nil {
            return writeJSONErr(c, http.StatusBadRequest, serr.Wrap(err, "invalid JSON"))
        }
    }
    ctxName, ns := body.Context, body.Namespace
    if ctxName == "" || ns == "" {
        sel, err := h.resolve(c)
        if err != nil { return writeJSONErr(c, http.StatusServiceUnavailable, err) }
        if ctxName == "" { ctxName = sel.Context }
        if ns == "" { ns = sel.Namespace }
    }
    sess, err := h.mgr.Start(ctxName, ns)
    ...
}
```

**Frontend — `web/embeds/watch.js`**

- Added `<select id="watch-ns-select">` to the `.watch-controls` toolbar, before
  the Start button.
- New `watchTarget()` helper returns `{context: ctx-select.value, namespace:
  watch-ns-select.value}` — Start/Stop act on *current context + picked namespace*
  instead of the global `ns-select`.
- New `loadWatchNamespaces()` fetches `/api/namespaces` and fills the picker,
  keeping the prior pick if it still exists, else the global `current`, else the
  first entry; then calls `renderStatus()`.
- `watchStart()` now posts `{context, namespace}` from `watchTarget()` (with a
  "Pick a namespace to watch" guard for the empty case).
- Toolbar Stop handler and `renderStatus()`'s Start/Stop enable logic switched from
  `currentSelection()` to `watchTarget()`. `currentSelection()` (reads the global
  dropdowns) is kept and still used for the page subtitle.
- Picker `change` listener re-runs `renderStatus()`; `watchPageActivate()` calls
  `loadWatchNamespaces()` so the picker refreshes when the tab regains focus (the
  context may have changed while hidden).

**Styling — `web/embeds/watch.css`**

- Added `.watch-ns-select` (light + `body.dark`) matching the existing toolbar
  control look.

## Verification

- `go build ./...` — clean
- `go vet ./web/... ./podwatch/...` — clean
- `node --check web/embeds/watch.js` — OK
- No `_test.go` files exist for `web` / `podwatch`.
- Full UI verification (picker + live watch) needs a running cluster + the app;
  left to the user to drive.

## Scope note

The picker lists namespaces for the **current context** only. Watching across
different kube contexts would need the picker-with-context variant (offered,
declined for now).

## Result

Committed straight to `main` (matches this repo's workflow):

- `96e2be6` — Make Pod Watch fully multi-namespace: start any namespace from a
  picker (3 files, +104/−11), pushed to `origin/main`.

Pick any namespace from the toolbar dropdown and hit **▶ Start Watch** — no need
to switch the global namespace first. Each running watch is its own session block
with independent Stop/Clear, so multiple namespaces can be started/stopped at any
time.
