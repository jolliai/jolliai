/**
 * XML escape helpers for prompt-block rendering.
 *
 * Two functions cover the two contexts in <linear-issues> / <plans> / <notes>:
 *   - escapeForAttr: XML attribute values — escapes &, <, >, ", '
 *   - escapeForText: XML element text content — escapes &, <, >
 *
 * Defense scope: these helpers prevent structural breakage (e.g. a `"` inside an
 * attribute value closing the attribute prematurely, or a `</description>` inside
 * a description body closing the element). They do NOT protect against
 * SUMMARIZE-sentinel imitation (`===SUMMARY===`, `---TICKETID---`, etc.) — those
 * characters pass through verbatim and the defense lives in the prompt's
 * style-mimicking warning (PromptTemplates.SUMMARIZE).
 */

/** Escape XML attribute value: &, <, >, ", ' */
export function escapeForAttr(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** Escape XML element text content: &, <, > (preserves " and ' as text) */
export function escapeForText(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
