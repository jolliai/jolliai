# 75. Image Asset Resolution

## Topic Statement

Resolving image references that would otherwise be broken in the mirrored content by searching upward from the source folder for a matching file, copying it under a deduplicated name, or generating a placeholder when no source can be found.

## Scope

**In scope:**
- The triggering condition: a markdown image whose path does not resolve in the staged content directory.
- The set of locations searched outside the source folder when looking for a matching file (the "upward search").
- The deduplicated naming applied to copied external assets.
- The conventional destination folder `public/images/` under the build directory.
- The placeholder generation: an SVG with a "missing image" indicator and the original filename embedded, written to the same destination folder.
- The result returned to the caller, which is fed back into the markdown to rewrite the image reference.
- The two reference styles handled: relative references (e.g., `../static/logo.svg`) and root-absolute references (e.g., `/img/logo.svg`).

**Out of scope:**
- Image references whose path resolves successfully inside the staged content (the mirror leaves them unchanged).
- Images already present alongside the markdown in the source (covered by the content-mirroring topic, which copies them as part of the regular mirror).
- The favicon, which has its own resolution flow (covered by the favicon-resolution topic).
- The actual rewrite of the markdown text after resolution; this topic only describes the resolver and what is written to the build's `public/` folder.

## Data Contracts

### Inputs to the resolver

- `relImagePath`: the image reference as written, with two recognized shapes:
  - A relative path resolved against the markdown file's original source directory (e.g., `../../static/img/logo.svg`).
  - A root-absolute path with the leading `/` stripped before being passed in (e.g., `img/logo.svg` after stripping the `/`).
- `originalMdDir`: absolute path to the markdown file's original source directory (used as the anchor for relative-path resolution).
- `sourceRoot`: absolute path to the documentation source folder (used to determine candidate search locations).

### Search locations (in order)

The resolver tries the following candidates and stops at the first that exists:

1. The path obtained by resolving `relImagePath` against `originalMdDir`.
2. `<projectRoot>/static/<relImagePath>` — the conventional Docusaurus static-assets directory under the project root.
3. `<projectRoot>/<relImagePath>` — directly under the project root.
4. `<sourceRoot>'s parent>/static/<relImagePath>` — when the source folder is one level below the project root, this picks up the static directory next to it.
5. `<sourceRoot>'s parent>/<relImagePath>` — directly in the source folder's parent.

The "project root" is determined by walking upward from the source folder for up to five levels, looking for any of these markers: `package.json`, `.git`, `docusaurus.config.ts`, `docusaurus.config.js`. The first directory containing any marker wins. If none is found within five levels, the project root falls back to the source folder's parent.

### Deduplicated naming

When a candidate file is found, its public name is derived from its absolute path relative to the project root:
- Replace path separators (forward and backward) with `-`.
- Preserve the file extension.
- Result: `static-img-logo.svg` for an absolute path of `<projectRoot>/static/img/logo.svg`.

If the absolute path does not start with the project root (e.g., the file lives outside the project), only the basename is used and no path-segment-derived dedup is applied.

The public-relative path returned is `images/<derived-name>`.

### Placeholder naming and generation

When no candidate exists:
- The placeholder filename is derived from the basename of the requested reference:
  - Strip the original extension.
  - Prepend `placeholder-`.
  - Append `.svg`.
  - Example: a missing `logo.png` becomes `placeholder-logo.svg`.
