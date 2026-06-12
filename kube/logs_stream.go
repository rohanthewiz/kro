package kube

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/rohanthewiz/serr"
	coreV1 "k8s.io/api/core/v1"
	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

const streamTailLines int64 = 500

// streamRetryInterval is how often StreamPodLogsOpts retries the pod Get and
// per-container Stream calls while ReadyTimeout has not elapsed. New pods race
// their own log availability: an ADDED watch event fires while the pod is
// still Pending, when GetLogs would fail with "container is waiting to start".
const streamRetryInterval = 2 * time.Second

// LogLine is one line of streamed pod log output. Container is empty for
// single-container pods; for multi-container pods it is set so callers can
// prefix or otherwise distinguish lines.
type LogLine struct {
	Container string
	Line      string
}

// StreamOpts tunes StreamPodLogsOpts.
type StreamOpts struct {
	// TailLines limits the initial backlog to the last N lines. Nil streams
	// from the start of the pod's logs.
	TailLines *int64
	// SinceTime resumes from a point in time (1-second granularity on the
	// API server, so up to ~1s of lines may repeat).
	SinceTime *metaV1.Time
	// ReadyTimeout, when >0, retries the initial pod Get and each
	// container's Stream call until the deadline, so logs of a pod that is
	// still Pending/starting are picked up once available.
	ReadyTimeout time.Duration
}

// StreamPodLogs follows logs for every container in the named pod and
// delivers each line on out. It returns when ctx is cancelled or every
// container's stream has ended (e.g., the pod terminated). Callers cancel
// ctx to stop streaming early.
func StreamPodLogs(ctx context.Context, client *kubernetes.Clientset, ns, name string, out chan<- LogLine) error {
	tail := streamTailLines
	return StreamPodLogsOpts(ctx, client, ns, name, StreamOpts{TailLines: &tail}, out)
}

// StreamPodLogsOpts is StreamPodLogs with explicit options; see StreamOpts.
//
// A container that is still legitimately coming up (ContainerCreating /
// PodInitializing) is waited on until ReadyTimeout. A container that has
// crashed or otherwise failed (CrashLoopBackOff, ImagePullBackOff, a non-zero
// exit, …) is not waited on: its previous (crashed) instance's logs are
// captured once and a non-nil error describing the failure is returned, so the
// caller can flag the stream rather than show an empty, mislabeled capture.
func StreamPodLogsOpts(ctx context.Context, client *kubernetes.Clientset, ns, name string, opts StreamOpts, out chan<- LogLine) error {
	deadline := time.Now().Add(opts.ReadyTimeout)

	pod, err := client.CoreV1().Pods(ns).Get(ctx, name, metaV1.GetOptions{})
	for err != nil {
		if opts.ReadyTimeout <= 0 || time.Now().After(deadline) {
			return serr.Wrap(err)
		}
		if !sleepCtx(ctx, streamRetryInterval) {
			return serr.Wrap(ctx.Err())
		}
		pod, err = client.CoreV1().Pods(ns).Get(ctx, name, metaV1.GetOptions{})
	}

	allContainers := append([]coreV1.Container{}, pod.Spec.InitContainers...)
	allContainers = append(allContainers, pod.Spec.Containers...)
	multi := len(allContainers) > 1

	var (
		wg       sync.WaitGroup
		errMu    sync.Mutex
		firstErr error
	)
	for _, container := range allContainers {
		wg.Add(1)
		go func(cname string) {
			defer wg.Done()
			tag := ""
			if multi {
				tag = cname
			}
			if cErr := streamContainerLogs(ctx, client, ns, name, cname, tag, opts, deadline, out); cErr != nil {
				errMu.Lock()
				if firstErr == nil {
					firstErr = cErr
				}
				errMu.Unlock()
			}
		}(container.Name)
	}
	wg.Wait()
	return firstErr
}

// streamContainerLogs follows one container's live logs, delivering each line on
// out. While the container is still coming up it retries until the ReadyTimeout
// deadline. If the container is in a crash/error state it captures the previous
// (crashed) instance's logs once and returns an error describing the failure.
// Returns nil on a clean end (the container's log stream closed normally) or
// when ctx is cancelled (pause/stop).
func streamContainerLogs(ctx context.Context, client *kubernetes.Clientset, ns, name, cname, tag string, opts StreamOpts, deadline time.Time, out chan<- LogLine) error {
	prevCaptured := false
	for {
		req := client.CoreV1().Pods(ns).GetLogs(name, &coreV1.PodLogOptions{
			Container: cname,
			TailLines: opts.TailLines,
			SinceTime: opts.SinceTime,
			Follow:    true,
		})
		stream, sErr := req.Stream(ctx)
		if sErr == nil {
			copyStream(ctx, stream, tag, out)
			stream.Close()
			// The follow ended: the container exited or was restarted. If the
			// run we just followed ended in a crash, surface it so the stream
			// is flagged. afterFollow=true also consults LastTerminationState,
			// since a fast restart moves the exit code there.
			if ctx.Err() != nil {
				return nil
			}
			if reason, msg := containerProblem(ctx, client, ns, name, cname, true); reason != "" {
				return fmt.Errorf("container %q %s: %s", cname, reason, msg)
			}
			return nil
		}

		// Stream() failed. Decide whether the container is merely still starting
		// (keep waiting) or has crashed/errored (capture crash logs, flag it).
		if ctx.Err() != nil {
			return nil
		}
		if reason, msg := containerProblem(ctx, client, ns, name, cname, false); reason != "" {
			if !prevCaptured {
				emitPreviousLogs(ctx, client, ns, name, cname, tag, out)
				prevCaptured = true
			}
			return fmt.Errorf("container %q %s: %s", cname, reason, msg)
		}

		// Still starting up (or a transient API error): wait and retry.
		if opts.ReadyTimeout <= 0 || time.Now().After(deadline) {
			return serr.Wrap(sErr)
		}
		if !sleepCtx(ctx, streamRetryInterval) {
			return nil
		}
	}
}

