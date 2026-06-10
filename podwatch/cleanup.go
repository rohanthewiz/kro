package podwatch

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/rohanthewiz/logger"
	"github.com/rohanthewiz/serr"
)

// Watch logs accumulate under logDir until something removes them. A janitor
// goroutine prunes files older than a retention period (default 7 days,
// KRO_WATCH_LOG_RETENTION_DAYS override, 0 disables), and the UI's gear
// popover exposes usage plus an on-demand cleanup. Files of streams still
// tracked by the manager are never removed, regardless of age.

const (
	defaultRetentionDays = 7
	janitorInterval      = 6 * time.Hour
)

// RetentionFromEnv returns the auto-clean age: KRO_WATCH_LOG_RETENTION_DAYS
// days if set to a non-negative integer, else 7 days. 0 disables auto-clean.
func RetentionFromEnv() time.Duration {
	if v := os.Getenv("KRO_WATCH_LOG_RETENTION_DAYS"); v != "" {
		if d, err := strconv.Atoi(v); err == nil && d >= 0 {
			return time.Duration(d) * 24 * time.Hour
		}
	}
	return defaultRetentionDays * 24 * time.Hour
}

// LogDirInfo describes the watch-log directory for the UI.
type LogDirInfo struct {
	Dir           string `json:"dir"`
	Files         int    `json:"files"`
	Bytes         int64  `json:"bytes"`
	RetentionDays int    `json:"retentionDays"` // 0 = auto-clean disabled
}

// StartJanitor records the retention period and, unless it is 0, starts a
// background pruner that runs immediately and then every janitorInterval.
// Call once at startup, before the server begins handling requests.
func (m *Manager) StartJanitor(maxAge time.Duration) {
	m.retention = maxAge
	if maxAge <= 0 {
		return
	}
	go func() {
		for {
			removed, freed, err := m.Cleanup(maxAge)
			if err != nil {
				logger.LogErr(serr.Wrap(err, "watch log cleanup"))
			} else if removed > 0 {
				logger.InfoF("watch log cleanup: removed %d file(s), freed %d bytes", removed, freed)
			}
			time.Sleep(janitorInterval)
		}
	}()
}

// LogDirInfo walks the log dir and reports file count and total size.
func (m *Manager) LogDirInfo() LogDirInfo {
	info := LogDirInfo{Dir: m.logDir, RetentionDays: int(m.retention / (24 * time.Hour))}
	filepath.WalkDir(m.logDir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil // a vanished entry or unreadable subdir shouldn't kill the count
		}
		if fi, err := d.Info(); err == nil {
			info.Files++
			info.Bytes += fi.Size()
		}
		return nil
	})
	return info
}

// Cleanup removes .log files under the log dir whose mtime is older than
// maxAge, then prunes any directories left empty. Files belonging to streams
// the manager still tracks (active or listed-terminal) are always kept —
// their tails and exports must keep working.
func (m *Manager) Cleanup(maxAge time.Duration) (removed int, freed int64, err error) {
	keep := m.trackedFiles()
	cutoff := time.Now().Add(-maxAge)

	var dirs []string
	walkErr := filepath.WalkDir(m.logDir, func(path string, d fs.DirEntry, werr error) error {
		if werr != nil {
			if path == m.logDir && os.IsNotExist(werr) {
				return filepath.SkipAll // nothing written yet
			}
			return werr
		}
		if d.IsDir() {
			if path != m.logDir {
				dirs = append(dirs, path)
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".log") || keep[path] {
			return nil
		}
		fi, ferr := d.Info()
		if ferr != nil || !fi.ModTime().Before(cutoff) {
			return nil
		}
		if rerr := os.Remove(path); rerr == nil {
			removed++
			freed += fi.Size()
		}
		return nil
	})
	if walkErr != nil {
		return removed, freed, serr.Wrap(walkErr, "walk watch log dir")
	}

	// Deepest-first so emptied leaf dirs unlock their parents; Remove fails
	// harmlessly on non-empty dirs.
	sort.Slice(dirs, func(i, j int) bool { return len(dirs[i]) > len(dirs[j]) })
	for _, d := range dirs {
		os.Remove(d)
	}
	return removed, freed, nil
}

// trackedFiles snapshots the file path of every stream the manager knows
// about, across all sessions.
func (m *Manager) trackedFiles() map[string]bool {
	m.mu.Lock()
	streams := []*Stream{}
	for _, sess := range m.sessions {
		for _, st := range sess.streams {
			streams = append(streams, st)
		}
	}
	m.mu.Unlock()

	keep := map[string]bool{}
	for _, st := range streams {
		st.mu.Lock()
		if st.filePath != "" {
			keep[st.filePath] = true
		}
		st.mu.Unlock()
	}
	return keep
}
