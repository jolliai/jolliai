/**
 * Sanitize.ts — URL and HTML escape helpers for the site-generation pipeline.
 *
 * Single source of truth for the allow-list-based URL sanitiser used by every
 * layout, footer renderer, and `_meta.js` writer. Previously these helpers
 * were duplicated across `themes/forge/Layout.ts`, `themes/atlas/Layout.ts`,
 * `themes/Footer.ts`, `NextraProjectWriter.ts`, and `renderer/nextra/Components.ts` —
 * five copies of the same allow-list. Consolidating here means a future
 * tightening of the allow-list (e.g. blocking `data:` even where benign) only
 * has to be made once.
 *
 * The `openapi/Escape.ts` module is purpose-built for the per-endpoint MDX
 * pipeline (YAML, MDX text, JS strings, inline-code, HTML entities for table
 * cells) and stays separate — different mediums, different escaping rules.
 */

// ─── sanitizeUrl ─────────────────────────────────────────────────────────────

const SAFE_URL_PATTERN = /^(?:https?:|mailto:|tel:|[#?/]|\.\.?\/)/i;

/**
 * Allow http(s), mailto, tel, fragments, query strings, and absolute or
 * relative paths. Anything else (`javascript:`, `data:`, `vbscript:`, etc.)
 * is replaced with `"#"` so a malicious site.json cannot inject a script
 * URL into the generated layout, footer, or `_meta.js`.
 *
 * Trims leading / trailing whitespace before testing the scheme so a value
 * like `"  javascript:alert(1)"` cannot bypass the check.
 */
export function sanitizeUrl(url: string): string {
	const trimmed = url.trim();
	if (trimmed === "" || SAFE_URL_PATTERN.test(trimmed)) {
		return trimmed;
	}
	return "#";
}

// ─── escapeHtml ──────────────────────────────────────────────────────────────

/**
 * Escape characters with special meaning when spliced into generated JSX
 * (`app/layout.tsx`, footer body strings) or HTML attributes. Handles
 * `&`, `<`, `>`, `"`, single quotes, and curly braces (which would
 * otherwise open a JSX expression). Mirrors the SaaS implementation in
 * `tools/nextra-generator/src/utils/sanitize.ts` so output stays
 * byte-identical between the two surfaces.
 */
export function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/\{/g, "&#123;")
		.replace(/\}/g, "&#125;");
}
