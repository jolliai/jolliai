/**
 * @jolli.ai/site-core — framework-agnostic core for Jolli documentation
 * site generation.
 *
 * Pure-logic portion of the site pipeline (navigation parsing, content
 * planning, OpenAPI IR, Nextra emitter). File I/O and subprocess work
 * stay in the consumer (CLI or web tool); biome lint enforces this at
 * the package boundary.
 *
 * Migration in progress — additional exports land as files migrate
 * from `cli/src/site/` in subsequent phases.
 *
 * Note on naming: Sanitize.ts and openapi/Escape.ts both define an
 * `escapeHtml` function (Sanitize.ts is the canonical/general one;
 * openapi/Escape.ts is OpenAPI-specific and differs from Sanitize.ts
 * only in apostrophe encoding — `&#39;` vs `&#039;`, an unintended drift
 * to unify in a follow-up). To avoid shadowing, the OpenAPI variant is
 * re-exported here as `escapeOpenApiHtml`.
 */

/** Current package version. Bumped per release; read by consumers for diagnostics. */
export const VERSION = "0.0.0";

// ─── Color utilities ──────────────────────────────────────────────────────
export * from "./ColorUtils.js";
// ─── Content planning (pure half — produce the source→target plan) ─────────
export * from "./ContentPlanner.js";
// ─── Meta generation (pure half — build _meta.js entry lists) ──────────────
export * from "./MetaGenerator.js";
// ─── OpenAPI: helpers ──────────────────────────────────────────────────────
export { generateCodeSamples, goStringLiteral, toPythonLiteral } from "./openapi/CodeSampleGenerator.js";
export {
	escapeHtml as escapeOpenApiHtml,
	escapeInlineCode,
	escapeJsString,
	escapeMdxText,
	escapeYaml,
} from "./openapi/Escape.js";
// ─── OpenAPI: IR + pipeline ────────────────────────────────────────────────
export { buildPipeline } from "./openapi/OpenApiPipeline.js";
export { isReservedSlug } from "./openapi/ReservedWords.js";
export { exampleFromSchema } from "./openapi/SchemaExample.js";
export { slugify } from "./openapi/Slug.js";
export { isOpenApiExtension, tryParseOpenApi } from "./openapi/SpecLoader.js";
export { deriveSpecName } from "./openapi/SpecName.js";
export { parseFullSpec } from "./openapi/SpecParser.js";
// ─── OpenAPI: types ────────────────────────────────────────────────────────
export * from "./openapi/Types.js";
// ─── Sanitization ──────────────────────────────────────────────────────────
export { escapeHtml, sanitizeUrl } from "./Sanitize.js";
// ─── Scope page-map (Nextra sidebar scoping helper) ────────────────────────
export * from "./ScopePageMap.js";
// ─── Navigation structure parsing (sidebar tree from site.json) ────────────
export * from "./StructureParser.js";
// ─── Site-level types (sidebar, footer, navigation, themes, …) ─────────────
export * from "./Types.js";
