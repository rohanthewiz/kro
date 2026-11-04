package podwatch

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// eventLog records notifyEvent calls so tests can assert which events fired.
type eventLog struct {
	mu     sync.Mutex
	events []string
}

func (l *eventLog) hook(m *Manager) {
	m.SetNotify(func(event string, _ any) {
		l.mu.Lock()
		l.events = append(l.events, event)
		l.mu.Unlock()
	})
}

func (l *eventLog) count(event string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, e := range l.events {
		if e == event {
			n++
		}
	}
	return n
}

// fillToCap adds running streams until every slot is held by an active one.
func fillToCap(m *Manager, sess *Session) {
	for i := 0; m.Status().ActiveStreams < m.maxStreamsNow(); i++ {
		pod := fmt.Sprintf("run-%d", i)
		sess.streams[pod] = &Stream{Pod: pod, state: StateRunning, StartedAt: time.Now()}
	}
}

// breakLogDir points the manager at a regular file, so openLogFile fails and
// an admitted stream goes straight to StateError without spawning runStream
// (which would need a real kube client). Admission bookkeeping still runs.
func breakLogDir(t *testing.T, m *Manager) {
	t.Helper()
	f := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(f, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	m.logDir = f
}

func drained(sess *Session) bool {
	select {
	case <-sess.slotFreed:
		return true
	default:
		return false
	}
}

func TestPendingQueuedAtCapAndAnnouncedOnce(t *testing.T) {
	m, sess := newTestSession(t)
	m.SetMaxStreams(2)
	fillToCap(m, sess)
	var log eventLog
	log.hook(m)

	m.startStream(sess, "late-a")
	m.startStream(sess, "late-b")
	m.startStream(sess, "late-a") // retry while still full: must stay silent

	if got := log.count("limit_reached"); got != 2 {
		t.Errorf("limit_reached fired %d times, want 2 (once per pod)", got)
	}
	st := m.Status()
	if st.PendingPods != 2 {
		t.Errorf("PendingPods = %d, want 2", st.PendingPods)
	}
	p := st.Sessions[0].Pending
	if len(p) != 2 || p[0].Pod != "late-a" || p[1].Pod != "late-b" {
		t.Errorf("session pending = %+v, want [late-a late-b] oldest first", p)
	}
	if _, ok := sess.streams["late-a"]; ok {
		t.Error("queued pod must not be registered as a stream")
	}
}

func TestKickOnSlotFreeingEvents(t *testing.T) {
	m, sess := newTestSession(t)
	m.SetMaxStreams(1)
	fillToCap(m, sess)
	drained(sess)

	// No pending pods: freeing a slot doesn't wake the loop.
	m.kickPending()
	if drained(sess) {
		t.Error("kick with an empty queue should not signal")
	}

	m.startStream(sess, "waiting")
	m.SetMaxStreams(3) // raising the cap is a slot-freeing event
	if !drained(sess) {
		t.Error("raising the cap must wake the watch loop")
	}

	// Bursts coalesce: two kicks leave exactly one queued wakeup.
	m.kickPending()
	m.kickPending()
	if !drained(sess) || drained(sess) {
		t.Error("kicks must coalesce into a single buffered wakeup")
	}

	// A user stop on an active stream frees a slot.
	if err := m.StreamAction("c1", "n1", "run-0", "stop"); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if !drained(sess) {
		t.Error("stopping an active stream must wake the watch loop")
	}
}

func TestRetryPendingAdmitsWhenSlotFrees(t *testing.T) {
	m, sess := newTestSession(t)
	m.SetMaxStreams(2)
	fillToCap(m, sess)
	m.startStream(sess, "q1")
	m.startStream(sess, "q2")

	// Still full: retry leaves the queue as-is.
	m.retryPending(sess)
	if len(m.Status().Sessions[0].Pending) != 2 {
		t.Fatal("retry with no free slot must keep both pods queued")
	}

	// Free a slot. Each admission errors on open (broken log dir) and so
	// releases the slot again, letting the pass admit both in turn. The
	// whole-list cap then evicts the oldest ended row to fit q2 — which is
	// q1's error row — so admissions are counted via events, not the list.
	breakLogDir(t, m)
	var log eventLog
	log.hook(m)
	sess.streams["run-0"].state = StateCompleted
	m.retryPending(sess)
	if got := log.count("stream_state"); got != 2 {
		t.Errorf("admissions = %d, want 2 (q1 then q2)", got)
	}
	if _, ok := sess.streams["q2"]; !ok {
		t.Error("q2 should be in the list")
	}
	if n := m.Status().PendingPods; n != 0 {
		t.Errorf("PendingPods = %d after admission, want 0", n)
	}
}

func TestPendingHeldUnderDoNotDisturb(t *testing.T) {
	m, sess := newTestSession(t)
	m.SetMaxStreams(1)
	fillToCap(m, sess)
	m.startStream(sess, "queued")
	drained(sess)

	if err := m.SetNoNewStreams("c1", "n1", true); err != nil {
		t.Fatal(err)
	}
	// Re-list under DND calls startStream again: the queued pod predates DND,
	// so it must stay queued rather than join the baseline.
	m.startStream(sess, "queued")
	if _, ok := sess.baseline["queued"]; ok {
		t.Error("a pod queued before DND must not be baselined by DND")
	}
	sess.streams["run-0"].state = StateCompleted
	m.retryPending(sess)
	if _, ok := sess.streams["queued"]; ok {
		t.Error("DND must hold queued pods, not admit them")
	}

	// A genuinely new pod under DND is still baselined as before.
	m.startStream(sess, "fresh")
	if _, ok := sess.baseline["fresh"]; !ok {
		t.Error("a new pod under DND must still be baselined")
	}

	if err := m.SetNoNewStreams("c1", "n1", false); err != nil {
		t.Fatal(err)
	}
	if !drained(sess) {
		t.Error("turning DND off with pods queued must wake the watch loop")
	}
}

func TestDropAndPrunePending(t *testing.T) {
	m, sess := newTestSession(t)
	m.SetMaxStreams(1)
	fillToCap(m, sess)
	for _, pod := range []string{"a", "b", "c"} {
		m.startStream(sess, pod)
	}
	var log eventLog
	log.hook(m)

	m.dropPending(sess, "a", "not-queued")
	if _, ok := sess.pending["a"]; ok {
		t.Error("dropped pod should leave the queue")
	}
	m.dropPending(sess, "not-queued") // no change → no event
	if got := log.count("pending_changed"); got != 1 {
		t.Errorf("pending_changed fired %d times, want 1", got)
	}

	m.prunePendingNotIn(sess, map[string]struct{}{"b": {}})
	if _, ok := sess.pending["c"]; ok {
		t.Error("pod missing from the re-list should be pruned")
	}
	if _, ok := sess.pending["b"]; !ok {
		t.Error("pod still present in the re-list should stay queued")
	}
}
