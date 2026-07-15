package podwatch

import (
	"math/rand/v2"
	"time"

	"github.com/rohanthewiz/logger"
	coreV1 "k8s.io/api/core/v1"
	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"
)

const (
	watchBackoffMin = time.Second
	watchBackoffMax = 30 * time.Second

	// watchTimeout{Min,Max}Secs bound the server-requested lifetime of each
	// watch connection. Kept under common API-server load-balancer idle
	// timeouts (the AWS NLB fronting EKS silently blackholes a flow idle past
	// 350s, never sending a FIN) so a watch is torn down and re-established
	// before it can wedge on a stale connection with ResultChan blocked
	// forever. Jittered so many sessions don't re-list in lockstep.
	watchTimeoutMinSecs = 240
	watchTimeoutMaxSecs = 300

	// watchStallGrace is how long past the requested timeout the watchdog
	// waits for the channel to close on its own before forcing it — the
	// backstop for when the server-side close never reaches us.
	watchStallGrace = 30 * time.Second
)

// watchTimeoutSecs returns a jittered watch timeout, in seconds, within
// [watchTimeoutMinSecs, watchTimeoutMaxSecs].
func watchTimeoutSecs() int64 {
	return int64(watchTimeoutMinSecs + rand.IntN(watchTimeoutMaxSecs-watchTimeoutMinSecs+1))
}

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

		timeout := watchTimeoutSecs()
		w, err := sess.client.CoreV1().Pods(sess.Namespace).Watch(sess.ctx, metaV1.ListOptions{
			ResourceVersion:     rv,
			AllowWatchBookmarks: true,
			TimeoutSeconds:      &timeout,
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

		// Backstop for a wedged watch: if the server-side close never reaches
		// us (a half-open connection silently dropped by a proxy or load
		// balancer), the range below would block forever and the watch would
		// go deaf to new pods. Force it closed a little past the requested
		// timeout so the loop re-lists and reconnects. Idempotent with the
		// w.Stop() after the range.
		watchdog := time.AfterFunc(time.Duration(timeout)*time.Second+watchStallGrace, w.Stop)

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
		watchdog.Stop()
		w.Stop()
		// Channel closed (server timeout, network blip, error event, or the
		// watchdog forcing a stalled connection): re-list to catch pods
		// created during the gap.
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
