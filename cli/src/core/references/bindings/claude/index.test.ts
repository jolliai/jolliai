import { describe, expect, it } from "vitest";
import { CLAUDE_SHELL_TOOL_NAMES, CLAUDE_TOOL_PREFIXES, claudeBindingForToolName, resolveClaudeTool } from "./index.js";

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

	describe("resolveClaudeTool", () => {
		it("resolves an MCP tool by name (kind mcp, toolName = real name, identity normalize)", () => {
			const r = resolveClaudeTool("mcp__github__issue_read", undefined);
			expect(r).toEqual({
				sourceId: "github",
				kind: "mcp",
				toolName: "mcp__github__issue_read",
				normalize: expect.any(Function),
			});
			const payload = { number: 1 };
			expect(r?.normalize(payload)).toBe(payload); // identity for MCP
		});

		it("resolves a Bash `gh issue view --json` command to the github CLI binding (kind cli, canonical toolName)", () => {
			const r = resolveClaudeTool("Bash", { command: "gh issue view 959 --repo o/r --json number,title" });
			expect(r?.sourceId).toBe("github");
			expect(r?.kind).toBe("cli");
			expect(r?.toolName).toBe("mcp__github__issue_read");
		});

		it("returns null for Bash running a non-gh command", () => {
			expect(resolveClaudeTool("Bash", { command: "npm test" })).toBeNull();
		});

		it("returns null for Bash with no command input", () => {
			expect(resolveClaudeTool("Bash", {})).toBeNull();
			expect(resolveClaudeTool("Bash", undefined)).toBeNull();
			expect(resolveClaudeTool("Bash", { command: 42 })).toBeNull();
		});

		it("returns null for BashOutput (not a shell tool, no command)", () => {
			expect(resolveClaudeTool("BashOutput", { bash_id: "x" })).toBeNull();
		});

		it("returns null for an unrecognised non-shell tool", () => {
			expect(resolveClaudeTool("Read", { file_path: "/x" })).toBeNull();
		});
	});

	describe("CLAUDE_SHELL_TOOL_NAMES", () => {
		it("contains Bash and not BashOutput", () => {
			expect(CLAUDE_SHELL_TOOL_NAMES.has("Bash")).toBe(true);
			expect(CLAUDE_SHELL_TOOL_NAMES.has("BashOutput")).toBe(false);
		});
	});
});
