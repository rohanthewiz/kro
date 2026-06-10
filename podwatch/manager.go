// Package podwatch watches namespaces for newly created pods and captures
// their logs to per-pod files on disk. Sessions and streams are owned by the
// server (not a browser connection), so they survive page reloads and stop
// only when explicitly stopped. Recent lines are kept in a per-stream ring
// buffer so a console tee toggled on mid-stream can replay history.
package podwatch

import (
	"bufio"
	"context"
	"errors"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rohanthewiz/serr"
	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

const (
	// maxWatchStreams caps concurrently active (starting|running|paused)
	// log streams across all watch sessions.
	maxWatchStreams = 12

	ringLines      = 2000 // per-stream replay buffer for console tees
	subChanSize    = 256  // per-tee subscriber channel buffer
	lineChanSize   = 256  // kube log line channel buffer
	flushInterval  = 2 * time.Second
	countsInterval = 2 * time.Second
	readyTimeout   = 2 * time.Minute // how long to wait for a new pod's logs
)

// Sentinel errors mapped to HTTP statuses by the web layer.
var (
	ErrSessionExists = errors.New("already watching this context/namespace")
	ErrNoSession     = errors.New("no watch session for this context/namespace")
	ErrNoStream      = errors.New("no such stream")
	ErrBadAction     = errors.New("unknown stream action")
	ErrBadTransition = errors.New("action not valid in the stream's current state")
)

// StreamState is the lifecycle state of one pod's log stream.
type StreamState string

const (
	StateStarting  StreamState = "starting"  // waiting for the pod's logs to become available
	StateRunning   StreamState = "running"   // capturing lines
	StatePaused    StreamState = "paused"    // capture suspended; file held open
	StateCompleted StreamState = "completed" // pod's log stream ended (e.g. pod gone)
	StateStopped   StreamState = "stopped"   // stopped by the user
	StateError     StreamState = "error"     // could not start or stream failed
)

func (s StreamState) active() bool {
	return s == StateStarting || s == StateRunning || s == StatePaused
}

func (s StreamState) terminal() bool {
	return s == StateCompleted || s == StateStopped || s == StateError
}

// Manager coordinates watch sessions. One session per (context, namespace).
type Manager struct {
	logDir    string
	clientFn  func(ctxName string) (*kubernetes.Clientset, error)
	retention time.Duration // auto-clean age; written once by StartJanitor before serving

	mu       sync.Mutex
	sessions map[string]*Session

	notifyMu sync.RWMutex
	notify   func(event string, payload any)
}

// Session is one namespace watch: a baseline of pods that existed when it
// started (those are ignored) plus a stream per pod created afterward.
type Session struct {
	Context   string
	Namespace string
	StartedAt time.Time

	ctx      context.Context
	cancel   context.CancelFunc
	client   *kubernetes.Clientset
	baseline map[string]struct{} // pods present at watch start; written only before the watch loop spawns
	streams  map[string]*Stream  // pod name -> stream; guarded by Manager.mu
}

// Stream captures one pod's logs to a file and fans lines out to tee
// subscribers. Lock order is always Manager.mu before Stream.mu.
type Stream struct {
	Pod       string
	StartedAt time.Time

	LineCount  atomic.Int64
	LastLineAt atomic.Int64 // unix nanos of the last captured line

	mu       sync.Mutex
	state    StreamState
	errMsg   string
	filePath string
	cancel   context.CancelFunc // cancels the kube log stream (pause/stop)
	file     *os.File
	w        *bufio.Writer
	ring     []string // circular: oldest at ringAt once full
	ringAt   int
	subs     map[chan string]struct{} // nil once the stream is terminal
}

// JSON shapes for /api/watch/status and /sse/watch payloads.

type StreamStatus struct {
	Pod          string    `json:"pod"`
	State        string    `json:"state"`
	File         string    `json:"file"`
	StartedAt    time.Time `json:"startedAt"`
	Lines        int64     `json:"lines"`
	LastActivity time.Time `json:"lastActivity,omitzero"`
	Error        string    `json:"error,omitempty"`
}

type SessionStatus struct {
	Context   string         `json:"context"`
	Namespace string         `json:"namespace"`
	StartedAt time.Time      `json:"startedAt"`
	Streams   []StreamStatus `json:"streams"`
}

type StatusPayload struct {
	MaxStreams    int             `json:"maxStreams"`
	ActiveStreams int             `json:"activeStreams"`
	Sessions      []SessionStatus `json:"sessions"`
}

func NewManager(clientFn func(string) (*kubernetes.Clientset, error), logDir string) *Manager {
	return &Manager{
		logDir:   logDir,
		clientFn: clientFn,
		sessions: map[string]*Session{},
	}
}

// SetNotify wires status events to the web layer's SSE hub.
func (m *Manager) SetNotify(fn func(event string, payload any)) {
	m.notifyMu.Lock()
	m.notify = fn
	m.notifyMu.Unlock()
}

func (m *Manager) notifyEvent(event string, payload any) {
	m.notifyMu.RLock()
	fn := m.notify
	m.notifyMu.RUnlock()
	if fn != nil {
		fn(event, payload)
	}
}

func sessKey(ctxName, ns string) string { return ctxName + "\x00" + ns }

// Start begins watching (ctxName, ns). The initial pod list runs
// synchronously so the caller gets immediate feedback on a bad cluster.
func (m *Manager) Start(ctxName, ns string) (*SessionStatus, error) {
	client, err := m.clientFn(ctxName)
	if err != nil {
		return nil, serr.Wrap(err, "build client")
	}

	sctx, cancel := context.WithCancel(context.Background())
	sess := &Session{
		Context:   ctxName,
		Namespace: ns,
		StartedAt: time.Now(),
		ctx:       sctx,
		cancel:    cancel,
		client:    client,
		baseline:  map[string]struct{}{},
		streams:   map[string]*Stream{},
	}

	key := sessKey(ctxName, ns)
	m.mu.Lock()
	if _, exists := m.sessions[key]; exists {
		m.mu.Unlock()
		cancel()
		return nil, ErrSessionExists
	}
	// Publish before the (slow) initial list so concurrent Starts conflict here.
	m.sessions[key] = sess
	m.mu.Unlock()

	list, err := client.CoreV1().Pods(ns).List(sctx, metaV1.ListOptions{})
	if err != nil {
		m.mu.Lock()
		delete(m.sessions, key)
		m.mu.Unlock()
		cancel()
		return nil, serr.Wrap(err, "initial pod list")
	}
	for i := range list.Items {
		sess.baseline[list.Items[i].Name] = struct{}{}
	}

	go m.runWatchLoop(sess, list.ResourceVersion)
	go m.runCountsTicker(sess)

	st := m.sessionStatus(sess)
	m.notifyEvent("session_started", st)
	return &st, nil
}

// Stop tears down a session: the watch loop and every active stream stop,
// files are flushed and closed, tee subscribers are closed.
func (m *Manager) Stop(ctxName, ns string) error {
	key := sessKey(ctxName, ns)
	m.mu.Lock()
	sess, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return ErrNoSession
	}
	delete(m.sessions, key)
	streams := make([]*Stream, 0, len(sess.streams))
	for _, st := range sess.streams {
		streams = append(streams, st)
	}
	m.mu.Unlock()

	sess.cancel()
	for _, st := range streams {
		st.finalize(StateStopped, "stopped (watch ended)")
	}
	m.notifyEvent("session_stopped", map[string]any{"context": ctxName, "namespace": ns})
	return nil
}

