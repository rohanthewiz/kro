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
- Live updates every ~10s via Server-Sent Events; each browser tab can target a
  different cluster/namespace independently (selection is cookie-keyed).
- Collapsible sections (state persists per browser).
- Dark mode.

## Install

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
| `KRO_PORT`        | `8000`                                     | HTTP listen port                         |
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
| GET    | `/health`                  | Liveness probe                                         |

## Develop

```sh
go vet ./...
go test ./...
go run .
```
