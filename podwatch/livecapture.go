package podwatch

import (
	"bufio"
	"os"
	"regexp"
	"sync"
	"time"

	"github.com/rohanthewiz/serr"
)

// Live captures back the plain Logs modal (/sse/logs) with a file, so a
// long-running view keeps every line it has streamed — not just what the
// browser happens to hold — and the user can download the whole session.
//
// They live in the same directory tree as Pod Watch logs, under the same
// naming scheme with a ".live.log" suffix:
//
//	<logDir>/<ctx>/<ns>/<pod>-<ts>.live.log
//
// Sharing the tree means the existing janitor, manual cleanup, and usage
// figure in the Pod Watch gear popover all cover live captures for free.
// Active captures are reported through trackedFiles so cleanup never unlinks
// a file that is still being written (which would silently send every later
// line into an unreachable inode and break its download).
//
// Lifecycle (one capture per Logs-modal open; the browser picks the ID):
//
//	viewLogs ─► /sse/logs?cap=ID ─► Acquire ─► Write… ─► Release (disconnect)
//	                 ▲                                          │
//	                 └──── reconnect (same ID) re-Acquires ◄────┘  file reopened for append
//
//	download ─► /api/logs/capture?id=ID ─► ExportPath (flush) ─► stream file
//
// The ID comes from the browser rather than the server because EventSource
// auto-reconnects with the exact URL it was created with; a client-chosen ID
// baked into that URL lets a reconnect continue the same file instead of
// starting a fresh one (which would orphan the earlier lines from the
// download). The ID is only ever a map key — it never reaches a path.

// liveCaptureIdle is how long a released capture stays addressable by ID (for
// downloads and reconnects) before its map entry is dropped. The file itself
// stays on disk until the retention janitor removes it.
const liveCaptureIdle = 24 * time.Hour

// liveFlushInterval bounds how stale the on-disk file can be relative to the
// lines already delivered, so the file is useful even if kro dies abruptly.
// Downloads flush explicitly, so this only matters for out-of-band readers.
const liveFlushInterval = 2 * time.Second

var liveCaptureIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

// LiveCaptures tracks the file-backed captures of open Logs modals.
type LiveCaptures struct {
	logDir string

	mu   sync.Mutex
	caps map[string]*LiveCapture
}

// LiveCapture is one Logs-modal session's capture file. It is shared by every
// SSE connection that carries the same ID (normally one; briefly two while a
// manual reconnect overlaps the old connection's teardown).
type LiveCapture struct {
	ID        string
	Context   string
	Namespace string
	Pod       string
	Path      string

	mu         sync.Mutex
	file       *os.File
	w          *bufio.Writer
	writers    int       // SSE connections currently writing; file is open iff > 0
	releasedAt time.Time // when writers last dropped to 0; drives map expiry
	lastFlush  time.Time
}

func newLiveCaptures(logDir string) *LiveCaptures {
	return &LiveCaptures{logDir: logDir, caps: map[string]*LiveCapture{}}
}

// ValidLiveCaptureID reports whether id is an acceptable client-chosen
// capture ID. Kept strict and short since it arrives in a query string.
func ValidLiveCaptureID(id string) bool {
	return liveCaptureIDRe.MatchString(id)
}

