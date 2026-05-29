# @jolli.ai/site-core

Framework-agnostic core for Jolli documentation site generation. Hosts the pure-logic portion of the site pipeline — navigation parsing, content planning, the OpenAPI IR, and the Nextra emitter — so the CLI ([`@jolli.ai/cli`](https://github.com/jolliai/jolliai/tree/main/cli)) and the Jolli web tool can share one implementation.

This package contains **no file I/O and no subprocess spawning**. The consumer (CLI or web tool) provides those at the edge. Biome `noRestrictedImports` enforces this at lint time: `node:fs`, `node:fs/promises`, and `node:child_process` are forbidden in `src/**`.

## Surface

```ts
import {
  // Navigation parsing (site.json → sidebar tree)
  parseNavigation, parsePages, normalizeHrefSegments,
  // Content planning (navigation → source/target file plan)
  buildNavigationContentPlan, validateNavigationPaths,
  // Sidebar _meta.js entry building + root-tab injection
  buildMetaEntries, injectRootNavEntries, serializeMetaEntries,
  // OpenAPI IR + Nextra emitter
  parseFullSpec, buildPipeline, emitNextraOpenApiFiles, generateApiCss,
  // site.json schema migrations (deprecated-alias coercion)
  applyDeprecatedSchemaAliases, DEFAULT_SITE_JSON,
  // Docusaurus import helper (pure transform — pass a loaded sidebars.js module)
  convertDocusaurusSidebarObject,
  // Framework detection rules + starter-site bundle
  FRAMEWORK_RULES, getStarterFiles,
  // Sanitization + small utilities
  sanitizeUrl, escapeHtml, slugify, hexToHsl,
} from "@jolli.ai/site-core";
```

The full export list is in [`src/index.ts`](src/index.ts).

## License

Apache-2.0
