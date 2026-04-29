package kube

import (
	"github.com/rohanthewiz/serr"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/clientcmd/api"
)

// LoadKubeconfig resolves and parses the active kubeconfig.
// Resolution order matches kubectl: $KUBECONFIG (colon-separated, merged) → ~/.kube/config.
// Returns the merged config and the precedence list of files actually used.
func LoadKubeconfig() (*api.Config, []string, error) {
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	cfg, err := rules.Load()
	if err != nil {
		return nil, nil, serr.Wrap(err, "failed to load kubeconfig")
	}
	return cfg, rules.Precedence, nil
}
