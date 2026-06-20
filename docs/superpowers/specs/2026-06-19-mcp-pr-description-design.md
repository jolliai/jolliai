# MCP `get_pr_description` tool — design

**Date:** 2026-06-19
**Status:** Approved (pending spec review)

## Problem

When the VS Code extension creates a GitHub PR, it embeds JolliMemory's
branch memory into the PR description: title derived from commit messages,
body built from every commit summary on the branch (trigger → decisions →
response, plans/notes links, E2E test guide), wrapped in idempotent update
markers.

When a developer instead asks Claude Code to open the PR (`gh pr create`),
none of that memory is present — Claude Code writes its own description from
the diff. The two paths produce structurally different PRs, and the
Claude-Code path loses the curated memory entirely.

There is no programmatic surface that hands the JolliMemory-rendered PR
description to an external agent. The MCP server (`jolli mcp`) exposes
`recall` / `search` / `get_decision_timeline` / `list_branches`, but `recall`
returns a structured `RecallPayload` (JSON aggregation), not the formatted PR
Markdown. Claude Code would have to reformat it itself — drifting from the
extension's output.

## Goal

Let Claude Code produce a PR whose title and description are **byte-identical
to what the VS Code extension would produce** for the same branch, via an MCP
tool, with a skill that wires the tool into a `gh pr create` flow.

Non-goals: auto-triggering on every PR (a skill prompts the flow, it is not a
hook); changing the PR Markdown format; merging the clipboard-export Markdown
builder.

## Key finding: pre-existing drift debt

The PR-building logic currently lives entirely under `vscode/src/`. The CLI
cannot import from `vscode/` (only the reverse — `vscode/` bundles
`cli/src/**` at esbuild time), so "use the same logic" requires the logic to
live in `cli/src/`.

There is already a **stale orphan** copy of `buildPrMarkdown` at
`cli/src/core/SummaryMarkdownBuilder.ts:55`. It is imported by **no one** (the
only importer of `buildPrMarkdown` is `vscode/src/views/SummaryWebviewPanel.ts`,
which imports the live version from `./SummaryPrMarkdownBuilder.js`). The
orphan has already diverged from the live VS Code version (plain `### N. title`
sections vs. `<details>` folding + wrapper-tag escaping).

The live VS Code PR logic also depends on `vscode/src/views/SummaryMarkdownBuilder.ts`
(`pushPlansAndNotesSection` / `pushRecapSection` / `pushFooter`), which is itself
a duplicate of the CLI clipboard builder.

This design treats the **live VS Code version as the source of truth**,
extracts it to the CLI, deletes the orphan, and leaves a one-source-only
invariant so the drift cannot recur.

## Architecture

### Part 1 — Extract PR logic to `cli/src/core/`

Move the live VS Code PR logic into the CLI; rewrite the VS Code call sites to
import from the CLI. Scope boundary: extract only what the PR path needs — do
**not** force-merge the entire clipboard `SummaryMarkdownBuilder`.

| Current (vscode) | Symbol | Destination (cli) |
|---|---|---|
| `views/SummaryPrMarkdownBuilder.ts` | `buildPrMarkdown` + folding/escaping/e2e file-local helpers | `cli/src/core/SummaryPrMarkdownBuilder.ts` (**replaces** the orphan in `SummaryMarkdownBuilder.ts:55`) |
| `views/SummaryPrAggregateMarkdownBuilder.ts` | `buildAggregatedPrMarkdown` | `cli/src/core/SummaryPrAggregateMarkdownBuilder.ts` |
| `views/SummaryWebviewPanel.ts:318/340` | `buildPrBodyMarkdown` + `pickPrTitle` (3-tier dispatchers) | new `cli/src/core/PrDescription.ts` |
| `views/BranchSummaryLoader.ts` | `loadBranchSummaries` | `cli/src/core/` (abstract the VS Code bridge dependency behind an interface if present) |
| `JolliMemoryBridge.ts:943` | `listBranchCommits` (merge-base..HEAD enumeration) | reuse / align with existing `cli/src/core/GitOps.ts` git helpers |
| `services/PrCommentService.ts:37` | `wrapWithMarkers` | `cli/src/core/PrDescription.ts` |

