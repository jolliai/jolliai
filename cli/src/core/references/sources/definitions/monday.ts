/**
 * monday.com built-in source — pure `path` DSL over the MondayNormalize
 * canonical shape ({ id, name, url, created_at, updated_at, board?, description? }).
 *
 * The messy work — the itemIds anti-flood gate and the delta-format body flatten
 * — lives in `sources/MondayNormalize.normalizeMonday`, wired into BOTH envelope
 * parsers (Claude via CONTEXT_NORMALIZERS, Codex via CodexMondayBinding). This
 * definition only selects fields, exactly like zoom-doc.
 *
 * `match.claude` allows only `get_board_items_page` (the item fetch); every
 * write/enumeration/doc/dashboard tool is excluded by the allowlist. `match.codex`
 * targets the `codex_apps__monday_com` connector (function_call `_get_board_items_page`,
 * invocation `monday_com.get_board_items_page`) — both transcribed from a real
 * 2026-07-14 rollout, not guessed.
 *
 * `column_values` are deliberately NOT surfaced as fields: their keys are
 * board-defined and vary per board (Tasks uses `task_status`; the Subitems board
 * uses `person`/`status`/`date0`), so only stable top-level fields are used.
 */

import type { SourceDefinition } from "../../SourceDefinition.js";

export const mondayDefinition: SourceDefinition = {
	id: "monday",
	label: "monday.com",
	icon: "table",
	match: {
		claude: { prefixes: ["mcp__claude_ai_monday_com__"], acceptSuffix: "get_board_items_page" },
		codex: {
			namespaceSuffix: "monday_com",
			functionCallNames: ["_get_board_items_page"],
			invocationTools: ["monday_com.get_board_items_page"],
		},
	},
	wrapperKeys: ["items"],
	reference: {
		nativeId: { pipe: [{ op: "path", path: "id" }], require: "^\\d+$" },
		title: { pipe: [{ op: "path", path: "name" }], require: ".+" },
		url: {
			pipe: [{ op: "path", path: "url" }],
			// Host must be monday.com or a sub-domain of it (one or more labels),
			// anchored so a spoofed `url` field can't point the reference elsewhere.
			require: "^https://([\\w-]+\\.)*monday\\.com/",
			requireFlags: "i",
		},
		description: { pipe: [{ op: "path", path: "description" }], optional: true },
	},
	fields: [
		{ key: "entity-type", label: "Type", icon: "symbol-class", pipe: [{ op: "const", value: "item" }] },
		{ key: "board", label: "Board", icon: "project", pipe: [{ op: "path", path: "board" }] },
	],
	storage: { nativeIdPathSafe: true },
	render: {
		wrapperTag: "monday-items",
		itemTag: "item",
		bodyTag: "description",
		maxCharsPerReference: 4000,
		maxTotalChars: 30000,
	},
};
