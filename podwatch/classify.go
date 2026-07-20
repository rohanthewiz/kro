package podwatch

import (
	"regexp"
	"strings"
)

// Log lines are routed into per-stream "errors" and "warnings" companion
// files (and the errors/warnings console views) so those lines survive even
// after the main console buffer scrolls past them. Classification mirrors the
// browser colorizer's level detection (web/embeds/resources.js) so the files
// match exactly what the UI tags as errors and warnings.

var (
	reJSONLevel   = regexp.MustCompile(`(?i)"level"\s*:\s*"([A-Za-z]+)"`)
	reLogfmtLevel = regexp.MustCompile(`(?i)\blevel="?([A-Za-z]+)`)
	reBareErr     = regexp.MustCompile(`\b(ERROR|FATAL|PANIC|FTL|ERR)\b`)
	reBareWarn    = regexp.MustCompile(`\b(WARNING|WARN|WRN)\b`)
	reBareInfo    = regexp.MustCompile(`\b(INFO|INF|DEBUG|DEB|DBG|TRACE|TRC)\b`)
)

// classifyLine maps one log line to a routing bucket:
//
//	"err" — error / fatal / panic
//	"wrn" — warning
//	"oth" — a recognized info/debug/trace line (ends an error/warn run)
//	""    — no recognizable level (a continuation line: stack trace, etc.)
//
// A structured level= or "level":"…" token is authoritative; otherwise a bare
// uppercase level token (logrus/zerolog console output) is used.
func classifyLine(line string) string {
	if tok := levelToken(line); tok != "" {
		switch bucketOf(tok) {
		case "err":
			return "err"
		case "wrn":
			return "wrn"
		default:
			return "oth" // a leveled line that is neither error nor warning
		}
	}
	switch {
	case reBareErr.MatchString(line):
		return "err"
	case reBareWarn.MatchString(line):
		return "wrn"
	case reBareInfo.MatchString(line):
		return "oth"
	}
	return ""
}

// levelToken extracts the level value from a structured line, JSON first
// (`"level":"error"`) then logfmt (`level=error` / `level="error"`).
func levelToken(line string) string {
	if m := reJSONLevel.FindStringSubmatch(line); m != nil {
		return m[1]
	}
	if m := reLogfmtLevel.FindStringSubmatch(line); m != nil {
		return m[1]
	}
	return ""
}

// bucketOf collapses a level token (full word or short form) to "err", "wrn",
// or "" (any other recognized level).
func bucketOf(tok string) string {
	switch strings.ToLower(tok) {
	case "error", "err", "erro", "fatal", "fata", "ftl", "panic", "pani":
		return "err"
	case "warn", "warning", "wrn":
		return "wrn"
	}
	return ""
}
