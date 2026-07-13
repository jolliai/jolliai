import { describe, expect, it } from "vitest";
import { getCodexNormalizer } from "./index.js";

describe("Codex producer normalizer registry", () => {
	describe("getCodexNormalizer", () => {
		it("returns the stable synthetic canonicalToolName persisted as sourceToolName, per source id", () => {
			expect(getCodexNormalizer("github")?.canonicalToolName).toBe("mcp__github__issue_read");
			expect(getCodexNormalizer("jira")?.canonicalToolName).toBe("mcp__claude_ai_Atlassian__getJiraIssue");
			expect(getCodexNormalizer("notion")?.canonicalToolName).toBe("mcp__claude_ai_Notion__notion-fetch");
			expect(getCodexNormalizer("linear")?.canonicalToolName).toBe("mcp__linear__get_issue");
			expect(getCodexNormalizer("zoom-meeting")?.canonicalToolName).toBe(
				"mcp__claude_ai_Zoom_for_Claude__get_meeting_assets",
			);
		});

		it("returns undefined for an id with no registered normalizer", () => {
			expect(getCodexNormalizer("unknown")).toBeUndefined();
		});
	});

	describe("normalize", () => {
		it("github normalizer reshapes a _search_issues collection (number derived from URL)", () => {
			const normalizer = getCodexNormalizer("github");
			const out = normalizer?.normalize({
				issues: [{ url: "https://github.com/o/r/issues/959", number: null, title: "S" }],
			}) as { issues: Array<Record<string, unknown>> };
			expect(out.issues[0].number).toBe(959);
			expect(out.issues[0].html_url).toBe("https://github.com/o/r/issues/959");
		});

		it("linear/notion/jira/zoom-meeting normalizers pass payloads through unchanged", () => {
			const payload = { id: "JOLLI-1", title: "x" };
			expect(getCodexNormalizer("linear")?.normalize(payload)).toBe(payload);
			expect(getCodexNormalizer("notion")?.normalize(payload)).toBe(payload);
			expect(getCodexNormalizer("jira")?.normalize(payload)).toBe(payload);
			expect(getCodexNormalizer("zoom-meeting")?.normalize(payload)).toBe(payload);
		});
	});
});