- The placeholder content is an SVG of dimensions 400×300 with a light-grey background and two text rows: a "Missing image" line and the original filename (XML-escaped) underneath. Specifically:
  - Outer rectangle filled `#f5f5f5`, stroke `#ddd` of width 2.
  - Top text "Missing image" at 50% / 40% in `#999`, sans-serif, 18pt.
  - Bottom text with the original filename at 50% / 55% in `#666`, monospace, 12pt.
  - XML special characters in the filename are escaped (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`).

### Result returned to caller

The resolver returns a record with three fields:
- `sourcePath`: the absolute path of the found file, or undefined when a placeholder was chosen.
- `publicPath`: the path relative to the build's `public/` folder, always of the form `images/<filename>`.
- `isPlaceholder`: true when no source was found (placeholder will be generated), false when a real file will be copied.

The caller is responsible for rewriting the markdown image reference to `/<publicPath>`.

### Copy/write step (separate operation)

A separate operation accepts the result above plus the build's `public/` directory and either:
- Copies `sourcePath` to `<publicDir>/<publicPath>` (creating intermediate directories as needed), when `sourcePath` is set.
- Writes the placeholder SVG to `<publicDir>/<publicPath>` (creating intermediate directories as needed), when `sourcePath` is unset. The placeholder text is derived by stripping the leading `placeholder-` and the trailing `.svg` from the public filename.

## Behavior

### Trigger conditions

The resolver is invoked by the content-mirror's missing-image pass when a markdown image reference cannot be resolved by simply locating it inside the staged content. Two reference shapes lead here:

- **Root-absolute reference** (begins with `/`): the leading `/` is stripped, the source folder's parent is used as the markdown's "original directory" anchor, and the resolver is invoked. This handles the Docusaurus convention of writing `/img/foo.png` and serving from a project-level `static/` folder.
- **Relative reference whose target does not exist in the staged content**: the resolver is invoked with the markdown file's original source directory as the anchor.

References to absolute URLs (`http*`) and references that resolve successfully inside the staged content are not triggered.

### Search algorithm

1. Determine the project root by walking up from `sourceRoot` looking for a marker (see above).
2. Compute the five candidate paths in order.
3. Test each candidate for existence; the first hit wins.
4. On hit: derive the deduplicated public name and return the resolved record with `isPlaceholder = false`.
5. On no hit: derive the placeholder name and return the resolved record with `isPlaceholder = true` and `sourcePath` undefined.

### Public-name derivation

For a found file at absolute path `A` and project root `P`:
- If `A` starts with `P` followed by a path separator: the relative-from-root part is taken (everything after `P` and the separator), its path separators are replaced with `-`, and the result is the public filename.
- Otherwise: only the basename of `A` is used.

Either way, the result is prefixed with `images/` to form the `publicPath`.

### Materialization

After mirroring all markdown files and queuing all resolved-or-placeholder assets, the caller invokes the copy/write operation for each asset in turn. Found files are copied; missing ones are written as placeholder SVGs.

## State Transitions

The build's `public/images/` folder moves through these states across a single mirror run:

- **Pre-resolve:** `public/images/` may not exist yet, or may contain stale entries from a previous run.
- **Queued:** the mirror has identified one or more missing references and computed resolved records for each.
- **Materialized:** each queued asset has been written (copied or placeholder) into `public/images/`.

The mirror does not clear `public/images/` between runs in this resolver's contract; stale assets from prior runs may remain unless cleaned up at a higher level.

## Notable Behavior

- **Search order is deliberate.** The first candidate is the markdown's own resolved relative path (covers in-tree references), then Docusaurus-style `static/` lookups at both project root and source-folder parent. This handles the common cases without requiring the user to reorganize their assets.
- **Project-root walk caps at five levels.** This bounds the search and avoids scanning the entire filesystem on misconfigured projects. If no marker exists within five levels, the source-folder parent is used as a fallback project root.
- **Markers are conventional.** `package.json`, `.git`, `docusaurus.config.ts`, `docusaurus.config.js` cover npm projects, git repositories, and the Docusaurus convention. Other project layouts (e.g., a bare folder) fall back to the source-folder parent.
- **Public name is a hash-free fingerprint.** Rather than a content hash, the dedup uses the source's path-from-project-root with separators replaced. Two different files that happen to share a basename do not collide as long as they live in different folders. Two distinct files with identical relative paths from the project root would collide; this would only happen if the same relative path resolved to two different files in the candidate search, which the search-order rule prevents (first hit wins).
- **The dedup is by source path, not by content.** If the same file is referenced by two markdown files, both references resolve to the same `images/<name>` and the file is copied once (the second copy overwrites the first byte-for-byte). The result is deduplication-by-source-path, which is sufficient because the search-order is deterministic.
- **Placeholders are also written to `public/images/`.** They are SVGs with a fixed shape that includes the original filename. This makes broken references obvious during development: users see a labeled placeholder rather than a broken-image icon.
- **Placeholder XML-escapes the filename.** Filenames containing `&`, `<`, or `>` are escaped before being embedded in the SVG to keep the SVG well-formed.
- **The resolver does not write to disk.** It returns a resolved record; the materialization step is a separate operation invoked once per queued record. This lets the caller batch work and run the searches before any I/O.
- **Resolution is stateless across calls.** No memoization is performed. If the same reference appears in many markdown files, the search runs once per occurrence.
- **The result feeds back to the caller for rewrites.** The caller substitutes `/<publicPath>` for the original reference in the markdown text. Without this rewrite the resolved file would land in `public/images/` but the markdown would still point at the original (broken) path.

## Shared Behavior

- The mirror's missing-image pass that triggers this resolver is defined by the content-mirroring topic.
- The build's `public/` directory is created by the project-scaffold step (covered by the Nextra-project-scaffold topic) before the mirror runs.
- The favicon resolver lives in the same module and shares the same destination folder convention; see the favicon-resolution topic.
- The deduplicated naming and the placeholder-SVG layout are user-visible artifacts that downstream sites and contributors may inspect; treat them as part of the public contract.
