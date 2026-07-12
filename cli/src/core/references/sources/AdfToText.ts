/**
 * Minimal ADF (Atlassian Document Format) → markdown-ish plain text.
 *
 * Agent- and source-agnostic: both the Codex Jira binding (issue descriptions)
 * and the Confluence normalizer (page bodies) receive ADF documents and need a
 * plain-text rendering for a reference body. Handles the node types those
 * payloads actually use (heading/paragraph/list/blockquote/codeBlock/text);
 * unknown nodes just concatenate their children. Good enough for a reference
 * body; the consumer truncates it.
 */

import { isObject } from "../guards.js";

export function adfToText(node: unknown): string {
	if (!isObject(node)) return "";
	if (node.type === "text") return typeof node.text === "string" ? node.text : "";
	const children = Array.isArray(node.content) ? node.content : [];
	const inline = children.map(adfToText).join("");
	switch (node.type) {
		case "heading": {
			const level = isObject(node.attrs) && typeof node.attrs.level === "number" ? node.attrs.level : 1;
			return `${"#".repeat(Math.min(Math.max(level, 1), 6))} ${inline}`;
		}
		case "paragraph":
		case "codeBlock":
			return inline;
		case "blockquote":
			return children.map((c) => `> ${adfToText(c)}`).join("\n");
		case "bulletList":
			return children.map((c) => `- ${adfToText(c)}`).join("\n");
		case "orderedList":
			return children.map((c, i) => `${i + 1}. ${adfToText(c)}`).join("\n");
		case "doc":
			return children.map(adfToText).join("\n\n");
		default:
			return inline;
	}
}
