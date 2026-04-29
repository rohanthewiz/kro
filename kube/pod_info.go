package kube

import (
	"fmt"
	"time"

	coreV1 "k8s.io/api/core/v1"
)

// containerStatus derives a human-readable status from the pod's container
// statuses (e.g. "ContainerCreating", "CrashLoopBackOff", "OOMKilled",
// "Completed", "Running"). Falls back to the pod phase if no container-level
// detail is available.
func containerStatus(podStatus coreV1.PodStatus) string {
	for _, cs := range podStatus.InitContainerStatuses {
		if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
			return cs.State.Waiting.Reason
		}
		if cs.State.Terminated != nil && cs.State.Terminated.Reason != "" {
			return cs.State.Terminated.Reason
		}
	}
	for _, cs := range podStatus.ContainerStatuses {
		if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
			return cs.State.Waiting.Reason
		}
		if cs.State.Terminated != nil && cs.State.Terminated.Reason != "" {
			return cs.State.Terminated.Reason
		}
	}
	return string(podStatus.Phase)
}

// podSpecResources sums container resource requests from the pod spec.
// Returns formatted CPU (millicores) and memory strings, with an asterisk
// to indicate "requested" rather than "live usage".
func podSpecResources(spec coreV1.PodSpec) (cpu, memory string) {
	var cpuTotal, memTotal int64
	for _, c := range spec.Containers {
		if req, ok := c.Resources.Requests[coreV1.ResourceCPU]; ok {
			cpuTotal += req.MilliValue()
		}
		if req, ok := c.Resources.Requests[coreV1.ResourceMemory]; ok {
			memTotal += req.Value()
		}
	}
	if cpuTotal > 0 {
		cpu = fmt.Sprintf("%dm*", cpuTotal)
	}
	if memTotal > 0 {
		memory = formatBytes(memTotal) + "*"
	}
	return
}

func formatBytes(b int64) string {
	const (
		mi = 1024 * 1024
		gi = 1024 * 1024 * 1024
	)
	switch {
	case b >= gi:
		return fmt.Sprintf("%.1fGi", float64(b)/float64(gi))
	case b >= mi:
		return fmt.Sprintf("%dMi", b/mi)
	default:
		return fmt.Sprintf("%dKi", b/1024)
	}
}

func formatAge(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}
