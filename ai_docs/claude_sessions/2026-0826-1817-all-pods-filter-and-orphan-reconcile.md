# Session: All Pods filter box + All Pods / orphan reconciliation

Session ID: c6f5ecdf-b33c-4d2a-8542-069d7a867082
Date: 2026-08-26 18:17

Two requests, back to back:

1. "I need a search box for the All Pods listing" (with a screenshot of the
   Pods tab).
2. "Let's reconcile All Pods vs Pods (orphan). Note that the Deployments tab
   only shows All Pods."

Everything lives in the `go:embed`ed `web/embeds/*` assets, so seeing it in
KRo.app needs a rebuild + re-run of `mac-install.sh`. (`mac-install.sh` does
`git reset --hard origin/main` on `~/.kro`, so commit + push before rebuilding
or the edits are discarded.)

## Part 1 — the filter box (commit `1fa2cd7`, pushed)

A filter input above the All Pods table, hiding non-matching rows client-side.

Key decision: **filter text is module state, not DOM state.** "All Pods"
renders in two tabs, and `rebuildTables()` replaces every section's innerHTML
on each refresh / SSE push. Storing the query in the input alone would drop it
on the next background refresh, so the query lives in JS and is re-applied at
the end of `rebuildTables()`.

- `podFilterBar()` renders the input (⌕ glyph, placeholder, clear ×).
- `applyPodFilter()` hides rows, mirrors the query into sibling inputs
  *without* clobbering the caret of the one being typed in, reveals a hidden
  "no matches" row, and swaps the section header count to `matched / total`.
- Esc clears + blurs; × clears.
- The bar sits inside the section but *outside* `.table-wrapper`, so
  `.resource-section.collapsed .table-wrapper { display: none }` doesn't cover
  it — resources.css needed an explicit collapsed rule for `.pod-filter-bar`.

## Part 2 — reconciliation (uncommitted at time of writing)

### What was actually wrong

Read the code before proposing anything:

- `buildAllPods()` already folded `orphan_pods` into All Pods, so on the
  workloads tab **every orphan was listed twice** — once in All Pods, once in
  "Pods (orphan)".
- Server-side (`kube/resources.go:191`) "orphan" just means *no owner ref among
  Jobs / ReplicaSets / StatefulSets / DaemonSets* — usually bare pods.
- The deployments tab rendered the same global All Pods list, so it showed
  Job / STS / DS / orphan pods that have nothing to do with deployments.

Two independent product calls, so both were put to the user. Answers:
**merge orphans into All Pods with an Owner column**, and **scope the
deployments tab to deployment-owned pods**.

### Shape

```
  tree ──┬─ buildAllPods(tree)        → [{pod, owner}]  → 'all-pods'
         └─ buildDeploymentPods(tree) → [{pod, owner}]  → 'deployment-pods'
                     │
                     └──→ podListSection(slug, title, entries, emptyText)
                            = podFilterBar(slug)
                            + table( tableHead(true) + parentRow(…, owner) )
                            + hidden .pod-filter-empty row
```

- Entries are `{pod, owner}` rather than bare pods: the owning controller is
  only knowable while walking *down* the tree. Owner strings: `job/x`, `rs/x`,
  `sts/x`, `ds/x`, `deploy/x` (deployment child that came back as a bare Pod
  because the RS couldn't be resolved), and `''` for orphans → rendered `—`.
- `tableHead(withOwner)` and `parentRow(parentId, res, hasChildren, owner)`
  gained *optional* owner support. The hierarchical tables (jobs, deployments,
  sts, ds) call them with the old arity, `owner === undefined` → no cell, so
  those tables are untouched.
- `TAB_CONFIG`: workloads `['jobs', 'all-pods']`, deployments
  `['deployments', 'deployment-pods']`.
- `pods-orphan` is **no longer mounted on any tab** but the builder was kept in
  `SECTION_BUILDERS` with a comment saying how to remount it — per the standing
  "don't remove existing code unless absolutely sure" rule.
- Filter state generalized from one variable to `podFilters` keyed by section
  slug (`POD_FILTER_SLUGS = ['all-pods', 'deployment-pods']`), so the two
  listings filter independently.
- Matching now covers **name and owner**, which is what makes `rs/landing-api`
  a useful query and keeps orphans findable now that they share one table.

### Files

| File | Change |
|---|---|
| `web/embeds/resources.js` | filter machinery, `buildAllPods` → `{pod, owner}`, `buildDeploymentPods`, `podListSection`, owner-aware `tableHead`/`parentRow`, TAB_CONFIG |
| `web/embeds/resources.css` | `.pod-filter-bar` + friends (light/dark), collapsed rule, `.resource-owner` / `.resource-owner.orphan` |
| `web/pages.go` | panel-composition doc comment updated for both tabs |

Verified with `node --check web/embeds/resources.js` and `go build ./...`.
Not verified in a live cluster.

## Follow-ups

- Rebuild via `mac-install.sh` and eyeball both tabs against a real cluster.
- The old `kro_collapsed_pods-orphan` localStorage key is now inert; harmless,
  but a cleanup pass could drop it.
- Possible: a keyboard shortcut to focus the filter box (`/` is the obvious
  one) — not requested, not done.
