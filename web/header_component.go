package web

import (
	_ "embed"

	"github.com/rohanthewiz/element"
)

//go:embed embeds/header.css
var headerCSS string

// HeaderBar renders kro's top navigation: title, context dropdown, namespace
// dropdown with add/remove buttons, an SSE status pill, refresh button, and
// dark-mode toggle. Dropdowns are populated by JS once /api/contexts and
// /api/namespaces respond.
type HeaderBar struct {
	Title   string
	Version string
}

func (h HeaderBar) Render(b *element.Builder) any {
	b.DivClass("header-bar").R(
		b.H1().R(
			b.Text(h.Title),
			b.Wrap(func() {
				if h.Version != "" {
					b.Span("class", "version-label").T(h.Version)
				}
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
					b.Button("type", "button", "id", "btn-ns-remove", "class", "btn-ns btn-ns-remove", "title", "Remove selected namespace").T("×"),
				),
			),
		),
		b.DivClass("header-actions").R(
			b.Input("type", "file", "id", "kubeconfig-merge-input", "accept", ".yaml,.yml,.conf,application/yaml,text/yaml", "style", "display:none").R(),
			b.Button("class", "btn-reconnect", "id", "btn-kubeconfig-merge", "onclick", "promptMergeKubeconfig()", "title", "Merge a kubeconfig file into the existing config").T("⇪ Add Kube Config"),
			b.Span("id", "resources-sse-status", "class", "log-status disconnected").R(),
			b.Button("class", "btn-reconnect", "onclick", "refreshResources()", "title", "Refresh").T("↻ Refresh"),
			b.Button("class", "btn-dark-toggle", "id", "btn-dark-toggle", "onclick", "toggleDarkMode()").T("\U0001F319"),
		),
	)
	return nil
}
