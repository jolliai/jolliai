/**
 * ConfluenceNormalize — reshape a `getConfluencePage` MCP result into a canonical
 * object the `confluence` SourceDefinition reads with plain `path` ops.
 *
 * TWO envelope shapes reach this layer, both carrying the same logical page:
 *   - WRAPPED `{ content: { nodes: [ node ] } }` — Claude's `getConfluencePage`
 *     tool result body (and a single-page fetch yields exactly one node). The
 *     node carries `space:{name}` / `author:{displayName}` objects.
 *   - FLAT `{ id, title, webUrl, body, spaceId, authorId, … }` — Codex's Rovo
 *     `_getconfluencepage`, whose `content[0].text` (the string the Codex envelope
 *     layer extracts) is the page node itself, NOT the wrapper. Its wrapped twin
 *     lives in the connector's `structuredContent`, which the envelope discards
 *     (verified against live 2026-07 rollouts). The flat node has NO `space` /
 *     `author` objects — only `spaceId` / `authorId` IDs — so those display fields
 *     are deliberately left undefined rather than surfaced as opaque IDs.
 * {@link resolveNode} accepts either. The only field the DSL cannot handle itself
 * is `body`, which is a markdown STRING under the default/"markdown" contentFormat
 * but an ADF document OBJECT under "adf" (true in BOTH shapes) — so this flattens
 * ADF to text (the DSL's `path`/`transform` cannot: `transform` fns are
 * `(string) => string`).
 *
 * "Normalize only normalizes": missing `title`/`url` are left undefined so the
 * definition's `require` regexes void the reference — this layer only returns
 * null for structurally unparseable input, and never throws.
 */

import { isObject } from "../guards.js";
import { adfToText } from "./AdfToText.js";

export interface ConfluenceCanonical {
	readonly pageId?: string;
	readonly title?: string;
	readonly url?: string;
	readonly body?: string;
	readonly space?: string;
	readonly author?: string;
	/** Confluence content type — "page", "blogpost", etc. Undefined when absent. */
	readonly entityType?: string;
}

function bodyToString(body: unknown): string | undefined {
	const text = typeof body === "string" ? body : adfToText(body);
	const trimmed = text.trim();
	return trimmed.length > 0 ? text : undefined;
}

/**
 * Extract the page node from either envelope shape. A top-level `content` key is
 * the unambiguous marker of the WRAPPED shape (a flat page node keeps its body
 * under `body`, never a top-level `content`), so once `content` is an object we
 * commit to `content.nodes[0]` and never fall through. Otherwise, a top-level
 * object that looks like a page node (`id` plus a `title` or `webUrl`) is treated
 * as the FLAT Codex shape. Anything else is unparseable.
 */
function resolveNode(rawResult: { [k: string]: unknown }): { [k: string]: unknown } | null {
	const content = rawResult.content;
	if (isObject(content)) {
		const nodes = content.nodes;
		if (!Array.isArray(nodes) || nodes.length === 0) return null;
		const node = nodes[0];
		return isObject(node) ? node : null;
	}
	if (
		typeof rawResult.id === "string" &&
		(typeof rawResult.title === "string" || typeof rawResult.webUrl === "string")
	) {
		return rawResult;
	}
	return null;
}

export function normalizeConfluence(rawResult: unknown): ConfluenceCanonical | null {
	if (!isObject(rawResult)) return null;
	const node = resolveNode(rawResult);
	if (node === null) return null;

	const pageId = typeof node.id === "string" ? node.id : undefined;
	const title = typeof node.title === "string" ? node.title : undefined;
	const url = typeof node.webUrl === "string" ? node.webUrl : undefined;
	const body = bodyToString(node.body);
	const space = isObject(node.space) && typeof node.space.name === "string" ? node.space.name : undefined;
	const author =
		isObject(node.author) && typeof node.author.displayName === "string" ? node.author.displayName : undefined;
	const entityType = typeof node.type === "string" ? node.type : undefined;

	return {
		...(pageId !== undefined ? { pageId } : {}),
		...(title !== undefined ? { title } : {}),
		...(url !== undefined ? { url } : {}),
		...(body !== undefined ? { body } : {}),
		...(space !== undefined ? { space } : {}),
		...(author !== undefined ? { author } : {}),
		...(entityType !== undefined ? { entityType } : {}),
	};
}
