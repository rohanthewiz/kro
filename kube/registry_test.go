package kube

import (
	"testing"

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
	reg := NewRegistry(newTestConfig())
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
	reg := NewRegistry(newTestConfig())
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
	reg := NewRegistry(newTestConfig())
	if _, err := reg.Client("does-not-exist"); err == nil {
		t.Error("Client(does-not-exist) returned no error")
	}
}

func TestClientCachesPerContext(t *testing.T) {
	reg := NewRegistry(newTestConfig())
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
