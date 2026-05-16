package web

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"kro/kube"

	"github.com/rohanthewiz/logger"
	"github.com/rohanthewiz/rweb"
	"github.com/rohanthewiz/serr"
	"k8s.io/client-go/kubernetes"
)

const termCmdMaxLen = 4096

const snapshotInterval = 10 * time.Second

const metricsPollInterval = 10 * time.Second

// SSE streams resource-tree snapshots for the cookie-selected (context,
// namespace) of the connecting client. Each connection has its own goroutine
// and selection — multiple tabs can target different clusters/namespaces.
//
// rweb.SSEHub broadcasts identical payloads to all clients, which doesn't fit
// per-tab targeting, so we wire SetupSSE directly with a per-client channel.
// When the client disconnects, rweb closes the response writer; the producer
// goroutine exits on the next send via the stop channel sent from a deferred
// close in the request handler. (rweb's SetupSSE blocks until disconnect.)
func (h *handlers) SSE(svr *rweb.Server) rweb.Handler {
	return func(c rweb.Context) error {
		sel, err := h.resolve(c)
		if err != nil {
			return writeTextErr(c, 503, err.Error())
		}
		client, err := h.reg.Client(sel.Context)
		if err != nil {
			return writeTextErr(c, 502, err.Error())
		}

		evCh := make(chan any, 4)
		stop := make(chan struct{})

		go produceSnapshots(client, sel, evCh, stop)

		// SetupSSE blocks until the client disconnects.
		serveErr := svr.SetupSSE(c, evCh, "resources_snapshot")
		close(stop)
		return serveErr
	}
}

func produceSnapshots(client *kubernetes.Clientset, sel kube.Selection, out chan<- any, stop <-chan struct{}) {
	send := func() {
		tree, err := kube.ListResources(client, sel.Namespace)
		if err != nil {
			logger.WarnF("sse list failed for %s/%s: %v", sel.Context, sel.Namespace, err)
			return
		}
		tree.Context = sel.Context
		tree.Namespace = sel.Namespace
		payload, err := json.Marshal(tree)
		if err != nil {
			logger.LogErr(serr.Wrap(err, "sse marshal"))
			return
		}
		select {
		case out <- rweb.SSEvent{Type: "resources_snapshot", Data: string(payload)}:
		case <-stop:
		}
	}

	send()
	t := time.NewTicker(snapshotInterval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			send()
		}
	}
}

// LogsSSE streams live pod logs (all containers, follow mode) for the
// duration of the SSE connection. Each line is delivered as a "log" SSE
// event.
//
// Why a per-request SSEHub instead of a plain channel + SetupSSE: rweb's
// SetupSSE returns immediately (the actual pump runs later in the response
// phase), so there is no public hook tying handler return to client
// disconnect. SSEHub.Handler installs an internal cleanup callback that
// fires when the SSE pump actually exits, and SSEHubOptions.OnDisconnect
// surfaces it to us — which is what we use to cancel the kube log stream.
func (h *handlers) LogsSSE(svr *rweb.Server) rweb.Handler {
	return func(c rweb.Context) error {
		name := c.Request().QueryParam("name")
		if name == "" {
			return writeTextErr(c, 400, "name is required")
		}
		sel, err := h.resolve(c)
		if err != nil {
			return writeTextErr(c, 503, err.Error())
		}
		client, err := h.reg.Client(sel.Context)
		if err != nil {
			return writeTextErr(c, 502, err.Error())
		}

		streamCtx, cancel := context.WithCancel(context.Background())

		var hub *rweb.SSEHub
		hub = rweb.NewSSEHub(rweb.SSEHubOptions{
			ChannelSize:       256,
			HeartbeatInterval: 30 * time.Second,
			OnDisconnect: func() {
				cancel()
				if hub != nil {
					hub.Close()
				}
			},
		})

		// hub.Handler installs the per-client channel + cleanup hook and
		// configures SSE on the context. It returns immediately; the
		// actual pump runs later in the response phase. Register the
		// client first so the producer's first lines aren't broadcast
		// to an empty hub.
		setupErr := hub.Handler(svr, "log")(c)
		if setupErr != nil {
			cancel()
			hub.Close()
			return setupErr
		}

		go produceLogStream(streamCtx, client, sel.Namespace, name, hub)
		return nil
	}
}

