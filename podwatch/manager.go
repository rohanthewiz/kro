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
	// The cap on concurrently active (starting|running|paused) log streams
	// across all watch sessions is runtime-settable via SetMaxStreams
	// (driven by the UI slider); these bound it.
	defaultMaxStreams = 10
	absMaxStreams     = 100

	ringLines           = 2000 // per-stream replay buffer for console tees
	subChanSize         = 256  // per-tee subscriber channel buffer
	lineChanSize        = 256  // kube log line channel buffer
	flushInterval       = 2 * time.Second
	countsInterval      = 2 * time.Second
	defaultReadyTimeout = 10 * time.Minute // default wait for a new pod's logs; override via config (KRO_POD_READY_TIMEOUT)
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
	logDir       string
	clientFn     func(ctxName string) (*kubernetes.Clientset, error)
	retention    time.Duration // auto-clean age; written once by StartJanitor before serving
	readyTimeout time.Duration // wait for a new pod's logs; written once before serving (SetReadyTimeout)

	maxStreams atomic.Int64 // cap on active streams; see SetMaxStreams

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

	ctx    context.Context
	cancel context.CancelFunc
	client *kubernetes.Clientset
	// baseline holds pods to ignore: those present at watch start, plus those
	// created while noNewStreams was on. Written by Start (before the watch
	// loop spawns) and then only by the watch-loop goroutine (startStream).
	baseline     map[string]struct{}
	streams      map[string]*Stream // pod name -> stream; guarded by Manager.mu
	noNewStreams bool               // do-not-disturb: ignore newly created pods; guarded by Manager.mu
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
	errPath  string             // <base>.errors.log; set at start, file opened lazily
	warnPath string             // <base>.warnings.log; set at start, file opened lazily
	cancel   context.CancelFunc // cancels the kube log stream (pause/stop)
	file     *os.File
	w        *bufio.Writer
	errFile  *os.File // errors companion; opened on the first error line
	errW     *bufio.Writer
	warnFile *os.File // warnings companion; opened on the first warning line
	warnW    *bufio.Writer
	lastRoute string   // last classified bucket ("err"|"wrn"|"oth"|""), for continuation-line inheritance
	ring      []string // circular: oldest at ringAt once full
	ringAt    int
	// subs maps each console tee's channel to its view filter: "" = all lines,
	// "err" = errors view, "wrn" = warnings view. nil once the stream is terminal.
	subs map[chan string]string
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
	Context      string         `json:"context"`
	Namespace    string         `json:"namespace"`
	StartedAt    time.Time      `json:"startedAt"`
	NoNewStreams bool           `json:"noNewStreams"`
	Streams      []StreamStatus `json:"streams"`
}

type StatusPayload struct {
	MaxStreams    int             `json:"maxStreams"`
	ActiveStreams int             `json:"activeStreams"`
	Sessions      []SessionStatus `json:"sessions"`
}

func NewManager(clientFn func(string) (*kubernetes.Clientset, error), logDir string) *Manager {
	m := &Manager{
		logDir:       logDir,
		clientFn:     clientFn,
		sessions:     map[string]*Session{},
		readyTimeout: defaultReadyTimeout,
	}
	m.maxStreams.Store(defaultMaxStreams)
	return m
}

// SetMaxStreams sets the cap on concurrently active streams, clamped to
// [1, absMaxStreams]. Lowering it below the current active count only blocks
// new streams; existing ones are unaffected. Returns the applied value.
func (m *Manager) SetMaxStreams(n int) int {
	n = max(1, min(n, absMaxStreams))
	m.maxStreams.Store(int64(n))
	m.notifyEvent("max_streams", map[string]any{"max": n})
	return n
}

func (m *Manager) maxStreamsNow() int { return int(m.maxStreams.Load()) }

// SetReadyTimeout overrides how long a new stream waits for a pod's logs to
// become available before giving up. Non-positive values are ignored (the
// default is kept). Call once at startup, before any streams start.
func (m *Manager) SetReadyTimeout(d time.Duration) {
	if d > 0 {
		m.readyTimeout = d
	}
}

