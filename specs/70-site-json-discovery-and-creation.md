# 70. Site Configuration File Discovery and Creation

## Topic Statement

Reading the documentation project's `site.json` configuration file when present, or creating it on first use after detecting a known documentation framework and prompting the user for a title.

## Scope

**In scope:**
- The fixed file name `site.json` placed at the root of the source content folder.
- The set of fields the file is expected to contain, with documented defaults for each.
- How forward-compatibility for unknown fields is preserved on read.
- The first-use creation flow when `site.json` is absent: framework detection, optional sidebar conversion, title prompt, and writing the new file.
- A "force re-detection" mode that re-runs the creation flow even when `site.json` already exists.
- Behavior when standard input is not a terminal (non-interactive default).
- Outputs returned to the caller (the parsed configuration plus a flag indicating whether a default-created file was used).

**Out of scope:**
- The detection rules used to recognize a particular framework (covered by the framework-detection topic).
- The conversion of a Docusaurus sidebar into the configuration's sidebar / path-mappings shape (covered by the Docusaurus-sidebar-conversion topic).
- Any later use of the configuration to mirror content, generate scaffolding, or render the site.
- Validation of the configuration's semantic content beyond field-shape coercion.

## Data Contracts

### File location and name

The configuration file is always named `site.json` and is read from the root of the content folder supplied by the caller.

### Recognized fields

The configuration file is a JSON document. The recognized top-level fields are:

- `title` (string) — display title for the documentation site. Default: `"My Documentation Site"`.
- `description` (string) — short description used in metadata. Default: `"A documentation site powered by Jolli"`.
- `nav` (array of `{ label, href }` entries) — flat list of navigation links shown in the header. Default: empty array.
- `header` (object) — richer header configuration that supersedes the flat `nav` when both are set; supports per-item dropdowns. Optional, no default.
- `footer` (object) — footer configuration: copyright text, columns of labelled links, and per-platform social URLs. Optional, no default.
- `sidebar` (object keyed by directory path) — per-folder sidebar overrides, where each value is an ordered map of `{ key: label-or-link-object }`. Optional, no default.
- `pathMappings` (object of `{ source-folder: target-folder }`) — folder-level remapping used when the logical sidebar structure differs from the physical content layout. Optional, no default.
- `favicon` (string) — favicon path; deprecated alias for `theme.favicon`. When both are set the top-level value wins. Optional, no default.
- `renderer` (string) — name of the renderer to use. Optional, no default.
- `theme` (object) — visual theme block (pack name, logo URLs, accent hue, default mode, font family, favicon). Optional, no default.

Any field not listed above is preserved verbatim across read.

### Forward compatibility on read

When parsing an existing `site.json`, the reader:
1. Coerces each recognized field to its expected shape, falling back to the default when the value is missing or has the wrong type.
2. Preserves every unrecognized top-level key as-is alongside the coerced recognized fields.

The result is a single object that contains both the coerced known fields and any extra fields supplied by the user.

### Public result

The reader returns a record containing:
- `config`: the parsed-or-defaulted configuration object.
- `usedDefault`: `true` when the file was just created on this call (default-bootstrap path), `false` when an existing file was read.

### Default content for a freshly created file

When the reader creates the file:
- `title` is the user's response to the title prompt, or the prompt's default when accepted unchanged.
- `description` is the chosen title followed by `" documentation"`.
- `nav` is the empty array.
- `sidebar`, `pathMappings`, and `favicon` are populated only when a successful framework conversion produced non-empty values for them; otherwise they are omitted.
- All other recognized fields are omitted from the freshly-written file.

The file is written with two-space indentation and a trailing newline.

## Behavior

### Read mode

When called with the default options:
1. If `site.json` exists at the source root, parse it and return the coerced configuration with `usedDefault = false`.
2. If parsing fails (the file exists but is not valid JSON), throw an error that names the file path and includes the underlying parse-error detail.
3. If `site.json` does not exist, fall through to the creation flow.

### Force-re-detect mode

The reader accepts an optional `migrate` flag. When set:
- The creation flow runs unconditionally, regardless of whether `site.json` exists.
- The existing file (if any) is overwritten by the freshly created file.

This mode is intended for re-running framework detection and sidebar conversion against a project that was previously configured.

### Creation flow

