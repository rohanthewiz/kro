package kube

import (
	"context"
	"fmt"

	"github.com/rohanthewiz/logger"
	appsV1 "k8s.io/api/apps/v1"
	batchV1 "k8s.io/api/batch/v1"
	coreV1 "k8s.io/api/core/v1"
	netV1 "k8s.io/api/networking/v1"
	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
)

// K8sResource is the flat record rendered by the resources page.
type K8sResource struct {
	Kind        string        `json:"kind"`
	Name        string        `json:"name"`
	Status      string        `json:"status"`
	Age         string        `json:"age"`
	CPU         string        `json:"cpu,omitempty"`
	Memory      string        `json:"memory,omitempty"`
	Node        string        `json:"node,omitempty"`
	Restarts    int32         `json:"restarts,omitempty"`
	Completions string        `json:"completions,omitempty"`
	Replicas    string        `json:"replicas,omitempty"`
	Extra       string        `json:"extra,omitempty"` // service type, ingress hosts, etc.
	Children    []K8sResource `json:"children,omitempty"`
}

// ResourceTree is the JSON shape sent to the page.
type ResourceTree struct {
	Context     string        `json:"context"`
	Namespace   string        `json:"namespace"`
	Jobs        []K8sResource `json:"jobs"`
	Deployments []K8sResource `json:"deployments"`
	StatefulSets []K8sResource `json:"statefulsets"`
	DaemonSets   []K8sResource `json:"daemonsets"`
	OrphanPods  []K8sResource `json:"orphan_pods"`
	Services    []K8sResource `json:"services"`
	Ingresses   []K8sResource `json:"ingresses"`
	ConfigMaps  []K8sResource `json:"configmaps"`
	Secrets     []K8sResource `json:"secrets"`
	Warnings    []string      `json:"warnings,omitempty"`
}

