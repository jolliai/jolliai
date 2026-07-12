/**
 * Asana built-in source definition — pure-DSL over the get_task result.
 *
 * The Asana MCP connector's get_task returns `{ data: { …task… } }`, so
 * wrapperKeys is `["data"]`: walkPayload voids at the top level (gid/name live
 * under `data`), then descends into `data` and extracts the task. The same key
 * also iterates a `{ data: [ … ] }` array shape, though only get_task is
 * accepted for extraction (acceptSuffix).
 *
 * Fields are deliberately minimal. Asana section/project live under array paths
 * (`memberships[0].section.name` / `projects[0].name`) that the DSL's dotted
 * `readPath` cannot index, and `completed` is a boolean that `toScalar` drops —
 * so only a constant entity-type and the assignee's name (an object subpath)
 * are surfaced.
 *
 * Claude-only: no Codex connector exposes Asana today, so no `match.codex`.
 */

import type { SourceDefinition } from "../../SourceDefinition.js";

/** Asana web host — task permalinks are always under app.asana.com. */
const ASANA_URL = "^https://app\\.asana\\.com/";

export const asanaDefinition: SourceDefinition = {
	id: "asana",
	label: "Asana",
	icon: "checklist",
	match: {
		claude: { prefixes: ["mcp__claude_ai_Asana__"], acceptSuffix: "get_task" },
	},
	wrapperKeys: ["data"],
	reference: {
		nativeId: { pipe: [{ op: "path", path: "gid" }], require: "^\\d+$" },
		title: { pipe: [{ op: "path", path: "name" }], require: ".+" },
		url: { pipe: [{ op: "path", path: "permalink_url" }], require: ASANA_URL },
		description: { pipe: [{ op: "path", path: "notes" }], optional: true },
	},
	fields: [
		{ key: "entity-type", label: "Type", icon: "symbol-class", pipe: [{ op: "const", value: "task" }] },
		{ key: "assignee", label: "Assignee", icon: "person", pipe: [{ op: "path", path: "assignee.name" }] },
	],
	storage: { nativeIdPathSafe: true },
	render: {
		wrapperTag: "asana-tasks",
		itemTag: "task",
		bodyTag: "description",
		maxCharsPerReference: 4000,
		maxTotalChars: 30000,
	},
};
