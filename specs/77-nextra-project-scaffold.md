# 77. Nextra Project Scaffold

## Topic Statement

Generating a Nextra v4 project scaffold inside the staged build directory — including a `package.json` with pinned dependencies, a `next.config.mjs`, an App Router layout, an MDX-component map, a TypeScript configuration with a path alias, and a 404 page and catch-all page route — and dispatching to a per-theme-pack layout when the user has selected one.

## Scope

**In scope:**
- The set of files written into the build directory.
- The folder layout the scaffold creates (`content/`, `app/`, `app/[[...mdxPath]]/`, optionally `app/themes/`).
- The pinned runtime dependency set and the dev dependency set used in the generated `package.json`.
- The minimal `next.config.mjs` and the optional static-export switch.
- The default layout shape: header (navbar) with logo and links, optional dropdown items, and a footer with optional columns/copyright/social links.
- The per-theme-pack layout dispatch, with three packs: a default vanilla shell, a Forge pack (clean dev docs), and an Atlas pack (editorial).
- The favicon `<link>` tag wiring inside theme-pack layouts.
- The pack-specific stylesheet written under `app/themes/<pack>.css` for non-default packs.
- The MDX component-mapping module, the 404 page, and the catch-all route page that drive Nextra v4's App Router rendering.
- The TypeScript configuration with an `@/*` alias mapping to the build directory root, used by generated MDX shims to import shared components.
- Idempotent regeneration of all config files on every run, while preserving any pre-existing `content/` directory.

**Out of scope:**
- The mirroring of source content into `content/` (covered by the content-mirroring topic).
- The OpenAPI rendering pipeline that emits per-endpoint MDX shims and per-operation JSON sidecars (covered by separate OpenAPI topics).
- The favicon resolution and copy step (covered by the favicon-resolution topic).
- Sidebar `_meta.js` generation (covered by a separate sidebar-files topic).
- The actual `next dev` / `next build` runs (covered by separate engine-management topics).

## Data Contracts

### Build directory

The scaffold operates inside a build directory whose path is supplied by the caller (conventionally `<source-root>/.jolli-site/`). The scaffold creates the directory if missing.

### Files written

On every run, the scaffold writes the following files (overwriting previous content):

- `package.json` — pinned dependency set (see "Pinned dependency set" below).
- `next.config.mjs` — minimal Next.js + Nextra configuration (see "next.config" below).
- `app/layout.tsx` — root layout, dispatched per theme pack.
- `app/not-found.tsx` — 404 page.
- `app/[[...mdxPath]]/page.tsx` — catch-all route that renders content from the `content/` folder.
- `mdx-components.tsx` — MDX component map.
- `tsconfig.json` — TypeScript configuration with a path alias.

For non-default theme packs, additionally:
- `app/themes/forge.css` (Forge pack) or `app/themes/atlas.css` (Atlas pack) — pack-specific stylesheet derived from the configured accent hue and font family.

### Folders created

Always:
- `content/` (preserved if it already exists, contents untouched).
- `app/[[...mdxPath]]/`.

When a non-default theme pack is selected:
- `app/themes/`.

### Pinned dependency set (runtime)

- `next`: `^15.0.0`.
- `nextra`: `4.2.17`.
- `nextra-theme-docs`: `4.2.17`.
- `react`: `^19.0.0`.
- `react-dom`: `^19.0.0`.
- `pagefind`: `^1.0.0`.

### Pinned dependency set (development)

- `@types/react`: `^19.0.0`.
- `typescript`: `^5.0.0`.

### `package.json` content

```
{
  "name": "jolli-site",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": { ... runtime set ... },
  "devDependencies": { ... dev set ... }
}
```

The serialized form uses two-space indentation. The runtime and dev dependency sets are also exported as named constants used elsewhere (the engine-management topic uses them to ensure dependencies are up-to-date).

### `next.config.mjs` content

