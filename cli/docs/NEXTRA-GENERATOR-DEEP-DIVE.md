# Nextra Generator Deep Dive — Context for CLI Integration

> This document captures architecture research from the `feature/jolli-1392` branch.
> Use it as context to bring nextra-generator capabilities into the CLI app at `~/jolli.ai/jolli/cli`.

---

## Table of Contents

1. [Theme Pack System](#1-theme-pack-system)
2. [OpenAPI / API Doc Generation Pipeline](#2-openapi--api-doc-generation-pipeline)
3. [Header / Footer Configuration](#3-header--footer-configuration)
4. [site.json Schema Definition](#4-sitejson-schema-definition)
5. [Extraction Plan — Three Options](#5-extraction-plan--three-options)
6. [Key Source Files Reference](#6-key-source-files-reference)

---

## 1. Theme Pack System

### Overview

Three theme packs exist: **Classic** (legacy), **Forge**, and **Atlas**. Each pack generates 5 files: `layout.tsx`, theme CSS, `mdx-components.tsx`, `next.config.mjs`, and a catch-all `page.tsx`.

### Generation Pipeline

```
SiteBranding (JSON config)
  → buildThemeConfig()                         [memory.ts:2253]
  → applyTheme(packName, config)               [themes/index.ts:26]
  → applyPack(bindings, config)                [themes/Shared.ts:360]
  → 15 template tokens stamped into layout     [Shared.ts:360-423]
  → Output: 5 generated files
```

### Pack Bindings Interface (what each theme provides)

Each pack implements `PackBindings` (defined in `tools/nextra-generator/src/themes/Shared.ts:334-353`):

| Binding | Purpose |
|---------|---------|
| `classPrefix` | CSS namespace ("forge" / "atlas") |
| `cssPath` | Output path (`app/themes/forge.css`) |
| `buildCss({ accentHue, fontFamily })` | Full CSS file (1000+ lines per pack) |
| `buildLayout()` | Root `layout.tsx` with logo, navbar, footer, auth |
| `buildMdxComponents()` | MDX component registry (Atlas adds 5 extra components) |
| `buildNextConfig()` | `next.config.mjs` with pack-specific code highlighting |
| `buildFooterBody(siteName, footerConfig)` | Pack-specific footer JSX |
| `buildFontLink()` | Optional font `<link>` override |

### Template Tokens (stamped into layout)

`__SITE_NAME__`, `__SITE_DESCRIPTION__`, `__PRIMARY_HUE__`, `__DEFAULT_THEME__`, `__FAVICON_LINK__`, `__FONT_LINK__`, `__LOGO_IMG_LIGHT__`, `__LOGO_IMG_DARK__`, `__LOGO_TEXT__`, `__AUTH_PROVIDER_IMPORT__`, `__AUTH_PROVIDER_OPEN__`, `__AUTH_PROVIDER_CLOSE__`, `__AUTH_BANNER_IMPORT__`, `__AUTH_BANNER_SLOT__`, `__FOOTER_BODY__`

### Pack Manifests (defaults)

| Field | Forge | Atlas |
|-------|-------|-------|
| `primaryHue` | 228 (indigo) | 200 (cool blue) |
| `defaultTheme` | light | dark |
| `fontFamily` | inter | source-serif |
| Code theme (light/dark) | github-light / github-dark | min-light / dracula |
| Accent saturation | 84% | 70% |
| Layout | 5-col grid (sidebar 295px, article 680px, TOC 220px) | 3-col (sidebar 280px, article 820px, TOC 200px) |

### CSS Cascade Layers

When `customCss` is present (see `tools/nextra-generator/src/utils/CssLayers.ts`):
- Pack CSS → `@layer jolli-defaults { ... }`
- User CSS → `@layer jolli-user { ... }`
- User rules win without `!important`

### What CAN Be Expressed as JSON (SiteBranding)

```json
{
  "themePack": "forge | atlas",
  "logoUrl": "https://...",
  "logoUrlDark": "https://...",
  "favicon": "https://...",
  "logoDisplay": "text | image | both",
  "primaryHue": 228,
  "defaultTheme": "dark | light | system",
  "fontFamily": "inter | space-grotesk | ibm-plex | source-sans | source-serif",
  "headerLinks": { "items": [] },
  "footer": { "copyright": "", "columns": [], "socialLinks": {} },
  "customCss": ""
}
```

### What Is Baked Into Theme Code (NOT JSON-expressible)

- 1000+ lines of CSS per pack (design tokens, layout grid, sidebar, typography, code blocks)
- Atlas-only MDX components: `<Outcome>`, `<Decision>`, `<Quote>`, `<ActionItem>`, `<EntryFeed>`
- Footer rendering style (Forge: simple copyright row; Atlas: masthead with serif name)
- Font loading strategy (Atlas always adds Source Serif 4 for headlines)

---

## 2. OpenAPI / API Doc Generation Pipeline

### Five-Stage Pipeline

```
OpenAPI Spec (JSON/YAML)
  → Stage 1: Parse spec           [utils/openapi.ts]
       loadOpenApiSpec() + parseFullSpec()
       Walks paths/methods, resolves $ref, extracts operations/tags/schemas

  → Stage 2: Build data sidecars  [templates/api/EndpointData.ts]
       generateEndpointData() → per-operation JSON files
       Contains: resolved auth, grouped params, synthesized examples

  → Stage 3: Generate code samples [utils/CodeSamples.ts]
       generateCodeSamples() → { curl, js, ts, python, go }
       Hand-rolled string templates, zero external deps

  → Stage 4: Generate MDX pages   [templates/api/EndpointPage.ts, OverviewPage.ts, Sidebar.ts]
       Per-endpoint MDX shim + overview page + _meta.ts sidebar files

  → Stage 5: Emit components+CSS  [templates/api/Components.ts, themes/ApiCss.ts]
       9 React components + 700-line API-specific CSS
```

### Stage Details

**Stage 1 — `parseFullSpec()` output:**
```typescript
{
  info: { title, version, description },
  servers: Array<{ url, description? }>,
  securitySchemes: Record<string, OpenApiSecurityScheme>,
  globalSecurity: Array<Record<string, Array<string>>>,
  tags: Array<{ name, description? }>,
  operations: Array<OpenApiOperationFull>,
  componentSchemas: Record<string, unknown>
}
```

**Stage 2 — Data sidecars:**
- Output: `content/api-{specName}/_data/{operationId}.json`
- Uses `exampleFromSchema()` to synthesize request body examples when spec doesn't provide one
- JSON sidecars (not inline JS in MDX) to reduce Next.js per-page compile cost

**Stage 3 — Code samples:**
- Five languages: cURL, JavaScript, TypeScript, Python, Go
- Hand-rolled templates (~30 lines each), no `openapi-snippet` or `httpsnippet` dependency
- Python uses custom `toPythonLiteral()` (True/False/None), Go uses custom `goStringLiteral()`

**Stage 4 — MDX pages:**
- Overview: `content/api-{specName}/index.mdx` — all endpoints grouped by tag in tables
- Per-endpoint: `content/api-{specName}/{tagSlug}/{operationId}.mdx` — thin MDX shim that imports data + renders `<Endpoint>` component with slot-based children
- Sidebar: `_meta.ts` files at spec level and per-tag level
- Schema refs: `content/api-{specName}/_refs.ts` — shared `componentSchemas` map

**Stage 5 — React components (9 files in `components/api/`):**
1. `describeType.ts` — schema → human-readable type string
2. `EndpointMeta.tsx` — method pill + path + tags + deprecation badge
3. `ParamTable.tsx` — parameter table (path/query/header/cookie)
4. `SchemaBlock.tsx` — collapsible recursive schema renderer with `$ref` resolution + circular-ref detection
5. `ResponseBlock.tsx` — status code header + SchemaBlock
6. `AuthRequirements.tsx` — lists security schemes
7. `TryIt.tsx` — interactive request builder (fetch, auth persistence via sessionStorage)
8. `CodeSwitcher.tsx` — dropdown + copy button for code samples
9. `Endpoint.tsx` — top-level two-column layout wrapper

### Dependency Analysis

**Core layer (zero Nextra dependency, extractable):**

| File | Depends on | External deps |
|------|-----------|---------------|
| `utils/openapi.ts` | types.ts, slugify from content.ts | `yaml` npm package |
| `utils/CodeSamples.ts` | types.ts, SchemaExample.ts | none |
| `utils/SchemaExample.ts` | nothing | none |
| `templates/api/EndpointData.ts` | types.ts, SchemaExample.ts, openapi.ts | none |

**Nextra-coupled layer (would need adaptation for non-Nextra output):**

| File | Nextra coupling |
|------|----------------|
| `templates/api/EndpointPage.ts` | MDX frontmatter format, `_meta.ts` conventions, `_refs.ts` naming |
| `templates/api/Components.ts` | `"use client"`, Nextra CSS variables, RSC-safe slot detection |
| `themes/ApiCss.ts` | `--nextra-bg`, `.nextra-code`, `.nextra-toc` CSS selectors |
| `templates/api/Sidebar.ts` | Nextra's `_meta.ts` format |

### Utility Functions Needed (small, can be copied)

From `utils/content.ts`: `slugify`, `escapeMdxText`, `escapeYaml`, `escapeInlineCode` (~30 lines total)
From `utils/sanitize.ts`: `escapeHtml`, `escapeJsString` (~20 lines total)

### How CLI Currently Invokes It

In `tools/nextra-generator/src/Cli.ts`:
- `--openapi / -a` flag accepts an OpenAPI spec path
- Creates `OpenApiConfig { specPath, outputPath: "api-reference", title: "API Reference" }`
- Passes to `generateSite(config)` → app-router generator → `generateApiReferenceFiles()`

---

## 3. Header / Footer Configuration

### Data Model (from `common/src/core/SiteClient.ts`)

```typescript
// Header
interface HeaderLinksConfig {
    items: Array<HeaderNavItem>;  // max 6
}

interface HeaderNavItem {
    id?: string;           // editor-only UUID
    label: string;         // max 100 chars
    url?: string;          // direct link (mutually exclusive with items)
    items?: Array<ExternalLink>;  // dropdown items, max 8 (mutually exclusive with url)
}

interface ExternalLink {
    id?: string;
    label: string;         // max 100 chars
    url: string;           // max 2048 chars, http/https/mailto
}

// Footer
interface FooterConfig {
    copyright?: string;                 // max 200 chars
    columns?: Array<FooterColumn>;      // max 4
    socialLinks?: SocialLinks;
}

interface FooterColumn {
    id?: string;
    title: string;                      // max 100 chars
    links: Array<ExternalLink>;         // max 10 per column
}

interface SocialLinks {
    github?: string;
    twitter?: string;
    discord?: string;
    linkedin?: string;
    youtube?: string;
}
```

### Validation Limits (from `common/src/types/BrandingLimits.ts`)

| Limit | Value |
|-------|-------|
| `MAX_HEADER_ITEMS` | 6 |
| `MAX_DROPDOWN_ITEMS` | 8 |
| `MAX_LABEL_LENGTH` | 100 |
| `MAX_FOOTER_COLUMNS` | 4 |
| `MAX_FOOTER_LINKS_PER_COLUMN` | 10 |
| `MAX_COLUMN_TITLE_LENGTH` | 100 |
| `MAX_COPYRIGHT_LENGTH` | 200 |
| `MAX_URL_LENGTH` | 2048 |

### How Themes Render Header/Footer Differently

| Aspect | Forge | Atlas | Classic |
|--------|-------|-------|---------|
| Footer style | Simple: columns + bottom row (copyright, social, Powered by) | Masthead: large serif site name + columns + social | Inline JSX styles, flexbox |
| Social icons | Text-label links with CSS classes | Text-label links with CSS classes | Inline SVGs with opacity |
| Header alignment | Fixed by CSS | Centered via CSS | Configurable left/right |
| "Powered by" | Separate `<span>` in bottom row | Inline with copyright | Appended to copyright string |

### How Header Links Become Navbar Items

In `utils/content.ts`, function `generateNavMeta()`:
- Header nav items → `nav-0`, `nav-1`, ... entries in Nextra's `_meta.ts`
- Direct links → `ExternalLinkMetaEntry { title, href, newWindow: true }`
- Dropdowns → `MenuNavMeta { title, type: "menu", items: { ... } }`

### How Footer Gets Into Layout

```
footerConfig → applyPack() → bindings.buildFooterBody(siteName, footerConfig)
  → JSX string → stamped into __FOOTER_BODY__ token in layout template
```

Shared helpers in `themes/Shared.ts`:
- `renderFooterColumns(footerConfig, classPrefix)` — maps columns to `<div>/<h4>/<ul>/<li>`
- `renderSocialLinks(socialLinks, classPrefix)` — filters populated platforms → `<a>` tags
- `buildFooterScaffold(classPrefix, columnsJsx, bottomRows)` — wraps in footer container

---

## 4. site.json Schema Definition

This is the complete JSON schema a CLI could accept to generate a full Nextra site:

```json
{
  "$schema": "site-schema.json",
  "site": {
    "name": "Acme Documentation",
    "description": "Official docs for the Acme platform",
    "url": "https://docs.acme.com"
  },
  "branding": {
    "themePack": "forge",
    "primaryHue": 228,
    "fontFamily": "inter",
    "defaultTheme": "light",
    "logoUrl": "https://cdn.acme.com/logo.svg",
    "logoUrlDark": "https://cdn.acme.com/logo-dark.svg",
    "favicon": "https://cdn.acme.com/favicon.ico",
    "logoDisplay": "both",
    "customCss": ".my-class { color: red; }"
  },
  "headerLinks": {
    "items": [
      {
        "label": "API Reference",
        "url": "/api-reference"
      },
      {
        "label": "SDKs",
        "items": [
          { "label": "JavaScript", "url": "https://github.com/acme/js-sdk" },
          { "label": "Python", "url": "https://github.com/acme/python-sdk" },
          { "label": "Go", "url": "https://github.com/acme/go-sdk" }
        ]
      },
      {
        "label": "Blog",
        "url": "https://blog.acme.com"
      },
      {
        "label": "GitHub",
        "url": "https://github.com/acme"
      }
    ]
  },
  "footer": {
    "copyright": "2026 Acme Inc.",
    "columns": [
      {
        "title": "Product",
        "links": [
          { "label": "Features", "url": "https://acme.com/features" },
          { "label": "Pricing", "url": "https://acme.com/pricing" },
          { "label": "Changelog", "url": "https://acme.com/changelog" }
        ]
      },
      {
        "title": "Developers",
        "links": [
          { "label": "Quickstart", "url": "/quickstart" },
          { "label": "API Reference", "url": "/api-reference" },
          { "label": "SDK Docs", "url": "/sdks" }
        ]
      },
      {
        "title": "Company",
        "links": [
          { "label": "About", "url": "https://acme.com/about" },
          { "label": "Careers", "url": "https://acme.com/careers" },
          { "label": "Contact", "url": "https://acme.com/contact" }
        ]
      }
    ],
    "socialLinks": {
      "github": "https://github.com/acme",
      "twitter": "https://twitter.com/acme",
      "discord": "https://discord.gg/acme",
      "linkedin": "https://linkedin.com/company/acme",
      "youtube": "https://youtube.com/@acme"
    }
  },
  "openApiSpecs": [
    {
      "specPath": "./openapi.yaml",
      "title": "API Reference",
      "outputPath": "api-reference"
    }
  ],
  "content": {
    "inputDir": "./docs",
    "outputDir": "./out"
  },
  "auth": {
    "provider": "none"
  }
}
```

---

## 5. Extraction Plan — Three Options

### Option A: Copy Code to CLI (fastest, most duplication)

Copy these files into `cli/src/`:
```
FROM tools/nextra-generator/src/          TO cli/src/nextra/
  utils/openapi.ts                          openapi.ts
  utils/CodeSamples.ts                      CodeSamples.ts
  utils/SchemaExample.ts                    SchemaExample.ts
  utils/content.ts (slugify + escape fns)   utils.ts (subset)
  utils/sanitize.ts (escapeHtml etc.)       utils.ts (append)
  utils/CssLayers.ts                        CssLayers.ts
  templates/api/index.ts                    api/index.ts
  templates/api/EndpointData.ts             api/EndpointData.ts
  templates/api/EndpointPage.ts             api/EndpointPage.ts
  templates/api/OverviewPage.ts             api/OverviewPage.ts
  templates/api/Sidebar.ts                  api/Sidebar.ts
  templates/api/Components.ts               api/Components.ts
  themes/ApiCss.ts                          themes/ApiCss.ts
  themes/Shared.ts                          themes/Shared.ts
  themes/forge/                             themes/forge/
  themes/atlas/                             themes/atlas/
  themes/index.ts                           themes/index.ts
  types.ts (OpenAPI subset)                 types.ts
```

**Pros:** No monorepo refactoring, CLI is self-contained.
**Cons:** Code duplication — changes in nextra-generator must be manually synced.

### Option B: Extract Shared Library (cleanest, most work)

Create `packages/nextra-core/` in the monorepo:
```
packages/nextra-core/
  src/
    parser/
      openapi.ts        ← parseFullSpec, loadOpenApiSpec
      types.ts           ← 20+ OpenAPI interfaces
    codegen/
      CodeSamples.ts
      SchemaExample.ts
      EndpointData.ts
    templates/
      api/               ← EndpointPage, OverviewPage, Sidebar, Components
    themes/
      Shared.ts, ApiCss.ts, CssLayers.ts
      forge/, atlas/, classic/
    utils.ts             ← slugify, escape functions
  package.json           ← deps: yaml
```

Both `tools/nextra-generator` and `cli` import from `@jolli/nextra-core`.

**Pros:** Single source of truth, no duplication.
**Cons:** Requires monorepo package setup, more initial work.

### Option C: JSON Schema + CLI Reads site.json (most flexible)

CLI accepts a `site.json` (schema defined in section 4 above) and calls into the existing nextra-generator as a dependency or subprocess.

```bash
# CLI invocation
jolli generate --config site.json --output ./out

# Or as subprocess
npx nextra-generator --config site.json --output ./out
```

**Pros:** Decoupled, CLI is thin, all logic stays in nextra-generator.
**Cons:** Requires nextra-generator to accept site.json as input (currently it doesn't — it takes CLI flags or in-memory objects from the backend). You'd need to add a `--config` flag to `Cli.ts`.

### Recommended Hybrid Approach

1. **Short term:** Add `--config site.json` support to `tools/nextra-generator/src/Cli.ts` (Option C). The CLI calls nextra-generator as a subprocess or importable function.
2. **Medium term:** Extract core parser + codegen into `packages/nextra-core/` (Option B) as you add more consumers.

---

## 6. Key Source Files Reference

### Theme System
| File | Purpose |
|------|---------|
| `common/src/types/ThemePacks.ts` | Theme pack metadata (UI-only, for preview cards) |
| `common/src/core/SiteClient.ts:104-233` | `SiteBranding` interface, `SiteThemePack` type |
| `tools/nextra-generator/src/themes/index.ts` | Theme dispatch (`applyTheme`) |
| `tools/nextra-generator/src/themes/Shared.ts:334-423` | `PackBindings` interface, `applyPack()` core engine |
| `tools/nextra-generator/src/themes/forge/` | Forge: Manifest, Apply, styles, templates |
| `tools/nextra-generator/src/themes/atlas/` | Atlas: Manifest, Apply, styles, templates |
| `tools/nextra-generator/src/themes/classic/` | Classic legacy compatibility shim |
| `tools/nextra-generator/src/utils/CssLayers.ts` | CSS cascade layer wrapping |

### OpenAPI Pipeline
| File | Purpose |
|------|---------|
| `tools/nextra-generator/src/utils/openapi.ts` | Spec loading + `parseFullSpec()` |
| `tools/nextra-generator/src/utils/CodeSamples.ts` | 5-language code sample generation |
| `tools/nextra-generator/src/utils/SchemaExample.ts` | Schema → example value synthesis |
| `tools/nextra-generator/src/templates/api/index.ts` | Orchestrator: `generateApiReferenceFiles()` |
| `tools/nextra-generator/src/templates/api/EndpointData.ts` | Per-operation JSON sidecar |
| `tools/nextra-generator/src/templates/api/EndpointPage.ts` | Per-endpoint MDX shim |
| `tools/nextra-generator/src/templates/api/OverviewPage.ts` | Overview page with endpoint tables |
| `tools/nextra-generator/src/templates/api/Sidebar.ts` | `_meta.ts` sidebar files |
| `tools/nextra-generator/src/templates/api/Components.ts` | 9 React components |
| `tools/nextra-generator/src/themes/ApiCss.ts` | API-specific CSS (~700 lines) |

### Header/Footer
| File | Purpose |
|------|---------|
| `common/src/core/SiteClient.ts:133-180` | Type definitions (`HeaderNavItem`, `FooterConfig`, etc.) |
| `common/src/types/BrandingLimits.ts` | Validation limits |
| `backend/src/util/BrandingValidation.ts` | Server-side validation (pure functions, reusable) |
| `tools/nextra-generator/src/utils/content.ts` | `generateNavMeta()` — header links → `_meta.ts` |
| `tools/nextra-generator/src/themes/Shared.ts` | `renderFooterColumns()`, `renderSocialLinks()`, `buildFooterScaffold()` |

### Generator Entry Points
| File | Purpose |
|------|---------|
| `tools/nextra-generator/src/Cli.ts` | CLI entry (`--openapi`, `--theme`, etc.) |
| `tools/nextra-generator/src/generators/memory.ts` | In-memory generator (used by backend) |
| `tools/nextra-generator/src/generators/app-router.ts` | File-system generator (used by CLI) |
| `tools/nextra-generator/src/types.ts` | All type definitions (ThemeConfig, OpenAPI types, GeneratorConfig) |
