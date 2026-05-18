# Terminal State Management Refactor

**Date:** 2026-05-18 16:42
**Session:** terminal-state-management-refactor

## Goal

Make the dashboard's kubectl terminal maintain its own state per namespace, and add a buffer cap so a single noisy command can't grow unbounded.

## Context

The kubectl terminal lives in `web/embeds/resources.js` as a small panel above the resource sections. Before this session, all of its state was global to the page:

- `termBlocks` — single DOM container holding every command's output block.
- `termRunning`, `termSource`, `termActiveBlock` — global "one command at a time" plumbing.
- `termHistory` — kubectl command history, persisted in `localStorage`.

Switching context/namespace updated the `term-target` label (e.g. `ctx-a / ns-foo`) but left every prior block visible in the DOM, regardless of which namespace produced them. There was also no upper bound on per-block output, so a long `kubectl logs -f` could accumulate indefinitely.

User asked for two things in succession:
1. "On the dashboard, each namespace should maintain its own terminal state."
2. "Perhaps we should put some kind of limit on each terminal's total output buffer."

## Design decisions

- **Per-namespace state via detached DOM nodes, not innerHTML.** Blocks own JS state — WeakMap-keyed search controllers (`blockSearchByEl`), `MutationObserver` for manual resize, persisted inline styles for font size/height, and fold class state. `innerHTML` save/restore would lose all of that. Keeping blocks as detached DOM lets them round-trip cleanly.
- **Memory only, not localStorage.** Block contents can be large; persisting across reloads would mean serializing HTML or rebuilding from a structured log. Keeping in-memory matches the existing behavior where a refresh clears the visible terminal.
- **Cancel running commands on switch** rather than letting them keep streaming into a detached block. The alternative (let it keep running, reattach on return) means the SSE writes to a node that's not in the document — harmless but invisible. Cleaner UX: leave a "canceled" pill on the origin block, free the global `termRunning` slot for the new namespace.
- **Cap is per-namespace, not per-block.** User phrased it as "each terminal's total output buffer", and a terminal is now a per-namespace surface. Trim oldest spans (one per line) from the front; sweep empty non-active blocks afterward so the scrollback isn't left with empty headers piling up.
- **Cap value: 5000 lines.** A comfortable scrollback without being heavy. Tunable via the `TERM_MAX_OUTPUT_LINES` constant.

## Implementation

All changes in `web/embeds/resources.js`.

### New state

```js
var termStateByKey = {};   // "ctx::ns" → { blocks: [DOM Element] }
var termCurrentKey = null;
var TERM_MAX_OUTPUT_LINES = 5000;
```

### `termKey()` and `termSwitchTo(newKey)`

`updateTermTarget` was the existing single entry point for "the target changed" — both `selectAndReload` and `onContextChange` flow through it. Hooking the swap there means the switch happens exactly when `currentCtx`/`currentNs` settle.

`termSwitchTo`:
1. Returns early if the key is unchanged.
2. Calls `window.termCancel()` if a command is running — that marks the active block "canceled" while it's still in the visible DOM, so the indicator is captured in the saved state.
3. Walks `termBlocks`' children, detaches each non-empty-state node into a `saved[]` array, parks it under the previous key.
4. Looks up the new key. If it has blocks, re-appends them and scrolls to bottom. Otherwise restores the "kubectl output appears here…" placeholder.

### `termTrimToLimit()`

Called from `termAppendOutput` after every span append. Two-pass:
1. Count total `.term-block-out > span` nodes. If over the cap, drop oldest-first.
2. If any spans were dropped, sweep `.term-block` children: any block that is neither the active block nor the last block, and whose output container is now empty, gets removed entirely.

Keeping the last block protects the "headers-only command I just ran" case where the command produces no output (e.g. `kubectl delete pod foo` returning instantly).

## Files touched

- `web/embeds/resources.js` — added per-namespace state vars, `termKey`, `termSwitchTo`, `termTrimToLimit`; one-line hook from `termAppendOutput` and from `updateTermTarget`.

## Verification

- `go build ./...` — clean.
- `node -c web/embeds/resources.js` — JS syntax OK.

Not exercised in a browser this session — UI smoke test left to the user.

## Open follow-ups

- If users want concurrent commands across namespaces (run `logs -f` in ns-a, switch to ns-b and run `get pods` without canceling), the global `termRunning`/`termSource`/`termActiveBlock` triple needs to move into `termStateByKey` too. Out of scope for this pass.
- Cap value (5000) is a guess. Could be made user-configurable, or split into per-block + per-namespace caps if a single noisy command starves older ones.
- Command history (`termHistory` in localStorage) stayed global — kubectl invocations are namespace-agnostic and the `--context`/`--namespace` come from the cookie, so a single shared history seems right. Worth revisiting if a user wants per-namespace history.