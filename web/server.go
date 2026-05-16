package web

import (
	"kro/config"
	"kro/kube"
	"kro/state"

	"github.com/rohanthewiz/rweb"
)

// NewServer wires routes for the kro web UI.
// All handlers close over the registry + store so they can resolve clients on demand.
func NewServer(cfg config.Config, reg *kube.ClientRegistry, store *state.Store) *rweb.Server {
	svr := rweb.NewServer(rweb.ServerOptions{
		Address: ":" + cfg.Port,
		Verbose: cfg.Verbose,
	})

	h := &handlers{reg: reg, store: store}

	svr.Get("/", h.Page)
	svr.Get("/api/contexts", h.Contexts)
	svr.Get("/api/namespaces", h.Namespaces)
	svr.Post("/api/namespaces", h.AddNamespace)
	svr.Delete("/api/namespaces", h.RemoveNamespace)
	svr.Post("/api/select", h.Select)
	svr.Post("/api/kubeconfig/merge", h.MergeKubeconfig)
	svr.Get("/api/resources", h.Resources)
	svr.Get("/api/describe", h.Describe)
	svr.Get("/api/logs", h.Logs)
	svr.Delete("/api/resources", h.Delete)
	svr.Get("/sse/resources", h.SSE(svr))
	svr.Get("/sse/logs", h.LogsSSE(svr))
	svr.Get("/sse/metrics", h.MetricsSSE(svr))
	svr.Get("/sse/term", h.TermSSE(svr))
	svr.Get("/health", func(c rweb.Context) error { return c.WriteString("ok") })

	return svr
}
