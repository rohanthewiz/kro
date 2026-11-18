package kube

import (
	"context"

	"github.com/rohanthewiz/serr"
	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// Delete removes the named resource. Only the original four mutating-allowed
// kinds are supported (the expanded read-only kinds intentionally aren't).
// ctx bounds the call; see RequestTimeout.
func Delete(ctx context.Context, client *kubernetes.Clientset, ns, kind, name string) error {
	propagation := metaV1.DeletePropagationBackground
	opts := metaV1.DeleteOptions{PropagationPolicy: &propagation}

	switch kind {
	case "Job":
		return client.BatchV1().Jobs(ns).Delete(ctx, name, opts)
	case "Pod":
		return client.CoreV1().Pods(ns).Delete(ctx, name, metaV1.DeleteOptions{})
	case "Deployment":
		return client.AppsV1().Deployments(ns).Delete(ctx, name, opts)
	case "ReplicaSet":
		return client.AppsV1().ReplicaSets(ns).Delete(ctx, name, opts)
	default:
		return serr.New("delete not supported for kind " + kind)
	}
}
