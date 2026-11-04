package kube

import (
	"errors"
	"slices"
	"testing"

	coreV1 "k8s.io/api/core/v1"
	apiErrors "k8s.io/apimachinery/pkg/api/errors"
	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func TestListNamespaceNamesSorted(t *testing.T) {
	client := fake.NewSimpleClientset(
		&coreV1.Namespace{ObjectMeta: metaV1.ObjectMeta{Name: "payments"}},
		&coreV1.Namespace{ObjectMeta: metaV1.ObjectMeta{Name: "default"}},
		&coreV1.Namespace{ObjectMeta: metaV1.ObjectMeta{Name: "kube-system"}},
	)
	got, err := ListNamespaceNames(t.Context(), client)
	if err != nil {
		t.Fatalf("ListNamespaceNames: %v", err)
	}
	if want := []string{"default", "kube-system", "payments"}; !slices.Equal(got, want) {
		t.Fatalf("names = %v, want %v", got, want)
	}
}

// A namespace-scoped user gets 403 on the cluster-scoped list; that must map
// to the dedicated sentinel so the handler can answer 403 with a clear reason.
func TestListNamespaceNamesForbidden(t *testing.T) {
	client := fake.NewSimpleClientset()
	client.PrependReactor("list", "namespaces", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apiErrors.NewForbidden(schema.GroupResource{Resource: "namespaces"}, "", errors.New("rbac"))
	})
	_, err := ListNamespaceNames(t.Context(), client)
	if !errors.Is(err, ErrNamespaceListForbidden) {
		t.Fatalf("err = %v, want ErrNamespaceListForbidden", err)
	}
}
