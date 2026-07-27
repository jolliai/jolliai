# 61. `jolli clean` — Remove stale state

## Topic Statement

The `jolli clean` command removes stale sessions, stale git-operation queue entries, and stale squash-pending state files, based on per-category age thresholds.

## Scope

This spec covers the user-facing behavior of `jolli clean`: which categories of data it considers, the age thresholds, the dry-run and confirmation modes, the report format, the exit code policy, and what is intentionally **not** deleted. Health diagnostics and repairs (handled by `jolli doctor`) are explicitly out of scope.

The boundary between `clean` and `doctor` is rigid:

- `clean` removes **redundant data** — entries that have aged past their retention window. Their presence wastes disk but never breaks Jolli Memory.
- `doctor` reports and repairs **faults** — conditions that impair functionality.

The two commands have no overlapping checks. A single fix is performed by exactly one of them.

## Data Contracts (output)

A multi-line report written to stdout. Lines are aligned with two-space leading indentation.

1. Header `Jolli Memory Clean` and a horizontal-rule separator.
2. Three count rows, always printed:
   - `Stale sessions:       <n> entries`
   - `Stale Git queue:      <n> entries`
   - `Stale squash-pending: <1 file | none>`
3. Conclusion (one of):
   - `Nothing to clean — all data is current.` when every category was zero.
   - `[dry-run] Would remove <n> item[s].` when `--dry-run` was passed and there was something to remove.
   - A confirmation prompt followed by either `Removed <n> item[s].` (after `y`/`yes`) or `Aborted. Nothing was removed.` (after any other input, including empty).

Errors are written to stderr.

## Behavior

### Invocation forms

- `jolli clean` — print the counts; if there is anything to remove and stdin is a TTY, prompt to confirm before deleting.
- `jolli clean --dry-run` — print the counts and what would be removed; never delete anything.
- `jolli clean --yes` (alias `-y`) — print the counts and delete without prompting. Required for non-interactive use.
- `jolli clean --cwd <dir>` — operate against `<dir>` instead of the auto-resolved git repository root.

### Categories and thresholds

The command considers exactly three categories. An entry is "stale" once its age exceeds the per-category threshold:

| Category | Threshold | What it is |
|----------|-----------|------------|
| Sessions | 48 hours | Entries in the per-project session registry whose last update is older than 48h. Pruning a session also removes its associated transcript cursor. |
| Git operation queue | 7 days | Files in the queue worker's per-operation queue that have not been processed and are older than 7 days. Corrupt queue entries (unparseable) are also counted as stale and removed. |
| Squash-pending marker | 48 hours | The single squash-pending state file the queue worker writes during a squash sequence. Counted as `1 file` or `none`; corrupt files count as stale. |

The total reported in conclusion lines is the arithmetic sum across all three categories.

### Dry-run mode

When `--dry-run` is supplied, the counts are computed and printed but no deletions occur. The conclusion line shows the number of items that *would* be removed. Both stale-counting and the deletion functions use the same age thresholds, so the dry-run total matches the would-actually-delete total exactly.

### Confirmation gate

When `--yes` is **not** passed and there is at least one stale item to remove:

- If stdin is a TTY, the command prints two reassuring lines explaining the data is expired and safe to remove, then prompts `Proceed to remove <n> item[s]? [y/N]:`. Only `y` or `yes` (case-insensitive, trimmed) proceeds; any other input — including empty input — aborts with `Aborted. Nothing was removed.` and exit `0`.
- If stdin is **not** a TTY, the command refuses to proceed: it prints `Refusing to delete in non-interactive mode. Pass --yes to confirm, or --dry-run to preview.` to stderr and exits with code `1`. This preserves a hard safety contract for CI, redirected stdin, and pipelines.

### What is intentionally preserved

The following are **never** deleted by `jolli clean`, even if they appear stale by file age:

- **By-hash summary files** under the unified-hoist storage layout. Under the current schema, the by-hash file is the only surviving record of a child commit's original topics and recap once they have been stripped from the parent's embedded copy. Deleting them would silently corrupt history.
- **By-hash transcript files**. These are content-addressed artifacts the display layer reads on demand for read-by-hash views and audit guards.

Both file types are tiny, and the audit / read-by-hash benefit of keeping them dominates any disk savings.

### Empty-state behavior

When all three category counts are zero, the conclusion line is `Nothing to clean — all data is current.` and the command returns immediately without prompting and without deleting. This holds regardless of `--dry-run` or `--yes`.

## Exit Codes

| Code | Condition |
|------|-----------|
| `0`  | Counts were reported, including: nothing to clean, dry-run completion, successful deletion after confirmation, and user-aborted confirmation. |
| `1`  | The confirmation prompt was required but stdin was not a TTY and `--yes` was not passed. |

Argument-parsing failures return non-zero via the CLI argument parser, not via the clean command itself.

## Notable Behavior

- **`clean` is the **only** command that removes redundant data.** `doctor --fix` will not touch stale sessions, stale queue entries, or stale squash-pending files even when it sees them.
- **Aborting the prompt is exit `0`, not `1`.** The user successfully made a "no" decision; this is not a failure.
- **`--dry-run` always exits `0`** (assuming valid arguments), even when the prompt-required-but-no-TTY rule would otherwise fire — `--dry-run` never reaches the prompt.
- **`--yes` is the only way to delete without a TTY.** This is a deliberate safety contract: pipes, CI, and `< /dev/null` all hit the non-interactive refusal.
- **Corrupt queue entries and corrupt squash-pending files are treated as stale.** They will be reported in counts and removed alongside the genuinely-aged entries.

## Shared Behavior

- The `--cwd <dir>` flag is shared with most other `jolli` sub-commands. When omitted, the project directory is auto-resolved to the enclosing git repository root.
- The 48-hour session staleness threshold matches the threshold used internally when sessions are pruned automatically as a side effect of session loading.
- The non-interactive refusal pattern (`Pass --yes to confirm, or --dry-run to preview`) is the same safety pattern other potentially destructive sub-commands follow.
