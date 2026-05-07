# Site Commands — Detailed Change Documentation

**Branch:** `feature/jolli-site-commands`
**Base:** `origin/main`
**Total new/modified files:** 31 (16 source + 11 test + 4 config/build)
**Total lines added:** ~8,220

---

## Table of Contents

1. [Overview](#overview)
2. [New CLI Commands](#new-cli-commands)
3. [Architecture](#architecture)
4. [File-by-File Details](#file-by-file-details)
   - [Modified Files](#modified-files)
   - [New Command Files](#new-command-files)
   - [New Site Module Files](#new-site-module-files)
   - [New Test Files](#new-test-files)
5. [Dependencies](#dependencies)
6. [Framework Migration](#framework-migration)
7. [MDX Compatibility](#mdx-compatibility)
8. [Image Handling](#image-handling)
9. [Output Filtering](#output-filtering)
10. [Testing](#testing)

---

## Overview

This branch adds five new CLI commands for creating, developing, building, serving, and converting documentation sites using Nextra v4 as the rendering engine:

| Command | Description |
|---------|-------------|
| `jolli new [folder]` | Scaffold a new documentation project with starter files |
| `jolli convert [source] [--output path]` | Permanently convert a Docusaurus (or other framework) project to Nextra structure |
| `jolli dev [folder] [--verbose]` | Start a dev server with hot reload |
| `jolli build [folder] [--verbose]` | Static build + Pagefind search indexing |
| `jolli start [folder] [--verbose]` | Build + search indexing + serve |

All commands support `--migrate` to re-detect framework config and regenerate `site.json`.

---

## New CLI Commands

### `jolli new [folder-name]`

Creates a new documentation project with:
- `site.json` — site configuration (title, description, nav)
- `index.md` — welcome page
- `getting-started.md` — quick start guide
- `api/openapi.yaml` — example OpenAPI 3.1.0 spec
- `guides/introduction.md` — nested subfolder example

If `folder-name` is omitted, prompts interactively.

### `jolli convert [source] [--output path]`

Permanently converts a documentation folder to Nextra-compatible structure:
- Detects source framework (Docusaurus, Mintlify, etc.)
- Reorganizes directory structure according to sidebar config
- Downgrades incompatible `.mdx` files to `.md`
- Fixes relative image paths
- Writes `site.json` without `pathMappings` (structure is already correct)

For in-place conversion, creates a timestamped backup (e.g., `docs.backup-2026-05-02T14-30-22/`).

### `jolli dev [folder] [--verbose] [--migrate]`

Starts a Next.js dev server with hot reload:
- Mirrors content to `~/.jolli/sites/<hash>/content/`
- Generates `_meta.js` navigation files
- Runs `next dev` with output filtering

### `jolli build [folder] [--verbose] [--migrate]`

Produces a static site with search:
- Mirrors content, generates navigation
- Runs `next build` (static export to `out/`)
- Runs Pagefind indexer (search index at `_pagefind/`)
- Reports build summary and output path

### `jolli start [folder] [--verbose] [--migrate]`

Same as `build`, then serves the output with `npx serve`.

---

## Architecture

```
User Content Folder                  Hidden Build Directory
(e.g., docs/)                        (~/.jolli/sites/<hash>/)
                                     
┌─────────────────┐                  ┌──────────────────────┐
│ site.json        │──ReadSiteJson──▶│ next.config.mjs      │
│ index.md         │                 │ app/layout.tsx        │
│ guides/          │──ContentMirror─▶│ app/[[...mdxPath]]/   │
│ api/openapi.yaml │                 │ content/              │
│ images/          │──MetaGenerator─▶│   _meta.js (per dir)  │
│ sidebars.js      │                 │ mdx-components.tsx    │
└─────────────────┘──OpenApiRender──▶│ public/               │
                                     │ tsconfig.json         │
                                     │ package.json          │
                                     └──────────────────────┘
                                              │
                                     NpmRunner (dev/build)
                                     PagefindRunner (search)
                                     OutputFilter (display)
```

### Build Directory Isolation

Each content folder maps to a unique build directory via SHA-256 hash:
```
~/.jolli/sites/
├── a1b2c3d4e5f6/  ← hash of /path/to/project-a
├── f6e5d4c3b2a1/  ← hash of /path/to/project-b
```

This ensures:
- No git pollution in user's content folder
- Multiple projects can coexist
- `node_modules` persists between runs (skip `npm install` on subsequent runs)

---

## File-by-File Details

### Modified Files

#### `cli/package.json`

**Changes:** Added 2 new dependencies.

| Dependency | Type | Version | Purpose |
|-----------|------|---------|---------|
| `@mdx-js/mdx` | runtime | `^3.1.1` | MDX compilation for compatibility checking (Layer 2 of MDX validation) |
| `fast-check` | dev | `^3.23.2` | Property-based testing library for correctness proofs |

#### `cli/vite.config.ts`

**Changes:** Added `@mdx-js/mdx` to Rollup's `external` array.

```diff
- external: ["@anthropic-ai/sdk", "commander", "open", /^node:.*/],
+ external: ["@anthropic-ai/sdk", "@mdx-js/mdx", "commander", "open", /^node:.*/],
```

This prevents Vite from bundling the MDX compiler into the CLI dist — it's loaded dynamically at runtime via `import("@mdx-js/mdx")`.

#### `cli/src/Cli.ts`

**Changes:** Registered 4 new commands and updated JSDoc.

Added imports:
- `registerConvertCommand` from `./commands/ConvertCommand.js`
- `registerNewCommand` from `./commands/NewCommand.js`
- `registerBuildCommand`, `registerDevCommand`, `registerStartCommand` from `./commands/StartCommand.js`

Added registrations in `main()`:
```typescript
registerNewCommand(program);
registerConvertCommand(program);
registerDevCommand(program);
registerBuildCommand(program);
registerStartCommand(program);
```

#### `cli/src/site/Types.ts`

**Changes:** New file (existed as stub on main, now fully populated with 89 lines).

Defines all shared types for the site module:

| Type | Description |
|------|-------------|
| `FileType` | `"markdown" \| "openapi" \| "image" \| "ignored"` |
| `NavLink` | `{ label: string; href: string }` |
| `SidebarItemValue` | String label or Nextra meta object (with `title?`, `href?`, `type?`) |
| `SidebarOverrides` | `Record<string, Record<string, SidebarItemValue>>` — path-keyed sidebar config |
| `PathMappings` | `Record<string, string>` — source → target folder remapping |
| `SiteJson` | Full site.json schema: `title`, `description`, `nav`, `sidebar?`, `pathMappings?`, `favicon?` |
| `ScaffoldResult` | Result of `jolli new` |
| `MirrorResult` | Result of content mirroring: file lists + `downgradedCount` + `renamedToIndex` |
| `NpmRunResult` | `{ success: boolean; output: string }` |
| `PagefindResult` | Extends NpmRunResult with `pagesIndexed?` |

---

### New Command Files

#### `cli/src/commands/NewCommand.ts` (62 lines)

Registers `jolli new [folder-name]`.

**Key behaviors:**
- If no argument: prompts interactively via `readline.createInterface`
- Validates non-empty input
- Delegates to `StarterKit.scaffoldProject()`
- Reports success with next-steps message or error with exit code 1

#### `cli/src/commands/StartCommand.ts` (236 lines)

Registers `jolli build`, `jolli start`, and `jolli dev`.

**Exported functions:**
- `registerBuildCommand(program)` — static build + pagefind
- `registerStartCommand(program)` — build + pagefind + serve
- `registerDevCommand(program)` — dev server
- `getBuildDir(sourceRoot)` — computes `~/.jolli/sites/<sha256-12-chars>/`

**Shared pipeline (`prepareContent`):**
1. Validate source root exists
2. Read `site.json` (with framework detection if missing)
3. Initialize Nextra project (write config files)
4. Resolve favicon to `public/`
5. Clear `.next/` cache and `public/`
6. Mirror content (with pathMappings and MDX downgrading)
7. Fix sidebar index key if `slug: /` file was renamed
8. Generate `_meta.js` navigation files
9. Render OpenAPI specs
10. Install npm dependencies (if `node_modules/` missing)

**Output control:**
- Default mode: concise summaries (`✓ Mirrored 45 files (3 downgraded)`)
- `--verbose` mode: full framework output
- Internal paths hidden from default output

**Options:**
- `--verbose` — show detailed build output
- `--migrate` — re-detect framework config and regenerate site.json

#### `cli/src/commands/ConvertCommand.ts` (380 lines)

Registers `jolli convert [source] [--output path]`.

**Conversion pipeline:**
1. Detect framework → generate sidebar + pathMappings
2. Prompt for site title
3. Create timestamped backup (if in-place)
4. Walk all files, applying pathMappings during copy/move
5. Downgrade incompatible MDX → MD with content stripping
6. Rewrite relative image paths for remapped files
7. Handle `slug: /` → `index.md` rename + update sidebar
8. Copy favicon from framework config
9. Write `site.json` (WITHOUT `pathMappings` — structure is already correct)
10. Clean up framework-specific files (`sidebars.js`, etc.)

**Safety features:**
- In-place conversion always creates backup: `<folder>.backup-YYYY-MM-DDTHH-MM-SS/`
- Skips framework config files during conversion
- Uses safe rename with cross-device fallback (copy + remove)

---

### New Site Module Files

#### `cli/src/site/StarterKit.ts` (336 lines)

Scaffolds a new documentation project for `jolli new`.

**Exports:** `scaffoldProject(targetDir): Promise<ScaffoldResult>`

**Generated files:**
- `site.json` — default config with title, description, nav links
- `index.md` — welcome page with markdown table showing project structure
- `getting-started.md` — quick start guide
- `api/openapi.yaml` — complete OpenAPI 3.1.0 example spec (Items API)
- `guides/introduction.md` — nested subfolder example

**Behavior:**
- Returns `{ success: false }` if target directory already exists (non-destructive)
- All file writes parallelized with `Promise.all`
- Catches filesystem errors and returns them in result (doesn't throw)

#### `cli/src/site/SiteJsonReader.ts` (157 lines)

Reads `site.json` or creates it with framework detection.

**Exports:**
- `readSiteJson(sourceRoot, options?): Promise<SiteJsonResult>`
- `DEFAULT_SITE_JSON` — fallback config

**When `site.json` exists:** Parses JSON, extracts `title`, `description`, `nav`, preserves unknown fields via spread.

**When `site.json` is missing:**
1. Calls `detectFramework()` to find Docusaurus/Mintlify/etc.
2. If found: prompts `"Found Docusaurus config. Generate site.json from it? (Y/n)"`
3. If yes + Docusaurus: calls `convertDocusaurusSidebar()` + `extractFaviconFromConfig()`
4. Prompts for site title (default: folder name in Title Case)
5. Writes `site.json` with sidebar, pathMappings, favicon

**`--migrate` support:** When `options.migrate` is true, re-runs creation even if `site.json` exists.

#### `cli/src/site/ContentMirror.ts` (706 lines)

Core content processing engine. Mirrors files from source to build directory.

**Exported functions:**

| Function | Description |
|----------|-------------|
| `mirrorContent(sourceRoot, contentDir, pathMappings?, publicDir?)` | Main entry: clear, walk, copy, resolve missing images |
| `classifyFile(filePath, content?)` | Categorize by extension + content inspection |
| `clearDir(dir)` | Remove all contents, keep directory |
| `hasIncompatibleImports(content)` | Two-layer MDX compatibility check |
| `stripIncompatibleContent(content)` | Downgrade MDX to plain markdown |
| `rewriteRelativeImagePaths(content, originalPath, newPath, mappings?)` | Fix image refs after path remapping |
| `applyPathMapping(relPath, mappings?)` | Apply folder-level path remapping |

**MDX compatibility checking (two layers):**

1. **Layer 1 — Regex (milliseconds):** Checks imports against safe prefix allowlist (`nextra`, `react`, `next/`, `swagger-ui-react`). Checks JSX components against imported names + Nextra built-ins (`Callout`, `Cards`, `Steps`, `Tabs`, etc.).

2. **Layer 2 — MDX compiler (seconds):** If regex passes, attempts `@mdx-js/mdx` compilation to catch syntax errors. Only runs on files that passed Layer 1.

**MDX downgrading (`stripIncompatibleContent`):**
- Removes all `import`/`export` statements
- Removes all uppercase JSX component tags (self-closing and paired)
- Preserves children content inside removed tags
- Converts JSX `style={{ camelCase: 'value' }}` to HTML `style="kebab-case: value"`
- Removes Docusaurus `:::` admonition fences
- Cleans up excessive blank lines

**Image path rewriting:**
- When a file is remapped via `pathMappings`, relative image paths break
- `rewriteRelativeImagePaths` resolves each path against original location, applies pathMapping to the image path too, then computes new relative path from new location
- Handles both `![](path)` and `<img src="path">` syntax

**Missing image resolution:**
- After all files are mirrored, scans markdown for image references
- For absolute paths (`/img/...`): searches Docusaurus `static/` directory
- For missing relative paths: searches up to project root
- If found externally: copies to `public/images/<unique-name>`, rewrites reference
- If not found: generates placeholder SVG (400×300, shows "Missing image: filename")

**`slug: /` handling:**
- Docusaurus uses `slug: /` frontmatter to designate homepage
- After mirroring, if no `index.md` exists, scans root files for `slug: /`
- Renames matching file to `index.md` (not copy — avoids duplicate)
- Returns old filename key so sidebar can be updated

#### `cli/src/site/MetaGenerator.ts` (206 lines)

Generates Nextra v4 `_meta.js` navigation files.

**Exports:**
- `generateMetaFiles(contentDir, sidebarOverrides?)` — recursive _meta.js generation
- `buildMetaEntries(filenames, override?)` — build ordered entry list
- `toTitleCase(filename)` — `getting-started` → `Getting Started`

**Default behavior (no sidebar override):**
- All items sorted alphabetically by key
- Labels auto-generated via `toTitleCase`
- `index.md`/`index.mdx` entries use `{ display: "hidden" }` to prevent duplicate sidebar entries

**Override behavior (with sidebar):**
- Declared items appear first, in declaration order
- `index` files auto-hidden if not explicitly declared
- Nextra auto-appends unlisted filesystem items alphabetically
- Object values supported (external links with `href`, separators, hidden items)

**_meta.js output format:**
```javascript
export default {
  "index": {"display":"hidden"},
  "getting-started": "Getting Started",
  "api": "Api",
  "github": {"title":"GitHub","href":"https://github.com"},
}
```

#### `cli/src/site/OpenApiRenderer.ts` (144 lines)

Generates MDX pages for OpenAPI specification files.

**Exports:**
- `renderOpenApiFiles(sourceRoot, contentDir, openapiFiles, publicDir?)` — main function
- `isValidOpenApiContent(content, ext)` — validates OpenAPI format
- `generateOpenApiMdx(openapiFilePath, relPath)` — creates MDX content

**Validation:**
- JSON: parses and checks for top-level `openapi` and `info` keys
- YAML: regex check for `openapi:` and `info:` at line start (no full parser)

**Generated MDX:**
```mdx
import SwaggerUI from 'swagger-ui-react'
import 'swagger-ui-react/swagger-ui.css'

<SwaggerUI url="/api/openapi.yaml" />
```

**Behavior:**
- Logs warning for invalid files, skips them (doesn't abort build)
- Always overwrites existing `.mdx` (supports incremental updates)
- Copies raw spec files to `public/` for SwaggerUI runtime fetching

#### `cli/src/site/NextraProjectWriter.ts` (268 lines)

Generates and maintains the Nextra v4 project scaffold.

**Exports:**
- `initNextraProject(buildDir, config, options?)` — creates/updates scaffold
- `generatePackageJson(config)` — with nextra 4.2.17, react 19, swagger-ui-react, pagefind
- `generateNextConfig(staticExport?)` — with `contentDirBasePath`, `preferRelative`
- `generateLayout(config)` — App Router layout with Navbar, Footer, getPageMap
- `generateCatchAllPage()` — `app/[[...mdxPath]]/page.tsx` with importPage
- `generateMdxComponents()` — MDX component wiring
- `generateTsConfig()` — with `moduleResolution: "bundler"`

**Key design decisions:**
- Nextra v4 requires App Router (not Pages Router)
- Pinned to nextra 4.2.17 (4.3+ has a Zod validation bug in Layout component)
- Theme configured via component props in layout.tsx (not theme.config.tsx)
- Navbar extra content uses `children` prop (not `extraContent`)
- `next.config.mjs` conditionally includes `output: 'export'` for static builds
- `webpack.resolve.preferRelative = true` for bare image imports in markdown

#### `cli/src/site/NpmRunner.ts` (124 lines)

Executes npm commands in the build directory.

**Exports:**
- `needsInstall(buildDir)` — checks for `node_modules/`
- `runNpmInstall(buildDir)` — `npm install` with pipe stdio
- `runNpmBuild(buildDir)` — `npm run build` with pipe stdio
- `runNpmDev(buildDir, verbose?)` — `npm run dev` with OutputFilter
- `runServe(buildDir, verbose?)` — `npx serve out` with OutputFilter
- `ServerResult` — extends NpmRunResult with `url?`

**Long-running processes:**
- Use `spawn` (not `spawnSync`) with `stdio: 'pipe'`
- Output streamed through `OutputFilter` for noise reduction
- Localhost URL extracted automatically from output
- Resolve when process exits (user presses Ctrl+C)

#### `cli/src/site/PagefindRunner.ts` (41 lines)

Runs the Pagefind search indexer.

**Exports:**
- `runPagefind(buildDir)` — executes `npx pagefind --site out --output-path out/_pagefind`

Output path is `out/_pagefind/` to match Nextra's search component which loads from `/_pagefind/pagefind.js`.

#### `cli/src/site/OutputFilter.ts` (112 lines)

Filters child process output for user-friendly display.

**Exports:**
- `createOutputFilter(verbose)` — returns `{ write(data), getUrl() }`

**Suppressed patterns (70+):**
- TypeScript detection/configuration messages
- npm peer dependency warnings
- Nextra git repository warnings
- Webpack hot-update messages
- Fast Refresh messages
- Next.js version/experiment banners
- Compilation progress messages

**Always shown:**
- Errors (⨯ prefix, Module not found, Build error, Failed to compile)
- HTTP 500 responses
- Localhost URL (printed immediately on first detection)

#### `cli/src/site/AssetResolver.ts` (198 lines)

Resolves external images and favicon.

**Exports:**
- `resolveExternalImage(relPath, mdDir, sourceRoot)` — searches multiple locations for missing images
- `copyExternalAsset(asset, publicDir)` — copies or generates placeholder
- `resolveFavicon(faviconPath, sourceRoot, publicDir)` — copies or generates default
- `generatePlaceholderSvg(filename)` — 400×300 SVG showing "Missing image" + filename
- `ResolvedAsset` interface

**Image search priority:**
1. Resolve from original markdown directory
2. `<projectRoot>/static/<path>` (Docusaurus convention)
3. `<projectRoot>/<path>`
4. `<sourceRoot>/../static/<path>`
5. `<sourceRoot>/../<path>`
6. → Not found: generate placeholder SVG

**Project root detection:** Searches upward (max 5 levels) for `package.json`, `.git`, or `docusaurus.config.*`.

**Unique naming:** Path separators replaced with dashes: `static/img/logo.svg` → `images/static-img-logo.svg`.

#### `cli/src/site/FrameworkDetector.ts` (139 lines)

Detects documentation framework config files.

**Exports:**
- `detectFramework(sourceRoot)` — scans for known configs
- `promptMigration(framework)` — interactive Y/n prompt
- `DetectedFramework` interface

**Detected frameworks:**

| Framework | Detection Files | Search Scope |
|-----------|----------------|--------------|
| Docusaurus | `docusaurus.config.{js,ts}`, `sidebars.{js,ts}` | Source + parent |
| Mintlify | `mint.json` | Source only |
| VitePress | `.vitepress/config.{js,ts}` | Source only |
| MkDocs | `mkdocs.{yml,yaml}` | Source only |
| GitBook | `SUMMARY.md`, `.gitbook.yaml` | Source only |

Only Docusaurus conversion is implemented in v1. Others are detected and reported as unsupported.

#### `cli/src/site/DocusaurusConverter.ts` (307 lines)

Converts Docusaurus `sidebars.js` to Jolli format.

**Exports:**
- `convertDocusaurusSidebar(sidebarPath)` — returns `ConversionResult`
- `extractFaviconFromConfig(configPath)` — regex extraction of favicon path

**Conversion logic:**

Walks the Docusaurus sidebar tree and produces:
1. **`SidebarOverrides`** — path-keyed map defining navigation order/labels
2. **`PathMappings`** — folder remapping when logical structure differs from filesystem

**Docusaurus item type handling:**

| Type | Handling |
|------|----------|
| `string` (doc ID) | Extract last segment as key, auto-title |
| `{ type: 'doc', id, label }` | Use label or auto-title |
| `{ type: 'category', label, items }` | Create sidebar entry + recurse into subfolder |
| `{ type: 'link', label, href }` | Create Nextra link object (`{ title, href }`) |

**Virtual grouping detection:** If a category's actual filesystem directory matches its parent's, it's treated as a logical grouping (e.g., "Operations" inside `sql/`). Items are flattened into the parent — no subfolder is created.

**PathMapping generation:** Only when a doc's or category's actual filesystem path differs from its logical sidebar position. E.g., `sql/` at root but under `pipelines` in sidebar → `{ "sql": "pipelines/sql" }`.

---

### New Test Files

All test files follow the project convention: co-located `*.test.ts` files using Vitest with `vi.mock` for filesystem and child_process mocking.

| Test File | Tests | Coverage Focus |
|-----------|-------|---------------|
| `StarterKit.test.ts` | 244 lines | File creation, site.json validity, nested structure, error handling |
| `SiteJsonReader.test.ts` | 292 lines | Valid/invalid/missing JSON, type fallbacks, framework detection mocking |
| `ContentMirror.test.ts` | 746 lines | File classification, mirroring, MDX downgrading, broken symlinks, property-based tests |
| `MetaGenerator.test.ts` | 571 lines | Title-casing, alphabetical ordering, sidebar overrides, hidden index, property-based tests |
| `OpenApiRenderer.test.ts` | 520 lines | OpenAPI validation, MDX generation, directory creation, property-based tests |
| `NextraProjectWriter.test.ts` | 626 lines | All generators, init/update cycles, property-based tests for config preservation |
| `NpmRunner.test.ts` | 368 lines | Install/build/dev/serve, exit codes, spawn mocking, output filter |
| `PagefindRunner.test.ts` | 174 lines | Page count parsing, error handling, command arguments |
| `NewCommand.test.ts` | 241 lines | With/without argument, interactive prompt, directory exists |
| `StartCommand.test.ts` | 492 lines | All three commands, shared pipeline, sidebar overrides, --migrate |
| `FrameworkDetector.test.ts` | 80 lines | Detection for Docusaurus, Mintlify, MkDocs, GitBook |
| `DocusaurusConverter.test.ts` | 140 lines | String items, categories, links, nested categories, invalid files |

**Property-based tests (using fast-check):**
- File type classification consistency
- Content mirroring preserves directory structure
- `_meta.js` entries alphabetically ordered
- Title-case transformation correctness
- site.json fields preserved in generated Nextra config
- OpenAPI detection is content-based

---

## Dependencies

### Runtime: `@mdx-js/mdx` ^3.1.1

Used as the **second layer** of MDX compatibility checking. When the fast regex scan flags a file as potentially incompatible, the MDX compiler confirms whether it truly can't be compiled. This prevents false positives (files with unusual but valid MDX that the regex would reject).

Loaded dynamically (`import("@mdx-js/mdx")`) to avoid startup cost. Only invoked for files flagged by the regex layer.

### Dev: `fast-check` ^3.23.2

Property-based testing library used to prove correctness invariants:
- Any `.md`/`.mdx` file → classified as `"markdown"`
- Any image extension → classified as `"image"`
- Any OpenAPI content with `openapi` + `info` → classified as `"openapi"`
- Meta entries always sorted alphabetically
- Title-case has no hyphens/underscores remaining

---

## Framework Migration

### Detection Flow

```
jolli dev/build/start (first run, no site.json)
  ↓
detectFramework() scans for config files
  ↓
Found? → promptMigration("Found Docusaurus config. Generate site.json from it? (Y/n)")
  ↓ Y
convertDocusaurusSidebar() → { sidebar, pathMappings }
extractFaviconFromConfig() → favicon path
  ↓
promptSiteTitle() → title
  ↓
Write site.json (with sidebar + pathMappings + favicon)
  ↓
Subsequent runs: read site.json directly, no detection
```

### Docusaurus Conversion Details

**Sidebar structure mapping:**

```
Docusaurus sidebar                    site.json sidebar
─────────────────                    ──────────────────
docsSidebar: [                       "/": {
  'what-is-feldera',                   "what-is-feldera": "What Is Feldera",
  { type: 'category',                  "get-started": "Install Feldera",
    label: 'Install Feldera',          ...
    items: [...] },                  }
  ...                                "/get-started": {
]                                      "docker": "Docker",
                                       "sandbox": "Sandbox",
                                       ...
                                     }
```

**Path remapping (when sidebar ≠ filesystem):**

```
pathMappings: {
  "sql": "pipelines/sql",           // root sql/ → nested under pipelines/
  "connectors": "pipelines/connectors",
  "use_cases/batch": "tutorials/batch",  // cross-directory grouping
}
```

---

## MDX Compatibility

### Two-Layer Validation

**Layer 1 — Regex scan (milliseconds):**
- Checks imports against allowlist: `nextra`, `react`, `next/*`, `swagger-ui-react`, relative paths
- Checks JSX components against imports + Nextra built-ins

**Layer 2 — MDX compiler (seconds):**
- Only runs on files that passed Layer 1
- Catches syntax errors the regex can't detect
- Uses `@mdx-js/mdx` `compile()` function

### Downgrading Process

When a `.mdx` file is incompatible:

1. **Strip imports/exports** — all `import`/`export` lines removed
2. **Strip JSX components** — all uppercase tags removed, children preserved
3. **Convert JSX styles** — `style={{ textAlign: 'center' }}` → `style="text-align: center"`
4. **Remove admonitions** — `:::tip`, `:::warning` fences removed
5. **Clean up whitespace** — excessive blank lines collapsed
6. **Rename to `.md`** — file extension changed

---

## Image Handling

### Five scenarios:

1. **Same-directory image** — copied alongside markdown, no path change needed
2. **Remapped file's image** — relative path rewritten to account for new directory
3. **Absolute path image** (`/img/foo.png`) — resolved from `static/` directory
4. **External image** (outside source root) — searched upward, copied to `public/images/`
5. **Missing image** — SVG placeholder generated (400×300, shows filename)

### Path Rewriting

When pathMappings moves a file, image references are recomputed:

```
Original: connectors/intro.md → ../pipelines/arch.png
Mapped:   pipelines/connectors/intro.md → ../arch.png  ✓

Original: sql/ad-hoc.md → materialized.png (same dir)
Mapped:   pipelines/sql/ad-hoc.md → ./materialized.png  ✓
  (image also mapped to pipelines/sql/)
```

### Favicon

- Extracted from `docusaurus.config.ts` (`favicon: "img/favicon.ico"`)
- Resolved from `static/` directory
- Copied to `public/favicon.ico`
- Fallback: SVG with blue background and "J" letter

---

## Output Filtering

### Default mode (concise):

```
  ✓ Loaded site config
  ✓ Mirrored 127 files (3 downgraded)
  ✓ Generated navigation
  ✓ Dependencies ready
  ✓ Built 127 pages
  ✓ Indexed 127 pages for search

  Server running at http://localhost:3000
```

### Verbose mode (`--verbose`):

Shows all framework output: TypeScript detection, npm warnings, webpack compilation, Next.js banners, etc.

---

## Testing

**Total tests:** 2,031+
**Coverage thresholds:** 97% statements, 96% branches, 97% functions, 97% lines

```bash
# Run all tests
npm run test -w @jolli.ai/cli

# Run specific module tests
npm run test -w @jolli.ai/cli -- src/site/ContentMirror.test.ts
```

### Test categories:

- **Unit tests** — each function tested in isolation with `vi.mock`
- **Integration tests** — full pipeline tests using real temp directories
- **Property-based tests** — correctness invariants proven with `fast-check`
- **Error handling** — filesystem errors, invalid JSON, broken symlinks
- **Edge cases** — empty directories, duplicate keys, cross-platform paths
