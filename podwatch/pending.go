package podwatch

import (
	"sort"
	"time"
)

// Pending pods: the stream-cap wait queue.
//
// When every slot under the stream cap is held by an *active* stream,
// startStream cannot evict anything, so a newly created pod is queued in
// Session.pending instead of being dropped. The queue is drained explicitly
// rather than waiting for the next periodic re-list:
//
//	slot frees (stream ends / user stop /     kickPending()           watch loop
//	session stop / cap raised / DND off) ───► non-blocking send ───► select on
//	                                          on each session's      sess.slotFreed
//	                                          slotFreed (cap 1)      → retryPending
//
// Design choices:
//   - The retry runs on the session's own watch-loop goroutine, never on the
//     goroutine that freed the slot. startStream may write sess.baseline
//     (do-not-disturb), and baseline is read lock-free by the watch loop, so
//     keeping every startStream call on that one goroutine preserves the
//     single-writer invariant documented on Session.baseline.
//   - slotFreed is buffered with capacity 1 and sent to without blocking:
//     several slots freeing in a burst coalesce into one wakeup, and
//     retryPending then admits as many pods as there are free slots.
//   - The cap is global across sessions, so a slot freed in one namespace
//     wakes every session that has pods waiting. They race for the slot;
//     startStream re-checks the cap under Manager.mu, so a loser simply stays
//     queued (silently — limit_reached fires only on a pod's first skip).
//   - Entries leave the queue when admitted (startStream), when the pod is
//     deleted (watch Deleted event), or when a re-list no longer finds it.
//     Without that pruning, a queued pod deleted during a watch gap would be
//     "admitted" later and fail straight into an error row.

// PendingPod is one pod waiting for a stream slot, for status payloads.
type PendingPod struct {
	Pod   string    `json:"pod"`
	Since time.Time `json:"since"` // when it first hit the cap
}

// kickPending wakes the watch loop of every session that has pods waiting,
// so they retry admission now that a slot may have freed. Must be called
// without holding any Stream.mu (lock order is Manager.mu before Stream.mu).
func (m *Manager) kickPending() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, sess := range m.sessions {
		if len(sess.pending) > 0 {
			sess.kick()
		}
	}
}

// kick signals the session's watch loop without blocking. A nil channel
// (sessions built directly in tests) makes the send never ready, so the
// default branch drops the signal harmlessly.
func (sess *Session) kick() {
	select {
	case sess.slotFreed <- struct{}{}:
	default: // a wakeup is already queued; it will cover this one too
	}
}

// pendingOldestFirstLocked lists the session's waiting pods in arrival
// order. Caller holds Manager.mu.
func (sess *Session) pendingOldestFirstLocked() []PendingPod {
	out := make([]PendingPod, 0, len(sess.pending))
	for pod, since := range sess.pending {
		out = append(out, PendingPod{Pod: pod, Since: since})
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Since.Equal(out[j].Since) {
			return out[i].Since.Before(out[j].Since)
		}
		return out[i].Pod < out[j].Pod
	})
	return out
}

// retryPending tries to admit the session's waiting pods, oldest first, for
// as long as slots are free. Runs on the session's watch-loop goroutine (see
// the file comment). Skipped under do-not-disturb: queued pods are held, not
// started, until DND is turned off (SetNoNewStreams kicks on that edge).
func (m *Manager) retryPending(sess *Session) {
	m.mu.Lock()
	if sess.noNewStreams || len(sess.pending) == 0 {
		m.mu.Unlock()
		return
	}
	queue := sess.pendingOldestFirstLocked()
	m.mu.Unlock()

	for _, p := range queue {
		// Cheap pre-check so a still-full cap stops the pass at the first
		// pod instead of re-queueing every one of them. startStream repeats
		// the check under the same lock, so the race with another session
		// taking the slot in between is still handled correctly there.
		m.mu.Lock()
		full := m.activeStreamCountLocked() >= m.maxStreamsNow()
		m.mu.Unlock()
		if full {
			return
		}
		m.startStream(sess, p.Pod)
	}
}

// dropPending removes pods from the session's wait queue (deleted pods, or
// pods a re-list no longer finds) and tells the UI if the queue changed.
func (m *Manager) dropPending(sess *Session, pods ...string) {
	m.mu.Lock()
	removed := 0
	for _, pod := range pods {
		if _, ok := sess.pending[pod]; ok {
			delete(sess.pending, pod)
			removed++
		}
	}
	waiting := len(sess.pending)
	m.mu.Unlock()
	if removed > 0 {
		m.notifyEvent("pending_changed", map[string]any{
			"context": sess.Context, "namespace": sess.Namespace, "waiting": waiting,
		})
	}
}

// prunePendingNotIn drops queued pods missing from a fresh pod list (deleted
// while the watch was down, so no Deleted event was seen).
func (m *Manager) prunePendingNotIn(sess *Session, present map[string]struct{}) {
	m.mu.Lock()
	var gone []string
	for pod := range sess.pending {
		if _, ok := present[pod]; !ok {
			gone = append(gone, pod)
		}
	}
	m.mu.Unlock()
	if len(gone) > 0 {
		m.dropPending(sess, gone...)
	}
}
