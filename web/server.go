package web

import (
	"runtime/debug"

	"kro/config"
	"kro/kube"
	"kro/state"

	"github.com/rohanthewiz/rweb"
)

// NewServer wires routes for the kro web UI.
// All handlers close over the registry + store so they can resolve clients on demand.
// buildNumber is the short commit hash injected via -ldflags at build time; if empty,
// we fall back to runtime/debug VCS info so dev runs (`go run .`) still show a hash.
func NewServer(cfg config.Config, reg *kube.ClientRegistry, store *state.Store, buildNumber string) *rweb.Server {
	svr := rweb.NewServer(rweb.ServerOptions{
		Address: ":" + cfg.Port,
		Verbose: cfg.Verbose,
	})

	h := &handlers{reg: reg, store: store, buildNumber: resolveBuildNumber(buildNumber)}

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

// resolveBuildNumber prefers the ldflags-injected value, then falls back to the
// short VCS revision the Go toolchain embeds for `go build`/`go run` inside a
// git checkout. Returns "" if neither is available.
func resolveBuildNumber(injected string) string {
	if injected != "" {
		return injected
	}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	for _, s := range info.Settings {
		if s.Key == "vcs.revision" && len(s.Value) >= 7 {
			return s.Value[:7]
		}
	}
	return ""
}
