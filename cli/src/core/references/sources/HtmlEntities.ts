/**
 * HTML entity decoder used by the github `SourceDefinition`'s `decodeHtmlEntities`
 * transform (see `sources/definitions/github.ts`, wired through `SourceEngine`).
 *
 * GitHub's MCP server returns issue/PR bodies with HTML-entity-escaped content
 * (e.g. `&lt;`, `&#x2026;`, `&#960;`). The body must be decoded before it
 * enters the SUMMARIZE prompt so the LLM sees the original markdown.
 *
 * Scope of decode (intentionally narrow):
 *   - Named entities: a fixed 5-entry table (`amp`, `lt`, `gt`, `quot`, `apos`).
 *     Unknown names pass through unchanged so we never silently corrupt text
 *     that happened to contain `&foo;`.
 *   - Hex numeric: `&#xNN…;` (lowercase `x` only — uppercase `&#X…;` is rare in
 *     real GitHub MCP output and intentionally unsupported). Range-guarded —
 *     code points outside U+0000–U+10FFFF, and lone UTF-16 surrogates
 *     (U+D800–U+DFFF), pass through unchanged rather than emitting a corrupt /
 *     lone-surrogate character.
 *   - Decimal numeric: `&#DD…;`, same range guard.
 *
 * Exposed to definitions as the `decodeHtmlEntities` transform (github body
 * decoding). The notion source does NOT call into this file — it peels its
 * `<content>` envelope with its own `CONTENT_BLOCK` regex.
 */

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * True only for code points that decode to a single well-formed character.
 * Excludes out-of-range values and the UTF-16 surrogate block U+D800–U+DFFF —
 * `String.fromCodePoint` does NOT throw on a surrogate, it silently produces a
 * lone surrogate, which would corrupt the decoded text.
 */
function isDecodableCodePoint(cp: number): boolean {
	return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
}

export function decodeHtmlEntities(s: string): string {
	return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
		if (body.startsWith("#x")) {
			const cp = Number.parseInt(body.slice(2), 16);
			return isDecodableCodePoint(cp) ? String.fromCodePoint(cp) : whole;
		}
		if (body.startsWith("#")) {
			const cp = Number.parseInt(body.slice(1), 10);
			return isDecodableCodePoint(cp) ? String.fromCodePoint(cp) : whole;
		}
		// `Object.hasOwn` (ES2022) is not in our `lib: ES2020`; access the value directly
		// instead. Unknown keys → `undefined`; defined entities are non-empty strings,
		// so the typeof check distinguishes them safely without prototype-chain hazards.
		const decoded: string | undefined = NAMED[body];
		return typeof decoded === "string" ? decoded : whole;
	});
}
