#!/usr/bin/env bash
#
# mac-install.sh — Install (or update) KRo as a native macOS app.
#
# Pulls the latest main branch into ~/.kro, ensures Go >= 1.26 is available
# (auto-installing a private copy under ~/.local/go if needed), builds kro,
# then creates ~/Applications/KRo.app with a small Swift/WebKit wrapper.
#
# The app starts the bundled kro server and displays it in its own macOS window
# instead of opening the UI in a browser.
#
# WARNING: this script owns ~/.kro. Re-running it will `git reset --hard`
# that directory to origin/main — do not put local edits there.
#
# Usage:
#   ./mac-install.sh
#   curl -fsSL https://raw.githubusercontent.com/rohanthewiz/kro/main/mac-install.sh | bash
#
# Env overrides:
#   KRO_REPO_URL    git remote   (default: https://github.com/rohanthewiz/kro.git)
#   KRO_DIR         repo dir     (default: $HOME/.kro)
#   KRO_GO_VERSION  Go to fetch  (default: 1.26.0)
#   KRO_GO_DIR      Go install   (default: $HOME/.local/go)
#   KRO_APP_DIR     app dir      (default: $HOME/Applications)
#   KRO_APP_NAME    app name     (default: KRo)
#   KRO_PORT        app port     (default: 8222)

set -euo pipefail

KRO_REPO_URL="${KRO_REPO_URL:-https://github.com/rohanthewiz/kro.git}"
KRO_DIR="${KRO_DIR:-$HOME/.kro}"
KRO_GO_VERSION="${KRO_GO_VERSION:-1.26.0}"
KRO_GO_DIR="${KRO_GO_DIR:-$HOME/.local/go}"
KRO_APP_DIR="${KRO_APP_DIR:-$HOME/Applications}"
KRO_APP_NAME="${KRO_APP_NAME:-KRo}"
KRO_PORT="${KRO_PORT:-8222}"

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
  [ "$os" = "darwin" ] || die "mac-install.sh requires macOS"

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
  die "git not found. Install with: xcode-select --install"
}

require_swiftc() {
  if command -v swiftc >/dev/null 2>&1; then return 0; fi
  die "swiftc not found. Install Xcode Command Line Tools with: xcode-select --install"
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

# ---- macOS app -------------------------------------------------------------

install_macos_app() {
  local app_path contents macos resources plist swift_src app_exe bundled_kro bundle_id
  app_path="$KRO_APP_DIR/$KRO_APP_NAME.app"
  contents="$app_path/Contents"
  macos="$contents/MacOS"
  resources="$contents/Resources"
  plist="$contents/Info.plist"
  swift_src="$resources/KRoApp.swift"
  app_exe="$macos/$KRO_APP_NAME"
  bundled_kro="$resources/kro"
  bundle_id="dev.kro.KRo"

  info "installing native macOS app at $app_path"
  rm -rf "$app_path"
  mkdir -p "$macos" "$resources"
  cp "$KRO_DIR/kro" "$bundled_kro"
  chmod +x "$bundled_kro"

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>$KRO_APP_NAME</string>
  <key>CFBundleExecutable</key>
  <string>$KRO_APP_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$bundle_id</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$KRO_APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>$KRO_BUILD_ID</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

  cat > "$swift_src" <<EOF
import AppKit
import Foundation
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var serverProcess: Process?
    private let port = "$KRO_PORT"
    private var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }
    private var healthURL: URL { baseURL.appendingPathComponent("health") }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildWindow()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        Task { @MainActor in
            if await waitForServer(timeout: 0.5) {
                loadApp()
                return
            }
            startServer()
            if await waitForServer(timeout: 20.0) {
                loadApp()
            } else {
                showError("KRo did not become ready. Check ~/Library/Logs/KRo/kro.log for details.")
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        serverProcess?.terminate()
    }

    private func buildWindow() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.center()
        window.title = "$KRO_APP_NAME"
        window.contentView = webView
    }

    private func startServer() {
        guard let kroURL = Bundle.main.resourceURL?.appendingPathComponent("kro") else {
            showError("The bundled kro binary is missing.")
            return
        }

        let logDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library")
            .appendingPathComponent("Logs")
            .appendingPathComponent("KRo")
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        let logURL = logDir.appendingPathComponent("kro.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)

        let process = Process()
        process.executableURL = kroURL
        var env = ProcessInfo.processInfo.environment
        env["KRO_PORT"] = port
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:\(FileManager.default.homeDirectoryForCurrentUser.path)/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:" + (env["PATH"] ?? "")
        process.environment = env

        if let logHandle = try? FileHandle(forWritingTo: logURL) {
          _ = try? logHandle.seekToEnd()
            process.standardOutput = logHandle
            process.standardError = logHandle
        }

        do {
            try process.run()
            serverProcess = process
        } catch {
            showError("KRo could not start: \(error.localizedDescription)")
        }
    }

    private func waitForServer(timeout: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if await isHealthy() { return true }
            try? await Task.sleep(nanoseconds: 250_000_000)
        } while Date() < deadline
        return false
    }

    private func isHealthy() async -> Bool {
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 0.4
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    private func loadApp() {
        webView.load(URLRequest(url: baseURL))
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "KRo could not start"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.runModal()
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
EOF

  swiftc "$swift_src" -o "$app_exe" -framework AppKit -framework WebKit
  chmod +x "$app_exe"
  ok "app installed at $app_path"
}

# ---- main ------------------------------------------------------------------

main() {
  detect_platform
  require_git
  require_swiftc
  sync_repo
  resolve_go
  build_kro
  install_macos_app

  printf '\n'
  printf '%s✓ KRo %s app installed%s\n' "$C_GREEN" "$KRO_BUILD_ID" "$C_RESET"
  printf '  repo: %s\n' "$KRO_DIR"
  printf '  app:  %s\n' "$KRO_APP_DIR/$KRO_APP_NAME.app"
  printf '  Go:   %s (%s)\n' "$GO_VERSION" "$GO_SOURCE"
  printf '\nOpen %s%s.app%s from Finder, Spotlight, or the Dock.\n' "$C_GREEN" "$KRO_APP_NAME" "$C_RESET"
  printf 'Logs: ~/Library/Logs/KRo/kro.log\n'
  printf '\nRe-run this installer any time to update to the latest main.\n'
}

main "$@"
