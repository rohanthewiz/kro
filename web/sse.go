package web

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"kro/kube"
	"kro/podwatch"

	"github.com/rohanthewiz/logger"
	"github.com/rohanthewiz/rweb"
	"github.com/rohanthewiz/serr"
	"k8s.io/client-go/kubernetes"
)

const termCmdMaxLen = 4096

const snapshotInterval = 10 * time.Second

const metricsPollInterval = 10 * time.Second

// snapshotErrBackoffMax caps how far produceSnapshots backs off while the
// cluster keeps failing. It has to stay under the page's 60s heartbeat
// watchdog minus kube.ListTimeout (15s): a failing attempt takes up to the
// list timeout, and the page must still hear something (the error event)
// within its watchdog window, or it would reconnect and reset the backoff.
const snapshotErrBackoffMax = 30 * time.Second

// SSE event types on /sse/resources. The page (resources.js) listens for each
// by name.
const (
	evResourcesSnapshot = "resources_snapshot" // data: the ResourceTree JSON
	evResourcesTick     = "resources_tick"     // data: unix seconds; "checked, nothing changed"
	evResourcesError    = "resources_error"    // data: {"error": "..."}; the list failed
)

// SSE streams resource-tree snapshots for the cookie-selected (context,
// namespace) of the connecting client. Each connection has its own producer
// goroutine and selection — multiple tabs can target different
// clusters/namespaces. rweb.SSEHub broadcasts identical payloads to all
// clients, which doesn't fit per-tab targeting, so SetupSSE is wired directly
// with a per-client channel.
//
// Producer lifetime: rweb's SetupSSE only records the channel and returns; the
// pump that writes events runs afterward, in the response phase. So the
// producer cannot be stopped "when SetupSSE returns" — an earlier version did
// exactly that, which cancelled it before its first list finished and left the
// page with one snapshot per connection. It is tied to the request context
// instead, which rweb keeps alive for the whole event stream and cancels when
// the stream ends (client gone, or server shutdown):
//
//	handler ── c.Request().Context() ──┐
//	   │                               ▼
//	   └─ SetupSSE(evCh) ──► returns   produceSnapshots(ctx) ──► evCh ──► pump ──► client
//	                                   ▲                                    │
//	                                   └──────── ctx cancelled ◄── stream ends
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

		// The request context must be obtained inside the handler, but is
		// safe to use from the producer goroutine after the handler returns.
		reqCtx := c.Request().Context()

		// Small buffer: the producer emits one event per interval, so this
		// only absorbs a briefly slow client. A client that stops reading
		// blocks the producer in emit (no further cluster calls are made on
		// its behalf) until it catches up or disconnects.
		evCh := make(chan any, 4)
		interval := h.snapshotEvery
		if interval <= 0 {
			interval = snapshotInterval
		}
		go produceSnapshots(reqCtx, client, sel, evCh, interval)

		return svr.SetupSSE(c, evCh, evResourcesSnapshot)
	}
}

