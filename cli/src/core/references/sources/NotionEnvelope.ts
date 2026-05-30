/**
 * Notion XML envelope parser used by NotionAdapter.
 *
 * `notion-fetch` returns a `text` field that wraps the page body inside a
 * simple XML envelope:
 *
 *   <page>
 *     <title>Page title</title>
 *     <metadata>...</metadata>
 *     <content>{markdown body — what the user actually authored}</content>
 *   </page>
 *
 * We only need the `<content>…</content>` body — every other field on the
 * payload is already exposed as a structured field on the top-level JSON, so
 * re-parsing them out of the envelope would be redundant.
 *
 * Defensive contract: malformed input (missing tags, mismatched tags, empty
 * envelope) returns `{content: ""}`. The parser never throws and never
 * "panics" on multi-line input — the regex is dotall (`[\s\S]`) so newlines
 * inside the content are preserved. The open tag may carry attributes
 * (`<content type="markdown">…`); those are tolerated. Only the FIRST
 * `<content>` block is read — the notion-fetch shape is a single, non-nested
 * content block, so multiple / nested blocks are not a concern in practice.
 *
 * Adapter modules MUST NOT share helpers across sources (per plan §Constraints).
 * This module is owned by NotionAdapter only.
 */

const CONTENT_BLOCK_RE = /<content\b[^>]*>([\s\S]*?)<\/content>/;

export interface NotionEnvelope {
	readonly content: string;
}

export function parseNotionEnvelope(text: string): NotionEnvelope {
	if (typeof text !== "string" || text.length === 0) return { content: "" };
	const m = CONTENT_BLOCK_RE.exec(text);
	if (!m) return { content: "" };
	return { content: m[1] };
}