The helpers from `vscode/src/views/SummaryMarkdownBuilder.ts` that the PR
builder genuinely depends on (`pushPlansAndNotesSection`, `pushRecapSection`,
`pushFooter`) are reused from / co-located with the CLI version rather than
re-merging the whole clipboard builder.

**Cleanup:** delete the orphan `buildPrMarkdown` from
`cli/src/core/SummaryMarkdownBuilder.ts`.

**Invariant (documented):** after this change, PR Markdown has exactly one
implementation, in `cli/src/core/`. `vscode/` must not reintroduce a copy.

### Part 2 — MCP tool `get_pr_description`

Register a 5th tool in `cli/src/mcp/McpTools.ts`, dispatched via the existing
`dispatchTool(cwd, name, args)`.

**Input:**
```ts
{
  branch?: string,          // default: current branch
  baseBranch?: string,      // default: configured main (resolved via existing CLI logic)
  includeMarkers?: boolean  // default: true — mirror the extension's idempotent markers
}
```

**Flow (mirrors the extension step-for-step):**
1. `listBranchCommits(baseBranch)` → commits in `mergeBase..HEAD`, chronological (oldest-first).
2. `loadBranchSummaries(...)` → load summaries by commit hash; track `missingCount` (commits with no memory).
3. `pickPrTitle(...)` → 3-tier: ≥2 summaries → most recent commit message; 1 → that one; 0 → fallback.
4. `buildPrBodyMarkdown(...)` → ≥2 → `buildAggregatedPrMarkdown`; 1 → `buildPrMarkdown` + missing footnote.
5. If `includeMarkers`, wrap body with `wrapWithMarkers`.

**Output:**
```ts
{
  type: "pr_description",
  branch: string,
  baseBranch: string,
  title: string,        // feed to gh pr create --title
  body: string,         // feed to --body-file
  commitCount: number,
  summaryCount: number,
  missingCount: number
}
```

**Errors:** tool throws `Error` (e.g. "no summaries on branch"); `McpServer`
wraps as `{ error, isError: true }` per existing convention.

### Part 3 — Skill `jolli-pr`

A skill alongside `jolli-recall` / `jolli-search`. It instructs Claude Code to:

1. Call `mcp__jollimemory__get_pr_description` (default current branch) → `{ title, body, missingCount }`.
2. Push the branch if needed: `git push -u origin <branch>`.
3. Create the PR: write `body` to a temp file, `gh pr create --title "<title>" --body-file <tmp>` (mirrors the extension's `--body-file` approach; avoids shell-escaping issues).
4. If `missingCount > 0`, tell the user "N commit(s) without memory; a footnote was added," then continue.
5. Title comes from the tool by default; override only on explicit user request.

**Hard constraint in the skill:** title and body come from the tool. Claude
Code does **not** rewrite the memory body (otherwise it regresses to the
"Claude writes its own description" problem). Claude Code only orchestrates
push + `gh`, and adjusts the title when the user explicitly asks.

## Testing & gates

- **CLI coverage floor (97%)** applies to all moved/new code. Migrate the
  existing VS Code builder tests (`SummaryPrMarkdownBuilder.test.ts`,
  `SummaryPrAggregateMarkdownBuilder.test.ts`, `BranchSummaryLoader.test.ts`)
  into the CLI and adapt them.
- **New `get_pr_description` cases** in `cli/src/mcp/McpTools.test.ts`:
  multi-commit aggregate, single-commit, zero-summary error, `missingCount`
  footnote, `includeMarkers` on/off.
- **No VS Code regression:** after rewiring VS Code to import from the CLI,
  existing PR tests (`SummaryWebviewPanel.test.ts` and siblings) stay green.
- **Gate:** run `npm run all` once at the end (clean → build → lint → test).
  Commit with `git commit -s`; no Claude co-author trailer / footer.

## Open questions / risks

- `loadBranchSummaries` and `listBranchCommits` may carry VS Code-specific
  dependencies (the `JolliMemoryBridge`). The extraction must abstract those
  behind a CLI-friendly seam (existing `GitOps` / `SummaryStore`) without
  changing observed output. Confirm during planning.
- `baseBranch` resolution must match the extension's `resolveHistoryBaseRef`
  semantics (configured main, with `main`/`master` fallback) so the commit
  range is identical.
