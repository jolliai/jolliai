/**
 * Confluence built-in source definition — captures the result of
 * `mcp__claude_ai_Atlassian__getConfluencePage`.
 *
 * Runs over the canonical shape produced by `normalizeConfluence`
 * (`{ pageId, title, url, body?, space?, author? }`), NOT the raw MCP payload:
 * the normalizer flattens the ADF-vs-markdown `body` variance the DSL cannot
 * express, so this reads plain `path` ops and needs no `wrapperKeys`.
 *
 * Ordering: jira's `match.claude` is prefix-only (`mcp__claude_ai_Atlassian__`)
 * and matches every Atlassian tool. This def's `acceptSuffix: "getConfluencePage"`
 * plus its position BEFORE jira in `BUILTIN_DEFINITIONS` routes page reads here
 * and lets `getJiraIssue` fall through to jira.
 */

import type { SourceDefinition } from "../../SourceDefinition.js";

// Any HTTPS host with a /wiki/ path. Stricter than jira's bare `^https?://`
// (confirms a Cloud wiki link), looser than hard-coding atlassian.net (tolerates
// Cloud custom domains, which keep the /wiki/ prefix). The claude.ai connector is
// Cloud-only; Data Center's /display/ URL layout is intentionally out of scope.
const WIKI_URL = "^https://[^/]+/wiki/";

export const confluenceDefinition: SourceDefinition = {
	id: "confluence",
	label: "Confluence",
	icon: "book",
	match: {
		claude: { prefixes: ["mcp__claude_ai_Atlassian__"], acceptSuffix: "getConfluencePage" },
		// Codex's built-in "Atlassian Rovo" app fetches a page through a dedicated
		// `_getconfluencepage` tool (namespace `mcp__codex_apps__atlassian_rovo`,
		// invocation `atlassian_rovo.getConfluencePage`) — verified from a live
		// rollout. Its extracted `content[0].text` is a FLAT page node, NOT the
		// Claude tool's `{content:{nodes}}` wrapper (see CodexConfluenceBinding);
		// `normalizeConfluence` accepts both, so the binding reuses it verbatim.
		// This def ONLY claims the dedicated `_getconfluencepage`; a page fetched via
		// the generic `_fetch` routes to the jira def and is dropped (see the KNOWN
		// GAP note in jira.ts). Jira's `_fetch` therefore never collides with this def.
		codex: {
			namespaceSuffix: "atlassian_rovo",
			functionCallNames: ["_getconfluencepage"],
			invocationTools: ["atlassian_rovo.getConfluencePage"],
		},
	},
	wrapperKeys: [],
	reference: {
		nativeId: { pipe: [{ op: "path", path: "pageId" }], require: "^\\d+$" },
		title: { pipe: [{ op: "path", path: "title" }], require: ".+" },
		url: { pipe: [{ op: "path", path: "url" }], require: WIKI_URL },
		description: { pipe: [{ op: "path", path: "body" }], optional: true },
	},
	fields: [
		{ key: "space", label: "Space", icon: "symbol-namespace", pipe: [{ op: "path", path: "space" }] },
		{ key: "author", label: "Author", icon: "account", pipe: [{ op: "path", path: "author" }] },
		{
			key: "entity-type",
			label: "Type",
			icon: "symbol-class",
			// Prefer the page's real content type ("page" / "blogpost"); fall back to
			// "page" when the payload omits it (older/leaner captures).
			pipe: [{ op: "coalesce", of: [[{ op: "path", path: "entityType" }], [{ op: "const", value: "page" }]] }],
		},
	],
	storage: { nativeIdPathSafe: true },
	render: {
		wrapperTag: "confluence-pages",
		itemTag: "page",
		bodyTag: "content",
		maxCharsPerReference: 30000,
		maxTotalChars: 60000,
	},
};
