package state

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestAddRemoveDedupAndSort(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	if changed, _ := s.Add("ctx-a", "team-a"); !changed {
		t.Error("Add returned changed=false on first add")
	}
	if changed, _ := s.Add("ctx-a", "team-a"); changed {
		t.Error("Add returned changed=true on duplicate")
	}
	s.Add("ctx-a", "kube-system")
	s.Add("ctx-a", "default")

	got := s.Namespaces("ctx-a")
	want := []string{"default", "kube-system", "team-a"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Namespaces(ctx-a) = %v, want %v", got, want)
	}

	if changed, _ := s.Remove("ctx-a", "kube-system"); !changed {
		t.Error("Remove returned changed=false for present ns")
	}
	if changed, _ := s.Remove("ctx-a", "kube-system"); changed {
		t.Error("Remove returned changed=true for absent ns")
	}

	got = s.Namespaces("ctx-a")
	want = []string{"default", "team-a"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("after remove, got %v, want %v", got, want)
	}
}

func TestPersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	s1, _ := Open(path)
	s1.Add("ctx-1", "ns-x")
	s1.Add("ctx-2", "ns-y")
	s1.Add("ctx-2", "ns-z")

	s2, err := Open(path)
	if err != nil {
		t.Fatalf("re-open: %v", err)
	}
	if got := s2.Namespaces("ctx-1"); !reflect.DeepEqual(got, []string{"ns-x"}) {
		t.Errorf("ctx-1 after reopen = %v", got)
	}
	if got := s2.Namespaces("ctx-2"); !reflect.DeepEqual(got, []string{"ns-y", "ns-z"}) {
		t.Errorf("ctx-2 after reopen = %v", got)
	}
}

func TestRemovingLastNamespaceClearsContext(t *testing.T) {
	s, _ := Open(filepath.Join(t.TempDir(), "state.json"))
	s.Add("ctx-a", "only")
	s.Remove("ctx-a", "only")
	if got := s.Namespaces("ctx-a"); len(got) != 0 {
		t.Errorf("expected empty list, got %v", got)
	}
}

func TestMissingFileIsTreatedAsEmpty(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "does-not-exist.json"))
	if err != nil {
		t.Fatalf("Open on missing file: %v", err)
	}
	if got := s.Namespaces("any"); len(got) != 0 {
		t.Errorf("expected empty namespaces, got %v", got)
	}
}
