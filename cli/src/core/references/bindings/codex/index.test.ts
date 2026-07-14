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
			expect(getCodexNormalizer("confluence")?.canonicalToolName).toBe(
				"mcp__claude_ai_Atlassian__getConfluencePage",
			);
			expect(getCodexNormalizer("asana")?.canonicalToolName).toBe("mcp__claude_ai_Asana__get_task");
			expect(getCodexNormalizer("monday")?.canonicalToolName).toBe(
				"mcp__claude_ai_monday_com__get_board_items_page",
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

		it("linear/notion/jira/zoom-meeting/asana normalizers pass payloads through unchanged", () => {
			const payload = { id: "JOLLI-1", title: "x" };
			expect(getCodexNormalizer("linear")?.normalize(payload)).toBe(payload);
			expect(getCodexNormalizer("notion")?.normalize(payload)).toBe(payload);
			expect(getCodexNormalizer("jira")?.normalize(payload)).toBe(payload);
			expect(getCodexNormalizer("zoom-meeting")?.normalize(payload)).toBe(payload);
			expect(getCodexNormalizer("asana")?.normalize(payload)).toBe(payload);
		});

		it("confluence normalizer reshapes the {content:{nodes}} page into the canonical shape", () => {
			const out = getCodexNormalizer("confluence")?.normalize({
				content: { nodes: [{ id: "131076", title: "P", webUrl: "https://x.atlassian.net/wiki/p/131076" }] },
			}) as { pageId?: string; title?: string; url?: string };
			expect(out.pageId).toBe("131076");
			expect(out.title).toBe("P");
			expect(out.url).toBe("https://x.atlassian.net/wiki/p/131076");
		});

		it("monday normalizer gates on itemIds from the threaded tool input", () => {
			const business = {
				board: { name: "Tasks" },
				items: [
					{
						id: "9",
						name: "T",
						url: "https://x.monday.com/boards/1/pulses/9",
						created_at: "t",
						updated_at: "t",
					},
				],
			};
			const out = getCodexNormalizer("monday")?.normalize(business, { itemIds: [9] }) as {
				items: Array<Record<string, unknown>>;
			};
			expect(out.items[0]).toEqual({
				id: "9",
				name: "T",
				url: "https://x.monday.com/boards/1/pulses/9",
				board: "Tasks",
			});
		});

		it("monday normalizer voids (null) a board browse with no itemIds", () => {
			expect(getCodexNormalizer("monday")?.normalize({ items: [] }, {})).toBeNull();
		});
	});
});
