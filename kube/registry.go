package kube

import (
	"os"
	"reflect"
	"slices"
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
// snapshot alone is up to 13 List calls, so with the defaults every snapshot was
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

	// reloadMu serialises reloads and guards stamps. Readers never take it:
	// they go through the atomic raw pointer, so a reload in progress does
	// not block a request that only needs the current config.
	reloadMu sync.Mutex
	// stamps is what each file in paths looked like (on stat) when raw was
	// last loaded, in the same order as paths. ReloadIfChanged compares a
	// fresh stat against it.
	stamps []fileStamp
}

// NewRegistry wraps an already-loaded kubeconfig. The files in paths are
// stat'ed here, so a write that lands between LoadKubeconfig and this call
// (a few milliseconds at startup) is only noticed at the next write.
func NewRegistry(cfg *api.Config, paths []string) *ClientRegistry {
	r := &ClientRegistry{paths: append([]string(nil), paths...)}
	r.raw.Store(cfg)
	r.stamps = statPaths(r.paths)
	return r
}

// fileStamp is the change signature of one kubeconfig file. mtime is in
// nanoseconds so the struct is comparable with ==. Size is included as well
// because a filesystem with coarse timestamps can give two quick writes the
// same mtime, and they usually differ in size. A file that is missing (or
// can't be stat'ed) is the zero value, so the file being created or removed
// also counts as a change.
type fileStamp struct {
	exists  bool
	modNano int64
	size    int64
}

// statPaths stats each kubeconfig path, following symlinks (a ~/.kube/config
// linked into a dotfiles repo is stamped by its target, which is the file
// that actually changes).
func statPaths(paths []string) []fileStamp {
	out := make([]fileStamp, len(paths))
	for i, p := range paths {
		if fi, err := os.Stat(p); err == nil {
			out[i] = fileStamp{exists: true, modNano: fi.ModTime().UnixNano(), size: fi.Size()}
		}
	}
	return out
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

// Reload re-parses the kubeconfig from disk and drops the cached clientsets
// of contexts whose connection settings changed, so subsequent Client()
// calls pick up the new config. kro calls it after writing the kubeconfig
// itself (the merge upload); ReloadIfChanged covers writes by anything else.
func (r *ClientRegistry) Reload() error {
	r.reloadMu.Lock()
	defer r.reloadMu.Unlock()
	return r.reloadLocked(statPaths(r.paths))
}

// ReloadIfChanged re-reads the kubeconfig when any file in the precedence
// list was created, removed, or rewritten since the last load, and reports
// whether it reloaded. This is how contexts added from a shell (`aws eks
// update-kubeconfig`, `kind create cluster`, `kubectl config set-context`)
// reach kro without a restart.
//
// It runs on demand from the handlers that list contexts rather than from a
// file watcher: the check is one stat per file (one or two in practice), the
// UI asks for contexts exactly when it is about to show them, and polling
// avoids fsnotify's edge cases with editors and tools that replace the file
// by renaming a temp file over it (the watch stays on the old inode).
//
// A file that fails to parse (caught mid-write, or a hand edit in progress)
// keeps the previous config and returns the error. Its stamp is still
// recorded, so the broken version is not re-parsed on every call; the write
// that completes or fixes it changes the stamp again and triggers the next
// attempt.
func (r *ClientRegistry) ReloadIfChanged() (bool, error) {
	r.reloadMu.Lock()
	defer r.reloadMu.Unlock()

	// Stat before loading. If the file changes between this stat and the
	// read inside LoadKubeconfig, the newer content is loaded under the
	// older stamp, and the next call reloads once more for nothing. Stat
	// after loading would instead risk recording the newer stamp against
	// the older content and missing that write entirely.
	now := statPaths(r.paths)
	if slices.Equal(now, r.stamps) {
		return false, nil
	}
	if err := r.reloadLocked(now); err != nil {
		r.stamps = now
		return false, err
	}
	return true, nil
}

// reloadLocked loads the kubeconfig, swaps it in, and invalidates stale
// clientsets. stamps must be a stat taken before the load (see
// ReloadIfChanged). The caller holds reloadMu.
func (r *ClientRegistry) reloadLocked(stamps []fileStamp) error {
	cfg, _, err := LoadKubeconfig()
	if err != nil {
		return err
	}
	old := r.raw.Swap(cfg)
	r.stamps = stamps

	// Drop only the clientsets this change affects. A reload now happens on
	// every kubeconfig write by any tool, and most of those leave a given
	// context's connection untouched: `kubectl config use-context` only
	// rewrites current-context, `kubens` only a context's namespace (which
	// the clientset never reads, since kro passes the namespace on every
	// call), and adding a cluster leaves the others alone. Clearing the whole
	// cache on each of those would rebuild every cluster's client (and its
	// HTTP transport) for nothing.
	r.clients.Range(func(key, _ any) bool {
		name := key.(string)
		if !sameConnection(old, cfg, name) {
			r.clients.Delete(name)
		}
		return true
	})
	return nil
}

// sameConnection reports whether a context resolves to identical cluster and
// user entries in both configs, i.e. whether a clientset built from old is
// still what Client would build from new. A context that is missing from
// either config counts as changed. The comparison includes LocationOfOrigin,
// so an entry that moved to another file reads as changed; rebuilding in that
// rare case is cheap and errs on the safe side.
func sameConnection(old, new *api.Config, ctxName string) bool {
	if old == nil || new == nil {
		return false
	}
	oc, ok := old.Contexts[ctxName]
	if !ok {
		return false
	}
	nc, ok := new.Contexts[ctxName]
	if !ok {
		return false
	}
	if oc.Cluster != nc.Cluster || oc.AuthInfo != nc.AuthInfo {
		return false
	}
	return reflect.DeepEqual(old.Clusters[oc.Cluster], new.Clusters[nc.Cluster]) &&
		reflect.DeepEqual(old.AuthInfos[oc.AuthInfo], new.AuthInfos[nc.AuthInfo])
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

	actual, loaded := r.clients.LoadOrStore(ctxName, cs)
	// If a reload swapped the config while this clientset was being built,
	// the reload's invalidation pass may already have run, and would then
	// miss the entry stored just now, built from the old config. Re-check
	// after storing: the reload swaps raw before it invalidates, so either
	// that pass sees this entry, or this check sees the new pointer and
	// removes it. When the context did not actually change, this only costs
	// one rebuild on the next call.
	if !loaded && r.raw.Load() != raw {
		r.clients.CompareAndDelete(ctxName, cs)
	}
	return actual.(*kubernetes.Clientset), nil
}
