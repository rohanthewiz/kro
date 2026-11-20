# Session: Pod Watch row count as approximate entries; fix the row count that never ticked (N-007)

Session ID: `a0c06034-6d24-41dd-a470-40938cc0c5ab`

## Summary

The user picked next-list item N-007: the per-row main count in Pod Watch
("N lines") was still literal lines while the Errors/Warnings view counts
had become approximate entries in
`2026-0720-1553-podwatch-whole-list-cap-and-approx-entry-counts`. Rows now
read **`~N entries · Ns ago`**, with the exact line count in the tooltip.

While checking it in a browser, a bug older than N-007 turned up: the row
count had **never ticked live**. It only changed when a full status re-render
happened (stream added / state change). Fixed in the same change.

## Design: what counts as an entry

`startsEntry(cls, body)` in `podwatch/classify.go`, in order:

| line | result |
|------|--------|
| has a level (`classifyLine` ≠ `""`), even if indented | new entry |
| blank, or starts with a space or tab | continuation |
| starts with `Caused by:` or `Traceback (most recent call last):` | continuation |
| anything else (plain unleveled output) | new entry |

- Leveled lines always count, so every Errors/Warnings entry start is also a
  main entry start: `entries ≥ errEntries + warnEntries`.
- **Deliberate difference from the error/warning counters:** those inherit
  through an error run (`routeLocked`'s `lastRoute`), so unleveled lines
  after an `ERROR` belong to that error. The main count does not inherit.
  Inheriting would freeze it for apps that only level their errors: after
  one `ERROR`, every later plain line would be a "continuation" until an
  INFO line arrived. The cost: unindented unleveled lines inside a crash
  (Go's `goroutine 1 [running]:`, Python's final `ValueError: …`) count as
  extra main entries. Offered to the user as a small change if they prefer
  inheritance; no answer yet.
- Indentation is judged on the container's untagged line. `consumeLine`
  prefixes `[container] ` for multi-container pods, which would hide it.
- Zero shows as `0 entries` without the `~` (it is exact), matching the
  dropdown, which shows plain "Errors" at zero.

## Changes

- `podwatch/classify.go`: `startsEntry` and `unindentedContinuations`, with
  the rule table and the no-inherit rationale in comments.
- `podwatch/manager.go`: `Stream.EntryCount atomic.Int64`;
  `StreamStatus.Entries` (`json:"entries"`); `runCountsTicker`'s
  `stream_counts` items carry `entries`.
- `podwatch/stream.go`
  - `consumeLine` calls the new `writeLineBody(line, ln.Line)` so the
    untagged body reaches `startsEntry`. `writeLine(line)` stays as a
    wrapper (`writeLineBody(line, line)`); the tests use it.
  - `writeLineBody` bumps `EntryCount` next to `LineCount`, not in
    `emitLocked`, so lifecycle markers (also emitted through `emitLocked`)
    stay out of both counts.
  - `emitLocked` runs `classifyLine` once and returns the class, so the
    level regexes don't run twice per line on the hot path. `routeLocked`
    now takes that class (`cls`) instead of the line.
  - `status()` fills `Entries`.
- `web/embeds/watch.js`
  - `countText(c)` / `countTitle(c)` helpers (next to `agoText`), used by
    both `renderStatus` and `patchCounts`, so the full render and the live
    patch can't drift. Singular/plural handled ("1 entry", "1 line").
  - **Live-tick fix:** the row span had `data-count-for="<frameKey>"`.
    `frameKey` joins ctx/ns/pod with U+0000, which the HTML parser stores
    as U+FFFD inside an attribute value, so `patchCounts`'
    `getAttribute('data-count-for') === key` never matched. Confirmed in
    WebKit: the attribute read back with two 65533 code points. The span now
    keeps `data-count-for` as a marker and carries the same
    `data-ctx`/`data-ns`/`data-pod` trio as the row buttons; `patchCounts`
    compares field by field. Safe for clicks: the list's delegate is
    `closest('button[data-act]')`. This bug dates from the commit that added
    Pod Watch (`b485057`); it was the only place a `frameKey` value went into
    a DOM attribute.
- `podwatch/podwatch_test.go`
  - `TestStartsEntry`: table of leveled, indented-but-leveled, plain, `{`,
    Java/Node frames, pretty JSON field, blank, `Caused by:`, `Traceback`.
  - `TestEntryCount`: end to end through `writeLine`/`writeLineBody`:
    continuations fold, a tagged body's indentation is seen, a marker counts
    as neither a line nor an entry, a plain line inside an error run counts
    as a main entry. Lines 8, entries 4, and `status()` agrees.
    (A first draft also asserted `ErrCount`, but `writeIssueLocked` only
    ticks once a companion file exists, and this bare stream has no
    `errPath`. The companion test already covers `ErrCount`.)
- `ai_docs/todo/next-list.md`: N-007 → Closed; N-047 raised under Validate;
  Next ID → N-048.

## Verification

- `go build ./...`, `go vet ./podwatch/ ./web/`, `gofmt -l` clean,
  `go test ./...` green. The only lint noise is the existing `rangeint`
  hints in `podwatch_test.go`.
- **Headless WebKit against a fake kube API** (Playwright from the npx cache;
  see the memory note on this). The fake from the 2026-11-18 session was
  copied to this session's scratchpad and extended with what Pod Watch needs:
  pod `?watch=true` (ADDED events pushed by `/_ctl/addpod`), single-pod GET
  (two containers, `app` and `side`, both running), and
  `pods/<name>/log?follow=true` (a 7-line canned body with RFC3339Nano
  stamps, 4 entries, then lines pushed by `/_ctl/log`). kro ran on 8335 with
  `KRO_STATE_FILE`/`KRO_WATCH_LOG_DIR` in scratch; the fake ran on 8336.
  - Before the JS fix: the row first read `~8 entries` with "14 lines
    captured" in the tooltip, which is right. After two more lines per
    container the status API said 18 lines / 10 entries, but the row stayed
    at `~8`, and its "0s ago" never aged. That led to the U+FFFD finding.
  - After the fix: `~8 entries · 2s ago` (the ticker patched it), then
    `~10 entries` / "18 lines captured" from the 2s `stream_counts` alone.
    The screenshot shows the row laid out normally.
  - Both scratch servers were stopped by their own PIDs afterwards.
- Not checked: KRo.app (WKWebView). It needs a `mac-install.sh` rebuild;
  recorded as N-047.

## Next

Closed: N-007. Declined: None. Raised: N-047. Deferred: None.
Promoted: None. Moved: None. Updated: None.
Full list: `ai_docs/todo/next-list.md`.
