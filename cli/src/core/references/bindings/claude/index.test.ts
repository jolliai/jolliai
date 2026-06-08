import { describe, expect, it } from "vitest";
import { CLAUDE_TOOL_PREFIXES, claudeBindingForToolName } from "./index.js";

describe("Claude producer binding", () => {
	describe("claudeBindingForToolName — source recognition", () => {
		it("maps each vendor MCP prefix to its source", () => {
			expect(claudeBindingForToolName("mcp__github__issue_read")?.sourceId).toBe("github");
			expect(claudeBindingForToolName("mcp__claude_ai_Atlassian__getJiraIssue")?.sourceId).toBe("jira");
			expect(claudeBindingForToolName("mcp__linear__get_issue")?.sourceId).toBe("linear");
			expect(claudeBindingForToolName("mcp__claude_ai_Notion__notion-fetch")?.sourceId).toBe("notion");
		});

		it("recognises any tool under the github/jira/linear prefixes (scope is shape-based downstream)", () => {
			expect(claudeBindingForToolName("mcp__github__list_issues")?.sourceId).toBe("github");
			expect(claudeBindingForToolName("mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql")?.sourceId).toBe(
				"jira",
			);
			expect(claudeBindingForToolName("mcp__linear__list_issues")?.sourceId).toBe("linear");
		});

		it("returns null for an unrecognised tool name", () => {
			expect(claudeBindingForToolName("Bash")).toBeNull();
			expect(claudeBindingForToolName("Read")).toBeNull();
			expect(claudeBindingForToolName("mcp__codex_apps__github")).toBeNull();
			expect(claudeBindingForToolName("")).toBeNull();
		});
	});

	describe("Notion tool-level business scope (only notion-fetch)", () => {
		it("accepts notion-fetch", () => {
			expect(claudeBindingForToolName("mcp__claude_ai_Notion__notion-fetch")?.sourceId).toBe("notion");
		});

		it("rejects notion-search / update / write tools (prefix matches but out of scope)", () => {
			expect(claudeBindingForToolName("mcp__claude_ai_Notion__notion-search")).toBeNull();
			expect(claudeBindingForToolName("mcp__claude_ai_Notion__notion-update-page")).toBeNull();
			expect(claudeBindingForToolName("mcp__claude_ai_Notion__notion-create-pages")).toBeNull();
		});
	});

	describe("normalize", () => {
		it("is identity for every recognised source (Claude shape ≈ canonical today)", () => {
			const payload = { id: "X", title: "t", url: "https://x" };
			expect(claudeBindingForToolName("mcp__github__issue_read")?.normalize(payload)).toBe(payload);
			expect(claudeBindingForToolName("mcp__linear__get_issue")?.normalize(payload)).toBe(payload);
		});
	});

	describe("CLAUDE_TOOL_PREFIXES", () => {
		it("lists the four vendor prefixes for the envelope pre-filter", () => {
			expect(CLAUDE_TOOL_PREFIXES).toEqual([
				"mcp__github__",
				"mcp__claude_ai_Atlassian__",
				"mcp__linear__",
				"mcp__claude_ai_Notion__",
			]);
		});
	});
});
