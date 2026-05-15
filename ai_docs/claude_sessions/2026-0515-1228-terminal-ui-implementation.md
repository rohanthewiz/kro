# Terminal UI Implementation

**Date:** 2026-05-15 12:28 · **Session:** 20f1fcef-077b-4266-acc1-6adeefba3a5b

## Goal

Add a collapsible terminal section above Jobs so kubectl commands can be issued
directly from the dashboard. Original ask referenced
https://github.com/rohanthewiz/rterm as a possible base — the user emphasized a
"graphical command line editor" as a minimum requirement (click-to-position
caret, multi-line editing, syntax highlight).

## rterm assessment

rterm is a native **Gio** (GPU desktop GUI) terminal emulator with elvish
embedded as a Go library. Two blockers for reuse here:

1. It's a standalone desktop app, not a library. Embedding it into kro's web UI
   isn't possible without a major rewrite.
2. Code lives under `internal/`, which Go's import rules forbid importing from
   another module.

So rterm informed the design (Warp-style block UI, click-to-position editor,
syntax highlight) but no code was imported. We built the equivalent in browser
JS with a transparent `<textarea>` overlaid on a syntax-highlighting `<pre>` —
native caret behavior, live colorization, no JS framework.

## Design decisions (confirmed with user)

- **Command scope:** kubectl-only, auto-prefixed with the active
  `--context`/`--namespace`. The Go server runs `kubectl` via `exec.CommandContext`
  with stdin detached; no shell involved, so quoted args travel safely.
- **Editor style:** inspired-by-rterm block editor. Each command produces a
  visible block with its prompt, live stdout/stderr, and an exit-status pill.

## What shipped

### Backend

**`kube/term.go`** (new)
- `TokenizeArgs(s)` — shell-aware tokenizer (single/double quotes, backslash
  escapes), no shell ever invoked.
- `RunKubectl(ctx, ctxName, ns, args, out)` — spawns `kubectl
  --context=… --namespace=… <args…>`, streams stdout/stderr line-by-line on a
  `chan TermEvent`, ends with a `done` event carrying the exit code. Cancel
  ctx → process killed. Friendly error when kubectl isn't on PATH.

**`kube/term_test.go`** (new)
- Covers quoted args, `--` separator, escape sequences, unterminated quotes.

**`web/sse.go`**
- Added `(h *handlers) TermSSE(svr) rweb.Handler`. Reuses the SSEHub +
  `OnDisconnect` pattern from `LogsSSE` — when the browser tab closes, the hub
  fires `OnDisconnect`, which cancels the streamCtx, which kills the kubectl
  child. Drains any buffered events on completion before exiting.
- Event types: `stdout`, `stderr`, `done`. `cmd` length capped at 4096.

**`web/server.go`**
- Registered `svr.Get("/sse/term", h.TermSSE(svr))`.

### Frontend

**`web/pages.go`**
- New `terminalSection(b)` component, rendered between the summary cards and
  the resource-content div. Section uses the standard `.resource-section` shell
  so its collapse animation/chevron matches every other section. Starts
  collapsed; JS restores the user's choice from `kro_collapsed_terminal`.

**`web/embeds/resources.css`**
- ~150 lines appended for terminal styling. Dark panel (`#1f2330`) regardless
  of light/dark mode — it always reads as a terminal. Token classes
  `.tk-verb`, `.tk-flag`, `.tk-string`, `.tk-resource`, `.tk-sep`,
  `.tk-number`, `.tk-comment`.
- Editor uses `position: relative` on a wrapper, `position: absolute; inset: 0`
  on the highlight `<pre>`, and `position: relative; color: transparent;
  caret-color: …` on the textarea — clicks land on the textarea (native
  caret), the colored text shows through from behind.

**`web/embeds/resources.js`** (terminal block appended inside the existing
IIFE)
- `highlightTermLine(line, isFirstLine)` — small parser that picks off
  quoted strings, `--` end-of-flags, `-x`/`--foo[=value]` flags, the kubectl
  verb (when on the first line), numbers, and comments. Anything between a
  verb and the next whitespace gets the softer `.tk-resource` color.
- `refreshTermHighlight()` runs on every input event. Trailing-newline edge
  case handled (a `' '` is appended so the last visual row doesn't collapse).
- `autosizeTermInput()` resizes the textarea to fit content up to 220 px tall.
- History: in-memory array + `localStorage['kro_term_history']` (200 max).
  Up/Down only navigate when the caret is on the first / last line so multi-
  line editing isn't hijacked. Live draft is saved on first Up so the user
  can come back to it.
- Each command produces a `.term-block` with prompt, output `<pre>`, and a
  status pill that flips from `running…` → `exit N` / `canceled`. stderr lines
  rendered in `.term-stderr` red.
- `termCancel()` closes the EventSource — server-side `OnDisconnect` cancels
  the kubectl process. Bound to Esc and to a Cancel button shown only while
  running.
- `termClear()` resets the block list. Bound to Ctrl-L.
- `updateTermTarget()` keeps the small pill in the section header in sync with
  the dashboard's selected `ctx / ns`. Hooked into `selectAndReload` and
  `onContextChange` so the pill reflects what the next kubectl call will use.

**`README.md`**
- Feature bullet added for the terminal section.
- `/sse/term` row added to the API table.

## Verification

- `go vet ./...` — clean.
- `go build ./...` — clean.
- `go test ./...` — passing (new tokenizer tests included).
- Built binary served `/health` → `ok` and `/` contained the new terminal
  markup (`term-section`, `term-input`, `term-highlight`, `term-blocks`,
  `data-section="terminal"`).
- No real-cluster smoke test of the SSE endpoint was run — that requires
  manual interaction.

## Files touched

- `kube/term.go` (new)
- `kube/term_test.go` (new)
- `web/server.go`
- `web/sse.go`
- `web/pages.go`
- `web/embeds/resources.css`
- `web/embeds/resources.js`
- `README.md`

## Notes for future work

- The kubectl verb regex in `highlightTermLine` lists the common verbs;
  unknown verbs render uncolored (graceful). If kubectl adds new top-level
  verbs the list can be extended without touching anything else.
- The terminal uses the same `kro_collapsed_<slug>` localStorage key the rest
  of the page uses, but is the only section rendered server-side; that's why
  it needs the small "restore from localStorage" block in `initTerminal()`
  rather than getting it for free via `sectionShell()`.
- Long-running commands (`logs -f`, `port-forward`) work — they'll keep
  streaming until the user hits Cancel/Esc or navigates away.
- `kubectl exec -it` etc. won't work as interactive sessions because stdin is
  detached. Documented elsewhere if needed; non-interactive variants are fine.
