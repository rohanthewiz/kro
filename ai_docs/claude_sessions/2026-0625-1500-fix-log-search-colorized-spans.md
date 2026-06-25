# Fix log search to match across colorized spans

Date: 2026-06-25 15:00 — session id: `6073d555-0034-4fe9-bfb1-32bb796fb173`

## Goal

Verify and fix regex search in the kro log viewer. Started as a review request
("check that regex is properly implemented in the logviewer"), then turned into
a real bug fix once the user showed that `worker.*2026` returned "no matches"
against a line that clearly contained both tokens.

## Review findings (initial)

There are three in-log search surfaces, all sharing the same regex logic:

| Surface | Location | Regex source |
|---|---|---|
| Log modal search | `web/embeds/resources.js` `buildLogSearchRegex` | canonical builder |
| Watch-frame search | `web/embeds/watch.js` → `kroLogSearch.buildRegex` | reuses canonical builder |
| Terminal-block search | `web/embeds/resources.js` `buildRx` | private copy (identical logic) |

What was already correct:
- Literal-mode escaping `/[.*+?^${}()|[\]\\]/g` → `'\\$&'` (complete special-char set).
- Three-state builder contract: `null` (empty query) / `false` (invalid regex) / RegExp.
- Global-flag iteration safe: `rx.lastIndex = 0` per node + zero-length-match guard
  (`if (m[0].length === 0) { rx.lastIndex++; continue; }`).
- Case-insensitive by default (`gi`), case toggle switches to `g`.

Intentional design points (not bugs): regex mode ignores the whole-word toggle;
matching is per-line.

## Root cause of the "no matches" bug

`highlightLogLine` (colorizer) splits each line into multiple text nodes — e.g.
plain text `[worker] ` followed by `<span class="log-time">2026-06-25 18:01:24</span>`.
The old matcher ran `rx.exec` **per text node** via a TreeWalker, so a query that
spans tokens (`worker.*2026`) never saw "worker" and "2026" in one string → no match.

## The fix

`web/embeds/resources.js`:
- Rewrote `highlightMatchesIn(root, rxOverride)`: concatenate a line's text nodes
  into one `joined` string (tracking each node's `{start, end}` offsets), run the
  regex over `joined`, collect match ranges, then rebuild each text node
  independently — wrapping the portion of every range that overlaps it in a
  `<mark class="log-match">`. Offsets are captured up front so replacing one node
  doesn't disturb the others.
- Each logical match gets a monotonic id (`matchSeq`) written to every segment as
  `data-mi`, so a match crossing spans produces multiple `<mark>`s that still count
  and navigate as one.
- Added `markGroups(marks)` helper: groups `<mark>`s by `data-mi` in DOM order,
  returning an array of segment-arrays. Exposed on `window.kroLogSearch`.
- Made all navigation group-aware (modal `navigateMatch`, term-block `navigate`):
  step by group, apply/remove `.current` on all segments of a group, scroll to the
  group's first segment, count groups not raw marks.

`web/embeds/watch.js`:
- `navigateFrameMatch` now uses `window.kroLogSearch.markGroups(...)`.
- The streaming recount in `flushFrame` counts groups:
  `frame.search.matchCount = LS.markGroups(body.querySelectorAll('mark.log-match')).length`.

Counts derived from `highlightMatchesIn`'s return value (modal `runSearch`, modal
append, frame `runFrameSearch`, term-block `run`/`onAppend`) already report logical
matches since the function returns `ranges.length`. Single-node matches behave
exactly as before (one segment → one group).

Files served directly via `go:embed` (`web/pages.go`) — no build/minify step. Both
files pass `node --check`.

## Verification

- `node --check` on both files: OK.
- App already running on `:8222`; user advised to hard-reload (Cmd+Shift+R) to pick
  up the embedded JS, since the browser caches the old copies. A second `kro` launch
  failed to bind `:8222` (address already in use) — expected, an instance was up.

## Commits / push

Working tree contained two unrelated complete changes. Per user choice, split into
two commits:

1. `22eacf1` — **Default to dark theme; light is now the opt-out**
   (`README.md`, `web/header_component.go`, `web/pages.go`, and the dark-mode hunk of
   `resources.js`). The `resources.js` hunk was staged selectively via a generated
   patch + `git apply --cached` (interactive `add -p` unavailable).
2. `178b3b1` — **Fix log search to match across colorized span boundaries**
   (`resources.js` + `watch.js`).

Push initially rejected (remote had advanced: merge of PR #3 + namespace-isolation
commit `4948904`). Rebased cleanly onto `origin/main` and pushed. The rebase pulled
upstream `watch.js` changes that the regex fix sits cleanly on top of.

Final state: `main` == `origin/main` == `178b3b1`, working tree clean.

## Notes / follow-ups

- Minor duplication remains: the terminal-block `buildRx` is logic-identical to the
  canonical `buildLogSearchRegex`. Could route it through
  `window.kroLogSearch.buildRegex` for a single source of truth — not a correctness
  issue, deferred.
- Regex matching is still per-line (can't match across `\n`); inherent to per-line
  DOM highlighting.
