package web

import (
	_ "embed"

	"github.com/rohanthewiz/element"
	"github.com/rohanthewiz/rweb"
)

//go:embed embeds/resources.css
var resourcesCSS string

//go:embed embeds/resources.js
var resourcesJS string

//go:embed embeds/watch.css
var watchCSS string

//go:embed embeds/watch.js
var watchJS string

// Page renders the single-page resources UI. Data is fetched client-side via
// /api/resources and a live /sse/resources stream, both keyed off cookies set
// by /api/select.
func (h *handlers) Page(c rweb.Context) error {
	return c.WriteHTML(renderPage(h.buildNumber))
}

func renderPage(buildNumber string) string {
	const pageName = "KRo — k8s resources"

	b := element.B()

	b.Html().R(
		b.Head().R(
			b.Meta("charset", "utf-8").R(),
			b.Meta("name", "viewport", "content", "width=device-width, initial-scale=1").R(),
			b.Title().T(pageName),
			b.Style().T(headerCSS),
			b.Style().T(resourcesCSS),
			b.Style().T(watchCSS),
		),
		b.Body().R(
			b.DivClass("container").R(
				HeaderBar{Title: "KRo", Version: buildNumber}.Render(b),

				b.DivClass("summary-bar").R(
					summaryCard(b, "jobs", "Jobs", "summary-jobs"),
					summaryCard(b, "deployments", "Deployments", "summary-deployments"),
					summaryCard(b, "pods", "Pods", "summary-pods"),
					summaryCard(b, "services", "Services", "summary-services"),
				),

				tabLayout(b),
			),
			b.Script().T(resourcesJS),
			b.Script().T(watchJS),
		),
	)

	return b.String()
}

func summaryCard(b *element.Builder, cls, label, valueID string) any {
	b.DivClass("summary-card " + cls).R(
		b.DivClass("label").T(label),
		b.Div("class", "value", "id", valueID).T("-"),
	)
	return nil
}

// tabLayout renders the left vertical tab sidebar and the five corresponding
// content panels on the right. Section assignment is hardwired here and in
// the JS TAB_CONFIG; the structure is meant to make tab-and-section
// configurability a near-term follow-up (each panel has a stable id, and JS
// reads the same config to populate them).
//
// Panel composition:
//   workloads   — Terminal, Jobs, All Pods (+ Pods orphan if any); shown as "Pods"
//   watch       — Pod Watch page (markup built by watch.js on first visit)
//   deployments — Deployments & ReplicaSets, All Pods
//   networking  — Services, Ingresses
//   sets        — StatefulSets, DaemonSets
//   config      — ConfigMaps, Secrets
func tabLayout(b *element.Builder) any {
	// The workloads tab keeps its internal id (localStorage keys, section
	// routing, JS TAB_CONFIG) but is presented as "Pods".
	tabs := []struct {
		id, label, sub, icon string
	}{
		{"workloads", "Pods", "Terminal · Jobs · Pods", "P"},
		{"watch", "Watch", "Pod log capture", "W"},
		{"deployments", "Deployments", "Deployments · Pods", "D"},
		{"networking", "Networking", "Services · Ingresses", "N"},
		{"sets", "Sets", "StatefulSets · DaemonSets", "S"},
		{"config", "Config", "ConfigMaps · Secrets", "C"},
	}

	b.DivClass("tab-layout").R(
		b.Nav("class", "tab-sidebar", "id", "tab-sidebar", "role", "tablist", "aria-label", "Resource tabs").R(
			b.Button(
				"type", "button",
				"class", "tab-collapse-toggle",
				"id", "tab-collapse-toggle",
				"onclick", "toggleTabSidebar()",
				"aria-label", "Collapse tab sidebar",
				"title", "Collapse sidebar",
			).R(
				b.Span("class", "tab-collapse-chevron").T("‹"),
			),
			b.Wrap(func() {
				for _, t := range tabs {
					cls := "tab-btn"
					// Pods (workloads) is the default tab; JS may switch to the
					// last-used tab from localStorage right after load.
					if t.id == "workloads" {
						cls += " active"
					}
					b.Button(
						"type", "button",
						"class", cls,
						"role", "tab",
						"data-tab", t.id,
						"aria-controls", "tab-panel-"+t.id,
						"id", "tab-btn-"+t.id,
						"title", t.label+" — "+t.sub,
					).R(
						b.Span("class", "tab-btn-icon").T(t.icon),
						b.Span("class", "tab-btn-text").R(
							b.Span("class", "tab-btn-label").T(t.label),
							b.Span("class", "tab-btn-sub").T(t.sub),
						),
					)
				}
			}),
		),
		b.DivClass("tab-content").R(
			// Pods / workloads (active by default)
			b.Div("class", "tab-panel active", "role", "tabpanel", "id", "tab-panel-workloads", "data-tab-panel", "workloads", "aria-labelledby", "tab-btn-workloads").R(
				terminalSection(b),
				b.Div("class", "tab-sections", "id", "tab-sections-workloads").R(
					b.DivClass("loading").T("Loading resources"),
				),
			),
			// Watch — Pod Watch page; watch.js builds the UI into #watch-page
			// the first time the tab is activated.
			b.Div("class", "tab-panel", "role", "tabpanel", "id", "tab-panel-watch", "data-tab-panel", "watch", "aria-labelledby", "tab-btn-watch").R(
				b.Div("class", "watch-page", "id", "watch-page").R(),
			),
			b.Div("class", "tab-panel", "role", "tabpanel", "id", "tab-panel-deployments", "data-tab-panel", "deployments", "aria-labelledby", "tab-btn-deployments").R(
				b.Div("class", "tab-sections", "id", "tab-sections-deployments").R(),
			),
			b.Div("class", "tab-panel", "role", "tabpanel", "id", "tab-panel-networking", "data-tab-panel", "networking", "aria-labelledby", "tab-btn-networking").R(
				b.Div("class", "tab-sections", "id", "tab-sections-networking").R(),
			),
			b.Div("class", "tab-panel", "role", "tabpanel", "id", "tab-panel-sets", "data-tab-panel", "sets", "aria-labelledby", "tab-btn-sets").R(
				b.Div("class", "tab-sections", "id", "tab-sections-sets").R(),
			),
			b.Div("class", "tab-panel", "role", "tabpanel", "id", "tab-panel-config", "data-tab-panel", "config", "aria-labelledby", "tab-btn-config").R(
				b.Div("class", "tab-sections", "id", "tab-sections-config").R(),
			),
		),
	)
	return nil
}

