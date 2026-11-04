package podwatch

import (
	"os"
	"strings"
	"testing"
	"time"
)

func readCapture(t *testing.T, lc *LiveCaptures, id string) string {
	t.Helper()
	path, err := lc.ExportPath(id)
	if err != nil {
		t.Fatalf("ExportPath: %v", err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read capture: %v", err)
	}
	return string(b)
}

func TestLiveCaptureWriteAndExport(t *testing.T) {
	lc := newLiveCaptures(t.TempDir())
	c, err := lc.Acquire("cap-12345678", "ctx", "ns", "pod-a")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	if !strings.HasSuffix(c.Path, ".live.log") {
		t.Errorf("path %q lacks .live.log suffix", c.Path)
	}
	c.WriteLine("line one")
	c.WriteLine("line two")

	// ExportPath must flush buffered lines while the capture is still open.
	got := readCapture(t, lc, "cap-12345678")
	if !strings.Contains(got, "live log capture of ctx/ns/pod-a started") {
		t.Errorf("missing start marker:\n%s", got)
	}
	if !strings.HasSuffix(got, "line one\nline two\n") {
		t.Errorf("lines not flushed in order:\n%s", got)
	}
}

func TestLiveCaptureResumeAppendsToSameFile(t *testing.T) {
	lc := newLiveCaptures(t.TempDir())
	c, err := lc.Acquire("cap-resume01", "ctx", "ns", "pod-a")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	c.WriteLine("before")
	c.Release()
	c.WriteLine("dropped after release")

	c2, err := lc.Acquire("cap-resume01", "ctx", "ns", "pod-a")
	if err != nil {
		t.Fatalf("re-Acquire: %v", err)
	}
	if c2 != c || c2.Path != c.Path {
		t.Fatalf("reconnect should reuse the capture and its file")
	}
	c2.WriteLine("after")
	c2.Release()

	got := readCapture(t, lc, "cap-resume01")
	if strings.Contains(got, "dropped after release") {
		t.Errorf("line written after the last Release was kept:\n%s", got)
	}
	bi, ri, ai := strings.Index(got, "before"), strings.Index(got, "reconnected"), strings.Index(got, "after")
	if bi < 0 || ri < 0 || ai < 0 || !(bi < ri && ri < ai) {
		t.Errorf("want before → reconnect marker → after, got:\n%s", got)
	}
}

func TestLiveCaptureOverlappingWritersKeepFileOpen(t *testing.T) {
	lc := newLiveCaptures(t.TempDir())
	a, _ := lc.Acquire("cap-overlap1", "ctx", "ns", "pod-a")
	b, _ := lc.Acquire("cap-overlap1", "ctx", "ns", "pod-a")
	a.Release() // old connection tears down while the new one is live
	b.WriteLine("still open")
	if got := readCapture(t, lc, "cap-overlap1"); !strings.Contains(got, "still open") {
		t.Errorf("write after one of two releases was lost:\n%s", got)
	}
	if n := len(lc.activeFiles()); n != 1 {
		t.Errorf("activeFiles = %d, want 1 while a writer remains", n)
	}
	b.Release()
	if n := len(lc.activeFiles()); n != 0 {
		t.Errorf("activeFiles = %d, want 0 after all writers released", n)
	}
}

func TestLiveCaptureRejectsBadOrMismatchedID(t *testing.T) {
	lc := newLiveCaptures(t.TempDir())
	for _, id := range []string{"", "short", "../../etc/passwd", "has space 123", strings.Repeat("x", 65)} {
		if _, err := lc.Acquire(id, "ctx", "ns", "pod"); err == nil {
			t.Errorf("Acquire(%q) should fail", id)
		}
	}
	if _, err := lc.Acquire("cap-mismatch", "ctx", "ns", "pod-a"); err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	if _, err := lc.Acquire("cap-mismatch", "ctx", "ns", "pod-b"); err == nil {
		t.Errorf("an ID bound to pod-a must not be reused for pod-b")
	}
	if _, err := lc.ExportPath("cap-unknown1"); err != ErrNoStream {
		t.Errorf("ExportPath(unknown) err = %v, want ErrNoStream", err)
	}
}

func TestLiveCapturePruneIdle(t *testing.T) {
	lc := newLiveCaptures(t.TempDir())
	c, _ := lc.Acquire("cap-prune001", "ctx", "ns", "pod-a")
	c.Release()
	lc.mu.Lock()
	lc.pruneLocked(time.Now()) // fresh release: kept
	_, kept := lc.caps["cap-prune001"]
	lc.pruneLocked(time.Now().Add(liveCaptureIdle + time.Minute))
	_, stillThere := lc.caps["cap-prune001"]
	lc.mu.Unlock()
	if !kept || stillThere {
		t.Errorf("kept=%v stillThere=%v, want true/false", kept, stillThere)
	}
}

func TestCleanupKeepsActiveLiveCapture(t *testing.T) {
	m := NewManager(nil, t.TempDir())
	c, err := m.Live().Acquire("cap-cleanup1", "ctx", "ns", "pod-a")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	c.WriteLine("x")
	// Age 0 removes every file not tracked; an active capture is tracked.
	if _, _, err := m.Cleanup(0); err != nil {
		t.Fatalf("Cleanup: %v", err)
	}
	if _, err := os.Stat(c.Path); err != nil {
		t.Fatalf("active capture removed by cleanup: %v", err)
	}
	c.Release()
	// Backdate so it's older than "now" for the age cutoff.
	old := time.Now().Add(-time.Hour)
	os.Chtimes(c.Path, old, old)
	if _, _, err := m.Cleanup(0); err != nil {
		t.Fatalf("Cleanup: %v", err)
	}
	if _, err := os.Stat(c.Path); !os.IsNotExist(err) {
		t.Errorf("released capture should be prunable, stat err = %v", err)
	}
}

// A reconnect must resume from the per-container timestamp of the last
// captured line, and lines at or before it (the overlap of an old and a new
// writer) must not be written twice.
func TestLiveCaptureResumeAfterAndDedup(t *testing.T) {
	lc := newLiveCaptures(t.TempDir())
	c, err := lc.Acquire("cap-dedup001", "ctx", "ns", "pod-a")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	if r := c.ResumeAfter(); r != nil {
		t.Fatalf("fresh capture ResumeAfter = %v, want nil", r)
	}
	t0 := time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC)
	c.WriteStamped("app", t0, "[app] one")
	c.WriteStamped("app", t0.Add(time.Second), "[app] two")
	c.WriteStamped("side", t0.Add(500*time.Millisecond), "[side] s1")
	c.WriteLine("unstamped note") // must not move any resume point
	c.Release()

	c2, err := lc.Acquire("cap-dedup001", "ctx", "ns", "pod-a")
	if err != nil {
		t.Fatalf("re-Acquire: %v", err)
	}
	r := c2.ResumeAfter()
	if !r["app"].Equal(t0.Add(time.Second)) || !r["side"].Equal(t0.Add(500*time.Millisecond)) || len(r) != 2 {
		t.Fatalf("ResumeAfter = %v", r)
	}
	// The returned map is a copy.
	r["app"] = time.Time{}
	if c2.ResumeAfter()["app"].IsZero() {
		t.Fatalf("ResumeAfter leaked its internal map")
	}

	if c2.WriteStamped("app", t0.Add(time.Second), "[app] two") {
		t.Errorf("a line at the resume point was written again")
	}
	if c2.WriteStamped("app", t0, "[app] one") {
		t.Errorf("a line before the resume point was written again")
	}
	if !c2.WriteStamped("app", t0.Add(2*time.Second), "[app] three") {
		t.Errorf("a newer line was dropped")
	}
	// Per-container: side's mark is earlier than app's, so a side line between
	// the two marks is new.
	if !c2.WriteStamped("side", t0.Add(900*time.Millisecond), "[side] s2") {
		t.Errorf("per-container mark not honoured")
	}
	c2.Release()

	got := readCapture(t, lc, "cap-dedup001")
	if strings.Count(got, "[app] two") != 1 || strings.Count(got, "[app] one") != 1 {
		t.Errorf("repeated lines in capture:\n%s", got)
	}
	if !strings.Contains(got, "resuming after the last captured line") {
		t.Errorf("missing resume marker:\n%s", got)
	}
	if strings.Contains(got, "may repeat") {
		t.Errorf("stamped resume should not use the may-repeat marker:\n%s", got)
	}
}

// A capture with only unstamped lines has no resume point, so a reconnect
// falls back to the tail and says so.
func TestLiveCaptureResumeWithoutStampsWarnsOfRepeats(t *testing.T) {
	lc := newLiveCaptures(t.TempDir())
	c, _ := lc.Acquire("cap-nostamp1", "ctx", "ns", "pod-a")
	c.WriteLine("plain")
	c.Release()
	c2, _ := lc.Acquire("cap-nostamp1", "ctx", "ns", "pod-a")
	if r := c2.ResumeAfter(); r != nil {
		t.Errorf("ResumeAfter = %v, want nil", r)
	}
	c2.Release()
	if got := readCapture(t, lc, "cap-nostamp1"); !strings.Contains(got, "lines below may repeat") {
		t.Errorf("missing may-repeat marker:\n%s", got)
	}
}
