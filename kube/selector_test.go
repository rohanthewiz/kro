package kube

import (
	"testing"

	"github.com/rohanthewiz/rweb"
)

// resolveWith runs a single rweb request through the in-memory test client and
// returns the Selection produced by the handler. Cookies are supplied via the
// Cookie header.
func resolveWith(t *testing.T, reg *ClientRegistry, cookieHeader string) (Selection, error) {
	t.Helper()
	s := rweb.NewServer()

	var got Selection
	var gotErr error
	s.Get("/probe", func(c rweb.Context) error {
		got, gotErr = ResolveSelection(c, reg, nil)
		return c.WriteString("ok")
	})

	var headers []rweb.Header
	if cookieHeader != "" {
		headers = []rweb.Header{{Key: "Cookie", Value: cookieHeader}}
	}
	s.Request("GET", "/probe", headers, nil)
	return got, gotErr
}

func TestSelectionFallsBackToCurrentContext(t *testing.T) {
	reg := NewRegistry(newTestConfig())
	sel, err := resolveWith(t, reg, "")
	if err != nil {
		t.Fatalf("ResolveSelection: %v", err)
	}
	if sel.Context != "ctx-a" {
		t.Errorf("Context = %q, want ctx-a (current-context)", sel.Context)
	}
	if sel.Namespace != "team-a" {
		t.Errorf("Namespace = %q, want team-a (default for ctx-a)", sel.Namespace)
	}
}

func TestSelectionUsesCookies(t *testing.T) {
	reg := NewRegistry(newTestConfig())
	sel, err := resolveWith(t, reg, "kro_ctx=ctx-b; kro_ns=kube-system")
	if err != nil {
		t.Fatalf("ResolveSelection: %v", err)
	}
	if sel.Context != "ctx-b" || sel.Namespace != "kube-system" {
		t.Errorf("got %+v, want {ctx-b, kube-system}", sel)
	}
}

func TestSelectionRejectsUnknownContextCookie(t *testing.T) {
	reg := NewRegistry(newTestConfig())
	sel, err := resolveWith(t, reg, "kro_ctx=does-not-exist")
	if err != nil {
		t.Fatalf("ResolveSelection: %v", err)
	}
	if sel.Context != "ctx-a" {
		t.Errorf("Context = %q, want fallback to ctx-a", sel.Context)
	}
}

func TestSelectionUsesPinnedWhenNoCookie(t *testing.T) {
	reg := NewRegistry(newTestConfig())
	pinned := func(ctx string) []string {
		if ctx == "ctx-a" {
			return []string{"alpha", "beta"}
		}
		return nil
	}
	s := rweb.NewServer()
	var got Selection
	s.Get("/probe", func(c rweb.Context) error {
		got, _ = ResolveSelection(c, reg, pinned)
		return c.WriteString("ok")
	})
	s.Request("GET", "/probe", nil, nil)
	if got.Namespace != "alpha" {
		t.Errorf("Namespace = %q, want alpha (first pinned)", got.Namespace)
	}
}