1. **Framework detection.** Inspect the source root (and, where the framework convention dictates, its parent directory) for the marker files of each known documentation framework. The first match wins.
2. **Optional sidebar conversion.**
   - If a framework was detected and standard input is a terminal, prompt the user with `Found <Framework> config. Generate site.json from it? (Y/n)`. An empty answer, `y`, or `yes` (case-insensitive, trimmed) means yes; anything else means no.
   - If standard input is not a terminal, treat the answer as yes.
   - If the user accepts and the detected framework supports conversion (currently Docusaurus only), invoke the converter, capture its sidebar overrides and path mappings, and additionally extract a favicon path from the framework's main config file when present.
   - On converter error, log a warning that names the underlying error message and continue without sidebar overrides.
   - If the user accepts but the framework's converter is not yet implemented, log a one-line warning naming the framework and continue without sidebar overrides.
3. **Title prompt.**
   - Compute a default title from the source root's folder name: replace `-` and `_` with spaces and title-case each word.
   - If standard input is a terminal, prompt with `Site title (<default>): `. An empty answer accepts the default; otherwise the trimmed answer is the title.
   - If standard input is not a terminal, accept the default without prompting.
4. **Build and write.** Compose the configuration object from the chosen title (and the derived description), the optional converter outputs, and the empty-array `nav`. Serialize as JSON with two-space indentation and a trailing newline, and write it to `site.json` at the source root.
5. **Log.** Print a `Created <path>` line to standard output. If sidebar conversion ran, also print a `Converted <sidebar-file> → sidebar config` line during conversion.
6. Return the new configuration with `usedDefault = true`.

### User-decline path

The creation flow has no explicit "exit when user declines" branch. Declining the framework conversion only skips the sidebar/path-mappings/favicon extraction; the title prompt and the file write still happen. To skip creation entirely, the caller must avoid invoking the reader (e.g., the source folder is not a documentation project).

## State Transitions

The `site.json` file has three observable states from the reader's point of view:

- **Absent** — no file exists at the source root.
- **Present and valid** — a JSON-parseable file exists.
- **Present and invalid** — a file exists but is not valid JSON.

Transitions driven by this reader:

- Absent → Present and valid: a creation-flow run wrote the file.
- Present and valid → Present and valid (overwritten): a force-re-detect run produced a new file from scratch.
- Present and invalid → (error): any read attempt throws; the file is not modified.

The reader never deletes the file and never converts a valid file to an invalid one.

## Notable Behavior

- **Forward-compat preservation.** Unknown top-level fields in an existing `site.json` survive a read unchanged. The reader does not warn about them. The reader does not currently round-trip them on a force-re-detect (which writes a fresh file from scratch).
- **Title prompt accepts the default on empty input.** Pressing Enter at the prompt selects the default title; only a non-empty trimmed answer overrides it.
- **Migration prompt defaults to yes.** A bare Enter at the migration prompt is treated as accepting conversion. This biases the first-time experience toward picking up an existing framework's structure.
- **Non-TTY auto-accepts.** Both prompts auto-accept when standard input is not a terminal, so unattended runs (CI, scripts) produce a sensible default file rather than hanging.
- **Convert-warning is non-fatal.** A failure inside the framework converter does not abort the creation flow; it logs a warning and proceeds to the title prompt and write step. The resulting `site.json` will simply not contain sidebar overrides or path mappings.
- **Converter coverage is partial.** Only Docusaurus is converted today. Detected-but-unsupported frameworks log a warning naming the framework and continue with the empty-folder-structure default.
- **Description defaults to `"<Title> documentation"` only on first creation.** Subsequent reads of an existing file accept whatever description the user has set.
- **`usedDefault` is the reader's sole signal that creation just happened.** Callers who want to print onboarding hints (e.g., "we just created your `site.json` — review it before publishing") rely on this flag.
- **Type-shape coercion is per-field, not whole-document.** A `site.json` with the wrong type for one field (e.g., `nav: "home"` instead of an array) silently uses the default for that field and keeps the rest of the file unchanged.

## Shared Behavior

- The framework-detection rules used by step 1 of the creation flow are defined by the documentation-framework-detection topic.
- The Docusaurus-specific sidebar-to-overrides conversion used by step 2 is defined by the Docusaurus-sidebar-conversion topic.
- The downstream consumers of the parsed configuration (content mirroring, project scaffolding, asset resolution) are defined by their own topics.
