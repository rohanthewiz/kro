package podwatch

import (
	"time"

	"github.com/rohanthewiz/logger"
	coreV1 "k8s.io/api/core/v1"
	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"
)

const (
	watchBackoffMin = time.Second
	watchBackoffMax = 30 * time.Second
)

// runWatchLoop watches the session's namespace for pods and starts a log
// stream for every pod that was not present at watch start. Raw Watch with a
// reconnect loop (informers are overkill for one namespace): on any failure,
// closure, or 410 Gone we re-list, which both refreshes the resourceVersion
// and starts streams for pods created during the gap. rv is the
// resourceVersion from the initial list done in Start.
func (m *Manager) runWatchLoop(sess *Session, rv string) {
	backoff := watchBackoffMin
	needRelist := false

	for sess.ctx.Err() == nil {
		if needRelist {
			nrv, err := m.relistAndCatchUp(sess)
			if err != nil {
				if sess.ctx.Err() != nil {
					return
				}
				logger.WarnF("pod watch re-list failed for %s/%s: %v", sess.Context, sess.Namespace, err)
				if !sleepCtxDone(sess, backoff) {
					return
				}
				backoff = min(backoff*2, watchBackoffMax)
				continue
			}
			rv = nrv
			needRelist = false
			backoff = watchBackoffMin
		}

		w, err := sess.client.CoreV1().Pods(sess.Namespace).Watch(sess.ctx, metaV1.ListOptions{
			ResourceVersion:     rv,
			AllowWatchBookmarks: true,
		})
		if err != nil {
			if sess.ctx.Err() != nil {
				return
			}
			logger.WarnF("pod watch failed for %s/%s: %v", sess.Context, sess.Namespace, err)
			needRelist = true
			if !sleepCtxDone(sess, backoff) {
				return
			}
			backoff = min(backoff*2, watchBackoffMax)
			continue
		}
		backoff = watchBackoffMin

	events:
		for ev := range w.ResultChan() {
			switch ev.Type {
			case watch.Error:
				// Typically 410 Gone (resourceVersion expired) — re-list.
				break events
			case watch.Added:
				pod, ok := ev.Object.(*coreV1.Pod)
				if !ok {
					continue
				}
				rv = pod.ResourceVersion
				if _, existed := sess.baseline[pod.Name]; existed {
					continue
				}
				m.startStream(sess, pod.Name)
			case watch.Modified, watch.Deleted, watch.Bookmark:
				// Pod deletion ends its log stream naturally; we only need
				// these events to keep the resourceVersion fresh.
				if pod, ok := ev.Object.(*coreV1.Pod); ok {
					rv = pod.ResourceVersion
				}
			}
		}
		w.Stop()
		// Channel closed (server timeout, network blip, or error event):
		// re-list to catch pods created during the gap.
		needRelist = true
	}
}

// relistAndCatchUp lists the namespace and starts streams for any pod that is
// neither in the baseline nor already tracked (never re-baselines). Returns
// the fresh resourceVersion to watch from.
func (m *Manager) relistAndCatchUp(sess *Session) (string, error) {
	list, err := sess.client.CoreV1().Pods(sess.Namespace).List(sess.ctx, metaV1.ListOptions{})
	if err != nil {
		return "", err
	}
	for i := range list.Items {
		name := list.Items[i].Name
		if _, existed := sess.baseline[name]; existed {
			continue
		}
		m.startStream(sess, name) // no-op if already tracked
	}
	return list.ResourceVersion, nil
}

// sleepCtxDone waits d or until the session ends; false means the session ended.
func sleepCtxDone(sess *Session, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-sess.ctx.Done():
		return false
	}
}
