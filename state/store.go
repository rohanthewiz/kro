// Package state persists the per-cluster pinned namespace lists to a small
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
//   $KRO_STATE_FILE  →  $XDG_CONFIG_HOME/kro/state.json (or os.UserConfigDir()).
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
}

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