// Acquire returns the capture for id, creating its file on first use or
// reopening it for append when a reconnect resumes a released capture. The
// caller must Release it when its SSE connection ends.
//
// An ID already bound to a different (context, namespace, pod) is refused
// rather than silently re-pointed: the browser mints a fresh ID per modal
// open, so a mismatch means a stale or forged ID.
func (lc *LiveCaptures) Acquire(id, ctxName, ns, pod string) (*LiveCapture, error) {
	if !ValidLiveCaptureID(id) {
		return nil, serr.New("invalid capture id")
	}
	now := time.Now()

	lc.mu.Lock()
	lc.pruneLocked(now)
	c, ok := lc.caps[id]
	if !ok {
		c = &LiveCapture{
			ID: id, Context: ctxName, Namespace: ns, Pod: pod,
			Path: liveFilePath(lc.logDir, ctxName, ns, pod, now),
		}
		lc.caps[id] = c
	}
	lc.mu.Unlock()

	if c.Context != ctxName || c.Namespace != ns || c.Pod != pod {
		return nil, serr.New("capture id belongs to a different pod", "id", id)
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.writers == 0 {
		f, w, err := openLogFile(c.Path)
		if err != nil {
			return nil, err
		}
		c.file, c.w = f, w
		if ok {
			// Resuming: the new follow re-sends the pod's tail, so the
			// lines right after this marker may repeat ones above it.
			// Duplicates are preferred over a gap for an archive.
			c.writeMarkerLocked("kro: log stream reconnected; lines below may repeat")
		} else {
			c.writeMarkerLocked("kro: live log capture of " + ctxName + "/" + ns + "/" + pod + " started")
		}
	}
	c.writers++
	return c, nil
}

// Release ends one connection's use of the capture. When the last writer
// leaves, the file is flushed and closed; the entry stays addressable for
// downloads and reconnects until liveCaptureIdle passes.
func (c *LiveCapture) Release() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.writers == 0 {
		return
	}
	c.writers--
	if c.writers > 0 {
		return
	}
	c.closeFileLocked()
	c.releasedAt = time.Now()
}

// WriteLine appends one line. Lines arriving after the last Release (a
// producer goroutine finishing up after disconnect) are dropped.
func (c *LiveCapture) WriteLine(line string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.w == nil {
		return
	}
	c.w.WriteString(line)
	c.w.WriteByte('\n')
	if now := time.Now(); now.Sub(c.lastFlush) >= liveFlushInterval {
		c.w.Flush()
		c.lastFlush = now
	}
}

// writeMarkerLocked records a lifecycle marker in the same format Pod Watch
// uses, so both kinds of capture read alike.
func (c *LiveCapture) writeMarkerLocked(text string) {
	if c.w == nil {
		return
	}
	c.w.WriteString("--- " + text + " " + time.Now().UTC().Format(time.RFC3339) + " ---\n")
}

func (c *LiveCapture) closeFileLocked() {
	if c.w != nil {
		c.w.Flush()
	}
	if c.file != nil {
		c.file.Close()
	}
	c.file, c.w = nil, nil
}

// ExportPath flushes buffered lines and returns the capture's file path for a
// download. Only paths the manager built itself are ever returned.
func (lc *LiveCaptures) ExportPath(id string) (string, error) {
	lc.mu.Lock()
	c, ok := lc.caps[id]
	lc.mu.Unlock()
	if !ok {
		return "", ErrNoStream
	}
	c.mu.Lock()
	if c.w != nil {
		c.w.Flush()
		c.lastFlush = time.Now()
	}
	c.mu.Unlock()
	return c.Path, nil
}

// pruneLocked drops entries released longer than liveCaptureIdle ago. It runs
// on each Acquire, which is often enough: entries are tiny and the files are
// governed separately by the retention janitor.
func (lc *LiveCaptures) pruneLocked(now time.Time) {
	for id, c := range lc.caps {
		c.mu.Lock()
		idle := c.writers == 0 && now.Sub(c.releasedAt) > liveCaptureIdle
		c.mu.Unlock()
		if idle {
			delete(lc.caps, id)
		}
	}
}

// activeFiles returns the paths of captures that still have a writer, for
// Cleanup to keep. Released captures may be pruned by age like any other log.
func (lc *LiveCaptures) activeFiles() []string {
	lc.mu.Lock()
	caps := make([]*LiveCapture, 0, len(lc.caps))
	for _, c := range lc.caps {
		caps = append(caps, c)
	}
	lc.mu.Unlock()

	var out []string
	for _, c := range caps {
		c.mu.Lock()
		if c.writers > 0 {
			out = append(out, c.Path)
		}
		c.mu.Unlock()
	}
	return out
}

// liveFilePath is logFilePath with a ".live.log" suffix, distinguishing Logs
// modal captures from Pod Watch captures of the same pod in the same folder.
func liveFilePath(dir, ctxName, ns, pod string, t time.Time) string {
	return companionPath(logFilePath(dir, ctxName, ns, pod, t), "live")
}
