package kube

import (
	"github.com/rohanthewiz/rweb"
	"github.com/rohanthewiz/serr"
)

const (
	CookieContext   = "kro_ctx"
	CookieNamespace = "kro_ns"
)

type Selection struct {
	Context   string
	Namespace string
}

// PinnedFn returns the list of pinned namespaces for the given context, or
// nil/empty if none are pinned. Pass nil to disable pinned-list fallback.
type PinnedFn func(ctx string) []string

// ResolveSelection picks the (context, namespace) pair to use for a request:
//   ctx: kro_ctx cookie (validated) → kubeconfig current-context.
//   ns:  kro_ns cookie → first pinned namespace for this ctx → kubeconfig
//        default for this ctx → "default".
//
// pinned may be nil (no pinned list source).
func ResolveSelection(c rweb.Context, reg *ClientRegistry, pinned PinnedFn) (Selection, error) {
	sel := Selection{}

	if v, err := c.GetCookie(CookieContext); err == nil && v != "" && reg.HasContext(v) {
		sel.Context = v
	} else {
		sel.Context = reg.CurrentContext()
	}

	if sel.Context == "" || !reg.HasContext(sel.Context) {
		return sel, serr.New("no kubeconfig context available")
	}

	if v, err := c.GetCookie(CookieNamespace); err == nil && v != "" {
		sel.Namespace = v
	} else if pinned != nil {
		if list := pinned(sel.Context); len(list) > 0 {
			sel.Namespace = list[0]
		}
	}
	if sel.Namespace == "" {
		sel.Namespace = reg.DefaultNamespace(sel.Context)
	}
	if sel.Namespace == "" {
		sel.Namespace = "default"
	}
	return sel, nil
}