// copyStream scans a log stream line by line, delivering each on out until EOF
// or ctx cancellation.
func copyStream(ctx context.Context, stream io.ReadCloser, tag string, out chan<- LogLine) {
	scanner := bufio.NewScanner(stream)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if !sendLine(ctx, out, LogLine{Container: tag, Line: line}) {
			return
		}
	}
}

// emitPreviousLogs delivers the logs of the container's previous (terminated)
// instance on out, bracketed by markers. Best-effort: if there is no previous
// instance (the container never ran, e.g. ImagePullBackOff) it emits nothing.
func emitPreviousLogs(ctx context.Context, client *kubernetes.Clientset, ns, name, cname, tag string, out chan<- LogLine) {
	req := client.CoreV1().Pods(ns).GetLogs(name, &coreV1.PodLogOptions{
		Container: cname,
		Previous:  true,
	})
	stream, err := req.Stream(ctx)
	if err != nil {
		return // no previous instance to read
	}
	defer stream.Close()
	sendLine(ctx, out, LogLine{Container: tag, Line: "--- previous (crashed) instance logs ---"})
	copyStream(ctx, stream, tag, out)
	sendLine(ctx, out, LogLine{Container: tag, Line: "--- end previous instance logs ---"})
}

// containerProblem reports a crash/error reason and message for the named
// container if it is in a failure state — waiting for a non-startup reason
// (CrashLoopBackOff, ImagePullBackOff, CreateContainerError, …) or terminated
// with a non-zero exit code. It returns "", "" while the container is healthy
// or still legitimately starting up. Both init and regular containers are
// searched. A Get failure is treated as "no problem" so a transient API error
// does not masquerade as a container failure.
// containerProblem fetches the pod and classifies the named container's state.
// When afterFollow is true (a live follow just ended) it also consults
// LastTerminationState, so a crash that a fast restart has already superseded is
// still reported; a pod that is merely being deleted reads as no problem.
func containerProblem(ctx context.Context, client *kubernetes.Clientset, ns, name, cname string, afterFollow bool) (reason, message string) {
	pod, err := client.CoreV1().Pods(ns).Get(ctx, name, metaV1.GetOptions{})
	if err != nil {
		return "", ""
	}
	if afterFollow && pod.DeletionTimestamp != nil {
		return "", "" // pod is being removed, not crashing
	}
	statuses := append([]coreV1.ContainerStatus{}, pod.Status.InitContainerStatuses...)
	statuses = append(statuses, pod.Status.ContainerStatuses...)
	return classifyContainer(statuses, cname, afterFollow)
}

// classifyContainer is the pure classification behind containerProblem: given a
// pod's container statuses, it returns the crash/error reason and message for
// the named container, or "", "" when it is healthy or still starting up. When
// includeLast is true the container's last terminated instance (the run that
// just ended) is considered as well as its current state.
func classifyContainer(statuses []coreV1.ContainerStatus, cname string, includeLast bool) (reason, message string) {
	for _, cs := range statuses {
		if cs.Name != cname {
			continue
		}
		if w := cs.State.Waiting; w != nil && !isStartupReason(w.Reason) {
			return w.Reason, strings.TrimSpace(w.Message)
		}
		if r, m, ok := terminatedProblem(cs.State.Terminated); ok {
			return r, m
		}
		if includeLast {
			if r, m, ok := terminatedProblem(cs.LastTerminationState.Terminated); ok {
				return r, m
			}
		}
		return "", ""
	}
	return "", ""
}

// terminatedProblem reports the reason/message for a Terminated state that
// exited non-zero. ok is false for a nil state or a clean (exit 0) termination.
func terminatedProblem(t *coreV1.ContainerStateTerminated) (reason, message string, ok bool) {
	if t == nil || t.ExitCode == 0 {
		return "", "", false
	}
	reason = t.Reason
	if reason == "" {
		reason = "Error"
	}
	return reason, strings.TrimSpace(fmt.Sprintf("exit code %d %s", t.ExitCode, t.Message)), true
}

// isStartupReason reports whether a container Waiting reason means it is still
// legitimately coming up (as opposed to having crashed or failed).
func isStartupReason(reason string) bool {
	switch reason {
	case "", "ContainerCreating", "PodInitializing":
		return true
	}
	return false
}

func sendLine(ctx context.Context, out chan<- LogLine, line LogLine) bool {
	select {
	case out <- line:
		return true
	case <-ctx.Done():
		return false
	}
}

// sleepCtx waits d or until ctx is done; reports true if the full duration elapsed.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}
