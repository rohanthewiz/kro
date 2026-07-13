package web

import (
	"encoding/json"
	"os/exec"
	"runtime/debug"
	"strings"
	"time"

	"kro/config"
	"kro/kube"
	"kro/podwatch"
	"kro/state"

	"github.com/rohanthewiz/logger"
	"github.com/rohanthewiz/rweb"
	"github.com/rohanthewiz/serr"
)

// NewServer wires routes for the kro web UI.
// All handlers close over the registry + store so they can resolve clients on demand.
// buildNumber is the short commit hash injected via -ldflags at build time; if empty,
// we fall back to runtime/debug VCS info so dev runs (`go run .`) still show a hash.
func NewServer(cfg config.Config, reg *kube.ClientRegistry, store *state.Store, mgr *podwatch.Manager, buildNumber, buildMessage string) *rweb.Server {
	svr := rweb.NewServer(rweb.ServerOptions{
		Address: ":" + cfg.Port,
		Verbose: cfg.Verbose,
	})

	resolvedBuild := resolveBuildNumber(buildNumber)
	h := &handlers{
		reg:          reg,
		store:        store,
		mgr:          mgr,
		buildNumber:  resolvedBuild,
		buildMessage: resolveBuildMessage(buildMessage, resolvedBuild),
	}

	// Long-lived hub broadcasting watch-manager status events (new pod
	// streams, state changes, limit hits) to every open watch modal. Unlike
	// the per-request log hubs, this one is shared: clients come and go,
	// the hub stays.
	watchHub := rweb.NewSSEHub(rweb.SSEHubOptions{
		ChannelSize:       64,
		HeartbeatInterval: 30 * time.Second,
	})
	mgr.SetNotify(func(event string, payload any) {
		data, err := json.Marshal(map[string]any{"event": event, "payload": payload})
		if err != nil {
			logger.LogErr(serr.Wrap(err, "marshal watch event"))
			return
		}
		watchHub.BroadcastRaw(rweb.SSEvent{Type: "watch", Data: string(data)})
	})

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
	svr.Post("/api/watch/start", h.WatchStart)
	svr.Post("/api/watch/stop", h.WatchStop)
	svr.Get("/api/watch/status", h.WatchStatus)
	svr.Post("/api/watch/stream", h.WatchStreamAction)
	svr.Post("/api/watch/maxstreams", h.WatchSetMax)
	svr.Post("/api/watch/clear", h.WatchClear)
	svr.Get("/api/watch/export", h.WatchExport)
	svr.Get("/api/watch/loginfo", h.WatchLogInfo)
	svr.Post("/api/watch/cleanup", h.WatchCleanup)
	svr.Get("/sse/resources", h.SSE(svr))
	svr.Get("/sse/logs", h.LogsSSE(svr))
	svr.Get("/sse/metrics", h.MetricsSSE(svr))
	svr.Get("/sse/term", h.TermSSE(svr))
	svr.Get("/sse/watch", watchHub.Handler(svr, "watch"))
	svr.Get("/sse/watch-logs", h.WatchLogsSSE(svr))
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

// resolveBuildMessage returns the subject (top line) of the commit that the
// build hash points at. It prefers an ldflags-injected message, then shells out
// to `git show` for the given hash so dev runs still get one. Returns "" when
// neither is available (e.g. a binary running outside its git checkout).
func resolveBuildMessage(injected, hash string) string {
	if injected != "" {
		return injected
	}
	if hash == "" {
		return ""
	}
	out, err := exec.Command("git", "show", "-s", "--format=%s", hash).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
