package kube

import (
	"sort"
	"sync"

	"github.com/rohanthewiz/serr"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/clientcmd/api"
)

// ContextInfo summarises a kubeconfig context for the UI dropdown.
type ContextInfo struct {
	Name             string `json:"name"`
	Cluster          string `json:"cluster"`
	Server           string `json:"server"`
	DefaultNamespace string `json:"default_namespace"`
	IsCurrent        bool   `json:"is_current"`
}

// ClientRegistry holds the parsed kubeconfig and lazily-built clients per context.
type ClientRegistry struct {
	raw     *api.Config
	clients sync.Map // ctxName -> *kubernetes.Clientset
}

func NewRegistry(cfg *api.Config) *ClientRegistry {
	return &ClientRegistry{raw: cfg}
}

func (r *ClientRegistry) Raw() *api.Config { return r.raw }

func (r *ClientRegistry) CurrentContext() string { return r.raw.CurrentContext }

// Contexts returns the kubeconfig contexts sorted by name.
func (r *ClientRegistry) Contexts() []ContextInfo {
	out := make([]ContextInfo, 0, len(r.raw.Contexts))
	for name, c := range r.raw.Contexts {
		ns := c.Namespace
		if ns == "" {
			ns = "default"
		}
		server := ""
		if cluster, ok := r.raw.Clusters[c.Cluster]; ok {
			server = cluster.Server
		}
		out = append(out, ContextInfo{
			Name:             name,
			Cluster:          c.Cluster,
			Server:           server,
			DefaultNamespace: ns,
			IsCurrent:        name == r.raw.CurrentContext,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// HasContext reports whether the given context name exists in the kubeconfig.
func (r *ClientRegistry) HasContext(name string) bool {
	_, ok := r.raw.Contexts[name]
	return ok
}

// DefaultNamespace returns the namespace bound to the given context, or "default".
func (r *ClientRegistry) DefaultNamespace(ctxName string) string {
	if c, ok := r.raw.Contexts[ctxName]; ok && c.Namespace != "" {
		return c.Namespace
	}
	return "default"
}

// Client builds (or returns the cached) clientset for the given context.
func (r *ClientRegistry) Client(ctxName string) (*kubernetes.Clientset, error) {
	if cached, ok := r.clients.Load(ctxName); ok {
		return cached.(*kubernetes.Clientset), nil
	}
	if !r.HasContext(ctxName) {
		return nil, serr.New("unknown context: " + ctxName)
	}

	restCfg, err := clientcmd.NewNonInteractiveClientConfig(
		*r.raw, ctxName, &clientcmd.ConfigOverrides{}, nil,
	).ClientConfig()
	if err != nil {
		return nil, serr.Wrap(err, "failed to build rest config for context "+ctxName)
	}

	cs, err := kubernetes.NewForConfig(restCfg)
	if err != nil {
		return nil, serr.Wrap(err, "failed to build clientset for context "+ctxName)
	}

	actual, _ := r.clients.LoadOrStore(ctxName, cs)
	return actual.(*kubernetes.Clientset), nil
}
