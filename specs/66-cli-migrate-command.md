# 66. `jolli migrate` — Migrate stored summaries to the v3 format

## Topic Statement

The `jolli migrate` command upgrades a project's stored summaries from the legacy v1 format to the current v3 tree format in two phases — first rebuilding the per-summary tree data, then upgrading the index — while keeping the legacy data on a separate branch for 48 hours as a safety net before a separate cleanup probe deletes it.

## Scope

This spec covers the user-facing behavior of `jolli migrate`: invocation form, the two-phase sequence, what is reported per phase, idempotency on already-migrated projects, the 48-hour legacy-retention window, and exit codes. It does not cover the in-format mapping rules between v1 and v3 (separate spec), the orphan-branch storage layout (separate spec), or the separate cleanup probe that deletes legacy data after 48 hours (separate spec).

**Not to be confused with `jolli migrate-memory-bank`.** A second, hidden command shares the "migrate" verb but touches a disjoint subsystem: it copies the orphan-branch store into the on-disk Memory Bank folder. `jolli migrate` upgrades the *format* of what is stored on the orphan branch and never writes to the Memory Bank folder; `migrate-memory-bank` changes no format and never rewrites the orphan branch. They share no data, no marker, and no report; neither is a phase, split, or rename of the other. See the Memory Bank migration bridge spec.

## Data Contracts (output)

The command writes a free-form, multi-line, human-readable report to stdout. It is not designed to be machine-parsed. Errors are written to stderr.

The report is structured as two labeled phases, each followed by per-phase counts and a status line.

## Behavior

### Invocation form

- `jolli migrate` — run the migration against the current project.
- `jolli migrate --cwd <dir>` — operate against `<dir>` instead of the auto-resolved git repository root. Default value is the resolved project directory.

There is no `--dry-run` flag; the command always commits its changes (Phase 1 writes a single migration commit on the v3 storage branch; Phase 2 writes a single index-upgrade commit). The migration is itself idempotent (see below) so the safe equivalent of a dry run is to inspect the report from a real run that has nothing to do.

### Two-phase sequence

The command always runs Phase 1 then Phase 2, in that order, in a single invocation. Each phase prints a labeled header before its work begins.

#### Phase 1 — Per-summary tree migration

Phase 1 converts every legacy v1 summary file into the v3 tree format and writes the converted set, plus a freshly rebuilt index, in a single commit on the v3 storage branch. The legacy v1 storage branch is **not deleted** by this phase.

The phase prints:

- `Step 1: Migrating orphan branch to v3 tree format...` (skipped header text if the phase short-circuits, see below).
- A `Migrated: <n> summaries converted to tree format` line if any summary was converted.
- A `Skipped:  <n> summaries (already in tree format or unparseable)` line if any summary was skipped.
- `No summaries found in v1 branch.` if neither count is non-zero (i.e. the legacy branch has no summary files).
- A final `V1 branch retained for 48 hours as a safety net.` line whenever the phase actually did work.

When Phase 1 has already completed in a prior run (detected by a migration-completion marker in the v3 storage), the entire phase is skipped and the report instead prints:

```
Orphan branch migration already completed. V1 branch retained for 48h as a safety net.
```

#### Phase 2 — Index format upgrade

Phase 2 converts the index file from the v1 layout (one entry per top-level summary) to the v3 flat layout (one entry per node in every summary tree, with parent-pointer fields). Phase 2 always runs, even when Phase 1 was skipped, because the index upgrade is independent of the per-summary file conversion.

The phase prints:

- `Step 2: Migrating index to v3 flat format...`
- `Index is already in v3 flat format.` if the index version marker is already at v3.
- Otherwise a `Migrated: <n> index entries upgraded to v3 flat format` line if any entry was migrated, and a `Skipped:  <n> entries (summary file missing or unparseable)` line for any entry whose underlying summary could not be loaded.
- `No index entries found.` if the index exists but is empty.

### Idempotency

