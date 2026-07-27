# Starter Kit Scaffolding

## Topic Statement

The new-project scaffolder writes a fixed starter content folder layout — site configuration, home page, getting-started guide, an example OpenAPI specification stub, and a nested guides subfolder — into a target directory, refusing to proceed when the target already exists.

## Scope

**In scope:**
- The exact set of files and folders the scaffolder writes.
- The default contents of each file.
- The pre-flight existence check that prevents accidental overwrites of an existing directory.
- The success and failure result shape returned to the caller.
- The directory creation order (parents first) and the parallel-write of file contents.

**Out of scope:**
- The behavior of any of the commands the starter content references (build, dev, serve).
- The deeper meaning of the configuration fields — the scaffolder writes literal values, not a parser.
- Translation of the starter into a localized form.
- Customization knobs — the starter is fixed; callers do not pass options to vary its contents.

## Data Contracts

### Scaffold input

The scaffolder takes a single input:

- **target directory path** (required, string): the absolute or relative path where the starter content will be written.

### Scaffold result

A small record with three fields:

- **success** (required, boolean): true if the starter was written, false on either pre-flight rejection or any write failure.
- **target directory** (required, string): echoed verbatim from the input.
- **message** (required, string): human-readable status. On success: a brief confirmation noting the directory created. On failure: either the "directory already exists" rejection or the underlying error's message.

### Starter file set

Five files are written, organized into three directory levels:

- **`site.json`** (root) — the site configuration.
- **`index.md`** (root) — the home page.
- **`getting-started.md`** (root) — the getting-started guide.
- **`api/openapi.yaml`** — example OpenAPI specification stub under an `api/` subfolder.
- **`guides/introduction.md`** — example guide under a `guides/` subfolder, demonstrating nested folder navigation.

### Default contents

- **Site configuration**: a JSON object pinning a default site title ("My API Docs"), a default description, four navigation entries (home, getting started, the example API reference, and the example guide), and a theme block selecting the default visual pack ("forge"). Two-space-indented, trailing newline.
- **Home page**: a markdown welcome page that names the product, lists what each starter file is for, and points the reader at the next steps (edit configuration, replace example pages, run the start command).
- **Getting-started guide**: a markdown page covering prerequisites (a runtime version requirement and the CLI binary), the local-run command, content editing conventions (markdown and MDX, OpenAPI specs, nested folders for sections), and a quick configuration walkthrough showing how to swap the theme pack.
- **OpenAPI specification stub**: a complete OpenAPI 3.1 specification with a top-level info block, two server entries (production and staging), one tag ("items"), three operations across two paths (list, create, get-by-id on `/items` and `/items/{id}`), and three named schemas (`Item`, `NewItem`, `Error`). Deliberately exercises path parameters, query parameters, request bodies, and component-schema references so the rendered API reference shows non-trivial output out of the box.
- **Example guide**: a markdown page that explains how nested folders become navigation sections, lists three example filename-to-label mappings, and invites the reader to add more `.md` files in the same folder.

## Behavior

### Pre-flight existence check

1. Test whether the target directory already exists on the filesystem.
2. If yes: return immediately with success-false, the input target directory, and a message of the form "Directory already exists: <path>". No filesystem changes are made.

### Directory creation

If the pre-flight check passes:

1. Create the `api/` subdirectory under the target directory, recursively (which also creates the target directory itself if missing).
2. Create the `guides/` subdirectory under the target directory, recursively.

### File writing

After the directories exist, write all five files in parallel:

- The site configuration to `<target>/site.json`.
- The home page to `<target>/index.md`.
- The getting-started guide to `<target>/getting-started.md`.
- The OpenAPI specification stub to `<target>/api/openapi.yaml`.
- The example guide to `<target>/guides/introduction.md`.

All writes use UTF-8 encoding.

### Success path

When all writes succeed, return success-true, the input target directory, and a message of the form "Created <path>".

### Failure path

If any directory creation or file write throws:

1. Catch the error.
2. Normalize it to a message string (the error's message field, or its string form for non-Error throws).
3. Return success-false, the input target directory, and the normalized message.

The scaffolder does not attempt to clean up partial output on failure — files written before the failing operation remain on disk. The caller is responsible for surfacing the failure to the user, who can either remove the partial directory or fix the underlying issue and retry against a new path.

## State Transitions

The target directory transitions through:

- **Absent** → **Populated** on a successful run.
- **Absent** → **Partially-populated** on a mid-write failure; the caller's error message identifies what failed.
- **Existing** → **Existing-unchanged** on the pre-flight rejection path. The directory's prior contents are guaranteed untouched.

## Notable Behavior

### Refusal to overwrite is the only safety net

The scaffolder does not merge into an existing directory, does not back it up, and does not write a single file when the directory already contains content. The pre-flight check is the sole protection against destroying user data; it operates on the target directory as a whole, not per-file.

### Parallel writes after sequential directory creation

The two subdirectories are created sequentially (their parent must exist first), but the five files are written concurrently because none of them depends on the order of the others. This shaves wall-clock time on slow filesystems without complicating the success-path code.

### Theme pack default in the starter configuration

The scaffolded site configuration sets the theme pack to the developer-docs pack. A side comment in the starter file points the reader at how to drop the pack or switch packs. This biases new sites toward a non-default visual presentation while keeping the override path discoverable.

### Navigation entries reflect the starter file set

The navigation entries written into the configuration line up exactly with the starter pages: home, the getting-started guide, the example API reference (rooted at the API stub's path), and the example guide. A reader who runs the starter unmodified sees a working, populated navigation.

### OpenAPI stub deliberately exercises common shapes

The stub specification includes path parameters, query parameters, request bodies, multi-response operations, schema references, and component schemas. This guarantees the rendered API reference shows non-trivial output the moment the starter is built, so a new user can immediately see what the API-reference rendering looks like without first authoring their own specification.

### Single-encoding writes

All five files are written as UTF-8. The OpenAPI stub is a YAML file, the configuration is JSON, and the markdown files are markdown — but the on-disk encoding is uniform.

### Errors include the underlying message

Non-pre-flight failures bubble up the underlying filesystem error message verbatim (or the error's string form for unusual throws), so the caller's user-facing output names the actual cause (permission denied, disk full, etc.) rather than a generic "scaffold failed".

### Result is structurally identical for both rejection paths

Whether the pre-flight rejected the target or a write failed mid-flight, the result has the same three fields. The caller distinguishes by reading the message string. Both paths set success-false; only the success path sets it true.

## Shared Behavior

- **Site configuration parser** — consumes the `site.json` the scaffolder writes; the starter's literal values must be a valid configuration.
- **Site renderer** — operates on the populated content folder when the user runs a build; the starter's structure must be a valid input to that pipeline.
- **OpenAPI rich-renderer pipeline** — consumes the example specification stub when a build runs against the scaffolded folder.
- **Sidebar manifest generator** — walks the populated folder to produce navigation manifests; the starter's nested folder layout exercises the nested-folder branch of that walk.