// ListResources fetches the resource tree for the given namespace.
// Resource types that return permission errors are silently skipped (with a
// user-visible warning) rather than failing the whole request.
func ListResources(client *kubernetes.Clientset, ns string) (ResourceTree, error) {
	bgCtx := context.Background()
	listOpts := metaV1.ListOptions{}
	var warnings []string

	jobs, err := client.BatchV1().Jobs(ns).List(bgCtx, listOpts)
	if err != nil {
		logger.WarnF("skipping jobs: %v", err)
		warnings = append(warnings, "Could not list Jobs — check RBAC permissions")
		jobs = &batchV1.JobList{}
	}

	deployments, err := client.AppsV1().Deployments(ns).List(bgCtx, listOpts)
	if err != nil {
		logger.WarnF("skipping deployments: %v", err)
		warnings = append(warnings, "Could not list Deployments — check RBAC permissions")
		deployments = &appsV1.DeploymentList{}
	}

	replicaSets, err := client.AppsV1().ReplicaSets(ns).List(bgCtx, listOpts)
	if err != nil {
		logger.WarnF("skipping replicasets: %v", err)
		warnings = append(warnings, "Could not list ReplicaSets — check RBAC permissions")
		replicaSets = &appsV1.ReplicaSetList{}
	}

	statefulSets, err := client.AppsV1().StatefulSets(ns).List(bgCtx, listOpts)
	if err != nil {
		logger.WarnF("skipping statefulsets: %v", err)
		warnings = append(warnings, "Could not list StatefulSets — check RBAC permissions")
		statefulSets = &appsV1.StatefulSetList{}
	}

	daemonSets, err := client.AppsV1().DaemonSets(ns).List(bgCtx, listOpts)
	if err != nil {
		logger.WarnF("skipping daemonsets: %v", err)
		warnings = append(warnings, "Could not list DaemonSets — check RBAC permissions")
		daemonSets = &appsV1.DaemonSetList{}
	}

	pods, err := client.CoreV1().Pods(ns).List(bgCtx, listOpts)
	if err != nil {
		logger.WarnF("skipping pods: %v", err)
		warnings = append(warnings, "Could not list Pods — check RBAC permissions")
		pods = &coreV1.PodList{}
	}

	services, err := client.CoreV1().Services(ns).List(bgCtx, listOpts)
	if err != nil {
		logger.WarnF("skipping services: %v", err)
		warnings = append(warnings, "Could not list Services — check RBAC permissions")
		services = &coreV1.ServiceList{}
	}

	ingresses, err := client.NetworkingV1().Ingresses(ns).List(bgCtx, listOpts)
	if err != nil {
		logger.WarnF("skipping ingresses: %v", err)
		warnings = append(warnings, "Could not list Ingresses — check RBAC permissions")
		ingresses = &netV1.IngressList{}
	}

	configMaps, err := client.CoreV1().ConfigMaps(ns).List(bgCtx, listOpts)
	if err != nil {
		logger.WarnF("skipping configmaps: %v", err)
		warnings = append(warnings, "Could not list ConfigMaps — check RBAC permissions")
		configMaps = &coreV1.ConfigMapList{}
	}

	secrets, err := client.CoreV1().Secrets(ns).List(bgCtx, listOpts)
	if err != nil {
		logger.WarnF("skipping secrets: %v", err)
		warnings = append(warnings, "Could not list Secrets — check RBAC permissions")
		secrets = &coreV1.SecretList{}
	}

	type indexedRS struct {
		rs       appsV1.ReplicaSet
		children []K8sResource
	}

	jobsByUID := make(map[types.UID]int, len(jobs.Items))
	jobChildren := make(map[int][]K8sResource, len(jobs.Items))
	for i, j := range jobs.Items {
		jobsByUID[j.UID] = i
	}

	rsByUID := make(map[types.UID]*indexedRS, len(replicaSets.Items))
	for _, rs := range replicaSets.Items {
		rsByUID[rs.UID] = &indexedRS{rs: rs}
	}

	deployByUID := make(map[types.UID]int, len(deployments.Items))
	deployChildren := make(map[int][]K8sResource, len(deployments.Items))
	for i, d := range deployments.Items {
		deployByUID[d.UID] = i
	}

	stsByUID := make(map[types.UID]int, len(statefulSets.Items))
	stsChildren := make(map[int][]K8sResource, len(statefulSets.Items))
	for i, s := range statefulSets.Items {
		stsByUID[s.UID] = i
	}

	dsByUID := make(map[types.UID]int, len(daemonSets.Items))
	dsChildren := make(map[int][]K8sResource, len(daemonSets.Items))
	for i, d := range daemonSets.Items {
		dsByUID[d.UID] = i
	}

	var orphanPods []K8sResource
	for _, pod := range pods.Items {
		podRes := podToResource(pod)
		assigned := false

		for _, ref := range pod.OwnerReferences {
			if idx, ok := jobsByUID[ref.UID]; ok {
				jobChildren[idx] = append(jobChildren[idx], podRes)
				assigned = true
				break
			}
			if irs, ok := rsByUID[ref.UID]; ok {
				irs.children = append(irs.children, podRes)
				assigned = true
				break
			}
			if idx, ok := stsByUID[ref.UID]; ok {
				stsChildren[idx] = append(stsChildren[idx], podRes)
				assigned = true
				break
			}
			if idx, ok := dsByUID[ref.UID]; ok {
				dsChildren[idx] = append(dsChildren[idx], podRes)
				assigned = true
				break
			}
		}
		if !assigned {
			orphanPods = append(orphanPods, podRes)
		}
	}

	orphanRS := make(map[types.UID]*indexedRS)
	for uid, irs := range rsByUID {
		assigned := false
		for _, ref := range irs.rs.OwnerReferences {
			if dIdx, ok := deployByUID[ref.UID]; ok {
				rsRes := replicaSetToResource(irs.rs, irs.children)
				deployChildren[dIdx] = append(deployChildren[dIdx], rsRes)
				assigned = true
				break
			}
		}
		if !assigned {
			orphanRS[uid] = irs
		}
	}

	tree := ResourceTree{Namespace: ns}

	for i, j := range jobs.Items {
		tree.Jobs = append(tree.Jobs, jobToResource(j, jobChildren[i]))
	}
	for i, d := range deployments.Items {
		tree.Deployments = append(tree.Deployments, deploymentToResource(d, deployChildren[i]))
	}
	for _, irs := range orphanRS {
		// Surface orphan ReplicaSets so users can still see them.
		tree.Deployments = append(tree.Deployments, replicaSetToResource(irs.rs, irs.children))
	}
	for i, s := range statefulSets.Items {
		tree.StatefulSets = append(tree.StatefulSets, statefulSetToResource(s, stsChildren[i]))
	}
	for i, d := range daemonSets.Items {
		tree.DaemonSets = append(tree.DaemonSets, daemonSetToResource(d, dsChildren[i]))
	}
	for _, s := range services.Items {
		tree.Services = append(tree.Services, serviceToResource(s))
	}
	for _, i := range ingresses.Items {
		tree.Ingresses = append(tree.Ingresses, ingressToResource(i))
	}
	for _, cm := range configMaps.Items {
		tree.ConfigMaps = append(tree.ConfigMaps, configMapToResource(cm))
	}
	for _, s := range secrets.Items {
		tree.Secrets = append(tree.Secrets, secretToResource(s))
	}

	tree.OrphanPods = orphanPods
	tree.Warnings = warnings
	return tree, nil
}

