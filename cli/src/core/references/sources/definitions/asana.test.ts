import { describe, expect, it } from "vitest";
import { extractRef, renderBlock } from "../../SourceEngine.js";
import { asanaDefinition as def } from "./asana.js";

// The definition runs over the task object after wrapperKeys:["data"] unwrap.
const CANONICAL = {
	gid: "1216474542361983",
	name: "Add Asana MCP integration",
	notes: "Add Asana MCP integration for Claude Code and Codex",
	permalink_url: "https://app.asana.com/1/1216474500374769/project/1216474339608643/task/1216474542361983",
	assignee: { gid: "42", name: "Flyer Li" },
};
const TOOL = "mcp__claude_ai_Asana__get_task";
const AT = "2026-07-12T00:00:00Z";

describe("asana definition", () => {
	it("extracts a Reference from the canonical shape", () => {
		const ref = extractRef(def, CANONICAL, TOOL, AT);
		expect(ref?.source).toBe("asana");
		expect(ref?.nativeId).toBe("1216474542361983");
		expect(ref?.title).toBe("Add Asana MCP integration");
		expect(ref?.url).toBe(CANONICAL.permalink_url);
		expect(ref?.description).toContain("Add Asana MCP integration for Claude Code and Codex");
		expect(ref?.fields).toEqual([
			{ key: "entity-type", label: "Type", icon: "symbol-class", value: "task" },
			{ key: "assignee", label: "Assignee", icon: "person", value: "Flyer Li" },
		]);
	});

	it("drops the assignee field when the task is unassigned", () => {
		const ref = extractRef(def, { ...CANONICAL, assignee: null }, TOOL, AT);
		expect(ref?.fields).toEqual([{ key: "entity-type", label: "Type", icon: "symbol-class", value: "task" }]);
	});

	it("voids when gid (nativeId) is missing", () => {
		expect(extractRef(def, { ...CANONICAL, gid: undefined }, TOOL, AT)).toBeNull();
	});

	it("voids when the url is not an Asana host", () => {
		expect(extractRef(def, { ...CANONICAL, permalink_url: "https://evil.example/task/1" }, TOOL, AT)).toBeNull();
	});

	it("accepts a mixed-case Asana host (URL hosts are case-insensitive)", () => {
		const url = "https://App.Asana.com/1/1216474500374769/task/1216474542361983";
		expect(extractRef(def, { ...CANONICAL, permalink_url: url }, TOOL, AT)?.url).toBe(url);
	});

	it("renders an <asana-tasks> block", () => {
		const ref = extractRef(def, CANONICAL, TOOL, AT);
		if (ref === null) throw new Error("expected ref");
		const block = renderBlock(def, [ref]);
		expect(block).toContain("<asana-tasks>");
		expect(block).toContain("<task");
		expect(block).toContain("<description>");
	});
});
