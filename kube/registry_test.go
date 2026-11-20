package kube

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/clientcmd/api"
)

func newTestConfig() *api.Config {
	cfg := api.NewConfig()
	cfg.Clusters["cluster-a"] = &api.Cluster{Server: "https://a.example.com"}
	cfg.Clusters["cluster-b"] = &api.Cluster{Server: "https://b.example.com"}
	cfg.AuthInfos["user-a"] = &api.AuthInfo{Token: "tok-a"}
	cfg.AuthInfos["user-b"] = &api.AuthInfo{Token: "tok-b"}
	cfg.Contexts["ctx-a"] = &api.Context{Cluster: "cluster-a", AuthInfo: "user-a", Namespace: "team-a"}
	cfg.Contexts["ctx-b"] = &api.Context{Cluster: "cluster-b", AuthInfo: "user-b"} // no namespace → "default"
	cfg.CurrentContext = "ctx-a"
	return cfg
}

func TestContextsAreSortedAndAnnotated(t *testing.T) {
	reg := NewRegistry(newTestConfig(), nil)
	ctxs := reg.Contexts()
	if len(ctxs) != 2 {
		t.Fatalf("want 2 contexts, got %d", len(ctxs))
	}
	if ctxs[0].Name != "ctx-a" || ctxs[1].Name != "ctx-b" {
		t.Errorf("contexts not sorted by name: %v", ctxs)
	}
	if !ctxs[0].IsCurrent || ctxs[1].IsCurrent {
		t.Errorf("IsCurrent flag wrong: %+v", ctxs)
	}
	if ctxs[0].DefaultNamespace != "team-a" {
		t.Errorf("ctx-a default namespace = %q, want team-a", ctxs[0].DefaultNamespace)
	}
	if ctxs[1].DefaultNamespace != "default" {
		t.Errorf("ctx-b default namespace = %q, want default", ctxs[1].DefaultNamespace)
	}
	if ctxs[0].Server != "https://a.example.com" {
		t.Errorf("server = %q", ctxs[0].Server)
	}
}

func TestHasContextAndDefaultNamespace(t *testing.T) {
	reg := NewRegistry(newTestConfig(), nil)
	if !reg.HasContext("ctx-a") {
		t.Error("HasContext(ctx-a) = false, want true")
	}
	if reg.HasContext("nope") {
		t.Error("HasContext(nope) = true, want false")
	}
	if got := reg.DefaultNamespace("ctx-b"); got != "default" {
		t.Errorf("DefaultNamespace(ctx-b) = %q, want default", got)
	}
	if got := reg.DefaultNamespace("nope"); got != "default" {
		t.Errorf("DefaultNamespace(nope) = %q, want default", got)
	}
}

func TestClientErrorsOnUnknownContext(t *testing.T) {
	reg := NewRegistry(newTestConfig(), nil)
	if _, err := reg.Client("does-not-exist"); err == nil {
		t.Error("Client(does-not-exist) returned no error")
	}
}

func TestClientCachesPerContext(t *testing.T) {
	reg := NewRegistry(newTestConfig(), nil)
	c1, err := reg.Client("ctx-a")
	if err != nil {
		t.Fatalf("first Client(ctx-a): %v", err)
	}
	c2, err := reg.Client("ctx-a")
	if err != nil {
		t.Fatalf("second Client(ctx-a): %v", err)
	}
	if c1 != c2 {
		t.Error("Client did not cache the clientset across calls")
	}
}

// ----- on-disk reload (ReloadIfChanged) -----

// writeKubeconfig writes cfg to path and stamps it with a distinct mtime.
// Tests write the same file several times within microseconds; an explicit
// mtime per write keeps the change visible regardless of how fine the
// filesystem's timestamps are (and of whether the sizes happen to match).
func writeKubeconfig(t *testing.T, path string, cfg *api.Config, gen int) {
	t.Helper()
	if err := clientcmd.WriteToFile(*cfg, path); err != nil {
		t.Fatalf("write kubeconfig: %v", err)
	}
	mt := time.Date(2026, 1, 1, 0, 0, gen, 0, time.UTC)
	if err := os.Chtimes(path, mt, mt); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
}

// fileRegistry builds a registry the way main does, from a kubeconfig file
// that $KUBECONFIG points at, so Reload reads the same file back.
func fileRegistry(t *testing.T, path string) *ClientRegistry {
	t.Helper()
	t.Setenv("KUBECONFIG", path)
	raw, paths, err := LoadKubeconfig()
	if err != nil {
		t.Fatalf("LoadKubeconfig: %v", err)
	}
	return NewRegistry(raw, paths)
}

func TestReloadIfChangedPicksUpNewContext(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config")
	cfg := newTestConfig()
	delete(cfg.Contexts, "ctx-b")
	writeKubeconfig(t, path, cfg, 1)
	reg := fileRegistry(t, path)

	if changed, err := reg.ReloadIfChanged(); changed || err != nil {
		t.Fatalf("unchanged file: ReloadIfChanged = (%v, %v), want (false, nil)", changed, err)
	}
	if reg.HasContext("ctx-b") {
		t.Fatal("ctx-b present before it was written")
	}

	writeKubeconfig(t, path, newTestConfig(), 2) // adds ctx-b
	if changed, err := reg.ReloadIfChanged(); !changed || err != nil {
		t.Fatalf("after write: ReloadIfChanged = (%v, %v), want (true, nil)", changed, err)
	}
	if !reg.HasContext("ctx-b") {
		t.Error("ctx-b not picked up after the kubeconfig changed")
	}
	if changed, _ := reg.ReloadIfChanged(); changed {
		t.Error("second check with no further write reloaded again")
	}
}