// ----- per-kind row builders -----

func podToResource(pod coreV1.Pod) K8sResource {
	var restarts int32
	for _, cs := range pod.Status.ContainerStatuses {
		restarts += cs.RestartCount
	}
	res := K8sResource{
		Kind:     "Pod",
		Name:     pod.Name,
		Status:   containerStatus(pod.Status),
		Age:      formatAge(pod.CreationTimestamp.Time),
		Node:     pod.Spec.NodeName,
		Restarts: restarts,
	}
	cpu, mem := podSpecResources(pod.Spec)
	res.CPU = cpu
	res.Memory = mem
	return res
}

func jobToResource(job batchV1.Job, children []K8sResource) K8sResource {
	completions := "N/A"
	if job.Spec.Completions != nil {
		completions = fmt.Sprintf("%d/%d", job.Status.Succeeded, *job.Spec.Completions)
	} else {
		completions = fmt.Sprintf("%d succeeded", job.Status.Succeeded)
	}
	return K8sResource{
		Kind:        "Job",
		Name:        job.Name,
		Status:      jobStatus(job),
		Age:         formatAge(job.CreationTimestamp.Time),
		Completions: completions,
		Children:    children,
	}
}

func deploymentToResource(deploy appsV1.Deployment, children []K8sResource) K8sResource {
	replicas := fmt.Sprintf("%d/%d", deploy.Status.ReadyReplicas, deploy.Status.Replicas)
	return K8sResource{
		Kind:     "Deployment",
		Name:     deploy.Name,
		Status:   deploymentStatus(deploy),
		Age:      formatAge(deploy.CreationTimestamp.Time),
		Replicas: replicas,
		Children: children,
	}
}

func replicaSetToResource(rs appsV1.ReplicaSet, children []K8sResource) K8sResource {
	desired := int32(0)
	if rs.Spec.Replicas != nil {
		desired = *rs.Spec.Replicas
	}
	replicas := fmt.Sprintf("%d/%d", rs.Status.ReadyReplicas, desired)
	return K8sResource{
		Kind:     "ReplicaSet",
		Name:     rs.Name,
		Status:   replicaSetStatus(rs),
		Age:      formatAge(rs.CreationTimestamp.Time),
		Replicas: replicas,
		Children: children,
	}
}

