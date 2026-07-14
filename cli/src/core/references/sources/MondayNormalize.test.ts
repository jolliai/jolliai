import { describe, expect, it } from "vitest";
import { normalizeMonday, readItemIds } from "./MondayNormalize.js";

const ITEM_A = {
	id: "12511130115",
	name: "Add monday MCP integration",
	url: "https://jolli-squad.monday.com/boards/18421599187/pulses/12511130115",
	created_at: "2026-07-12T11:05:25Z",
	updated_at: "2026-07-14T08:30:22Z",
	column_values: { task_status: "In Progress" },
	item_description: {
		id: "44442382",
		blocks: [
			{
				id: "c5d5",
				type: "normal text",
				content:
					'{"direction":"ltr","deltaFormat":[{"insert":"Use MCP to get monday task info in Agents (Claude Code, Codex, etc), Jolli Memory will capture the context in sessions, and show as context reference in working memory."}]}',
			},
		],
	},
};
const PAYLOAD_A = { board: { id: "18421599187", name: "Tasks" }, items: [ITEM_A], pagination: { count: 1 } };

const ITEM_B_NO_DESC = {
	id: "12526313713",
	name: "Claude Code Support",
	url: "https://jolli-squad.monday.com/boards/18421888353/pulses/12526313713",
	created_at: "2026-07-14T09:15:22Z",
	updated_at: "2026-07-14T09:15:22Z",
	column_values: { person: null },
};
const PAYLOAD_B = { board: { id: "18421888353", name: "Subitems of Tasks" }, items: [ITEM_B_NO_DESC] };

describe("readItemIds", () => {
	it("returns the numeric ids when present", () => {
		expect(readItemIds({ boardId: 1, itemIds: [12511130115] })).toEqual([12511130115]);
	});
	it("returns undefined when itemIds is absent (board browse)", () => {
		expect(readItemIds({ boardId: 1 })).toBeUndefined();
	});
	it("returns undefined for an empty itemIds array", () => {
		expect(readItemIds({ itemIds: [] })).toBeUndefined();
	});
	it("accepts numeric-string ids (monday serializes large ids as strings)", () => {
		expect(readItemIds({ itemIds: ["12511130115"] })).toEqual([12511130115]);
		expect(readItemIds({ itemIds: [12511130115, "12526313713"] })).toEqual([12511130115, 12526313713]);
	});
	it("ignores non-numeric-string entries but keeps a valid one", () => {
		expect(readItemIds({ itemIds: ["abc"] })).toBeUndefined();
		expect(readItemIds({ itemIds: ["abc", "9"] })).toEqual([9]);
	});
	it("returns undefined for a non-object input", () => {
		expect(readItemIds(undefined)).toBeUndefined();
		expect(readItemIds("nope")).toBeUndefined();
	});
});

describe("normalizeMonday", () => {
	it("voids (null) when itemIds is undefined — a board browse produces no reference", () => {
		expect(normalizeMonday(PAYLOAD_A, { itemIds: undefined })).toBeNull();
	});
	it("voids (null) when itemIds is empty", () => {
		expect(normalizeMonday(PAYLOAD_A, { itemIds: [] })).toBeNull();
	});
	it("voids (null) for a non-object payload", () => {
		expect(normalizeMonday("nope", { itemIds: [1] })).toBeNull();
	});
	it("flattens a targeted item with its delta-format description + board name", () => {
		const out = normalizeMonday(PAYLOAD_A, { itemIds: [12511130115] });
		expect(out).toEqual({
			items: [
				{
					id: "12511130115",
					name: "Add monday MCP integration",
					url: "https://jolli-squad.monday.com/boards/18421599187/pulses/12511130115",
					board: "Tasks",
					description:
						"Use MCP to get monday task info in Agents (Claude Code, Codex, etc), Jolli Memory will capture the context in sessions, and show as context reference in working memory.",
				},
			],
		});
	});
	it("omits description when item_description is absent (subitem)", () => {
		const out = normalizeMonday(PAYLOAD_B, { itemIds: [12526313713] });
		expect(out?.items[0]).toEqual({
			id: "12526313713",
			name: "Claude Code Support",
			url: "https://jolli-squad.monday.com/boards/18421888353/pulses/12526313713",
			board: "Subitems of Tasks",
		});
	});
	it("concatenates multiple blocks and multiple inserts", () => {
		const multi = {
			items: [
				{
					id: "9",
					name: "Multi",
					url: "https://x.monday.com/boards/1/pulses/9",
					created_at: "t",
					updated_at: "t",
					item_description: {
						blocks: [
							{ content: '{"deltaFormat":[{"insert":"Line one "},{"insert":"still one"}]}' },
							{ content: '{"deltaFormat":[{"insert":"Line two"}]}' },
						],
					},
				},
			],
		};
		expect(normalizeMonday(multi, { itemIds: [9] })?.items[0].description).toBe("Line one still one\nLine two");
	});
	it("keeps a non-JSON block as plain text and concatenates the deltaFormat block", () => {
		const bad = {
			items: [
				{
					id: "9",
					name: "Bad",
					url: "https://x.monday.com/boards/1/pulses/9",
					created_at: "t",
					updated_at: "t",
					item_description: {
						blocks: [{ content: "plain text line" }, { content: '{"deltaFormat":[{"insert":"ok"}]}' }],
					},
				},
			],
		};
		expect(normalizeMonday(bad, { itemIds: [9] })?.items[0].description).toBe("plain text line\nok");
	});
	it("skips a JSON-shaped but malformed/deltaFormat-less block without throwing", () => {
		const bad = {
			items: [
				{
					id: "9",
					name: "Bad",
					url: "https://x.monday.com/boards/1/pulses/9",
					created_at: "t",
					updated_at: "t",
					item_description: {
						// first: truncated JSON blob (JSON-shaped, unparseable); second: valid JSON, no deltaFormat.
						blocks: [{ content: '{"deltaFormat":[{"insert":' }, { content: '{"other":1}' }],
					},
				},
			],
		};
		expect(normalizeMonday(bad, { itemIds: [9] })?.items[0].description).toBeUndefined();
	});
	it("drops an item missing id/name/url", () => {
		const p = { board: { name: "B" }, items: [{ id: "1", name: "no-url" }] };
		expect(normalizeMonday(p, { itemIds: [1] })).toEqual({ items: [] });
	});
	it("omits board when the board name is absent", () => {
		const p = { items: [ITEM_B_NO_DESC] };
		expect(normalizeMonday(p, { itemIds: [1] })?.items[0].board).toBeUndefined();
	});
});
