package kube

import (
	"bytes"
	"context"
	"fmt"
	"sort"

	"github.com/rohanthewiz/serr"
	appsV1 "k8s.io/api/apps/v1"
	batchV1 "k8s.io/api/batch/v1"
	coreV1 "k8s.io/api/core/v1"
	netV1 "k8s.io/api/networking/v1"
	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// Describe returns a kubectl-describe-style text rendering for the given resource,
// including its events. Returns an error if the resource is not found or the kind
// is unsupported.
func Describe(client *kubernetes.Clientset, ns, kind, name string) (string, error) {
	bgCtx := context.Background()
	var buf bytes.Buffer

	switch kind {
	case "Pod":
		pod, err := client.CoreV1().Pods(ns).Get(bgCtx, name, metaV1.GetOptions{})
		if err != nil {
			return "", serr.Wrap(err)
		}
		describePod(&buf, pod)
	case "Job":
		job, err := client.BatchV1().Jobs(ns).Get(bgCtx, name, metaV1.GetOptions{})
		if err != nil {
			return "", serr.Wrap(err)
		}
		describeJob(&buf, job)
	case "Deployment":
		d, err := client.AppsV1().Deployments(ns).Get(bgCtx, name, metaV1.GetOptions{})
		if err != nil {
			return "", serr.Wrap(err)
		}
		describeDeployment(&buf, d)
	case "ReplicaSet":
		rs, err := client.AppsV1().ReplicaSets(ns).Get(bgCtx, name, metaV1.GetOptions{})
		if err != nil {
			return "", serr.Wrap(err)
		}
		describeReplicaSet(&buf, rs)
	case "StatefulSet":
		s, err := client.AppsV1().StatefulSets(ns).Get(bgCtx, name, metaV1.GetOptions{})
		if err != nil {
			return "", serr.Wrap(err)
		}
		describeStatefulSet(&buf, s)
	case "DaemonSet":
		d, err := client.AppsV1().DaemonSets(ns).Get(bgCtx, name, metaV1.GetOptions{})
		if err != nil {
			return "", serr.Wrap(err)
		}
		describeDaemonSet(&buf, d)
	case "Service":
		s, err := client.CoreV1().Services(ns).Get(bgCtx, name, metaV1.GetOptions{})
		if err != nil {
			return "", serr.Wrap(err)
		}
		describeService(&buf, s)
	case "Ingress":
		in, err := client.NetworkingV1().Ingresses(ns).Get(bgCtx, name, metaV1.GetOptions{})
		if err != nil {
			return "", serr.Wrap(err)
		}
		describeIngress(&buf, in)
	case "ConfigMap":
		cm, err := client.CoreV1().ConfigMaps(ns).Get(bgCtx, name, metaV1.GetOptions{})
		if err != nil {
			return "", serr.Wrap(err)
		}
		describeConfigMap(&buf, cm)
	case "Secret":
		s, err := client.CoreV1().Secrets(ns).Get(bgCtx, name, metaV1.GetOptions{})
		if err != nil {
			return "", serr.Wrap(err)
		}
		describeSecret(&buf, s)
	default:
		return "", serr.New("unsupported kind: " + kind)
	}

	writeEvents(&buf, client, bgCtx, ns, kind, name)
	return buf.String(), nil
}

func describePod(buf *bytes.Buffer, pod *coreV1.Pod) {
	fmt.Fprintf(buf, "Name:         %s\n", pod.Name)
	fmt.Fprintf(buf, "Namespace:    %s\n", pod.Namespace)
	fmt.Fprintf(buf, "Node:         %s\n", pod.Spec.NodeName)
	fmt.Fprintf(buf, "Status:       %s\n", pod.Status.Phase)
	if pod.Status.PodIP != "" {
		fmt.Fprintf(buf, "IP:           %s\n", pod.Status.PodIP)
	}
	if pod.Status.StartTime != nil {
		fmt.Fprintf(buf, "Start Time:   %s\n", pod.Status.StartTime.Format("2006-01-02 15:04:05 MST"))
	}

	writeLabels(buf, pod.Labels)

	if len(pod.OwnerReferences) > 0 {
		fmt.Fprintf(buf, "\nControlled By:\n")
		for _, ref := range pod.OwnerReferences {
			fmt.Fprintf(buf, "  %s/%s\n", ref.Kind, ref.Name)
		}
	}

	fmt.Fprintf(buf, "\nContainers:\n")
	for _, c := range pod.Spec.Containers {
		fmt.Fprintf(buf, "  %s:\n", c.Name)
		fmt.Fprintf(buf, "    Image:      %s\n", c.Image)
		for _, cs := range pod.Status.ContainerStatuses {
			if cs.Name == c.Name {
				writeContainerState(buf, "State", cs.State)
				if cs.LastTerminationState.Running != nil || cs.LastTerminationState.Waiting != nil || cs.LastTerminationState.Terminated != nil {
					writeContainerState(buf, "Last State", cs.LastTerminationState)
				}
				fmt.Fprintf(buf, "    Ready:      %v\n", cs.Ready)
				fmt.Fprintf(buf, "    Restarts:   %d\n", cs.RestartCount)
				break
			}
		}
		writeContainerResources(buf, c)
	}

	if len(pod.Status.Conditions) > 0 {
		fmt.Fprintf(buf, "\nConditions:\n")
		fmt.Fprintf(buf, "  %-22s %s\n", "Type", "Status")
		for _, c := range pod.Status.Conditions {
			fmt.Fprintf(buf, "  %-22s %s\n", c.Type, c.Status)
		}
	}
}

func describeJob(buf *bytes.Buffer, job *batchV1.Job) {
	fmt.Fprintf(buf, "Name:         %s\n", job.Name)
	fmt.Fprintf(buf, "Namespace:    %s\n", job.Namespace)
	fmt.Fprintf(buf, "Status:       %s\n", jobStatus(*job))
	fmt.Fprintf(buf, "Start Time:   %s\n", job.CreationTimestamp.Format("2006-01-02 15:04:05 MST"))
	if job.Status.CompletionTime != nil {
		fmt.Fprintf(buf, "Completed:    %s\n", job.Status.CompletionTime.Format("2006-01-02 15:04:05 MST"))
	}
	if job.Spec.Parallelism != nil {
		fmt.Fprintf(buf, "Parallelism:  %d\n", *job.Spec.Parallelism)
	}
	if job.Spec.Completions != nil {
		fmt.Fprintf(buf, "Completions:  %d/%d\n", job.Status.Succeeded, *job.Spec.Completions)
	} else {
		fmt.Fprintf(buf, "Succeeded:    %d\n", job.Status.Succeeded)
	}
	fmt.Fprintf(buf, "Active:       %d\n", job.Status.Active)
	fmt.Fprintf(buf, "Failed:       %d\n", job.Status.Failed)
	if job.Spec.BackoffLimit != nil {
		fmt.Fprintf(buf, "Backoff:      %d\n", *job.Spec.BackoffLimit)
	}
	writeLabels(buf, job.Labels)

	fmt.Fprintf(buf, "\nPod Template:\n")
	for _, c := range job.Spec.Template.Spec.Containers {
		fmt.Fprintf(buf, "  %s:\n", c.Name)
		fmt.Fprintf(buf, "    Image:      %s\n", c.Image)
		writeContainerResources(buf, c)
	}
}

func describeDeployment(buf *bytes.Buffer, d *appsV1.Deployment) {
	fmt.Fprintf(buf, "Name:         %s\n", d.Name)
	fmt.Fprintf(buf, "Namespace:    %s\n", d.Namespace)
	fmt.Fprintf(buf, "Status:       %s\n", deploymentStatus(*d))
	fmt.Fprintf(buf, "Replicas:     %d desired | %d updated | %d total | %d available | %d unavailable\n",
		d.Status.Replicas, d.Status.UpdatedReplicas, d.Status.Replicas,
		d.Status.AvailableReplicas, d.Status.UnavailableReplicas)
	if d.Spec.Strategy.Type != "" {
		fmt.Fprintf(buf, "Strategy:     %s\n", d.Spec.Strategy.Type)
		if d.Spec.Strategy.RollingUpdate != nil {
			if d.Spec.Strategy.RollingUpdate.MaxUnavailable != nil {
				fmt.Fprintf(buf, "  Max Unavailable:  %s\n", d.Spec.Strategy.RollingUpdate.MaxUnavailable.String())
			}
			if d.Spec.Strategy.RollingUpdate.MaxSurge != nil {
				fmt.Fprintf(buf, "  Max Surge:        %s\n", d.Spec.Strategy.RollingUpdate.MaxSurge.String())
			}
		}
	}
	writeLabels(buf, d.Labels)

	if d.Spec.Selector != nil && len(d.Spec.Selector.MatchLabels) > 0 {
		fmt.Fprintf(buf, "\nSelector:\n")
		for k, v := range d.Spec.Selector.MatchLabels {
			fmt.Fprintf(buf, "  %s=%s\n", k, v)
		}
	}

	fmt.Fprintf(buf, "\nPod Template:\n")
	for _, c := range d.Spec.Template.Spec.Containers {
		fmt.Fprintf(buf, "  %s:\n", c.Name)
		fmt.Fprintf(buf, "    Image:      %s\n", c.Image)
		writeContainerResources(buf, c)
	}

	if len(d.Status.Conditions) > 0 {
		fmt.Fprintf(buf, "\nConditions:\n")
		fmt.Fprintf(buf, "  %-22s %-8s %s\n", "Type", "Status", "Reason")
		for _, c := range d.Status.Conditions {
			fmt.Fprintf(buf, "  %-22s %-8s %s\n", c.Type, c.Status, c.Reason)
		}
	}
}

func describeReplicaSet(buf *bytes.Buffer, rs *appsV1.ReplicaSet) {
	fmt.Fprintf(buf, "Name:         %s\n", rs.Name)
	fmt.Fprintf(buf, "Namespace:    %s\n", rs.Namespace)
	fmt.Fprintf(buf, "Status:       %s\n", replicaSetStatus(*rs))

	desired := int32(0)
	if rs.Spec.Replicas != nil {
		desired = *rs.Spec.Replicas
	}
	fmt.Fprintf(buf, "Replicas:     %d desired | %d ready | %d available\n",
		desired, rs.Status.ReadyReplicas, rs.Status.AvailableReplicas)
	writeLabels(buf, rs.Labels)

	if len(rs.OwnerReferences) > 0 {
		fmt.Fprintf(buf, "\nControlled By:\n")
		for _, ref := range rs.OwnerReferences {
			fmt.Fprintf(buf, "  %s/%s\n", ref.Kind, ref.Name)
		}
	}

	fmt.Fprintf(buf, "\nPod Template:\n")
	for _, c := range rs.Spec.Template.Spec.Containers {
		fmt.Fprintf(buf, "  %s:\n", c.Name)
		fmt.Fprintf(buf, "    Image:      %s\n", c.Image)
		writeContainerResources(buf, c)
	}
}

func describeStatefulSet(buf *bytes.Buffer, s *appsV1.StatefulSet) {
	fmt.Fprintf(buf, "Name:         %s\n", s.Name)
	fmt.Fprintf(buf, "Namespace:    %s\n", s.Namespace)
	desired := int32(0)
	if s.Spec.Replicas != nil {
		desired = *s.Spec.Replicas
	}
	fmt.Fprintf(buf, "Replicas:     %d desired | %d ready | %d current\n",
		desired, s.Status.ReadyReplicas, s.Status.CurrentReplicas)
	if s.Spec.ServiceName != "" {
		fmt.Fprintf(buf, "Service:      %s\n", s.Spec.ServiceName)
	}
	writeLabels(buf, s.Labels)

	fmt.Fprintf(buf, "\nPod Template:\n")
	for _, c := range s.Spec.Template.Spec.Containers {
		fmt.Fprintf(buf, "  %s:\n", c.Name)
		fmt.Fprintf(buf, "    Image:      %s\n", c.Image)
		writeContainerResources(buf, c)
	}
}

func describeDaemonSet(buf *bytes.Buffer, d *appsV1.DaemonSet) {
	fmt.Fprintf(buf, "Name:         %s\n", d.Name)
	fmt.Fprintf(buf, "Namespace:    %s\n", d.Namespace)
	fmt.Fprintf(buf, "Desired:      %d\n", d.Status.DesiredNumberScheduled)
	fmt.Fprintf(buf, "Current:      %d\n", d.Status.CurrentNumberScheduled)
	fmt.Fprintf(buf, "Ready:        %d\n", d.Status.NumberReady)
	fmt.Fprintf(buf, "Available:    %d\n", d.Status.NumberAvailable)
	fmt.Fprintf(buf, "Misscheduled: %d\n", d.Status.NumberMisscheduled)
	writeLabels(buf, d.Labels)

	fmt.Fprintf(buf, "\nPod Template:\n")
	for _, c := range d.Spec.Template.Spec.Containers {
		fmt.Fprintf(buf, "  %s:\n", c.Name)
		fmt.Fprintf(buf, "    Image:      %s\n", c.Image)
		writeContainerResources(buf, c)
	}
}

func describeService(buf *bytes.Buffer, s *coreV1.Service) {
	fmt.Fprintf(buf, "Name:         %s\n", s.Name)
	fmt.Fprintf(buf, "Namespace:    %s\n", s.Namespace)
	fmt.Fprintf(buf, "Type:         %s\n", s.Spec.Type)
	fmt.Fprintf(buf, "ClusterIP:    %s\n", s.Spec.ClusterIP)
	if len(s.Spec.ExternalIPs) > 0 {
		fmt.Fprintf(buf, "External IPs: %v\n", s.Spec.ExternalIPs)
	}
	if s.Spec.LoadBalancerIP != "" {
		fmt.Fprintf(buf, "LB IP:        %s\n", s.Spec.LoadBalancerIP)
	}
	writeLabels(buf, s.Labels)

	if len(s.Spec.Selector) > 0 {
		fmt.Fprintf(buf, "\nSelector:\n")
		for k, v := range s.Spec.Selector {
			fmt.Fprintf(buf, "  %s=%s\n", k, v)
		}
	}
	if len(s.Spec.Ports) > 0 {
		fmt.Fprintf(buf, "\nPorts:\n")
		for _, p := range s.Spec.Ports {
			fmt.Fprintf(buf, "  %s  %d/%s -> %s\n", p.Name, p.Port, p.Protocol, p.TargetPort.String())
		}
	}
}

func describeIngress(buf *bytes.Buffer, in *netV1.Ingress) {
	fmt.Fprintf(buf, "Name:         %s\n", in.Name)
	fmt.Fprintf(buf, "Namespace:    %s\n", in.Namespace)
	if in.Spec.IngressClassName != nil {
		fmt.Fprintf(buf, "Class:        %s\n", *in.Spec.IngressClassName)
	}
	writeLabels(buf, in.Labels)

	if len(in.Spec.Rules) > 0 {
		fmt.Fprintf(buf, "\nRules:\n")
		for _, r := range in.Spec.Rules {
			fmt.Fprintf(buf, "  Host: %s\n", r.Host)
			if r.HTTP != nil {
				for _, p := range r.HTTP.Paths {
					target := ""
					if p.Backend.Service != nil {
						target = fmt.Sprintf("%s:%s", p.Backend.Service.Name, p.Backend.Service.Port.String())
					}
					fmt.Fprintf(buf, "    %s -> %s\n", p.Path, target)
				}
			}
		}
	}
	if len(in.Status.LoadBalancer.Ingress) > 0 {
		fmt.Fprintf(buf, "\nLoadBalancer:\n")
		for _, lb := range in.Status.LoadBalancer.Ingress {
			fmt.Fprintf(buf, "  %s%s\n", lb.IP, lb.Hostname)
		}
	}
}

func describeConfigMap(buf *bytes.Buffer, cm *coreV1.ConfigMap) {
	fmt.Fprintf(buf, "Name:         %s\n", cm.Name)
	fmt.Fprintf(buf, "Namespace:    %s\n", cm.Namespace)
	writeLabels(buf, cm.Labels)

	if len(cm.Data) > 0 {
		fmt.Fprintf(buf, "\nData:\n")
		keys := make([]string, 0, len(cm.Data))
		for k := range cm.Data {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Fprintf(buf, "  %s: (%d bytes)\n", k, len(cm.Data[k]))
		}
	}
	if len(cm.BinaryData) > 0 {
		fmt.Fprintf(buf, "\nBinaryData:\n")
		for k, v := range cm.BinaryData {
			fmt.Fprintf(buf, "  %s: (%d bytes)\n", k, len(v))
		}
	}
}

func describeSecret(buf *bytes.Buffer, s *coreV1.Secret) {
	fmt.Fprintf(buf, "Name:         %s\n", s.Name)
	fmt.Fprintf(buf, "Namespace:    %s\n", s.Namespace)
	fmt.Fprintf(buf, "Type:         %s\n", s.Type)
	writeLabels(buf, s.Labels)

	if len(s.Data) > 0 {
		fmt.Fprintf(buf, "\nData (values redacted):\n")
		keys := make([]string, 0, len(s.Data))
		for k := range s.Data {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Fprintf(buf, "  %s: (%d bytes)\n", k, len(s.Data[k]))
		}
	}
}

func writeLabels(buf *bytes.Buffer, labels map[string]string) {
	if len(labels) == 0 {
		return
	}
	fmt.Fprintf(buf, "\nLabels:\n")
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(buf, "  %s=%s\n", k, labels[k])
	}
}

