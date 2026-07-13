package web

import (
	_ "embed"

	"github.com/rohanthewiz/element"
)

//go:embed embeds/header.css
var headerCSS string

// copyIconSVG is a "two overlapping rectangles" copy glyph followed by a
// checkmark glyph. CSS shows the copy icon by default and swaps to the check
// while the button carries the `copied` class (see header.css).
const copyIconSVG = `<svg class="icon-copy" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><svg class="icon-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`

// HeaderBar renders kro's top navigation: title, context dropdown, namespace
// dropdown with add/remove buttons, an SSE status pill, refresh button, and
// dark-mode toggle. Dropdowns are populated by JS once /api/contexts and
// /api/namespaces respond.
type HeaderBar struct {
	Title   string
	Version string
	// VersionMessage is the top line of the build commit's message. When set,
	// hovering the version hash reveals it in a small popup.
	VersionMessage string
	// VersionHash is the full commit hash. When set, the hover popup shows it in
	// bold as a header alongside a button to copy it to the clipboard.
	VersionHash string
}

func (h HeaderBar) Render(b *element.Builder) any {
	b.DivClass("header-bar").R(
		b.H1().R(
			b.Text(h.Title),
			b.Wrap(func() {
				if h.Version == "" {
					return
				}
				// Wrap the hash so a hover popup can reveal the full commit hash
				// (with a copy button) and the commit subject.
				b.Span("class", "version-wrap").R(
					b.Span("class", "version-label").T(h.Version),
					b.Wrap(func() {
						if h.VersionHash == "" && h.VersionMessage == "" {
							return
						}
						b.DivClass("version-popup").R(
							b.Wrap(func() {
								if h.VersionHash != "" {
									b.DivClass("version-popup-head").R(
										b.Span("class", "version-popup-hash").T(h.VersionHash),
										b.Button("type", "button", "class", "version-copy-btn",
											"title", "Copy commit hash",
											"data-hash", h.VersionHash,
											"onclick", "kroCopyCommitHash(this)").R(
											b.T(copyIconSVG),
										),
									)
								}
							}),
							b.Wrap(func() {
								if h.VersionMessage != "" {
									b.DivClass("version-popup-msg").T(h.VersionMessage)
								}
							}),
						)
					}),
				)
			}),
		),
		b.DivClass("header-selectors").R(
			b.DivClass("selector-group cluster-group").R(
				b.Label("for", "ctx-select", "class", "selector-label").T("Cluster"),
				b.Select("id", "ctx-select", "class", "selector").R(),
			),
			b.DivClass("selector-group ns-group").R(
				b.Label("for", "ns-select", "class", "selector-label").T("NS"),
				b.DivClass("ns-controls").R(
					b.Select("id", "ns-select", "class", "selector").R(),
					b.Input("type", "text", "id", "ns-add-input", "class", "selector ns-add-input", "placeholder", "namespace name", "autocomplete", "off").R(),
					b.Button("type", "button", "id", "btn-ns-add", "class", "btn-ns btn-ns-add", "title", "Add namespace").T("+"),
					b.Button("type", "button", "id", "btn-ns-remove", "class", "btn-ns btn-ns-remove", "title", "Remove selected namespace").T("−"),
				),
			),
		),
		b.DivClass("header-actions").R(
			b.Input("type", "file", "id", "kubeconfig-merge-input", "accept", ".yaml,.yml,.conf,application/yaml,text/yaml", "style", "display:none").R(),
			b.Button("class", "btn-reconnect", "id", "btn-kubeconfig-merge", "onclick", "promptMergeKubeconfig()", "title", "Upload a kubeconfig file and merge its clusters, users, and contexts into your existing ~/.kube/config. Useful for combining access to multiple clusters without overwriting your current config. Existing entries are preserved on name conflict, and a timestamped backup of the current config is created first.").T("＋ Kube Config"),
			b.Span("id", "resources-sse-status", "class", "log-status disconnected").R(),
			b.Button("class", "btn-reconnect", "onclick", "refreshResources()", "title", "Refresh").T("↻ Refresh"),
			b.Button("class", "btn-dark-toggle", "id", "btn-dark-toggle", "onclick", "toggleDarkMode()").T("☀️"),
		),
	)
	return nil
}
