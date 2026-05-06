/**
 * Escape — small string-escape helpers shared by the OpenAPI emitters.
 *
 * Lives in `openapi/` rather than under a specific renderer because every
 * framework emitter we care about (Nextra now, Fumadocs later) writes MDX
 * and reuses these same primitives. None of these depend on a particular
 * docs framework.
 */

const YAML_SPECIAL_VALUES = new Set(["true", "false", "yes", "no", "on", "off", "null", "~"]);

// ─── escapeYaml ──────────────────────────────────────────────────────────────

/**
 * Escapes special characters in YAML string values and quotes the value if
 * it would otherwise be parsed as a non-string type:
 *  - Strings starting with a digit (would be parsed as a number)
 *  - YAML special values (`true`, `false`, `null`, `yes`, `no`, `on`, `off`, `~`)
 */
export function escapeYaml(str: string): string {
	const hasSpecialChars = /[:#[\]{}|>`\n\r]/.test(str) || str.includes('"') || str.includes("'");
	const startsWithDigit = /^[0-9]/.test(str);
	const isSpecialValue = YAML_SPECIAL_VALUES.has(str.toLowerCase());

	if (hasSpecialChars || startsWithDigit || isSpecialValue) {
		return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
	}
	return str;
}

// ─── escapeMdxText ───────────────────────────────────────────────────────────

/**
 * Escapes MDX-significant characters in body text emitted into the rendered
 * docs (titles, descriptions, summaries). The customer's spec is the source
 * of these strings, so we can't trust them to be MDX-safe.
 *
 *   - `{` `}`: JSX expression delimiters. OpenAPI path templates use them
 *     (`/users/{id}`), so they'd break MDX without escaping.
 *   - All `<`: any `<` opens either a JSX tag (`<script>`) or breaks the
 *     parse (`value < 10` → `Unexpected character`). Escape every one
 *     so neither hits the MDX compiler. This also blocks injected
 *     `<script>` / `<iframe>` from third-party specs at the cost of
 *     inline HTML like `<details>` no longer rendering in descriptions.
 */
export function escapeMdxText(text: string): string {
	return text
		.replace(/\\/g, "\\\\")
		.replace(/[{}]/g, (match) => `\\${match}`)
		.replace(/</g, "\\<");
}

// ─── escapeInlineCode ────────────────────────────────────────────────────────

/**
 * Backslash-escapes backticks so a customer-supplied value containing one
 * (rare in OpenAPI versions, paths, or URLs but not impossible) cannot
 * escape the surrounding `` `…` `` inline-code span.
 */
export function escapeInlineCode(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

// ─── escapeJsString ──────────────────────────────────────────────────────────

/**
 * Escapes characters for use in a single-quoted JavaScript string literal.
 * Handles single quotes, backslashes, and CR/LF. **Not** safe for template
 * literals — those would also need backtick and `${` escaping.
 */
export function escapeJsString(str: string): string {
	return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

// ─── escapeHtml ──────────────────────────────────────────────────────────────

/**
 * Escapes HTML special characters to prevent XSS and curly-brace escapes
 * from JSX text contexts. Numeric character references (`&#123;` / `&#125;`)
 * render as the literal `{` / `}` characters in the browser but cannot be
 * parsed as JSX expressions during MDX compilation.
 */
export function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;")
		.replace(/\{/g, "&#123;")
		.replace(/\}/g, "&#125;");
}
