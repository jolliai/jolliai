import type { SourceDefinition } from "../../SourceDefinition.js";

// A Context7-compatible library id is `/org/project` (optionally `/org/project/version`).
const LIBRARY_ID = "^/[^/\\s]+/[^/\\s]+";

/**
 * context7 (`@upstash/context7-mcp`) — track-only documentation references.
 * Only the current `query-docs` tool is matched (legacy `get-library-docs` uses a
 * different arg name and is out of scope). The reference is built from the ARGUMENTS
 * (`libraryId`, `query`) via `Context7Normalize`; the markdown result is ignored,
 * which is why `argumentsDerived` is set. `trackOnly` keeps it out of the LLM block.
 */
export const context7Definition: SourceDefinition = {
	id: "context7",
	label: "Context7",
	icon: "book",
	trackOnly: true,
	argumentsDerived: true,
	match: {
		claude: { prefixes: ["mcp__context7__"], acceptSuffix: "query-docs" },
		codex: {
			namespaceSuffix: "context7",
			functionCallNames: ["_query_docs"],
			invocationTools: ["query-docs", "context7.query-docs"],
		},
	},
	wrapperKeys: [],
	reference: {
		nativeId: { pipe: [{ op: "path", path: "libraryId" }], require: LIBRARY_ID },
		title: {
			pipe: [
				{ op: "path", path: "libraryId" },
				{ op: "regex", pattern: "^/(.+)$", extract: "$1" },
			],
			require: ".+",
		},
		url: {
			pipe: [
				{
					op: "template",
					template: "https://context7.com{id}",
					from: { id: [{ op: "path", path: "libraryId" }] },
				},
			],
			require: "^https://context7\\.com/",
		},
		description: { pipe: [{ op: "path", path: "query" }], optional: true },
	},
	fields: [],
	storage: { nativeIdPathSafe: false },
	render: {
		wrapperTag: "context7-libraries",
		itemTag: "library",
		bodyTag: "content",
		maxCharsPerReference: 2000,
		maxTotalChars: 8000,
	},
};
