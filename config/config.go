package config

import (
	"net"
	"os"
	"strings"
	"time"
)

type Config struct {
	// Host is the interface to listen on (KRO_HOST). Empty means every
	// interface, which is the long-standing default; "127.0.0.1" restricts
	// kro to this machine. kro has no login, so anything that can reach the
	// port can use the kubeconfig's credentials.
	Host string
	Port string
	// AllowedHosts are extra hostnames accepted in the Host header
	// (KRO_ALLOWED_HOSTS, comma-separated), for reaching kro through a DNS
	// name. IP literals, localhost and this machine's own hostname are always
	// accepted; see web/guard.go for why the header is checked at all.
	AllowedHosts    []string
	Verbose         bool
	KubeconfigPath  string        // empty → resolve via clientcmd loading rules
	PodReadyTimeout time.Duration // how long to wait for a new pod's logs to become available
}

func Load() Config {
	port := os.Getenv("KRO_PORT")
	if port == "" {
		port = "8222"
	}
	return Config{
		Host:            strings.TrimSpace(os.Getenv("KRO_HOST")),
		Port:            port,
		AllowedHosts:    splitList(os.Getenv("KRO_ALLOWED_HOSTS")),
		Verbose:         os.Getenv("KRO_VERBOSE") == "true",
		KubeconfigPath:  os.Getenv("KUBECONFIG"),
		PodReadyTimeout: podReadyTimeout(),
	}
}

// ListenAddr is the address handed to the HTTP server: "host:port", or
// ":port" for every interface. JoinHostPort brackets an IPv6 host.
func (c Config) ListenAddr() string {
	return net.JoinHostPort(c.Host, c.Port)
}

// splitList parses a comma-separated env value, dropping empty entries.
func splitList(v string) []string {
	var out []string
	for _, part := range strings.Split(v, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// podReadyTimeout resolves KRO_POD_READY_TIMEOUT, a Go duration string such as
// "10m" or "420s". Pods can take several minutes to start, so the default is
// generous; an empty, unparseable, or non-positive value falls back to it.
func podReadyTimeout() time.Duration {
	const def = 10 * time.Minute
	v := os.Getenv("KRO_POD_READY_TIMEOUT")
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return def
	}
	return d
}
