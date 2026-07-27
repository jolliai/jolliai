# 74. MDX Downgrade Detection

## Topic Statement

Deciding whether a source `.mdx` file uses imports or components that the build framework cannot resolve and downgrading it to plain `.md` when it would otherwise fail to compile.

## Scope

**In scope:**
- The two-layer check that decides whether an MDX file is "incompatible": a fast textual scan first, and a slower compiler probe second when the textual scan flags risk.
- The configurable safe-list of import-specifier prefixes that pass the textual scan.
- The configurable set of component names provided by the renderer that don't need explicit imports.
- The transformations applied when downgrading: removal of import/export lines, removal of all custom-component tags (preserving inner text), removal of admonition fences, and a JSX-to-HTML attribute rewrite for inline styles.
- The output: a `.md` file in place of the original `.mdx`, with cleaned content.
- The "no downgrade" path when the file passes both checks unchanged.
- Behavior when the compiler probe is unavailable.

**Out of scope:**
- The walk that finds `.mdx` files (covered by the content-mirroring topic).
- The actual file-write to disk and the `MirrorResult` accounting (covered by the content-mirroring topic).
- Renderer-specific safe-list defaults (those are configured by the caller).
- The compilation of MDX during the final build (handled by the framework itself).

## Data Contracts

### Inputs

- `content`: the textual content of the source `.mdx` file.
- `rules` (optional): a renderer-specific override for the textual-scan parameters:
  - `safeImportPrefixes`: list of strings; an import specifier passes the textual scan when it matches any prefix exactly or begins with `<prefix>/`.
  - `providedComponents`: set of component names that the renderer guarantees are available globally (i.e., do not require an explicit import in the MDX).

### Default safe-list (used when no rules are supplied)

The fallback safe-list of import-specifier prefixes is:
- `nextra`
- `nextra-theme-docs`
- `next/`
- `next-themes`
- `react`
- `swagger-ui-react`

The fallback set of provided components is:
- `Fragment`
- `Callout`
- `Cards`
- `Card`
- `FileTree`
- `Steps`
- `Tabs`
- `Tab`

### Output

The downgrade decision returns a boolean ("downgrade required") for the textual-scan layer; the compiler-probe layer returns a boolean ("compiles successfully") when invoked. The combined check is "downgrade required if either layer flags the file."

When a downgrade is performed, the output is:
- A new file with extension `.md` instead of `.mdx`, at the same relative path otherwise.
- Content that has been transformed by the strip step (see "Strip transformations" below).
- A trailing newline, with excessive blank lines collapsed to at most one blank line.

## Behavior

### Two-layer check

Layer 1 — fast textual scan:

1. Find every `import ... from '...'` (or `"..."`) statement. For each one:
   - If the specifier begins with `./` or `../`, it is a relative import; treat as safe.
   - If the specifier matches a safe prefix exactly or begins with `<prefix>/`, treat as safe.
   - Otherwise, report incompatible.
2. Find every JSX-style component tag whose name starts with an uppercase letter (e.g., `<Foo>`, `<Foo />`, `<Foo …>`). For each one:
   - If the name was imported (named or default) anywhere in the file, treat as safe.
   - If the name is in the provided-components set, treat as safe.
   - Otherwise, report incompatible.

If any check above fires, the file is flagged as "incompatible" by Layer 1 and the caller proceeds to downgrade without invoking Layer 2.

Layer 2 — compiler probe:

1. Only invoked when Layer 1 found no problems.
2. Attempt to compile the MDX content with the framework's MDX compiler in non-development mode.
3. If compilation succeeds, the file is compatible (no downgrade).
4. If compilation throws, the file is incompatible (downgrade).
5. If the compiler is not available in the runtime environment, treat the file as compatible (assume safe and proceed without modification). This handles environments where the MDX compiler is not installed; an unavailable probe is silently skipped rather than treated as a failure.

### Strip transformations (downgrade)

When a downgrade is performed, the source content is transformed in this order:

1. Remove every line that begins with `import` or `export` followed by whitespace.
2. Remove self-closing JSX tags whose name begins with uppercase: `<Foo … />` and `<Foo />`.
3. Remove paired open/close JSX tags whose name begins with uppercase, but **preserve the children** between them. Process iteratively until no further changes occur (so nested tags like `<Tabs><TabItem>…</TabItem></Tabs>` collapse correctly to just the inner text).
4. Convert JSX inline-style attributes from `style={{ camelCaseKey: "value", … }}` form to HTML `style="kebab-case-key: value; …"` form. Quoted values are unwrapped before re-emission.
5. Remove every line whose content begins with `:::` (Docusaurus-style admonition fences).
6. Collapse runs of three or more consecutive newlines into two newlines.
7. Trim leading and trailing whitespace from the whole document and append a single trailing newline.