func writeContainerState(buf *bytes.Buffer, label string, st coreV1.ContainerState) {
	const tsFmt = "Mon, 02 Jan 2006 15:04:05 -0700"
	switch {
	case st.Running != nil:
		fmt.Fprintf(buf, "    %s:      Running\n", label)
		if !st.Running.StartedAt.IsZero() {
			fmt.Fprintf(buf, "      Started:    %s\n", st.Running.StartedAt.Format(tsFmt))
		}
	case st.Waiting != nil:
		fmt.Fprintf(buf, "    %s:      Waiting\n", label)
		if st.Waiting.Reason != "" {
			fmt.Fprintf(buf, "      Reason:     %s\n", st.Waiting.Reason)
		}
		if st.Waiting.Message != "" {
			fmt.Fprintf(buf, "      Message:    %s\n", st.Waiting.Message)
		}
	case st.Terminated != nil:
		fmt.Fprintf(buf, "    %s:      Terminated\n", label)
		if st.Terminated.Reason != "" {
			fmt.Fprintf(buf, "      Reason:     %s\n", st.Terminated.Reason)
		}
		if st.Terminated.Message != "" {
			fmt.Fprintf(buf, "      Message:    %s\n", st.Terminated.Message)
		}
		fmt.Fprintf(buf, "      Exit Code:  %d\n", st.Terminated.ExitCode)
		if st.Terminated.Signal != 0 {
			fmt.Fprintf(buf, "      Signal:     %d\n", st.Terminated.Signal)
		}
		if !st.Terminated.StartedAt.IsZero() {
			fmt.Fprintf(buf, "      Started:    %s\n", st.Terminated.StartedAt.Format(tsFmt))
		}
		if !st.Terminated.FinishedAt.IsZero() {
			fmt.Fprintf(buf, "      Finished:   %s\n", st.Terminated.FinishedAt.Format(tsFmt))
		}
	default:
		fmt.Fprintf(buf, "    %s:      <unknown>\n", label)
	}
}

