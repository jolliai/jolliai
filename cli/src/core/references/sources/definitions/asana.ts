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
 * Codex: the `codex_apps` Asana connector's `get_task` produces the SAME
 * `{ data: { …task… } }` shape (verified against a real rollout — function_call
 * `name="_get_task"` under namespace `mcp__codex_apps__asana`; invocation
 * `asana.get_task`; the `function_call_output` unwraps to the identical task
 * object), so no reshaping is needed — see `CodexAsanaBinding` (identity
 * normalize). `match.codex` mirrors `notion.ts`: the dotted `invocationTool`
 * value (`asana.get_task`) is taken verbatim from the rollout, not guessed.
 */

import type { SourceDefinition } from "../../SourceDefinition.js";

/**
 * Asana web host — task permalinks are always under app.asana.com. Matched
 * case-insensitively (`requireFlags: "i"`, mirroring `notion.ts`): URL hosts are
 * case-insensitive, so a mixed-case host must not silently void the reference.
 */
const ASANA_URL = "^https://app\\.asana\\.com/";

export const asanaDefinition: SourceDefinition = {
	id: "asana",
	label: "Asana",
	icon: "checklist",
	match: {
		claude: { prefixes: ["mcp__claude_ai_Asana__"], acceptSuffix: "get_task" },
		codex: { namespaceSuffix: "asana", functionCallNames: ["_get_task"], invocationTools: ["asana.get_task"] },
	},
	wrapperKeys: ["data"],
	reference: {
		nativeId: { pipe: [{ op: "path", path: "gid" }], require: "^\\d+$" },
		title: { pipe: [{ op: "path", path: "name" }], require: ".+" },
		url: { pipe: [{ op: "path", path: "permalink_url" }], require: ASANA_URL, requireFlags: "i" },
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
