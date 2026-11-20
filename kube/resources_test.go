package kube

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	appsV1 "k8s.io/api/apps/v1"
	batchV1 "k8s.io/api/batch/v1"
	coreV1 "k8s.io/api/core/v1"
	apiErrors "k8s.io/apimachinery/pkg/api/errors"
	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
	k8stesting "k8s.io/client-go/testing"
)

const testNS = "team-a"

// meta builds namespaced object metadata with a UID equal to the name, so
// owner references can point at it by name.
func meta(name string, created time.Time, owner string) metaV1.ObjectMeta {
	m := metaV1.ObjectMeta{
		Name:              name,
		Namespace:         testNS,
		UID:               types.UID(name),
		CreationTimestamp: metaV1.NewTime(created),
	}
	if owner != "" {
		m.OwnerReferences = []metaV1.OwnerReference{{UID: types.UID(owner), Name: owner}}
	}
	return m
}

func replicaSet(name, owner string, created time.Time, desired int32) *appsV1.ReplicaSet {
	return &appsV1.ReplicaSet{
		ObjectMeta: meta(name, created, owner),
		Spec:       appsV1.ReplicaSetSpec{Replicas: &desired},
	}
}

func pod(name, owner string, created time.Time) *coreV1.Pod {
	return &coreV1.Pod{ObjectMeta: meta(name, created, owner), Status: coreV1.PodStatus{Phase: coreV1.PodRunning}}
}

// The tree groups pods under their controllers, and a Deployment's
// ReplicaSets come out live-first then newest-first. The whole tree must be
// byte-identical across calls: the stream decides "nothing changed" on the
// marshalled JSON, and the old map-ordered output reshuffled ReplicaSets
// between calls.
func TestListResourcesTreeAndStableOrder(t *testing.T) {
	// Old enough that every Age is in whole days and cannot tick over
	// between the calls compared below.
	base := time.Now().Add(-100 * 24 * time.Hour)
	day := func(n int) time.Time { return base.Add(time.Duration(n) * 24 * time.Hour) }

	client := fake.NewSimpleClientset(
		&appsV1.Deployment{ObjectMeta: meta("web", day(0), "")},
		// The live ReplicaSet is the *oldest* (a rollback): it must still
		// sort first, ahead of the newer scaled-down ones.
		replicaSet("web-live", "web", day(1), 2),
		replicaSet("web-old-a", "web", day(2), 0),
		replicaSet("web-old-b", "web", day(3), 0),
		replicaSet("web-old-c", "web", day(4), 0),
		replicaSet("stray-rs", "", day(5), 1), // no Deployment: listed as an orphan RS
		pod("web-live-1", "web-live", day(6)),
		pod("web-live-2", "web-live", day(6)),
		&batchV1.Job{ObjectMeta: meta("migrate", day(1), "")},
		pod("migrate-x", "migrate", day(1)),
		pod("loner", "", day(2)),
		// Another namespace: must not leak into this tree.
		&coreV1.Pod{ObjectMeta: metaV1.ObjectMeta{Name: "elsewhere", Namespace: "other", UID: "elsewhere"}},
	)

	tree, err := ListResources(t.Context(), client, testNS, AllKinds)
	if err != nil {
		t.Fatalf("ListResources: %v", err)
	}
	if len(tree.Warnings) != 0 {
		t.Errorf("unexpected warnings: %v", tree.Warnings)
	}

	if len(tree.Deployments) != 2 || tree.Deployments[0].Name != "web" || tree.Deployments[1].Name != "stray-rs" {
		t.Fatalf("deployments = %+v, want [web, stray-rs(orphan RS)]", tree.Deployments)
	}
	var rsOrder []string
	for _, rs := range tree.Deployments[0].Children {
		rsOrder = append(rsOrder, rs.Name)
	}
	if got, want := strings.Join(rsOrder, ","), "web-live,web-old-c,web-old-b,web-old-a"; got != want {
		t.Errorf("ReplicaSet order = %s, want %s (live first, then newest first)", got, want)
	}
	if kids := tree.Deployments[0].Children[0].Children; len(kids) != 2 {
		t.Errorf("web-live pods = %+v, want 2", kids)
	}
	if len(tree.Jobs) != 1 || len(tree.Jobs[0].Children) != 1 || tree.Jobs[0].Children[0].Name != "migrate-x" {
		t.Errorf("jobs = %+v", tree.Jobs)
	}
	if len(tree.OrphanPods) != 1 || tree.OrphanPods[0].Name != "loner" {
		t.Errorf("orphan pods = %+v, want [loner]", tree.OrphanPods)
	}

	first, _ := json.Marshal(tree)
	for i := range 25 {
		again, err := ListResources(t.Context(), client, testNS, AllKinds)
		if err != nil {
			t.Fatalf("ListResources (repeat %d): %v", i, err)
		}
		if b, _ := json.Marshal(again); string(b) != string(first) {
			t.Fatalf("tree differs between identical calls (repeat %d):\n%s\n%s", i, first, b)
		}
	}
}

