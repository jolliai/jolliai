/**
 * CodexMondayBinding — monday.com `codex_apps` connector normalizer.
 *
 * Reached through `_get_board_items_page` (namespace `mcp__codex_apps__monday_com`)
 * or the `monday_com.get_board_items_page` invocation — match identity lives in
 * `mondayDefinition.match.codex`. The connector's `function_call_output` unwraps to
 * the SAME `{ board, items, pagination }` payload as the Claude monday MCP, so this
 * binding shares `normalizeMonday` with the Claude path. It reads the `itemIds` gate
 * from the request `arguments` (threaded by CodexEnvelopeParser) — a Codex board
 * browse with no `itemIds` voids, exactly like the Claude side.
 */

import { normalizeMonday, readItemIds } from "../../sources/MondayNormalize.js";
import type { CodexNormalizer } from "./CodexBinding.js";

export const mondayCodexBinding: CodexNormalizer = {
	id: "monday",
	canonicalToolName: "mcp__claude_ai_monday_com__get_board_items_page",
	normalize: (business, toolInput) => normalizeMonday(business, { itemIds: readItemIds(toolInput) }),
};
