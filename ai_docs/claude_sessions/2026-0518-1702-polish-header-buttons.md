# Polish Header Buttons

**Date:** 2026-05-18 17:02
**Session ID:** 0bf40b68-6be6-44ce-b78a-da1df1e2853f

## Goal

Make the namespace `+` / `×` buttons in the top header bar (next to the Cluster and NS selectors) feel more inviting without departing from the existing flat navy / mint / coral dashboard theme.

The user shared a screenshot showing the buttons reading as sharp outlined rectangles — they felt like outlines waiting to be clicked rather than clear affordances.

## Recommendation given

Four targeted polish moves, all keeping the existing palette:

1. **Soft tinted fill by default** — give `+` a faint mint wash and `−` a faint coral wash (~6–8% opacity) so they read as affordances at rest, not just outlines.
2. **Equal-size square targets** — 30×30px, `border-radius: 8px`, flex-centered glyphs. The previous markup left the `×` visually heavier than the `+` because of glyph weight and non-uniform box sizing.
3. **Softer remove glyph** — swap `×` for `−` (U+2212). The cross reads as "cancel/error" and felt alarming for a routine namespace removal; minus reads as the natural opposite of plus.
4. **Hover lift** — `transform: translateY(-1px)` plus a 1px accent-colored shadow on hover. Adds tactility without changing the flat theme.

Also floated a bigger swing (turn the selector groups into card-style containers with a left accent stripe) but flagged it as a real visual change rather than polish — user did not opt in.

User approved 1–4. No other options pursued.

## Changes applied

### `web/embeds/header.css`

Rewrote the `.btn-ns` block and its variants:

- `.btn-ns` is now `display: inline-flex` with `width: 30px; height: 30px; padding: 0; border-radius: 8px`, and added `transform` + `box-shadow` to its `transition` list.
- `.btn-ns:hover` got `transform: translateY(-1px)` (separate from the color hovers so the lift applies to both variants).
- `.btn-ns-add` now has a default `rgba(0,184,148,0.08)` background and `rgba(0,184,148,0.25)` border; hover deepens to `0.18` with a `0 1px 4px rgba(0,184,148,0.25)` shadow.
- `.btn-ns-remove` mirrors that with the coral `rgba(214,48,49,...)` values.
- `.btn-ns:disabled` resets `transform: none` and `box-shadow: none` so disabled state stays flat.

Matching dark-mode block (`body.dark .btn-ns-add` / `body.dark .btn-ns-remove`):

- Default tints at `0.08`, borders at `0.28`, hovers at `0.16–0.18` with a softer `0 1px 6px` glow using the brighter dark-mode accents (`#55efc4` mint, `#ff7675` coral). Removed the old plain `body.dark .btn-ns:hover` rule since each variant now defines its own hover.

### `web/header_component.go`

Single glyph swap on the remove button: `.T("×")` → `.T("−")` (U+2212 MINUS SIGN).

### Verification

`go build ./...` passes. No runtime/visual test performed in-session — user will reload the page to see it.

## Files touched

- `web/embeds/header.css`
- `web/header_component.go`

## Notes for future work

- If the user wants the bigger card-style treatment for the selector groups later, the bottom-border accent (`.selector-group.cluster-group` blue / `.ns-group` mint) is the natural anchor — move it to a left stripe and add a subtle inset shadow.
- The `+` button keeps `mint` and the `−` keeps `coral` — these match the existing SSE status dot palette (`#00b894` connected / `#d63031` disconnected), so the semantics stay consistent across the header.
- The `Add Kube Config` and `Refresh` buttons in `.header-actions` were not touched in this pass. They use `.btn-reconnect` (transparent pill). If the goal is to make the whole header feel more inviting, those are the next candidates — but the user scoped this to the +/− buttons.