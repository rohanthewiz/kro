package kube

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"

	"github.com/rohanthewiz/serr"
)

// TermEvent is a single message in a kubectl terminal stream. Stream is one of
// "stdout", "stderr", "info", or "done". For "done", ExitCode is set.
type TermEvent struct {
	Stream   string `json:"stream"`
	Line     string `json:"line,omitempty"`
	ExitCode int    `json:"exit_code,omitempty"`
}

// TokenizeArgs splits a kubectl argument string into a slice the way a shell
// would, respecting single/double quotes and backslash escapes. It never
// invokes a shell — the result is fed straight to exec.Command, so values
// containing spaces or quoted metacharacters are safe.
func TokenizeArgs(s string) ([]string, error) {
	var out []string
	var cur strings.Builder
	inSingle, inDouble := false, false
	hasToken := false
	for i := 0; i < len(s); i++ {
		ch := s[i]
		switch {
		case inSingle:
			if ch == '\'' {
				inSingle = false
			} else {
				cur.WriteByte(ch)
			}
		case inDouble:
			if ch == '\\' && i+1 < len(s) {
				next := s[i+1]
				if next == '"' || next == '\\' || next == '$' || next == '`' {
					cur.WriteByte(next)
					i++
					continue
				}
				cur.WriteByte(ch)
			} else if ch == '"' {
				inDouble = false
			} else {
				cur.WriteByte(ch)
			}
		case ch == '\'':
			inSingle = true
			hasToken = true
		case ch == '"':
			inDouble = true
			hasToken = true
		case ch == '\\' && i+1 < len(s):
			cur.WriteByte(s[i+1])
			i++
			hasToken = true
		case ch == ' ' || ch == '\t' || ch == '\n':
			if hasToken {
				out = append(out, cur.String())
				cur.Reset()
				hasToken = false
			}
		default:
			cur.WriteByte(ch)
			hasToken = true
		}
	}
	if inSingle || inDouble {
		return nil, serr.New("unterminated quote")
	}
	if hasToken {
		out = append(out, cur.String())
	}
	return out, nil
}

// RunKubectl runs `kubectl --context=ctx --namespace=ns <args...>`, streaming
// stdout and stderr line-by-line into out, then a final "done" event with the
// exit code. Cancel ctx to terminate the process early. stdin is detached so
// commands like `exec -it` exit fast rather than blocking.
func RunKubectl(ctx context.Context, ctxName, ns string, args []string, out chan<- TermEvent) {
	defer func() {
		// Outer caller drains/closes; never close from here.
	}()
	if len(args) == 0 {
		sendTerm(ctx, out, TermEvent{Stream: "stderr", Line: "error: empty command"})
		sendTerm(ctx, out, TermEvent{Stream: "done", ExitCode: 1})
		return
	}

	full := []string{"--context=" + ctxName, "--namespace=" + ns}
	full = append(full, args...)

	cmd := exec.CommandContext(ctx, "kubectl", full...)
	cmd.Stdin = nil
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		sendTerm(ctx, out, TermEvent{Stream: "stderr", Line: "stdout pipe: " + err.Error()})
		sendTerm(ctx, out, TermEvent{Stream: "done", ExitCode: 1})
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		sendTerm(ctx, out, TermEvent{Stream: "stderr", Line: "stderr pipe: " + err.Error()})
		sendTerm(ctx, out, TermEvent{Stream: "done", ExitCode: 1})
		return
	}

	if startErr := cmd.Start(); startErr != nil {
		msg := startErr.Error()
		if strings.Contains(msg, "executable file not found") {
			msg = "kubectl not found in PATH — install kubectl to use the terminal"
		}
		sendTerm(ctx, out, TermEvent{Stream: "stderr", Line: msg})
		sendTerm(ctx, out, TermEvent{Stream: "done", ExitCode: 1})
		return
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go pumpLines(ctx, "stdout", stdout, out, &wg)
	go pumpLines(ctx, "stderr", stderr, out, &wg)
	wg.Wait()

	exitCode := 0
	if waitErr := cmd.Wait(); waitErr != nil {
		if ee, ok := waitErr.(*exec.ExitError); ok {
			exitCode = ee.ExitCode()
		} else if ctx.Err() != nil {
			exitCode = 130 // canceled
		} else {
			exitCode = 1
			sendTerm(ctx, out, TermEvent{Stream: "stderr", Line: "wait: " + waitErr.Error()})
		}
	}
	sendTerm(ctx, out, TermEvent{Stream: "done", ExitCode: exitCode})
}

func pumpLines(ctx context.Context, stream string, r io.Reader, out chan<- TermEvent, wg *sync.WaitGroup) {
	defer wg.Done()
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if !sendTerm(ctx, out, TermEvent{Stream: stream, Line: line}) {
			return
		}
	}
	if err := sc.Err(); err != nil && ctx.Err() == nil {
		sendTerm(ctx, out, TermEvent{Stream: "stderr", Line: fmt.Sprintf("(read %s: %v)", stream, err)})
	}
}

func sendTerm(ctx context.Context, out chan<- TermEvent, ev TermEvent) bool {
	select {
	case out <- ev:
		return true
	case <-ctx.Done():
		return false
	}
}