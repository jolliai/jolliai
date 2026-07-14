import { describe, expect, it } from "vitest";
import { CLAUDE_SHELL_TOOL_NAMES, CLAUDE_TOOL_PREFIXES } from "./index.js";

describe("Claude producer binding", () => {
	describe("CLAUDE_TOOL_PREFIXES", () => {
		it("lists every vendor prefix for the envelope pre-filter, de-duplicated (both Linear prefixes included; Zoom prefix appears once even though zoom-meeting and zoom-doc both declare it)", () => {
			// Order follows BUILTIN_DEFINITIONS (linear, jira, github, notion, slack,
			// zoom-meeting, zoom-doc, asana, monday) — derived from the SourceDefinitionRegistry.
			// zoom-meeting and zoom-doc share the same Claude MCP prefix, so
			// CLAUDE_TOOL_PREFIXES de-dupes via a Set; the shared prefix still
			// appears exactly once here. Order is not semantically significant
			// here (the needles are only used via `.some()`), so this pins the
			// registry-driven order for regression visibility rather than a hard
			// functional requirement.
			expect(CLAUDE_TOOL_PREFIXES).toEqual([
				"mcp__linear__",
				"mcp__claude_ai_Linear__",
				"mcp__claude_ai_Atlassian__",
				"mcp__github__",
				"mcp__claude_ai_Notion__",
				"mcp__claude_ai_Slack__",
				"mcp__claude_ai_Zoom_for_Claude__",
				"mcp__claude_ai_Asana__",
				"mcp__claude_ai_monday_com__",
			]);
		});
	});

	describe("CLAUDE_SHELL_TOOL_NAMES", () => {
		it("contains Bash and not BashOutput", () => {
			expect(CLAUDE_SHELL_TOOL_NAMES.has("Bash")).toBe(true);
			expect(CLAUDE_SHELL_TOOL_NAMES.has("BashOutput")).toBe(false);
		});
	});
});
