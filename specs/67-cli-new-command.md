# 67. `jolli new` — Scaffold a new documentation content folder

## Topic Statement

The `jolli new <folder>` command creates a brand-new documentation content folder at the given path, populated with a starter kit of files (site configuration, home page, getting-started guide, an example OpenAPI spec, and a nested guides subfolder), refusing to run if the target already exists.

## Scope

This spec covers the user-facing behavior of `jolli new`: invocation forms, the interactive folder-name prompt, the contents of the starter kit, the abort-on-existing-target rule, the success and failure messages, and exit codes. It does not cover the build pipeline that turns a content folder into a static site (separate spec) or the `jolli convert` flow that converts an existing third-party docs folder (separate spec).

## Data Contracts (output)

### Filesystem output (success path)

On success, the command creates the target directory at `<cwd>/<folder>` (or at the resolved interactive answer) and writes the following files inside it:

```
<folder>/
  site.json
  index.md
  getting-started.md
  api/
    openapi.yaml
  guides/
    introduction.md
```

`site.json` — a JSON document with sensible defaults: a placeholder site title, a description, a navigation array with entries for Home, Getting Started, API Reference, and Guides, and a default visual theme pack.

`index.md` — a welcome page that explains the layout and points the user at editing `site.json` and running the local preview.

`getting-started.md` — a quick-start guide that documents the prerequisites and the local preview command, plus how to edit content and configure the site.

`api/openapi.yaml` — a fully populated example OpenAPI 3.x specification (info block, two servers, one tag, three operations on two paths, and the matching component schemas) so the user can immediately see how an OpenAPI file is rendered.

`guides/introduction.md` — a nested-subfolder example that explains how subfolders become navigation sections.

### Stdout report

On success, the command prints two lines:

```
  Created <absolute target dir>
  Run `jolli dev` inside that folder to preview your site.
```

On failure, the command prints `Error: <message>` to stderr and sets the exit code to `1`.

## Behavior

### Invocation forms

- `jolli new <folder-name>` — scaffold at `<cwd>/<folder-name>`.
- `jolli new` — interactive: prompt `Folder name: ` on stdin and use the answer (trimmed). If stdin is not a TTY, or the answer is empty, the command treats this as a missing folder name and prints `Error: Folder name is required.` to stderr with exit code `1`.

The folder name is taken verbatim — it is not slugified, not validated for filesystem safety, and not lowercased. Whatever the user supplies (interactively or as the positional argument) becomes the directory name relative to the current working directory.

### Abort on existing target

If the resolved target directory already exists (whether empty or populated), the command refuses to run, prints `Error: Directory already exists: <absolute target dir>` to stderr, and exits with code `1`. **No file is created or overwritten in this case** — the existing tree is left untouched.

This is deliberate: the starter kit is for greenfield use. Adding starter files into an existing tree is the job of `jolli convert`, not `jolli new`.

### Starter-kit contents

All five files are written in a single batch after the directory tree is created. The starter kit is fixed at the version of the CLI that produced it; running `jolli new` from a newer CLI may produce different starter content. The contents include forward references to commands (`jolli dev`, `jolli start`) that exist in the same CLI.

### Default `site.json`

The default `site.json` is intentionally pre-populated with a navigation bar that matches the starter kit's file layout — the four nav entries point at `/`, `/getting-started`, `/api/openapi`, and `/guides/introduction`. A user who replaces the starter pages should update the nav entries; the file is otherwise valid as-is for an immediate preview.

### Interactive prompt — TTY only

The interactive prompt is suppressed when stdin is not a TTY: in that case the command treats the missing argument as an error rather than blocking on a prompt that would never be answered. This makes the command safe to use from CI shells.

## Exit Codes

| Code | Condition |
|------|-----------|
| `0`  | Starter kit was successfully scaffolded at the target directory. |
| `1`  | The folder name was missing (no positional argument and no interactive answer), the target directory already exists, or a filesystem error prevented writing one of the starter files. |

## Notable Behavior

- **Greenfield only.** The command never touches an existing directory. To migrate an existing third-party docs folder into the Jolli format, the user must use `jolli convert`.
- **Starter kit is a fixed snapshot.** The contents of the five files are baked into the CLI build, not downloaded. The command works fully offline.
- **No LLM calls.** Pure local filesystem work.
- **Folder name is verbatim.** Spaces, uppercase, special characters — they all pass through unchanged. The user is expected to choose a sensible name.
- **The next-steps message points at `jolli dev`** (for live preview), not `jolli start` (which builds and serves a static site). The starter kit's `getting-started.md` mentions `jolli start` as the production-style command.
- **Both the starter `index.md` and the next-steps message tell the user to run from inside the new folder.** The CLI does not auto-cd; the user must do so.

## Shared Behavior

- The starter kit's navigation theme pack is part of the broader site-rendering theme system, covered by its own spec.
- The site-build commands referenced by the starter kit (`jolli dev`, `jolli start`) are separate commands with their own specs.
- The OpenAPI starter spec is rendered by the documentation site's OpenAPI pipeline, covered by its own spec.
