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

// Page renders the single-page resources UI. Data is fetched client-side via
// /api/resources and a live /sse/resources stream, both keyed off cookies set
// by /api/select.
func (h *handlers) Page(c rweb.Context) error {
	return c.WriteHTML(renderPage())
}

func renderPage() string {
	const pageName = "KRo — k8s resources"

	b := element.B()

	b.Html().R(
		b.Head().R(
			b.Meta("charset", "utf-8").R(),
			b.Meta("name", "viewport", "content", "width=device-width, initial-scale=1").R(),
			b.Title().T(pageName),
			b.Style().T(headerCSS),
			b.Style().T(resourcesCSS),
		),
		b.Body().R(
			b.DivClass("container").R(
				HeaderBar{Title: "KRo"}.Render(b),

				b.DivClass("summary-bar").R(
					summaryCard(b, "jobs", "Jobs", "summary-jobs"),
					summaryCard(b, "deployments", "Deployments", "summary-deployments"),
					summaryCard(b, "pods", "Pods", "summary-pods"),
					summaryCard(b, "services", "Services", "summary-services"),
				),

				terminalSection(b),

				b.Div("id", "resources-content").R(
					b.DivClass("loading").T("Loading resources"),
				),
			),
			b.Script().T(resourcesJS),
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