// failList makes the fake answer every List of resource with err.
func failList(client *fake.Clientset, resource string, err error) {
	client.PrependReactor("list", resource, func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, err
	})
}

func forbidden(resource string) error {
	return apiErrors.NewForbidden(schema.GroupResource{Resource: resource}, "", errors.New("rbac"))
}

// One kind failing must not fail the tree, and only a real 403 may be blamed
// on RBAC. Both messages keep the "Could not list <Kind>" prefix the page
// uses to route a warning to its tab.
func TestListResourcesPartialFailureWarnings(t *testing.T) {
	client := fake.NewSimpleClientset(pod("p1", "", time.Now().Add(-time.Hour)))
	failList(client, "secrets", forbidden("secrets"))
	failList(client, "ingresses", errors.New("etcd leader changed"))

	tree, err := ListResources(t.Context(), client, testNS, AllKinds)
	if err != nil {
		t.Fatalf("ListResources: %v", err)
	}
	if len(tree.OrphanPods) != 1 {
		t.Errorf("pods should still be listed, got %+v", tree.OrphanPods)
	}
	want := []string{
		"Could not list Ingresses — etcd leader changed",
		"Could not list Secrets — check RBAC permissions",
	}
	if strings.Join(tree.Warnings, "|") != strings.Join(want, "|") {
		t.Errorf("warnings = %q, want %q", tree.Warnings, want)
	}
}

// Every kind failing for a non-permission reason means the cluster is the
// problem: one error, not thirteen misleading RBAC warnings over empty tables.
// "Every kind" is every kind that was listed: a core-only call (the usual
// one) must reach the verdict too, not count the kinds it skipped as working.
func TestListResourcesClusterUnavailable(t *testing.T) {
	for _, kinds := range []Kinds{AllKinds, 0} {
		client := fake.NewSimpleClientset()
		client.PrependReactor("list", "*", func(k8stesting.Action) (bool, runtime.Object, error) {
			return true, nil, errors.New("dial tcp 10.0.0.1:443: connect: connection refused")
		})
		_, err := ListResources(t.Context(), client, testNS, kinds)
		if !errors.Is(err, ErrClusterUnavailable) {
			t.Fatalf("kinds %v: err = %v, want ErrClusterUnavailable", kinds.Names(), err)
		}
		if !strings.Contains(err.Error(), "connection refused") {
			t.Errorf("kinds %v: error should carry the cause, got %q", kinds.Names(), err)
		}
	}
}

// listedResources is the set of resources the fake was asked to List, in the
// order the asks arrived (which, the lists being concurrent, is arbitrary).
func listedResources(client *fake.Clientset) map[string]int {
	seen := map[string]int{}
	for _, a := range client.Actions() {
		if a.GetVerb() == "list" {
			seen[a.GetResource().Resource]++
		}
	}
	return seen
}

