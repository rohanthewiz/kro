// Package state persists the per-cluster pinned namespace lists, the last-used
// selection, and the user's starred cluster/namespace favorites to a small
// JSON file on disk. Reads are O(in-memory map); writes flush the whole file
// (the data is tiny — a few strings per cluster — and writes are infrequent).
package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"github.com/rohanthewiz/serr"
)

const stateFileName = "state.json"

// DefaultPath returns the path used when KRO_STATE_FILE is unset:
//
//	$KRO_STATE_FILE  →  $XDG_CONFIG_HOME/kro/state.json (or os.UserConfigDir()).
func DefaultPath() (string, error) {
	if p := os.Getenv("KRO_STATE_FILE"); p != "" {
		return p, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", serr.Wrap(err, "user config dir")
	}
	return filepath.Join(dir, "kro", stateFileName), nil
}

// data is the on-disk shape. Versioned so we can migrate later without breaking.
type data struct {
	Version    int                 `json:"version"`
	Namespaces map[string][]string `json:"namespaces"` // contextName -> [namespace, ...]

	// LastContext is the context the user most recently selected; LastNamespace
	// maps a context to the namespace last selected within it. Together they let
	// a fresh browser (no cookie) resume the last-used cluster/namespace on
	// startup instead of snapping back to the kubeconfig defaults.
	LastContext   string            `json:"lastContext,omitempty"`
	LastNamespace map[string]string `json:"lastNamespace,omitempty"` // contextName -> namespace

	// Favorites is an ORDERED list of cluster/namespace pairs the user has
	// starred. Order is meaningful and user-controlled: the UI numbers the
	// first nine as Ctrl+1..Ctrl+9 hotkeys, so we deliberately do not sort
	// this list the way Namespaces is sorted.
	Favorites []Favorite `json:"favorites,omitempty"`
}

// Favorite is one saved cluster/namespace destination.
//
// Label is an optional user-supplied display name; when empty the UI renders
// "context / namespace". Storing it here (rather than in localStorage) keeps a
// favorite meaningful across browsers, which is the whole point of the file.
type Favorite struct {
	Context   string `json:"context"`
	Namespace string `json:"namespace"`
	Label     string `json:"label,omitempty"`
}

// favKey is the identity of a favorite: the (context, namespace) pair. Label is
// not part of identity, so re-adding an existing pair with a new label edits
// it in place instead of creating a duplicate chip.
func favKey(ctx, ns string) string { return ctx + "\x00" + ns }

// Store is a goroutine-safe handle to the JSON state file.
type Store struct {
	path string

	mu sync.RWMutex
	d  data
}

// Open reads the file if it exists, or initialises an empty store. Missing
// directories are created on the first save, not at open — so a read-only
// load with no file present is fine and won't error.
func Open(path string) (*Store, error) {
	s := &Store{
		path: path,
		d: data{
			Version:       1,
			Namespaces:    map[string][]string{},
			LastNamespace: map[string]string{},
		},
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, serr.Wrap(err, "read state file")
	}
	if len(raw) == 0 {
		return s, nil
	}
	if err := json.Unmarshal(raw, &s.d); err != nil {
		return nil, serr.Wrap(err, "decode state file")
	}
	if s.d.Namespaces == nil {
		s.d.Namespaces = map[string][]string{}
	}
	if s.d.LastNamespace == nil {
		s.d.LastNamespace = map[string]string{}
	}
	return s, nil
}

func (s *Store) Path() string { return s.path }

// Namespaces returns a sorted copy of the pinned namespaces for ctx.
func (s *Store) Namespaces(ctx string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	src := s.d.Namespaces[ctx]
	out := make([]string, len(src))
	copy(out, src)
	return out
}

// Add appends ns to ctx's pinned list (deduplicated, sorted) and persists.
// Returns true if the list changed.
func (s *Store) Add(ctx, ns string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.d.Namespaces[ctx] {
		if existing == ns {
			return false, nil
		}
	}
	s.d.Namespaces[ctx] = append(s.d.Namespaces[ctx], ns)
	sort.Strings(s.d.Namespaces[ctx])
	return true, s.saveLocked()
}

// Remove drops ns from ctx's pinned list and persists.
// Returns true if the list changed.
func (s *Store) Remove(ctx, ns string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.d.Namespaces[ctx]
	idx := -1
	for i, existing := range cur {
		if existing == ns {
			idx = i
			break
		}
	}
	if idx < 0 {
		return false, nil
	}
	s.d.Namespaces[ctx] = append(cur[:idx], cur[idx+1:]...)
	if len(s.d.Namespaces[ctx]) == 0 {
		delete(s.d.Namespaces, ctx)
	}
	return true, s.saveLocked()
}

// LastContext returns the most recently selected context, or "" if none has
// been recorded yet.
func (s *Store) LastContext() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.d.LastContext
}

// LastNamespace returns the namespace last selected within ctx, or "" if none
// has been recorded for it.
func (s *Store) LastNamespace(ctx string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.d.LastNamespace[ctx]
}

