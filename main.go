package main

import (
	"fmt"
	"os"

	"kro/config"
	"kro/kube"
	"kro/state"
	"kro/web"

	"github.com/rohanthewiz/logger"
)

// BuildNumber is set via -ldflags at build time.
var BuildNumber = ""

func main() {
	cfg := config.Load()

	raw, paths, err := kube.LoadKubeconfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, "fatal: load kubeconfig:", err)
		os.Exit(1)
	}
	logger.InfoF("loaded kubeconfig (contexts=%d, paths=%v, current=%q)",
		len(raw.Contexts), paths, raw.CurrentContext)
	if len(raw.Contexts) == 0 {
		logger.WarnF("no contexts found in kubeconfig — UI will be empty")
	}

	statePath, err := state.DefaultPath()
	if err != nil {
		fmt.Fprintln(os.Stderr, "fatal: resolve state path:", err)
		os.Exit(1)
	}
	store, err := state.Open(statePath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fatal: open state file:", err)
		os.Exit(1)
	}
	logger.InfoF("state file: %s", store.Path())

	reg := kube.NewRegistry(raw)
	srv := web.NewServer(cfg, reg, store)

	logger.InfoF("kro listening on :%s (build=%s)", cfg.Port, BuildNumber)
	if err := srv.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "fatal: server:", err)
		os.Exit(1)
	}
}
