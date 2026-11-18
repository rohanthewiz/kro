package web

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"kro/kube"
	"kro/state"

	"github.com/rohanthewiz/rweb"
	"k8s.io/client-go/tools/clientcmd/api"
)

// fakeKubeAPI stands in for a kube-apiserver behind the resources stream.
// Every list answers empty, except pods once addPod is set; while failing is
// set every request answers 500. podLists counts pod List calls, i.e. one per
// snapshot round, which is how the tests observe the producer running (or
// having stopped).
type fakeKubeAPI struct {
	srv      *httptest.Server
	podLists atomic.Int64
	addPod   atomic.Bool
	failing  atomic.Bool
}

func newFakeKubeAPI(t *testing.T) *fakeKubeAPI {
	t.Helper()
	f := &fakeKubeAPI{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		isPods := strings.HasSuffix(r.URL.Path, "/pods")
		if isPods {
			f.podLists.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		if f.failing.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","message":"apiserver on fire","code":500}`))
			return
		}
		if isPods && f.addPod.Load() {
			// Created long ago, so its Age string ("…d") is stable for the test.
			_, _ = w.Write([]byte(`{"metadata":{"resourceVersion":"2"},"items":[{"metadata":{"name":"late-pod","namespace":"default","uid":"u1","creationTimestamp":"2020-01-01T00:00:00Z"},"status":{"phase":"Running"}}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"metadata":{"resourceVersion":"1"},"items":[]}`))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// serveResourcesStream runs a real rweb server exposing /sse/resources (and
// /api/resources) against the fake API, with a fast snapshot interval.
func serveResourcesStream(t *testing.T, apiURL string, every time.Duration) string {
	t.Helper()
	cfg := api.NewConfig()
	cfg.Clusters["c"] = &api.Cluster{Server: apiURL}
	cfg.AuthInfos["u"] = &api.AuthInfo{Token: "t"}
	cfg.Contexts["ctx"] = &api.Context{Cluster: "c", AuthInfo: "u"}
	cfg.CurrentContext = "ctx"

	store, err := state.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()

	ready := make(chan struct{}, 1)
	svr := rweb.NewServer(rweb.ServerOptions{Address: addr, ReadyChan: ready})
	h := &handlers{reg: kube.NewRegistry(cfg, nil), store: store, snapshotEvery: every}
	svr.Get("/sse/resources", h.SSE(svr))
	svr.Get("/api/resources", h.Resources)
	go svr.Run()
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("server did not start")
	}
	for range 50 {
		if c, err := net.Dial("tcp", addr); err == nil {
			c.Close()
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	return "http://" + addr
}

// sseEvent is one parsed server-sent event.
type sseEvent struct{ typ, data string }

// readSSE parses the event stream into a channel, closed at end of stream.
func readSSE(body *bufio.Reader) <-chan sseEvent {
	out := make(chan sseEvent, 64)
	go func() {
		defer close(out)
		var ev sseEvent
		for {
			line, err := body.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimRight(line, "\r\n")
			switch {
			case line == "":
				if ev.typ != "" {
					out <- ev
				}
				ev = sseEvent{}
			case strings.HasPrefix(line, "event: "):
				ev.typ = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				ev.data = strings.TrimPrefix(line, "data: ")
			}
		}
	}()
	return out
}

// nextEvent waits for the next event of the wanted type, failing on any
// other type or a timeout.
func nextEvent(t *testing.T, events <-chan sseEvent, want string) sseEvent {
	t.Helper()
	select {
	case ev, ok := <-events:
		if !ok {
			t.Fatalf("stream ended while waiting for %q", want)
		}
		if ev.typ != want {
			t.Fatalf("got event %q (%.80s), want %q", ev.typ, ev.data, want)
		}
		return ev
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %q", want)
	}
	return sseEvent{}
}

// skipTo discards events until one of the wanted type arrives.
func skipTo(t *testing.T, events <-chan sseEvent, want string) sseEvent {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				t.Fatalf("stream ended while waiting for %q", want)
			}
			if ev.typ == want {
				return ev
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q", want)
		}
	}
}

// The regression this guards: the producer used to be stopped the moment the
// handler returned, so a connection got at most one snapshot. It must keep
// producing for the life of the connection, send ticks while nothing changes,
// a fresh snapshot when something does, an error event (then a full snapshot
// again) across an outage, and stop once the client disconnects.
func TestResourcesStreamLifecycle(t *testing.T) {
	fake := newFakeKubeAPI(t)
	base := serveResourcesStream(t, fake.srv.URL, 40*time.Millisecond)

	res, err := http.Get(base + "/sse/resources")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("Content-Type = %q", ct)
	}
	events := readSSE(bufio.NewReader(res.Body))

	// 1. First round: a full snapshot naming the selection.
	first := nextEvent(t, events, evResourcesSnapshot)
	var tree kube.ResourceTree
	if err := json.Unmarshal([]byte(first.data), &tree); err != nil {
		t.Fatalf("snapshot is not a tree: %v", err)
	}
	if tree.Context != "ctx" || tree.Namespace != "default" {
		t.Errorf("snapshot scope = %s/%s, want ctx/default", tree.Context, tree.Namespace)
	}

	// 2. Nothing changed: later rounds are ticks, not repeated snapshots.
	nextEvent(t, events, evResourcesTick)
	nextEvent(t, events, evResourcesTick)

	// 3. A pod appears: a new snapshot carrying it.
	fake.addPod.Store(true)
	changed := skipTo(t, events, evResourcesSnapshot)
	if !strings.Contains(changed.data, "late-pod") {
		t.Errorf("changed snapshot lacks the new pod: %.200s", changed.data)
	}
	nextEvent(t, events, evResourcesTick)

	// 4. The cluster fails: an error event with the cause, no snapshot.
	fake.failing.Store(true)
	errEv := skipTo(t, events, evResourcesError)
	var errBody map[string]string
	if err := json.Unmarshal([]byte(errEv.data), &errBody); err != nil || !strings.Contains(errBody["error"], "cluster unavailable") {
		t.Errorf("error event = %q (%v)", errEv.data, err)
	}

	// 5. It recovers: a full snapshot again even though the tree is
	//    identical to the pre-outage one (the page needs it to clear its
	//    banner), not a tick.
	fake.failing.Store(false)
	for {
		ev := skipTo(t, events, evResourcesSnapshot)
		if strings.Contains(ev.data, "late-pod") {
			break
		}
	}

	// 6. Disconnect: the producer must stop listing.
	res.Body.Close()
	time.Sleep(300 * time.Millisecond) // let the server notice and wind down
	settled := fake.podLists.Load()
	time.Sleep(400 * time.Millisecond) // ten intervals' worth
	if now := fake.podLists.Load(); now != settled {
		t.Errorf("producer still listing after disconnect: %d → %d pod lists", settled, now)
	}
}

// The one-shot endpoint reports a dead cluster as one 503 with the cause.
func TestResourcesEndpointClusterUnavailable(t *testing.T) {
	fake := newFakeKubeAPI(t)
	base := serveResourcesStream(t, fake.srv.URL, time.Hour)

	res, err := http.Get(base + "/api/resources")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("healthy status = %d, want 200", res.StatusCode)
	}

	fake.failing.Store(true)
	res, err = http.Get(base + "/api/resources")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	var body map[string]string
	_ = json.NewDecoder(res.Body).Decode(&body)
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", res.StatusCode)
	}
	if !strings.Contains(body["error"], "cluster unavailable") || !strings.Contains(body["error"], "apiserver on fire") {
		t.Errorf("error body = %q", fmt.Sprint(body))
	}
}
