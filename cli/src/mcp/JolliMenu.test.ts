import { describe, expect, it } from "vitest";
import type { PlatformToolManifestEntry } from "../core/JolliMemoryPushClient.js";
import {
	type BuiltInToolInfo,
	buildJolliMenu,
	buildJolliPromptText,
	JOLLI_PROMPT_ARGUMENT,
	JOLLI_PROMPT_NAME,
	LOCAL_MENU_TOOL_NAMES,
} from "./JolliMenu.js";

function platformTool(overrides: Partial<PlatformToolManifestEntry> & { name: string }): PlatformToolManifestEntry {
	return {
		description: `desc for ${overrides.name}`,
		inputSchema: { type: "object", properties: {} },
		...overrides,
	};
}

const BUILT_INS: BuiltInToolInfo[] = [
	{ name: "search", description: "Search memories" },
	{ name: "recall", description: "Recall branch context" },
];

describe("JolliMenu constants", () => {
	it("names the prompt and its single argument", () => {
		expect(JOLLI_PROMPT_NAME).toBe("jolli");
		expect(JOLLI_PROMPT_ARGUMENT).toBe("request");
	});

	it("ships an empty local inclusion list", () => {
		expect(LOCAL_MENU_TOOL_NAMES).toEqual([]);
	});
});

describe("buildJolliMenu", () => {
	it("includes only menu-flagged platform tools", () => {
		const menu = buildJolliMenu(
			[
				platformTool({ name: "create_ticket", menu: { label: "Create ticket" } }),
				platformTool({ name: "unflagged" }),
			],
			BUILT_INS,
		);
		expect(menu).toEqual([
			{ toolName: "create_ticket", label: "Create ticket", description: "desc for create_ticket" },
		]);
	});

	it("prefers the menu description over the tool description when provided", () => {
		const menu = buildJolliMenu(
			[
				platformTool({
					name: "create_ticket",
					menu: { label: "Create ticket", description: "Open a new ticket" },
				}),
			],
			BUILT_INS,
		);
		expect(menu[0]).toMatchObject({ description: "Open a new ticket" });
	});

	it("resolves local tool names against the built-in registry", () => {
		const menu = buildJolliMenu([], BUILT_INS, ["recall"]);
		expect(menu).toEqual([{ toolName: "recall", label: "recall", description: "Recall branch context" }]);
	});

	it("skips local names that do not match a built-in tool", () => {
		const menu = buildJolliMenu([], BUILT_INS, ["does_not_exist"]);
		expect(menu).toEqual([]);
	});

	it("defaults to the empty local inclusion list", () => {
		const menu = buildJolliMenu([platformTool({ name: "a", menu: { label: "A" } })], BUILT_INS);
		expect(menu.map((m) => m.toolName)).toEqual(["a"]);
	});

	it("sorts by order ascending, then label, then tool name", () => {
		const menu = buildJolliMenu(
			[
				platformTool({ name: "third", menu: { label: "Zeta" } }), // no order → last
				platformTool({ name: "first", menu: { label: "Alpha", order: 1 } }),
				platformTool({ name: "second", menu: { label: "Beta", order: 2 } }),
				platformTool({ name: "second_tie", menu: { label: "Beta", order: 2 } }),
			],
			BUILT_INS,
		);
		expect(menu.map((m) => m.toolName)).toEqual(["first", "second", "second_tie", "third"]);
	});

	it("combines platform and local items", () => {
		const menu = buildJolliMenu(
			[platformTool({ name: "create_ticket", menu: { label: "Create ticket" } })],
			BUILT_INS,
			["search"],
		);
		expect(menu.map((m) => m.toolName).sort()).toEqual(["create_ticket", "search"]);
	});
});

describe("buildJolliPromptText", () => {
	const menu = buildJolliMenu(
		[
			platformTool({ name: "create_ticket", menu: { label: "Create ticket", description: "Open a ticket" } }),
			platformTool({ name: "plain", menu: { label: "Plain" }, description: "" }),
		],
		BUILT_INS,
	);

	it("renders each item with label, description, and the tool to call", () => {
		const text = buildJolliPromptText(menu);
		expect(text).toContain("- Create ticket — Open a ticket (call tool `create_ticket`)");
		// An item with no description omits the em-dash clause.
		expect(text).toContain("- Plain (call tool `plain`)");
	});

	it("with a request: instructs the agent to match and invoke directly", () => {
		const text = buildJolliPromptText(menu, "  make me a ticket  ");
		expect(text).toContain('with this request: "make me a ticket"');
		expect(text).toContain("invoke its MCP tool directly");
		expect(text).not.toContain("without a specific request");
	});

	it("without a request: instructs the agent to present a picker with a text fallback", () => {
		const text = buildJolliPromptText(menu);
		expect(text).toContain("without a specific request");
		expect(text).toContain("AskUserQuestion");
		expect(text).toContain("plain text");
	});

	it("treats a blank/whitespace request as absent", () => {
		expect(buildJolliPromptText(menu, "   ")).toContain("without a specific request");
	});
});
