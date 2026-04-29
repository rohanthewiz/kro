package web

import (
	"bytes"
	"encoding/json"
	"net/http"

	"kro/kube"
	"kro/state"

	"github.com/rohanthewiz/logger"
	"github.com/rohanthewiz/rweb"
	"github.com/rohanthewiz/serr"
)

type handlers struct {
	reg   *kube.ClientRegistry
	store *state.Store
}

// resolve picks (context, namespace) using the store as the pinned-list source.
func (h *handlers) resolve(c rweb.Context) (kube.Selection, error) {
	return kube.ResolveSelection(c, h.reg, h.store.Namespaces)
}

// Contexts returns all kubeconfig contexts plus the active selection.
func (h *handlers) Contexts(c rweb.Context) error {
	sel, _ := h.resolve(c)
	return c.WriteJSON(map[string]any{
		"contexts": h.reg.Contexts(),
		"current":  sel.Context,
	})
}

// Namespaces returns the pinned namespaces for the cookie-selected context.
// On first encounter (empty list + the kubeconfig has a default for this
// context), the kubeconfig default is auto-pinned so the UI is never blank
// out of the box.
func (h *handlers) Namespaces(c rweb.Context) error {
	sel, err := h.resolve(c)
	if err != nil {
		return writeJSONErr(c, http.StatusServiceUnavailable, err)
	}

	list := h.store.Namespaces(sel.Context)
	if len(list) == 0 {
		def := h.reg.DefaultNamespace(sel.Context)
		if def != "" {
			if _, err := h.store.Add(sel.Context, def); err != nil {
				logger.WarnF("auto-pin %s/%s: %v", sel.Context, def, err)
			}
			list = h.store.Namespaces(sel.Context)
		}
	}

	return c.WriteJSON(map[string]any{
		"namespaces": list,
		"current":    sel.Namespace,
	})
}

// AddNamespace pins a namespace for the cookie-selected context. Body: {"namespace":"..."}.
// If the request also passed "select": true, the new namespace becomes the active selection.
func (h *handlers) AddNamespace(c rweb.Context) error {
	var body struct {
		Namespace string `json:"namespace"`
		Select    bool   `json:"select"`
	}
	if err := json.NewDecoder(bytes.NewReader(c.Request().Body())).Decode(&body); err != nil {
		return writeJSONErr(c, http.StatusBadRequest, serr.Wrap(err, "invalid JSON"))
	}
	if body.Namespace == "" {
		return writeJSONErr(c, http.StatusBadRequest, serr.New("namespace is required"))
	}

	sel, err := h.resolve(c)
	if err != nil {
		return writeJSONErr(c, http.StatusServiceUnavailable, err)
	}
	if _, err := h.store.Add(sel.Context, body.Namespace); err != nil {
		return writeJSONErr(c, http.StatusInternalServerError, err)
	}
	if body.Select {
		if err := c.SetCookie(kube.CookieNamespace, body.Namespace); err != nil {
			return writeJSONErr(c, http.StatusInternalServerError, err)
		}
	}
	return c.WriteJSON(map[string]any{
		"namespaces": h.store.Namespaces(sel.Context),
		"added":      body.Namespace,
	})
}

// RemoveNamespace unpins a namespace from the cookie-selected context.
// Reads ?name=<ns>. If the removed namespace was the active selection, the
// cookie falls back to the first remaining pinned namespace (or kubeconfig default).
func (h *handlers) RemoveNamespace(c rweb.Context) error {
	name := c.Request().QueryParam("name")
	if name == "" {
		return writeJSONErr(c, http.StatusBadRequest, serr.New("name is required"))
	}

	sel, err := h.resolve(c)
	if err != nil {
		return writeJSONErr(c, http.StatusServiceUnavailable, err)
	}
	if _, err := h.store.Remove(sel.Context, name); err != nil {
		return writeJSONErr(c, http.StatusInternalServerError, err)
	}

	// If the removed namespace was active, swap the cookie to a sane fallback.
	if sel.Namespace == name {
		fallback := ""
		if list := h.store.Namespaces(sel.Context); len(list) > 0 {
			fallback = list[0]
		} else {
			fallback = h.reg.DefaultNamespace(sel.Context)
		}
		if fallback != "" {
			_ = c.SetCookie(kube.CookieNamespace, fallback)
		} else {
			_ = c.DeleteCookie(kube.CookieNamespace)
		}
	}

	return c.WriteJSON(map[string]any{
		"namespaces": h.store.Namespaces(sel.Context),
		"removed":    name,
	})
}

