/**
 * Jira built-in source definition — data-only mirror of the pre-migration Jira
 * adapter (deleted once `GoldenParity.test.ts` proved byte-equivalence).
 *
 * Verified field-by-field against that adapter (see `GoldenParity.test.ts`):
 *   - `key` → nativeId, require `^[A-Z][A-Z0-9_]*-\d+$` (JIRA_KEY_REGEX).
 *   - `fields.summary` → title, require non-empty.
 *   - `webUrl` → url, require `^https?://`.
 *   - `fields.description` → description, optional.
 *   - `fields.status` (bare string OR `{name}`) → field `status`.
 *   - `fields.priority` (bare string OR `{name}`) → field `priority`.
 *   - `fields.labels` (string[]) → field `labels`, joined with ", ".
 *
 * Because every field lives under `fields.*`, a missing/non-object `fields`
 * naturally voids `title` (required) → the whole Reference voids, matching the
 * pre-migration adapter's explicit `isObject(fields)` gate.
 */

import type { SourceDefinition } from "../../SourceDefinition.js";

/**
 * Jira issue-key grammar (e.g. `KAN-42`). Its own constant — Jira owns this rule
 * independently of Linear's ticket-id grammar, even though the two coincide today.
 */
const JIRA_KEY_REGEX = "^[A-Z][A-Z0-9_]*-\\d+$";

export const jiraDefinition: SourceDefinition = {
	id: "jira",
	label: "Jira",
	icon: "issues",
	match: {
		claude: { prefixes: ["mcp__claude_ai_Atlassian__"] },
		// Codex's built-in "Atlassian Rovo" app reaches a Jira issue TWO ways, both
		// claimed here (namespace `mcp__codex_apps__atlassian_rovo`):
		//   - Generic `_fetch` (invocation `atlassian_rovo.fetch`) → flat
		//     `{id,title,text,url,type:"jira-issue",metadata}` envelope, `url`→`webUrl`.
		//   - Dedicated `getJiraIssue` (function_call `_getjiraissue`, invocation
		//     `atlassian_rovo.getJiraIssue`) → standard Jira REST issue
		//     `{key,fields:{summary,…},self}` with NO webUrl (self→webUrl mapped in the
		//     binding). Both VERIFIED from live rollouts (2026-07-12 / -13). The
		//     invocation name MUST be the dotted `atlassian_rovo.getJiraIssue`; an
		//     earlier `"atlassian rovo_getjiraissue"` was a fabricated guess that never
		//     matched a real event, so getJiraIssue fetches were silently dropped.
		// Confluence's dedicated `_getconfluencepage` is owned by the confluence def,
		// so that path never collides. KNOWN GAP: the generic `_fetch` can also fetch a
		// Confluence page (a `confluence-page` entity); it routes here by tool name,
		// passes through `normalizeJira` unreshaped (type !== "jira-issue"), and voids
		// on the jira `key`/`summary` requires — i.e. such a page is DROPPED, not
		// captured as confluence. Proper per-payload-`type` dispatch of the shared
		// `_fetch` is deferred.
		codex: {
			namespaceSuffix: "atlassian_rovo",
			functionCallNames: ["_fetch", "_getjiraissue"],
			invocationTools: ["atlassian_rovo.fetch", "atlassian_rovo.getJiraIssue"],
		},
	},
	wrapperKeys: ["nodes", "issues", "items", "results"],
	reference: {
		nativeId: { pipe: [{ op: "path", path: "key" }], require: JIRA_KEY_REGEX },
		title: { pipe: [{ op: "path", path: "fields.summary" }], require: ".+" },
		url: { pipe: [{ op: "path", path: "webUrl" }], require: "^https?://" },
		description: { pipe: [{ op: "path", path: "fields.description" }], optional: true },
	},
	fields: [
		{
			key: "status",
			label: "Status",
			icon: "circle-large-filled",
			pipe: [
				{
					op: "coalesce",
					of: [[{ op: "path", path: "fields.status.name" }], [{ op: "path", path: "fields.status" }]],
				},
			],
		},
		{
			key: "priority",
			label: "Priority",
			icon: "flame",
			pipe: [
				{
					op: "coalesce",
					of: [[{ op: "path", path: "fields.priority.name" }], [{ op: "path", path: "fields.priority" }]],
				},
			],
		},
		{
			key: "labels",
			label: "Labels",
			icon: "tag",
			pipe: [
				{ op: "path", path: "fields.labels" },
				{ op: "join", sep: ", " },
			],
		},
	],
	storage: { nativeIdPathSafe: true },
	render: {
		wrapperTag: "jira-issues",
		itemTag: "issue",
		bodyTag: "description",
		maxCharsPerReference: 4000,
		maxTotalChars: 30000,
	},
};