A minimal Nextra v4 configuration:
- Imports the Nextra configuration factory.
- Invokes it with `contentDirBasePath` set to `/`.
- Exports the result wrapping the user's Next config.
- The user config configures the bundler so relative-image resolution is preferred, ensuring relative-image references resolve as expected in the static-image pipeline.
- An optional static-export branch enables Next.js static export and disables image optimization when the caller passes a `staticExport` flag.

Nextra v4's theme and theme-config options are deliberately absent — those are configured via `app/layout.tsx` and `mdx-components.tsx` instead.

### Layout dispatch

The layout generator inspects `theme.pack` (the chosen theme pack from `site.json`):
- `default` (or unset) → emit a vanilla Nextra layout.
- `forge` → emit the Forge pack layout, additionally writing `app/themes/forge.css`.
- `atlas` → emit the Atlas pack layout, additionally writing `app/themes/atlas.css`.

Each layout is responsible for emitting:
- A document `<html>` and `<body>` shell with `lang="en"`, `dir="ltr"`, and hydration-warning suppression enabled.
- The framework's document-head component.
- The site title and description as page metadata.
- A header (navbar) with the logo and the resolved header items.
- A footer with optional columns, copyright, and social links.
- (Theme packs only) a `<link rel="icon">` tag when a favicon URL is configured.
- A reference to a stylesheet:
  - Default layout imports the docs theme's stylesheet and the project's `../styles/api.css` (a stylesheet provided by the OpenAPI rendering pipeline).
  - Theme-pack layouts import their own pack-specific stylesheet (`./themes/forge.css` or `./themes/atlas.css`) in addition to the base styles.

### Header items

The header items list is resolved as:
- If `header.items` is set and non-empty, use it.
- Otherwise, coerce the legacy flat `nav` (a list of `{ label, href }`) into header items (each with `label` and `url`, no dropdown).

Each rendered item is one of:
- A direct `<a>` link (item has a `url`, no `items`).
- A `<details>`-based dropdown (item has nested `items`), with each sub-item rendered as a link inside a positioned panel.

### Footer body

The footer body has three optional sections, rendered when present:
- Columns: a row of `{ title, links }` blocks, each with a heading and an unordered list of links.
- Copyright: a single span with the configured text.
- Social links: a row of platform-labeled `<a>` elements; recognized platforms are `github`, `twitter`, `discord`, `linkedin`, `youtube`, rendered in that fixed order, and only when the platform's URL is set and non-empty.

If none of the three sections has content, an empty `<Footer />` is emitted.

### URL sanitization

All emitted URLs (header links, footer links, social links, favicon) are passed through a sanitizer that allows http(s), mailto, tel, fragment-only, query-only, and absolute or relative path URLs, and replaces anything else with `#`. This prevents a malicious `site.json` from injecting a `javascript:`, `data:`, or `vbscript:` URL into the layout.

### MDX component-map module

Always-emitted content of `mdx-components.tsx`:
- Imports the docs theme's components helper, aliasing it locally so it can be invoked under a different name.
- Invokes that helper once at module scope to obtain the docs theme's components.
- Exports the standard MDX-components helper that merges the docs components with any caller-provided components (caller wins on key conflict).

### Catch-all page route

Always-emitted content of `app/[[...mdxPath]]/page.tsx`:
- Imports the framework's static-params generator (configured for the catch-all `mdxPath` route segment) and its on-demand page importer.
- Imports the standard MDX-components helper from the project's `mdx-components.tsx`.
- Exports a `generateStaticParams` bound to the `mdxPath` segment.
- Exports an async metadata generator that loads the page and returns its metadata.
- Defines an async page component that imports the page, retrieves the MDX content, table of contents, and metadata, and wraps the content in the docs wrapper component.

### 404 page

Always-emitted content of `app/not-found.tsx`:
- Re-exports the docs theme's not-found page as the default export.
- Required by Next.js 15 during static export to resolve the `/_not-found` route.

### TypeScript configuration

