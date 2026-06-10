package podwatch

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/rohanthewiz/serr"
)

const logFileTimeFormat = "20060102-150405"

// DefaultLogDir returns where background watch logs are written:
//
//	$KRO_WATCH_LOG_DIR  →  os.UserConfigDir()/kro/watch-logs
//
// (mirrors state.DefaultPath so logs live next to state.json).
func DefaultLogDir() (string, error) {
	if p := os.Getenv("KRO_WATCH_LOG_DIR"); p != "" {
		return p, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", serr.Wrap(err, "user config dir")
	}
	return filepath.Join(dir, "kro", "watch-logs"), nil
}

var unsafePathChars = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// sanitize makes a string safe as a single path segment. Context names in
// particular can contain slashes and colons (e.g. EKS ARNs).
func sanitize(s string) string {
	out := unsafePathChars.ReplaceAllString(s, "_")
	if out == "" || out == "." || out == ".." {
		return "_"
	}
	return out
}

// logFilePath builds <dir>/<ctx>/<ns>/<pod>-<timestamp>.log. The timestamp
// disambiguates same-named pods created at different times.
func logFilePath(dir, ctxName, ns, pod string, t time.Time) string {
	name := sanitize(pod) + "-" + t.UTC().Format(logFileTimeFormat) + ".log"
	return filepath.Join(dir, sanitize(ctxName), sanitize(ns), name)
}

// openLogFile creates parent directories and opens the file for appending.
func openLogFile(path string) (*os.File, *bufio.Writer, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, nil, serr.Wrap(err, "mkdir watch log dir")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, nil, serr.Wrap(err, "open watch log file")
	}
	return f, bufio.NewWriterSize(f, 32*1024), nil
}
