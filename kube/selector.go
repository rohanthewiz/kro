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

// Last supplies the persisted "last selected" values so a browser with no
// cookie (a fresh session, cleared cookies, or the first visit after a restart)
// resumes where the user left off instead of the kubeconfig defaults. A nil
// pointer disables the fallback; either field may be empty/nil independently.
type Last struct {
	Context   string                  // global last-used context ("" if none recorded)
	Namespace func(ctx string) string // last-used namespace for a context ("" if none)
}

// ResolveSelection picks the (context, namespace) pair to use for a request:
//   ctx: kro_ctx cookie (validated) → last-used context → kubeconfig current-context.
//   ns:  kro_ns cookie → last-used namespace for this ctx → first pinned
//        namespace for this ctx → kubeconfig default for this ctx → "default".
//
// pinned and last may be nil (their respective fallbacks are then skipped).
func ResolveSelection(c rweb.Context, reg *ClientRegistry, pinned PinnedFn, last *Last) (Selection, error) {
	sel := Selection{}

	if v, err := c.GetCookie(CookieContext); err == nil && v != "" && reg.HasContext(v) {
		sel.Context = v
	} else if last != nil && last.Context != "" && reg.HasContext(last.Context) {
		sel.Context = last.Context
	} else {
		sel.Context = reg.CurrentContext()
	}

	if sel.Context == "" || !reg.HasContext(sel.Context) {
		return sel, serr.New("no kubeconfig context available")
	}

	if v, err := c.GetCookie(CookieNamespace); err == nil && v != "" {
		sel.Namespace = v
	} else if last != nil && last.Namespace != nil && last.Namespace(sel.Context) != "" {
		sel.Namespace = last.Namespace(sel.Context)
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