Always-emitted content of `tsconfig.json`:
- Compiler options: `target: ES2020`, `lib: [ES2020, DOM, DOM.Iterable]`, `jsx: preserve`, `module: ESNext`, `moduleResolution: bundler`, `resolveJsonModule: true`, `isolatedModules: true`, `strict: true`, `skipLibCheck: true`, `esModuleInterop: true`, `baseUrl: .`, `paths: { "@/*": ["./*"] }`.
- Includes: `**/*.ts`, `**/*.tsx`, `mdx-components.tsx`.
- Excludes: `node_modules`.

The `@/*` alias maps to the build root, so generated MDX shims (e.g., per-endpoint OpenAPI pages) can import `@/components/api/Endpoint` regardless of how deep they sit under `content/`. Next.js resolves the alias at bundle time via the same tsconfig.

### Result returned to caller

The scaffold returns `{ isNew: boolean }` indicating whether the build directory was created on this call (true) or already existed (false). Callers may use this signal to decide whether to run a one-time setup step like installing dependencies.

## Behavior

### Top-level scaffold flow

1. Check whether the build directory already exists. Capture the answer as `isNew = !existsSync(buildDir)`.
2. Create the `content/` and `app/[[...mdxPath]]/` subdirectories (recursive; idempotent).
3. Write `package.json`, `next.config.mjs`, `app/layout.tsx`, `app/not-found.tsx`, `app/[[...mdxPath]]/page.tsx`, `mdx-components.tsx`, and `tsconfig.json`. All overwrites.
4. If a non-default theme pack is selected, create `app/themes/`, generate the pack's stylesheet from the configured accent hue and font family (with pack-specific defaults applied where the configured value is unset), and write it to `app/themes/<pack>.css`.
5. Return `{ isNew }`.

### Layout dispatch

`generateLayout(config)` reads `config.theme?.pack`:
- `forge` → call the Forge layout generator with the resolved input (title, description, nav, header, footer, theme, legacy favicon).
- `atlas` → call the Atlas layout generator with the same input shape.
- Otherwise → emit the default Nextra layout inline.

### Default Nextra layout emission

1. JSON-stringify `title` and `description` for safe embedding.
2. Resolve the header items (header.items if set, else flat nav).
3. Render each header item as either a link or a `<details>` dropdown.
4. Build the footer body. If empty, emit an empty footer element; otherwise wrap the body in the footer element.
5. Emit a layout file that imports the docs theme's layout shell, navbar, and footer components, the framework's document-head component, the framework's page-map loader, plus the two stylesheets.
6. Define `metadata` using the title and description.
7. Define an async root-layout default export returning a document tree of `<html><body><Layout navbar={...} pageMap={...} footer={...}>{children}</Layout></body></html>`.

### Theme-pack layouts (Forge / Atlas)

Each theme-pack layout generator receives a resolved input that incorporates pack-specific defaults (e.g., Forge defaults to `primaryHue: 228`, `defaultTheme: light`, `fontFamily: inter`; Atlas to `primaryHue: 200`, `defaultTheme: dark`, `fontFamily: source-serif`). The Atlas pack adds an editorial visual treatment with serif headlines, a top-nav, and a masthead footer; the Forge pack uses a sidebar-first layout, hairline borders, and Inter typography.

Both pack layouts emit a favicon `<link>` tag when a configured favicon URL is present (the legacy top-level `favicon` wins over `theme.favicon`).

### Idempotent regeneration

Every run rewrites the config files (package.json, next.config, layouts, mdx-components, tsconfig). The `content/` folder is created once and preserved across runs. Pre-existing files outside the always-overwritten set (e.g., a user-edited `app/themes/custom.css`) are not removed but may be ignored by Next.js if they are not referenced by the generated layout.

## State Transitions

The build directory moves through these states across runs:

- **Absent:** the directory does not exist; the scaffold creates it and writes all files; `isNew = true`.
- **Present, current:** the directory exists with files matching the current run's configuration; the scaffold rewrites them in place; `isNew = false`. (Notable: even if no values changed, files are still rewritten.)
- **Present, stale:** the directory exists with files reflecting an earlier configuration; the scaffold rewrites them in place to reflect the latest values; `isNew = false`.