func writeContainerResources(buf *bytes.Buffer, c coreV1.Container) {
	if len(c.Resources.Limits) > 0 {
		fmt.Fprintf(buf, "    Limits:\n")
		if cpu, ok := c.Resources.Limits[coreV1.ResourceCPU]; ok {
			fmt.Fprintf(buf, "      cpu:      %s\n", cpu.String())
		}
		if mem, ok := c.Resources.Limits[coreV1.ResourceMemory]; ok {
			fmt.Fprintf(buf, "      memory:   %s\n", mem.String())
		}
	}
	if len(c.Resources.Requests) > 0 {
		fmt.Fprintf(buf, "    Requests:\n")
		if cpu, ok := c.Resources.Requests[coreV1.ResourceCPU]; ok {
			fmt.Fprintf(buf, "      cpu:      %s\n", cpu.String())
		}
		if mem, ok := c.Resources.Requests[coreV1.ResourceMemory]; ok {
			fmt.Fprintf(buf, "      memory:   %s\n", mem.String())
		}
	}
}

func writeEvents(buf *bytes.Buffer, client *kubernetes.Clientset, ctx context.Context, ns, kind, name string) {
	events, err := client.CoreV1().Events(ns).List(ctx, metaV1.ListOptions{
		FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=%s", name, kind),
	})
	if err != nil || len(events.Items) == 0 {
		fmt.Fprintf(buf, "\nEvents:  <none>\n")
		return
	}

	sort.Slice(events.Items, func(i, j int) bool {
		ti := events.Items[i].LastTimestamp.Time
		tj := events.Items[j].LastTimestamp.Time
		return ti.After(tj)
	})

	fmt.Fprintf(buf, "\nEvents:\n")
	fmt.Fprintf(buf, "  %-8s %-22s %-8s %s\n", "Type", "Reason", "Age", "Message")
	for _, e := range events.Items {
		age := ""
		if !e.LastTimestamp.IsZero() {
			age = formatAge(e.LastTimestamp.Time)
		} else if !e.FirstTimestamp.IsZero() {
			age = formatAge(e.FirstTimestamp.Time)
		}
		fmt.Fprintf(buf, "  %-8s %-22s %-8s %s\n", e.Type, e.Reason, age, e.Message)
	}
}
