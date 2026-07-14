/**
 * MondayNormalize — canonical-shape builder for the monday.com item source.
 *
 * monday has no single-item getter: `get_board_items_page` serves BOTH a
 * targeted `itemIds` fetch AND a whole-board browse (up to 500 items). Tool-name
 * matching cannot tell them apart, so the reference gate is on the tool INPUT — a
 * reference is produced ONLY when the call carried a non-empty `itemIds` (a
 * targeted lookup); a board browse yields null. This mirrors Slack/zoom-doc
 * reading tool_use input.
 *
 * It also flattens the item body: `item_description.blocks[].content` is a JSON
 * string holding a Quill `deltaFormat`, which the DSL's dotted `readPath` (no
 * array indexing, no embedded-JSON parse) cannot express — the same reason
 * Confluence's ADF flattening lives in a normalizer.
 *
 * The `mondayDefinition` is pure `path` DSL over this function's `{ items: [...] }`
 * output. Used by BOTH hosts: the Claude envelope's CONTEXT_NORMALIZERS entry and
 * the Codex `mondayCodexBinding`, each passing the itemIds read from its host's
 * own tool input.
 */

import { isObject } from "../guards.js";

/** Flattened, host-agnostic monday item the `mondayDefinition` reads via `path`. */
export interface MondayItem {
	readonly id: string;
	readonly name: string;
	readonly url: string;
	readonly board?: string;
	readonly description?: string;
}

function readString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * The `itemIds` a `get_board_items_page` call carried, or undefined when absent /
 * empty / malformed — the gate then voids (a board browse has no `itemIds`). Only
 * presence matters downstream; the values are not cross-referenced.
 *
 * monday item ids are large integers that this ecosystem serializes both ways —
 * the tool_result body carries them as strings (`id: "12511130115"`) even though
 * the request schema takes numbers — so a numeric string in `itemIds` is accepted
 * too, otherwise a real targeted fetch would silently produce no reference. The
 * coerced value is never used beyond presence, so >2^53 precision loss is moot.
 */
export function readItemIds(toolInput: unknown): readonly number[] | undefined {
	if (!isObject(toolInput)) return undefined;
	const ids = toolInput.itemIds;
	if (!Array.isArray(ids)) return undefined;
	const nums = ids
		.map((x) => (typeof x === "number" ? x : typeof x === "string" && /^\d+$/.test(x) ? Number(x) : undefined))
		.filter((x): x is number => x !== undefined);
	return nums.length > 0 ? nums : undefined;
}

/**
 * Flatten a monday `item_description` into plain text. Each block's `content` is a
 * JSON string `{"deltaFormat":[{"insert":"…"}]}`; concat every `insert` across all
 * blocks, blocks joined by "\n". Returns undefined when absent or empty.
 *
 * A block whose `content` is not JSON-shaped (does not start with `{`/`[`) is
 * treated as plain text and kept verbatim, so a non-deltaFormat body is preserved
 * rather than dropped. Content that IS JSON-shaped but fails to parse (e.g. a
 * truncated blob) or parses without a `deltaFormat` array is skipped — never
 * surfacing broken JSON as text, and never throwing.
 */
function flattenDescription(itemDescription: unknown): string | undefined {
	if (!isObject(itemDescription)) return undefined;
	const blocks = itemDescription.blocks;
	if (!Array.isArray(blocks)) return undefined;
	const lines: string[] = [];
	for (const block of blocks) {
		if (!isObject(block) || typeof block.content !== "string") continue;
		const trimmed = block.content.trim();
		if (trimmed.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(block.content);
		} catch {
			// Not deltaFormat JSON. Keep genuine plain text; skip a malformed
			// JSON-shaped blob so we never emit broken JSON as a description.
			if (trimmed[0] !== "{" && trimmed[0] !== "[") lines.push(trimmed);
			continue;
		}
		if (!isObject(parsed) || !Array.isArray(parsed.deltaFormat)) continue;
		const text = parsed.deltaFormat
			.map((seg) => (isObject(seg) && typeof seg.insert === "string" ? seg.insert : ""))
			.join("");
		if (text.length > 0) lines.push(text);
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * Build the `{ items }` wrapper the `mondayDefinition` reads, or null to void the
 * whole result. Gates on `itemIds`; flattens each item's description.
 */
export function normalizeMonday(
	payload: unknown,
	ctx: { readonly itemIds: readonly number[] | undefined },
): { items: MondayItem[] } | null {
	if (ctx.itemIds === undefined || ctx.itemIds.length === 0) return null;
	if (!isObject(payload)) return null;
	const board = isObject(payload.board) ? readString(payload.board.name) : undefined;
	const rawItems = Array.isArray(payload.items) ? payload.items : [];
	const items: MondayItem[] = [];
	for (const raw of rawItems) {
		if (!isObject(raw)) continue;
		const id = readString(raw.id);
		const name = readString(raw.name);
		const url = readString(raw.url);
		if (id === undefined || name === undefined || url === undefined) continue;
		const description = flattenDescription(raw.item_description);
		items.push({
			id,
			name,
			url,
			...(board !== undefined ? { board } : {}),
			...(description !== undefined ? { description } : {}),
		});
	}
	return { items };
}