// Only the requested kinds, plus the core kinds, are asked of the cluster,
// and the tree names exactly those in Kinds. Secrets in particular must not
// be listed for a tab that does not show them: that is the point of the
// selection (they come back whole, data included).
func TestListResourcesListsOnlySelectedKinds(t *testing.T) {
	core := []string{"jobs", "deployments", "replicasets", "statefulsets", "daemonsets", "pods", "services"}
	cases := []struct {
		name  string
		kinds Kinds
		want  []string
	}{
		{"zero value is core only", 0, core},
		{"core is not duplicated", CoreKinds, core},
		{"one tab's kinds", KindConfigMaps | KindSecrets, append(append([]string{}, core...), "configmaps", "secrets")},
		{"core added to a lone extra", KindStorageClasses, append(append([]string{}, core...), "storageclasses")},
		{"everything", AllKinds, AllKinds.Names()},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			client := fake.NewSimpleClientset(
				&coreV1.Secret{ObjectMeta: meta("token", time.Now(), "")},
				&coreV1.ConfigMap{ObjectMeta: meta("settings", time.Now(), "")},
			)
			tree, err := ListResources(t.Context(), client, testNS, tc.kinds)
			if err != nil {
				t.Fatalf("ListResources: %v", err)
			}
			if got, want := strings.Join(tree.Kinds, ","), strings.Join(tc.want, ","); got != want {
				t.Errorf("tree.Kinds = %s, want %s", got, want)
			}
			seen := listedResources(client)
			if len(seen) != len(tc.want) {
				t.Errorf("listed %v, want exactly %v", seen, tc.want)
			}
			for _, r := range tc.want {
				if seen[r] != 1 {
					t.Errorf("%s listed %d times, want once (listed: %v)", r, seen[r], seen)
				}
			}
			// The tree fields follow the selection: a kind not listed is
			// empty even though the namespace has one.
			if tc.kinds.Has(KindSecrets) != (len(tree.Secrets) == 1) {
				t.Errorf("secrets = %+v with kinds %v", tree.Secrets, tree.Kinds)
			}
			if tc.kinds.Has(KindConfigMaps) != (len(tree.ConfigMaps) == 1) {
				t.Errorf("configmaps = %+v with kinds %v", tree.ConfigMaps, tree.Kinds)
			}
		})
	}
}

// Without the owner kinds, owned pods would be reported as orphans. Asking
// for an unrelated kind alone must still place the pods under their owners.
func TestListResourcesKeepsPodTreeWhateverIsAsked(t *testing.T) {
	old := time.Now().Add(-48 * time.Hour)
	client := fake.NewSimpleClientset(
		&batchV1.Job{ObjectMeta: meta("migrate", old, "")},
		pod("migrate-x", "migrate", old),
		replicaSet("web-rs", "", old, 1),
		pod("web-rs-1", "web-rs", old),
	)
	tree, err := ListResources(t.Context(), client, testNS, KindSecrets)
	if err != nil {
		t.Fatalf("ListResources: %v", err)
	}
	if len(tree.OrphanPods) != 0 {
		t.Errorf("owned pods reported as orphans: %+v", tree.OrphanPods)
	}
	if len(tree.Jobs) != 1 || len(tree.Jobs[0].Children) != 1 {
		t.Errorf("jobs = %+v, want migrate with its pod", tree.Jobs)
	}
}

// A kind's warning keeps its plural label ("Could not list ConfigMaps"), which
// the page routes to the kind's tab, whichever subset was listed.
func TestListResourcesWarningLabelsWithSelection(t *testing.T) {
	client := fake.NewSimpleClientset()
	failList(client, "configmaps", forbidden("configmaps"))
	tree, err := ListResources(t.Context(), client, testNS, KindConfigMaps)
	if err != nil {
		t.Fatalf("ListResources: %v", err)
	}
	want := "Could not list ConfigMaps — check RBAC permissions"
	if len(tree.Warnings) != 1 || tree.Warnings[0] != want {
		t.Errorf("warnings = %q, want [%q]", tree.Warnings, want)
	}
}

