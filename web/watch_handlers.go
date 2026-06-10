package web

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"

	"kro/podwatch"

	"github.com/rohanthewiz/logger"
	"github.com/rohanthewiz/rweb"
	"github.com/rohanthewiz/serr"
)

// watchErrStatus maps podwatch sentinel errors to HTTP statuses.
func watchErrStatus(err error) int {
	switch {
	case errors.Is(err, podwatch.ErrSessionExists), errors.Is(err, podwatch.ErrBadTransition):
		return http.StatusConflict
	case errors.Is(err, podwatch.ErrNoSession), errors.Is(err, podwatch.ErrNoStream):
		return http.StatusNotFound
	case errors.Is(err, podwatch.ErrBadAction):
		return http.StatusBadRequest
	default:
		return http.StatusBadGateway // cluster unreachable, list failed, etc.
	}
}

// WatchStart begins watching the cookie-selected (context, namespace) for
// newly created pods. The session is bound to that selection at start time.
func (h *handlers) WatchStart(c rweb.Context) error {
	sel, err := h.resolve(c)
	if err != nil {
		return writeJSONErr(c, http.StatusServiceUnavailable, err)
	}
	sess, err := h.mgr.Start(sel.Context, sel.Namespace)
	if err != nil {
		return writeJSONErr(c, watchErrStatus(err), err)
	}
	logger.InfoF("pod watch started for %s/%s", sel.Context, sel.Namespace)
	return c.WriteJSON(sess)
}

// watchSessionBody identifies a session explicitly — the user's cookie
// selection may have moved on since the watch was started.
type watchSessionBody struct {
	Context   string `json:"context"`
	Namespace string `json:"namespace"`
}

// WatchStop tears down a watch session. Body: {"context","namespace"}.
func (h *handlers) WatchStop(c rweb.Context) error {
	var body watchSessionBody
	if err := json.NewDecoder(bytes.NewReader(c.Request().Body())).Decode(&body); err != nil {
		return writeJSONErr(c, http.StatusBadRequest, serr.Wrap(err, "invalid JSON"))
	}
	if body.Context == "" || body.Namespace == "" {
		return writeJSONErr(c, http.StatusBadRequest, serr.New("context and namespace are required"))
	}
	if err := h.mgr.Stop(body.Context, body.Namespace); err != nil {
		return writeJSONErr(c, watchErrStatus(err), err)
	}
	logger.InfoF("pod watch stopped for %s/%s", body.Context, body.Namespace)
	return c.WriteJSON(map[string]string{"status": "stopped"})
}

// WatchStatus returns every session and stream, so a reopened modal can
// rebuild its list regardless of the current selection.
func (h *handlers) WatchStatus(c rweb.Context) error {
	return c.WriteJSON(h.mgr.Status())
}

// WatchStreamAction applies stop|pause|resume|remove to one pod's stream.
// Body: {"context","namespace","pod","action"}.
func (h *handlers) WatchStreamAction(c rweb.Context) error {
	var body struct {
		watchSessionBody
		Pod    string `json:"pod"`
		Action string `json:"action"`
	}
	if err := json.NewDecoder(bytes.NewReader(c.Request().Body())).Decode(&body); err != nil {
		return writeJSONErr(c, http.StatusBadRequest, serr.Wrap(err, "invalid JSON"))
	}
	if body.Context == "" || body.Namespace == "" || body.Pod == "" || body.Action == "" {
		return writeJSONErr(c, http.StatusBadRequest, serr.New("context, namespace, pod, and action are required"))
	}
	if err := h.mgr.StreamAction(body.Context, body.Namespace, body.Pod, body.Action); err != nil {
		return writeJSONErr(c, watchErrStatus(err), err)
	}
	return c.WriteJSON(map[string]string{"status": body.Action})
}
