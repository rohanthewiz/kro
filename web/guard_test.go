package web

import (
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/rohanthewiz/rweb"
)

func TestGuardVerdict(t *testing.T) {
	allow := hostAllowlist{names: map[string]bool{"mybox": true, "mybox.local": true, "kro.internal": true}}

	cases := []struct {
		name                             string
		method, path, host, site, origin string
		allowed                          bool
	}{
		// --- the page itself, and direct use ---
		{"page fetch", "GET", "/api/resources", "127.0.0.1:8222", "same-origin", "", true},
		{"page POST", "POST", "/api/select", "localhost:8222", "same-origin", "http://localhost:8222", true},
		{"typed URL", "GET", "/", "localhost:8222", "none", "", true},
		{"curl, no browser headers", "GET", "/sse/term", "127.0.0.1:8222", "", "", true},
		{"curl DELETE", "DELETE", "/api/resources", "127.0.0.1:8222", "", "", true},
		{"LAN by IP", "GET", "/api/resources", "192.168.1.20:8222", "same-origin", "", true},
		{"IPv6 loopback", "GET", "/api/resources", "[::1]:8222", "same-origin", "", true},
		{"machine name", "GET", "/api/resources", "MyBox.local:8222", "same-origin", "", true},
		{"allowlisted name", "GET", "/api/resources", "kro.internal", "same-origin", "", true},

		// --- another site steering the browser ---
		{"img tag runs kubectl", "GET", "/sse/term", "localhost:8222", "cross-site", "", false},
		{"cross-site delete", "DELETE", "/api/resources", "localhost:8222", "cross-site", "https://evil.example", false},
		{"cross-site read", "GET", "/api/resources", "localhost:8222", "cross-site", "", false},
		{"other local app (same-site)", "POST", "/api/watch/start", "localhost:8222", "same-site", "http://localhost:3000", false},
		{"link to the UI from elsewhere", "GET", "/", "localhost:8222", "cross-site", "", true},
		{"cross-site health", "GET", "/health", "localhost:8222", "cross-site", "", true},
		{"cross-site POST to /", "POST", "/", "localhost:8222", "cross-site", "", false},

		// --- old browser: no Sec-Fetch-Site, Origin decides ---
		{"legacy same-origin POST", "POST", "/api/select", "localhost:8222", "", "http://localhost:8222", true},
		{"legacy cross-origin POST", "POST", "/api/select", "localhost:8222", "", "https://evil.example", false},
		{"legacy sandboxed origin", "POST", "/api/select", "localhost:8222", "", "null", false},

		// --- DNS rebinding: same-origin as far as the browser knows ---
		{"rebound name", "GET", "/sse/term", "evil.example:8222", "same-origin", "", false},
		{"rebound name, no metadata", "GET", "/sse/term", "evil.example", "", "", false},
		{"empty host", "GET", "/", "", "none", "", false},
	}
	for _, tc := range cases {
		reason := guardVerdict(tc.method, tc.path, tc.host, tc.site, tc.origin, allow)
		if got := reason == ""; got != tc.allowed {
			t.Errorf("%s: allowed = %v (reason %q), want %v", tc.name, got, reason, tc.allowed)
		}
	}
}

func TestHostOnly(t *testing.T) {
	for in, want := range map[string]string{
		"localhost:8222":   "localhost",
		"LOCALHOST":        "localhost",
		"[::1]:8222":       "::1",
		"[::1]":            "::1",
		"10.0.0.5":         "10.0.0.5",
		"example.com.:443": "example.com",
		"":                 "",
	} {
		if got := hostOnly(in); got != want {
			t.Errorf("hostOnly(%q) = %q, want %q", in, got, want)
		}
	}
}

// The middleware must stop a refused request before the route handler runs
// (the handler's side effect is the whole danger), and leave allowed ones
// untouched.
func TestRequestGuardMiddleware(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()

	ready := make(chan struct{}, 1)
	svr := rweb.NewServer(rweb.ServerOptions{Address: addr, ReadyChan: ready})
	svr.Use(requestGuard(newHostAllowlist(nil)))
	ran := make(chan string, 8)
	svr.Get("/sse/term", func(c rweb.Context) error {
		ran <- c.Request().QueryParam("cmd")
		return c.WriteString("ran")
	})
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

	get := func(site, host string) (int, string) {
		req, _ := http.NewRequest("GET", "http://"+addr+"/sse/term?cmd=delete+everything", nil)
		if site != "" {
			req.Header.Set("Sec-Fetch-Site", site)
		}
		if host != "" {
			req.Host = host
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET: %v", err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(body)
	}

	if code, body := get("cross-site", ""); code != http.StatusForbidden || !strings.Contains(body, "cross-site") {
		t.Errorf("cross-site: %d %q, want 403", code, body)
	}
	if code, _ := get("same-origin", "evil.example:8222"); code != http.StatusForbidden {
		t.Errorf("rebound host: %d, want 403", code)
	}
	select {
	case cmd := <-ran:
		t.Fatalf("handler ran for a refused request (cmd=%q)", cmd)
	default:
	}

	if code, body := get("same-origin", ""); code != http.StatusOK || body != "ran" {
		t.Errorf("same-origin: %d %q, want 200 ran", code, body)
	}
	if code, _ := get("", ""); code != http.StatusOK {
		t.Errorf("no browser headers: %d, want 200", code)
	}
}
