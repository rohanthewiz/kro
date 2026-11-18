package kube

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	appsV1 "k8s.io/api/apps/v1"
	batchV1 "k8s.io/api/batch/v1"
	coreV1 "k8s.io/api/core/v1"
	netV1 "k8s.io/api/networking/v1"
	storageV1 "k8s.io/api/storage/v1"
	apiErrors "k8s.io/apimachinery/pkg/api/errors"
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
	Context      string        `json:"context"`
	Namespace    string        `json:"namespace"`
	Jobs         []K8sResource `json:"jobs"`
	Deployments  []K8sResource `json:"deployments"`
	StatefulSets []K8sResource `json:"statefulsets"`
	DaemonSets   []K8sResource `json:"daemonsets"`
	OrphanPods   []K8sResource `json:"orphan_pods"`
	Services     []K8sResource `json:"services"`
	Ingresses    []K8sResource `json:"ingresses"`
	ConfigMaps   []K8sResource `json:"configmaps"`
	Secrets      []K8sResource `json:"secrets"`
	// Storage objects. PersistentVolumes and StorageClasses are cluster-scoped
	// (listed cluster-wide); PersistentVolumeClaims are namespaced.
	PersistentVolumes      []K8sResource `json:"persistentvolumes"`
	PersistentVolumeClaims []K8sResource `json:"persistentvolumeclaims"`
	StorageClasses         []K8sResource `json:"storageclasses"`
	Warnings               []string      `json:"warnings,omitempty"`
}

// ListTimeout bounds one whole ListResources call. The 13 lists run
// concurrently, so this is also the longest any single one may take. It is a
// little longer than the page's 10s refresh cadence on purpose: a slow but
// working cluster still gets its answer, while an unreachable one (VPN down,
// expired credentials hanging in an exec plugin) fails in seconds rather than
// stacking one dial timeout per kind.
const ListTimeout = 15 * time.Second

// ErrClusterUnavailable marks a ListResources failure that concerns the
// cluster as a whole (unreachable, credentials rejected, no answer in time)
// rather than one resource kind. Callers show it as a single banner instead
// of a page of per-kind warnings over empty tables.
var ErrClusterUnavailable = errors.New("cluster unavailable")

