package podwatch

import (
	"bufio"
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strings"
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

// companionPath derives a sibling file for a classification of a stream's log:
//
//	<base>-<ts>.log  →  <base>-<ts>.<kind>.log   (kind: "errors" | "warnings")
//
// These hold only the error/warning subset of lines and are never truncated,
// so the full history stays accessible even after the console buffer scrolls.
func companionPath(mainPath, kind string) string {
	return strings.TrimSuffix(mainPath, ".log") + "." + kind + ".log"
}

// tailChunkSize is how much tailFile reads per step while walking backwards.
const tailChunkSize = 64 * 1024

// tailFile returns up to n trailing lines of the file at path, reading
// backwards in chunks so large logs are never loaded whole. Used to replay
// an already-ended stream into a console frame: the file is authoritative
// and can hold far more than the in-memory ring.
func tailFile(path string, n int) ([]string, error) {
	if n <= 0 {
		return nil, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, serr.Wrap(err, "open log for tail")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, serr.Wrap(err, "stat log for tail")
	}

	var buf []byte
	off := info.Size()
	for off > 0 && bytes.Count(buf, []byte{'\n'}) <= n {
		readLen := min(off, int64(tailChunkSize))
		off -= readLen
		b := make([]byte, readLen)
		if _, err := f.ReadAt(b, off); err != nil {
			return nil, serr.Wrap(err, "read log tail")
		}
		buf = append(b, buf...)
	}
	if len(buf) == 0 {
		return nil, nil
	}

	lines := strings.Split(strings.TrimSuffix(string(buf), "\n"), "\n")
	if off > 0 && len(lines) > 0 {
		lines = lines[1:] // we stopped mid-file: the first line may be partial
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines, nil
}

// readLogLines returns every line of the file at path (nil if it does not
// exist). Used to replay a companion (errors/warnings) file in full — these
// hold only the classified subset, so they stay small enough to read whole,
// which is the point: the errors/warnings view is never truncated.
func readLogLines(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, serr.Wrap(err, "open companion log")
	}
	defer f.Close()

	var lines []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024) // tolerate long lines
	for sc.Scan() {
		lines = append(lines, sc.Text())
	}
	if err := sc.Err(); err != nil {
		return nil, serr.Wrap(err, "scan companion log")
	}
	return lines, nil
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
