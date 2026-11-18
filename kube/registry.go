package kube

import (
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rohanthewiz/serr"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/clientcmd/api"
)

// Client-side rate limits applied to every clientset the registry builds.
//
// client-go defaults to 5 requests/second with a burst of 10. One resources
// snapshot alone is 13 List calls, so with the defaults every snapshot was
// throttled by the client's own limiter (the calls past the burst wait in
// line at 5/s), before counting Pod Watch's per-pod Get/GetLogs calls and the
// log modal sharing the same clientset. The API server has its own
// server-side fairness controls (API Priority and Fairness); these values
// just keep kro from queueing against itself.
const (
	clientQPS   = 50
	clientBurst = 100
)

// RequestTimeout is the deadline handlers put on one-shot cluster calls
// (describe, the non-streaming logs fetch, delete). It is applied per call
// through a context rather than as rest.Config.Timeout, because that field
// sets http.Client.Timeout for *every* request on the clientset — including
// the long-lived log follows and pod watches, which it would sever.
const RequestTimeout = 20 * time.Second

// ContextInfo summarises a kubeconfig context for the UI dropdown.
type ContextInfo struct {
	Name             string `json:"name"`
	Cluster          string `json:"cluster"`
	Server           string `json:"server"`
	DefaultNamespace string `json:"default_namespace"`
	IsCurrent        bool   `json:"is_current"`
}

// ClientRegistry holds the parsed kubeconfig and lazily-built clients per context.
// raw is swapped atomically so Reload can replace it under concurrent readers.
type ClientRegistry struct {
	raw     atomic.Pointer[api.Config]
	paths   []string // kubeconfig precedence list (paths[0] is the primary write target)
	clients sync.Map // ctxName -> *kubernetes.Clientset
}

func NewRegistry(cfg *api.Config, paths []string) *ClientRegistry {
	r := &ClientRegistry{paths: append([]string(nil), paths...)}
	r.raw.Store(cfg)
	return r
}

func (r *ClientRegistry) Raw() *api.Config { return r.raw.Load() }

func (r *ClientRegistry) CurrentContext() string { return r.raw.Load().CurrentContext }

// Paths returns the kubeconfig precedence list discovered at startup.
func (r *ClientRegistry) Paths() []string { return r.paths }

// PrimaryPath returns the first kubeconfig file in precedence — kubectl's default write target.
func (r *ClientRegistry) PrimaryPath() string {
	if len(r.paths) == 0 {
		return ""
	}
	return r.paths[0]
}

// Reload re-parses the kubeconfig from disk and clears cached clientsets so
// subsequent Client() calls pick up the new config.
func (r *ClientRegistry) Reload() error {
	cfg, _, err := LoadKubeconfig()
	if err != nil {
		return err
	}
	r.raw.Store(cfg)
	r.clients.Clear()
	return nil
}

// Contexts returns the kubeconfig contexts sorted by name.
func (r *ClientRegistry) Contexts() []ContextInfo {
	raw := r.raw.Load()
	out := make([]ContextInfo, 0, len(raw.Contexts))
	for name, c := range raw.Contexts {
		ns := c.Namespace
		if ns == "" {
			ns = "default"
		}
		server := ""
		if cluster, ok := raw.Clusters[c.Cluster]; ok {
			server = cluster.Server
		}
		out = append(out, ContextInfo{
			Name:             name,
			Cluster:          c.Cluster,
			Server:           server,
			DefaultNamespace: ns,
			IsCurrent:        name == raw.CurrentContext,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// HasContext reports whether the given context name exists in the kubeconfig.
func (r *ClientRegistry) HasContext(name string) bool {
	_, ok := r.raw.Load().Contexts[name]
	return ok
}

// DefaultNamespace returns the namespace bound to the given context, or "default".
func (r *ClientRegistry) DefaultNamespace(ctxName string) string {
	if c, ok := r.raw.Load().Contexts[ctxName]; ok && c.Namespace != "" {
		return c.Namespace
	}
	return "default"
}

// Client builds (or returns the cached) clientset for the given context.
func (r *ClientRegistry) Client(ctxName string) (*kubernetes.Clientset, error) {
	if cached, ok := r.clients.Load(ctxName); ok {
		return cached.(*kubernetes.Clientset), nil
	}
	raw := r.raw.Load()
	if _, ok := raw.Contexts[ctxName]; !ok {
		return nil, serr.New("unknown context: " + ctxName)
	}

	restCfg, err := clientcmd.NewNonInteractiveClientConfig(
		*raw, ctxName, &clientcmd.ConfigOverrides{}, nil,
	).ClientConfig()
	if err != nil {
		return nil, serr.Wrap(err, "failed to build rest config for context "+ctxName)
	}
	restCfg.QPS = clientQPS
	restCfg.Burst = clientBurst

	cs, err := kubernetes.NewForConfig(restCfg)
	if err != nil {
		return nil, serr.Wrap(err, "failed to build clientset for context "+ctxName)
	}

	actual, _ := r.clients.LoadOrStore(ctxName, cs)
	return actual.(*kubernetes.Clientset), nil
}
