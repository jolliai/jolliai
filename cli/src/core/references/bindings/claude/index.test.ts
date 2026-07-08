import { describe, expect, it } from "vitest";
import { CLAUDE_SHELL_TOOL_NAMES, CLAUDE_TOOL_PREFIXES } from "./index.js";

describe("Claude producer binding", () => {
	describe("CLAUDE_TOOL_PREFIXES", () => {
		it("lists every vendor prefix for the envelope pre-filter (both Linear prefixes included)", () => {
			// Order follows BUILTIN_DEFINITIONS (linear, jira, github, notion) —
			// derived from the SourceDefinitionRegistry. Order is not semantically
			// significant here (the needles are only used via `.some()`), so this
			// pins the registry-driven order for regression visibility rather than a
			// hard functional requirement.
			expect(CLAUDE_TOOL_PREFIXES).toEqual([
				"mcp__linear__",
				"mcp__claude_ai_Linear__",
				"mcp__claude_ai_Atlassian__",
				"mcp__github__",
				"mcp__claude_ai_Notion__",
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
