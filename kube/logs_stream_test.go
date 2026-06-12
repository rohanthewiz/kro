package kube

import (
	"strings"
	"testing"

	coreV1 "k8s.io/api/core/v1"
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
	tests := []struct {
		name        string
		statuses    []coreV1.ContainerStatus
		cname       string
		includeLast bool
		wantReason  string
		wantMsgSub  string // substring that must appear in the message ("" = empty message)
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
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			reason, msg := classifyContainer(tc.statuses, tc.cname, tc.includeLast)
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