// Status snapshots every session and stream for the UI.
func (m *Manager) Status() StatusPayload {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	active := m.activeStreamCountLocked()
	m.mu.Unlock()

	sort.Slice(sessions, func(i, j int) bool {
		if sessions[i].Context != sessions[j].Context {
			return sessions[i].Context < sessions[j].Context
		}
		return sessions[i].Namespace < sessions[j].Namespace
	})

	out := StatusPayload{MaxStreams: maxWatchStreams, ActiveStreams: active, Sessions: []SessionStatus{}}
	for _, s := range sessions {
		out.Sessions = append(out.Sessions, m.sessionStatus(s))
	}
	return out
}

func (m *Manager) sessionStatus(sess *Session) SessionStatus {
	m.mu.Lock()
	streams := make([]*Stream, 0, len(sess.streams))
	for _, st := range sess.streams {
		streams = append(streams, st)
	}
	m.mu.Unlock()

	sort.Slice(streams, func(i, j int) bool {
		if !streams[i].StartedAt.Equal(streams[j].StartedAt) {
			return streams[i].StartedAt.Before(streams[j].StartedAt)
		}
		return streams[i].Pod < streams[j].Pod
	})

	ss := SessionStatus{Context: sess.Context, Namespace: sess.Namespace, StartedAt: sess.StartedAt, Streams: []StreamStatus{}}
	for _, st := range streams {
		ss.Streams = append(ss.Streams, st.status())
	}
	return ss
}

