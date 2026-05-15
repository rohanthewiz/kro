package kube

import (
	"bytes"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/rohanthewiz/serr"
)

// MergeKubeconfig merges srcPath into the primary kubeconfig (paths[0]) by running:
//
//	KUBECONFIG=<primary>:<src>:<rest...> kubectl config view --flatten --raw -o yaml
//
// Output is written back to primary; primary is backed up first as
// "<primary>.bak.<UTC timestamp>". Returns the backup path on success.
//
// paths is the kubeconfig precedence list (typically ClientRegistry.Paths()).
// If empty, falls back to ~/.kube/config.
func MergeKubeconfig(srcPath string, paths []string) (backupPath string, err error) {
	if _, statErr := os.Stat(srcPath); statErr != nil {
		return "", serr.Wrap(statErr, "stat source kubeconfig")
	}

	primary := ""
	var rest []string
	if len(paths) > 0 {
		primary = paths[0]
		rest = paths[1:]
	} else {
		home, herr := os.UserHomeDir()
		if herr != nil {
			return "", serr.Wrap(herr, "resolve home dir")
		}
		primary = filepath.Join(home, ".kube", "config")
	}

	// kubectl merges in KUBECONFIG order — first occurrence wins for conflicting
	// keys. Putting primary first preserves existing entries when names collide.
	parts := append([]string{primary, srcPath}, rest...)
	kubeconfigEnv := strings.Join(parts, string(filepath.ListSeparator))

	cmd := exec.Command("kubectl", "config", "view", "--flatten", "--raw", "-o", "yaml")
	cmd.Env = append(os.Environ(), "KUBECONFIG="+kubeconfigEnv)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if runErr := cmd.Run(); runErr != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = runErr.Error()
		}
		if strings.Contains(runErr.Error(), "executable file not found") {
			msg = "kubectl not found in PATH — install kubectl to merge kubeconfigs"
		}
		return "", serr.New("kubectl config view failed: " + msg)
	}
	if stdout.Len() == 0 {
		return "", serr.New("kubectl config view produced empty output")
	}

	if statInfo, statErr := os.Stat(primary); statErr == nil {
		if statInfo.IsDir() {
			return "", serr.New("primary kubeconfig path is a directory: " + primary)
		}
		backupPath = primary + ".bak." + time.Now().UTC().Format("20060102-150405")
		if cpErr := copyFile(primary, backupPath); cpErr != nil {
			return "", serr.Wrap(cpErr, "backup primary kubeconfig")
		}
	} else if !os.IsNotExist(statErr) {
		return "", serr.Wrap(statErr, "stat primary kubeconfig")
	}

	if mkErr := os.MkdirAll(filepath.Dir(primary), 0o700); mkErr != nil {
		return "", serr.Wrap(mkErr, "mkdir kubeconfig dir")
	}
	tmp := primary + ".kro-merge.tmp"
	if wErr := os.WriteFile(tmp, stdout.Bytes(), 0o600); wErr != nil {
		return "", serr.Wrap(wErr, "write merged kubeconfig")
	}
	if rErr := os.Rename(tmp, primary); rErr != nil {
		_ = os.Remove(tmp)
		return "", serr.Wrap(rErr, "rename merged kubeconfig")
	}

	return backupPath, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}
