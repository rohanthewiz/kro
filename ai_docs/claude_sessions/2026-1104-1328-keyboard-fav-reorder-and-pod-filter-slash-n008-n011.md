# Session: Keyboard reorder for favorite chips, `/` to focus the pod filter (N-008, N-011)

Session ID: `07b671b3-25fa-4626-aad0-9c5b619d2dd5`

## Summary

Second wrap of the same session. The first wrap is
`2026-1104-1325-logs-modal-resume-and-dom-cap-n015-n016`. The user asked for
as many next-list items as possible without their input. This wrap covers
two keyboard-access items: N-008 (no keyboard path to reorder favorite
chips) and N-011 (no shortcut to focus the pods filter).

## Changes

- `web/embeds/favorites.js`
  - Chips now carry `tabindex="0"` and `role="button"`. They stay `<span>`s
    so the nested × `<button>` remains valid HTML.
  - New `onChipsKeydown`, wired on `#fav-chips`. It only acts when the
    event target is the chip itself, so the ×'s native Enter → click →
    remove still works.
    - ←/→ move focus to the neighbouring chip.
    - Alt/⌥+←/→ calls `moveFavorite(from, to)`. That splices `favorites`,
      repaints, and calls `persistOrder()`: the same local-first, then
      reconcile path a drop uses. Moves don't wrap; an end chip stays put.
    - Enter/Space call `goTo`. Space also gets `preventDefault` so the page
      doesn't scroll.
    - F2 reuses `onChipsDblClick`, which opens the same rename prompt.
    - Ctrl/Cmd combos are left to the global hotkeys (Ctrl+1–9, Cmd+K).
  - `renderChips` keeps focus on the favorite across rebuilds. The chip
    bar is rebuilt with innerHTML, including on the server's reply to a
    reorder, which would otherwise drop focus mid-way through a run of
    moves. Focus is tracked by identity (`favKey(ctx, ns)`) rather than by
    index, because a reorder is exactly what changes the index.
  - The chip tooltip and the file header list the new keys. The modifier
    shows as ⌥ on macOS.
- `web/embeds/favorites.css`
  - `.fav-chip:focus-visible` gets a blue outline, so the ring shows for
    keyboard focus but not on mouse clicks.
  - The × now shows on `:focus-within` as well as on hover.
- `web/embeds/resources.js`
  - New document keydown listener for a bare `/`. It does nothing if a
    modifier is held, an input/textarea/select/contenteditable has focus,
    or the resource modal is open. Otherwise it focuses and selects the
    first `.pod-filter-input` with a layout box (`offsetParent !== null`),
    which means the visible tab and not a collapsed section. The input is
    looked up at keypress time because the listings re-render wholesale and
    "All Pods" exists in more than one tab. With no filter on screen (the
    Pod Watch page, a collapsed section) the key passes through.
  - The pod filter placeholder now ends with `( / )`.

## Verification

- `node --check` passes on both JS files. `go build ./...` and
  `go test ./web` pass.
- Throwaway jsdom harnesses in the scratchpad (not committed):
  - Favorites, with a stubbed `fetch` and `kroSwitchTarget`. Checked:
    - Chips are tabbable, and ArrowRight moves focus.
    - Alt+→ reorders, focus follows the moved chip, and it is still there
      after the server re-render.
    - There's no move past the end. Two Alt+← moves reach the front, and
      each move is persisted (3 POSTs to `/reorder`).
    - Enter switches. Enter on the × is ignored by the chip handler.
  - `/`, with `offsetParent` emulated because jsdom has no layout. Checked:
    ignored in a textarea, ignored with the modal open, ignored with Ctrl
    held, and otherwise focuses the visible filter (skipping a hidden one)
    and prevents the `/` from being typed.
- Not run in KRo.app. Those checks are N-025 and N-026.

## Design notes

- Every chip is a tab stop. A roving tabindex was considered and skipped:
  the × buttons are tab stops either way, so roving would only make the Tab
  order uneven, and the list is short (favorites are hand-curated).
- Alt+Arrow was chosen for reordering because Option+Arrow has no default
  action on a non-editable element in WKWebView, and plain arrows already
  move focus.

## Next

Closed: N-008, N-011. Declined: None. Raised: N-025, N-026.
Deferred: None. Promoted: None. Moved: None. Updated: None.
Full list: `ai_docs/todo/next-list.md`.
