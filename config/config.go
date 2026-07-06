package config

import (
	"os"
	"time"
)

type Config struct {
	Port            string
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
		Port:            port,
		Verbose:         os.Getenv("KRO_VERBOSE") == "true",
		KubeconfigPath:  os.Getenv("KUBECONFIG"),
		PodReadyTimeout: podReadyTimeout(),
	}
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
