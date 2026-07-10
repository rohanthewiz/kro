package kube

import (
	"io"
	"slices"
	"strings"
	"testing"
	"time"

	coreV1 "k8s.io/api/core/v1"
	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func waiting(name, reason, msg string) coreV1.ContainerStatus {
	return coreV1.ContainerStatus{
		Name:  name,
		State: coreV1.ContainerState{Waiting: &coreV1.ContainerStateWaiting{Reason: reason, Message: msg}},
	}
}

func terminated(name, reason string, code int32, msg string) coreV1.ContainerStatus {
	return coreV1.ContainerStatus{
		Name: name,
		State: coreV1.ContainerState{Terminated: &coreV1.ContainerStateTerminated{
			Reason: reason, ExitCode: code, Message: msg,
		}},
	}
}

func running(name string) coreV1.ContainerStatus {
	return coreV1.ContainerStatus{
		Name:  name,
		State: coreV1.ContainerState{Running: &coreV1.ContainerStateRunning{}},
	}
}

// runningAfterCrash models a container that crashed (exit code) and has already
// restarted, so the crash now lives in LastTerminationState.
func runningAfterCrash(name string, code int32) coreV1.ContainerStatus {
	cs := running(name)
	cs.LastTerminationState = coreV1.ContainerState{Terminated: &coreV1.ContainerStateTerminated{
		Reason: "Error", ExitCode: code,
	}}
	return cs
}

// runningAfterCrashAt is runningAfterCrash with an explicit crash finish time.
func runningAfterCrashAt(name string, code int32, finished time.Time) coreV1.ContainerStatus {
	cs := runningAfterCrash(name, code)
	cs.LastTerminationState.Terminated.FinishedAt = metaV1.NewTime(finished)
	return cs
}

func TestIsStartupReason(t *testing.T) {
	for _, r := range []string{"", "ContainerCreating", "PodInitializing"} {
		if !isStartupReason(r) {
			t.Errorf("expected %q to be a startup reason", r)
		}
	}
	for _, r := range []string{"CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerError"} {
		if isStartupReason(r) {
			t.Errorf("expected %q to NOT be a startup reason", r)
		}
	}
}

func TestClassifyContainer(t *testing.T) {
	followStart := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)

	tests := []struct {
		name         string
		statuses     []coreV1.ContainerStatus
		cname        string
		includeLast  bool
		crashesSince time.Time
		wantReason   string
		wantMsgSub   string // substring that must appear in the message ("" = empty message)
	}{
		{
			name:       "still starting is not a problem",
			statuses:   []coreV1.ContainerStatus{waiting("app", "ContainerCreating", "")},
			cname:      "app",
			wantReason: "",
		},
		{
			name:       "running is not a problem",
			statuses:   []coreV1.ContainerStatus{running("app")},
			cname:      "app",
			wantReason: "",
		},
		{
			name:       "crashloop is a problem",
			statuses:   []coreV1.ContainerStatus{waiting("app", "CrashLoopBackOff", "back-off 5m0s restarting")},
			cname:      "app",
			wantReason: "CrashLoopBackOff",
			wantMsgSub: "back-off",
		},
		{
			name:       "image pull error is a problem",
			statuses:   []coreV1.ContainerStatus{waiting("app", "ImagePullBackOff", "Back-off pulling image")},
			cname:      "app",
			wantReason: "ImagePullBackOff",
			wantMsgSub: "pulling",
		},
		{
			name:       "non-zero exit is a problem",
			statuses:   []coreV1.ContainerStatus{terminated("app", "Error", 1, "boom")},
			cname:      "app",
			wantReason: "Error",
			wantMsgSub: "exit code 1",
		},
		{
			name:       "zero exit is a clean completion",
			statuses:   []coreV1.ContainerStatus{terminated("app", "Completed", 0, "")},
			cname:      "app",
			wantReason: "",
		},
		{
			name:       "terminated with empty reason defaults to Error",
			statuses:   []coreV1.ContainerStatus{terminated("app", "", 137, "")},
			cname:      "app",
			wantReason: "Error",
			wantMsgSub: "exit code 137",
		},
		{
			name:       "matches the named container among several",
			statuses:   []coreV1.ContainerStatus{running("sidecar"), waiting("app", "CrashLoopBackOff", "")},
			cname:      "app",
			wantReason: "CrashLoopBackOff",
		},
		{
			name:       "unknown container reports nothing",
			statuses:   []coreV1.ContainerStatus{running("app")},
			cname:      "missing",
			wantReason: "",
		},
		{
			name:        "restarted-after-crash ignored unless includeLast",
			statuses:    []coreV1.ContainerStatus{runningAfterCrash("app", 7)},
			cname:       "app",
			includeLast: false,
			wantReason:  "",
		},
		{
			name:        "restarted-after-crash flagged with includeLast",
			statuses:    []coreV1.ContainerStatus{runningAfterCrash("app", 7)},
			cname:       "app",
			includeLast: true,
			wantReason:  "Error",
			wantMsgSub:  "exit code 7",
		},
		{
			name:         "crash during the follow is flagged",
			statuses:     []coreV1.ContainerStatus{runningAfterCrashAt("app", 7, followStart.Add(time.Minute))},
			cname:        "app",
			includeLast:  true,
			crashesSince: followStart,
			wantReason:   "Error",
			wantMsgSub:   "exit code 7",
		},
		{
			name:         "old crash predating the follow is ignored",
			statuses:     []coreV1.ContainerStatus{runningAfterCrashAt("app", 7, followStart.Add(-time.Hour))},
			cname:        "app",
			includeLast:  true,
			crashesSince: followStart,
			wantReason:   "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			reason, msg := classifyContainer(tc.statuses, tc.cname, tc.includeLast, tc.crashesSince)
			if reason != tc.wantReason {
				t.Fatalf("reason = %q, want %q", reason, tc.wantReason)
			}
			if tc.wantMsgSub == "" {
				return
			}
			if !strings.Contains(msg, tc.wantMsgSub) {
				t.Fatalf("message %q does not contain %q", msg, tc.wantMsgSub)
			}
		})
	}
}

