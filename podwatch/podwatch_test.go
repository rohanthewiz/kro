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
	st := &Stream{state: StateRunning, subs: map[chan string]string{}}
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
	st := &Stream{state: StateStarting, subs: map[chan string]string{}}
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
	for i := len(states); m.Status().ActiveStreams < m.maxStreamsNow(); i++ {
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

func TestNoNewStreamsGate(t *testing.T) {
	m, sess := newTestSession(t)

	if err := m.SetNoNewStreams("c1", "n1", true); err != nil {
		t.Fatalf("SetNoNewStreams: %v", err)
	}
	if !m.Status().Sessions[0].NoNewStreams {
		t.Error("status must report noNewStreams on")
	}

	// While on, a new pod gets no stream and is baselined so it stays
	// ignored after the toggle turns off.
	m.startStream(sess, "quiet-pod")
	if _, exists := sess.streams["quiet-pod"]; exists {
		t.Error("pod must not get a stream while noNewStreams is on")
	}
	if _, baselined := sess.baseline["quiet-pod"]; !baselined {
		t.Error("pod skipped under noNewStreams must join the baseline")
	}

	if err := m.SetNoNewStreams("c1", "n1", false); err != nil {
		t.Fatalf("SetNoNewStreams off: %v", err)
	}
	if m.Status().Sessions[0].NoNewStreams {
		t.Error("status must report noNewStreams off")
	}

	if err := m.SetNoNewStreams("c1", "nope", true); err != ErrNoSession {
		t.Errorf("unknown session: got %v, want ErrNoSession", err)
	}
}

func TestSubscribeReplayAndLive(t *testing.T) {
	m, sess := newTestSession(t)
	st := &Stream{Pod: "p", state: StateRunning, subs: map[chan string]string{}}
	sess.streams["p"] = st
	st.writeLine("old-1")
	st.writeLine("old-2")

	replay, ch, cancel, err := m.Subscribe("c1", "n1", "p", 0, "")
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
	st2 := &Stream{Pod: "done", state: StateRunning, subs: map[chan string]string{}}
	sess.streams["done"] = st2
	st2.writeLine("only")
	st2.mu.Lock()
	st2.closeLocked(StateCompleted)
	st2.mu.Unlock()
	replay2, ch2, cancel2, err := m.Subscribe("c1", "n1", "done", 0, "")
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

	if _, _, _, err := m.Subscribe("c1", "n1", "missing", 0, ""); err != ErrNoStream {
		t.Errorf("missing stream err = %v, want ErrNoStream", err)
	}
	if _, _, _, err := m.Subscribe("cX", "nX", "p", 0, ""); err != ErrNoSession {
		t.Errorf("missing session err = %v, want ErrNoSession", err)
	}
}

func TestSubscriberClosedOnStreamClose(t *testing.T) {
	m, sess := newTestSession(t)
	st := &Stream{Pod: "p", state: StateRunning, subs: map[chan string]string{}}
	sess.streams["p"] = st

	_, ch, cancel, err := m.Subscribe("c1", "n1", "p", 0, "")
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
	st := &Stream{Pod: "p", state: StateRunning, subs: map[chan string]string{}}
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

func TestTailFile(t *testing.T) {
	dir := t.TempDir()

	// Multi-chunk: enough data that tailFile must walk back more than one
	// 64K chunk to satisfy the request.
	big := filepath.Join(dir, "big.log")
	var sb strings.Builder
	total := 8000 // ~8000 * ~16B ≈ 128K
	for i := 0; i < total; i++ {
		fmt.Fprintf(&sb, "line-%07d\n", i)
	}
	if err := os.WriteFile(big, []byte(sb.String()), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := tailFile(big, 3)
	if err != nil {
		t.Fatalf("tailFile: %v", err)
	}
	want := []string{"line-0007997", "line-0007998", "line-0007999"}
	if len(got) != 3 || got[0] != want[0] || got[2] != want[2] {
		t.Errorf("tail 3 = %v, want %v", got, want)
	}

	got, err = tailFile(big, 5000) // crosses the chunk boundary
	if err != nil {
		t.Fatalf("tailFile big: %v", err)
	}
	if len(got) != 5000 || got[0] != "line-0003000" || got[4999] != "line-0007999" {
		t.Errorf("tail 5000: len=%d first=%q last=%q", len(got), got[0], got[len(got)-1])
	}

	// Ask for more lines than the file has → whole file.
	small := filepath.Join(dir, "small.log")
	os.WriteFile(small, []byte("a\nb\n"), 0o644)
	if got, _ = tailFile(small, 10); len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Errorf("tail beyond size = %v, want [a b]", got)
	}

	// Empty file and n<=0.
	empty := filepath.Join(dir, "empty.log")
	os.WriteFile(empty, nil, 0o644)
	if got, _ = tailFile(empty, 5); len(got) != 0 {
		t.Errorf("tail of empty file = %v, want none", got)
	}
	if got, _ = tailFile(small, 0); got != nil {
		t.Errorf("tail 0 = %v, want nil", got)
	}

	if _, err = tailFile(filepath.Join(dir, "missing.log"), 5); err == nil {
		t.Error("tail of missing file should error")
	}
}

func TestSubscribeTerminalTailsFile(t *testing.T) {
	m, sess := newTestSession(t)
	path := logFilePath(m.logDir, "c1", "n1", "done", time.Now())
	f, w, err := openLogFile(path)
	if err != nil {
		t.Fatalf("openLogFile: %v", err)
	}
	st := &Stream{Pod: "done", state: StateRunning, subs: map[chan string]string{}, filePath: path, file: f, w: w}
	sess.streams["done"] = st
	// More lines than the ring holds, so a file tail is provably not the ring.
	total := ringLines + 50
	for i := 0; i < total; i++ {
		st.writeLine(fmt.Sprintf("line-%d", i))
	}
	st.finalize(StateCompleted, "stream ended")

	// tail > ring size: replay must come from the file and include lines the
	// ring already evicted, plus the end marker.
	replay, ch, _, err := m.Subscribe("c1", "n1", "done", total+10, "")
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	if _, open := <-ch; open {
		t.Error("terminal subscribe channel should be closed")
	}
	if len(replay) != total+1 { // all lines + the marker
		t.Fatalf("replay len = %d, want %d", len(replay), total+1)
	}
	if replay[0] != "line-0" || !strings.HasPrefix(replay[total], "--- stream ended") {
		t.Errorf("replay bounds: first=%q last=%q", replay[0], replay[total])
	}

	// tail smaller than the file: last n lines only.
	replay, _, _, err = m.Subscribe("c1", "n1", "done", 2, "")
	if err != nil {
		t.Fatalf("Subscribe small tail: %v", err)
	}
	if len(replay) != 2 || replay[0] != fmt.Sprintf("line-%d", total-1) {
		t.Errorf("small tail = %v", replay)
	}

	// tail 0 keeps the old behavior: ring snapshot.
	replay, _, _, err = m.Subscribe("c1", "n1", "done", 0, "")
	if err != nil {
		t.Fatalf("Subscribe no tail: %v", err)
	}
	if len(replay) != ringLines {
		t.Errorf("no-tail replay len = %d, want ring size %d", len(replay), ringLines)
	}
}

func TestClassifyLine(t *testing.T) {
	cases := []struct{ line, want string }{
		{`time="t" level=error msg="boom"`, "err"},
		{`time="t" level="fatal" msg="dead"`, "err"},
		{`time="t" level=warn msg="careful"`, "wrn"},
		{`time="t" level=info msg="hi"`, "oth"},
		{`{"level":"error","msg":"json boom"}`, "err"},
		{`{"level":"warning","msg":"json warn"}`, "wrn"},
		{`{"level":"debug","msg":"noise"}`, "oth"},
		{`2026-01-01 ERROR something failed`, "err"},
		{`2026-01-01 WARN heads up`, "wrn"},
		{`2026-01-01 INFO all good`, "oth"},
		{`    at foo.bar(stack:12)`, ""}, // continuation: no level of its own
		{`plain line, no level here`, ""},
	}
	for _, c := range cases {
		if got := classifyLine(c.line); got != c.want {
			t.Errorf("classifyLine(%q) = %q, want %q", c.line, got, c.want)
		}
	}
}

// TestErrorsWarningsCompanionAndView covers the whole feature: errors and
// warnings are routed into untruncated companion files (continuation lines
// inheriting the preceding level), and the errors/warnings views replay the
// right file and filter live delivery to that bucket.
func TestErrorsWarningsCompanionAndView(t *testing.T) {
	m, sess := newTestSession(t)
	path := logFilePath(m.logDir, "c1", "n1", "p", time.Now())
	f, w, err := openLogFile(path)
	if err != nil {
		t.Fatalf("openLogFile: %v", err)
	}
	st := &Stream{
		Pod: "p", state: StateRunning, subs: map[chan string]string{},
		filePath: path, errPath: companionPath(path, "errors"), warnPath: companionPath(path, "warnings"),
		file: f, w: w,
	}
	sess.streams["p"] = st

	st.writeLine(`level=info msg="starting"`)
	st.writeLine(`level=error msg="boom 1"`)
	st.writeLine(`    at stack.frame`) // no level → inherits err
	st.writeLine(`level=warn msg="careful"`)
	st.writeLine(`level=info msg="ok"`)
	st.writeLine(`level=error msg="boom 2"`)

	// Errors view: replay is exactly the error-bucket lines (including the
	// inherited continuation), read whole from the untruncated companion.
	replay, ch, cancel, err := m.Subscribe("c1", "n1", "p", 0, "errors")
	if err != nil {
		t.Fatalf("Subscribe errors: %v", err)
	}
	wantErr := "level=error msg=\"boom 1\"\n    at stack.frame\nlevel=error msg=\"boom 2\""
	if strings.Join(replay, "\n") != wantErr {
		t.Fatalf("errors replay =\n%q\nwant\n%q", strings.Join(replay, "\n"), wantErr)
	}

	recv := func() string {
		select {
		case v := <-ch:
			return v
		case <-time.After(time.Second):
			t.Fatal("no live line delivered to errors view")
			return ""
		}
	}
	// A new error is delivered live; an info line in between is filtered out.
	st.writeLine(`level=error msg="boom 3"`)
	if got := recv(); got != `level=error msg="boom 3"` {
		t.Errorf("live errors line = %q", got)
	}
	st.writeLine(`level=info msg="ignored by errors view"`)
	st.writeLine(`level=error msg="boom 4"`)
	if got := recv(); got != `level=error msg="boom 4"` {
		t.Errorf("errors view must skip the info line; got %q", got)
	}
	cancel()

	// Warnings view replays only the warning line.
	replayW, _, cancelW, err := m.Subscribe("c1", "n1", "p", 0, "warnings")
	if err != nil {
		t.Fatalf("Subscribe warnings: %v", err)
	}
	if strings.Join(replayW, "\n") != `level=warn msg="careful"` {
		t.Errorf("warnings replay = %q", replayW)
	}
	cancelW()

	// The companion files exist and hold the full set (5 errors, 1 warning).
	st.mu.Lock()
	st.flushLocked()
	st.mu.Unlock()
	if lines, _ := readLogLines(companionPath(path, "errors")); len(lines) != 5 {
		t.Errorf("errors file = %d lines, want 5", len(lines))
	}
	if lines, _ := readLogLines(companionPath(path, "warnings")); len(lines) != 1 {
		t.Errorf("warnings file = %d lines, want 1", len(lines))
	}
}

func TestExportPath(t *testing.T) {
	m, sess := newTestSession(t)
	path := logFilePath(m.logDir, "c1", "n1", "p", time.Now())
	f, w, err := openLogFile(path)
	if err != nil {
		t.Fatalf("openLogFile: %v", err)
	}
	st := &Stream{Pod: "p", state: StateRunning, subs: map[chan string]string{}, filePath: path, file: f, w: w}
	sess.streams["p"] = st
	st.writeLine("buffered-but-not-flushed")

	got, err := m.ExportPath("c1", "n1", "p")
	if err != nil || got != path {
		t.Fatalf("ExportPath = %q, %v", got, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(raw), "buffered-but-not-flushed") {
		t.Errorf("ExportPath should flush before returning; file=%q err=%v", raw, err)
	}

	if _, err := m.ExportPath("c1", "n1", "nope"); err != ErrNoStream {
		t.Errorf("missing stream err = %v, want ErrNoStream", err)
	}
	if _, err := m.ExportPath("cX", "nX", "p"); err != ErrNoSession {
		t.Errorf("missing session err = %v, want ErrNoSession", err)
	}
}

func TestCleanup(t *testing.T) {
	m, sess := newTestSession(t)
	dir := m.logDir
	old := time.Now().Add(-48 * time.Hour)

	mk := func(rel string, age bool) string {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if age {
			if err := os.Chtimes(p, old, old); err != nil {
				t.Fatal(err)
			}
		}
		return p
	}

	oldGone := mk("c1/n1/old-20260601-000000.log", true)
	oldKept := mk("c1/n1/tracked-20260601-000000.log", true) // tracked → kept
	fresh := mk("c1/n1/fresh-20260610-000000.log", false)
	notLog := mk("c1/n1/notes.txt", true)                // not a .log → never touched
	oldDir := mk("c2/n2/lone-20260601-000000.log", true) // its dirs empty out

	sess.streams["tracked"] = &Stream{Pod: "tracked", state: StateCompleted, filePath: oldKept}

	removed, freed, err := m.Cleanup(24 * time.Hour)
	if err != nil {
		t.Fatalf("Cleanup: %v", err)
	}
	if removed != 2 || freed != 4 {
		t.Errorf("removed=%d freed=%d, want 2 files / 4 bytes", removed, freed)
	}
	for _, p := range []string{oldKept, fresh, notLog} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("%s should survive: %v", p, err)
		}
	}
	for _, p := range []string{oldGone, oldDir} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s should be removed", p)
		}
	}
	// c2's emptied directory chain is pruned; the root and busy dirs stay.
	if _, err := os.Stat(filepath.Join(dir, "c2")); !os.IsNotExist(err) {
		t.Error("emptied session dir c2 should be pruned")
	}
	if _, err := os.Stat(filepath.Join(dir, "c1", "n1")); err != nil {
		t.Errorf("non-empty dir must remain: %v", err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Errorf("log root must remain: %v", err)
	}

	// A log dir that does not exist yet is not an error.
	m2 := NewManager(nil, filepath.Join(dir, "does-not-exist"))
	if _, _, err := m2.Cleanup(time.Hour); err != nil {
		t.Errorf("Cleanup on missing dir: %v", err)
	}
}

