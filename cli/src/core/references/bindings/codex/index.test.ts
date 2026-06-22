import { describe, expect, it } from "vitest";
import { codexBindingFromFunctionCall, codexBindingFromInvocationTool } from "./index.js";

describe("Codex producer binding registry", () => {
	describe("codexBindingFromInvocationTool (mcp_tool_call_end path)", () => {
		it("maps the real main-fetch invocation.tool names (incl the space in jira)", () => {
			expect(codexBindingFromInvocationTool("linear_fetch")?.id).toBe("linear");
			expect(codexBindingFromInvocationTool("notion_fetch")?.id).toBe("notion");
			expect(codexBindingFromInvocationTool("github_fetch_issue")?.id).toBe("github");
			expect(codexBindingFromInvocationTool("atlassian rovo_getjiraissue")?.id).toBe("jira");
		});

		it("maps the OpenAI-curated Linear connector's dotted read invocations", () => {
			expect(codexBindingFromInvocationTool("linear.get_issue")?.id).toBe("linear");
			expect(codexBindingFromInvocationTool("linear.list_issues")?.id).toBe("linear");
			expect(codexBindingFromInvocationTool("linear.search")?.id).toBe("linear");
		});

		it("maps github_search_issues to github (search-then-resolve path)", () => {
			expect(codexBindingFromInvocationTool("github_search_issues")?.id).toBe("github");
		});

		it("returns null for non-whitelisted (list/create/search/comments/get_repo) tools", () => {
			expect(codexBindingFromInvocationTool("linear_list_teams")).toBeNull();
			expect(codexBindingFromInvocationTool("github_fetch_issue_comments")).toBeNull();
			expect(codexBindingFromInvocationTool("github_get_repo")).toBeNull();
			expect(codexBindingFromInvocationTool("atlassian rovo_search")).toBeNull();
			expect(codexBindingFromInvocationTool("")).toBeNull();
		});
	});

	describe("codexBindingFromFunctionCall (function_call path)", () => {
		it("maps namespace suffix + tool name to source (atlassian_rovo→jira)", () => {
			expect(codexBindingFromFunctionCall("mcp__codex_apps__linear", "_fetch")?.id).toBe("linear");
			expect(codexBindingFromFunctionCall("mcp__codex_apps__notion", "_fetch")?.id).toBe("notion");
			expect(codexBindingFromFunctionCall("mcp__codex_apps__github", "_fetch_issue")?.id).toBe("github");
			expect(codexBindingFromFunctionCall("mcp__codex_apps__github", "_search_issues")?.id).toBe("github");
			expect(codexBindingFromFunctionCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue")?.id).toBe("jira");
		});

		it("maps the OpenAI-curated Linear connector's read tools (_get_issue/_list_issues/_search)", () => {
			expect(codexBindingFromFunctionCall("mcp__codex_apps__linear", "_get_issue")?.id).toBe("linear");
			expect(codexBindingFromFunctionCall("mcp__codex_apps__linear", "_list_issues")?.id).toBe("linear");
			expect(codexBindingFromFunctionCall("mcp__codex_apps__linear", "_search")?.id).toBe("linear");
		});

		it("returns null when the source does not expose that tool name", () => {
			expect(codexBindingFromFunctionCall("mcp__codex_apps__github", "_fetch_issue_comments")).toBeNull();
			expect(codexBindingFromFunctionCall("mcp__codex_apps__github", "_get_repo")).toBeNull();
			expect(codexBindingFromFunctionCall("mcp__codex_apps__linear", "_list_teams")).toBeNull();
			expect(codexBindingFromFunctionCall("mcp__codex_apps__atlassian_rovo", "_createjiraissue")).toBeNull();
		});

		it("rejects a tool name paired with the wrong source (namespace-first, name-checked)", () => {
			// github's fetch is `_fetch_issue`, not `_fetch`; jira's is `_getjiraissue`.
			expect(codexBindingFromFunctionCall("mcp__codex_apps__github", "_fetch")).toBeNull();
			expect(codexBindingFromFunctionCall("mcp__codex_apps__atlassian_rovo", "_fetch")).toBeNull();
			expect(codexBindingFromFunctionCall("mcp__codex_apps__linear", "_fetch_issue")).toBeNull();
			expect(codexBindingFromFunctionCall("mcp__codex_apps__linear", "_search_issues")).toBeNull();
			expect(codexBindingFromFunctionCall("mcp__codex_apps__notion", "_getjiraissue")).toBeNull();
		});

		it("returns null for a non-codex_apps namespace or unknown suffix", () => {
			expect(codexBindingFromFunctionCall("mcp__linear__get_issue", "_fetch")).toBeNull();
			expect(codexBindingFromFunctionCall("shell", "_fetch")).toBeNull();
			expect(codexBindingFromFunctionCall("mcp__codex_apps__slack", "_fetch")).toBeNull();
		});
	});

	describe("canonicalToolName satisfies each adapter's downstream expectations", () => {
		it("returns the stable synthetic names persisted as sourceToolName", () => {
			expect(codexBindingFromInvocationTool("github_fetch_issue")?.canonicalToolName).toBe(
				"mcp__github__issue_read",
			);
			expect(codexBindingFromInvocationTool("atlassian rovo_getjiraissue")?.canonicalToolName).toBe(
				"mcp__claude_ai_Atlassian__getJiraIssue",
			);
			expect(codexBindingFromInvocationTool("notion_fetch")?.canonicalToolName).toBe(
				"mcp__claude_ai_Notion__notion-fetch",
			);
			expect(codexBindingFromInvocationTool("linear_fetch")?.canonicalToolName).toBe("mcp__linear__get_issue");
		});
	});

	describe("normalize", () => {
		it("github binding reshapes a _search_issues collection (number derived from URL)", () => {
			const binding = codexBindingFromFunctionCall("mcp__codex_apps__github", "_search_issues");
			const out = binding?.normalize({
				issues: [{ url: "https://github.com/o/r/issues/959", number: null, title: "S" }],
			}) as { issues: Array<Record<string, unknown>> };
			expect(out.issues[0].number).toBe(959);
			expect(out.issues[0].html_url).toBe("https://github.com/o/r/issues/959");
		});

		it("linear/notion/jira bindings pass payloads through unchanged", () => {
			const payload = { id: "JOLLI-1", title: "x" };
			expect(codexBindingFromInvocationTool("linear_fetch")?.normalize(payload)).toBe(payload);
			expect(codexBindingFromInvocationTool("notion_fetch")?.normalize(payload)).toBe(payload);
			expect(codexBindingFromInvocationTool("atlassian rovo_getjiraissue")?.normalize(payload)).toBe(payload);
		});
	});
});
