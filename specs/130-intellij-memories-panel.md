# IntelliJ Memories Panel (Retired)

## Topic Statement

This topic previously described a standalone MEMORIES section of the IntelliJ side panel — a flat, paginated list of every commit memory across all branches, with an out-of-panel search dialog, "Load More" pagination, a copy-the-recall-prompt action, and three empty/initializing/disabled states. That standalone panel is no longer wired into the tool window. The side panel's memory list is now the **COMMITTED MEMORIES** section, which is the branch-scoped commits panel owned by a separate spec.

## Scope

**In scope:**
- Recording that the standalone all-branches MEMORIES panel — and its distinctive behaviors (flat all-branch list, modal search dialog driving an external filter, "Load More" page-size pagination against a `MAX_SEARCH_ENTRIES` ceiling, recall-prompt-to-clipboard with a confirmation popup, the initializing / disabled / empty tri-state) — has been removed from the live tool window.
- The supersession relationship: the live memory list is the COMMITTED MEMORIES section, scoped to the current branch (or a foreign branch in read-only mode), not a flat all-branches list.

**Out of scope:**
- The COMMITTED MEMORIES section's actual behavior (token meter, SHIPPED / CONVERSATIONS / CONTEXT / FILES evidence groups, per-commit expand, hover actions, recall-prompt copy, foreign-memory read-only mode, empty states) — owned by the IntelliJ Commits Panel spec.
- The tool-window frame that stacks the COMMITTED MEMORIES section and shows / hides it — owned by the IntelliJ tool-window layout spec.
- The orphan-branch index format and reader.

## Data Contracts

There is no live data contract for this topic. The class that implemented the old panel still exists in the source tree but is unreferenced — it is not constructed by the tool-window factory, not held in the panel registry, and has no action group in the plugin manifest. The `listMemoryEntries(count, filter?)` service method it consumed still exists but has no live caller from the UI.

## Behavior

### Current reality

The tool window builds three top-level collapsible sections (PINNED, WORKING MEMORY, COMMITTED MEMORIES). The COMMITTED MEMORIES section is the commits panel: it walks the current branch back to its merge-base with `main` and renders one expandable card per commit, with a branch-level token meter above the list. There is no flat all-branches memory list, no "Load More" row, no modal search/clear-filter action pair, and no separate "Initializing / Disabled / Empty" tri-state owned by this topic.

### Retired behaviors

The following behaviors that this topic used to describe are **no longer present** in the live UI:

- The flat, all-branches list of root memory entries.
- The out-of-panel "Search" / "Clear Filter" actions opening a modal input dialog and calling `setFilter` / `getFilter` back into the panel.
- The live filter re-fetching against a `MAX_SEARCH_ENTRIES` upper bound (vs the `PAGE_SIZE` pagination window).
- The "Load More" pseudo-row appended when more entries exist and no filter is active.
- The panel-owned initializing / disabled / empty tri-state, including the disabled-mode marketing pitch and "Enable Jolli Memory" button.
- The single-click-opens-summary / copy-icon-copies-recall-prompt row layout specific to that flat list.

The recall-prompt-copy concept survives, but in the COMMITTED MEMORIES section as a per-row hover action (owned by the commits panel spec), not as a per-row copy icon on a flat list.

### An added-but-unreachable placeholder

The dead class has since gained a third placeholder branch alongside its initializing and empty states: a "not enabled" placeholder carrying the same two-line copy the live panels use — "Jolli Memory is not enabled for this repository." followed by "Open the Status panel to install hooks and enable it." It is recorded here only for completeness. **It is unreachable**: the class has no construction site, so nothing can render it. The equivalent branch in the live commits panel and the live plans panel *is* reachable and is specified there.

## State Transitions

None. This topic has no live UI surface.

## Notable Behavior

- **The standalone MEMORIES panel was superseded, not merely renamed.** The live COMMITTED MEMORIES section is branch-scoped (current branch, or a foreign branch read-only), whereas the retired panel was a flat list across every branch.
- **The implementing class is dead code.** It is present in the source tree but has no construction site, no registry entry, and no manifest action group; its search / pagination / recall-copy logic is unreachable from the running product.
- **The dead class is still being maintained.** It picked up the same "not enabled for this repository" placeholder the live panels gained, which means edits aimed at the live surfaces are being applied here too. Nothing renders it, so those edits have no user-visible effect — but they are a signal that the class has not been recognized as dead by everyone touching it.

## Shared Behavior

- **IntelliJ Commits Panel spec** — owns the live COMMITTED MEMORIES section that replaced this panel.
- **IntelliJ tool-window layout spec** — owns the section stacking, the live row-count suffix, and the show/hide of the COMMITTED MEMORIES section.