The `content/` subdirectory is independently managed by the content-mirroring topic; the scaffold creates it but never clears it.

## Notable Behavior

- **App Router only.** Nextra v4 requires Next.js 15's App Router; content lives in `content/`, not `pages/`. The theme is configured via component props in `app/layout.tsx` rather than a standalone `theme.config.tsx`.
- **Pinned versions.** The runtime dependency set pins `nextra` and `nextra-theme-docs` to an exact version (`4.2.17`) rather than using a range. This prevents silent breakage from upstream changes; upgrading requires bumping the pin.
- **`swagger-ui-react` is gone.** Earlier versions of the scaffold included `swagger-ui-react` for OpenAPI rendering. The new OpenAPI pipeline emits per-endpoint MDX with custom components, so the runtime no longer pulls a Swagger UI bundle.
- **Two stylesheets imported by the default layout.** The default layout imports both the docs theme's stylesheet (the base theme) and `../styles/api.css` (the OpenAPI-pipeline stylesheet). The latter is written by a separate step in the OpenAPI pipeline; the layout assumes it will exist by build time.
- **Theme packs add their own stylesheet.** When the user selects Forge or Atlas, the scaffold writes a pack-specific stylesheet under `app/themes/`. The pack's layout imports this stylesheet directly, so it must land before `next dev` reads the layout module.
- **Favicon `<link>` is emitted only by theme packs.** The vanilla default layout omits the explicit `<link>` and relies on Next.js's automatic discovery of `public/favicon.ico` (always materialized by the favicon resolver).
- **URL sanitization is layout-wide.** Every URL embedded into the layout (header links, footer links, social links, favicon) is sanitized; only well-known schemes and path-like strings pass through. Anything else is replaced with `#`. This is the layout's defense-in-depth against a malicious or mistaken `site.json`.
- **Header coercion preserves backward compatibility.** Sites authored before `header.items` was introduced supply a flat `nav`. The layout coerces this flat list into dropdown-less header items so the rendered output is identical for those sites.
- **Social-link order is fixed.** The five recognized social platforms render in this order: github, twitter, discord, linkedin, youtube. Platforms not in the list are silently dropped.
- **Catch-all route uses the framework's on-demand page importer.** The catch-all page imports the requested page on demand and wraps it in the docs theme's MDX components. This is the standard Nextra v4 pattern; the scaffold writes it verbatim.
- **`mdx-components.tsx` merges caller components into docs components.** The exported MDX-components helper lets per-page MDX shims (e.g., from the OpenAPI pipeline) supply additional components without losing the docs theme's defaults. Caller-provided components win on key conflict.
- **`tsconfig.json`'s `@/*` alias is structural.** Generated MDX shims may sit at any depth under `content/`; the alias lets them import shared components by a stable name. Without the alias, every shim would need a relative path that depends on its own location.
- **`isNew` is a one-shot signal.** It is `true` only on the run that creates the build directory. Subsequent runs return `false`. Callers that want to install dependencies on first creation use this signal as a trigger.
- **Static-export switch is opt-in.** The default `next.config.mjs` does not enable static export; callers must pass `staticExport: true` to the scaffold to produce a config that emits `output: 'export'`. The Pagefind-based search index relies on this static export when in use.

## Shared Behavior

- The site-configuration discovery topic supplies the configuration object that drives layout generation (title, description, nav, header, footer, theme, favicon).
- The favicon-resolution topic places `public/favicon.ico` and is the source of the favicon URL referenced by theme-pack layouts.
- The content-mirroring topic populates `content/` with markdown and images.
- The OpenAPI rendering pipeline writes the additional stylesheet referenced by the default layout (`styles/api.css`) and emits per-endpoint MDX shims that import shared components via the `@/*` alias.
- The engine-management topics consume the dependency sets to install or update node modules and to invoke `next dev` / `next build` / `next start`.