func (m *Manager) activeStreamCountLocked() int {
	n := 0
	for _, sess := range m.sessions {
		for _, st := range sess.streams {
			st.mu.Lock()
			if st.state.active() {
				n++
			}
			st.mu.Unlock()
		}
	}
	return n
}

// StreamAction applies a user action ("stop"|"pause"|"resume"|"remove") to
// one pod's stream.
func (m *Manager) StreamAction(ctxName, ns, pod, action string) error {
	m.mu.Lock()
	sess, ok := m.sessions[sessKey(ctxName, ns)]
	if !ok {
		m.mu.Unlock()
		return ErrNoSession
	}
	st, ok := sess.streams[pod]
	if !ok {
		m.mu.Unlock()
		return ErrNoStream
	}

	if action == "remove" {
		st.mu.Lock()
		terminal := st.state.terminal()
		st.mu.Unlock()
		if !terminal {
			m.mu.Unlock()
			return ErrBadTransition
		}
		delete(sess.streams, pod)
		m.mu.Unlock()
		m.notifyEvent("stream_removed", map[string]any{"context": ctxName, "namespace": ns, "pod": pod})
		return nil
	}
	m.mu.Unlock()

	switch action {
	case "stop":
		st.mu.Lock()
		if !st.state.active() {
			st.mu.Unlock()
			return ErrBadTransition
		}
		if st.cancel != nil {
			st.cancel()
			st.cancel = nil
		}
		st.writeMarkerLocked("stopped")
		st.closeLocked(StateStopped)
		st.mu.Unlock()

	case "pause":
		st.mu.Lock()
		if st.state != StateRunning && st.state != StateStarting {
			st.mu.Unlock()
			return ErrBadTransition
		}
		if st.cancel != nil {
			st.cancel()
			st.cancel = nil
		}
		st.writeMarkerLocked("paused")
		st.flushLocked()
		st.state = StatePaused
		st.mu.Unlock()

	case "resume":
		st.mu.Lock()
		if st.state != StatePaused {
			st.mu.Unlock()
			return ErrBadTransition
		}
		// Resume from the last captured line. The API server's sinceTime
		// has 1-second granularity, so up to ~1s of lines may repeat; the
		// paused/resumed markers in the file make any overlap auditable.
		var since *metaV1.Time
		if n := st.LastLineAt.Load(); n > 0 {
			t := metaV1.NewTime(time.Unix(0, n).Truncate(time.Second))
			since = &t
		}
		st.writeMarkerLocked("resumed")
		st.state = StateRunning
		streamCtx, cancel := context.WithCancel(sess.ctx)
		st.cancel = cancel
		st.mu.Unlock()
		go m.runStream(sess, st, streamCtx, since)

	default:
		return ErrBadAction
	}

	m.notifyEvent("stream_state", m.streamPayload(sess, st))
	return nil
}