// SetNoNewStreams toggles a session's do-not-disturb: while on, pods created
// in the namespace are permanently ignored (they join the baseline) instead
// of getting log streams — so turning it back off does not retroactively
// start streams for pods created during the quiet period. Existing streams
// are unaffected either way.
func (m *Manager) SetNoNewStreams(ctxName, ns string, on bool) error {
	m.mu.Lock()
	sess, ok := m.sessions[sessKey(ctxName, ns)]
	if !ok {
		m.mu.Unlock()
		return ErrNoSession
	}
	sess.noNewStreams = on
	m.mu.Unlock()
	m.notifyEvent("session_no_new", map[string]any{
		"context": ctxName, "namespace": ns, "noNewStreams": on,
	})
	return nil
}

// ClearTerminal removes every terminal (completed|stopped|error) stream from
// the session list. When ctxName and ns are both non-empty it is scoped to
// that one session; otherwise every session is cleared. Log files are kept.
// Returns how many streams were removed.
func (m *Manager) ClearTerminal(ctxName, ns string) int {
	scoped := ctxName != "" && ns != ""
	m.mu.Lock()
	n := 0
	for key, sess := range m.sessions {
		if scoped && key != sessKey(ctxName, ns) {
			continue
		}
		for pod, st := range sess.streams {
			st.mu.Lock()
			terminal := st.state.terminal()
			st.mu.Unlock()
			if terminal {
				delete(sess.streams, pod)
				n++
			}
		}
	}
	m.mu.Unlock()
	if n > 0 {
		m.notifyEvent("streams_cleared", map[string]any{"removed": n})
	}
	return n
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

	out := StatusPayload{MaxStreams: m.maxStreamsNow(), ActiveStreams: active, Sessions: []SessionStatus{}}
	for _, s := range sessions {
		out.Sessions = append(out.Sessions, m.sessionStatus(s))
	}
	return out
}

func (m *Manager) sessionStatus(sess *Session) SessionStatus {
	m.mu.Lock()
	noNew := sess.noNewStreams
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

	ss := SessionStatus{Context: sess.Context, Namespace: sess.Namespace, StartedAt: sess.StartedAt, NoNewStreams: noNew, Streams: []StreamStatus{}}
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

// viewFilter maps a requested console view to the stream's line-bucket filter:
// "errors" → "err", "warnings" → "wrn", anything else (incl. "all") → "".
func viewFilter(view string) string {
	switch view {
	case "errors":
		return "err"
	case "warnings":
		return "wrn"
	default:
		return ""
	}
}

// Subscribe registers a console tee on a stream. The replay snapshot and the
// subscriber registration happen under one lock, so replay + live delivery
// has no gap and no duplicates. view selects what the tee sees:
//
//   - "" / "all": every line. Replay is the ring for a live stream; for a
//     terminal stream with tail > 0 it is the last tail lines of the log file
//     (complete where the ring caps at ringLines; the ring is the fallback if
//     the read fails).
//   - "errors" / "warnings": only that bucket's lines. Replay is the whole
//     companion file (never truncated) and live delivery is filtered to the
//     matching bucket, so the view holds every error/warning ever captured.
//
// For a terminal stream the returned channel is already closed. The returned
// cancel is idempotent and safe to call after the stream closed the channel.
func (m *Manager) Subscribe(ctxName, ns, pod string, tail int, view string) (replay []string, ch <-chan string, cancel func(), err error) {
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

	filter := viewFilter(view)

	st.mu.Lock()
	defer st.mu.Unlock()

	if filter == "" {
		replay = st.ringSnapshotLocked()
	} else {
		// Flush pending writes, then read the companion whole: every line
		// already routed to this bucket is on disk, and any line emitted
		// after we release the lock reaches the (filtered) subscriber — so
		// there is no gap and no duplicate across the replay/live boundary.
		st.flushLocked()
		compPath := st.errPath
		if filter == "wrn" {
			compPath = st.warnPath
		}
		if compPath != "" {
			if lines, rerr := readLogLines(compPath); rerr == nil {
				replay = lines
			}
		}
	}

	sub := make(chan string, subChanSize)
	if st.subs == nil { // terminal: replay only
		if filter == "" && tail > 0 && st.filePath != "" {
			if fromFile, ferr := tailFile(st.filePath, min(tail, maxTailLines)); ferr == nil {
				replay = fromFile
			}
		}
		close(sub)
		return replay, sub, func() {}, nil
	}
	st.subs[sub] = filter
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
