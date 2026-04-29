package config

import "os"

type Config struct {
	Port           string
	Verbose        bool
	KubeconfigPath string // empty → resolve via clientcmd loading rules
}

func Load() Config {
	port := os.Getenv("KRO_PORT")
	if port == "" {
		port = "8000"
	}
	return Config{
		Port:           port,
		Verbose:        os.Getenv("KRO_VERBOSE") == "true",
		KubeconfigPath: os.Getenv("KUBECONFIG"),
	}
}