// maxTailLines bounds how much of an ended stream's file Subscribe will
// replay, regardless of what the client asks for.
const maxTailLines = 100_000

// Subscribe registers a console tee on a stream. The ring snapshot and the
// subscriber registration happen under one lock, so replay + live delivery
// has no gap and no duplicates. For a terminal stream the returned channel
// is already closed and, when tail > 0, the replay is the last tail lines
// of the log file instead of the ring — the file is complete where the
// ring caps out at ringLines (the ring is the fallback if the read fails).
// The returned cancel is idempotent and safe to call after the stream
// closed the channel.
func (m *Manager) Subscribe(ctxName, ns, pod string, tail int) (replay []string, ch <-chan string, cancel func(), err error) {
	m.mu.Lock()
	sess, ok := m.sessions[sessKey(ctxName, ns)]
	if !ok {
		m.mu.Unlock()
		return nil, nil, nil, ErrNoSession
	}
	st, ok := sess.streams[pod]
	if !ok {
		m.mu.Unlock()
		return nil, nil, nil, ErrNoStream
	}
	m.mu.Unlock()

	st.mu.Lock()
	defer st.mu.Unlock()
	replay = st.ringSnapshotLocked()
	sub := make(chan string, subChanSize)
	if st.subs == nil { // terminal: replay only
		if tail > 0 && st.filePath != "" {
			if fromFile, ferr := tailFile(st.filePath, min(tail, maxTailLines)); ferr == nil {
				replay = fromFile
			}
		}
		close(sub)
		return replay, sub, func() {}, nil
	}
	st.subs[sub] = struct{}{}
	cancel = func() {
		st.mu.Lock()
		defer st.mu.Unlock()
		if st.subs != nil {
			if _, live := st.subs[sub]; live {
				delete(st.subs, sub)
				close(sub)
			}
		}
	}
	return replay, sub, cancel, nil
}

// ExportPath flushes a stream's buffered writer (so the file is current)
// and returns the log file path, for serving the capture as a download.
func (m *Manager) ExportPath(ctxName, ns, pod string) (string, error) {
	m.mu.Lock()
	sess, ok := m.sessions[sessKey(ctxName, ns)]
	if !ok {
		m.mu.Unlock()
		return "", ErrNoSession
	}
	st, ok := sess.streams[pod]
	if !ok {
		m.mu.Unlock()
		return "", ErrNoStream
	}
	m.mu.Unlock()

	st.mu.Lock()
	defer st.mu.Unlock()
	if st.filePath == "" {
		return "", ErrNoStream
	}
	st.flushLocked()
	return st.filePath, nil
}

func (m *Manager) streamPayload(sess *Session, st *Stream) map[string]any {
	return map[string]any{
		"context":   sess.Context,
		"namespace": sess.Namespace,
		"stream":    st.status(),
	}
}

// runCountsTicker periodically broadcasts line counts for active streams so
// the UI ticks without per-line notification spam.
func (m *Manager) runCountsTicker(sess *Session) {
	t := time.NewTicker(countsInterval)
	defer t.Stop()
	for {
		select {
		case <-sess.ctx.Done():
			return
		case <-t.C:
		}

		m.mu.Lock()
		streams := make([]*Stream, 0, len(sess.streams))
		for _, st := range sess.streams {
			streams = append(streams, st)
		}
		m.mu.Unlock()

		counts := make([]map[string]any, 0, len(streams))
		for _, st := range streams {
			st.mu.Lock()
			isActive := st.state.active()
			st.mu.Unlock()
			if !isActive {
				continue
			}
			c := map[string]any{"pod": st.Pod, "lines": st.LineCount.Load()}
			if n := st.LastLineAt.Load(); n > 0 {
				c["lastActivity"] = time.Unix(0, n)
			}
			counts = append(counts, c)
		}
		if len(counts) > 0 {
			m.notifyEvent("stream_counts", map[string]any{
				"context": sess.Context, "namespace": sess.Namespace, "streams": counts,
			})
		}
	}
}
