# Meta Sidebar Generation

## Topic Statement

A traversal that walks the staged content tree and writes one navigation manifest per folder, using customer-declared sidebar overrides where present and falling back to a deterministic alphabetical default everywhere else.

## Scope

**In scope:**
- Per-folder navigation manifest generation across the staged content directory.
- The two ordering modes (declared overrides versus alphabetical default) and the rule that picks between them.
- Label derivation for default ordering (title-casing of the filename stem).
- Index-page suppression so a folder's own page does not also appear as a child entry.
- The folder-emptiness check that skips manifest emission entirely when a folder contributes nothing visible.
- The OpenAPI sibling generator, contrasted only enough to mark it as out-of-band (its own ordering rules, not this topic).

**Out of scope:**
- The mechanics of staging content into the build directory.
- The format of the site configuration block that holds the overrides.
- The OpenAPI tag/operation ordering rules (covered by the OpenAPI emitter topic).
- Page rendering, link resolution, or any runtime navigation behavior.

## Data Contracts

### Per-folder input

Each folder visited carries:

- **folder path on disk** — used both to read children and to derive the lookup key for overrides.
- **child entries** — the folder's direct children (subfolders that recursively contain content; markdown and MDX files at this level). Hidden files (leading dot) and the manifest file itself are excluded.
- **path key** — a forward-slash-rooted, OS-separator-normalized relative path from the content root, with a trailing slash trimmed; the root folder's key is `/`.

### Sidebar overrides

A nested map keyed by path key. Each entry maps an item's filename stem to either:

- A plain string (display label), or
- An object (label-plus-extras, e.g. external link, separator, hidden flag).

### Manifest entry

A single record holding:

- **key** — the navigation key, equal to the filename stem.
- **value** — either a plain string label or a structured record.

### Output manifest

A JavaScript module that default-exports an object whose keys are filename stems in iteration order and whose values are the per-entry display label or structured record. Written as the file `_meta.js` in the folder.

## Behavior

### Top-level walk

1. Start at the content root with the supplied overrides.
2. Recursively process each subfolder before deciding whether to emit a manifest for the current folder.

### Per-folder processing

1. Read the folder's direct children. If unreadable, treat as empty and report "no content".
2. For each child:
   - Skip hidden files (leading dot) and any existing manifest file.
   - Subfolders: recursively process; include the subfolder name as a content item only if the recursion reports the subfolder produced content.
   - Files: include only those with a markdown or MDX extension.
3. If no content items survived, report "no content" and do not emit a manifest for this folder.
4. Compute the folder's path key (root-relative, slash-rooted, trailing-slash trimmed).
5. Look up the overrides entry for that path key.
6. Build the manifest entries (see below).
7. If at least one manifest entry is visible (i.e. has a string value, or an object value whose `display` field is not `"hidden"`), write the manifest. Otherwise skip the write.
8. Report "has content" so the parent folder counts this subfolder.

### Default ordering (no overrides for this path key)

1. For each content item, derive the entry key by stripping the file extension from the filename (subfolder names are used unchanged).
2. If the key is `index`, emit a manifest entry whose value is the structured record `{ display: "hidden" }` and mark the key as seen.
3. For every other key not yet seen, emit a manifest entry whose value is the title-cased form of the key (hyphens and underscores become spaces; the first letter of each resulting word is uppercased).
4. Sort all emitted entries alphabetically by key, applying the sort across both the index entry and the visible entries.

### Override ordering (overrides exist for this path key)

1. If the folder physically contains an `index` file but the override map does not declare an `index` key, prepend a manifest entry with value `{ display: "hidden" }` so the index page does not also appear as a visible child.
2. Walk the override map in declaration order. For each entry, emit a manifest entry whose value is the override value verbatim — strings stay strings, objects stay objects.
3. Do not append any filesystem children that the override did not declare; the underlying docs framework appends those alphabetically at runtime.

### Label transformation (default mode only)

The title-case helper takes a filename stem and:

- Replaces every hyphen and underscore with a space.
- Uppercases the first letter of every whitespace-bounded word.

No other normalization is applied (acronyms, casing of internal letters, and pluralization are left alone).

### Index-only folder skip

After building the manifest entries, the writer checks whether any visible entry exists. A visible entry is one whose value is a plain string, or one whose value is an object whose `display` field is anything other than `"hidden"`. If none is visible (the only entry is the hidden index), no manifest file is written at all — the underlying docs framework would otherwise refuse to prerender a folder whose manifest declares no visible navigation children.

### Manifest serialization

Entries are written as `"<key>": <value>,` lines, where the value is the JSON-stringified form of an object value or the bare double-quoted string for a string value. The lines are wrapped in a default-exported object. The folder is created if missing before the file is written.

## State Transitions

A folder visited by the walk transitions through:

- **Entered** → **No-content** when no qualifying child survives the filter; reported back to the parent as "skip me".
- **Entered** → **Visible-only** when at least one entry would render; manifest is written.
- **Entered** → **Hidden-only** when the only content is an index file with no other children; manifest is suppressed but the folder still reports "has content" so the parent navigation can include it.

## Notable Behavior

### Forward-slash path keys regardless of platform

Path keys are always slash-rooted with forward slashes, even on platforms whose native path separator is a backslash. This keeps override declarations in the site configuration portable across operating systems.

### Trailing-slash trimming

A trailing slash is stripped from path keys so the root folder's key is exactly `/` and a nested folder's key is exactly `/foo/bar` (never `/foo/bar/`).

### Hidden-index entry value is structured, not string

The hidden-index entry uses the structured form `{ display: "hidden" }` rather than a string label. This is necessary because the underlying docs framework treats unrecognized strings as labels and would auto-render the index as a duplicate child.

### Override values pass through unchanged

When an override declares a string label, that string is emitted verbatim. When it declares an object (external link, separator, hidden flag), the entire object is JSON-serialized into the manifest. Override author retains full control over the entry shape.

### Filesystem-only items in override mode are not auto-appended by this generator

In override mode the manifest contains only the declared keys. Items that exist on disk but are not mentioned in the override are intentionally omitted from the manifest; the underlying docs framework handles their alphabetical appendix at runtime. This generator does not duplicate that work.

### Subfolder content gating

A subfolder is only counted as a content item if its own recursive walk produced something — either a manifest was written, or a deeper folder produced one. This prevents empty scaffolding directories from appearing in parent navigation.

### The OpenAPI emitter is a separate path

Per-spec OpenAPI sidebars (one folder per spec, with an Overview entry plus one entry per tag, and per-tag folders listing operations in spec order) are generated by a different emitter that does not consult overrides at all and uses its own ordering rules driven by the parsed spec. This topic does not cover that path beyond noting it exists.

## Shared Behavior

- **Site configuration parsing** — produces the sidebar overrides map keyed by path key.
- **Content staging** — populates the directory tree this generator walks, including translation of source files into markdown/MDX shape.
- **OpenAPI sidebar emitter** — generates per-spec navigation manifests through a parallel pipeline with its own ordering rules.
- **Underlying docs framework** — consumes the emitted manifests and is the system that auto-appends unlisted children alphabetically at runtime.
