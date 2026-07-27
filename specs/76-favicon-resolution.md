# 76. Favicon Resolution

## Topic Statement

Resolving the documentation site's favicon by copying a configured source path into the build's `public/` folder, or generating a default lightweight SVG when none is configured, and wiring the result into the generated layout's HTML head.

## Scope

**In scope:**
- The configured-source path (the favicon path declared in `site.json`).
- The destination filename (`favicon.ico` under the build's `public/` folder, irrespective of the source's extension).
- The default-favicon generation when no source path is configured or the source path does not exist on disk.
- The shape of the default favicon (a small SVG with a colored rounded square and a single uppercase letter).
- The `<link rel="icon">` tag emitted into the layout's HTML head and the URL it points at.
- Two precedence rules that govern which configured path wins:
  - The legacy top-level `favicon` field versus the newer `theme.favicon` field.
  - The configured value versus a default when the configured value cannot be found.
- The two surfaces that emit a favicon link (the default Nextra layout and the theme-pack layouts), and the difference in how each one references the favicon URL.

**Out of scope:**
- The image-asset resolver for missing markdown image references (covered by the image-asset-resolution topic).
- The `site.json` reader and writer (covered by the site-configuration-discovery topic).
- The Docusaurus-config favicon extraction routine that populates the `site.json`'s `favicon` field on first creation (covered by the Docusaurus-sidebar-conversion topic).
- Theme-pack-specific styling beyond the favicon link (covered by theme-pack topics).

## Data Contracts

### Inputs

- `faviconPath` (string or undefined): a path declared in the configuration, conventionally relative to the documentation source folder. May refer to a file with any extension (e.g., `.ico`, `.svg`, `.png`).
- `sourceRoot` (absolute path): the documentation source folder, used as the anchor for resolving relative `faviconPath` values.
- `publicDir` (absolute path): the build's `public/` folder.

### Configured-source precedence

The configuration may carry the favicon path in either of two places:

- `favicon` at the top level of `site.json` — the legacy alias.
- `theme.favicon` inside the theme block — the newer location.

When both are set, the top-level value wins. When only one is set, that value is used. When neither is set, the configured-source path is undefined and the default-generation path applies.

### Destination

The destination is always `<publicDir>/favicon.ico`. The file's actual content may be `.ico`, `.svg`, or any other format depending on what was copied or generated; the filename does not change.

### Default favicon

When no source can be used (either no `faviconPath` was configured, or the configured path does not exist on disk), the default favicon is generated as an inline SVG with these properties:

- Dimensions 32×32, viewBox `0 0 32 32`.
- A rounded rectangle (rx 6) filling the entire canvas with the color `#0070f3`.
- A single uppercase letter centered horizontally, positioned at 75% vertical, in white, sans-serif, 22pt, bold weight.
- The letter is currently the static character `J`. (The assignment hints at "the title's first letter," but the implementation as it stands hardcodes `J`.)

The default favicon is written to the same destination as a real favicon: `<publicDir>/favicon.ico`.

### HTML head wiring

The generated layout for the site emits a favicon `<link rel="icon">` tag in the page head. The URL referenced by the tag is the configured `favicon` (or `theme.favicon`) value verbatim, after URL sanitization (any unsafe scheme — `javascript:`, `data:`, etc. — is replaced with `#`).

There are two surfaces that emit the link, with different rules:

