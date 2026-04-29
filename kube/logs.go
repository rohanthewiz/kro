package kube

import (
	"bytes"
	"context"
	"fmt"
	"io"

	"github.com/rohanthewiz/serr"
	coreV1 "k8s.io/api/core/v1"
	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

const logsTailLines int64 = 500

// PodLogs returns the last 500 lines from each container of the named pod,
// concatenated with `=== Container: <name> ===` separators when the pod has
// more than one container (init + regular).
func PodLogs(client *kubernetes.Clientset, ns, name string) (string, error) {
	bgCtx := context.Background()

	pod, err := client.CoreV1().Pods(ns).Get(bgCtx, name, metaV1.GetOptions{})
	if err != nil {
		return "", serr.Wrap(err)
	}

	var buf bytes.Buffer
	multiContainer := len(pod.Spec.InitContainers)+len(pod.Spec.Containers) > 1
	allContainers := append(pod.Spec.InitContainers, pod.Spec.Containers...)
	tail := logsTailLines

	for _, container := range allContainers {
		req := client.CoreV1().Pods(ns).GetLogs(name, &coreV1.PodLogOptions{
			Container: container.Name,
			TailLines: &tail,
		})
		stream, sErr := req.Stream(bgCtx)
		if sErr != nil {
			if multiContainer {
				fmt.Fprintf(&buf, "=== Container: %s (error: %v) ===\n\n", container.Name, sErr)
			}
			continue
		}
		data, rErr := io.ReadAll(stream)
		stream.Close()
		if rErr != nil {
			if multiContainer {
				fmt.Fprintf(&buf, "=== Container: %s (read error: %v) ===\n\n", container.Name, rErr)
			}
			continue
		}
		if multiContainer {
			fmt.Fprintf(&buf, "=== Container: %s ===\n", container.Name)
		}
		buf.Write(data)
		if len(data) > 0 && data[len(data)-1] != '\n' {
			buf.WriteByte('\n')
		}
		if multiContainer {
			buf.WriteByte('\n')
		}
	}

	if buf.Len() == 0 {
		return "No logs available — the container may still be starting.", nil
	}
	return buf.String(), nil
}
