# OpenAPI Overview Page Emission (Nextra)

## Topic Statement

Emit a single per-spec overview MDX page that introduces the API (title, version, description, server URLs) and lists every operation grouped by tag with method, path, summary, and a link to the dedicated endpoint page — with tag iteration order matching the parsed-spec order so the page mirrors the sidebar.

## Scope

In scope: choosing the on-disk path of the overview page (`content/api-{spec-slug}/index.mdx`); emitting front-matter; emitting a top-level heading from the spec's `info.title`; emitting the version (rendered as inline code), description (when present), and a "Servers" section listing the spec-level servers; emitting an "Endpoints" section with one subsection per tag, each containing a Markdown table of method/endpoint/summary; emitting links from each table row to the dedicated endpoint page; including operations whose tag is the synthetic default group under that group's heading; neutralizing MDX-hostile characters in text taken from the spec.

Out of scope: per-tag descriptions beyond what the spec declares; rendering parameters, request bodies, or responses on the overview page (those are on the dedicated endpoint pages); generating a try-it widget on the overview page; emitting non-Nextra renderer overview pages; mixing operations from multiple specs into one overview (each spec gets its own).

## Data Contracts

Inputs:
- The spec name (used to derive the spec folder slug and the per-endpoint route paths).
- The parsed spec, including `info` (title, version, description), `servers`, `tags`, and `operations`.

Output:
- One MDX file at `content/api-{spec-slug}/index.mdx`.

Page structure (in order):
- Front-matter — `title:` set to `info.title`, YAML-escaped.
- Top-level heading (`#`) with the title.
- Version — `Version: \`{info.version}\`` (inline-code escaped).
- Description — when `info.description` is non-empty, the raw text MDX-escaped on its own paragraph.
- "## Servers" section — one bullet per server URL with the URL inline-code-escaped, plus an em-dash and the description when one is supplied.
- "## Endpoints" section — one `### {tag-name}` subsection per tag in declaration order, each containing:
  - The tag's description (if any), MDX-escaped on its own paragraph.
  - A three-column markdown table: `Method | Endpoint | Summary`.
  - One row per operation in the tag's group: bold uppercased method, the path inline-code-escaped wrapped in a link to the endpoint page, and the summary with table-cell-specific escapes applied.

Tag groups with no operations are omitted entirely from the "Endpoints" section.

The endpoint route in each link is the public route for the dedicated endpoint page (`/api-{spec-slug}/{tag-slug}/{operationId}`).

## Behavior

The page path is the spec folder slug plus `index.mdx`. There is exactly one overview page per spec.

Front-matter and the top-level heading both come from `info.title`. Front-matter goes through a YAML-string escape; the heading goes through an MDX-text escape.

Version is rendered with inline-code formatting so the actual version string is visually distinct from prose. Description, when present, is MDX-escaped and emitted as a standalone paragraph above the "Servers" section.

The "Servers" section is omitted entirely when the parsed spec has no servers. When present, each server URL is rendered as an inline-code-escaped string; the description (when supplied) follows after an em-dash and is MDX-escaped.

The "Endpoints" section iterates the parsed spec's `tags` array in order. For each tag, operations whose primary tag matches are collected. Operations whose primary tag is not in the parsed spec's tag list (e.g. tags that appear only on operations) are still represented — they are appended as a fallback group under their original tag name. The synthetic `default` tag (operations with no spec-supplied tags) is rendered as a group with the literal tag name.

Within each tag subsection, the tag name is the heading text, MDX-escaped. The tag's description (when present) appears as a paragraph between the heading and the table. The table header is fixed (`Method | Endpoint | Summary`); each row contains:
- The HTTP method, uppercased, in bold.
- The path, inline-code-escaped, wrapped in a markdown link whose href is the public endpoint route.
- The summary with table-cell-specific escapes applied.

Empty tag groups (no matching operations) are skipped — the heading and table are not emitted at all.

## Notable Behavior

The summary cell uses a stricter escape set than ordinary MDX text because Markdown table cells are parsed differently. Inside table cells the MDX parser hands off to the JS expression parser for any expression-shaped text; backslash-escaped curly braces still trip "could not parse expression" errors. The escape uses HTML entities for `&`, `<`, `{`, and `}` (which render as the literal characters but are invisible to the expression parser), then escapes pipes (`|`) and backslashes (`\`) for table-syntax safety. Newlines within the summary are collapsed to single spaces so the row stays on one line.

The em-dash that joins server URLs to their descriptions is the literal em-dash character (U+2014), not a hyphen-minus, matching the typographic convention used throughout the docs site.

Tag iteration order is taken from the parsed spec's `tags` array — same order the sidebar emitter uses. The overview page and the sidebar therefore present operations in identical order, which matches what the spec author declared.

Operations whose primary tag is not declared in the spec's `tags` array are appended to the iteration as fallback groups so they still appear on the overview page. This mirrors the parser's behavior of registering newly-encountered tag names during the operation walk.

When `info.title`, version, description, server descriptions, tag names, tag descriptions, and operation summaries arrive from the spec, they all pass through MDX escapers because they are user-supplied strings that may contain `<`, `{`, or other MDX-hostile characters. The escapers preserve the source text visually; they do not translate punctuation or formatting.

The path string in each table row is shown inside inline-code formatting (e.g. `` `/users/{id}` ``), which is the standard convention for showing path templates with their `{name}` placeholders verbatim.

## Shared Behavior

The endpoint route used in each row's link is generated by the same path-helper used by the sidebar `_meta.ts` emitter and by the per-endpoint page emitter — all three must agree on the route for the link to land on the right page.

The tag-iteration order matches the sidebar emitter so the visual order on the overview page is identical to the sidebar order. Both are driven from the parsed spec's `tags` array.

Tag groups with no operations are omitted here and also from the sidebar emitter — neither surface shows an empty bucket.

The synthetic default group (operations with no spec-supplied tags) is the same default used by the parser and by the sidebar emitter; the three stages are consistent about which operations land in which bucket.
