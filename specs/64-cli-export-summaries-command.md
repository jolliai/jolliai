# 64. `jolli export` — Export commit summaries to the Documents knowledge base

## Topic Statement

The `jolli export` command writes every stored commit summary in the current project as an individual Markdown file under a per-project directory inside the user's Documents folder, plus a chronological index file that links to all of them.

## Scope

This spec covers the user-facing behavior of `jolli export`: invocation forms, the destination layout under `~/Documents/jollimemory/<project-name>/`, the per-summary filename convention, what the per-summary file contains, the index file, idempotency, project-name derivation, the report printed to stdout, and exit codes. It does not cover how summaries are stored (separate spec) or how the rendered Markdown is shaped (separate spec).

The sibling `jolli export-prompt` command is a different command and is specified separately.

## Data Contracts (output)

### Destination

The export root is the absolute path:

```
~/Documents/jollimemory/<project-name>/
```

`<project-name>` is the resolved project name, described under **Behavior → Project-name derivation**. The directory tree is created if it does not exist; existing files inside it are never deleted.

### Per-summary file

For each summary that is processed, the file written is:

```
~/Documents/jollimemory/<project-name>/<8-hex>-<slug>.md
```

- `<8-hex>` is the first 8 lowercase hex characters of the commit hash.
- `<slug>` is the commit message lowercased, with every run of non-alphanumeric characters collapsed to a single hyphen, leading and trailing hyphens trimmed, and the result truncated to at most 60 characters.

The file body is the rendered Markdown view of the summary (the same view used elsewhere for clipboard export and PR publishing). The command does not call any LLM — it only renders already-stored data.

### Index file

A single index file is always (re)written at:

```
~/Documents/jollimemory/<project-name>/index.md
```

The index begins with a heading containing the project name, followed by a Markdown table with three columns — date (YYYY-MM-DD), short commit hash in code formatting, and the commit message linked to the per-summary file. Rows appear in the same order the summaries were processed (i.e. the order returned by the summary store, which is reverse-chronological by activity date).

The index is rebuilt from scratch on every run and reflects all summaries that have a corresponding file on disk after the run finishes (both newly written and pre-existing files).

### Stdout report

After a successful run that produced or already had at least one summary, the command prints:

- The destination directory path (`Exported to <outputDir>`).
- Counts on a single line: `New: <writtenCount>  Skipped: <skippedCount>` and, when any errors occurred, `  Errored: <erroredCount>`, then `  Total: <totalCount>`.
- The absolute index file path (`Index: <indexPath>`).

When there are no summaries at all in the project, the command prints `No summaries found to export.` and writes nothing.

When every attempted file write failed (zero new files written, but at least one error), the command prints a failure line of the form `Export failed — <erroredCount> failed (<skippedCount> already on disk).` to stderr.

## Behavior

### Invocation forms

- `jolli export` — export every stored summary in the current project.
- `jolli export --commit <sha>` — export only the single summary identified by the given commit hash; if no summary exists for that hash, the result behaves like the empty-summaries case.
- `jolli export --project <name>` — override the project name used to derive the destination directory. The argument is treated as a single path segment (the basename is taken if the caller supplies a path).
- `jolli export --cwd <dir>` — operate against `<dir>` instead of the auto-resolved git repository root. Default value is the resolved project directory.

There is no `--output` flag — the destination is always under `~/Documents/jollimemory/`.

### Project-name derivation

The `<project-name>` segment of the destination path is resolved in this order:

1. If `--project <name>` was passed, the basename of that value is used.
2. Otherwise, the basename of the git repository root (resolved from `--cwd` or the current working directory) is used.
3. If the directory is not a git repository at all, the basename of the working directory is used.

### Idempotency

Before writing, the command scans the destination directory for files matching the `<8-hex>-*.md` filename pattern. Any summary whose 8-hex prefix is already present is **skipped** — no file is rewritten, the existing content is preserved, and the summary is counted under `Skipped` rather than `New`. Skipped summaries still appear in the regenerated index file as long as their file exists on disk.

This makes the command safe to re-run repeatedly: only new commit summaries since the last export incur a write.

### What is written

The per-summary file is the rendered Markdown view of the stored summary. The renderer is pure (no LLM call, no network call). The exact section structure is owned by the shared Markdown renderer used by other surfaces, so it stays consistent between an exported file, a clipboard copy, and the PR publish path.

### Index regeneration

The index file is rewritten on every run, even if no new summary files were written. This keeps the index in sync with the actual files on disk after manual additions, deletions, or renames inside the destination directory: the index lists every summary that has a corresponding file present after the run, and only those.

### Single-commit mode

When `--commit <sha>` resolves to a known summary, the command processes that single summary and otherwise behaves identically. The regenerated index in single-commit mode contains only that summary's row plus rows for any other summaries already on disk that match the filename pattern — no, wait: the index is built from the summaries the command processed during this run. In single-commit mode, the index therefore contains a single row.

When `--commit <sha>` does not match any stored summary, the command prints the empty-summaries message and writes nothing.

### Failure modes

A per-summary write failure (for example out-of-space or permission denied) is caught individually, logged to stderr, and counted under `Errored`. Processing continues for the remaining summaries.

- If at least one new file landed on disk, the command treats the run as a success path and prints the normal report (with an `Errored:` segment in the counts line).
- If zero new files landed and at least one errored, the command prints the failure line on stderr and sets the exit code to `1`.

## Exit Codes

| Code | Condition |
|------|-----------|
| `0`  | Run completed normally — all summaries were either newly written, intentionally skipped because already on disk, or there were no summaries to export. Also returned when partial errors occurred but at least one new file was written. |
| `1`  | Every attempted summary write failed (zero new files written, one or more errors). |

## Notable Behavior

- **No LLM calls.** The command is a pure render-and-write of already-stored data. It never makes a network request.
- **Per-project isolation.** Two projects with different names get two separate directories under `~/Documents/jollimemory/`. The same project always resolves to the same directory across runs (modulo a `--project` override).
- **Existing files are never deleted.** Manual edits or deletions inside the destination directory are tolerated: edits survive, deletions cause the summary to be re-exported on the next run because the 8-hex prefix is no longer present.
- **The index is the single source of truth for ordering and discoverability** — the per-summary filenames are content-addressed (hash + slug) and not designed for human ordering on their own.
- **Slug truncation can collide** if two distinct commit messages slugify to the same 60-char value, but the 8-hex prefix disambiguates filenames so collisions never occur on disk.
- **The `<project-name>` from `--project` is treated as a basename** — supplying a path like `acme/web` is equivalent to `web` for destination resolution, by design, to keep the directory tree shallow.
- **Pipe-safe index rows.** Pipe characters inside commit messages are escaped in the index table so the Markdown table never breaks.

## Shared Behavior

- The `--cwd <dir>` flag is shared with most other `jolli` sub-commands. When omitted, the project directory is auto-resolved to the enclosing git repository root.
- All Jolli sub-commands set up the per-project log directory under `<cwd>/.jolli/jollimemory/` before doing any work; messages logged by `export` land there in addition to whatever is printed to the terminal.
- The Markdown rendering used per summary is the same renderer used by clipboard export, PR publishing, and other Markdown surfaces.
- The summary store and its read API (used to list and fetch summaries) are covered by the storage and indexing topics.