The transformation is content-only; the file's relative path is computed by replacing the `.mdx` suffix with `.md` and the file is written at the new path.

### Skip path (no downgrade)

When the two-layer check returns "compatible," the file is not modified. The source `.mdx` is copied verbatim to the staged content directory (with extension preserved).

### Imported-name extraction (used by Layer 1's component check)

The textual scan extracts imported names by matching:
- `import <Identifier>` for default and namespace imports.
- `import { <names> }` for named imports, splitting on commas, handling `as` aliases by taking the alias when present, and trimming whitespace.

Names extracted this way are added to the "imported components" set used by the JSX-tag check.

## State Transitions

A single source `.mdx` file moves through these states during mirroring:

- **Pending:** the mirror has decided this is a markdown-class file and is about to process it.
- **Layer-1-safe:** Layer 1 found no problems; proceed to Layer 2.
- **Layer-1-flagged:** Layer 1 reported an issue; immediately downgrade.
- **Layer-2-safe:** Layer 2 compiled the content successfully; copy as `.mdx` unchanged.
- **Layer-2-flagged:** Layer 2 compilation failed; downgrade.
- **Downgraded:** the cleaned content has been written to `<path>.md`; the `.mdx` source is left in place but never copied.
- **Copied:** the `.mdx` source has been copied verbatim to its destination.

There is no path that produces both a `.mdx` and a downgraded `.md` for the same source file.

## Notable Behavior

- **Two layers are necessary because each catches what the other misses.** The textual scan is fast and catches missing modules that the compiler would resolve at bundle time but fail later. The compiler probe catches malformed JSX, invalid expressions, and other syntactic issues the regex cannot reliably detect.
- **Layer 1 only fires Layer 2 when it thinks the file is safe.** Files Layer 1 already flagged are downgraded immediately; Layer 2 is reserved for files that pass the fast scan, which avoids running the compiler on files that are obviously incompatible.
- **Compiler probe is best-effort.** When the MDX compiler is missing from the environment (e.g., a stripped runtime that doesn't bundle it), the probe is skipped and the file is assumed safe. This is a deliberate fallback: the alternative would be to falsely downgrade every MDX file in environments without the compiler.
- **Downgrade preserves text content.** The strip step is designed to keep the file readable as plain markdown after the transformation: code blocks, headings, paragraphs, lists, links, and images all survive. Custom-component wrappers are unwrapped, leaving their inner text in place.
- **Iterative tag stripping handles nesting.** The strip step repeatedly removes uppercase-tag opens and closes until the content stabilizes; this ensures that nested custom components (e.g., a `Tabs` containing multiple `Tab` components) collapse to their innermost text content.
- **Admonition fences are removed entirely.** Docusaurus admonition syntax (`:::tip`, `:::warning`, etc.) has no equivalent in plain markdown; the fences are stripped but the content between them is preserved.
- **Inline style conversion is regex-based.** A `style={{ color: "red", fontSize: 12 }}` becomes `style="color: red; font-size: 12"`. The conversion handles trivial cases but does not validate CSS, does not handle template literals, and does not handle nested expressions.
- **Component-name match is case-sensitive.** Only names that begin with an uppercase letter are treated as JSX components (per JSX convention). Lowercase tags are treated as HTML and pass through unchanged.
- **Provided-components set is closed.** The default provided-components set is small and curated. Renderers that bundle additional global components must supply them via the `providedComponents` rule; otherwise those components are flagged as missing imports and trigger a downgrade.
- **Safe-prefix list is closed.** The default safe-prefix list reflects the framework's known dependencies. Custom packages used by the user's MDX must be added to the safe-prefix list at the call site, or the file will always be downgraded — even though the import would resolve correctly at bundle time.
- **`swagger-ui-react` is in the default safe-prefix list for historical reasons.** Earlier versions of the framework rendered OpenAPI specs via Swagger UI; the rich-renderer pipeline replaced this. The prefix is kept in the default safe-list to avoid regressing any user MDX that still imports from it.

## Shared Behavior

- The walk that decides which files to subject to this check is defined by the content-mirroring topic.
- The `downgradedCount` reported in the mirror result is incremented when this check returns "downgrade."
- Renderers can override the safe-list and provided-components set; the Nextra renderer supplies the default values used when no override is provided.
- The framework's MDX compiler used by Layer 2 is the same one used during the final site build; a successful Layer 2 result is a strong signal that the build will also succeed for that file.
