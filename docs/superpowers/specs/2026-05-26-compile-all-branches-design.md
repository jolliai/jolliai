# `jolli compile --all` — bulk compile every branch with summaries

## Motivation

`jolli compile <branch>` accepts one or more explicit branch names. First-time
adopters who want to populate the compiled-knowledge layer for every branch
have to enumerate branches by hand and invoke the command repeatedly — costly
in keystrokes, error-prone, and easy to miss branches that exist only on the
orphan branch.

Add `--all` so a single invocation compiles every branch that has summaries
recorded in `index.json`.

## Surface

Two new invocations:

```
jolli compile --all              # compile every branch with summaries (sequential, per-branch progress)
jolli compile --all --merge      # compile every branch, then merge into the wiki (top-20 by mtime, same cap as existing --merge)
```

`--force` is declared on the existing command but is **not wired through to
the compile pipeline** in the current codebase. This spec does not fix that —
`--all --force` accepts the flag but has the same (no-op) behavior as the
existing `--force` on a single-branch invocation. Wiring `--force` through is
tracked separately.

Existing invocations are unchanged:

```
jolli compile <branch>           # single branch
jolli compile <b1> <b2> --merge  # explicit list + merge
jolli compile --merge            # spec-110 force-rebuild of the wiki from existing caches
```

## Rules

- `--all` and an explicit `[branches...]` argument list are **mutually
  exclusive**. Passing both is a usage error (exit 1, clear message). Reason:
  silently combining is ambiguous and the user almost certainly meant one of
  the two.
- `--all` with no branches in the catalog is **not an error** — emit a friendly
  "no branches have summaries yet" message and exit 0.
- `--all --merge` reuses the existing `MAX_MERGE_BRANCHES = 20` cap on the
  merge step. The **compile step has no cap** — every branch with summaries is
  compiled. The merge step selects the top-20 by mtime exactly like
  `runForceMerge` does today. Reason: compile is per-branch and produces a
  per-branch artifact; capping it would silently drop branches from the
  knowledge layer. Merge is a single LLM call whose prompt size scales with
  branch count; the cap is there for a real reason.

  **Update 2026-05-26 (superseded by 2026-05-26-hierarchical-wiki-merge):** the
  merge-step cap has been removed in favor of a hierarchical (two-level) merge.
  The reason cited above ("merge is a single LLM call whose prompt size scales
  with branch count") is dissolved by batching into level-1 merges of size
  `HIERARCHICAL_BATCH_SIZE` and then merging the level-1 results in a level-2
  call — no single LLM call ever sees more than one batch's worth of input. The
  compile step remains uncapped as described. See the companion spec for
  invariants.
- `--force` is currently a no-op (not consumed by `compileBranch` /
  `compileBranches`). `--all --force` accepts the flag for forward
  compatibility but does **not** change behavior in this PR.
- Sequential execution. No new concurrency. Per-branch progress is printed as
  `[i/N] <branch>: <topics> topics from <summaries> summaries`, matching the
  current explicit-list output.

## Implementation

### Files to touch

- [cli/src/commands/CompileCommand.ts](../../cli/src/commands/CompileCommand.ts)
  — add the `--all` option, add an argument-validation branch, add a
  `runCompileAll(config, cwd, opts)` helper.
- [cli/src/commands/CompileCommand.test.ts](../../cli/src/commands/CompileCommand.test.ts)
  — new file. Covers the new `--all` paths and the previously-uncovered
  legacy paths so the CompileCommand-as-a-whole crosses the 97% coverage
  threshold for new code.

### Data flow

```
jolli compile --all [--merge] [--force]
        │
        ▼
  registerCompileCommand action
        │
        ├─ validate: branches.length == 0 && --all  → runCompileAll
        ├─ validate: branches.length > 0  && --all  → usage error
        ├─ validate: branches.length == 0 && --merge && !--all
        │                                            → runForceMerge (existing)
        ├─ validate: branches.length == 0 && !--merge && !--all
        │                                            → usage error (existing)
        └─ validate: branches.length > 0            → existing per-branch path
        ▼
runCompileAll:
  1. listBranchCatalog(cwd) → BranchCatalog
  2. branches := catalog.branches.map(b => b.branch)
  3. branches.length === 0  →  friendly message, return
  4. console.log("Compiling N branch(es)...")
  5. compileBranches(branches, config, cwd)         ← reused
  6. print per-branch result lines                  ← reused format
  7. if --merge:
        selected := top-20 by mtime (listCompiledWithMtime + sort + slice)
        mergeBranches(selected, config, cwd)
        markMergeTouched(cwd)
        print merge result
```

### Why `listBranchCatalog` and not `listCompiled`

`listCompiled` returns only branches whose compiled cache already exists. The
user's request is for **first-time** compile — by definition zero or few
branches are in `listCompiled`. We need the universe of branches that have
recorded summaries, which is `listBranchCatalog`'s exact purpose. It already
filters to head-only entries (no amended/squashed ghosts) and is the same
view shown in the KB tab.

### Why no parallelism

- Sequential keeps the per-branch progress output legible.
- LLM rate-limit headroom is shared across users; serial keeps the blast
  radius of a runaway batch bounded.
- Future improvement, out of scope here.

### Why no cost-confirm prompt

- The user invoked the command explicitly with an explicit `--all` flag —
  intent is unambiguous.
- A confirmation would have to know per-branch summary counts to be useful,
  which means the same exploration cost as just running it.
- Easy follow-up if real-world usage shows it's needed.

## Testing

New `cli/src/commands/CompileCommand.test.ts` covers:

| Path | Assertion |
|------|-----------|
| `--all` with non-empty catalog | calls `compileBranches` with every branch from `listBranchCatalog`; prints `[i/N]` lines |
| `--all` with empty catalog | prints "no branches" message; exits 0; does NOT call `compileBranches` |
| `--all --merge` | calls `compileBranches` for all, then `mergeBranches` with top-20 by mtime, then `markMergeTouched` |
| `--all` + explicit branches | exits 1 with usage message; no LLM calls |
| no args, no flags | existing usage error preserved |
| explicit branches, no flags | existing single-branch path preserved (regression guard) |
| `--merge` with no branches, no `--all` | existing `runForceMerge` path preserved (regression guard) |

Mock surface (same vitest patterns used elsewhere in `cli/src/commands/*.test.ts`):
- `loadConfig` — return a stub with `apiKey: "test"`.
- `listBranchCatalog` — controlled return value per case.
- `compileBranches` / `mergeBranches` — spied; verify call args.
- `listCompiledWithMtime` — controlled return for the merge-cap test.
- `markMergeTouched` — spied.
- `setActiveStorage` / `createStorage` — no-op stubs (we don't exercise real
  storage in this test).

## Out of scope

- Parallel compile.
- Cost confirmation prompts.
- Filter flags (e.g. `--since=2026-05-01`, `--exclude main`).
- Removing the `MAX_MERGE_BRANCHES` cap or making it configurable.
- VS Code / IntelliJ UI buttons for "compile all" (CLI only here).
