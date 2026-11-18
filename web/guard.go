package web

import (
	"net"
	"net/http"
	"os"
	"strings"

	"github.com/rohanthewiz/logger"
	"github.com/rohanthewiz/rweb"
)

// Request guard.
//
// kro has no login: whoever can send it an HTTP request acts with the
// kubeconfig credentials of the person running it. /sse/term runs kubectl on a
// plain GET, and a request with no cookie still resolves to the last-used
// cluster. Left unguarded, that makes two kinds of stranger a kubectl user:
//
//	(1) a web page open in any browser on this machine. Browsers will send a
//	    request to http://localhost:8222 on a page's behalf (an <img> tag is
//	    enough for a GET), and same-origin policy only stops the page from
//	    *reading* the answer, not from causing the side effect;
//	(2) the same page using DNS rebinding: it serves itself from evil.example,
//	    then re-points evil.example at 127.0.0.1, after which the browser
//	    treats kro's responses as same-origin with the attacker's script.
//
// The guard closes both without adding a login:
//
//	request ──► Host allowed? ── no ──► 403        (2: a rebound name is not
//	                │ yes                              an IP, localhost, or
//	                ▼                                  this machine's name)
//	          Sec-Fetch-Site says
//	          same-origin / none? ── yes ──► handler
//	                │ no
//	                ├─ header absent: Origin absent or equal to Host? ── yes ──► handler
//	                ├─ cross-site GET of a landing path ("/", "/health") ──► handler
//	                └─ anything else ──► 403      (1)
//
// Non-browser clients (curl, scripts, the KRo.app health probe) send neither
// Sec-Fetch-Site nor Origin and pass, as before. The guard is about browsers
// being steered by pages the user did not mean to give cluster access to; it
// is not authentication, and it does nothing about another machine on the
// network talking to kro directly. Binding to loopback (KRO_HOST) is the
// answer to that.

// landingPaths are the only paths a cross-site request may reach: a link or
// bookmark to the UI from another site must still open it, and /health is
// harmless. Everything that reads cluster data or acts on it is excluded.
var landingPaths = map[string]bool{"/": true, "/health": true}

// hostAllowlist decides which Host header values are acceptable.
type hostAllowlist struct {
	names map[string]bool // lowercase hostnames, in addition to IP literals and localhost
}

// newHostAllowlist builds the allowlist from this machine's hostname plus the
// operator's extra names (KRO_ALLOWED_HOSTS). The machine's own name is
// included so that reaching kro as http://<hostname>:8222 or
// http://<hostname>.local:8222 from another device keeps working; a rebinding
// attacker controls a public DNS name, not this one.
func newHostAllowlist(extra []string) hostAllowlist {
	names := map[string]bool{}
	add := func(n string) {
		n = strings.ToLower(strings.TrimSpace(n))
		if n != "" {
			names[n] = true
		}
	}
	if hn, err := os.Hostname(); err == nil {
		add(hn)
		short, _, _ := strings.Cut(hn, ".")
		add(short)
		add(short + ".local")
	}
	for _, n := range extra {
		add(n)
	}
	return hostAllowlist{names: names}
}

// allows reports whether a Host header (with or without a port) names this
// server legitimately: any IP literal, localhost, or an allowlisted name.
// IP literals are always fine because a rebinding attack needs a *name* the
// attacker can re-point; the browser's same-origin check does the rest.
func (a hostAllowlist) allows(hostHeader string) bool {
	host := hostOnly(hostHeader)
	if host == "" {
		return false
	}
	if net.ParseIP(host) != nil {
		return true
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	return a.names[host]
}

// hostOnly strips the port and IPv6 brackets from a Host header value and
// lowercases it: "Example:8222" → "example", "[::1]:8222" → "::1".
func hostOnly(hostHeader string) string {
	h := strings.ToLower(strings.TrimSpace(hostHeader))
	if host, _, err := net.SplitHostPort(h); err == nil {
		return strings.TrimSuffix(host, ".")
	}
	// No port (or not splittable): drop IPv6 brackets if present.
	h = strings.TrimPrefix(h, "[")
	h = strings.TrimSuffix(h, "]")
	return strings.TrimSuffix(h, ".")
}

// guardVerdict is the guard's whole decision as a pure function, so every
// branch is unit-testable without a server. It returns "" to allow the
// request, or a short reason for refusing it.
func guardVerdict(method, path, host, secFetchSite, origin string, allow hostAllowlist) string {
	if !allow.allows(host) {
		return "host not allowed (set KRO_ALLOWED_HOSTS to permit it)"
	}

	switch strings.ToLower(strings.TrimSpace(secFetchSite)) {
	case "same-origin", "none":
		// The page itself, or the user typing the URL / using a bookmark.
		return ""
	case "":
		// A browser too old to send Fetch Metadata, or not a browser. Fall
		// back to Origin, which browsers attach to cross-origin requests
		// and to same-origin non-GET ones.
		if origin == "" {
			return ""
		}
		if originMatchesHost(origin, host) {
			return ""
		}
	}

	// From here the request is cross-origin ("cross-site", "same-site" — a
	// different port on this machine is still another application — or a
	// mismatched Origin).
	if method == http.MethodGet && landingPaths[path] {
		return ""
	}
	return "cross-site request refused"
}

// originMatchesHost reports whether an Origin header ("scheme://host[:port]")
// names the same host:port the request was addressed to. "null" (sandboxed
// frames, file:// pages) never matches.
func originMatchesHost(origin, host string) bool {
	_, rest, ok := strings.Cut(origin, "://")
	if !ok {
		return false
	}
	return strings.EqualFold(strings.TrimSuffix(rest, "/"), strings.TrimSpace(host))
}

// requestGuard is the middleware form of guardVerdict. A refused request gets
// a bare 403 and never reaches a route handler.
func requestGuard(allow hostAllowlist) rweb.Handler {
	return func(c rweb.Context) error {
		req := c.Request()
		reason := guardVerdict(req.Method(), req.Path(), req.Host(),
			req.Header("Sec-Fetch-Site"), req.Header("Origin"), allow)
		if reason == "" {
			return c.Next()
		}
		logger.WarnF("refused %s %s (host=%q origin=%q sec-fetch-site=%q): %s",
			req.Method(), req.Path(), req.Host(), req.Header("Origin"), req.Header("Sec-Fetch-Site"), reason)
		return writeTextErr(c, http.StatusForbidden, reason)
	}
}
