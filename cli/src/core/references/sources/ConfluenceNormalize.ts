/**
 * ConfluenceNormalize — reshape a `getConfluencePage` MCP result into a canonical
 * object the `confluence` SourceDefinition reads with plain `path` ops.
 *
 * The raw payload is `{ content: { nodes: [ node ] } }`; a single-page fetch
 * yields exactly one node. The only field the DSL cannot handle itself is `body`,
 * which is a markdown STRING under the default/"markdown" contentFormat but an
 * ADF document OBJECT under "adf" — so this flattens ADF to text (the DSL's
 * `path`/`transform` cannot: `transform` fns are `(string) => string`).
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

export function normalizeConfluence(rawResult: unknown): ConfluenceCanonical | null {
	if (!isObject(rawResult)) return null;
	const content = rawResult.content;
	if (!isObject(content)) return null;
	const nodes = content.nodes;
	if (!Array.isArray(nodes) || nodes.length === 0) return null;
	const node = nodes[0];
	if (!isObject(node)) return null;

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
