package web

import (
	_ "embed"

	"github.com/rohanthewiz/element"
)

//go:embed embeds/favorites.css
var favoritesCSS string

//go:embed embeds/favorites.js
var favoritesJS string

// favoritesBar renders the shell of the favorites strip that sits directly
// under the header, plus the (hidden) quick-switcher overlay.
//
// Only the shell is server-rendered: the chips themselves and the palette rows
// are painted by favorites.js from /api/favorites and /api/targets, because
// both lists change without a page reload (starring, dragging, switching
// clusters). Keeping the containers in Go means the CSS grid/flow is stable on
// first paint and there's no layout jump while the first fetch lands.
func favoritesBar(b *element.Builder) any {
	b.Div("class", "fav-bar", "id", "fav-bar").R(
		b.Span("class", "fav-bar-label", "title",
			"Saved Cluster / Namespace destinations. Click a chip to switch, "+
				"drag to reorder, double-click to rename, × to remove.").T("★"),
		// Chips live here. The empty-state hint is replaced on first render.
		b.Div("class", "fav-chips", "id", "fav-chips").R(
			b.Span("class", "fav-empty").T("Star a Cluster / NS above to pin it here"),
		),
		b.Button("type", "button", "class", "fav-switch-btn", "id", "btn-fav-switcher",
			"title", "Quick switch — search every cluster / namespace").R(
			b.Span("class", "fav-switch-icon").T("⌕"),
			b.Span("class", "fav-switch-keys", "id", "fav-switch-keys").T("Ctrl K"),
		),
	)

	// Quick switcher. Rendered once, hidden until opened; `active` on the
	// overlay reveals it (same pattern as the resource modal).
	b.Div("class", "fav-palette-overlay", "id", "fav-palette-overlay").R(
		b.Div("class", "fav-palette", "role", "dialog", "aria-modal", "true",
			"aria-label", "Quick switch cluster and namespace").R(
			b.DivClass("fav-palette-input-row").R(
				b.Span("class", "fav-palette-prompt").T("⌕"),
				b.Input("type", "text", "id", "fav-palette-input", "class", "fav-palette-input",
					"placeholder", "cluster / namespace…",
					"autocomplete", "off", "autocorrect", "off", "autocapitalize", "off",
					"spellcheck", "false").R(),
			),
			b.Div("class", "fav-palette-list", "id", "fav-palette-list", "role", "listbox").R(),
			b.DivClass("fav-palette-hint").R(
				b.Span("class", "fav-key").T("↑↓"), b.Span("class", "fav-key-desc").T("move"),
				b.Span("class", "fav-key").T("⏎"), b.Span("class", "fav-key-desc").T("switch"),
				b.Span("class", "fav-key").T("Esc"), b.Span("class", "fav-key-desc").T("close"),
				b.Span("class", "fav-key").T("Ctrl+1…9"), b.Span("class", "fav-key-desc").T("jump to favorite"),
			),
		),
	)
	return nil
}
