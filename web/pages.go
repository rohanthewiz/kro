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
