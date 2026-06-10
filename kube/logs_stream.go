package kube

import (
	"bufio"
	"context"
	"fmt"
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

	var wg sync.WaitGroup
	for _, container := range allContainers {
		wg.Add(1)
		go func(cname string) {
			defer wg.Done()
			tag := ""
			if multi {
				tag = cname
			}
			req := client.CoreV1().Pods(ns).GetLogs(name, &coreV1.PodLogOptions{
				Container: cname,
				TailLines: opts.TailLines,
				SinceTime: opts.SinceTime,
				Follow:    true,
			})
			stream, sErr := req.Stream(ctx)
			for sErr != nil {
				if opts.ReadyTimeout <= 0 || time.Now().After(deadline) {
					sendLine(ctx, out, LogLine{Container: tag, Line: fmt.Sprintf("(stream error for %s: %v)", cname, sErr)})
					return
				}
				if !sleepCtx(ctx, streamRetryInterval) {
					return
				}
				stream, sErr = req.Stream(ctx)
			}
			defer stream.Close()

			scanner := bufio.NewScanner(stream)
			scanner.Buffer(make([]byte, 64*1024), 1024*1024)
			for scanner.Scan() {
				line := strings.TrimRight(scanner.Text(), "\r")
				if !sendLine(ctx, out, LogLine{Container: tag, Line: line}) {
					return
				}
			}
		}(container.Name)
	}
	wg.Wait()
	return nil
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
