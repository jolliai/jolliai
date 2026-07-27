# 63. `jolli view` — Display commit summaries

## Topic Statement

The `jolli view` command displays one or many commit summaries in the terminal, either as a compact list of recent commits or as a single commit's full detail, optionally writing the result to a file in markdown or JSON.

## Relationship to `jolli recall`

`jolli view` and `jolli recall` are deliberately distinct surfaces over the same stored summary data:

- `jolli view` is a **raw summary dump**. It surfaces the stored per-commit summary payloads as-is — either the compact index table (recent commits with their metadata) or a single commit's full topic-level detail. It does no token-budgeted compilation, no per-branch aggregation, no plan/note merging, and no cross-commit decision extraction. The output corresponds 1:1 to what was persisted by the summary generator for one or more commits.
- `jolli recall` is a **compiled context view**. It pulls all summaries on a branch, deduplicates referenced plans and notes, extracts key decisions across the branch, and renders a single token-budgeted artifact suitable for re-injection into an AI agent (see the development-context-recall spec).

Choose `view` when the user wants to inspect what was actually recorded for one commit (or scan the recent commit list). Choose `recall` when the user wants a synthesized briefing across a branch.

## Scope

This spec covers the user-facing behavior of `jolli view`: invocation forms, how a `--commit` reference is resolved, the two output shapes (compact list vs. full detail), the file-output behavior, the supported formats, and the exit code policy. It does not cover how summaries are stored (separate spec), how they are generated (separate spec), or the branch-level compiled context surface (covered by the development-context-recall spec, including its branch catalog mode).

## Data Contracts (output)

### Compact list (default)

A multi-line table written to stdout when `jolli view` is invoked without `--commit`:

1. Header line `Recent Memories (<shown> of <total>)`.
2. Column headers `#     Hash      Date      Summaries  Changes          Message` over a horizontal rule whose width is clamped to the terminal width minus a small margin.
3. One row per commit:
   - `#` — 1-based numeric index, padded to width 2.
   - `Hash` — first 8 characters of the commit hash.
   - `Date` — short date string padded to width 10.
   - `Summaries` — topic count for that commit, right-padded to width 3.
   - `Changes` — `<files-changed> files +<insertions>` (omitted when no diff stats are recorded), padded to width 15.
   - `Message` — the commit message, truncated with a trailing `...` to fit the remaining terminal width, with an optional `[<commitType>]` badge appended (e.g. `[squash]`) when the commit type is anything other than the default.
4. Two trailing hint lines suggesting `jolli view --commit 1` and `jolli view --commit 1 --output summary.md`.

When `--format json` is set, the compact list is emitted as a JSON array of summary index entries instead of the table.

When `--output <path>` is set without `--commit`, the format defaults to `json` (not `md`), since the compact list is most useful as machine-readable data; `--format md` produces a GFM-compatible markdown table with the same six columns and pipe-escaped cells.

### Single-commit detail (`--commit <ref>`)

A multi-line, sectioned report written to stdout:

1. A separator rule.
2. A metadata block with the commit's short hash and message, branch, optional commit type / source, date, duration, change stats (`<files> files, +<insertions> -<deletions>`), optional total turn count, and optional model + token + latency line.
3. A `Summaries:` (or `Summary:` when there is exactly one topic) section listing each topic. Each topic shows: a 1-based ordinal, title, optional category in brackets, optional `(minor)` marker, then four labelled paragraphs (`Why this change`, `Decisions behind the code`, `What was implemented`, `Todo`) and an optional `Files: <comma-list>` line. Topics flagged minor sort to the bottom; non-minor topics are listed first in their original order.
4. When the commit has no topics, a single line `Summaries: (none — LLM did not generate any for this commit)`.

When `--format json` is set with `--commit`, the full underlying summary object is emitted as JSON, written to stdout (or the output file if `--output` is set).

When `--output <path>` is set with `--commit`, the format defaults to `md` (the full markdown rendering used by exports), not `json`.

### Output file confirmation

When `--output <path>` is used, after the file is written the command prints a single line:

```
<list-or-detail-label> written to <file:// URI>
```

The URI is the absolute path with the `file://` scheme prepended so terminals that support OSC-8 / file links can open it.

## Behavior

### Invocation forms

