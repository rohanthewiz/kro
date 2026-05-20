# Session: fix-keyboard-shortcuts-term-blocks

**Date:** 2026-05-19 19:43
**Session ID:** 39f6e0e1-f82a-4d11-ba72-074aa22098fa

## Goal

Improve terminal DevEx: when text is selected in the terminal output pane, a keyboard shortcut should splice that text into the command input at the caret (instead of the user having to retype/copy-paste pod names, etc.).

## Decision

- **Plain Enter** — unchanged, runs the command.
- **Ctrl+Enter or Cmd+Enter** with non-empty selection inside `.term-blocks` → insert that text at the caret in the command input.
- If the chord is pressed with no qualifying selection, the handler is inert (does not run the command). This avoids surprising behavior; plain Enter is still the way to run.

Rationale for separate chord vs. overloading plain Enter: less risky — no chance of accidentally swallowing an Enter the user meant for run.

## Implementation

All changes in `web/embeds/resources.js`.

1. Added two helpers near the existing term-input keydown logic:
   - `getTermBlocksSelection()` — returns the selected text only when `window.getSelection()` is non-empty and both anchor and focus nodes are contained in `termBlocks`. Returns `''` for selections in headers, sidebar, or inside the textarea itself.
   - `insertIntoTermInput(text)` — splices text at the caret, adds a leading space if the prior char is non-whitespace, refreshes the syntax highlight overlay, autosizes the textarea, and clears the document selection so a subsequent Enter just runs the command.

2. Added a document-level keydown listener `onDocTermInsertKey` registered in **capture phase**:
   ```js
   document.addEventListener('keydown', onDocTermInsertKey, true);
   ```
   It matches `Enter` with `(ctrlKey || metaKey)` and no Shift/Alt, calls `preventDefault()` + `stopPropagation()`, runs the insert, and refocuses `termInput`.

3. Left the input-bound `onTermKeydown` Enter branch as-is (plain Enter → `termRun`).

## Bug found & fixed mid-session

First pass bound the chord on `termInput` only. User reported:
- **Cmd+Enter did nothing**
- **Ctrl+Enter opened the existing custom context menu**

Root cause for Cmd+Enter: after drag-selecting text in `.term-blocks`, focus leaves the textarea, so a `termInput`-bound `keydown` listener never fires.

Root cause for Ctrl+Enter context menu: almost certainly an OS-level mapping on the user's Mac translating Ctrl+Enter into a right-click (the `contextmenu` DOM event isn't keyboard-driven by default, and our handler at `termBlocks.addEventListener('contextmenu', onTermBlockContextMenu)` only fires from real contextmenu events). Not something our code can suppress.

Fix: moved the chord handling to a document-level capture-phase listener so focus location doesn't matter, and gated everything on `getTermBlocksSelection()` returning text so the chord is inert outside the terminal use case. User confirmed both Cmd+Enter and Ctrl+Enter now work on Mac.

## Files touched

- `web/embeds/resources.js` — added helpers (`getTermBlocksSelection`, `insertIntoTermInput`, `onDocTermInsertKey`) and the document-level capture-phase listener registration inside `initTerminal`.

## Verification

User confirmed: "Now both Ctrl+Enter and Cmd+Enter work on the Mac. Thanks."

## Notes for next time

- Future configurability: user mentioned this could become a setting later. Today's behavior is hard-coded to Ctrl/Cmd+Enter.
- The pattern (drag-select moves focus → input-bound chord listeners miss the key) is worth remembering for any future keyboard shortcuts that interact with selected output text in this UI.