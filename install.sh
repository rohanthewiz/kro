#!/usr/bin/env bash
#
# install.sh — Install (or update) KRo from main.
#
# Pulls the latest main branch into ~/.kro, ensures Go >= 1.25 is available
# (auto-installing a private copy under ~/.local/go if needed), builds the
# kro binary, and symlinks it into ~/.local/bin.
#
# WARNING: this script owns ~/.kro. Re-running it will `git reset --hard`
# that directory to origin/main — do not put local edits there.
#
# Usage:
#   ./install.sh
#   curl -fsSL https://raw.githubusercontent.com/rohanthewiz/kro/main/install.sh | bash
#
# Env overrides:
#   KRO_REPO_URL    git remote   (default: https://github.com/rohanthewiz/kro.git)
#   KRO_DIR         repo dir     (default: $HOME/.kro)
#   KRO_BIN_DIR     symlink dir  (default: $HOME/.local/bin)
#   KRO_GO_VERSION  Go to fetch  (default: 1.25.0)
#   KRO_GO_DIR      Go install   (default: $HOME/.local/go)

set -euo pipefail

KRO_REPO_URL="${KRO_REPO_URL:-https://github.com/rohanthewiz/kro.git}"
KRO_DIR="${KRO_DIR:-$HOME/.kro}"
KRO_BIN_DIR="${KRO_BIN_DIR:-$HOME/.local/bin}"
KRO_GO_VERSION="${KRO_GO_VERSION:-1.25.0}"
KRO_GO_DIR="${KRO_GO_DIR:-$HOME/.local/go}"

# ---- output helpers --------------------------------------------------------

if [ -t 1 ]; then
  C_BLUE=$'\033[34m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_BLUE=""; C_YELLOW=""; C_RED=""; C_GREEN=""; C_DIM=""; C_RESET=""
fi

info() { printf '%s==>%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf '%s ok%s %s\n'  "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%swarn%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()  { printf '%serror%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
die()  { err "$*"; exit 1; }

# ---- platform detect -------------------------------------------------------

detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$os" in
    darwin|linux) ;;
    *) die "unsupported OS: $os (need darwin or linux)";;
  esac

  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64)  arch="amd64";;
    aarch64|arm64) arch="arm64";;
    *) die "unsupported arch: $arch (need amd64 or arm64)";;
  esac

  OS="$os"
  ARCH="$arch"
}

# ---- prerequisites ---------------------------------------------------------

require_git() {
  if command -v git >/dev/null 2>&1; then return 0; fi
  if [ "$OS" = "darwin" ]; then
    die "git not found. Install with: xcode-select --install"
  else
    die "git not found. Install with your package manager (e.g. apt install git, dnf install git)."
  fi
}

# fetcher: prefer curl, fall back to wget. Args: url, out-file
download() {
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 2 -o "$out" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$out" "$url"
  else
    die "neither curl nor wget found; cannot download $url"
  fi
}

# ---- repo sync -------------------------------------------------------------

sync_repo() {
  if [ -d "$KRO_DIR/.git" ]; then
    info "updating $KRO_DIR from origin/main"
    git -C "$KRO_DIR" remote set-url origin "$KRO_REPO_URL"
    git -C "$KRO_DIR" fetch --depth=1 origin main
    git -C "$KRO_DIR" checkout -q main 2>/dev/null || git -C "$KRO_DIR" checkout -q -B main origin/main
    git -C "$KRO_DIR" reset --hard origin/main
  else
    if [ -e "$KRO_DIR" ]; then
      die "$KRO_DIR exists but is not a git checkout; refusing to overwrite. Remove it or set KRO_DIR."
    fi
    info "cloning $KRO_REPO_URL into $KRO_DIR"
    git clone --depth=1 --branch main "$KRO_REPO_URL" "$KRO_DIR"
  fi
  ok "repo at $(git -C "$KRO_DIR" rev-parse --short HEAD)"
}

# ---- Go resolution ---------------------------------------------------------

# version_ge HAVE WANT  -> 0 if HAVE >= WANT, 1 otherwise. Pure shell.
version_ge() {
  local have="$1" want="$2" h w i
  IFS=. read -r -a h <<< "$have"
  IFS=. read -r -a w <<< "$want"
  for i in 0 1 2; do
    local hi="${h[$i]:-0}" wi="${w[$i]:-0}"
    # strip non-digits (e.g. 1.26rc1 -> 1.26)
    hi="${hi%%[^0-9]*}"; wi="${wi%%[^0-9]*}"
    hi="${hi:-0}"; wi="${wi:-0}"
    if   [ "$hi" -gt "$wi" ]; then return 0
    elif [ "$hi" -lt "$wi" ]; then return 1
    fi
  done
  return 0
}