// ListResources fetches the resource tree for the given namespace.
//
// The 13 kinds are listed concurrently under one ListTimeout deadline:
//
//	          ┌─ Jobs ──────────┐
//	ctx+15s ──┼─ Deployments ───┼──► wait ──► classify errors ──► build tree
//	          ├─ … 11 more … ───┤
//	          └─ StorageClasses ┘
//
// Sequentially, the wall time was the sum of the calls (and against an
// unreachable cluster, 13 dial timeouts back to back). Concurrently it is the
// slowest single call, capped by the deadline. Each goroutine writes only its
// own result variable and its own slot of errs, so no locking is needed.
//
// Error policy:
//   - A kind that fails while others succeed is skipped with a user-visible
//     warning. Only a real 403 is reported as an RBAC gap; anything else
//     carries its actual cause.
//   - If every kind failed and none of the failures was a 403, the problem is
//     the cluster, not permissions: the call returns ErrClusterUnavailable
//     wrapping a summary of the cause. (A namespace-scoped user who is
//     forbidden everything still gets the per-kind RBAC warnings.)
//
// ctx cancellation (the browser went away) aborts in-flight lists.
//
// Nothing is logged here: this runs every few seconds per open page, so the
// callers log (on transitions only) instead. The warnings and the returned
// error carry everything a caller needs.
func ListResources(ctx context.Context, client kubernetes.Interface, ns string) (ResourceTree, error) {
	ctx, cancel := context.WithTimeout(ctx, ListTimeout)
	defer cancel()
	listOpts := metaV1.ListOptions{}

	var (
		jobs           *batchV1.JobList
		deployments    *appsV1.DeploymentList
		replicaSets    *appsV1.ReplicaSetList
		statefulSets   *appsV1.StatefulSetList
		daemonSets     *appsV1.DaemonSetList
		pods           *coreV1.PodList
		services       *coreV1.ServiceList
		ingresses      *netV1.IngressList
		configMaps     *coreV1.ConfigMapList
		secrets        *coreV1.SecretList
		pvs            *coreV1.PersistentVolumeList
		pvcs           *coreV1.PersistentVolumeClaimList
		storageClasses *storageV1.StorageClassList
	)

	// The order here is the order warnings are reported in, so it is fixed
	// (and matches the order the kinds were listed in before this ran
	// concurrently). kind is the plural the page's warning router keys on
	// ("Could not list <kind>").
	calls := []struct {
		kind string
		run  func() error
	}{
		{"Jobs", func() (err error) { jobs, err = client.BatchV1().Jobs(ns).List(ctx, listOpts); return }},
		{"Deployments", func() (err error) { deployments, err = client.AppsV1().Deployments(ns).List(ctx, listOpts); return }},
		{"ReplicaSets", func() (err error) { replicaSets, err = client.AppsV1().ReplicaSets(ns).List(ctx, listOpts); return }},
		{"StatefulSets", func() (err error) { statefulSets, err = client.AppsV1().StatefulSets(ns).List(ctx, listOpts); return }},
		{"DaemonSets", func() (err error) { daemonSets, err = client.AppsV1().DaemonSets(ns).List(ctx, listOpts); return }},
		{"Pods", func() (err error) { pods, err = client.CoreV1().Pods(ns).List(ctx, listOpts); return }},
		{"Services", func() (err error) { services, err = client.CoreV1().Services(ns).List(ctx, listOpts); return }},
		{"Ingresses", func() (err error) { ingresses, err = client.NetworkingV1().Ingresses(ns).List(ctx, listOpts); return }},
		{"ConfigMaps", func() (err error) { configMaps, err = client.CoreV1().ConfigMaps(ns).List(ctx, listOpts); return }},
		{"Secrets", func() (err error) { secrets, err = client.CoreV1().Secrets(ns).List(ctx, listOpts); return }},
		// PersistentVolumes and StorageClasses are cluster-scoped — listed
		// cluster-wide, not by namespace.
		{"PersistentVolumes", func() (err error) { pvs, err = client.CoreV1().PersistentVolumes().List(ctx, listOpts); return }},
		{"PersistentVolumeClaims", func() (err error) { pvcs, err = client.CoreV1().PersistentVolumeClaims(ns).List(ctx, listOpts); return }},
		{"StorageClasses", func() (err error) {
			storageClasses, err = client.StorageV1().StorageClasses().List(ctx, listOpts)
			return
		}},
	}

	errs := make([]error, len(calls))
	var wg sync.WaitGroup
	for i, call := range calls {
		wg.Go(func() { errs[i] = call.run() })
	}
	wg.Wait()

	// The caller gave up (browser disconnected, server shutting down): the
	// errors below are all "context canceled" and describe nothing about the
	// cluster, so report the cancellation itself and let the caller drop it.
	if cause := ctx.Err(); cause != nil && !errors.Is(cause, context.DeadlineExceeded) {
		return ResourceTree{}, cause
	}

	var warnings []string
	failed, forbidden := 0, 0
	var firstErr error
	for i, err := range errs {
		if err == nil {
			continue
		}
		failed++
		kind := calls[i].kind
		if apiErrors.IsForbidden(err) {
			forbidden++
			warnings = append(warnings, "Could not list "+kind+" — check RBAC permissions")
			continue
		}
		if firstErr == nil {
			firstErr = err
		}
		warnings = append(warnings, "Could not list "+kind+" — "+describeListError(err))
	}
	if failed == len(calls) && forbidden == 0 {
		return ResourceTree{}, fmt.Errorf("%w: %s", ErrClusterUnavailable, describeListError(firstErr))
	}

	// A failed call may leave its list nil; substitute empty lists so the
	// tree-building below needs no nil checks.
	if jobs == nil {
		jobs = &batchV1.JobList{}
	}
	if deployments == nil {
		deployments = &appsV1.DeploymentList{}
	}
	if replicaSets == nil {
		replicaSets = &appsV1.ReplicaSetList{}
	}
	if statefulSets == nil {
		statefulSets = &appsV1.StatefulSetList{}
	}
	if daemonSets == nil {
		daemonSets = &appsV1.DaemonSetList{}
	}
	if pods == nil {
		pods = &coreV1.PodList{}
	}
	if services == nil {
		services = &coreV1.ServiceList{}
	}
	if ingresses == nil {
		ingresses = &netV1.IngressList{}
	}
	if configMaps == nil {
		configMaps = &coreV1.ConfigMapList{}
	}
	if secrets == nil {
		secrets = &coreV1.SecretList{}
	}
	if pvs == nil {
		pvs = &coreV1.PersistentVolumeList{}
	}
	if pvcs == nil {
		pvcs = &coreV1.PersistentVolumeClaimList{}
	}
	if storageClasses == nil {
		storageClasses = &storageV1.StorageClassList{}
	}

	type indexedRS struct {
		rs       *appsV1.ReplicaSet
		children []K8sResource
	}

	jobsByUID := make(map[types.UID]int, len(jobs.Items))
	jobChildren := make(map[int][]K8sResource, len(jobs.Items))
	for i, j := range jobs.Items {
		jobsByUID[j.UID] = i
	}

	// allRS keeps the API's list order; rsByUID is only the pod → ReplicaSet
	// lookup. Everything that *emits* ReplicaSets walks allRS, never the map:
	// Go randomizes map iteration, which used to reshuffle a Deployment's
	// ReplicaSet rows (and the orphan ReplicaSets) on every snapshot.
	allRS := make([]*indexedRS, len(replicaSets.Items))
	rsByUID := make(map[types.UID]*indexedRS, len(replicaSets.Items))
	for i := range replicaSets.Items {
		irs := &indexedRS{rs: &replicaSets.Items[i]}
		allRS[i] = irs
		rsByUID[irs.rs.UID] = irs
	}

	deployByUID := make(map[types.UID]int, len(deployments.Items))
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

	// Attach each ReplicaSet to its Deployment; the rest are orphans.
	deployRS := make(map[int][]*indexedRS, len(deployments.Items))
	var orphanRS []*indexedRS
	for _, irs := range allRS {
		assigned := false
		for _, ref := range irs.rs.OwnerReferences {
			if dIdx, ok := deployByUID[ref.UID]; ok {
				deployRS[dIdx] = append(deployRS[dIdx], irs)
				assigned = true
				break
			}
		}
		if !assigned {
			orphanRS = append(orphanRS, irs)
		}
	}

	tree := ResourceTree{Namespace: ns}

	for i, j := range jobs.Items {
		tree.Jobs = append(tree.Jobs, jobToResource(j, jobChildren[i]))
	}
	for i, d := range deployments.Items {
		// A Deployment keeps its old ReplicaSets around (scaled to 0) for
		// rollback, typically ten of them. Put the ones that still want
		// pods first and order the rest newest first, so the ReplicaSet
		// that matters is the top row instead of somewhere in the history.
		owned := deployRS[i]
		sort.SliceStable(owned, func(a, b int) bool {
			aLive, bLive := rsDesired(owned[a].rs) > 0, rsDesired(owned[b].rs) > 0
			if aLive != bLive {
				return aLive
			}
			at, bt := owned[a].rs.CreationTimestamp.Time, owned[b].rs.CreationTimestamp.Time
			if !at.Equal(bt) {
				return at.After(bt)
			}
			return owned[a].rs.Name < owned[b].rs.Name
		})
		children := make([]K8sResource, 0, len(owned))
		for _, irs := range owned {
			children = append(children, replicaSetToResource(*irs.rs, irs.children))
		}
		if len(children) == 0 {
			children = nil // keep "children" out of the JSON, as before
		}
		tree.Deployments = append(tree.Deployments, deploymentToResource(d, children))
	}
	for _, irs := range orphanRS {
		// Surface orphan ReplicaSets so users can still see them.
		tree.Deployments = append(tree.Deployments, replicaSetToResource(*irs.rs, irs.children))
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
	for _, pv := range pvs.Items {
		tree.PersistentVolumes = append(tree.PersistentVolumes, pvToResource(pv))
	}
	for _, pvc := range pvcs.Items {
		tree.PersistentVolumeClaims = append(tree.PersistentVolumeClaims, pvcToResource(pvc))
	}
	for _, sc := range storageClasses.Items {
		tree.StorageClasses = append(tree.StorageClasses, storageClassToResource(sc))
	}

	tree.OrphanPods = orphanPods
	tree.Warnings = warnings
	return tree, nil
}

// rsDesired is the ReplicaSet's desired replica count (nil spec → 0).
func rsDesired(rs *appsV1.ReplicaSet) int32 {
	if rs.Spec.Replicas == nil {
		return 0
	}
	return *rs.Spec.Replicas
}

// listErrorMaxLen caps a cause shown in the page. client-go errors embed the
// full request URL and can run to several hundred characters.
const listErrorMaxLen = 240

// describeListError turns a client-go list failure into one short line for
// the page. The common whole-cluster causes get plain wording; anything else
// is the error text itself, truncated.
func describeListError(err error) string {
	if err == nil {
		return "unknown error"
	}
	var netErr net.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &netErr) && netErr.Timeout():
		return fmt.Sprintf("no response from the cluster within %s", ListTimeout)
	case apiErrors.IsUnauthorized(err):
		return "the cluster rejected the credentials (401); re-authenticate and retry"
	}
	msg := strings.Join(strings.Fields(err.Error()), " ") // collapse newlines from exec-plugin output
	if len(msg) > listErrorMaxLen {
		msg = msg[:listErrorMaxLen] + "…"
	}
	return msg
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