// SetLast records ctx as the last-used context and, when ns is non-empty, ns as
// the last-used namespace within ctx. Empty arguments are ignored so callers can
// update just one axis (e.g. a context switch that doesn't name a namespace).
// Persists only when something actually changed.
func (s *Store) SetLast(ctx, ns string) error {
	if ctx == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	if s.d.LastContext != ctx {
		s.d.LastContext = ctx
		changed = true
	}
	if ns != "" && s.d.LastNamespace[ctx] != ns {
		if s.d.LastNamespace == nil {
			s.d.LastNamespace = map[string]string{}
		}
		s.d.LastNamespace[ctx] = ns
		changed = true
	}
	if !changed {
		return nil
	}
	return s.saveLocked()
}

// ----- Favorites -----
//
// A favorite is a (context, namespace) destination the user wants one-click /
// one-keystroke access to. The list is ordered by the user (chips render in
// list order and the first nine get Ctrl+1..9 hotkeys), so every mutation
// below preserves position rather than sorting.

// Favorites returns a copy of the ordered favorites list.
func (s *Store) Favorites() []Favorite {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Favorite, len(s.d.Favorites))
	copy(out, s.d.Favorites)
	return out
}

// IsFavorite reports whether (ctx, ns) is currently starred.
func (s *Store) IsFavorite(ctx, ns string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.indexOfFavLocked(ctx, ns) >= 0
}

// AddFavorite stars (ctx, ns), appending it to the end of the list so existing
// hotkey numbers don't shift under the user. If the pair is already starred,
// only its label is updated (an empty label leaves the existing one alone, so
// re-starring never silently wipes a name the user typed).
// Returns true when something changed.
func (s *Store) AddFavorite(ctx, ns, label string) (bool, error) {
	if ctx == "" || ns == "" {
		return false, serr.New("favorite requires both a context and a namespace")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	if i := s.indexOfFavLocked(ctx, ns); i >= 0 {
		if label == "" || s.d.Favorites[i].Label == label {
			return false, nil
		}
		s.d.Favorites[i].Label = label
		return true, s.saveLocked()
	}

	s.d.Favorites = append(s.d.Favorites, Favorite{Context: ctx, Namespace: ns, Label: label})
	return true, s.saveLocked()
}

// RemoveFavorite unstars (ctx, ns). Returns true when the list changed.
func (s *Store) RemoveFavorite(ctx, ns string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.indexOfFavLocked(ctx, ns)
	if i < 0 {
		return false, nil
	}
	s.d.Favorites = append(s.d.Favorites[:i], s.d.Favorites[i+1:]...)
	return true, s.saveLocked()
}

// SetFavoriteLabel renames an existing favorite; an empty label clears the
// custom name so the UI falls back to "context / namespace".
// Returns true when the label actually changed.
func (s *Store) SetFavoriteLabel(ctx, ns, label string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.indexOfFavLocked(ctx, ns)
	if i < 0 {
		return false, serr.New("not a favorite: " + ctx + "/" + ns)
	}
	if s.d.Favorites[i].Label == label {
		return false, nil
	}
	s.d.Favorites[i].Label = label
	return true, s.saveLocked()
}

// ReorderFavorites rewrites the list order from the (context, namespace) pairs
// in order. Entries not mentioned in order keep their relative order at the
// tail, and pairs in order that aren't favorites are ignored — so a stale
// client (one that dragged a chip while another tab removed a favorite) can
// never delete or resurrect an entry through this path; it can only permute.
func (s *Store) ReorderFavorites(order []Favorite) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	placed := make(map[string]bool, len(s.d.Favorites))
	out := make([]Favorite, 0, len(s.d.Favorites))
	for _, want := range order {
		i := s.indexOfFavLocked(want.Context, want.Namespace)
		if i < 0 {
			continue
		}
		k := favKey(want.Context, want.Namespace)
		if placed[k] { // defend against a duplicated entry in the request
			continue
		}
		placed[k] = true
		out = append(out, s.d.Favorites[i])
	}
	for _, f := range s.d.Favorites {
		if !placed[favKey(f.Context, f.Namespace)] {
			out = append(out, f)
		}
	}
	s.d.Favorites = out
	return s.saveLocked()
}

// indexOfFavLocked returns the position of (ctx, ns) in the favorites list, or
// -1. Callers must hold at least the read lock.
func (s *Store) indexOfFavLocked(ctx, ns string) int {
	for i, f := range s.d.Favorites {
		if f.Context == ctx && f.Namespace == ns {
			return i
		}
	}
	return -1
}

// AllNamespaces returns a copy of the whole pinned map (context -> namespaces).
// The quick-switcher palette uses it to offer every known destination without
// hitting any cluster.
func (s *Store) AllNamespaces() map[string][]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string][]string, len(s.d.Namespaces))
	for ctx, list := range s.d.Namespaces {
		cp := make([]string, len(list))
		copy(cp, list)
		out[ctx] = cp
	}
	return out
}

// saveLocked writes the file atomically (temp + rename) under the held lock.
// Creates the parent directory on first write.
func (s *Store) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return serr.Wrap(err, "mkdir state dir")
	}
	raw, err := json.MarshalIndent(s.d, "", "  ")
	if err != nil {
		return serr.Wrap(err, "encode state")
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return serr.Wrap(err, "write tmp state file")
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return serr.Wrap(err, "rename state file")
	}
	return nil
}
