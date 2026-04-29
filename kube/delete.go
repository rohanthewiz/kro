package kube

import (
	"context"

	"github.com/rohanthewiz/serr"
	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// Delete removes the named resource. Only the original four mutating-allowed
// kinds are supported (the expanded read-only kinds intentionally aren't).
func Delete(client *kubernetes.Clientset, ns, kind, name string) error {
	bgCtx := context.Background()
	propagation := metaV1.DeletePropagationBackground
	opts := metaV1.DeleteOptions{PropagationPolicy: &propagation}

	switch kind {
	case "Job":
		return client.BatchV1().Jobs(ns).Delete(bgCtx, name, opts)
	case "Pod":
		return client.CoreV1().Pods(ns).Delete(bgCtx, name, metaV1.DeleteOptions{})
	case "Deployment":
		return client.AppsV1().Deployments(ns).Delete(bgCtx, name, opts)
	case "ReplicaSet":
		return client.AppsV1().ReplicaSets(ns).Delete(bgCtx, name, opts)
	default:
		return serr.New("delete not supported for kind " + kind)
	}
}
