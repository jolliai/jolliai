/**
 * @jolli.ai/site-core — framework-agnostic core for Jolli documentation
 * site generation.
 *
 * Pure-logic portion of the site pipeline (navigation parsing, content
 * planning, OpenAPI IR, Nextra emitter, schema coercions, framework
 * detection, starter templates, Docusaurus import). File I/O and
 * subprocess work stay in the consumer (CLI or web tool); biome
 * `noRestrictedImports` enforces this at the package boundary.
 *
 * Note on naming: Sanitize.ts and openapi/Escape.ts both define an
 * `escapeHtml` function (Sanitize.ts is the canonical/general one;
 * openapi/Escape.ts is OpenAPI-specific and differs from Sanitize.ts
 * only in apostrophe encoding — `&#39;` vs `&#039;`, an unintended drift
 * to unify in a follow-up). To avoid shadowing, the OpenAPI variant is
 * re-exported here as `escapeOpenApiHtml`.
 */

/** Current package version. Bumped per release; read by consumers for diagnostics. */
export const VERSION = "0.1.0";

// ─── Color utilities ──────────────────────────────────────────────────────
export * from "./ColorUtils.js";
// ─── Content planning (pure half — produce the source→target plan) ─────────
export * from "./ContentPlanner.js";
// ─── Custom scripts (.jolli/scripts/) — constants + path predicate ──────────
export * from "./CustomScripts.js";
// ─── Docusaurus → Jolli converter (pure transform half) ─────────────────────
export * from "./DocusaurusConverter.js";
// ─── Framework detection (rules + types; CLI provides the filesystem scan) ─
export * from "./FrameworkDetector.js";
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
// ─── Nextra renderer: API CSS + emitter surface ────────────────────────────
export { buildApiCss, generateApiCss } from "./renderer/nextra/ApiCss.js";
export * from "./renderer/nextra/index.js";
// ─── Sanitization ──────────────────────────────────────────────────────────
export { escapeHtml, sanitizeUrl } from "./Sanitize.js";
// ─── Scope page-map (Nextra sidebar scoping helper) ────────────────────────
export * from "./ScopePageMap.js";
// ─── site.json schema coercions (deprecated-alias migration) ───────────────
export * from "./SiteJsonSchema.js";
// ─── site.json shape validation (friendly diagnostics) ─────────────────────
export * from "./SiteJsonValidator.js";
// ─── Starter kit (templates for `jolli new` / web "new site" flow) ─────────
export { getStarterFiles } from "./StarterKit.js";
// ─── Navigation structure parsing (sidebar tree from site.json) ────────────
export * from "./StructureParser.js";
// ─── Site-level types (sidebar, footer, navigation, themes, …) ─────────────
export * from "./Types.js";
// ─── Theme helpers (footer JSX-string builders shared across packs) ────────
export * from "./themes/Footer.js";
