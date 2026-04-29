# KRo install script — session log

**Date:** 2026-04-29 17:52
**Session ID:** b176bd95-71c1-447c-a507-de1a0d1170a0

## Request

> Plz create an install script that will take the latest in the main branch to the user's local, get the required Go version if necessary and build and run KRo.

Follow-up:

> Do add a mention of quick install with install.sh in the README

## Decisions taken (via AskUserQuestion)

| Question | Choice |
|---|---|
| Go missing or < 1.26 | Auto-install Go locally to `~/.local/go` (no sudo) |
| Repo + binary location | Repo at `~/.kro`, symlink at `~/.local/bin/kro` |
| Run after build? | No — print run command only |

## Plan

Saved to `/Users/RAllison3/.claude/plans/plz-create-an-install-sharded-cray.md` and approved before implementation. Highlights:

- Single bash file at repo root (`install.sh`), POSIX-bash, macOS + Linux × amd64/arm64.
- Self-contained, no sudo. Idempotent — re-run = update.
- Strict mode (`set -euo pipefail`).
- Configurable via env: `KRO_REPO_URL`, `KRO_DIR`, `KRO_BIN_DIR`, `KRO_GO_VERSION`, `KRO_GO_DIR`.
- Reuses existing `main.BuildNumber` ldflag hook in `main.go:16` for the build sha.
- Hardcodes `KRO_GO_VERSION=1.26.0`; manual sync needed if `go.mod`'s `go 1.26` line ever moves.

## Implementation

### `install.sh` (new, 0755)

Sections:

1. **Output helpers** — `info` / `ok` / `warn` / `err` / `die`. Color codes only when `[ -t 1 ]`.
2. **Platform detect** — maps `uname -s/-m` → `darwin|linux` × `amd64|arm64`; rejects others.
3. **`require_git`** — fails with platform-specific install hint; never tries to install git itself.
4. **`download`** — `curl -fsSL --retry 3` preferred, `wget -qO-` fallback.
5. **`sync_repo`** — fresh clone (`--depth=1 --branch main`) or `git fetch + reset --hard origin/main`. Refuses to overwrite a non-git `$KRO_DIR`.
6. **`version_ge`** — pure-shell dotted-version compare. Strips trailing non-digits per component (so `1.26rc1` ≈ `1.26.0`). Pads missing components with `0`.
7. **`go_version_of`** — runs `<gobin> env GOVERSION` and strips the leading `go`.
8. **`resolve_go`** — system Go → cached `~/.local/go` → fresh download. Sets `GO_BIN`, `GO_VERSION`, `GO_SOURCE` (`system|local-cached|local-installed`).
9. **`install_go_local`** — downloads `https://go.dev/dl/go${VER}.${OS}-${ARCH}.tar.gz` into `mktemp -d`, extracts, atomically replaces `$KRO_GO_DIR`. `trap RETURN` cleanup of tmpdir.
10. **`build_kro`** — `go build -trimpath -ldflags "-s -w -X main.BuildNumber=<short-sha>" -o kro .`
11. **`install_symlink`** — `ln -sf $KRO_DIR/kro $KRO_BIN_DIR/kro`.
12. **Final summary** — prints repo path, binary path + symlink target, Go version + source, run command, opens-at URL, and the rc-file PATH snippet if `~/.local/bin` isn't on PATH.

Notable choices:

- `git reset --hard origin/main` is destructive but the script "owns" `~/.kro`. Documented in the file header.
- Doesn't permanently alter `~/.zshrc`/`~/.bashrc`. Just prints a snippet the user can paste.
- No README rewrite triggered automatically; that was a follow-up.

### `README.md` edit

Replaced the single `## Install` block with two subsections:

- **Quick install (macOS / Linux)** — curl-pipe-bash one-liner, with summary of what it does and the env override list.
- **From source** — the original `go install ./...` / `go build` instructions, kept verbatim.

## Verification performed

1. `bash -n install.sh` — parses cleanly.
2. `version_ge` table-test for: `1.26.0/1.26.0`, `1.26.1/1.26.0`, `1.27/1.26.0`, `1.25.5/1.26.0`, `1.21.0/1.26.0`, `2.0.0/1.26.0`, `1.26/1.26.0`, `1.26rc1/1.26.0` — all expected.
3. End-to-end smoke run with `KRO_REPO_URL` pointed at the local working copy, throwaway `KRO_DIR`/`KRO_BIN_DIR`/`KRO_GO_DIR` under `/tmp`. First run cloned + built; second run hit the update path (`reset --hard`) and rebuilt. Both produced a 41 MB arm64 Mach-O at `$KRO_DIR/kro` and a working symlink. Cleanup confirmed.
4. Did **not** execute the resulting binary — it binds port 8000 and the sandbox blocked it without explicit user approval. Confirmed via `file` that the artifact is a valid Mach-O.
5. `shellcheck` not installed locally; skipped.

## Open follow-ups (not done)

- Test on `linux/amd64`, `linux/arm64`, `darwin/amd64` (best-effort manual).
- Decide whether to bump `KRO_GO_VERSION` past `1.26.0` once a patch release is the de-facto recommended version.
- The `install.sh` file is currently untracked in git — user has not asked for a commit yet.

## Files touched

- **Created**: `/Users/RAllison3/projs/go/pers/kro/install.sh` (chmod 755)
- **Modified**: `/Users/RAllison3/projs/go/pers/kro/README.md` (added Quick install section)
- **Created**: `/Users/RAllison3/.claude/plans/plz-create-an-install-sharded-cray.md` (plan file)