// produceSnapshots lists the selection's resources every interval and emits
// the result on out until ctx is cancelled.
//
// Three outcomes per round:
//   - the tree changed (or this is the first round): a full snapshot event;
//   - the tree is byte-identical to the last one sent: a tiny tick event, so
//     the page can skip parsing and re-rendering but still knows the stream
//     is alive (its heartbeat watchdog would otherwise reconnect);
//   - the list failed as a whole: an error event, with the wait before the
//     next attempt doubling up to snapshotErrBackoffMax so an unreachable
//     cluster is not dialed 13 times every interval indefinitely.
//
// "Changed" is decided on the marshalled JSON, which includes the formatted
// age strings; a quiet namespace therefore still produces a snapshot whenever
// an age rolls over (every second for a pod under a minute old, every minute
// under an hour, and so on). That is what keeps the Age column moving.
//
// Log lines are written on transitions only (first failure, a different
// failure, recovery, a changed warning set). At one round every ten seconds
// per open tab, logging every round would bury kro.log.
func produceSnapshots(ctx context.Context, client kubernetes.Interface, sel kube.Selection, out chan<- any, interval time.Duration) {
	var (
		lastSum      [sha256.Size]byte // digest of the last snapshot payload sent
		haveLast     bool              // false until a snapshot is sent, and again after an error
		lastErrMsg   string            // last failure logged ("" while healthy)
		lastWarnings string            // last per-kind warning set logged
	)

	// emit delivers one event unless the client has gone; false means stop.
	emit := func(evType, data string) bool {
		select {
		case out <- rweb.SSEvent{Type: evType, Data: data}:
			return true
		case <-ctx.Done():
			return false
		}
	}

	// round runs one list and emits its outcome. ok=false means the client
	// has gone; failed reports a cluster-level failure (drives the backoff).
	round := func() (ok, failed bool) {
		tree, err := kube.ListResources(ctx, client, sel.Namespace)
		if ctx.Err() != nil {
			return false, false // cancelled mid-list: nothing worth reporting
		}
		if err != nil {
			msg := err.Error()
			if msg != lastErrMsg {
				logger.WarnF("resources stream %s/%s: %s", sel.Context, sel.Namespace, msg)
				lastErrMsg = msg
			}
			// Forget the last digest: when the cluster comes back, the page
			// must get a full snapshot to clear its error banner, even if
			// the tree is identical to the one from before the outage.
			haveLast = false
			payload, _ := json.Marshal(map[string]string{"error": msg})
			return emit(evResourcesError, string(payload)), true
		}
		if lastErrMsg != "" {
			logger.InfoF("resources stream %s/%s: recovered", sel.Context, sel.Namespace)
			lastErrMsg = ""
		}
		if w := strings.Join(tree.Warnings, "; "); w != lastWarnings {
			if w != "" {
				logger.WarnF("resources stream %s/%s: %s", sel.Context, sel.Namespace, w)
			}
			lastWarnings = w
		}

		tree.Context = sel.Context
		tree.Namespace = sel.Namespace
		payload, err := json.Marshal(tree)
		if err != nil {
			logger.LogErr(serr.Wrap(err, "sse marshal"))
			return true, false
		}
		if sum := sha256.Sum256(payload); !haveLast || sum != lastSum {
			lastSum, haveLast = sum, true
			return emit(evResourcesSnapshot, string(payload)), false
		}
		return emit(evResourcesTick, strconv.FormatInt(time.Now().Unix(), 10)), false
	}

	// A timer rather than a ticker: the wait is measured from the end of one
	// round to the start of the next, so a slow list never has the next one
	// queued up behind it, and the error backoff is just a longer wait.
	wait := interval
	timer := time.NewTimer(0) // first round immediately
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		ok, failed := round()
		if !ok {
			return
		}
		if failed {
			wait = min(wait*2, max(interval, snapshotErrBackoffMax))
		} else {
			wait = interval
		}
		timer.Reset(wait)
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
//
// When the browser passes cap=<id>, every streamed line is also appended to a
// capture file (podwatch.LiveCaptures), so a long-running view keeps its whole
// history on disk and can be downloaded via /api/logs/capture. A "capture"
// event announces the file path once the capture is open. Capture failure is
// logged and otherwise ignored — the live view must not depend on disk.
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

		var capture *podwatch.LiveCapture
		if capID := c.Request().QueryParam("cap"); capID != "" {
			var capErr error
			capture, capErr = h.mgr.Live().Acquire(capID, sel.Context, sel.Namespace, name)
			if capErr != nil {
				logger.LogErr(serr.Wrap(capErr, "open live log capture"), "pod", name)
				capture = nil
			}
		}

		streamCtx, cancel := context.WithCancel(context.Background())

		var hub *rweb.SSEHub
		hub = rweb.NewSSEHub(rweb.SSEHubOptions{
			ChannelSize:       256,
			HeartbeatInterval: 30 * time.Second,
			OnDisconnect: func() {
				cancel()
				// Release after cancel: the producer may still write a
				// line or two while unwinding; WriteLine drops those
				// once the last writer has released.
				if capture != nil {
					capture.Release()
				}
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
			if capture != nil {
				capture.Release()
			}
			hub.Close()
			return setupErr
		}

		go produceLogStream(streamCtx, client, sel.Namespace, name, hub, capture)
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

// produceLogStream pumps one pod's follow stream into the hub and, when
// capture is non-nil, into its capture file. The file gets exactly the text
// the browser renders (container prefix included), so a download matches
// what was on screen — minus nothing, since the file is never trimmed.
//
// A capture that already holds stamped lines (a reconnect: EventSource's own
// retry, or the status pill) resumes the follow right after them via
// StreamOpts.ResumeAfter, instead of re-sending the 500-line tail into both
// the file and the browser's view. Lines the capture drops as repeats are
// still sent to the browser: the old connection was closed before this one
// opened, so the browser may not have received them.
func produceLogStream(ctx context.Context, client *kubernetes.Clientset, ns, name string, hub *rweb.SSEHub, capture *podwatch.LiveCapture) {
	if capture != nil {
		payload, _ := json.Marshal(map[string]string{"path": capture.Path})
		hub.BroadcastRaw(rweb.SSEvent{Type: "capture", Data: string(payload)})
	}

	lines := make(chan kube.LogLine, 64)
	done := make(chan struct{})
	go func() {
		defer close(done)
		tail := kube.StreamTailLines
		opts := kube.StreamOpts{TailLines: &tail}
		if capture != nil {
			opts.ResumeAfter = capture.ResumeAfter()
		}
		if err := kube.StreamPodLogsOpts(ctx, client, ns, name, opts, lines); err != nil {
			msg := fmt.Sprintf("(error opening log stream: %v)", err)
			if capture != nil {
				capture.WriteLine(msg)
			}
			hub.BroadcastRaw(rweb.SSEvent{Type: "log", Data: msg})
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
			if capture != nil {
				capture.WriteStamped(ln.Container, ln.TS, data)
			}
			hub.BroadcastRaw(rweb.SSEvent{Type: "log", Data: data})
		}
	}
}
