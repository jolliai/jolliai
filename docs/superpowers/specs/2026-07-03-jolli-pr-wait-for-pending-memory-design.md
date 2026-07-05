# jolli-pr: wait for pending memory before building the PR — Design

**Date:** 2026-07-03
**Branch:** `jolli-pr-skill-improvement`
**Builds on:** [`2026-06-19-mcp-pr-description-design.md`](2026-06-19-mcp-pr-description-design.md), [`2026-06-20-skills-use-mcp-tools-design.md`](2026-06-20-skills-use-mcp-tools-design.md)

## Problem

When a user tells an AI agent "commit, then create a PR", the commit's memory
(summary) is generated **asynchronously** by a detached `QueueWorker` that can
take tens of seconds. If the `jolli-pr` skill fires immediately, the just-made
commits have no summary yet, so `get_pr_description` silently counts them as
`missingCount` and folds them into a "N commit(s) without summary were skipped"
footnote. The user's freshly-recorded memory is lost from the PR description.

Today the whole path (`jolli-pr` skill → `get_pr_description` →
`buildPrDescription`) is a **pure snapshot read** with no awareness of
in-progress generation. See `cli/src/core/PrDescription.ts:62` (single
`Promise.allSettled` over whatever summaries exist right now).

## Goal

Before building the PR description, the `jolli-pr` skill should **wait for
in-progress memory generation to finish**, so the newly-committed summaries are
included. Waiting must be bounded and must not block on work that will never
produce a summary.

## Decisions (confirmed with Flyer)

1. **Interaction:** auto-wait with a visible progress message. Only on timeout
   does the skill stop and ask the user.
2. **Timeout action:** on timeout the skill **stops and asks**, offering two
   choices — *keep waiting* / *create the PR now*. Never wait indefinitely.
3. **Poll surface:** a new lightweight CLI command `jolli queue-status` **and** a
   matching MCP tool `queue_status`. The skill loops the cheap probe; it does not
   re-run `get_pr_description` (which rebuilds the whole body) on each tick.
4. **Backstop:** `get_pr_description` additionally returns queue-status fields so
   a single call is self-describing even if the skill skipped the probe.
5. **Scope of "pending" = memory-summary work only.** Wiki/graph ingest entries
   and the ingest worker phase are **excluded** — the PR must not wait ~80s for
   Memory Bank wiki rendering.

## Wait semantics (correctness core)

The wait predicate is **queue-state based**, not per-commit-summary based.
Checking "does commit X have a summary?" would hang forever on commits that never
get one (merge/empty/excluded commits). The queue drains to a natural terminus;
we add a timeout only to survive a crashed worker.

Two axes must both be consulted (either alone is wrong):

- **Queue layer** — count only summary-producing entries. Queue entries carry a
  `type` field (`cli/src/Types.ts:167`): `commit | amend | squash | rebase-pick |
  rebase-squash | cherry-pick | revert` all produce or migrate a summary. The
  separate ingest entry (`type: "ingest"`, `cli/src/Types.ts:206`, detected by
  `isIngestOperation`, `:213`) renders wiki/graph and is **excluded**.
- **Worker layer** — mirror the existing `isWorkerBlockingBusy` logic
  (`vscode/src/util/LockUtils.ts:71`): `worker.lock` held **and** the
  `worker-phase` marker is *not* a fresh `ingest:wiki` / `ingest:graph` phase.
  This catches the window where the queue is already empty but the worker is
  still writing the last summary.

Resulting fields:

```
active         = # of non-stale, non-ingest queue entries          (summary work waiting)
ingestActive   = # of non-stale ingest entries                     (debug only)
workerBusy     = worker.lock held (any phase)                       (debug only)
workerBlocking = worker.lock held AND not a fresh ingest phase      (summary in flight)
drained        = active === 0 AND !workerBlocking
```

`drained` is decided by `active` and `workerBlocking` only; the other fields are
informational.

## Changes

### 1. CLI: `jolli queue-status` (new command)

New `cli/src/commands/QueueStatusCommand.ts`, registered in `cli/src/Api.ts`
alongside the other commands.

- **Snapshot:** `jolli queue-status --format json` returns immediately:
  ```json
  { "active": 2, "ingestActive": 0, "workerBusy": true, "workerBlocking": true, "drained": false, "stale": 0 }
  ```