1. **The default Nextra layout** (no theme pack) does not currently emit a favicon `<link>` tag of its own. It relies on Next.js's automatic discovery of `public/favicon.ico` (which the resolver above always materializes).
2. **The theme-pack layouts** (Forge and Atlas) emit a `<link rel="icon" href={<value>} />` tag whose `href` attribute is the configured favicon URL after sanitization. When no favicon URL is configured, the `<link>` tag is omitted entirely (the layout falls back to Next.js's automatic discovery of `public/favicon.ico`).

The two sources of the URL the theme-pack layouts use, in precedence order: the legacy top-level `favicon`, then `theme.favicon`. The first set value wins.

## Behavior

### Resolve and copy

1. If `faviconPath` is set, compute its absolute path by resolving against `sourceRoot`.
2. If the absolute path exists on disk, ensure the destination's parent directory exists, copy the source file to `<publicDir>/favicon.ico`, and return.
3. If `faviconPath` is unset or the absolute path does not exist, generate the default-favicon SVG and write it to `<publicDir>/favicon.ico`.

### Layout link emission (theme packs)

1. The layout generator receives the configured favicon URL (resolved from the legacy and theme blocks per the precedence rule above).
2. If the URL is empty or unset, no `<link>` tag is emitted; the document head omits the icon link entirely.
3. Otherwise, sanitize the URL (replace anything other than http(s)/mailto/tel/fragment/query/relative-or-absolute-path with `#`) and emit `<link rel="icon" href={<sanitized-url>} />` in the head.

### Layout link emission (default layout)

The default Nextra layout omits the explicit `<link>` tag and relies on Next.js's automatic favicon discovery from `public/favicon.ico`. This works because the resolver above always writes a `favicon.ico` to `public/`, even when no favicon was configured (in which case the default SVG is written under that name).

## State Transitions

The build's `public/favicon.ico` file moves through these states per build:

- **Pre-resolve:** the file may be absent or contain a value from a previous run.
- **Configured-and-found:** a configured `faviconPath` resolves to an existing file; the file is copied to `public/favicon.ico`.
- **Configured-but-missing:** a configured `faviconPath` does not resolve to an existing file; the default SVG is written instead.
- **Unconfigured:** no `faviconPath` is set; the default SVG is written.

The resolver always produces a populated `public/favicon.ico` after one run, regardless of the input.

## Notable Behavior

- **Destination filename is fixed.** Regardless of whether the source is `.ico`, `.svg`, `.png`, or anything else, the destination is always named `favicon.ico`. Browsers accept SVG and PNG content under this filename when properly served, so this works for the default-generated SVG too.
- **Default favicon is always materialized.** Even when the user has not configured a favicon, the resolver writes a default SVG to `public/favicon.ico`. This guarantees the build always has a favicon and that Next.js's automatic discovery succeeds for the default layout.
- **Default-favicon letter is currently hardcoded.** The implementation writes `J` (for the product brand) regardless of the site's title. The spec acknowledges this; a future change may switch to the title's first letter.
- **Top-level `favicon` wins over `theme.favicon`.** The legacy alias takes precedence so that existing `site.json` files continue to work unchanged after the theme block was introduced. New projects should prefer `theme.favicon` but the legacy form remains supported.
- **Theme-pack layouts render the link explicitly.** Forge and Atlas emit `<link rel="icon">` directly with the configured URL. This bypasses Next.js's automatic discovery, which is useful when the user wants the favicon served from a path other than `public/favicon.ico` (e.g., a CDN URL).
- **Default layout omits the link.** The vanilla Nextra layout does not emit a `<link>` tag and relies on Next.js's discovery of `public/favicon.ico`. This means a configured remote URL would be ignored on the default layout (the local copy at `public/favicon.ico` is what serves), unless the user switches to a theme pack.
- **URL sanitization on the link tag protects against script-URL injection.** A malicious `site.json` setting `theme.favicon: "javascript:alert(1)"` would be rewritten to `href="#"` in the emitted layout. This is independent of the resolve-and-copy step (which never tries to fetch a URL).
- **Resolve-and-copy does not fetch remote URLs.** The resolver only handles filesystem paths (relative or absolute). A configured value that looks like a URL (`http://...`, `https://...`) will fail the existence check and fall back to the default favicon for the local file at `public/favicon.ico`. The theme-pack layout will, however, emit the URL as-is in its `<link>` tag (after sanitization), so the configured remote URL is what visitors see in their browser.
- **Idempotency.** Running the resolver twice produces the same output. The destination is overwritten on each call.

## Shared Behavior

- The Docusaurus-sidebar-conversion topic populates the configured `favicon` field on first project creation by extracting it from the framework's main config file.
- The site-configuration-discovery topic carries the user's favicon configuration from `site.json` to the resolver.
- The Nextra-project-scaffold topic creates the `public/` folder and the layout files into which the favicon link is wired.
- The image-asset-resolution topic shares the same destination-folder convention (`public/`) but handles a different category of asset; the two flows are independent.
