package kube

import (
	"context"
	"slices"
	"time"

	"github.com/rohanthewiz/serr"
	apiErrors "k8s.io/apimachinery/pkg/api/errors"
	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// namespaceListTimeout bounds the one cluster call behind the quick
// switcher's "Browse all namespaces". It is user-initiated and the palette
// shows a loading row meanwhile, so a slow or unreachable cluster should
// fail visibly within seconds rather than hang the row.
const namespaceListTimeout = 8 * time.Second

// ErrNamespaceListForbidden reports that the context's credentials may not
// list namespaces (a cluster-scoped permission many namespace-scoped users
// lack). Callers surface it as "not permitted" rather than a generic failure,
// since typing cluster/namespace still works for those users.
var ErrNamespaceListForbidden = serr.New("not permitted to list namespaces on this cluster")

// ListNamespaceNames returns the names of every namespace the cluster
// reports, sorted. Only names are kept: the palette needs nothing else, and
// the full objects (labels, annotations, managedFields) can be large on
// clusters with hundreds of namespaces.
func ListNamespaceNames(ctx context.Context, client kubernetes.Interface) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, namespaceListTimeout)
	defer cancel()
	list, err := client.CoreV1().Namespaces().List(ctx, metaV1.ListOptions{})
	if err != nil {
		if apiErrors.IsForbidden(err) {
			return nil, ErrNamespaceListForbidden
		}
		return nil, serr.Wrap(err, "list namespaces")
	}
	names := make([]string, 0, len(list.Items))
	for _, ns := range list.Items {
		names = append(names, ns.Name)
	}
	slices.Sort(names)
	return names, nil
}
