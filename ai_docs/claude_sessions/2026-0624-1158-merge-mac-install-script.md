# Merge mac-install.sh — native macOS app installer

**Date:** 2026-06-24 11:58 &nbsp;|&nbsp; **Session:** 423df079-6487-431b-a0bc-422e9821d127

## Goal

A friend shared a script (`~/Downloads/mac-install.sh.zip`) for installing KRo as a
native macOS app. Evaluate whether it's usable for the project, fix any issues, test
it, document it, and ship it.

## What we did

1. **Examined the script.** Extracted `mac-install.sh` from the zip. It's a
   self-contained installer/updater that:
   - Syncs `github.com/rohanthewiz/kro` into `~/.kro` (`git reset --hard origin/main`).
   - Resolves Go: uses system Go if new enough, else downloads a private copy to
     `~/.local/go`.
   - Builds: `go build -trimpath -ldflags "-s -w -X main.BuildNumber=<sha>" -o kro .`
   - Wraps: generates `~/Applications/KRo.app` with a Swift/WebKit wrapper that
     launches the bundled server, polls `/health`, then shows the UI in a native
     window (no browser).

2. **Verified assumptions against the actual codebase** — all checked out:
   - `main.BuildNumber` var exists (`main.go:17`).
   - `KRO_PORT` read with default `8222` (`config/config.go:12-14`).
   - `/health` returns `"ok"` with 200 (`web/server.go:73`).
   - Root `main` package, module `kro` → `go build -o kro .` works.

3. **Found one real bug:** script defaulted `KRO_GO_VERSION=1.25.0`, but `go.mod`
   declares `go 1.26.0`. Mismatch would fail the build or trigger an unreliable
   `GOTOOLCHAIN=auto` fetch.

4. **Applied the fix:** bumped the default and header/comment references
   `1.25.0` → `1.26.0` (3 spots) after copying the script to the repo root.

5. **Tested end-to-end in a sandbox** (all paths redirected via env overrides,
   repo URL pointed at the local checkout, no network — nothing real touched):
   - `bash -n` syntax: clean.
   - System Go 1.26.1 satisfied the 1.26 floor.
   - Clone → build → `swiftc` compile → bundle: all succeeded.
   - Bundle structure correct; app exe is valid `Mach-O arm64`; `Info.plist`
     version keys populated (`CFBundleVersion=5994d7c`, id `dev.kro.KRo`).
   - Launched the bundled `kro`; `/health` returned `ok`; server logged
     `kro listening on :8223`.

6. **Answered two teardown questions** (both important — the friend's script had a
   shared-server bug):
   - *Does quitting the app affect another KRo on 8224?* **No.** The Swift wrapper
     calls `serverProcess?.terminate()`, which signals only the specific child
     `Process` it spawned (by PID), never by port and never a broadcast. kro itself
     has no signal handling / kill-by-port logic.
   - *Does quitting close a shared server on 8222?* **No.** Startup has an
     early-return reuse path: `if await waitForServer(timeout: 0.5) { loadApp();
     return }` — when a healthy server already exists, `startServer()` never runs and
     `serverProcess` stays `nil`. Teardown's optional chaining (`serverProcess?.`)
     makes terminate a no-op. So whoever *starts* the server owns it; an app that
     merely *attaches* leaves it running on quit. This is exactly the bug the
     friend's script had, and this one avoids it.

7. **Documented it:** added a "Native macOS app" subsection to the README Install
   section (curl one-liner, what it does, Xcode CLT prereq, log location, shared-
   server reuse behavior, unsigned-app + `~/.kro`-hard-reset caveats, env overrides).

8. **Shipped it:**
   - Branched `add-mac-install-script` (avoided committing directly to `main`).
   - Staged only `mac-install.sh` + `README.md`, leaving unrelated working changes
     (`kube/`, `web/`) untouched.
   - Committed `1b730e9`, pushed, set upstream.
   - `gh` CLI not installed → opened the PR via the browser link (Option 1).
   - User merged; `main` fast-forwarded `5994d7c..1aa1da2`; feature branch deleted.

## Key files

- `mac-install.sh` (new, repo root) — the installer.
- `README.md` — new "Native macOS app" subsection under Install.

## Outcome

Merged to `main` (`1aa1da2`). The README's
`raw.githubusercontent.com/.../main/mac-install.sh` curl link now resolves and works.

## Notes / gotchas for future

- The installer **owns `~/.kro`** and `git reset --hard`s it every run — never keep
  local edits there. The dev clone at `~/projs/go/pers/kro` is separate.
- The app is **not code-signed** — first launch may need right-click → Open.
- **Cross-instance caveat** (unrelated to teardown): multiple kro instances default
  to the same `state.json` and watch-log dir under `os.UserConfigDir()/kro`. To run
  several at once, give each its own `KRO_STATE_FILE` to avoid clobbering state.
- Sandbox test pattern that worked well: redirect `KRO_DIR`/`KRO_GO_DIR`/
  `KRO_APP_DIR`/`KRO_APP_NAME`/`KRO_PORT` to a throwaway dir and set
  `KRO_REPO_URL` to the local repo path for a network-free, non-destructive run.
