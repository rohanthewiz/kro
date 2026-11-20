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

// unindentedContinuations are well-known continuation lines that start at
// column 0, so the whitespace rule in startsEntry misses them: Java's chained
// cause, and the header Python's logging.exception prints under the message.
// Kept deliberately short: each entry is a HasPrefix per unleveled line.
var unindentedContinuations = []string{
	"Caused by:",
	"Traceback (most recent call last):",
}

// startsEntry reports whether a captured line begins a new log entry, for the
// approximate main entry count (Stream.EntryCount). cls is the line's
// classifyLine result; body is the line as the container emitted it, before
// consumeLine adds its "[container] " tag (the tag would hide indentation).
//
// Rules, in order:
//
//	leveled (cls != "")          → new entry, even if indented
//	blank / whitespace-led       → continuation (stack frames, wrapped text, pretty JSON)
//	known unindented continuation → continuation ("Caused by:", Python "Traceback")
//	anything else                → new entry (plain unleveled app output)
//
// Leveled lines always count so that every errors/warnings entry start is also
// a main entry start, keeping entries ≥ errEntries + warnEntries.
//
// Unlike the errors/warnings counters, this does not inherit through a level
// run (routeLocked's lastRoute). Inheriting would freeze the main count for an
// app that only levels its errors: after one "ERROR" line, every later plain
// line would be a "continuation" until an INFO line appeared. Judging each
// unleveled line by its own shape keeps the count moving with the log; the
// cost is that an unindented, unleveled line inside an error run (Go's
// "goroutine 1 [running]:", Python's final "ValueError: …") counts as a main
// entry but not as an error entry.
func startsEntry(cls, body string) bool {
	if cls != "" {
		return true
	}
	if body == "" || body[0] == ' ' || body[0] == '\t' {
		return false
	}
	for _, p := range unindentedContinuations {
		if strings.HasPrefix(body, p) {
			return false
		}
	}
	return true
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
