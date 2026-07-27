# 72. Docusaurus Sidebar Conversion

## Topic Statement

Converting a Docusaurus sidebar declaration into the documentation site's sidebar overrides and folder path mappings, so the configuration's logical navigation structure can differ from the physical content layout.

## Scope

**In scope:**
- The shape of the input — a parsed Docusaurus sidebar declaration (categories, doc references, links).
- The two outputs — sidebar overrides keyed by directory path, and folder path mappings.
- How a category's logical position in the sidebar tree maps to a logical directory path.
- How a category's actual filesystem location is derived (from `link.id` or the first item).
- Detection of "virtual" categories — groupings whose actual filesystem path matches their parent's, which become flattened into the parent directory.
- Detection of out-of-tree document references that require a folder-level path mapping.
- Treatment of unrecognized item types (currently: skipped).
- Extraction of the favicon path from the framework's main config file via simple text scanning.
- Optional feedback to the caller (informational and warning messages).

**Out of scope:**
- Loading and parsing the input file from disk; the converter accepts an already-loaded module-export shape.
- The detection of which framework the project uses (covered by the documentation-framework-detection topic).
- The use of the resulting sidebar overrides and path mappings during content mirroring (covered by the content-mirroring topic).
- Conversion of sidebar declarations from any framework other than Docusaurus.

## Data Contracts

### Input

The converter accepts the parsed default-export of a Docusaurus sidebar declaration. The export is conceptually a record whose values include at least one array of sidebar items. The converter searches the record's values for the first array and treats its contents as the sidebar items.

A sidebar item is one of:
- A bare string — a doc reference (the slash-separated logical id of a doc).
- A category object: `{ type: "category", label, items, link? }` where `items` is an array of nested sidebar items, and `link` is an optional `{ type, id? }` that points the category at a specific doc.
- A doc object: `{ type: "doc", id, label? }` where `id` is the doc reference and `label` is an optional display label.
- A link object: `{ type: "link", label, href }` for an external or in-site URL.

### Outputs

The converter returns a record with three fields:

- `sidebar`: a sidebar-overrides object keyed by directory path, where each value is an ordered map of `{ key: SidebarItemValue }`. A `SidebarItemValue` is either a string (display label) or an object with `title` and/or `href` and/or `type: "separator"`. Directory paths use a leading `/`; the root is `/`.
- `pathMappings`: an object of `{ source-folder: target-folder }`, where both sides are slash-separated relative paths. Used by content mirroring to remap files that live under a different folder than the sidebar's logical structure expects.
- `favicon` (optional): a path to a favicon file extracted from the framework's main config, when one was found. Set on the result by the bootstrap flow (not by the core conversion), via a separate extraction routine.

### Sidebar key derivation

For each sidebar item the converter derives a key (the property name used inside the per-directory ordered map):
- Bare string or `doc` item: the last segment of the doc id, with the special case that when the last segment is `index` and there is more than one segment, the second-to-last segment is used instead.
- Category: the last segment of the category's actual filesystem directory (see "Category actual directory" below).
- Link: a slugified version of the label (lowercase, non-alphanumerics collapsed to single dashes, leading/trailing dashes stripped).

### Sidebar value derivation

- Bare string: the display label is the title-cased version of the key (replace `-` and `_` with spaces, uppercase the first letter of each word).
- `doc` item: the explicit `label` if provided, otherwise the title-cased key.
- Category: the category's `label` verbatim.
- Link: `{ title: <label>, href: <sanitized-href> }`. The `pathname://` prefix, used by Docusaurus for in-site links, is stripped from the href.

### Category logical directory

A category's children are placed at a "logical directory" path computed by appending the category's resolved key to the parent's logical directory. The root logical directory is `/`. A child of root with key `pipelines` has logical directory `/pipelines`.

### Category actual directory

A category's actual filesystem directory is computed as:
1. If the category has `link.id`, drop the last slash-separated segment of the id (treating it as the filename) and join the remaining segments under a leading `/`.
2. Otherwise, look at the first item in the category's items list:
   - If it is a bare string with at least one slash, drop the last segment and use the rest under a leading `/`.
   - If it is an object with `id` and the id has at least one slash, do the same with the id.
3. If neither yields a path, fall back to `/<slugified-label>`.

### Path mapping rules

Two situations produce a path-mapping entry:

1. **Category with mismatched actual directory.** When a category's logical directory differs from its actual filesystem directory (and both are non-empty), record `pathMappings[<actual-relative>] = <logical-relative>` (relative paths, no leading slash).

2. **Doc reference outside its logical directory.** When a doc's id has at least two slash-separated segments and its actual parent directory does not start with the logical directory it appears in (per a string-prefix check), record `pathMappings[<actual-parent>] = <logical-parent>/<actual-leaf-folder>`. Only the first such mapping per actual-parent wins; subsequent docs sharing the same actual-parent do not overwrite it.

### Virtual category detection