func pvToResource(pv coreV1.PersistentVolume) K8sResource {
	parts := []string{storageCapacity(pv.Spec.Capacity)}
	if modes := accessModesShort(pv.Spec.AccessModes); modes != "" {
		parts = append(parts, modes)
	}
	if pv.Spec.PersistentVolumeReclaimPolicy != "" {
		parts = append(parts, string(pv.Spec.PersistentVolumeReclaimPolicy))
	}
	if pv.Spec.StorageClassName != "" {
		parts = append(parts, "sc:"+pv.Spec.StorageClassName)
	}
	if pv.Spec.ClaimRef != nil {
		parts = append(parts, "→ "+pv.Spec.ClaimRef.Namespace+"/"+pv.Spec.ClaimRef.Name)
	}
	return K8sResource{
		Kind:   "PersistentVolume",
		Name:   pv.Name,
		Status: string(pv.Status.Phase),
		Age:    formatAge(pv.CreationTimestamp.Time),
		Extra:  strings.Join(parts, " · "),
	}
}

func pvcToResource(pvc coreV1.PersistentVolumeClaim) K8sResource {
	// Prefer the bound capacity; fall back to the request for unbound claims.
	capacity := storageCapacity(pvc.Status.Capacity)
	if capacity == "-" {
		capacity = storageCapacity(pvc.Spec.Resources.Requests)
	}
	parts := []string{capacity}
	if modes := accessModesShort(pvc.Spec.AccessModes); modes != "" {
		parts = append(parts, modes)
	}
	if pvc.Spec.StorageClassName != nil && *pvc.Spec.StorageClassName != "" {
		parts = append(parts, "sc:"+*pvc.Spec.StorageClassName)
	}
	if pvc.Spec.VolumeName != "" {
		parts = append(parts, "→ "+pvc.Spec.VolumeName)
	}
	return K8sResource{
		Kind:   "PersistentVolumeClaim",
		Name:   pvc.Name,
		Status: string(pvc.Status.Phase),
		Age:    formatAge(pvc.CreationTimestamp.Time),
		Extra:  strings.Join(parts, " · "),
	}
}

