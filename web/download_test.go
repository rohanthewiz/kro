package web

import (
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"kro/podwatch"

	"github.com/rohanthewiz/rweb"
)

// serveCaptureDownloads runs a real rweb server with just the capture
// download route, so the streamed (SendFileAs) response is exercised over an
// actual connection — headers, Content-Length, and body framing included.
func serveCaptureDownloads(t *testing.T, mgr *podwatch.Manager) string {
	t.Helper()
	// Grab a free port, then hand it to rweb (which does its own Listen).
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()

	ready := make(chan struct{}, 1)
	svr := rweb.NewServer(rweb.ServerOptions{Address: addr, ReadyChan: ready})
	h := &handlers{mgr: mgr}
	svr.Get("/api/logs/capture", h.LogsCaptureDownload)
	go svr.Run()
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("server did not start")
	}
	// ReadyChan fires just before the accept loop; give it a beat.
	for i := 0; i < 50; i++ {
		if c, err := net.Dial("tcp", addr); err == nil {
			c.Close()
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	return "http://" + addr
}

func TestLogsCaptureDownloadStreamsFile(t *testing.T) {
	mgr := podwatch.NewManager(nil, t.TempDir())
	c, err := mgr.Live().Acquire("cap-download1", "ctx", "ns", "pod-a")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer c.Release()
	// Enough lines to exceed bufio's buffer and rweb's copy chunk sizes.
	for i := 0; i < 5000; i++ {
		c.WriteLine("line " + strings.Repeat("x", 40))
	}
	c.WriteLine("last line")

	base := serveCaptureDownloads(t, mgr)
	res, err := http.Get(base + "/api/logs/capture?id=cap-download1")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()

	if res.StatusCode != 200 {
		t.Fatalf("status = %d, body %q", res.StatusCode, body)
	}
	if cd := res.Header.Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment;") || !strings.Contains(cd, ".live.log") {
		t.Errorf("Content-Disposition = %q", cd)
	}
	if cc := res.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	if res.ContentLength != int64(len(body)) {
		t.Errorf("Content-Length %d != body %d", res.ContentLength, len(body))
	}
	// The unflushed tail must be included: ExportPath flushes first.
	if !strings.HasSuffix(string(body), "last line\n") {
		t.Errorf("download missing buffered tail; ends with %q", string(body[max(0, len(body)-40):]))
	}
}

func TestLogsCaptureDownloadErrors(t *testing.T) {
	mgr := podwatch.NewManager(nil, t.TempDir())
	base := serveCaptureDownloads(t, mgr)
	for q, want := range map[string]int{
		"id=bad":            http.StatusBadRequest,
		"id=cap-unknown01":  http.StatusNotFound,
		"id=..%2F..%2Fetcx": http.StatusBadRequest,
	} {
		res, err := http.Get(base + "/api/logs/capture?" + q)
		if err != nil {
			t.Fatalf("GET %s: %v", q, err)
		}
		res.Body.Close()
		if res.StatusCode != want {
			t.Errorf("%s: status = %d, want %d", q, res.StatusCode, want)
		}
		if cd := res.Header.Get("Content-Disposition"); cd != "" {
			t.Errorf("%s: error response should not be an attachment (%q)", q, cd)
		}
	}
}