When a category's actual filesystem directory equals the parent's actual filesystem directory (i.e., the category groups items already inside the parent's folder), the category is treated as "virtual": no sidebar entry is emitted for it, no path mapping is added, and its items are recursed directly into the parent's logical directory. This handles cases like a Docusaurus "Operations" category that visually groups several files inside `sql/` without creating a real `sql/operations/` folder.

The "parent's actual filesystem directory" is resolved via the inverse of the recorded path mappings: scan known mappings to see if any target equals the parent's logical directory; if so, the parent's actual directory is the corresponding source. Otherwise the parent's actual directory is its logical directory.

### Favicon extraction

The bootstrap flow may also call a separate routine that takes the framework's main config file path, reads it as text, scans for `favicon: "<value>"` (or `'<value>'`) using a simple text match, and returns a path computed by joining: the directory of the config file, the conventional `static` subfolder, and the captured value. Returns undefined when no match is found or the file cannot be read.

## Behavior

### Top-level conversion

1. Find the first array value among the input record's values; treat it as the sidebar items list. If no array is found, log a warning ("Could not find sidebar items in the Docusaurus config.") and return empty sidebar and empty path mappings.
2. Walk the items recursively starting at logical directory `/`, populating the sidebar entries (a per-directory ordered list of `[key, value]` pairs) and the path-mappings record.
3. Convert the per-directory ordered lists into the final sidebar-overrides object (one ordered map per directory).
4. Return the sidebar overrides and path mappings.

### Per-item handling

- **Bare string:** add a sidebar entry under the current logical directory with the derived key and title-cased label, then check whether the doc requires a folder-level path mapping (per the "doc reference outside its logical directory" rule).
- **`doc` item:** same as bare string, except the label can be overridden by the explicit `label` field.
- **`category` item:**
  - Compute the actual filesystem directory and the parent's actual filesystem directory.
  - If they are equal, recurse directly into the parent's logical directory (virtual-category flatten); do not add a sidebar entry, do not record a path mapping.
  - Otherwise, derive the category key, add a sidebar entry under the current logical directory using the category's `label`, compute the child logical directory, optionally record a path mapping when the relative paths differ, and recurse into the child logical directory.
- **`link` item:** add a sidebar entry under the current logical directory with key = slugified label, value = `{ title: label, href: sanitized-href }`.

### Duplicate-key suppression

When adding a sidebar entry, if the per-directory list already contains an entry with the same key, the new entry is skipped (first-write-wins).

### Unrecognized item types

Items whose `type` is not `category`, `doc`, or `link`, and which are not bare strings, are silently skipped. (A future change may promote this to a logged warning per the assignment's intent; today the converter does not emit a warning for unknown types.)

### Sidebar load helper

A helper used by the bootstrap flow loads the user's sidebar declaration from a `.js` or `.ts` file by importing the file URL, returning either the module's `default` export or the module itself, falling back to an empty record on import error. On error, it logs `Could not load <path>. Skipping sidebar conversion.`

## State Transitions

The converter is stateless across invocations. Within a single invocation it accumulates two collections (the per-directory sidebar-entries map and the path-mappings record) by walking the input once. There are no externally-observable state transitions.

## Notable Behavior

- **Logical vs. physical separation is the whole point.** Docusaurus sidebars routinely group a doc whose physical id is `use_cases/fraud_detection/fraud_detection` under a "Tutorials" category. The converter records this by emitting a sidebar entry at logical directory `/tutorials` and a path mapping `use_cases/fraud_detection → tutorials/fraud_detection`. The mirroring step then physically moves files to match.
- **Virtual categories flatten silently.** A category whose actual directory matches its parent's is collapsed into the parent. No sidebar entry, no path mapping, no log line. This is intentional — those categories exist purely as visual groupings in the Docusaurus rendering and should not produce phantom subfolders in the output.
- **First doc wins for category actual-dir derivation.** When a category lacks `link.id`, the converter inspects the first item to infer the category's filesystem location. If the items mix folders, only the first folder is used; out-of-place items get caught by the per-doc path-mapping rule instead.
- **Index files compress the key.** A doc id ending in `/index` collapses to its parent's last segment as the sidebar key. Without this rule, every `index.md` in a Docusaurus project would land under the key `index`.
- **First-write-wins on duplicate sidebar keys.** If the same key is added twice to the same directory, the second add is dropped. This favors the order Docusaurus declared the items.
- **First-write-wins on duplicate path mappings.** If two docs share the same actual-parent, only the first mapping is recorded. This means a folder's mapping is set by the first doc that triggers it; later docs in the same folder do not overwrite the mapping.
- **Link href sanitization is partial.** Only the `pathname://` prefix is stripped. Other potentially-unsafe schemes (e.g., `javascript:`) pass through unchanged at this layer; downstream rendering applies its own sanitization.
- **No conflict detection between categories and docs.** If a `doc` and a `category` produce the same sidebar key, the second one is silently skipped per the duplicate-key rule. The converter does not warn about this.
- **Favicon extraction is regex-based.** The framework's main config file may be TypeScript; rather than executing it, the converter scans the text for the first `favicon: "..."` or `favicon: '...'` and trusts the captured value. The path is then composed as `<config-dir>/static/<captured>`, matching Docusaurus's convention of serving favicons from a sibling `static/` directory. On any read or parse failure, returns undefined.
- **Items array discovery uses "first array".** The Docusaurus sidebar export may be an object with multiple sidebar IDs; the converter picks the first array among the export's values rather than asking the caller which sidebar to convert. Multi-sidebar projects therefore lose all sidebars except the first.
- **Path mappings use forward slashes regardless of platform.** Both the keys and values are slash-separated; downstream consumers normalize platform-specific separators before matching.

## Shared Behavior

- The detector that triggers this converter is defined by the documentation-framework-detection topic.
- The bootstrap flow that calls the converter and writes its results into `site.json` is defined by the site-configuration-discovery topic.
- The path mappings produced here are consumed during content mirroring; see the content-mirroring topic for how source files are rewritten to match the logical structure.
- The sidebar overrides produced here are consumed at sidebar-file generation time (a separate topic) to write per-directory `_meta.js` files.