- `jolli view` — compact list of the most recent commits with summaries (default 10).
- `jolli view --count <n>` — compact list, capped at `<n>` rows. `<n>` must be a positive integer; argument parsing rejects non-positive or non-numeric values.
- `jolli view --commit <ref>` — full detail of one commit. `<ref>` may be a numeric index, a short SHA, or a full hash (see resolution rules below).
- `jolli view --output <path>` — write to a file instead of stdout. Combinable with `--commit` and `--format`.
- `jolli view --format <fmt>` — explicit format selector, where `<fmt>` is one of `md` or `json`. The argument parser rejects any other value.
- `jolli view --cwd <dir>` — operate against `<dir>` instead of the auto-resolved git repository root.

### `--commit` reference resolution

A `--commit <ref>` value is resolved as follows, in order:

1. If `<ref>` is a base-10 integer between 1 and 9999 inclusive, it is treated as a 1-based index into the **root** entries of the summary index, sorted newest-first by display date. Index `1` is the most recent commit with a summary, `2` is the next, and so on.
2. Otherwise `<ref>` is treated as a (full or partial) commit hash and looked up directly in the summary store.

The 9999 cap distinguishes pure numeric indices from numeric-prefix short SHAs; a SHA that begins with all digits and is longer than four characters falls through to the hash lookup branch.

When the integer index has no entry (e.g. `--commit 50` on a project with 12 summaries), the command prints `No summary at index #<n> (<total> total)` and returns without an error exit code. When a hash reference does not match any stored summary, the command prints `No summary found for commit <ref>` and returns without an error exit code.

When the summary index is missing entirely (no commits ever generated a summary), and a numeric index was used, the command prints `No summaries found. Start coding with your AI agent and commit!` and returns.

### Compact-list count behavior

`--count` controls how many rows are displayed; the index header still reports `<shown> of <total>` so the user can tell when the list is truncated. The count applies to the compact-list path only and is ignored when `--commit` is used.

### File-output side effects

When `--output <path>` is supplied:

- Parent directories of `<path>` are created as needed.
- The file is written as UTF-8.
- The absolute path of the resulting file is printed back to the user as a `file://` URI.

The file-output path is taken verbatim from the user; relative paths are resolved against the current working directory of the shell, not against `--cwd`.

### Empty-state behavior

- Compact-list mode with no summaries → prints `No summaries found. Start coding with your AI agent and commit!` and returns. No file is written even if `--output` was supplied.
- `--commit` with a missing reference → prints the per-mode "no summary" message described above and returns. No file is written.

In both cases the exit code is `0`.

## Exit Codes

| Code | Condition |
|------|-----------|
| `0`  | Output was produced, including the empty-state messages and the missing-commit messages. |
| Non-zero | Argument parsing failed (e.g. `--count -3`, `--format xml`). Reported by the CLI argument parser, not by the view command itself. |

`jolli view` is intentionally a read-only, never-failing query. It does not signal "no summaries" via exit code.

## Notable Behavior

- **Numeric `--commit` resolves against root commits only.** Commits that are folded into another commit (e.g. squash children) are not directly addressable by index — the user reaches them through the root they were merged into.
- **Default format depends on the surface.** Stdout always defaults to the human-readable rendering (compact table or full detail). `--output` defaults to `json` for the compact list (more useful as data) and `md` for a single commit (more useful as a document). `--format` overrides both defaults.
- **The compact list shows index totals, not just the displayed count.** Users always see how many summaries exist in total, even when only the first 10 are shown.
- **Topic ordering puts minor first-class material at the bottom.** Non-minor topics keep their stored order; topics flagged `minor` always sort after them, regardless of their stored order.
- **The `Todo` block is omitted when the topic's todo is empty or literally `none`.** The omission is case-insensitive and tolerant of a trailing period.
- **Truncation is terminal-width-aware.** The message column adapts to `process.stdout.columns`, with a floor of 20 characters. The horizontal rule under the headers is similarly clamped.

## Shared Behavior

- The `--cwd <dir>` flag is shared with most other `jolli` sub-commands. When omitted, the project directory is auto-resolved to the enclosing git repository root.
- The full-detail markdown rendering (`--commit … --output … --format md`) uses the same markdown builder used by the export command, so the file you write here is byte-for-byte identical to what `jolli export` would produce for the same commit.
- The summary index queried in compact-list mode and the by-hash store queried in detail mode are the same storage surfaces specified in the orphan-branch storage spec.
