/**
 * Linear built-in source definition — data-only mirror of the pre-migration
 * Linear adapter (deleted once `GoldenParity.test.ts` proved byte-equivalence).
 *
 * Verified field-by-field against that adapter (see `GoldenParity.test.ts`):
 *   - `id` → nativeId, require `^[A-Z][A-Z0-9_]*-\d+$` (LINEAR_TICKET_ID_REGEX).
 *   - `title` → title, require non-empty.
 *   - `url` → url, require `^https?://`.
 *   - `description` → description, optional.
 *   - `status` (bare string) → field `status`.
 *   - `priority` (bare string OR `{name}` object) → field `priority`.
 *   - `labels` (string[]) → field `labels`, joined with ", ".
 */

import type { SourceDefinition } from "../../SourceDefinition.js";

/**
 * Linear ticket-id grammar (e.g. `ENG-123`). Its own constant — Linear owns this
 * rule independently of Jira's key grammar, even though the two coincide today.
 */
const LINEAR_TICKET_ID_REGEX = "^[A-Z][A-Z0-9_]*-\\d+$";

export const linearDefinition: SourceDefinition = {
	id: "linear",
	label: "Linear",
	icon: "issues",
	match: {
		claude: { prefixes: ["mcp__linear__", "mcp__claude_ai_Linear__"] },
		codex: {
			namespaceSuffix: "linear",
			functionCallNames: ["_fetch", "_get_issue", "_list_issues", "_search"],
			invocationTools: ["linear_fetch", "linear.get_issue", "linear.list_issues", "linear.search"],
		},
	},
	wrapperKeys: ["items", "issues", "nodes", "results"],
	reference: {
		nativeId: { pipe: [{ op: "path", path: "id" }], require: LINEAR_TICKET_ID_REGEX },
		title: { pipe: [{ op: "path", path: "title" }], require: ".+" },
		url: { pipe: [{ op: "path", path: "url" }], require: "^https?://" },
		description: { pipe: [{ op: "path", path: "description" }], optional: true },
	},
	fields: [
		{ key: "status", label: "Status", icon: "circle-large-filled", pipe: [{ op: "path", path: "status" }] },
		{
			key: "priority",
			label: "Priority",
			icon: "flame",
			pipe: [
				{
					op: "coalesce",
					of: [[{ op: "path", path: "priority" }], [{ op: "path", path: "priority.name" }]],
				},
			],
		},
		{
			key: "labels",
			label: "Labels",
			icon: "tag",
			pipe: [
				{ op: "path", path: "labels" },
				{ op: "join", sep: ", " },
			],
		},
	],
	storage: { nativeIdPathSafe: true },
	render: {
		wrapperTag: "linear-issues",
		itemTag: "issue",
		bodyTag: "description",
		maxCharsPerReference: 4000,
		maxTotalChars: 30000,
	},
};