// TermSSE runs `kubectl --context --namespace <cmd>` and streams its
// stdout/stderr line-by-line to the browser as SSE events:
//
//	event: stdout|stderr  → data: "<line>"
//	event: done           → data: "<exit-code>"
//
// Disconnect cancels the underlying process via context, matching LogsSSE.
func (h *handlers) TermSSE(svr *rweb.Server) rweb.Handler {
	return func(c rweb.Context) error {
		raw := c.Request().QueryParam("cmd")
		if raw == "" {
			return writeTextErr(c, 400, "cmd is required")
		}
		if len(raw) > termCmdMaxLen {
			return writeTextErr(c, 400, "cmd too long")
		}
		args, err := kube.TokenizeArgs(raw)
		if err != nil {
			return writeTextErr(c, 400, err.Error())
		}
		if len(args) == 0 {
			return writeTextErr(c, 400, "empty command")
		}

		sel, err := h.resolve(c)
		if err != nil {
			return writeTextErr(c, 503, err.Error())
		}

		streamCtx, cancel := context.WithCancel(context.Background())

		var hub *rweb.SSEHub
		hub = rweb.NewSSEHub(rweb.SSEHubOptions{
			ChannelSize:       256,
			HeartbeatInterval: 30 * time.Second,
			OnDisconnect: func() {
				cancel()
				if hub != nil {
					hub.Close()
				}
			},
		})

		setupErr := hub.Handler(svr, "stdout")(c)
		if setupErr != nil {
			cancel()
			hub.Close()
			return setupErr
		}

		go produceTermStream(streamCtx, sel.Context, sel.Namespace, args, hub)
		return nil
	}
}

func produceTermStream(ctx context.Context, ctxName, ns string, args []string, hub *rweb.SSEHub) {
	events := make(chan kube.TermEvent, 64)
	done := make(chan struct{})
	go func() {
		defer close(done)
		kube.RunKubectl(ctx, ctxName, ns, args, events)
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-events:
			switch ev.Stream {
			case "done":
				hub.BroadcastRaw(rweb.SSEvent{Type: "done", Data: fmt.Sprintf("%d", ev.ExitCode)})
			default:
				hub.BroadcastRaw(rweb.SSEvent{Type: ev.Stream, Data: ev.Line})
			}
		case <-done:
			// Drain any remaining buffered events before returning.
			for {
				select {
				case ev := <-events:
					switch ev.Stream {
					case "done":
						hub.BroadcastRaw(rweb.SSEvent{Type: "done", Data: fmt.Sprintf("%d", ev.ExitCode)})
					default:
						hub.BroadcastRaw(rweb.SSEvent{Type: ev.Stream, Data: ev.Line})
					}
				default:
					return
				}
			}
		}
	}
}

// MetricsSSE polls metrics.k8s.io for a single pod every metricsPollInterval
// and pushes each sample as a "metrics" event. Mirrors LogsSSE's per-request
// SSEHub so disconnect cancels the polling goroutine.
func (h *handlers) MetricsSSE(svr *rweb.Server) rweb.Handler {
	return func(c rweb.Context) error {
		name := c.Request().QueryParam("name")
		if name == "" {
			return writeTextErr(c, 400, "name is required")
		}
		sel, err := h.resolve(c)
		if err != nil {
			return writeTextErr(c, 503, err.Error())
		}
		client, err := h.reg.Client(sel.Context)
		if err != nil {
			return writeTextErr(c, 502, err.Error())
		}

		streamCtx, cancel := context.WithCancel(context.Background())

		var hub *rweb.SSEHub
		hub = rweb.NewSSEHub(rweb.SSEHubOptions{
			ChannelSize:       16,
			HeartbeatInterval: 30 * time.Second,
			OnDisconnect: func() {
				cancel()
				if hub != nil {
					hub.Close()
				}
			},
		})

		setupErr := hub.Handler(svr, "metrics")(c)
		if setupErr != nil {
			cancel()
			hub.Close()
			return setupErr
		}

		go produceMetricsStream(streamCtx, client, sel.Namespace, name, hub)
		return nil
	}
}

func produceMetricsStream(ctx context.Context, client *kubernetes.Clientset, ns, name string, hub *rweb.SSEHub) {
	send := func() {
		sample, err := kube.PodMetrics(ctx, client, ns, name)
		if err != nil {
			payload, _ := json.Marshal(map[string]string{"error": err.Error()})
			hub.BroadcastRaw(rweb.SSEvent{Type: "error", Data: string(payload)})
			return
		}
		payload, err := json.Marshal(sample)
		if err != nil {
			logger.LogErr(serr.Wrap(err, "marshal metrics sample"))
			return
		}
		hub.BroadcastRaw(rweb.SSEvent{Type: "metrics", Data: string(payload)})
	}

	send()
	t := time.NewTicker(metricsPollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			send()
		}
	}
}

func produceLogStream(ctx context.Context, client *kubernetes.Clientset, ns, name string, hub *rweb.SSEHub) {
	lines := make(chan kube.LogLine, 64)
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := kube.StreamPodLogs(ctx, client, ns, name, lines); err != nil {
			hub.BroadcastRaw(rweb.SSEvent{Type: "log", Data: fmt.Sprintf("(error opening log stream: %v)", err)})
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case ln := <-lines:
			data := ln.Line
			if ln.Container != "" {
				data = "[" + ln.Container + "] " + data
			}
			hub.BroadcastRaw(rweb.SSEvent{Type: "log", Data: data})
		}
	}
}