func TestParseKinds(t *testing.T) {
	cases := []struct {
		in   string
		want Kinds
	}{
		{"", 0},
		{"secrets", KindSecrets},
		{"configmaps,secrets", KindConfigMaps | KindSecrets},
		{" Secrets , CONFIGMAPS ", KindConfigMaps | KindSecrets}, // case and spaces
		{"secrets,,bogus,secrets", KindSecrets},                  // unknown and empty names skipped
		{strings.Join(AllKinds.Names(), ","), AllKinds},          // round trip
	}
	for _, tc := range cases {
		if got := ParseKinds(tc.in); got != tc.want {
			t.Errorf("ParseKinds(%q) = %v, want %v", tc.in, got.Names(), tc.want.Names())
		}
	}
	if n := len(AllKinds.Names()); n != len(kindTable) {
		t.Errorf("AllKinds names %d kinds, kindTable has %d", n, len(kindTable))
	}
}

// A user who is forbidden everything has a permissions problem, not a dead
// cluster: that stays a (fully warned) empty tree.
func TestListResourcesAllForbiddenIsNotClusterFailure(t *testing.T) {
	client := fake.NewSimpleClientset()
	client.PrependReactor("list", "*", func(a k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, forbidden(a.GetResource().Resource)
	})
	tree, err := ListResources(t.Context(), client, testNS, AllKinds)
	if err != nil {
		t.Fatalf("ListResources: %v", err)
	}
	if len(tree.Warnings) != 13 {
		t.Errorf("warnings = %d, want one per kind (13): %q", len(tree.Warnings), tree.Warnings)
	}
	for _, w := range tree.Warnings {
		if !strings.HasSuffix(w, "check RBAC permissions") {
			t.Errorf("warning %q should be the RBAC message", w)
		}
	}
}

// emptyListAPI is a minimal stand-in for a kube-apiserver: every GET answers
// with an empty list after delay. The fake clientset cannot be used to observe
// concurrency (it runs reactors under one lock, serializing the calls), so
// this goes over real HTTP. An untyped empty list is enough: the typed
// client decodes into the list type it asked for.
func emptyListAPI(t *testing.T, delay time.Duration) *kubernetes.Clientset {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(delay)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"metadata":{"resourceVersion":"1"},"items":[]}`))
	}))
	t.Cleanup(srv.Close)
	client, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL, QPS: clientQPS, Burst: clientBurst})
	if err != nil {
		t.Fatalf("build client: %v", err)
	}
	return client
}

// The lists run concurrently: thirteen calls that each take `delay` must
// finish in about one delay, not thirteen.
func TestListResourcesRunsListsConcurrently(t *testing.T) {
	const delay = 200 * time.Millisecond
	client := emptyListAPI(t, delay)
	start := time.Now()
	tree, err := ListResources(t.Context(), client, testNS, AllKinds)
	if err != nil {
		t.Fatalf("ListResources: %v", err)
	}
	if len(tree.Warnings) != 0 {
		t.Errorf("unexpected warnings: %v", tree.Warnings)
	}
	// Sequential would be 13 × 200ms = 2.6s. Allow generous scheduling slack.
	if took := time.Since(start); took > 5*delay {
		t.Errorf("took %v; lists appear to run sequentially", took)
	}
}

// A caller that gives up (the browser disconnected) gets its own cancellation
// back, not a "cluster unavailable" verdict built from 13 "context canceled"
// errors.
func TestListResourcesCancelledIsNotClusterFailure(t *testing.T) {
	client := emptyListAPI(t, 2*time.Second)
	ctx, cancel := context.WithCancel(t.Context())
	time.AfterFunc(100*time.Millisecond, cancel)
	_, err := ListResources(ctx, client, testNS, AllKinds)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if errors.Is(err, ErrClusterUnavailable) {
		t.Errorf("a cancelled call must not read as a cluster failure: %v", err)
	}
}

func TestDescribeListError(t *testing.T) {
	long := errors.New(strings.Repeat("x", 600))
	if got := describeListError(long); len(got) > listErrorMaxLen+len("…") {
		t.Errorf("long error not truncated: %d chars", len(got))
	}
	if got := describeListError(errors.New("line one\n  line two")); got != "line one line two" {
		t.Errorf("whitespace not collapsed: %q", got)
	}
	unauth := apiErrors.NewUnauthorized("token expired")
	if got := describeListError(unauth); !strings.Contains(got, "401") {
		t.Errorf("unauthorized wording = %q", got)
	}
}