The command is fully idempotent:

- Re-running after Phase 1 has already completed short-circuits Phase 1 (no double-conversion, no overwrite of v3 data) and only runs Phase 2 — which itself short-circuits if the index is already at v3.
- Per-summary files that are already in v3 tree format are detected as such and copied through as-is into the migration commit; they are counted as `Skipped` (with the skip reason "already in tree format"), not migrated.
- An unparseable per-summary file is also skipped (counted under the same `Skipped` line) and does not abort the phase. Such an entry is excluded from the rebuilt index so the index never carries dangling references.

### 48-hour legacy retention

After Phase 1 commits the v3 conversion, the legacy v1 branch is retained on disk for 48 hours. Phase 1 records the migration timestamp on the v3 branch as a marker file; that marker is what the separate cleanup probe checks before deleting the v1 branch.

During the 48-hour window:

- The `jolli migrate` command will not re-run Phase 1 (it short-circuits on the marker).
- The user can inspect the legacy v1 branch directly to compare against the v3 conversion.
- The legacy v1 branch is still readable; it is simply no longer the source of truth.

After the 48-hour window, the separate cleanup probe (covered by its own spec) deletes the legacy branch reference. The `jolli migrate` command itself never deletes the legacy branch.

### Per-summary failure handling

Phase 1 processes each legacy summary file in isolation. A read failure or parse failure on a single file is logged as a warning, the file is counted under `Skipped`, and the phase continues with the next file. Phase 1 only commits if at least one file was either migrated or skipped — empty legacy branches produce no commit.

Phase 2 processes each index entry in isolation. If the underlying per-summary file cannot be loaded, the entry is counted under `Skipped` and excluded from the new flat index. Phase 2 always commits a new index when at least one entry was migrated; it does not commit if there were no entries to process.

## Exit Codes

| Code | Condition |
|------|-----------|
| `0`  | The command ran to completion. This includes the all-success case, the no-op case (already migrated), and the partial-failure case where some entries were skipped due to unparseable input. |

The command does not currently set a non-zero exit code for partial-failure scenarios; the `Skipped` count in the report is the signal that some entries were not migrated. A hard internal failure (for example a git-write failure) propagates as an uncaught error.

## Notable Behavior

- **Two phases in one command.** Even though Phase 1 and Phase 2 are conceptually independent (per-summary file format vs. index file format), they always run in the same invocation. The user does not need to remember a phase ordering.
- **Phase 1 short-circuit is by marker, not by branch presence.** Even if the legacy v1 branch still exists (because the 48-hour window has not elapsed), Phase 1 detects the prior completion via the v3-branch marker and skips. This prevents duplicate conversion when the user re-runs `jolli migrate` during the retention window.
- **Phase 2 is independent of Phase 1.** A project that was created on the v3 per-summary format but has an old-format index will run Phase 1 as a no-op (legacy branch absent or contains no summary files) and Phase 2 as the actual migration.
- **The 48-hour safety net is data, not flag.** The user does not need to pass any flag to enable retention — Phase 1 always records the marker and the legacy branch always survives for the window.
- **No LLM calls.** The migration is a pure data transformation between two file formats. It never makes a network request.
- **Single commit per phase.** Phase 1 writes one commit on the v3 storage branch containing the converted summaries plus the rebuilt index. Phase 2 writes a separate single commit containing the upgraded index. Neither phase produces incremental commits per file.

## Shared Behavior

- The `--cwd <dir>` flag is shared with most other `jolli` sub-commands. When omitted, the project directory is auto-resolved to the enclosing git repository root.
- All Jolli sub-commands set up the per-project log directory under `<cwd>/.jolli/jollimemory/` before doing any work; messages logged by `migrate` land there in addition to whatever is printed to the terminal.
- The legacy-branch retention window is honored by a separate cleanup probe; that probe is covered by its own spec.
- The v3 tree format and the v3 index flat format are covered by the storage and indexing topics.
