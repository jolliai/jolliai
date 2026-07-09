/**
 * Zoom Hub doc built-in source — pure `path` DSL over the ZoomDocNormalize
 * canonical shape ({ fileId, title, content, url }). The messy work (fileId
 * from tool_use input, url construction) lives in
 * `sources/ZoomDocNormalize.normalizeZoomDoc`, wired into the Claude envelope
 * parser's `collectToolResults`; this definition only selects fields.
 */

import type { SourceDefinition } from "../../SourceDefinition.js";

export const zoomDocDefinition: SourceDefinition = {
	id: "zoom-doc",
	label: "Zoom Doc",
	icon: "file",
	match: {
		claude: { prefixes: ["mcp__claude_ai_Zoom_for_Claude__"], acceptSuffix: "hub_get_file_content" },
	},
	wrapperKeys: [],
	reference: {
		nativeId: { pipe: [{ op: "path", path: "fileId" }], require: "^[\\w.-]+$" },
		title: { pipe: [{ op: "path", path: "title" }], require: ".+" },
		url: { pipe: [{ op: "path", path: "url" }], require: "^https://docs\\.zoom\\.us/doc/" },
		description: { pipe: [{ op: "path", path: "content" }], optional: true },
	},
	fields: [{ key: "entity-type", label: "Type", icon: "symbol-class", pipe: [{ op: "const", value: "doc" }] }],
	storage: { nativeIdPathSafe: true },
	render: {
		wrapperTag: "zoom-docs",
		itemTag: "doc",
		bodyTag: "content",
		maxCharsPerReference: 30000,
		maxTotalChars: 60000,
	},
};
