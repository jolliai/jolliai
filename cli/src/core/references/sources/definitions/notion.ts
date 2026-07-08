/**
 * Notion built-in source definition — data-only mirror of the pre-migration
 * Notion adapter (deleted once `GoldenParity.test.ts` proved byte-equivalence).
 *
 * Verified field-by-field against that adapter (see `GoldenParity.test.ts`):
 *   - `guard`: `metadata.type === "page"` — database / data_source payloads void.
 *   - `url` → nativeId source: extract the LAST 32-hex page id in the URL path
 *     (`[-/]([0-9a-fA-F]{32})(?=[/?#]|$)`, global, last match), lowercased.
 *   - `title` → title, require non-empty.
 *   - `url` → url, require an allow-listed Notion host
 *     (`www.notion.so` / `notion.so` / `app.notion.com` / `*.notion.site`),
 *     HTTPS only, matched case-insensitively (`requireFlags: "i"`) since the
 *     adapter's `isAllowedHost` compared against `new URL().hostname`, which
 *     is always lowercased. Fidelity note: the adapter's `isAllowedHost` parses
 *     the URL structurally (`new URL`), which is marginally stricter against
 *     userinfo tricks (`https://evil@www.notion.so.evil.example/...`) than
 *     this raw regex. No fixture exercises that gap; flagged per the design brief.
 *   - `text` → description: the `<content>…</content>` envelope body
 *     (`CONTENT_BLOCK` regex, first match only — the adapter never scans for
 *     more than one content block), optional.
 *   - `fields`: a single constant `entity-type` = "page" (the guard already
 *     restricts extraction to page-typed payloads).
 */

import type { SourceDefinition } from "../../SourceDefinition.js";

const PAGE_ID_PATTERN = "[-/]([0-9a-fA-F]{32})(?=[/?#]|$)";
const ALLOWED_URL = "^https://(www\\.notion\\.so|notion\\.so|app\\.notion\\.com|[^/]+\\.notion\\.site)/";
const CONTENT_BLOCK = "<content\\b[^>]*>([\\s\\S]*?)</content>";

export const notionDefinition: SourceDefinition = {
	id: "notion",
	label: "Notion",
	icon: "file-text",
	match: {
		claude: { prefixes: ["mcp__claude_ai_Notion__"], acceptSuffix: "notion-fetch" },
		codex: { namespaceSuffix: "notion", functionCallNames: ["_fetch"], invocationTools: ["notion_fetch"] },
	},
	wrapperKeys: ["results", "items", "pages"],
	reference: {
		guard: { pipe: [{ op: "path", path: "metadata.type" }], require: "^page$" },
		nativeId: {
			pipe: [
				{ op: "path", path: "url" },
				{ op: "regex", pattern: PAGE_ID_PATTERN, extract: "$1", lastMatch: true },
				{ op: "transform", fn: "lowercase" },
			],
			require: "^[0-9a-fA-F]{32}$",
		},
		title: { pipe: [{ op: "path", path: "title" }], require: ".+" },
		url: { pipe: [{ op: "path", path: "url" }], require: ALLOWED_URL, requireFlags: "i" },
		description: {
			pipe: [
				{ op: "path", path: "text" },
				{ op: "regex", pattern: CONTENT_BLOCK, extract: "$1" },
			],
			optional: true,
		},
	},
	fields: [{ key: "entity-type", label: "Type", icon: "symbol-class", pipe: [{ op: "const", value: "page" }] }],
	storage: { nativeIdPathSafe: true },
	render: {
		wrapperTag: "notion-pages",
		itemTag: "page",
		bodyTag: "content",
		fieldAttrs: false,
		maxCharsPerReference: 30000,
		maxTotalChars: 60000,
	},
};
