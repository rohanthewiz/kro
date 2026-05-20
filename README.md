# KRo

A small local web app to monitor and lightly manage Kubernetes resources across the
clusters in your `~/.kube/config`. Quick context/namespace switching from the toolbar,
live updates over SSE, no cluster-side install.

## Features

- Loads `~/.kube/config` (or `$KUBECONFIG`) on startup; lists every context.
- Per-cluster pinned namespace lists you build up yourself (add `+`, remove `×`).
  Stored as a small JSON file at `os.UserConfigDir()/kro/state.json`.
- Hierarchical resource tree: Jobs, Deployments+ReplicaSets+Pods, StatefulSets,
  DaemonSets, plus flat read-only listings for Services, Ingresses, ConfigMaps, Secrets.
- Per-row actions: Describe (kubectl-describe-style text), Logs (Pods, all containers),
  Delete (Job/Pod/Deployment/ReplicaSet only).
- Collapsible Terminal section: type kubectl arguments (auto-prefixed with the
  active `--context`/`--namespace`), live stdout/stderr streamed back as
  Warp-style blocks. Multi-line editor with syntax highlight and ↑↓ history.
  Requires `kubectl` on PATH.
- Live updates every ~10s via Server-Sent Events; each browser tab can target a
  different cluster/namespace independently (selection is cookie-keyed).
- Collapsible sections (state persists per browser).
- Dark mode.

## Install

### Quick install (macOS / Linux)

```sh
curl -fsSL https://raw.githubusercontent.com/rohanthewiz/kro/main/install.sh | bash
```

Pulls the latest `main` into `~/.kro`, fetches Go 1.26 into `~/.local/go` if your
system Go is missing or older (no sudo), builds, and symlinks `~/.local/bin/kro`.
Re-run the same command any time to update.

Override paths via env: `KRO_DIR`, `KRO_BIN_DIR`, `KRO_GO_DIR`, `KRO_GO_VERSION`.

### From source

```sh
go install ./...
# or
go build -o kro .
```

Requires Go 1.26+.

## Run

```sh
./kro
# then open http://localhost:8000
```

### Environment

| Variable          | Default                                    | Purpose                                  |
|-------------------|--------------------------------------------|------------------------------------------|
| `KRO_PORT`        | `8222`                                     | HTTP listen port                         |
| `KRO_VERBOSE`     | `false`                                    | rweb request logging                     |
| `KUBECONFIG`      | `~/.kube/config`                           | Kubeconfig file (colon-separated merges) |
| `KRO_STATE_FILE`  | `os.UserConfigDir()/kro/state.json`        | Pinned-namespaces JSON file              |

## Layout

```
config/   minimal env-driven config
kube/     kubeconfig loader, per-context client registry, list/describe/logs/delete
state/    file-backed JSON store for pinned namespaces (per cluster)
web/      rweb routes, handlers, SSE feeder, page render, embedded CSS/JS
```

## API

| Method | Path                       | Purpose                                                |
|--------|----------------------------|--------------------------------------------------------|
| GET    | `/api/contexts`            | List kubeconfig contexts + active one                  |
| GET    | `/api/namespaces`          | List pinned namespaces for active context              |
| POST   | `/api/namespaces`          | Pin a namespace `{namespace, select?}`                 |
| DELETE | `/api/namespaces?name=...` | Unpin a namespace                                      |
| POST   | `/api/select`              | Set active `{context?, namespace?}` cookies            |
| GET    | `/api/resources`           | One-shot resource tree                                 |
| GET    | `/api/describe?kind=&name=`| kubectl-describe text                                  |
| GET    | `/api/logs?name=`          | Pod logs (all containers, last 500 lines each)         |
| DELETE | `/api/resources`           | Delete a resource `{kind, name}`                       |
| GET    | `/sse/resources`           | SSE stream of resource snapshots for the cookie scope  |
| GET    | `/sse/term?cmd=...`        | Run `kubectl <cmd>` against active ctx/ns; SSE stdout/stderr/done |
| GET    | `/health`                  | Liveness probe                                         |

## Develop

```sh
go vet ./...
go test ./...
go run .
```

### Example Build with commit hash baked in
`go build -ldflags "-X main.BuildNumber=$(git rev-parse --short HEAD)" -o ~/bin/kro`

### Docker build
`docker build --build-arg BUILD_NUMBER=$(git rev-parse --short HEAD) -t kro .`

### Docker run

Mount your kubeconfig (read-only) and a directory for kro's pinned-namespace
state. The image's `app` user (UID 1001) reads kubeconfig from
`/home/app/.kube/config` and writes state under `/home/app/.config/kro`.

```sh
docker run --rm -it -p 8222:8222 \
  -v "$HOME/.kube/config:/home/app/.kube/config:ro" \
  -v "$HOME/.config/kro:/home/app/.config/kro" \
  kro
```

Or point at any host directory holding both — kubeconfig file named `config`
and a writable spot for `state.json`:

```sh
docker run --rm -it -p 8222:8222 \
  -v "/path/to/configs/kube:/home/app/.kube:ro" \
  -v "/path/to/configs/kro:/home/app/.config/kro" \
  kro
```

The mounted host directory for state must be writable by UID 1001
(`chown 1001 /path/to/configs/kro` or `chmod 777`). Use a named volume
(`-v kro-state:/home/app/.config/kro`) if you'd rather Docker manage it.