func TestReloadKeepsClientsOfUnchangedContexts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config")
	writeKubeconfig(t, path, newTestConfig(), 1)
	reg := fileRegistry(t, path)

	a1, err := reg.Client("ctx-a")
	if err != nil {
		t.Fatalf("Client(ctx-a): %v", err)
	}
	b1, err := reg.Client("ctx-b")
	if err != nil {
		t.Fatalf("Client(ctx-b): %v", err)
	}

	// What `kubectl config use-context` plus a cluster endpoint change look
	// like on disk: ctx-a's cluster and user are untouched, ctx-b's cluster
	// moved, and ctx-a's namespace changed (which the clientset never uses).
	cfg := newTestConfig()
	cfg.CurrentContext = "ctx-b"
	cfg.Contexts["ctx-a"].Namespace = "team-a2"
	cfg.Clusters["cluster-b"].Server = "https://b2.example.com"
	writeKubeconfig(t, path, cfg, 2)
	if changed, err := reg.ReloadIfChanged(); !changed || err != nil {
		t.Fatalf("ReloadIfChanged = (%v, %v), want (true, nil)", changed, err)
	}

	a2, _ := reg.Client("ctx-a")
	b2, _ := reg.Client("ctx-b")
	if a1 != a2 {
		t.Error("ctx-a's clientset was rebuilt although its cluster and user did not change")
	}
	if b1 == b2 {
		t.Error("ctx-b's clientset was kept although its cluster's server changed")
	}
	if got := reg.CurrentContext(); got != "ctx-b" {
		t.Errorf("CurrentContext = %q, want ctx-b", got)
	}
	if got := reg.DefaultNamespace("ctx-a"); got != "team-a2" {
		t.Errorf("DefaultNamespace(ctx-a) = %q, want team-a2", got)
	}
}

func TestReloadIfChangedKeepsConfigWhenFileIsBroken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config")
	writeKubeconfig(t, path, newTestConfig(), 1)
	reg := fileRegistry(t, path)

	// A hand edit in progress, or a write caught halfway.
	if err := os.WriteFile(path, []byte("contexts: [this is not\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	mt := time.Date(2026, 1, 1, 0, 0, 2, 0, time.UTC)
	if err := os.Chtimes(path, mt, mt); err != nil {
		t.Fatal(err)
	}

	if changed, err := reg.ReloadIfChanged(); changed || err == nil {
		t.Fatalf("broken file: ReloadIfChanged = (%v, %v), want (false, error)", changed, err)
	}
	if !reg.HasContext("ctx-a") || !reg.HasContext("ctx-b") {
		t.Error("previous contexts lost after a failed reload")
	}
	// The broken version's stamp was recorded, so it is not re-parsed (and
	// re-logged) on every request.
	if changed, err := reg.ReloadIfChanged(); changed || err != nil {
		t.Errorf("repeat check of the same broken file = (%v, %v), want (false, nil)", changed, err)
	}

	// Fixing the file is a new write and is picked up.
	cfg := newTestConfig()
	cfg.Contexts["ctx-c"] = &api.Context{Cluster: "cluster-a", AuthInfo: "user-a"}
	writeKubeconfig(t, path, cfg, 3)
	if changed, err := reg.ReloadIfChanged(); !changed || err != nil {
		t.Fatalf("fixed file: ReloadIfChanged = (%v, %v), want (true, nil)", changed, err)
	}
	if !reg.HasContext("ctx-c") {
		t.Error("ctx-c not picked up after the file was fixed")
	}
}

func TestReloadIfChangedSeesFileCreatedAfterStartup(t *testing.T) {
	// No kubeconfig yet: kro starts with no contexts (a fresh machine before
	// the first `kind create cluster`).
	path := filepath.Join(t.TempDir(), "config")
	reg := fileRegistry(t, path)
	if n := len(reg.Contexts()); n != 0 {
		t.Fatalf("want 0 contexts before the file exists, got %d", n)
	}

	writeKubeconfig(t, path, newTestConfig(), 1)
	if changed, err := reg.ReloadIfChanged(); !changed || err != nil {
		t.Fatalf("ReloadIfChanged = (%v, %v), want (true, nil)", changed, err)
	}
	if n := len(reg.Contexts()); n != 2 {
		t.Errorf("want 2 contexts after the file was created, got %d", n)
	}
}

func TestReloadIfChangedWithNoPathsIsANoop(t *testing.T) {
	// Registries built in memory (tests, or a config with no file behind it)
	// have nothing to stat and must never reload from the environment.
	reg := NewRegistry(newTestConfig(), nil)
	if changed, err := reg.ReloadIfChanged(); changed || err != nil {
		t.Errorf("ReloadIfChanged = (%v, %v), want (false, nil)", changed, err)
	}
}
