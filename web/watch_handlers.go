package web

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"time"

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

// WatchSetMax sets the cap on concurrently active streams (the UI slider).
// Body: {"max": N}. The manager clamps to its allowed range and returns the
// applied value.
func (h *handlers) WatchSetMax(c rweb.Context) error {
	var body struct {
		Max *int `json:"max"`
	}
	if err := json.NewDecoder(bytes.NewReader(c.Request().Body())).Decode(&body); err != nil {
		return writeJSONErr(c, http.StatusBadRequest, serr.Wrap(err, "invalid JSON"))
	}
	if body.Max == nil || *body.Max < 1 {
		return writeJSONErr(c, http.StatusBadRequest, serr.New("max (>= 1) is required"))
	}
	applied := h.mgr.SetMaxStreams(*body.Max)
	logger.InfoF("pod watch max streams set to %d", applied)
	return c.WriteJSON(map[string]int{"max": applied})
}

// WatchClear removes every ended (terminal) stream from every session's
// list. Log files are kept.
func (h *handlers) WatchClear(c rweb.Context) error {
	return c.WriteJSON(map[string]int{"removed": h.mgr.ClearTerminal()})
}

// WatchExport serves one stream's log file as a text download, flushing the
// stream's write buffer first so the file is current.
// GET /api/watch/export?context=..&namespace=..&pod=..
func (h *handlers) WatchExport(c rweb.Context) error {
	req := c.Request()
	ctxName, ns, pod := req.QueryParam("context"), req.QueryParam("namespace"), req.QueryParam("pod")
	if ctxName == "" || ns == "" || pod == "" {
		return writeJSONErr(c, http.StatusBadRequest, serr.New("context, namespace, and pod are required"))
	}
	// Only the manager's own path for the stream is ever served — no
	// client-supplied paths touch the filesystem.
	path, err := h.mgr.ExportPath(ctxName, ns, pod)
	if err != nil {
		return writeJSONErr(c, watchErrStatus(err), err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return writeJSONErr(c, http.StatusInternalServerError, serr.Wrap(err, "read watch log file"))
	}
	res := c.Response()
	res.SetHeader("Content-Type", "text/plain; charset=utf-8")
	// The filename is built from sanitized segments, so it is quote-safe.
	res.SetHeader("Content-Disposition", `attachment; filename="`+filepath.Base(path)+`"`)
	_, err = res.Write(data)
	return err
}

// WatchLogInfo reports the watch-log directory, its usage, and the
// auto-clean retention for the settings popover.
func (h *handlers) WatchLogInfo(c rweb.Context) error {
	return c.WriteJSON(h.mgr.LogDirInfo())
}

// WatchCleanup deletes log files older than the requested number of days
// (0 = everything not belonging to a listed stream). Body: {"days": N}.
func (h *handlers) WatchCleanup(c rweb.Context) error {
	var body struct {
		Days *int `json:"days"`
	}
	if err := json.NewDecoder(bytes.NewReader(c.Request().Body())).Decode(&body); err != nil {
		return writeJSONErr(c, http.StatusBadRequest, serr.Wrap(err, "invalid JSON"))
	}
	if body.Days == nil || *body.Days < 0 {
		return writeJSONErr(c, http.StatusBadRequest, serr.New("days (>= 0) is required"))
	}
	removed, freed, err := h.mgr.Cleanup(time.Duration(*body.Days) * 24 * time.Hour)
	if err != nil {
		return writeJSONErr(c, http.StatusInternalServerError, err)
	}
	logger.InfoF("watch log cleanup (manual, >%dd): removed %d file(s), freed %d bytes", *body.Days, removed, freed)
	return c.WriteJSON(map[string]any{"removed": removed, "freedBytes": freed, "info": h.mgr.LogDirInfo()})
}