func statefulSetToResource(sts appsV1.StatefulSet, children []K8sResource) K8sResource {
	desired := int32(0)
	if sts.Spec.Replicas != nil {
		desired = *sts.Spec.Replicas
	}
	replicas := fmt.Sprintf("%d/%d", sts.Status.ReadyReplicas, desired)
	status := "Progressing"
	if sts.Status.ReadyReplicas == desired && desired > 0 {
		status = "Ready"
	} else if desired == 0 {
		status = "Scaled Down"
	}
	return K8sResource{
		Kind:     "StatefulSet",
		Name:     sts.Name,
		Status:   status,
		Age:      formatAge(sts.CreationTimestamp.Time),
		Replicas: replicas,
		Children: children,
	}
}

func daemonSetToResource(ds appsV1.DaemonSet, children []K8sResource) K8sResource {
	replicas := fmt.Sprintf("%d/%d", ds.Status.NumberReady, ds.Status.DesiredNumberScheduled)
	status := "Ready"
	if ds.Status.NumberReady < ds.Status.DesiredNumberScheduled {
		status = "Progressing"
	}
	return K8sResource{
		Kind:     "DaemonSet",
		Name:     ds.Name,
		Status:   status,
		Age:      formatAge(ds.CreationTimestamp.Time),
		Replicas: replicas,
		Children: children,
	}
}

func serviceToResource(s coreV1.Service) K8sResource {
	extra := string(s.Spec.Type)
	if s.Spec.ClusterIP != "" && s.Spec.ClusterIP != "None" {
		extra += " " + s.Spec.ClusterIP
	} else if s.Spec.ClusterIP == "None" {
		extra += " (headless)"
	}
	return K8sResource{
		Kind:   "Service",
		Name:   s.Name,
		Status: string(s.Spec.Type),
		Age:    formatAge(s.CreationTimestamp.Time),
		Extra:  extra,
	}
}

func ingressToResource(in netV1.Ingress) K8sResource {
	hosts := ""
	for i, r := range in.Spec.Rules {
		if i > 0 {
			hosts += ", "
		}
		hosts += r.Host
	}
	if hosts == "" {
		hosts = "-"
	}
	return K8sResource{
		Kind:   "Ingress",
		Name:   in.Name,
		Status: "—",
		Age:    formatAge(in.CreationTimestamp.Time),
		Extra:  hosts,
	}
}

func configMapToResource(cm coreV1.ConfigMap) K8sResource {
	return K8sResource{
		Kind:   "ConfigMap",
		Name:   cm.Name,
		Status: fmt.Sprintf("%d keys", len(cm.Data)+len(cm.BinaryData)),
		Age:    formatAge(cm.CreationTimestamp.Time),
	}
}

func secretToResource(s coreV1.Secret) K8sResource {
	return K8sResource{
		Kind:   "Secret",
		Name:   s.Name,
		Status: string(s.Type),
		Age:    formatAge(s.CreationTimestamp.Time),
		Extra:  fmt.Sprintf("%d keys", len(s.Data)),
	}
}

// ----- status helpers -----

func jobStatus(job batchV1.Job) string {
	for _, c := range job.Status.Conditions {
		if c.Type == batchV1.JobComplete && c.Status == coreV1.ConditionTrue {
			return "Complete"
		}
		if c.Type == batchV1.JobFailed && c.Status == coreV1.ConditionTrue {
			return "Failed"
		}
	}
	if job.Status.Active > 0 {
		return "Running"
	}
	return "Pending"
}

func deploymentStatus(deploy appsV1.Deployment) string {
	if deploy.Status.ReadyReplicas == deploy.Status.Replicas && deploy.Status.Replicas > 0 {
		return "Ready"
	}
	if deploy.Status.ReadyReplicas == 0 {
		return "Unavailable"
	}
	return "Progressing"
}

func replicaSetStatus(rs appsV1.ReplicaSet) string {
	desired := int32(0)
	if rs.Spec.Replicas != nil {
		desired = *rs.Spec.Replicas
	}
	if rs.Status.ReadyReplicas == desired && desired > 0 {
		return "Ready"
	}
	if desired == 0 {
		return "Scaled Down"
	}
	return "Scaling"
}
