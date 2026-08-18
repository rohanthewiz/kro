package web

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"

	"kro/kube"
	"kro/state"

	"github.com/rohanthewiz/logger"
	"github.com/rohanthewiz/rweb"
	"github.com/rohanthewiz/serr"
)

// Favorites are saved (cluster, namespace) destinations. They live in the same
// state.json as the pinned namespace lists, so they survive restarts and are
// shared by every browser pointed at this kro instance — the star, the chip
// bar, the Ctrl+1..9 hotkeys and the quick switcher are all views onto this
// one list.
//
// Request flow for a switch (the "super-fast" path):
//
//	client                          server
//	  │  POST /api/favorites/go       │
//	  │  {context, namespace}         │
//	  │──────────────────────────────>│ validate ctx, pin ns, set both cookies,
//	  │                               │ record last-used
//	  │<──────────────────────────────│ {context, namespace, namespaces:[...]}
//	  │  repaint dropdowns + reload   │
//
// One round trip does what the dropdowns need three for (select context →
// reload namespaces → select namespace), which is what makes a chip click or
// a hotkey feel instant.

// favoritesPayload is the standard response body for every favorites mutation:
// the client always gets the full, authoritative list back so two open tabs
// can't drift.
func (h *handlers) favoritesPayload(c rweb.Context) map[string]any {
	sel, _ := h.resolve(c)
	favs := h.store.Favorites()
	return map[string]any{
		"favorites":  favs,
		"context":    sel.Context,
		"namespace":  sel.Namespace,
		"isFavorite": h.store.IsFavorite(sel.Context, sel.Namespace),
	}
}

// Favorites returns the ordered favorites list plus whether the current
// selection is among them (so the header star can render filled or hollow).
func (h *handlers) Favorites(c rweb.Context) error {
	return c.WriteJSON(h.favoritesPayload(c))
}

// AddFavorite stars a destination. Body: {"context":"...","namespace":"...","label":"..."}.
// Context/namespace default to the caller's current selection, which is the
// common case (clicking the ★ in the header).
func (h *handlers) AddFavorite(c rweb.Context) error {
	var body struct {
		Context   string `json:"context"`
		Namespace string `json:"namespace"`
		Label     string `json:"label"`
	}
	if err := json.NewDecoder(bytes.NewReader(c.Request().Body())).Decode(&body); err != nil {
		return writeJSONErr(c, http.StatusBadRequest, serr.Wrap(err, "invalid JSON"))
	}

	sel, err := h.resolve(c)
	if err != nil {
		return writeJSONErr(c, http.StatusServiceUnavailable, err)
	}
	ctx := strings.TrimSpace(body.Context)
	ns := strings.TrimSpace(body.Namespace)
	if ctx == "" {
		ctx = sel.Context
	}
	if ns == "" {
		ns = sel.Namespace
	}
	if !h.reg.HasContext(ctx) {
		return writeJSONErr(c, http.StatusBadRequest, serr.New("unknown context: "+ctx))
	}
	if _, err := h.store.AddFavorite(ctx, ns, strings.TrimSpace(body.Label)); err != nil {
		return writeJSONErr(c, http.StatusInternalServerError, err)
	}
	// Starring a destination also pins its namespace under that cluster, so the
	// NS dropdown agrees with the chip bar after a switch.
	if _, err := h.store.Add(ctx, ns); err != nil {
		logger.WarnF("pin namespace for favorite %s/%s: %v", ctx, ns, err)
	}
	return c.WriteJSON(h.favoritesPayload(c))
}

// RemoveFavorite unstars a destination. Reads ?context=&namespace=; both
// default to the current selection so the header star can toggle off without
// knowing what it is pointing at.
func (h *handlers) RemoveFavorite(c rweb.Context) error {
	sel, err := h.resolve(c)
	if err != nil {
		return writeJSONErr(c, http.StatusServiceUnavailable, err)
	}
	ctx := c.Request().QueryParam("context")
	ns := c.Request().QueryParam("namespace")
	if ctx == "" {
		ctx = sel.Context
	}
	if ns == "" {
		ns = sel.Namespace
	}
	if _, err := h.store.RemoveFavorite(ctx, ns); err != nil {
		return writeJSONErr(c, http.StatusInternalServerError, err)
	}
	// The namespace stays pinned on purpose: unstarring a shortcut shouldn't
	// yank the namespace out of the dropdown the user is looking at.
	return c.WriteJSON(h.favoritesPayload(c))
}

// LabelFavorite renames a favorite. Body: {"context","namespace","label"}.
// An empty label clears the custom name.
func (h *handlers) LabelFavorite(c rweb.Context) error {
	var body struct {
		Context   string `json:"context"`
		Namespace string `json:"namespace"`
		Label     string `json:"label"`
	}
	if err := json.NewDecoder(bytes.NewReader(c.Request().Body())).Decode(&body); err != nil {
		return writeJSONErr(c, http.StatusBadRequest, serr.Wrap(err, "invalid JSON"))
	}
	if body.Context == "" || body.Namespace == "" {
		return writeJSONErr(c, http.StatusBadRequest, serr.New("context and namespace are required"))
	}
	if _, err := h.store.SetFavoriteLabel(body.Context, body.Namespace, strings.TrimSpace(body.Label)); err != nil {
		return writeJSONErr(c, http.StatusBadRequest, err)
	}
	return c.WriteJSON(h.favoritesPayload(c))
}