// Select persists the requested (context, namespace) into cookies.
func (h *handlers) Select(c rweb.Context) error {
	var body struct {
		Context   string `json:"context"`
		Namespace string `json:"namespace"`
	}
	if err := json.NewDecoder(bytes.NewReader(c.Request().Body())).Decode(&body); err != nil {
		return writeJSONErr(c, http.StatusBadRequest, serr.Wrap(err, "invalid JSON"))
	}

	if body.Context != "" {
		if !h.reg.HasContext(body.Context) {
			return writeJSONErr(c, http.StatusBadRequest, serr.New("unknown context: "+body.Context))
		}
		if err := c.SetCookie(kube.CookieContext, body.Context); err != nil {
			return writeJSONErr(c, http.StatusInternalServerError, err)
		}
	}
	if body.Namespace != "" {
		if err := c.SetCookie(kube.CookieNamespace, body.Namespace); err != nil {
			return writeJSONErr(c, http.StatusInternalServerError, err)
		}
	}

	sel, _ := h.resolve(c)
	return c.WriteJSON(map[string]any{
		"context":   sel.Context,
		"namespace": sel.Namespace,
	})
}

// Resources returns the hierarchical resource tree for the selected (ctx, ns).
func (h *handlers) Resources(c rweb.Context) error {
	sel, err := h.resolve(c)
	if err != nil {
		return writeJSONErr(c, http.StatusServiceUnavailable, err)
	}
	client, err := h.reg.Client(sel.Context)
	if err != nil {
		return writeJSONErr(c, http.StatusBadGateway, err)
	}

	tree, err := kube.ListResources(client, sel.Namespace)
	if err != nil {
		logger.LogErr(serr.Wrap(err, "failed to list resources"))
		return writeJSONErr(c, http.StatusInternalServerError, err)
	}
	tree.Context = sel.Context
	tree.Namespace = sel.Namespace
	return c.WriteJSON(tree)
}

// Describe returns kubectl-describe-style text for a resource in the selected namespace.
func (h *handlers) Describe(c rweb.Context) error {
	kind := c.Request().QueryParam("kind")
	name := c.Request().QueryParam("name")
	if kind == "" || name == "" {
		return writeTextErr(c, http.StatusBadRequest, "kind and name are required")
	}

	sel, err := h.resolve(c)
	if err != nil {
		return writeTextErr(c, http.StatusServiceUnavailable, err.Error())
	}
	client, err := h.reg.Client(sel.Context)
	if err != nil {
		return writeTextErr(c, http.StatusBadGateway, err.Error())
	}

	out, err := kube.Describe(client, sel.Namespace, kind, name)
	if err != nil {
		return writeTextErr(c, http.StatusNotFound, err.Error())
	}
	c.Response().SetHeader("Content-Type", "text/plain; charset=utf-8")
	return c.WriteString(out)
}

// Logs returns the last 500 lines from each container of the named pod.
func (h *handlers) Logs(c rweb.Context) error {
	name := c.Request().QueryParam("name")
	if name == "" {
		return writeTextErr(c, http.StatusBadRequest, "name is required")
	}

	sel, err := h.resolve(c)
	if err != nil {
		return writeTextErr(c, http.StatusServiceUnavailable, err.Error())
	}
	client, err := h.reg.Client(sel.Context)
	if err != nil {
		return writeTextErr(c, http.StatusBadGateway, err.Error())
	}

	out, err := kube.PodLogs(client, sel.Namespace, name)
	if err != nil {
		return writeTextErr(c, http.StatusNotFound, err.Error())
	}
	c.Response().SetHeader("Content-Type", "text/plain; charset=utf-8")
	return c.WriteString(out)
}

// Delete removes a resource (Job/Pod/Deployment/ReplicaSet) in the selected namespace.
func (h *handlers) Delete(c rweb.Context) error {
	var body struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(bytes.NewReader(c.Request().Body())).Decode(&body); err != nil {
		return writeJSONErr(c, http.StatusBadRequest, serr.Wrap(err, "invalid JSON"))
	}
	if body.Kind == "" || body.Name == "" {
		return writeJSONErr(c, http.StatusBadRequest, serr.New("kind and name are required"))
	}

	sel, err := h.resolve(c)
	if err != nil {
		return writeJSONErr(c, http.StatusServiceUnavailable, err)
	}
	client, err := h.reg.Client(sel.Context)
	if err != nil {
		return writeJSONErr(c, http.StatusBadGateway, err)
	}

	if err := kube.Delete(client, sel.Namespace, body.Kind, body.Name); err != nil {
		return writeJSONErr(c, http.StatusInternalServerError, err)
	}
	logger.InfoF("deleted %s/%s in %s/%s", body.Kind, body.Name, sel.Context, sel.Namespace)
	return c.WriteJSON(map[string]string{"status": "deleted"})
}

// ----- helpers -----

func writeJSONErr(c rweb.Context, status int, err error) error {
	c.SetStatus(status)
	return c.WriteJSON(map[string]string{"error": err.Error()})
}

func writeTextErr(c rweb.Context, status int, msg string) error {
	c.Response().SetHeader("Content-Type", "text/plain; charset=utf-8")
	c.SetStatus(status)
	return c.WriteString("error: " + msg)
}
