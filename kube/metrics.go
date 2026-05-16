package kube

import (
	"context"
	"encoding/json"
	"time"

	"github.com/rohanthewiz/serr"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/client-go/kubernetes"
)

// PodMetricsSample is one point-in-time reading for a pod, aggregated and
// broken down per container. CPU is in millicores; memory in bytes — both
// pre-parsed so the UI does no quantity math.
type PodMetricsSample struct {
	Timestamp  time.Time          `json:"ts"`
	Window     string             `json:"window,omitempty"`
	CPUMilli   int64              `json:"cpu_m"`
	MemBytes   int64              `json:"mem_bytes"`
	Containers []ContainerMetrics `json:"containers"`
}

type ContainerMetrics struct {
	Name     string `json:"name"`
	CPUMilli int64  `json:"cpu_m"`
	MemBytes int64  `json:"mem_bytes"`
}

// ErrMetricsUnavailable signals that the metrics.k8s.io API isn't installed
// on the cluster (or isn't reachable). UI shows a friendly message rather
// than retrying forever.
var ErrMetricsUnavailable = serr.New("metrics API unavailable (metrics-server not installed?)")

// raw shape returned by GET /apis/metrics.k8s.io/v1beta1/namespaces/<ns>/pods/<name>
type rawPodMetrics struct {
	Timestamp  time.Time `json:"timestamp"`
	Window     string    `json:"window"`
	Containers []struct {
		Name  string `json:"name"`
		Usage struct {
			CPU    string `json:"cpu"`
			Memory string `json:"memory"`
		} `json:"usage"`
	} `json:"containers"`
}

// PodMetrics fetches a single live-usage sample for the named pod from the
// metrics.k8s.io API (the same source kubectl top uses). Returns
// ErrMetricsUnavailable wrapped when metrics-server is missing.
func PodMetrics(ctx context.Context, client *kubernetes.Clientset, ns, name string) (PodMetricsSample, error) {
	raw, err := client.RESTClient().Get().
		AbsPath("/apis/metrics.k8s.io/v1beta1/namespaces", ns, "pods", name).
		DoRaw(ctx)
	if err != nil {
		if errors.IsNotFound(err) || errors.IsServiceUnavailable(err) {
			return PodMetricsSample{}, serr.Wrap(ErrMetricsUnavailable, err.Error())
		}
		return PodMetricsSample{}, serr.Wrap(err, "fetch pod metrics")
	}

	var m rawPodMetrics
	if err := json.Unmarshal(raw, &m); err != nil {
		return PodMetricsSample{}, serr.Wrap(err, "decode pod metrics")
	}

	sample := PodMetricsSample{
		Timestamp:  m.Timestamp,
		Window:     m.Window,
		Containers: make([]ContainerMetrics, 0, len(m.Containers)),
	}
	if sample.Timestamp.IsZero() {
		sample.Timestamp = time.Now()
	}
	for _, c := range m.Containers {
		cpuM := parseCPUMilli(c.Usage.CPU)
		memB := parseMemBytes(c.Usage.Memory)
		sample.Containers = append(sample.Containers, ContainerMetrics{
			Name: c.Name, CPUMilli: cpuM, MemBytes: memB,
		})
		sample.CPUMilli += cpuM
		sample.MemBytes += memB
	}
	return sample, nil
}

func parseCPUMilli(s string) int64 {
	if s == "" {
		return 0
	}
	q, err := resource.ParseQuantity(s)
	if err != nil {
		return 0
	}
	return q.MilliValue()
}

func parseMemBytes(s string) int64 {
	if s == "" {
		return 0
	}
	q, err := resource.ParseQuantity(s)
	if err != nil {
		return 0
	}
	return q.Value()
}
