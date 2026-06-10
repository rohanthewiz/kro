package podwatch

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSanitize(t *testing.T) {
	cases := map[string]string{
		"my-pod-abc123":                       "my-pod-abc123",
		"arn:aws:eks:us-east-1:123:cluster/x": "arn_aws_eks_us-east-1_123_cluster_x",
		"a/b\\c":                              "a_b_c",
		"":                                    "_",
		".":                                   "_",
		"..":                                  "_",
		"web.v2_test":                         "web.v2_test",
	}
	for in, want := range cases {
		if got := sanitize(in); got != want {
			t.Errorf("sanitize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLogFilePath(t *testing.T) {
	ts := time.Date(2026, 6, 9, 15, 4, 5, 0, time.UTC)
	got := logFilePath("/base", "ctx:1", "ns", "pod-x", ts)
	want := filepath.Join("/base", "ctx_1", "ns", "pod-x-20260609-150405.log")
	if got != want {
		t.Errorf("logFilePath = %q, want %q", got, want)
	}
}

func TestDefaultLogDirEnvOverride(t *testing.T) {
	t.Setenv("KRO_WATCH_LOG_DIR", "/tmp/custom-watch")
	dir, err := DefaultLogDir()
	if err != nil || dir != "/tmp/custom-watch" {
		t.Errorf("DefaultLogDir with env = %q, %v", dir, err)
	}

	t.Setenv("KRO_WATCH_LOG_DIR", "")
	dir, err = DefaultLogDir()
	if err != nil {
		t.Fatalf("DefaultLogDir: %v", err)
	}
	if !strings.HasSuffix(dir, filepath.Join("kro", "watch-logs")) {
		t.Errorf("DefaultLogDir default = %q, want .../kro/watch-logs", dir)
	}
}

func TestRingWrapAndSnapshot(t *testing.T) {
	st := &Stream{state: StateRunning, subs: map[chan string]struct{}{}}
	total := ringLines + 25
	for i := 0; i < total; i++ {
		st.writeLine(fmt.Sprintf("line-%d", i))
	}
	st.mu.Lock()
	snap := st.ringSnapshotLocked()
	st.mu.Unlock()

	if len(snap) != ringLines {
		t.Fatalf("snapshot len = %d, want %d", len(snap), ringLines)
	}
	if snap[0] != fmt.Sprintf("line-%d", total-ringLines) {
		t.Errorf("oldest = %q, want line-%d", snap[0], total-ringLines)
	}
	if snap[len(snap)-1] != fmt.Sprintf("line-%d", total-1) {
		t.Errorf("newest = %q, want line-%d", snap[len(snap)-1], total-1)
	}
	if got := st.LineCount.Load(); got != int64(total) {
		t.Errorf("LineCount = %d, want %d", got, total)
	}
}

func TestWriteLineFlipsStartingToRunning(t *testing.T) {
	st := &Stream{state: StateStarting, subs: map[chan string]struct{}{}}
	if !st.writeLine("first") {
		t.Error("first writeLine should report the starting→running flip")
	}
	if st.writeLine("second") {
		t.Error("second writeLine should not report a flip")
	}
	if st.state != StateRunning {
		t.Errorf("state = %q, want running", st.state)
	}
}

func TestWriteLineDroppedWhenTerminal(t *testing.T) {
	st := &Stream{state: StateStopped}
	st.writeLine("late")
	if st.LineCount.Load() != 0 || len(st.ring) != 0 {
		t.Error("terminal stream should drop lines")
	}
}

// newTestSession builds a manager with one session and direct access to its
// internals — no kube client is needed for these paths.
func newTestSession(t *testing.T) (*Manager, *Session) {
	t.Helper()
	m := NewManager(nil, t.TempDir())
	ctx, cancel := context.WithCancel(context.Background())
	sess := &Session{
		Context: "c1", Namespace: "n1", StartedAt: time.Now(),
		ctx: ctx, cancel: cancel,
		baseline: map[string]struct{}{},
		streams:  map[string]*Stream{},
	}
	m.sessions[sessKey("c1", "n1")] = sess
	t.Cleanup(cancel)
	return m, sess
}

func TestActiveStreamCountAndCap(t *testing.T) {
	m, sess := newTestSession(t)
	states := []StreamState{
		StateStarting, StateRunning, StatePaused, // active
		StateCompleted, StateStopped, StateError, // not active
	}
	for i, s := range states {
		sess.streams[fmt.Sprintf("p%d", i)] = &Stream{Pod: fmt.Sprintf("p%d", i), state: s}
	}
	m.mu.Lock()
	got := m.activeStreamCountLocked()
	m.mu.Unlock()
	if got != 3 {
		t.Errorf("activeStreamCountLocked = %d, want 3", got)
	}

	// Fill to the cap with running streams; the next startStream must be
	// rejected with a limit_reached notification and no new entry.
	for i := len(states); m.Status().ActiveStreams < maxWatchStreams; i++ {
		sess.streams[fmt.Sprintf("p%d", i)] = &Stream{Pod: fmt.Sprintf("p%d", i), state: StateRunning}
	}
	var limited string
	m.SetNotify(func(event string, payload any) {
		if event == "limit_reached" {
			limited = payload.(map[string]any)["pod"].(string)
		}
	})
	before := len(sess.streams)
	m.startStream(sess, "one-too-many")
	if limited != "one-too-many" {
		t.Errorf("expected limit_reached for one-too-many, got %q", limited)
	}
	if len(sess.streams) != before {
		t.Error("over-cap pod must not be registered")
	}
}

func TestSubscribeReplayAndLive(t *testing.T) {
	m, sess := newTestSession(t)
	st := &Stream{Pod: "p", state: StateRunning, subs: map[chan string]struct{}{}}
	sess.streams["p"] = st
	st.writeLine("old-1")
	st.writeLine("old-2")

	replay, ch, cancel, err := m.Subscribe("c1", "n1", "p")
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	if len(replay) != 2 || replay[0] != "old-1" || replay[1] != "old-2" {
		t.Errorf("replay = %v", replay)
	}
	st.writeLine("live-1")
	select {
	case got := <-ch:
		if got != "live-1" {
			t.Errorf("live = %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("no live line delivered")
	}

	cancel()
	cancel() // idempotent
	if _, open := <-ch; open {
		t.Error("channel should be closed after cancel")
	}

	// Terminal stream: replay only, channel pre-closed, cancel after close is safe.
	st2 := &Stream{Pod: "done", state: StateRunning, subs: map[chan string]struct{}{}}
	sess.streams["done"] = st2
	st2.writeLine("only")
	st2.mu.Lock()
	st2.closeLocked(StateCompleted)
	st2.mu.Unlock()
	replay2, ch2, cancel2, err := m.Subscribe("c1", "n1", "done")
	if err != nil {
		t.Fatalf("Subscribe terminal: %v", err)
	}
	if len(replay2) != 1 || replay2[0] != "only" {
		t.Errorf("terminal replay = %v", replay2)
	}
	if _, open := <-ch2; open {
		t.Error("terminal subscribe channel should be closed")
	}
	cancel2()

	if _, _, _, err := m.Subscribe("c1", "n1", "missing"); err != ErrNoStream {
		t.Errorf("missing stream err = %v, want ErrNoStream", err)
	}
	if _, _, _, err := m.Subscribe("cX", "nX", "p"); err != ErrNoSession {
		t.Errorf("missing session err = %v, want ErrNoSession", err)
	}
}

func TestSubscriberClosedOnStreamClose(t *testing.T) {
	m, sess := newTestSession(t)
	st := &Stream{Pod: "p", state: StateRunning, subs: map[chan string]struct{}{}}
	sess.streams["p"] = st

	_, ch, cancel, err := m.Subscribe("c1", "n1", "p")
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	st.finalize(StateStopped, "stopped")
	// Drain marker then expect close.
	for {
		v, open := <-ch
		if !open {
			break
		}
		if !strings.HasPrefix(v, "--- stopped") {
			t.Errorf("unexpected line %q", v)
		}
	}
	cancel() // safe after manager closed the channel
}

func TestStreamActionTransitions(t *testing.T) {
	m, sess := newTestSession(t)
	st := &Stream{Pod: "p", state: StateRunning, subs: map[chan string]struct{}{}}
	sess.streams["p"] = st

	if err := m.StreamAction("c1", "n1", "p", "bogus"); err != ErrBadAction {
		t.Errorf("bogus action err = %v", err)
	}
	if err := m.StreamAction("c1", "n1", "p", "resume"); err != ErrBadTransition {
		t.Errorf("resume running err = %v, want ErrBadTransition", err)
	}
	if err := m.StreamAction("c1", "n1", "p", "remove"); err != ErrBadTransition {
		t.Errorf("remove running err = %v, want ErrBadTransition", err)
	}
	if err := m.StreamAction("c1", "n1", "p", "pause"); err != nil {
		t.Errorf("pause: %v", err)
	}
	if st.state != StatePaused {
		t.Errorf("state after pause = %q", st.state)
	}
	if err := m.StreamAction("c1", "n1", "p", "pause"); err != ErrBadTransition {
		t.Errorf("double pause err = %v, want ErrBadTransition", err)
	}
	if err := m.StreamAction("c1", "n1", "p", "stop"); err != nil {
		t.Errorf("stop paused: %v", err)
	}
	if st.state != StateStopped {
		t.Errorf("state after stop = %q", st.state)
	}
	if err := m.StreamAction("c1", "n1", "p", "remove"); err != nil {
		t.Errorf("remove stopped: %v", err)
	}
	if _, exists := sess.streams["p"]; exists {
		t.Error("stream should be removed")
	}
}

func TestFileWriteAndMarkers(t *testing.T) {
	dir := t.TempDir()
	path := logFilePath(dir, "c", "n", "pod", time.Now())
	f, w, err := openLogFile(path)
	if err != nil {
		t.Fatalf("openLogFile: %v", err)
	}
	st := &Stream{Pod: "pod", state: StateRunning, subs: map[chan string]struct{}{}, filePath: path, file: f, w: w}
	st.writeLine("hello")
	st.finalize(StateStopped, "stopped")

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	content := string(raw)
	if !strings.Contains(content, "hello\n") || !strings.Contains(content, "--- stopped ") {
		t.Errorf("log content = %q", content)
	}
	if st.file != nil || st.w != nil {
		t.Error("file handles should be nil after finalize")
	}
}
