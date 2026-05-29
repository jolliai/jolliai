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

export {
	escapeHtml as escapeOpenApiHtml,
	escapeInlineCode,
	escapeJsString,
	escapeMdxText,
	escapeYaml,
} from "./openapi/Escape.js";
export { isReservedSlug } from "./openapi/ReservedWords.js";
export { slugify } from "./openapi/Slug.js";
export { escapeHtml, sanitizeUrl } from "./Sanitize.js";
