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
		codex: {
			namespaceSuffix: "atlassian_rovo",
			functionCallNames: ["_getjiraissue"],
			invocationTools: ["atlassian rovo_getjiraissue"],
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
