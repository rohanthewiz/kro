# Session: frame-clipboard-export-feature

**Date:** 2026-06-10 12:03 · **Session id:** `22313d72-8740-448a-a8a7-764ccd36165b`

Continues `2026-0610-0704-implement-pod-watch.md` (that session's work was committed as `b485057` + follow-ups before this one began).

## Request

Four Pod Watch enhancements:
1. If a stream has **ended before the user gets to it**, teeing it to the console should show the last `<buffer-size>` lines of its log.
2. An **export button** to copy/download the text log to a location.
3. Be mindful of **cleanup** in the streamed (watch-logs) location.
4. A **copy button** (double-rectangle icon) on each console frame buffer to copy its contents.

## What was built

### 1. Ended-stream tail replay (`tail=` on the tee)
- `podwatch/files.go` — `tailFile(path, n)`: reads the last n lines of a file backwards in 64K chunks (`tailChunkSize`), drops a possibly-partial first line when stopping mid-file, handles empty file / n<=0 / n > file lines.
- `podwatch/manager.go` — `Subscribe` gained a `tail int` param. For **terminal** streams with `tail > 0` it replays `tailFile(filePath, min(tail, maxTailLines=100_000))` instead of the ring (ring stays the fallback on read error, and the behavior for `tail=0`). Live streams are unchanged — ring replay + live channel; mixing file tail with live would break the no-gap/no-dupe guarantee (buffered writer lags the ring).
- `web/watch_sse.go` — parses `tail` query param (0 on absent/garbage), passes to Subscribe.
- `web/embeds/watch.js` — tee URL now appends `&tail=` + the configured console buffer size. Rationale: the file is complete where the ring caps at 2000, so a 50k buffer setting really gets 50k lines.

### 2. Export / download
- `podwatch/manager.go` — `ExportPath(ctx, ns, pod)`: flushes the stream's buffered writer (so the file is current) and returns its path; `ErrNoSession`/`ErrNoStream` mapped as usual.
- `web/watch_handlers.go` — `WatchExport`: `GET /api/watch/export?context&namespace&pod` → reads the file, `Content-Type: text/plain`, `Content-Disposition: attachment; filename="<base>"` (filename is built from sanitized segments, quote-safe). Only the manager's own recorded path is served — no client-supplied paths.
- `watch.js` — per-row ⤓ button (shown whenever `st.file` is set); click creates a temporary `<a download>` so the browser saves to Downloads/dialog.

### 3. Cleanup (retention janitor + manual)
- New `podwatch/cleanup.go`:
  - `RetentionFromEnv()` — `KRO_WATCH_LOG_RETENTION_DAYS` (non-negative int), default **7 days**, `0` disables auto-clean.
  - `Manager.StartJanitor(maxAge)` — stores retention on the manager (plain field, written before serving), and unless 0 spawns a pruner: runs immediately, then every **6h**.
  - `Manager.Cleanup(maxAge)` — removes `.log` files with mtime older than cutoff, **never** files in `trackedFiles()` (every stream the manager still lists, active *or* terminal — their tails/exports must keep working); prunes emptied dirs deepest-first (root kept); missing log dir is not an error (`filepath.SkipAll`).
  - `Manager.LogDirInfo()` — dir, file count, total bytes, retentionDays (JSON for the UI).
- `main.go` — `mgr.StartJanitor(podwatch.RetentionFromEnv())` + log line.
- Endpoints: `GET /api/watch/loginfo`; `POST /api/watch/cleanup` body `{"days": N}` (pointer-int so 0 is valid and "absent" is a 400; negative → 400; 0 = delete all untracked) → `{removed, freedBytes, info}`.
- UI (gear popover): separator, usage line ("log folder: N files · X MB", folder path in tooltip), days input (defaults to retention or 7) + **Clean up** button, hint that listed streams' files are always kept. Usage fetched each time the popover opens; cleanup result shown in the notice area and usage re-rendered.

### 4. Per-frame copy button
- `watch.js` — `COPY_SVG` inline two-rectangle icon in each frame header (next to ×); `copyFrame()` copies `frame.body.textContent` via `navigator.clipboard.writeText`, falling back to a hidden-textarea `document.execCommand('copy')`; icon flashes ✓ (green) / ✗ (red) for 1.2s.
- `watch.css` — `.watch-frame-copy` (+ `.copied`/`.copy-failed`), settings-popover additions (`.watch-settings-sep`, `.watch-log-usage`, `.watch-clean-row`), dark-mode variants.

### Docs / tests
- README: feature bullet expanded; env table gains `KRO_WATCH_LOG_RETENTION_DAYS`; API table gains export/loginfo/cleanup; `/sse/watch-logs` row documents `tail=`.
- `podwatch_test.go` — Subscribe call sites updated for the new arg; 6 new tests: `TestTailFile` (incl. multi-chunk 128K file), `TestSubscribeTerminalTailsFile` (tail > ring proves file source; tail=0 keeps ring), `TestExportPath` (flush proven by reading un-flushed line back), `TestCleanup` (old removed, tracked/fresh/non-.log kept, empty dir chain pruned, missing dir OK), `TestLogDirInfo`, `TestRetentionFromEnv`.

## Verification

- `go build/vet/test ./...` clean (18 podwatch tests); `node --check` on watch.js OK.
- Live smoke test (no cluster needed): built a binary, ran with `KRO_PORT=8377`, temp `KRO_WATCH_LOG_DIR`, retention 0 — `loginfo` reported the seeded old file; `cleanup {"days":30}` removed it and returned updated info; `{"days":-1}` → 400; `export` for an unknown stream → 404. Killed the test binary afterwards (`pkill -f`, per the stale-server gotcha from the prior session).

## Design notes / boundaries

- Export and ended-replay only work for streams **still listed** in the modal. After ✕ remove or session stop, the file stays on disk (until cleanup) but is only reachable via the filesystem — the manager no longer tracks it.
- `Subscribe` reads the file tail while holding `Stream.mu` only (terminal streams are quiet, file already closed — acceptable).
- Janitor logs via `rohanthewiz/logger` — first logger import inside `podwatch` (rest of the app already uses it).
- Pre-existing gofmt diffs in `kube/*.go` and `web/pages.go` left untouched again.

## State at session end

All changes uncommitted on `main`: modified `README.md`, `main.go`, `podwatch/{files,manager,podwatch_test}.go`, `web/{server,watch_handlers,watch_sse}.go`, `web/embeds/watch.{js,css}`; new `podwatch/cleanup.go`. Next step if resumed: commit, or a manual UI pass (`go run .` → ◉ Watch → gear popover / ⤓ / frame copy).
