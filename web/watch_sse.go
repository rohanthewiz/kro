package web

import (
	"strconv"
	"time"

	"github.com/rohanthewiz/rweb"
)

// WatchLogsSSE tees one background watch stream to a console frame:
//
//	GET /sse/watch-logs?context=..&namespace=..&pod=..&tail=N&view=all|errors|warnings
//	event: log → data: "<line>"      (replay, then live)
//	event: end → data: "stream ended" (stream stopped/completed)
//
// view (default "all") picks which file the frame shows: the full log, or the
// untruncated errors/warnings companion. errors/warnings replay the whole
// companion file and filter live lines to that bucket.
//
// Replay is the in-memory ring for a live stream; for an already-ended
// stream it is the last tail lines of the log file (the client sends its
// console buffer size), so a stream that finished before the user got to
// it still shows its history.
//
// Identification is explicit (not cookies) because the watch session is
// bound to the selection it was started with. Same per-request hub pattern
// as LogsSSE: Manager.Subscribe snapshots the ring and registers the live
// channel atomically, and hub.Handler registers the SSE client before
// returning, so replay→live delivery has no gap.
func (h *handlers) WatchLogsSSE(svr *rweb.Server) rweb.Handler {
	return func(c rweb.Context) error {
		req := c.Request()
		ctxName := req.QueryParam("context")
		ns := req.QueryParam("namespace")
		pod := req.QueryParam("pod")
		if ctxName == "" || ns == "" || pod == "" {
			return writeTextErr(c, 400, "context, namespace, and pod are required")
		}

		tail, _ := strconv.Atoi(req.QueryParam("tail")) // 0 on absent/garbage → ring replay only
		// view selects the file: "" / "all" (full log), "errors", or "warnings".
		view := req.QueryParam("view")
		replay, live, unsub, err := h.mgr.Subscribe(ctxName, ns, pod, tail, view)
		if err != nil {
			return writeTextErr(c, 404, err.Error())
		}

		var hub *rweb.SSEHub
		hub = rweb.NewSSEHub(rweb.SSEHubOptions{
			ChannelSize:       256,
			HeartbeatInterval: 30 * time.Second,
			OnDisconnect: func() {
				unsub()
				if hub != nil {
					hub.Close()
				}
			},
		})

		setupErr := hub.Handler(svr, "log")(c)
		if setupErr != nil {
			unsub()
			hub.Close()
			return setupErr
		}

		go func() {
			for _, line := range replay {
				hub.BroadcastRaw(rweb.SSEvent{Type: "log", Data: line})
			}
			// live is closed by the manager when the stream stops or
			// completes, or by unsub on client disconnect.
			for line := range live {
				hub.BroadcastRaw(rweb.SSEvent{Type: "log", Data: line})
			}
			hub.BroadcastRaw(rweb.SSEvent{Type: "end", Data: "stream ended"})
		}()
		return nil
	}
}