- **Blocking:** `jolli queue-status --wait --timeout 120 --format json` polls
  in-process until `drained` or the timeout elapses, then returns the final
  snapshot plus `"waitedMs": <n>`. The wait primitive lives in the CLI so the
  skill issues one call, not a model-driven poll loop.
- A human-readable (non-`--format json`) output is provided for direct CLI use.

### 2. CLI core: queue/worker helpers

- `countActiveSummaryQueueEntries(cwd)` in `cli/src/core/SessionTracker.ts` — the
  `!isIngestOperation` filtered variant of `countActiveQueueEntries`. (Keep the
  existing unfiltered function; `doctor`/`clean` still use it.)
- Port `isWorkerBlockingBusy(cwd)` (and its `worker-phase` reader) into
  `cli/src/core/Locks.ts`. The vscode `LockUtils.ts` copy stays as-is — this is
  intentional duplication, not a refactor target; a later consolidation (vscode
  importing the bundled CLI helper) is out of scope here.

### 3. MCP: `queue_status` tool

- Schema in `cli/src/mcp/McpServer.ts` (sixth tool): optional inputs
  `{ wait?: boolean, timeoutMs?: number }`, returns the same shape as the CLI.
- Handler `runQueueStatus(cwd, args)` in `cli/src/mcp/McpTools.ts`, delegating to
  the same core helpers as the CLI command (single engine, two surfaces — the
  same parity pattern as `get_pr_description`).

### 4. `get_pr_description` backstop fields

- Extend `PrDescriptionResult` (`cli/src/core/PrDescription.ts:119`) with
  `queueActive: number` (the filtered summary count) and `workerBlocking:
  boolean`. `missingCount` semantics are unchanged.

### 5. `jolli-pr` skill template

In `buildPrSkillTemplate` (`cli/src/install/SkillInstaller.ts:494`), insert a
**Step 0: wait for pending memory** before the existing Step 1:

1. Probe once — `queue_status` (MCP host) or `run-cli queue-status --format json`
   (CLI fallback).
2. `drained` → proceed to Step 1.
3. Not drained → show "N memory summaries still generating, waiting…", then call
   the blocking form (`queue_status {wait:true, timeoutMs:120000}` /
   `queue-status --wait --timeout 120`).
4. Returns `drained:true` → Step 1. Returns `drained:false` (timeout) → **stop and
   ask the user**: *keep waiting* / *create the PR now*.
5. Steps 1–4 unchanged; commits still missing a summary after drain fall through
   to the existing `missingCount` footnote.

Skill changes ship via the `SKILLS` registry in `SkillInstaller.ts`; the
`SKILL_VERSION` frontmatter bumps automatically with the package version.

## Testing

- `QueueStatusCommand`: snapshot, blocking-until-drained, timeout-returns-not-drained,
  ingest entries excluded from `active`, ingest phase → `workerBlocking:false`,
  `--format json` shape.
- `runQueueStatus` MCP handler: parity with the CLI shape; `wait`/`timeoutMs`
  honored.
- `countActiveSummaryQueueEntries`: ingest entries excluded, stale entries
  excluded, mixed queue counted correctly.
- `isWorkerBlockingBusy` (CLI port): fresh ingest phase exempt, stale ingest
  phase treated as blocking (fail-safe), missing marker → blocking.
- `buildPrDescription`: new `queueActive` / `workerBlocking` fields populated.
- Coverage must stay at/above the CLI floor (97% statements / 96% branches /
  97% functions / 97% lines — `cli/vite.config.ts`).
- `npm run all` once at the end (clean → build → lint → test). No per-task commits.

## Out of scope

- Q2 — pushing memory to Jolli and selecting a JM memory space from a CLI/MCP
  surface. Separate feature, separate spec (needs backend wire alignment).
- Consolidating the vscode `LockUtils` copy onto the new CLI helper.
- Changing `missingCount` footnote behavior or any Step 1–4 logic beyond the new
  backstop fields.
- IntelliJ parity for the new command/tool.

## Default-branch / base note

`get_pr_description` and `jolli-pr` are unchanged in how they resolve the base
branch (`origin/HEAD`, `baseBranch` override); this feature only inserts a wait
gate before the existing description build.
