# Apostrophe-proof commit-hash hover popup

Session ID: c065baa7-a5e6-4767-8ce6-55c7251f0d24

## Problem

Hovering the commit hash next to the KRo logo only showed a question-mark
cursor (the `cursor: help` style) instead of a popup with the first line of the
build commit's message.

## Root cause

The hover popup relies on `HeaderBar.VersionMessage`, filled by the server via
`resolveBuildMessage` (`web/server.go`). That function prefers an
ldflags-injected `main.BuildMessage` and otherwise shells out to `git show`.

The install scripts (`install.sh`, `mac-install.sh`) injected only
`main.BuildNumber` via `-ldflags`, never `BuildMessage`. So the *installed*
binary had an empty injected message, and its `git show` fallback failed because
it runs outside the git checkout. With an empty message,
`web/header_component.go` renders no `.version-popup` span — leaving only the
`cursor: help` question-mark cursor on hover.

Dev runs via `go run .` worked because the `git show` fallback executes inside
the repo, which is why the bug wasn't obvious.

## Fix

Inject the commit subject at build time. To make the injection immune to
quoting issues when a commit subject contains spaces, quotes, or apostrophes
(e.g. "Don't ..."), the subject is base64-encoded — base64 output is only
`[A-Za-z0-9+/=]`, so it needs no quoting in the `-ldflags` string at all — and
decoded in Go at startup.

### `main.go`
- Added `BuildMessageB64` ldflags var (base64-encoded commit subject).
- Added `buildMessage()` helper: decodes `BuildMessageB64` when set, else falls
  back to plaintext `BuildMessage` (then the server's git lookup handles empty).
- `web.NewServer(...)` now receives `buildMessage()` instead of `BuildMessage`.
- Added `encoding/base64` import.

### `install.sh` and `mac-install.sh`
Both `build_kro()` functions now:
```sh
build_msg_b64="$(git -C "$KRO_DIR" show -s --format=%s HEAD | base64 | tr -d '\n')"
...
-ldflags "-s -w -X main.BuildNumber=$build_id -X main.BuildMessageB64=$build_msg_b64"
```

## Verification

- `go build` with the new ldflags succeeds; the subject string is embedded in
  the binary (`strings | grep`).
- Round-trip test with a hostile subject (`Don't "break" the build & ship it`)
  containing apostrophes, double quotes, ampersands, and spaces: builds cleanly
  and decodes back exactly.
- `go vet .` clean.

## Files touched
- `main.go`
- `install.sh`
- `mac-install.sh`

## Follow-up / notes
- Re-run the installer (`./install.sh` or `./mac-install.sh`) to rebuild so the
  installed binary picks up the injected commit subject.
- The runtime `git show` fallback in `web/server.go` still serves dev
  (`go run .`) runs; the ldflags path serves installed binaries.
