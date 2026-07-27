# 68. `jolli convert` — Convert a third-party docs folder to the Jolli content layout

## Topic Statement

The `jolli convert` command rearranges an existing third-party documentation folder (Docusaurus, with detection-only support for Mintlify, VitePress, MkDocs, and GitBook) into a Jolli content folder by reorganizing files according to the source framework's sidebar configuration, downgrading incompatible MDX, fixing relative image paths, writing a clean `site.json`, and — for in-place runs — taking a timestamped backup of the original first.

## Scope

This spec covers the user-facing behavior of `jolli convert`: invocation forms, framework detection, the interactive prompts (migrate confirmation, site title), the in-place vs. separate-target output modes, the timestamped backup, the file-by-file reorganization (sidebar-driven path remapping, MDX → MD downgrade, image path rewriting), the resulting `site.json`, the cleanup of source-framework config files in the target, and exit codes. It does not cover the build of the resulting content folder into a static site (separate spec) or the deep semantics of the source framework's sidebar config (separate spec).

## Data Contracts (output)

### Filesystem output

After a successful run, the target directory contains:

- All Markdown content from the source, with paths potentially remapped according to the source's sidebar (`source-folder/file.md` → `logical-folder/file.md` where the sidebar groups them differently from the filesystem layout).
- All image files copied or moved through, preserved at their (potentially remapped) relative paths.
- All OpenAPI files (`.json` / `.yaml` / `.yml`) classified as OpenAPI documents copied or moved through.
- A `site.json` file at the target root containing the site title, a description (defaulted to `"<title> documentation"`), an empty top navigation array, the converted sidebar overrides (when produced from the source's sidebar config), and a `favicon` field referencing a copied `favicon.ico` if one was extracted from the source config. The `site.json` deliberately **does not** contain a `pathMappings` field — the path remapping has already been applied to the physical layout.
- A `favicon.ico` at the target root if the source config defined one.

For an in-place run (no `--output` flag), a timestamped backup of the original source tree is created as a sibling directory before any changes are made.

### Stdout report

The command prints a step-by-step progress report. Notable lines include:

- A backup-creation line: `Creating backup → <absolute backup path>` followed by `✓ Backup created` (in-place runs only).
- A summary block on success:
  - `✓ Converted <N> files (<M> downgraded)` — the parenthetical only appears when at least one MDX file was downgraded.
  - `✓ Moved <N> folders:` followed by an indented list of `source → target` lines, when the source's sidebar caused folder remapping.
  - `✓ Original backed up` (in-place runs only).
  - `✓ Created site.json`.
  - A closing hint: `Run \`jolli dev <target>\` to preview.` (or just `jolli dev` when the target is the current working directory).

### Stderr report

On a missing source folder, on an unhandled conversion error, or on a failed prompt, the command writes `Error: <message>` to stderr and sets the exit code to `1`.

## Behavior

### Invocation forms

- `jolli convert` — convert the current directory in place.
- `jolli convert <source>` — convert `<source>` in place.
- `jolli convert --output <target>` — convert the current directory into `<target>` (separate target).
- `jolli convert <source> --output <target>` — convert `<source>` into `<target>` (separate target).

If the source folder does not exist, the command prints `Error: Source folder does not exist: <absolute path>` and exits with code `1`.

### Framework detection

Before doing any work, the command scans the source root (and, for Docusaurus, the parent directory as a fallback) for known framework config files in this order: Docusaurus, Mintlify, VitePress, MkDocs, GitBook. The first match wins. The framework names are recognized as follows:

- **Docusaurus**: `docusaurus.config.js`, `docusaurus.config.ts`, `sidebars.js`, or `sidebars.ts` in the source root or parent.
- **Mintlify**: `mint.json` in the source root.
- **VitePress**: `.vitepress/config.js` or `.vitepress/config.ts` in the source root.
- **MkDocs**: `mkdocs.yml` or `mkdocs.yaml` in the source root.
- **GitBook**: `SUMMARY.md` or `.gitbook.yaml` in the source root.

Only Docusaurus has full conversion support today. The other frameworks are detected and reported but the sidebar-driven reorganization is not applied to them — they are converted as a flat copy.

### Migrate confirmation prompt

If a framework is detected and stdin is a TTY, the command prompts:

```
Found <Framework>. Generate site.json from it? (Y/n)
```

The default answer (empty input or `Y` / `y` / `yes`) is yes; any other answer is no. If stdin is not a TTY, the prompt is implicitly answered yes. If the user declines, the conversion proceeds but the source's sidebar is not used to drive folder reorganization or sidebar overrides — it becomes a flat copy.

### Site-title prompt

The command always prompts for the site title:

```
Site title (<DefaultTitle>):
```

The default title is the source folder's basename, with `-` and `_` replaced by spaces and each word title-cased. An empty answer accepts the default. If stdin is not a TTY, the default is used without prompting.

### In-place vs. separate-target

The two modes differ in three ways:

1. **Backup.** In-place runs create a timestamped backup at `<sourceRoot>.backup-<YYYY-MM-DDTHH-MM-SS>` (the colons and dots in the ISO-8601 timestamp are replaced with hyphens) by recursively copying the source tree before any modification. Separate-target runs do not create a backup — the source is read-only as far as `convert` is concerned and the conversion is written into the (created if missing) target directory.
2. **Move vs. copy.** In-place runs move files (rename, with a copy + delete fallback for cross-device moves) so the source folder ends up containing only the converted layout. Separate-target runs copy files; the source is left untouched.
3. **Path stability.** Files whose path does not change under sidebar remapping are left in place during in-place runs (no work) and copied as-is during separate-target runs.

### Reorganization driven by the source sidebar (Docusaurus only)

When the user accepts the migrate prompt and the framework is Docusaurus, the source's sidebar configuration is loaded and converted to a logical sidebar structure with associated path remappings. The remappings describe how each source folder should be repositioned to match the sidebar's logical structure (for example, an `sql/` folder grouped under a `pipelines` sidebar category becomes physically located under `pipelines/sql/`).

The remappings are applied physically to the converted tree, so the resulting `site.json` does not need to (and does not) carry a `pathMappings` field. The destination layout is the one the sidebar describes.

The summary report's `Moved N folders:` block lists each `source → target` remapping that was applied.

### MDX downgrade

For each `.mdx` file processed, the command inspects its content for incompatible imports (markers used by source frameworks but not supported by Jolli's renderer). When such markers are present, the file is **downgraded**: the incompatible content is stripped, the file extension is rewritten to `.md`, and the result is written to the (possibly remapped) target path. The original `.mdx` is removed in in-place mode. Each downgrade increments the `downgraded` counter shown in the summary.

If the file's relative path also changed under sidebar remapping, the relative image paths inside its body are rewritten so they continue to resolve from the new location.

### Image-path fixes for moved Markdown

For Markdown (`.md` and non-downgraded `.mdx`) files whose relative path changes under sidebar remapping, the command rewrites relative image references inside the file body so they resolve correctly from the new location. Files that don't move have their content copied through unchanged.

### `slug: /` handling

After all files have been written into the target, the command scans the target root for any Markdown file with a frontmatter `slug: /` declaration and renames the first such file to `index.md`. If a sidebar entry referred to that file by its old key, the sidebar entry is rewritten to `index` and re-anchored at the top of the root sidebar group.

### Favicon handling

When the framework is Docusaurus and a favicon is declared in the source config, the favicon file is copied to `<target>/favicon.ico` and the resulting `site.json` declares `"favicon": "favicon.ico"`. Source paths that are missing on disk are silently skipped — the conversion does not abort.

### `site.json` content

The written `site.json` always contains:

- `title` — from the prompt or the default.
- `description` — `"<title> documentation"`.
- `nav` — empty array (the user is expected to populate it).

It additionally contains:

- `sidebar` — the converted sidebar overrides, when the source had a usable sidebar config and the user accepted the migrate prompt and the structure was non-empty.
- `favicon` — `"favicon.ico"`, when a favicon was copied through.

The `pathMappings` field is intentionally absent — see the reorganization step above.

### Cleanup of source-framework files

Files that are part of the source framework's configuration (Docusaurus `sidebars.js` / `sidebars.ts` / `docusaurus.config.js` / `docusaurus.config.ts`, plus `package.json`, `package-lock.json`, `yarn.lock`, `node_modules`, and any pre-existing `site.json`) are skipped during file-by-file processing — they never appear in the target. After all content has been written, any remaining `sidebars.js` / `sidebars.ts` at the target root are removed.

The command also skips a `.jolli-site/` directory and any pre-existing `.backup-*` siblings during traversal so it never re-converts its own output or its own backups.

## Exit Codes

| Code | Condition |
|------|-----------|
| `0`  | Conversion completed successfully — files were written, the summary report printed, and (for in-place runs) the backup was created. |
| `1`  | The source folder does not exist, or an unhandled error occurred during conversion. |

## Notable Behavior

- **Destructive operation in in-place mode — gated by the timestamped backup.** The backup is taken before any file is moved, so the user can always recover the original tree by deleting the converted output and restoring from the backup directory.
- **The backup is a sibling directory, not nested.** This guarantees the backup is not itself processed by the conversion (the traversal explicitly skips `.backup-*` siblings).
- **The migrate prompt is per-conversion, not per-framework.** Even if the framework is detected, the user can decline and produce a flat copy without sidebar-driven reorganization.
- **Non-TTY stdin is treated as "accept defaults"** — both prompts auto-resolve to their default answers, making the command safe to run from CI scripts.
- **Only Docusaurus drives reorganization today.** The other supported frameworks are detected and reported but their sidebar configs are not parsed.
- **The conversion is renderer-agnostic at the IR level.** The reorganized content folder is the same shape that `jolli new` produces, so the downstream build pipeline does not need to know whether a folder came from `new` or `convert`.
- **MDX downgrade is content-driven, not extension-driven.** A `.mdx` file with no incompatible imports is left as `.mdx` (and copied or moved through normally). Only the presence of incompatible markers triggers the downgrade.
- **`site.json` is the user-editable configuration surface.** The starter `nav` is empty so the user can curate the top navigation themselves; the converted `sidebar` reflects the source structure and can be edited freely afterward.

## Shared Behavior

- The site-rendering theme system (referenced by `site.json`) is covered by its own spec.
- The downstream documentation-site build pipeline (`jolli dev` / `jolli start`) consumes the converted content folder; those commands have their own specs.
- The starter equivalent of this command for greenfield projects is `jolli new`, which is specified separately.
- The `slug: /` index-renaming convention is part of the broader content-folder routing convention and is covered by the routing spec.
