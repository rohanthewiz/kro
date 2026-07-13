package main

import (
	"encoding/base64"
	"fmt"
	"os"

	"kro/config"
	"kro/kube"
	"kro/podwatch"
	"kro/state"
	"kro/web"

	"github.com/rohanthewiz/logger"
)

// BuildNumber is set via -ldflags at build time.
var BuildNumber = ""

// BuildMessage is the top line of the build commit's message, optionally set
// via -ldflags at build time. When empty, the server derives it from git.
var BuildMessage = ""

// BuildMessageB64 is a base64-encoded alternative to BuildMessage. Injecting
// the subject encoded avoids quoting pitfalls in the -ldflags string when the
// commit message contains spaces, quotes, or apostrophes. When set, it takes
// precedence over BuildMessage.
var BuildMessageB64 = ""

// buildMessage returns the commit subject to hand the server, decoding the
// base64 form when present and falling back to the plaintext var otherwise.
func buildMessage() string {
	if BuildMessageB64 == "" {
		return BuildMessage
	}
	if b, err := base64.StdEncoding.DecodeString(BuildMessageB64); err == nil {
		return string(b)
	}
	return BuildMessage
}

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

	reg := kube.NewRegistry(raw, paths)

	watchLogDir, err := podwatch.DefaultLogDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "fatal: resolve watch log dir:", err)
		os.Exit(1)
	}
	mgr := podwatch.NewManager(reg.Client, watchLogDir)
	mgr.SetReadyTimeout(cfg.PodReadyTimeout)
	retention := podwatch.RetentionFromEnv()
	mgr.StartJanitor(retention)
	logger.InfoF("watch log dir: %s (retention=%v, 0s=auto-clean off, podReadyTimeout=%v)",
		watchLogDir, retention, cfg.PodReadyTimeout)

	srv := web.NewServer(cfg, reg, store, mgr, BuildNumber, buildMessage())

	logger.InfoF("kro listening on :%s (build=%s)", cfg.Port, BuildNumber)
	if err := srv.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "fatal: server:", err)
		os.Exit(1)
	}
}