# go_version_of GO_BIN -> prints "1.26.0" or empty on failure
go_version_of() {
  local bin="$1" v
  v="$("$bin" env GOVERSION 2>/dev/null || true)"
  v="${v#go}"
  printf '%s' "$v"
}

resolve_go() {
  local sys_go sys_ver local_go local_ver
  GO_BIN=""
  GO_SOURCE=""

  if command -v go >/dev/null 2>&1; then
    sys_go="$(command -v go)"
    sys_ver="$(go_version_of "$sys_go")"
    if [ -n "$sys_ver" ] && version_ge "$sys_ver" "$KRO_GO_VERSION"; then
      GO_BIN="$sys_go"
      GO_VERSION="$sys_ver"
      GO_SOURCE="system"
      ok "using system Go $sys_ver at $sys_go"
      return
    fi
    warn "system Go $sys_ver at $sys_go is older than required $KRO_GO_VERSION"
  fi

  local_go="$KRO_GO_DIR/bin/go"
  if [ -x "$local_go" ]; then
    local_ver="$(go_version_of "$local_go")"
    if [ -n "$local_ver" ] && version_ge "$local_ver" "$KRO_GO_VERSION"; then
      GO_BIN="$local_go"
      GO_VERSION="$local_ver"
      GO_SOURCE="local-cached"
      ok "using cached Go $local_ver at $local_go"
      return
    fi
  fi

  install_go_local
  GO_BIN="$KRO_GO_DIR/bin/go"
  GO_VERSION="$(go_version_of "$GO_BIN")"
  [ -n "$GO_VERSION" ] || die "installed Go but '$GO_BIN env GOVERSION' returned empty"
  GO_SOURCE="local-installed"
  ok "installed Go $GO_VERSION at $GO_BIN"
}

install_go_local() {
  local url tmp tarball
  url="https://go.dev/dl/go${KRO_GO_VERSION}.${OS}-${ARCH}.tar.gz"
  info "downloading Go $KRO_GO_VERSION for ${OS}/${ARCH}"
  printf '    %s%s%s\n' "$C_DIM" "$url" "$C_RESET"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  tarball="$tmp/go.tar.gz"

  download "$url" "$tarball"
  tar -xzf "$tarball" -C "$tmp"
  [ -x "$tmp/go/bin/go" ] || die "extracted archive missing go/bin/go"

  mkdir -p "$(dirname "$KRO_GO_DIR")"
  rm -rf "$KRO_GO_DIR"
  mv "$tmp/go" "$KRO_GO_DIR"
}

# ---- build -----------------------------------------------------------------

build_kro() {
  local build_id
  build_id="$(git -C "$KRO_DIR" rev-parse --short HEAD)"
  info "building kro (BuildNumber=$build_id)"
  ( cd "$KRO_DIR" && \
    "$GO_BIN" build -trimpath \
      -ldflags "-s -w -X main.BuildNumber=$build_id" \
      -o kro . )
  [ -x "$KRO_DIR/kro" ] || die "build reported success but $KRO_DIR/kro is missing"
  ok "built $KRO_DIR/kro"
  KRO_BUILD_ID="$build_id"
}

install_symlink() {
  mkdir -p "$KRO_BIN_DIR"
  ln -sf "$KRO_DIR/kro" "$KRO_BIN_DIR/kro"
  ok "linked $KRO_BIN_DIR/kro -> $KRO_DIR/kro"
}

path_has() {
  case ":$PATH:" in
    *":$1:"*) return 0;;
    *) return 1;;
  esac
}

# ---- main ------------------------------------------------------------------

main() {
  detect_platform
  require_git
  sync_repo
  resolve_go
  build_kro
  install_symlink

  printf '\n'
  printf '%s✓ KRo %s installed%s\n' "$C_GREEN" "$KRO_BUILD_ID" "$C_RESET"
  printf '  repo:   %s\n' "$KRO_DIR"
  printf '  binary: %s -> %s\n' "$KRO_BIN_DIR/kro" "$KRO_DIR/kro"
  printf '  Go:     %s (%s)\n' "$GO_VERSION" "$GO_SOURCE"
  printf '\n'

  if path_has "$KRO_BIN_DIR"; then
    printf 'Run:   %skro%s\n' "$C_GREEN" "$C_RESET"
  else
    printf '%s%s is not on $PATH.%s Add it with:\n' "$C_YELLOW" "$KRO_BIN_DIR" "$C_RESET"
    printf '    echo '\''export PATH="%s:$PATH"'\'' >> ~/.zshrc   # or ~/.bashrc\n' "$KRO_BIN_DIR"
    printf '    exec $SHELL -l\n'
    printf '\nOr run directly:  %s%s/kro%s\n' "$C_GREEN" "$KRO_BIN_DIR" "$C_RESET"
  fi
  printf 'Then open: http://localhost:8000\n'
  printf '\nRe-run this installer any time to update to the latest main.\n'
}

main "$@"
