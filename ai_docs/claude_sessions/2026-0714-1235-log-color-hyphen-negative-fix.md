# Session: Fix log colorizer treating hash/UUID hyphen segments as negatives

Session ID: 14140c48-e2ad-4a36-bd95-31202400a681
Date: 2026-07-14 12:35

## Problem

In the log colorizer (affects all logs, notably pod-watch console frames),
numbers preceded by an alphanumeric-then-hyphen were being colored orange as
"negative numbers". Example: a UUID/hash like

    work-3d4f6132-5c29-4700-8fc8-692b766d3d77

rendered the `-4700` segment in the negative (orange) color, because the
number-matching regex `-?\b\d+` greedily consumed the preceding hyphen as a
minus sign.

## Root cause

`web/embeds/resources.js` — the log colorizer number alternative:

    '-?\\b\\d+(?:\\.\\d+)?\\b'

The optional `-?` consumed any preceding `-`, even when that hyphen was just a
separator between alphanumeric groups in a hash/UUID. This appeared in two
passes:
- the main `highlightLogLine` regex
- the `highlightInner` regex (used for quoted / `msg=` values and JSON string
  values)

## Fix

Prepended a negative lookbehind so the sign (and the digits) are only treated
as a number when NOT preceded by a word char or hyphen:

    '(?<![\\w-])-?\\b\\d+(?:\\.\\d+)?\\b'

Effect:
- `work-3d4f6132-5c29-4700-8fc8-...` → left untouched (not a number at all;
  hyphen-joined tokens read as identifiers)
- `temp=-5`, `-3.14` → still negative (hyphen preceded by `=` / space)
- `count=42`, `port 8080` → still positive

Applied to both the `highlightLogLine` regex and the `highlightInner` regex.

Lookbehind is well-supported in all current browsers (Chrome 62+, Firefox 78+,
Safari 16.4+), and this UI is browser-served.

## Verification

- Node test of the two number/bool alternatives confirmed the UUID is no longer
  colored while genuine negatives/positives still classify correctly.
- `go build ./...` passes (`resources.js` is `go:embed`-ed, so a rebuild picks
  up the change; no codegen step).

## Files changed

- `web/embeds/resources.js` — two regex edits (main pass + inner pass)