// terminalSection renders the collapsible kubectl terminal that sits above the
// resource tree. Past commands and live output are rendered as blocks into
// #term-blocks; the input row sits at the bottom with a transparent textarea
// overlaid on a syntax-highlighting <pre> so the user gets click-to-position
// editing while the visible text is colorized.
func terminalSection(b *element.Builder) any {
	// Start collapsed by default; JS reads kro_collapsed_terminal from
	// localStorage in initTerminal() and may un-collapse it on load.
	b.Div("class", "resource-section term-section collapsed", "data-section", "terminal", "id", "term-section").R(
		b.DivClass("section-header").R(
			b.Span("class", "section-chevron", "onclick", "toggleSection('terminal')").T("▸"),
			b.H2("onclick", "toggleSection('terminal')").T("Terminal"),
			b.Span("class", "section-count term-target", "id", "term-target").T("—"),
			b.Span("class", "term-hint").T("kubectl auto-prefixed · Enter=run · Shift+Enter=newline · ↑↓=history · Ctrl+L=clear · Esc=cancel"),
			b.Span("class", "term-spacer").R(),
			b.Button("type", "button", "class", "term-action term-cancel", "id", "term-cancel", "title", "Cancel running command", "onclick", "termCancel()").T("Cancel"),
			b.Button("type", "button", "class", "term-action term-clear", "id", "term-clear", "title", "Clear output (Ctrl+L)", "onclick", "termClear()").T("Clear"),
		),
		b.DivClass("table-wrapper term-wrapper").R(
			b.Div("class", "term-blocks", "id", "term-blocks").R(
				b.DivClass("term-empty").T("kubectl output appears here. Try: get pods"),
			),
			b.DivClass("term-input-row").R(
				b.Span("class", "term-prompt").T("$ kubectl"),
				b.DivClass("term-editor").R(
					b.Pre("class", "term-highlight", "id", "term-highlight", "aria-hidden", "true").R(),
					b.TextArea("class", "term-input", "id", "term-input", "rows", "1", "autocomplete", "off", "autocorrect", "off", "autocapitalize", "off", "spellcheck", "false", "placeholder", "get pods -A").R(),
				),
				b.Button("type", "button", "class", "term-run", "id", "term-run", "title", "Run (Enter)", "onclick", "termRun()").T("▶"),
			),
			b.Div("class", "term-resizer", "id", "term-resizer", "title", "Drag to resize terminal").R(
				b.DivClass("term-resizer-grip").R(),
			),
		),
	)
	return nil
}
