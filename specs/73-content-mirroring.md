# 73. Content Mirroring

## Topic Statement

Mirroring a source content folder into the staged build directory by classifying every file as markdown, image, OpenAPI, or ignored, then copying or transforming each accordingly while applying any folder-level path remappings.

## Scope

**In scope:**
- The recursive walk over the source content folder.
- The classification rules that decide whether a file is markdown, an image, an OpenAPI document, or ignored.
- The copy/transform actions performed for each classification.
- Application of folder-level path mappings when the source folder must be remapped to a target folder in the build directory.
- The rewriting of relative image references inside markdown files when the file itself was remapped.
- The interaction with the configured-but-disjoint OpenAPI-rendering pipeline (boundary): for OpenAPI files, the parsed document is captured and returned to the caller; the file itself is not copied.
- The clearing of stale content from the build directory before mirroring.
- The skip of the build-output subfolder to prevent infinite recursion.
- The "ensure an index page exists at the build root" guarantee.
- Resolving missing image references in mirrored markdown by searching outside the source folder or generating placeholders.
- The `MirrorResult` returned to the caller (counts and relative paths per category).

**Out of scope:**
- The MDX-vs-MD downgrade decision and rewriting (covered by the MDX-downgrade-detection topic).
- Image-asset resolution outside the source folder and placeholder generation (covered by the image-asset-resolution topic).
- Favicon resolution (covered by the favicon-resolution topic).
- The OpenAPI rendering pipeline that consumes the captured documents (covered by separate OpenAPI topics).
- The Nextra project scaffold written into the build directory before mirroring (covered by the project-scaffold topic).

## Data Contracts

### Inputs

- `sourceRoot`: absolute path to the user's content folder.
- `contentDir`: absolute path to the staged content directory inside the build directory (where mirrored markdown and images land).
- `pathMappings` (optional): a folder-level remapping table where each key is a source folder path (slash-separated, no leading slash) and each value is the target folder path. Any source file under the key is rewritten to live under the value.
- `publicDir` (optional): absolute path to the build directory's `public/` folder, used as the destination for missing-image placeholders and for assets resolved outside the source folder.
- `contentRules` (optional): renderer-specific rules used by the MDX-downgrade decision (covered by its own topic).

### File classification (`classifyFile`)

Files are classified by extension, with one content-sniffing exception:

- Extension `.md` or `.mdx` → `markdown`.
- Extension `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, or `.ico` → `image`.
- Extension `.json`, `.yaml`, or `.yml`:
  - When file content is provided to the classifier and a parse-and-validate step succeeds (the content has both an `openapi` field and an `info` object structurally — the OpenAPI structural check is owned by a separate spec-loader topic) → `openapi`.
  - Otherwise → `ignored`.
- Any other extension → `ignored`.

### Skipped during traversal

The traversal explicitly skips the entry name `.jolli-site` (the staged build directory itself, often nested inside the source folder). This is necessary because the source content folder and the build directory may share an ancestor, and the build directory is normally a hidden subfolder of the project. The skip prevents the mirror from recursively copying the build directory into itself.

Other categories of files (dotfiles, build outputs from other tools, lockfiles, etc.) are not specifically excluded — they fall into the `ignored` category by virtue of having an unrecognized extension. They are still listed in the result's `ignoredFiles` array, but no copy or transform happens.

### MirrorResult

The mirror returns a record with these fields:

- `markdownFiles`: array of relative paths (from `contentDir`) of markdown files written.
- `openapiFiles`: array of relative paths of OpenAPI documents detected (relative to `sourceRoot`, then through path mappings).
- `openapiDocs`: an object mapping the relative path of each detected OpenAPI file to its parsed document (the structured AST). Provided so the caller's renderer pipeline can consume the parsed document without re-reading or re-parsing the source file.
- `imageFiles`: array of relative paths of image files copied into `contentDir`.
- `ignoredFiles`: array of relative paths of files that were classified as ignored.
- `downgradedCount`: integer count of `.mdx` files that were downgraded to `.md` during mirroring.
- `renamedToIndex` (optional): if a root-level markdown file with `slug: /` frontmatter was renamed to `index.md`, this is the old filename's stem (without extension); otherwise undefined.

### Path-mapping application

Applied per file at copy time. Given a source-relative path and a `pathMappings` table, the mapping logic:
1. Normalizes the source path to forward slashes.
2. For each mapping entry, checks whether the normalized path is exactly equal to the source key or starts with `<source-key>/`.
3. On match, replaces the matched prefix with the target value and uses the result as the destination relative path.
4. If no entry matches, the path is left unchanged.

Mappings are checked in iteration order; the first match wins.

### Image-path rewrite (within remapped markdown)

When a markdown file is itself remapped (its destination directory differs from its source directory), the relative image references in the file are rewritten so they still point at the correct image after the move:
1. For each relative image reference (Markdown `![alt](path)` or HTML `<img src="path">`):
   - Skip if the path is absolute (begins with `/`) or starts with `http`.
   - Skip if the path's extension is not one of the recognized image extensions.
   - Resolve the path against the original source directory to compute an absolute-from-source-root path.
   - Apply the same path mapping table to that absolute path (the image may have moved with the file's folder).
   - Compute a new relative path from the new (target) directory.
   - Substitute the new path in place.
2. If the original directory and new directory are identical, the rewrite is a no-op and the content is left unchanged.

## Behavior

### Top-level flow (`mirrorContent`)

1. Clear stale content from `contentDir` (delete every entry inside it but keep the directory itself).
2. Initialize an empty `MirrorResult`.
3. Recursively walk `sourceRoot`. For each entry:
   - If the entry name is `.jolli-site`, skip it.
   - If the entry is a directory, recurse.
   - If the entry is a file, process it (see "Per-file processing" below).
   - Failures to read a directory or stat an entry are silently ignored (the entry is skipped).
4. After the walk completes, run the "ensure index page" guarantee (see below).
5. If `publicDir` was provided, run the "resolve missing images" pass (see below).
6. Return the `MirrorResult`.

### Per-file processing

1. Compute `originalRelPath` = source file's path relative to `sourceRoot` (as written on disk).
2. Compute `relPath` = `originalRelPath` after applying `pathMappings`.
3. Branch on extension:

#### Potential OpenAPI files (`.json`, `.yaml`, `.yml`)

1. Read the file's text content. On read failure, push `relPath` into `ignoredFiles` and stop.
2. Run the structural OpenAPI check on the content (boundary into the spec-loader topic).
3. If the content is OpenAPI:
   - Push `relPath` into `openapiFiles`.
   - Store the parsed document into `openapiDocs[relPath]`.
   - **Do not copy the file into `contentDir`.** OpenAPI files are consumed by a separate renderer that emits per-endpoint MDX shims; copying the raw file would create unused content.
4. If the content is not OpenAPI, push `relPath` into `ignoredFiles`.

#### Markdown (`.md`, `.mdx`)

1. For `.mdx`: run the MDX-downgrade decision (covered by the MDX-downgrade-detection topic). If the decision is "downgrade," strip incompatible content, write the result as `<relPath without .mdx>.md`, push the new path into `markdownFiles`, increment `downgradedCount`, and stop.
2. Otherwise, push `relPath` into `markdownFiles`. Ensure the destination directory exists.
3. If `originalRelPath` differs from `relPath` (the file was remapped), read the source content, rewrite relative image paths against the new directory (per "Image-path rewrite" above), and write the rewritten content to the destination.
4. If the file was not remapped, copy the source file directly to the destination (preserves byte-for-byte content; no transform).

#### Images

1. Push `relPath` into `imageFiles`.
2. Ensure the destination directory exists.
3. Copy the source file directly to the destination. Images live next to the markdown that references them in the staged content directory; they are not moved into the build directory's `public/` unless they need cross-folder resolution (handled by the missing-image pass).

#### Ignored

Push `relPath` into `ignoredFiles`. Take no other action.

### Stale-content clear

Before mirroring, every entry inside `contentDir` is deleted (recursively, force). This guarantees that files removed from the source do not linger in the staged build. The `contentDir` itself is preserved.

### Ensure-index guarantee

After the walk, the result's markdown list is checked for `index.md` or `index.mdx` at the root. If neither is present, the mirror scans the root-level markdown files for one whose frontmatter contains `slug: /`. If found, the file is renamed in place to `index.md`, the entry in `markdownFiles` is updated, and the old filename's stem is recorded in `renamedToIndex`. This handles Docusaurus projects that designate a homepage via `slug: /` rather than a literal `index.md`.

If no `slug: /` candidate exists either, the result has no `index.md` at the root and the build will fall back to whatever the framework provides (typically a directory listing).

### Resolve-missing-images pass

When `publicDir` is provided, the mirror walks every mirrored markdown file and inspects each markdown image and HTML `<img>`:

- Reference is absolute (`http*` URL): skipped.
- Reference begins with `/` (root-relative): treated as a "static" reference; resolution is delegated to the asset-resolver (covered by the image-asset-resolution topic), which searches outside the source folder and either copies the found file or generates a placeholder. The reference in the markdown is rewritten to `/<resolver-public-path>`.
- Reference is relative: resolved against the markdown's own directory in the staged content. If the file exists there, the reference is left unchanged. If not, the asset-resolver is invoked using the markdown file's original source directory; the markdown reference is rewritten to point at the resolver's public path. The original-directory choice matters: it lets the resolver search upward from where the user wrote the markdown, not from where the file landed after path mapping.

After all rewrites, every queued resolved-or-placeholder asset is copied (or written) into the build directory's `public/` subfolder.

If `publicDir` was not provided, this pass is skipped entirely; missing images remain broken in the output.

### What is included vs. excluded

- Included: `.md`, `.mdx`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, `.ico`, OpenAPI `.json`/`.yaml`/`.yml` files (the parsed document, not the file itself).
- Excluded (silently ignored): every other extension, including `.bmp` (despite appearing in a related extension list elsewhere — the classifier does not treat it as an image), other JSON/YAML files, source code, lockfiles, dotfiles, build outputs of other tools, etc.
- Skipped during traversal: any directory or file named `.jolli-site`.

## State Transitions

The mirror operation moves the staged content directory through these states per run:

- **Pre-mirror:** `contentDir` may contain stale files from a previous run.
- **Cleared:** `contentDir` is empty (entries removed).
- **Mirrored:** `contentDir` contains the freshly walked source files (markdown + images, possibly remapped, with rewrites applied).
- **Index-ensured:** if needed, a root-level `slug: /` markdown was renamed to `index.md`.
- **Images-resolved:** if `publicDir` was provided, missing-image references in markdown were rewritten and placeholder/external assets were materialized in `public/images/`.

The transitions are linear within a single run; the mirror is invoked again on the next build to reset to the latest source state.

## Notable Behavior

- **OpenAPI files are not copied.** They are detected by content-sniffing JSON/YAML and their parsed document is captured in `openapiDocs` for the renderer pipeline. The raw file never lands in `contentDir`. This means a user who places an OpenAPI spec in their source folder will not see it in the staged content as a downloadable file; if they want a downloadable spec they must put it under `public/`.
- **JSON/YAML files that are not OpenAPI are ignored.** They are not copied into `contentDir`. There is no pass-through for arbitrary JSON or YAML data files.
- **Image extension list differs by branch.** The classifier accepts `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, `.ico`. The image-rewrite regex elsewhere also accepts `.bmp`, but a `.bmp` file would be classified as `ignored` and never copied. Consequence: `.bmp` references inside markdown could be rewritten but the underlying file would not be present in the output.
- **Stale-content clear is unconditional.** Every entry in `contentDir` is deleted at the start of every run. This means anything written into `contentDir` by a previous step or by hand is lost on the next mirror.
- **`.jolli-site` skip is hardcoded.** The traversal skips this single name regardless of where it appears in the tree, so a user-named folder of the same name would also be skipped.
- **Walk silently absorbs filesystem errors.** Failure to `readdir` a directory or `stat` an entry causes that entry to be skipped without a warning.
- **Path mappings apply to image references too.** When a markdown file is remapped, the relative image rewrite resolves the image against the original directory, then re-applies path mappings, then computes a new relative path. This handles the case where both the markdown and its images were moved together.
- **`renamedToIndex` is the caller's hook for sidebar adjustment.** When the mirror renames a `slug: /` file to `index.md`, the original key (e.g., `what-is-our-product`) may still appear in the configuration's sidebar overrides; the caller is expected to use `renamedToIndex` to suppress or relabel that key.
- **`openapiDocs` is the parse-once cache.** Callers that want to render OpenAPI documents must use the AST from `openapiDocs[relPath]` rather than re-reading and re-parsing the source file. This is a deliberate boundary: parsing happens here once per build.
- **Image references with absolute paths (`/...`) trigger external resolution.** This handles the Docusaurus `static/` convention, where the user writes `/img/foo.png` in their markdown and the framework serves `static/img/foo.png`. The mirror's external-resolver searches the project's `static/` folder and copies the file to `public/images/<unique-name>`, then rewrites the reference in the markdown.
- **Per-folder index requirement is partial.** The "every folder gets at least an index" guarantee is implemented only at the build root (the source folder's top level). Subfolders are not given a synthesized `index.md` if they lack one; the framework's directory-listing default applies.
- **Read failures during markdown rewrite fall back to copyFile.** If the source file cannot be read for the rewrite step, the mirror falls back to a byte-for-byte copy of the source file to the destination, even though the relative image paths inside will be wrong post-move. This is a soft-failure mode.

## Shared Behavior

- The MDX-vs-MD downgrade decision used during markdown processing is defined by the MDX-downgrade-detection topic.
- The external-image search and placeholder generation used by the resolve-missing-images pass is defined by the image-asset-resolution topic.
- The structural OpenAPI check used by the JSON/YAML classification branch is defined by the OpenAPI spec-loader topic.
- The site configuration that supplies `pathMappings` is defined by the site-configuration discovery topic.
- The Nextra project scaffold that creates `contentDir` and `publicDir` before mirroring is defined by the Nextra-project-scaffold topic.
- The downstream consumers of `MirrorResult` include sidebar generation, OpenAPI rendering, and the static-build runner.