func TestLogDirInfo(t *testing.T) {
	m, _ := newTestSession(t)
	p := filepath.Join(m.logDir, "c", "n", "a.log")
	os.MkdirAll(filepath.Dir(p), 0o755)
	os.WriteFile(p, []byte("hello\n"), 0o644)
	m.retention = 7 * 24 * time.Hour

	info := m.LogDirInfo()
	if info.Dir != m.logDir || info.Files != 1 || info.Bytes != 6 || info.RetentionDays != 7 {
		t.Errorf("LogDirInfo = %+v", info)
	}
}

func TestRetentionFromEnv(t *testing.T) {
	t.Setenv("KRO_WATCH_LOG_RETENTION_DAYS", "")
	if got := RetentionFromEnv(); got != 7*24*time.Hour {
		t.Errorf("default retention = %v, want 168h", got)
	}
	t.Setenv("KRO_WATCH_LOG_RETENTION_DAYS", "3")
	if got := RetentionFromEnv(); got != 3*24*time.Hour {
		t.Errorf("retention(3) = %v, want 72h", got)
	}
	t.Setenv("KRO_WATCH_LOG_RETENTION_DAYS", "0")
	if got := RetentionFromEnv(); got != 0 {
		t.Errorf("retention(0) = %v, want 0", got)
	}
	t.Setenv("KRO_WATCH_LOG_RETENTION_DAYS", "junk")
	if got := RetentionFromEnv(); got != 7*24*time.Hour {
		t.Errorf("retention(junk) = %v, want default 168h", got)
	}
}

func TestFileWriteAndMarkers(t *testing.T) {
	dir := t.TempDir()
	path := logFilePath(dir, "c", "n", "pod", time.Now())
	f, w, err := openLogFile(path)
	if err != nil {
		t.Fatalf("openLogFile: %v", err)
	}
	st := &Stream{Pod: "pod", state: StateRunning, subs: map[chan string]string{}, filePath: path, file: f, w: w}
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
