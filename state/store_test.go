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

// keys flattens favorites to "ctx/ns" strings for readable assertions.
func favKeys(favs []Favorite) []string {
	out := make([]string, 0, len(favs))
	for _, f := range favs {
		out = append(out, f.Context+"/"+f.Namespace)
	}
	return out
}

func TestFavoritesAppendInOrderAndDedup(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	if changed, _ := s.AddFavorite("prod", "payments", ""); !changed {
		t.Error("AddFavorite returned changed=false on first add")
	}
	s.AddFavorite("stg", "api", "")
	s.AddFavorite("dev", "tools", "")

	// Re-adding an existing pair must not duplicate it or move it — hotkey
	// numbers would shift under the user.
	if changed, _ := s.AddFavorite("prod", "payments", ""); changed {
		t.Error("AddFavorite returned changed=true for an existing pair")
	}

	got := favKeys(s.Favorites())
	want := []string{"prod/payments", "stg/api", "dev/tools"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Favorites() = %v, want %v", got, want)
	}

	if !s.IsFavorite("stg", "api") {
		t.Error("IsFavorite(stg, api) = false, want true")
	}
	if s.IsFavorite("stg", "nope") {
		t.Error("IsFavorite(stg, nope) = true, want false")
	}

	if changed, _ := s.RemoveFavorite("stg", "api"); !changed {
		t.Error("RemoveFavorite returned changed=false for a present favorite")
	}
	if changed, _ := s.RemoveFavorite("stg", "api"); changed {
		t.Error("RemoveFavorite returned changed=true for an absent favorite")
	}
	if got, want := favKeys(s.Favorites()), []string{"prod/payments", "dev/tools"}; !reflect.DeepEqual(got, want) {
		t.Errorf("after remove, Favorites() = %v, want %v", got, want)
	}
}

func TestFavoriteLabels(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	s.AddFavorite("prod", "payments", "Payments PROD")

	// Re-adding with an empty label must not wipe a name the user typed.
	s.AddFavorite("prod", "payments", "")
	if got := s.Favorites()[0].Label; got != "Payments PROD" {
		t.Errorf("label after empty re-add = %q, want %q", got, "Payments PROD")
	}

	if _, err := s.SetFavoriteLabel("prod", "payments", ""); err != nil {
		t.Fatalf("SetFavoriteLabel: %v", err)
	}
	if got := s.Favorites()[0].Label; got != "" {
		t.Errorf("label after explicit clear = %q, want empty", got)
	}
	if _, err := s.SetFavoriteLabel("nope", "nope", "x"); err == nil {
		t.Error("SetFavoriteLabel on a non-favorite returned nil error")
	}
}

func TestReorderFavoritesPermutesOnly(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	s.AddFavorite("a", "1", "")
	s.AddFavorite("b", "2", "")
	s.AddFavorite("c", "3", "")

	// Unknown pairs are ignored, duplicates collapse, and unmentioned entries
	// keep their relative order at the tail — a stale client can permute but
	// never add or drop.
	err = s.ReorderFavorites([]Favorite{
		{Context: "c", Namespace: "3"},
		{Context: "c", Namespace: "3"},
		{Context: "zz", Namespace: "9"},
	})
	if err != nil {
		t.Fatalf("ReorderFavorites: %v", err)
	}
	got := favKeys(s.Favorites())
	want := []string{"c/3", "a/1", "b/2"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Favorites() = %v, want %v", got, want)
	}
}

func TestFavoritesPersistAcrossReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	s.AddFavorite("prod", "payments", "Pay")
	s.AddFavorite("stg", "api", "")

	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got := s2.Favorites()
	want := []Favorite{
		{Context: "prod", Namespace: "payments", Label: "Pay"},
		{Context: "stg", Namespace: "api"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("after reopen, Favorites() = %+v, want %+v", got, want)
	}
}

func TestAddFavoriteRequiresBothFields(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, err := s.AddFavorite("prod", "", ""); err == nil {
		t.Error("AddFavorite with an empty namespace returned nil error")
	}
	if _, err := s.AddFavorite("", "ns", ""); err == nil {
		t.Error("AddFavorite with an empty context returned nil error")
	}
}
