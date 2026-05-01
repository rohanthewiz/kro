package kube

import (
	"bufio"
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/rohanthewiz/serr"
	coreV1 "k8s.io/api/core/v1"
	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

const streamTailLines int64 = 500

// LogLine is one line of streamed pod log output. Container is empty for
// single-container pods; for multi-container pods it is set so callers can
// prefix or otherwise distinguish lines.
type LogLine struct {
	Container string
	Line      string
}

// StreamPodLogs follows logs for every container in the named pod and
// delivers each line on out. It returns when ctx is cancelled or every
// container's stream has ended (e.g., the pod terminated). Callers cancel
// ctx to stop streaming early.
func StreamPodLogs(ctx context.Context, client *kubernetes.Clientset, ns, name string, out chan<- LogLine) error {
	pod, err := client.CoreV1().Pods(ns).Get(ctx, name, metaV1.GetOptions{})
	if err != nil {
		return serr.Wrap(err)
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
			tail := streamTailLines
			req := client.CoreV1().Pods(ns).GetLogs(name, &coreV1.PodLogOptions{
				Container: cname,
				TailLines: &tail,
				Follow:    true,
			})
			stream, sErr := req.Stream(ctx)
			if sErr != nil {
				sendLine(ctx, out, LogLine{Container: tag, Line: fmt.Sprintf("(stream error for %s: %v)", cname, sErr)})
				return
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