// ReorderFavorites accepts the full chip order after a drag.
// Body: {"favorites":[{"context":"...","namespace":"..."}, ...]}.
func (h *handlers) ReorderFavorites(c rweb.Context) error {
	var body struct {
		Favorites []state.Favorite `json:"favorites"`
	}
	if err := json.NewDecoder(bytes.NewReader(c.Request().Body())).Decode(&body); err != nil {
		return writeJSONErr(c, http.StatusBadRequest, serr.Wrap(err, "invalid JSON"))
	}
	if err := h.store.ReorderFavorites(body.Favorites); err != nil {
		return writeJSONErr(c, http.StatusInternalServerError, err)
	}
	return c.WriteJSON(h.favoritesPayload(c))
}

// GoToTarget switches the session to (context, namespace) in a single request:
// it validates the context, pins the namespace so the dropdown can show it,
// writes both selection cookies, and records the pair as last-used. The
// response carries everything the header needs to repaint, so a chip click or
// a Ctrl+<n> press costs exactly one round trip.
func (h *handlers) GoToTarget(c rweb.Context) error {
	var body struct {
		Context   string `json:"context"`
		Namespace string `json:"namespace"`
	}
	if err := json.NewDecoder(bytes.NewReader(c.Request().Body())).Decode(&body); err != nil {
		return writeJSONErr(c, http.StatusBadRequest, serr.Wrap(err, "invalid JSON"))
	}

	sel, err := h.resolve(c)
	if err != nil {
		return writeJSONErr(c, http.StatusServiceUnavailable, err)
	}
	ctx := strings.TrimSpace(body.Context)
	ns := strings.TrimSpace(body.Namespace)
	if ctx == "" {
		ctx = sel.Context
	}
	if !h.reg.HasContext(ctx) {
		return writeJSONErr(c, http.StatusBadRequest, serr.New("unknown context: "+ctx))
	}
	if ns == "" {
		// A context-only jump lands on whatever that cluster last showed.
		ns = h.store.LastNamespace(ctx)
		if ns == "" {
			if list := h.store.Namespaces(ctx); len(list) > 0 {
				ns = list[0]
			} else {
				ns = h.reg.DefaultNamespace(ctx)
			}
		}
	}

	if _, err := h.store.Add(ctx, ns); err != nil {
		logger.WarnF("pin namespace on jump %s/%s: %v", ctx, ns, err)
	}
	if err := c.SetCookie(kube.CookieContext, ctx); err != nil {
		return writeJSONErr(c, http.StatusInternalServerError, err)
	}
	if err := c.SetCookie(kube.CookieNamespace, ns); err != nil {
		return writeJSONErr(c, http.StatusInternalServerError, err)
	}
	if err := h.store.SetLast(ctx, ns); err != nil {
		logger.WarnF("persist last selection %s/%s: %v", ctx, ns, err)
	}

	// Cookies just written are only visible to the NEXT request, so answer from
	// the values we just committed rather than re-resolving (same reasoning as
	// in Select).
	return c.WriteJSON(map[string]any{
		"context":    ctx,
		"namespace":  ns,
		"namespaces": h.store.Namespaces(ctx),
		"isFavorite": h.store.IsFavorite(ctx, ns),
	})
}

// target is one row in the quick-switcher palette.
type target struct {
	Context   string `json:"context"`
	Namespace string `json:"namespace"`
	Label     string `json:"label,omitempty"`
	Favorite  bool   `json:"favorite"`
	// Rank orders the palette before any typing: 0 favorites, 1 pinned
	// namespaces, 2 a cluster's kubeconfig default (the fallback row that
	// makes every context reachable even with nothing pinned yet).
	Rank int `json:"rank"`
}

// Targets returns every destination the palette can offer, assembled purely
// from the kubeconfig and state.json — no cluster round trips, so opening the
// switcher is instant even with a dozen clusters configured.
func (h *handlers) Targets(c rweb.Context) error {
	sel, _ := h.resolve(c)

	out := make([]target, 0, 32)
	seen := map[string]bool{}
	add := func(t target) {
		k := t.Context + "\x00" + t.Namespace
		if seen[k] {
			return
		}
		seen[k] = true
		out = append(out, t)
	}

	for _, f := range h.store.Favorites() {
		if !h.reg.HasContext(f.Context) { // kubeconfig entry went away
			continue
		}
		add(target{Context: f.Context, Namespace: f.Namespace, Label: f.Label, Favorite: true, Rank: 0})
	}

	pinned := h.store.AllNamespaces()
	for _, ci := range h.reg.Contexts() {
		for _, ns := range pinned[ci.Name] {
			add(target{Context: ci.Name, Namespace: ns, Rank: 1})
		}
		add(target{Context: ci.Name, Namespace: ci.DefaultNamespace, Rank: 2})
	}

	return c.WriteJSON(map[string]any{
		"targets":   out,
		"context":   sel.Context,
		"namespace": sel.Namespace,
	})
}
