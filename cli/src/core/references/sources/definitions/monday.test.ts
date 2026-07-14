import { describe, expect, it } from "vitest";
import { extractRef, renderBlock } from "../../SourceEngine.js";
import { mondayDefinition as def } from "./monday.js";

// The definition runs over ONE normalized item (after wrapperKeys:["items"] unwrap).
const ITEM = {
	id: "12511130115",
	name: "Add monday MCP integration",
	url: "https://jolli-squad.monday.com/boards/18421599187/pulses/12511130115",
	board: "Tasks",
	description: "Use MCP to get monday task info in Agents.",
};
const TOOL = "mcp__claude_ai_monday_com__get_board_items_page";
const AT = "2026-07-14T00:00:00Z";

describe("monday definition", () => {
	it("extracts a Reference from a normalized item", () => {
		const ref = extractRef(def, ITEM, TOOL, AT);
		expect(ref?.source).toBe("monday");
		expect(ref?.nativeId).toBe("12511130115");
		expect(ref?.title).toBe("Add monday MCP integration");
		expect(ref?.url).toBe(ITEM.url);
		expect(ref?.description).toBe("Use MCP to get monday task info in Agents.");
		expect(ref?.fields).toEqual([
			{ key: "entity-type", label: "Type", icon: "symbol-class", value: "item" },
			{ key: "board", label: "Board", icon: "project", value: "Tasks" },
		]);
	});
	it("drops the description when absent (subitem)", () => {
		const { description: _description, ...noDesc } = ITEM;
		const ref = extractRef(def, noDesc, TOOL, AT);
		expect(ref?.description).toBeUndefined();
	});
	it("drops the board field when the board name is absent", () => {
		const { board: _board, ...noBoard } = ITEM;
		const ref = extractRef(def, noBoard, TOOL, AT);
		expect(ref?.fields).toEqual([{ key: "entity-type", label: "Type", icon: "symbol-class", value: "item" }]);
	});
	it("voids when id (nativeId) is missing", () => {
		expect(extractRef(def, { ...ITEM, id: undefined }, TOOL, AT)).toBeNull();
	});
	it("voids when the url is not a monday host", () => {
		expect(extractRef(def, { ...ITEM, url: "https://evil.example/x" }, TOOL, AT)).toBeNull();
	});
	it("accepts a mixed-case monday host (URL hosts are case-insensitive)", () => {
		const url = "https://Jolli-Squad.Monday.com/boards/1/pulses/9";
		expect(extractRef(def, { ...ITEM, url }, TOOL, AT)?.url).toBe(url);
	});
	it("accepts a multi-label monday sub-domain", () => {
		const url = "https://a.b.monday.com/boards/1/pulses/9";
		expect(extractRef(def, { ...ITEM, url }, TOOL, AT)?.url).toBe(url);
	});
	it("still rejects a look-alike host that only ends in monday.com", () => {
		expect(extractRef(def, { ...ITEM, url: "https://x.monday.com.evil.example/x" }, TOOL, AT)).toBeNull();
		expect(extractRef(def, { ...ITEM, url: "https://evilmonday.com/x" }, TOOL, AT)).toBeNull();
	});
	it("renders a <monday-items> block", () => {
		const ref = extractRef(def, ITEM, TOOL, AT);
		if (ref === null) throw new Error("expected ref");
		const block = renderBlock(def, [ref]);
		expect(block).toContain("<monday-items>");
		expect(block).toContain("<item ");
		expect(block).toContain("<description>");
	});
});
