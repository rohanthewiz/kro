package podwatch

import (
	"context"
	"time"

	"kro/kube"

	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// startStream begins background capture for a newly seen pod: registers the
// stream (enforcing the stream cap), opens its log file, and spawns the
// capture goroutine. Called from the watch loop; no-op if already tracked.
func (m *Manager) startStream(sess *Session, podName string) {
	m.mu.Lock()
	if sess.ctx.Err() != nil { // session stopped while an event was in flight
		m.mu.Unlock()
		return
	}
	if _, exists := sess.streams[podName]; exists {
		m.mu.Unlock()
		return
	}
	if sess.noNewStreams {
		// Do-not-disturb: baseline the pod so it stays ignored even after the
		// toggle is turned back off (a later re-list won't pick it up).
		sess.baseline[podName] = struct{}{}
		m.mu.Unlock()
		return
	}
	if m.activeStreamCountLocked() >= m.maxStreamsNow() {
		m.mu.Unlock()
		m.notifyEvent("limit_reached", map[string]any{
			"context": sess.Context, "namespace": sess.Namespace,
			"pod": podName, "max": m.maxStreamsNow(),
		})
		return
	}
	now := time.Now()
	st := &Stream{
		Pod:       podName,
		StartedAt: now,
		state:     StateStarting,
		subs:      map[chan string]string{},
	}
	sess.streams[podName] = st
	m.mu.Unlock()

	path := logFilePath(m.logDir, sess.Context, sess.Namespace, podName, now)
	f, w, err := openLogFile(path)

	st.mu.Lock()
	st.filePath = path
	st.errPath = companionPath(path, "errors")
	st.warnPath = companionPath(path, "warnings")
	if err != nil {
		st.errMsg = err.Error()
		st.closeLocked(StateError)
		st.mu.Unlock()
		m.notifyEvent("stream_state", m.streamPayload(sess, st))
		return
	}
	st.file, st.w = f, w
	streamCtx, cancel := context.WithCancel(sess.ctx)
	st.cancel = cancel
	st.mu.Unlock()

	m.notifyEvent("stream_added", m.streamPayload(sess, st))
	go m.runStream(sess, st, streamCtx, nil)
}

// runStream pumps one pod's log lines into the file/ring/subscribers until
// the kube stream ends or ctx is cancelled (pause, stop, or session stop).
// since, when set, resumes from that time (see resume in StreamAction).
func (m *Manager) runStream(sess *Session, st *Stream, ctx context.Context, since *metaV1.Time) {
	lines := make(chan kube.LogLine, lineChanSize)
	done := make(chan error, 1)
	go func() {
		done <- kube.StreamPodLogsOpts(ctx, sess.client, sess.Namespace, st.Pod,
			kube.StreamOpts{SinceTime: since, ReadyTimeout: m.readyTimeout}, lines)
	}()

	flush := time.NewTicker(flushInterval)
	defer flush.Stop()

	var streamErr error
	for pumping := true; pumping; {
		select {
		case ln := <-lines:
			m.consumeLine(sess, st, ln)
		case <-flush.C:
			st.mu.Lock()
			st.flushLocked()
			st.mu.Unlock()
		case streamErr = <-done:
			pumping = false
		}
	}
	// All producer goroutines have exited; drain whatever is buffered.
	for drained := false; !drained; {
		select {
		case ln := <-lines:
			m.consumeLine(sess, st, ln)
		default:
			drained = true
		}
	}

	st.mu.Lock()
	if !st.state.active() { // stop already finalized things
		st.mu.Unlock()
		return
	}
	if ctx.Err() != nil {
		// Cancelled: by pause/stop (their bookkeeping already ran or runs
		// under st.mu) or by session teardown. A stream that is still
		// active here with a dead session lost the race with Stop's
		// finalize snapshot — close it the same way Stop would.
		if sess.ctx.Err() != nil {
			st.writeMarkerLocked("stopped (watch ended)")
			st.closeLocked(StateStopped)
			st.mu.Unlock()
			return
		}
		st.flushLocked() // paused: keep file open, capture resumes later
		st.mu.Unlock()
		return
	}
	// Natural end (pod terminated) or stream failure.
	if streamErr != nil {
		st.errMsg = streamErr.Error()
		st.writeMarkerLocked("error: " + st.errMsg)
		st.closeLocked(StateError)
	} else {
		st.writeMarkerLocked("stream ended")
		st.closeLocked(StateCompleted)
	}
	st.mu.Unlock()
	m.notifyEvent("stream_state", m.streamPayload(sess, st))
}

func (m *Manager) consumeLine(sess *Session, st *Stream, ln kube.LogLine) {
	line := ln.Line
	if ln.Container != "" {
		line = "[" + ln.Container + "] " + line
	}
	if st.writeLine(line) { // first line: starting → running
		m.notifyEvent("stream_state", m.streamPayload(sess, st))
	}
}

// writeLine appends a captured line to the file, ring, and subscribers.
// Reports whether the stream just transitioned starting → running.
func (st *Stream) writeLine(line string) (flipped bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.state.terminal() {
		return false
	}
	if st.state == StateStarting {
		st.state = StateRunning
		flipped = true
	}
	st.emitLocked(line)
	st.LineCount.Add(1)
	st.LastLineAt.Store(time.Now().UnixNano())
	return flipped
}

// writeMarkerLocked records a lifecycle marker (paused/resumed/stopped/...)
// in the file, ring, and subscribers so gaps are visible everywhere.
func (st *Stream) writeMarkerLocked(text string) {
	st.emitLocked("--- " + text + " " + time.Now().UTC().Format(time.RFC3339) + " ---")
}

// emitLocked writes one line to the main file (if open), the matching
// errors/warnings companion file, the ring, and all subscribers. Subscribers
// with a view filter ("err"/"wrn") receive only lines in their bucket.
func (st *Stream) emitLocked(line string) {
	route := st.routeLocked(line)
	if st.w != nil {
		st.w.WriteString(line)
		st.w.WriteByte('\n')
	}
	if route != "" {
		st.writeIssueLocked(route, line)
	}
	if len(st.ring) < ringLines {
		st.ring = append(st.ring, line)
	} else {
		st.ring[st.ringAt] = line
		st.ringAt = (st.ringAt + 1) % ringLines
	}
	for sub, filter := range st.subs {
		if filter != "" && filter != route {
			continue
		}
		select { // never block capture on a slow tee; the file is authoritative
		case sub <- line:
		default:
		}
	}
}

// routeLocked classifies a line into an issue bucket ("err"|"wrn") or "",
// carrying the last recognized level forward so unleveled continuation lines
// (stack traces, wrapped messages) follow the entry that produced them — the
// same inheritance the browser colorizer applies per frame.
func (st *Stream) routeLocked(line string) string {
	switch b := classifyLine(line); b {
	case "err", "wrn":
		st.lastRoute = b
		return b
	case "oth":
		st.lastRoute = "oth" // a real info/debug line ends any error/warn run
		return ""
	default: // "" — no level token: inherit an ongoing error/warn run
		if st.lastRoute == "err" || st.lastRoute == "wrn" {
			return st.lastRoute
		}
		return ""
	}
}

// writeIssueLocked appends an error/warning line to its companion file,
// creating the file lazily on first use so a clean pod produces no extra
// files. Best-effort: a companion open/write failure never disrupts capture,
// since the main log remains authoritative.
func (st *Stream) writeIssueLocked(route, line string) {
	switch route {
	case "err":
		if st.errW == nil {
			if st.errPath == "" {
				return
			}
			f, w, err := openLogFile(st.errPath)
			if err != nil {
				return
			}
			st.errFile, st.errW = f, w
		}
		st.errW.WriteString(line)
		st.errW.WriteByte('\n')
	case "wrn":
		if st.warnW == nil {
			if st.warnPath == "" {
				return
			}
			f, w, err := openLogFile(st.warnPath)
			if err != nil {
				return
			}
			st.warnFile, st.warnW = f, w
		}
		st.warnW.WriteString(line)
		st.warnW.WriteByte('\n')
	}
}

func (st *Stream) ringSnapshotLocked() []string {
	out := make([]string, 0, len(st.ring))
	out = append(out, st.ring[st.ringAt:]...)
	out = append(out, st.ring[:st.ringAt]...)
	return out
}

func (st *Stream) flushLocked() {
	if st.w != nil {
		st.w.Flush()
	}
	if st.errW != nil {
		st.errW.Flush()
	}
	if st.warnW != nil {
		st.warnW.Flush()
	}
}

// closeLocked flushes and closes the file, closes all tee subscribers, and
// sets the terminal state.
func (st *Stream) closeLocked(state StreamState) {
	st.flushLocked()
	if st.file != nil {
		st.file.Close()
		st.file, st.w = nil, nil
	}
	if st.errFile != nil {
		st.errFile.Close()
		st.errFile, st.errW = nil, nil
	}
	if st.warnFile != nil {
		st.warnFile.Close()
		st.warnFile, st.warnW = nil, nil
	}
	for sub := range st.subs {
		close(sub)
	}
	st.subs = nil
	st.state = state
}

// finalize is closeLocked behind the lock with a marker, idempotent on
// already-terminal streams. Used by session Stop.
func (st *Stream) finalize(state StreamState, marker string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.state.terminal() {
		return
	}
	if st.cancel != nil {
		st.cancel()
		st.cancel = nil
	}
	st.writeMarkerLocked(marker)
	st.closeLocked(state)
}

// status snapshots the stream for JSON payloads.
func (st *Stream) status() StreamStatus {
	st.mu.Lock()
	state, errMsg, path := st.state, st.errMsg, st.filePath
	st.mu.Unlock()

	var last time.Time
	if n := st.LastLineAt.Load(); n > 0 {
		last = time.Unix(0, n)
	}
	return StreamStatus{
		Pod:          st.Pod,
		State:        string(state),
		File:         path,
		StartedAt:    st.StartedAt,
		Lines:        st.LineCount.Load(),
		LastActivity: last,
		Error:        errMsg,
	}
}