func TestSplitLogTimestamp(t *testing.T) {
	ts, rest, ok := splitLogTimestamp("2026-07-10T12:00:05.700000001Z hello world")
	if !ok || rest != "hello world" {
		t.Fatalf("ok=%v rest=%q", ok, rest)
	}
	if want := time.Date(2026, 7, 10, 12, 0, 5, 700000001, time.UTC); !ts.Equal(want) {
		t.Fatalf("ts = %v, want %v", ts, want)
	}

	// Empty log line: timestamp with trailing space.
	if _, rest, ok := splitLogTimestamp("2026-07-10T12:00:05Z "); !ok || rest != "" {
		t.Fatalf("empty line: ok=%v rest=%q", ok, rest)
	}

	// Not a timestamp: line comes back untouched.
	if _, rest, ok := splitLogTimestamp("plain line no timestamp"); ok || rest != "plain line no timestamp" {
		t.Fatalf("plain line: ok=%v rest=%q", ok, rest)
	}
}

func TestCopyTimestampedStreamSkipsReplayedLines(t *testing.T) {
	input := "2026-07-10T12:00:05.100000000Z old-a\n" + // replayed by SinceTime, before skipThrough
		"2026-07-10T12:00:05.500000000Z old-b\n" + // exactly at skipThrough: also dropped
		"2026-07-10T12:00:05.900000000Z new-a\n" +
		"2026-07-10T12:00:06.000000000Z new-b\n"
	skipThrough := time.Date(2026, 7, 10, 12, 0, 5, 500000000, time.UTC)

	out := make(chan LogLine, 16)
	last := copyTimestampedStream(t.Context(), io.NopCloser(strings.NewReader(input)), "c1", skipThrough, out)
	close(out)

	var got []string
	for ln := range out {
		if ln.Container != "c1" {
			t.Fatalf("container tag = %q, want c1", ln.Container)
		}
		got = append(got, ln.Line)
	}
	if want := []string{"new-a", "new-b"}; !slices.Equal(got, want) {
		t.Fatalf("lines = %v, want %v", got, want)
	}
	if want := time.Date(2026, 7, 10, 12, 0, 6, 0, time.UTC); !last.Equal(want) {
		t.Fatalf("last = %v, want %v", last, want)
	}
}
