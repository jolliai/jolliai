# 65. `jolli export-prompt` — Export LLM prompt templates

## Topic Statement

The `jolli export-prompt` command emits the product's library of LLM prompt templates either to standard output or as a directory of per-template Markdown files plus a structured manifest, supporting both human review and downstream backend seeding from the same source of truth.

## Scope

This spec covers the user-facing behavior of `jolli export-prompt`: the three invocation forms (no flags / `--action` only / `--output [+ --action]`), the file layout of the directory mode, the manifest format, the per-template Markdown layout, placeholder extraction, the stdout messages for the no-flags branch, and exit codes. It does not cover the internal template registry or how the templates are consumed at runtime — those are separate specs.

The sibling `jolli export` command is a different command and is specified separately.

## Data Contracts (output)

### Stdout-only modes

- **No flags (guidance branch).** Prints a multi-line guidance message that explains the command takes either `--action <key>` or `--output <dir>`, lists every available action key on a single comma-separated line, and exits cleanly. No template body is dumped.
- **`--action <key>` (single-template branch).** Prints the raw template body (no frontmatter, no manifest, no separators) to stdout, terminated by a single newline.

### Directory mode (`--output <dir>`)

The command creates the target directory recursively if it does not exist and writes the following layout into it:

```
<dir>/
  manifest.json
  <action-1>.md
  <action-2>.md
  ...
```

Per-template filenames are derived from the action key by replacing every run of non-alphanumeric characters with a single hyphen.

#### `manifest.json`

A single JSON document, tab-indented, with a trailing newline, with the following shape:

```json
{
  "exportedAt": "<ISO-8601 timestamp>",
  "cliVersion": "<product version string>",
  "prompts": [
    {
      "action": "<action key>",
      "version": <integer>,
      "template": "<raw template body, including {{placeholder}} markers>",
      "placeholders": ["<name1>", "<name2>", "..."]
    }
  ]
}
```

`prompts` is sorted by `action` (locale compare) for deterministic diffs across runs. Each `placeholders` array is the deduplicated, alphabetically sorted set of placeholder names found in the template body. Each entry's `template` is the raw template body verbatim — no substitution is performed.

#### Per-template `.md` file

Each template is also written as a standalone Markdown file with a YAML frontmatter block followed by the raw template body:

```
---
action: "<action key, double-quoted, internal quotes backslash-escaped>"
version: <integer>
placeholders:
  - <name1>
  - <name2>
---

<raw template body>
```

When a template has no placeholders, the frontmatter line is `placeholders: []` (flow style on a single line) instead of a block list.

### Stderr report

On unknown action key (with or without `--output`), an error line is written to stderr of the form `Error: unknown action "<key>"`, followed by an `Available: <comma-separated list>` line, and the process exit code is set to `1`.

On a successful `--output` run, a confirmation line is also written to stdout listing the count exported, the absolute output directory path, and the absolute manifest path.

## Behavior

### Invocation forms

- `jolli export-prompt` — print the guidance message and exit `0`.
- `jolli export-prompt --action <key>` — print the single template body to stdout and exit `0`. If `<key>` is not a known action, print the error and exit `1`.
- `jolli export-prompt --output <dir>` — write `manifest.json` and one `.md` per template into `<dir>`. The directory is created if missing.
- `jolli export-prompt --output <dir> --action <key>` — write `manifest.json` containing only the named template, plus a single `.md` file for it. If `<key>` is not a known action, print the error and exit `1` (no files are written).

### Why no-flags is guidance, not a dump

Dumping every template body to stdout would produce thousands of lines that overwhelm terminal scrollback and rarely matches what the user actually wants. The no-flags branch therefore prints only a short usage message that lists the available action keys and points the user at either `--action` or `--output`. To get all template bodies, the user must explicitly write them to a directory.

### Placeholder extraction

For each template, the set of placeholder names is computed by scanning the template body for `{{name}}` markers (with optional surrounding whitespace inside the braces). The same scan is used by the runtime template engine, so what the manifest reports as a placeholder is exactly what the runtime will substitute. Names are deduplicated and sorted alphabetically.

### `cliVersion` resolution

The `cliVersion` field reflects the product version of the CLI that produced the export. When the CLI is run from a build artifact, the embedded build-time version constant is used; when it is run from source (development or test mode), the version is read from the package metadata in the standard location. If neither is available, the literal string `unknown` is written instead of failing.

### Manifest determinism

`prompts` is sorted by `action` so that running the command twice on the same product version produces byte-identical content for every entry — except `exportedAt`, which always reflects the time of the export. This makes the per-template `.md` files a clean fit for committing into a version-controlled review workflow, and makes the `manifest.json` suitable for backend seeding pipelines that want a stable diff.

### Filename sanitisation

The per-template filename is the action key with every run of non-alphanumeric characters replaced by a single hyphen, followed by `.md`. Action keys are simple identifiers in practice, so collisions between distinct keys are not expected.

### Action filter with `--output`

When `--action` is combined with `--output`, the manifest's `prompts` array is filtered down to the single matching entry before being written, and only one `.md` file lands on disk. The unknown-action error path is identical to the stdout-only single-template branch.

### Idempotency and overwrites

The directory mode overwrites `manifest.json` and any per-template `.md` files that share a filename with a current template. Files in the target directory that do not collide with an exported filename are left untouched.

## Exit Codes

| Code | Condition |
|------|-----------|
| `0`  | Guidance printed (no flags), single template printed to stdout, or directory mode wrote successfully. |
| `1`  | `--action <key>` was supplied but `<key>` is not a known action (whether or not `--output` was also supplied). |

## Notable Behavior

- **Two artifacts, same source of truth.** The per-template `.md` files are intended for human review and version-controlled diffs; `manifest.json` is intended as the structured input for backend seeding. They are emitted from the same template registry in a single run, so they cannot drift relative to each other.
- **Templates contain `{{placeholder}}` markers verbatim.** No substitution is performed by this command — the export is a snapshot of the templates as the runtime will substitute them.
- **Unknown action error lists all available actions** so the user can immediately retry with a valid key without consulting external documentation.
- **`exportedAt` makes every run a fresh document** even when nothing else changed, so the manifest can serve as a provenance record.
- **No network access.** The command reads only from the in-memory template registry and writes only to local files (or stdout).

## Shared Behavior

- The template registry that this command exports from is the same registry consumed at runtime by both direct-mode (Anthropic SDK) and proxy-mode (Jolli backend) summary generation.
- The placeholder regex used for extraction is the same regex used by the runtime template-fill engine, so the manifest's `placeholders` arrays are guaranteed to match what the engine substitutes.
