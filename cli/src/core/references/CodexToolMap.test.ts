import { describe, expect, it } from "vitest";
import { canonicalToolName, sourceFromFunctionCall, sourceFromInvocationTool } from "./CodexToolMap.js";

describe("CodexToolMap", () => {
	describe("sourceFromInvocationTool (mcp_tool_call_end path)", () => {
		it("maps the four real main-fetch invocation.tool names (incl the space in jira)", () => {
			expect(sourceFromInvocationTool("linear_fetch")).toBe("linear");
			expect(sourceFromInvocationTool("notion_fetch")).toBe("notion");
			expect(sourceFromInvocationTool("github_fetch_issue")).toBe("github");
			expect(sourceFromInvocationTool("atlassian rovo_getjiraissue")).toBe("jira");
		});

		it("returns null for non-whitelisted (list/create/search/comments) tools", () => {
			expect(sourceFromInvocationTool("linear_list_teams")).toBeNull();
			expect(sourceFromInvocationTool("github_fetch_issue_comments")).toBeNull();
			expect(sourceFromInvocationTool("atlassian rovo_search")).toBeNull();
			expect(sourceFromInvocationTool("atlassian rovo_createjiraissue")).toBeNull();
			expect(sourceFromInvocationTool("")).toBeNull();
		});
	});

	describe("sourceFromFunctionCall (function_call path)", () => {
		it("maps namespace suffix + main-fetch name to source (atlassian_rovo→jira)", () => {
			expect(sourceFromFunctionCall("mcp__codex_apps__linear", "_fetch")).toBe("linear");
			expect(sourceFromFunctionCall("mcp__codex_apps__notion", "_fetch")).toBe("notion");
			expect(sourceFromFunctionCall("mcp__codex_apps__github", "_fetch_issue")).toBe("github");
			expect(sourceFromFunctionCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue")).toBe("jira");
		});

		it("returns null when the name is not a main-fetch tool", () => {
			expect(sourceFromFunctionCall("mcp__codex_apps__github", "_fetch_issue_comments")).toBeNull();
			expect(sourceFromFunctionCall("mcp__codex_apps__linear", "_list_teams")).toBeNull();
			expect(sourceFromFunctionCall("mcp__codex_apps__atlassian_rovo", "_createjiraissue")).toBeNull();
		});

		it("rejects a main-fetch name paired with the wrong source (no flat allowlist)", () => {
			// github's real fetch is `_fetch_issue`, not `_fetch`; jira's is `_getjiraissue`.
			expect(sourceFromFunctionCall("mcp__codex_apps__github", "_fetch")).toBeNull();
			expect(sourceFromFunctionCall("mcp__codex_apps__atlassian_rovo", "_fetch")).toBeNull();
			expect(sourceFromFunctionCall("mcp__codex_apps__atlassian_rovo", "_fetch_issue")).toBeNull();
			expect(sourceFromFunctionCall("mcp__codex_apps__linear", "_fetch_issue")).toBeNull();
			expect(sourceFromFunctionCall("mcp__codex_apps__notion", "_getjiraissue")).toBeNull();
		});

		it("returns null for a non-codex_apps namespace", () => {
			expect(sourceFromFunctionCall("mcp__linear__get_issue", "_fetch")).toBeNull();
			expect(sourceFromFunctionCall("shell", "_fetch")).toBeNull();
		});

		it("returns null for an unknown codex_apps suffix", () => {
			expect(sourceFromFunctionCall("mcp__codex_apps__slack", "_fetch")).toBeNull();
		});
	});

	describe("canonicalToolName", () => {
		it("returns names that satisfy each adapter's guard", () => {
			expect(canonicalToolName("github")).toContain("mcp__github__");
			expect(canonicalToolName("jira")).toContain("mcp__claude_ai_Atlassian__");
			expect(canonicalToolName("notion").endsWith("notion-fetch")).toBe(true);
			expect(canonicalToolName("linear")).toContain("mcp__linear__");
		});
	});
});
