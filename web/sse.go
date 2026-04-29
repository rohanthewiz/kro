package web

import (
	"encoding/json"
	"time"

	"kro/kube"

	"github.com/rohanthewiz/logger"
	"github.com/rohanthewiz/rweb"
	"github.com/rohanthewiz/serr"
	"k8s.io/client-go/kubernetes"
)

const snapshotInterval = 10 * time.Second

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
