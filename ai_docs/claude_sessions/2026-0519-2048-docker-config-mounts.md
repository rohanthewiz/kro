# Docker config mounts

Date: 2026-05-19 20:48
Session: docker-config-mounts

## Summary

Two small changes to the Docker workflow:

1. README: documented the docker build command that bakes the commit hash into
   `main.BuildNumber` via `--build-arg BUILD_NUMBER=$(git rev-parse --short HEAD)`.
2. Dockerfile + README: gave the in-container `app` user (UID 1001) a real home
   directory at `/home/app` with pre-created `.kube/` and `.config/kro/`
   subdirs, set `HOME=/home/app`, and declared both as `VOLUME`s. This lets
   `os.UserConfigDir()` and the standard kubeconfig loader resolve naturally
   without env-var overrides, so users can mount a host path to hold both the
   kubeconfig and the pinned-namespace `state.json`.

## Files touched

- `README.md`
  - Updated `### Docker build` to include `--build-arg BUILD_NUMBER=$(git rev-parse --short HEAD)`.
  - Replaced bare `docker run --rm -it -p 8222:8222 kro` with two mount
    examples (standard host paths and a single shared configs directory),
    plus a note about UID 1001 ownership requirements for the writable
    state mount.

- `Dockerfile`
  - `adduser` now uses `-h /home/app`.
  - Pre-create `/home/app/.kube` and `/home/app/.config/kro`, `chown` to 1001:1001.
  - `ENV HOME=/home/app`.
  - `VOLUME ["/home/app/.kube", "/home/app/.config/kro"]`.

## Why no env overrides

The app already resolves:

- kubeconfig via `clientcmd.NewDefaultClientConfigLoadingRules()` →
  `$KUBECONFIG` or `~/.kube/config`.
- state file via `state.DefaultPath()` →
  `$KRO_STATE_FILE` or `os.UserConfigDir()/kro/state.json`.

With `HOME=/home/app` set in the image, both fall into `/home/app/...`
naturally, so docker run only needs `-v` flags — no `-e KUBECONFIG=...` or
`-e KRO_STATE_FILE=...` plumbing required.

## Example invocations now documented

```sh
docker build --build-arg BUILD_NUMBER=$(git rev-parse --short HEAD) -t kro .

docker run --rm -it -p 8222:8222 \
  -v "$HOME/.kube/config:/home/app/.kube/config:ro" \
  -v "$HOME/.config/kro:/home/app/.config/kro" \
  kro
```

## Open considerations / follow-ups

- README still shows `KRO_PORT` default as `8000` in the env table while
  `config.Load()` defaults to `8222` and the docker examples use `8222`.
  Not touched this session — flagging for a future cleanup.
- The image still `EXPOSE 8000` while the app listens on `8222` by default
  inside the container. Either change `EXPOSE` to 8222 or document a
  `-e KRO_PORT=8000` override. Not touched this session.
- The mounted state directory must be writable by UID 1001. README notes the
  `chown 1001` / named-volume options; no automatic chown in entrypoint.