func storageClassToResource(sc storageV1.StorageClass) K8sResource {
	var parts []string
	if sc.Annotations["storageclass.kubernetes.io/is-default-class"] == "true" {
		parts = append(parts, "default")
	}
	if sc.ReclaimPolicy != nil {
		parts = append(parts, string(*sc.ReclaimPolicy))
	}
	if sc.VolumeBindingMode != nil {
		parts = append(parts, string(*sc.VolumeBindingMode))
	}
	if sc.AllowVolumeExpansion != nil && *sc.AllowVolumeExpansion {
		parts = append(parts, "expandable")
	}
	return K8sResource{
		Kind:   "StorageClass",
		Name:   sc.Name,
		Status: sc.Provisioner,
		Age:    formatAge(sc.CreationTimestamp.Time),
		Extra:  strings.Join(parts, " · "),
	}
}

// storageCapacity returns the storage quantity from a resource list, or "-".
func storageCapacity(list coreV1.ResourceList) string {
	if q, ok := list[coreV1.ResourceStorage]; ok {
		return q.String()
	}
	return "-"
}

// accessModesShort abbreviates PV/PVC access modes (RWO/ROX/RWX/RWOP).
func accessModesShort(modes []coreV1.PersistentVolumeAccessMode) string {
	out := make([]string, 0, len(modes))
	for _, m := range modes {
		switch m {
		case coreV1.ReadWriteOnce:
			out = append(out, "RWO")
		case coreV1.ReadOnlyMany:
			out = append(out, "ROX")
		case coreV1.ReadWriteMany:
			out = append(out, "RWX")
		case coreV1.ReadWriteOncePod:
			out = append(out, "RWOP")
		default:
			out = append(out, string(m))
		}
	}
	return strings.Join(out, ",")
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
