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

// WatchStart begins watching a (context, namespace) for newly created pods.
// The body may name the target explicitly ({"context","namespace"}) so the
// watch is independent of the current selection; an empty or partial body
// falls back to the cookie selection. The session is bound to the resolved
// (context, namespace) at start time.
func (h *handlers) WatchStart(c rweb.Context) error {
	var body watchSessionBody
	if raw := c.Request().Body(); len(bytes.TrimSpace(raw)) > 0 {
		if err := json.NewDecoder(bytes.NewReader(raw)).Decode(&body); err != nil {
			return writeJSONErr(c, http.StatusBadRequest, serr.Wrap(err, "invalid JSON"))
		}
	}
	ctxName, ns := body.Context, body.Namespace
	if ctxName == "" || ns == "" {
		sel, err := h.resolve(c)
		if err != nil {
			return writeJSONErr(c, http.StatusServiceUnavailable, err)
		}
		if ctxName == "" {
			ctxName = sel.Context
		}
		if ns == "" {
			ns = sel.Namespace
		}
	}
	sess, err := h.mgr.Start(ctxName, ns)
	if err != nil {
		return writeJSONErr(c, watchErrStatus(err), err)
	}
	logger.InfoF("pod watch started for %s/%s", ctxName, ns)
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

// WatchNoNewStreams toggles a session's do-not-disturb: while on, newly
// created pods are ignored (no streams start); existing streams keep
// capturing. Body: {"context","namespace","noNewStreams":bool}.
func (h *handlers) WatchNoNewStreams(c rweb.Context) error {
	var body struct {
		watchSessionBody
		NoNewStreams *bool `json:"noNewStreams"`
	}
	if err := json.NewDecoder(bytes.NewReader(c.Request().Body())).Decode(&body); err != nil {
		return writeJSONErr(c, http.StatusBadRequest, serr.Wrap(err, "invalid JSON"))
	}
	if body.Context == "" || body.Namespace == "" || body.NoNewStreams == nil {
		return writeJSONErr(c, http.StatusBadRequest, serr.New("context, namespace, and noNewStreams are required"))
	}
	if err := h.mgr.SetNoNewStreams(body.Context, body.Namespace, *body.NoNewStreams); err != nil {
		return writeJSONErr(c, watchErrStatus(err), err)
	}
	logger.InfoF("pod watch no-new-streams set to %v for %s/%s", *body.NoNewStreams, body.Context, body.Namespace)
	return c.WriteJSON(map[string]bool{"noNewStreams": *body.NoNewStreams})
}

// WatchSetMax sets the cap on the total streams kept in the list (the UI
// stepper). Body: {"max": N}. The manager clamps to its allowed range and
// returns the applied value.
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

// WatchClear removes ended (terminal) streams from the session list. With an
// empty body it clears every session; with {"context","namespace"} it clears
// only that one session. Log files are kept.
func (h *handlers) WatchClear(c rweb.Context) error {
	var body watchSessionBody
	if raw := c.Request().Body(); len(bytes.TrimSpace(raw)) > 0 {
		if err := json.NewDecoder(bytes.NewReader(raw)).Decode(&body); err != nil {
			return writeJSONErr(c, http.StatusBadRequest, serr.Wrap(err, "invalid JSON"))
		}
	}
	return c.WriteJSON(map[string]int{"removed": h.mgr.ClearTerminal(body.Context, body.Namespace)})
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
	return sendLogDownload(c, path, "read watch log file")
}

// LogsCaptureDownload serves a Logs-modal capture file (everything that view
// has streamed, see podwatch.LiveCaptures) as a download. The capture may
// still be growing; the download is a consistent snapshot of it as of the
// request.
// GET /api/logs/capture?id=..
func (h *handlers) LogsCaptureDownload(c rweb.Context) error {
	id := c.Request().QueryParam("id")
	if !podwatch.ValidLiveCaptureID(id) {
		return writeJSONErr(c, http.StatusBadRequest, serr.New("a valid capture id is required"))
	}
	// As with WatchExport, the ID only selects among paths the manager
	// built itself; it never becomes part of a path.
	path, err := h.mgr.Live().ExportPath(id)
	if err != nil {
		return writeJSONErr(c, watchErrStatus(err), err)
	}
	return sendLogDownload(c, path, "read live log capture")
}

// sendLogDownload streams a log file to the client as an attachment.
//
// rweb.SendFileAs opens and stats the file up front, then copies exactly that
// many bytes to the connection after the handler returns (sendfile(2) on
// plain TCP). Two properties matter for capture files:
//   - memory stays flat no matter how large a long-running pod's log grew
//     (the previous os.ReadFile approach held the whole file in RAM);
//   - the size is fixed at stat time, so lines appended mid-download are not
//     chased — the client gets a clean snapshot with a correct Content-Length.
//
// rweb treats .log as viewable text and sets no Content-Disposition, so it is
// set here to force a save. no-store keeps WKWebView/browsers from answering
// a repeat download of a grown file with a cached copy (or a 304 via the
// Last-Modified header SendFileAs adds).
func sendLogDownload(c rweb.Context, path, what string) error {
	// Stat before setting the attachment headers so an error answer is a
	// plain JSON response rather than an error body saved as the "log".
	if _, err := os.Stat(path); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, os.ErrNotExist) {
			status = http.StatusNotFound // pruned by retention/cleanup
		}
		return writeJSONErr(c, status, serr.Wrap(err, what))
	}
	res := c.Response()
	// The filename is built from sanitized segments, so it is quote-safe.
	res.SetHeader("Content-Disposition", `attachment; filename="`+filepath.Base(path)+`"`)
	res.SetHeader("Cache-Control", "no-store")
	// The file could still vanish between Stat and open (a cleanup racing
	// the click); that rare case surfaces as a handler error.
	if err := rweb.SendFileAs(c, path, filepath.Base(path)); err != nil {
		return serr.Wrap(err, what)
	}
	return nil
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
