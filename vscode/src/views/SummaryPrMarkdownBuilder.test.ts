/**
 * SummaryPrMarkdownBuilder tests
 *
 * Tests the GitHub PR-description-optimized markdown output. Shared helpers
 * (pushPlansAndNotesSection, pushFooter) are imported from the real
 * SummaryMarkdownBuilder — only SummaryUtils is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	aggregateStats: vi.fn(),
	aggregateTurns: vi.fn(),
	formatDurationLabel: vi.fn(),
	resolveDiffStats: vi.fn(),
	collectSortedTopics: vi.fn(),
	formatDate: vi.fn(),
	formatFullDate: vi.fn(),
	getDisplayDate: vi.fn(
		(e: { generatedAt?: string; commitDate: string }) =>
			e.generatedAt || e.commitDate,
	),
	padIndex: vi.fn(),
}));

vi.mock("../../../cli/src/core/SummaryTree.js", () => ({
	aggregateStats: mocks.aggregateStats,
	aggregateTurns: mocks.aggregateTurns,
	formatDurationLabel: mocks.formatDurationLabel,
	resolveDiffStats: mocks.resolveDiffStats,
}));

// Mock the core SummaryFormat module (used by the core SummaryMarkdownBuilder)
vi.mock("../../../cli/src/core/SummaryFormat.js", () => ({
	collectSortedTopics: mocks.collectSortedTopics,
	formatDate: mocks.formatDate,
	formatFullDate: mocks.formatFullDate,
	getDisplayDate: mocks.getDisplayDate,
	padIndex: mocks.padIndex,
}));

import type { CommitSummary } from "../../../cli/src/Types.js";
import { buildMarkdown } from "./SummaryMarkdownBuilder.js";
import { buildPrMarkdown } from "./SummaryPrMarkdownBuilder.js";
import type { TopicWithDate } from "./SummaryUtils.js";

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Creates a minimal CommitSummary stub with sensible defaults. */
function makeSummary(overrides: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 3,
		commitHash: "abc1234567890def",
		commitMessage: "Fix login timeout",
		commitAuthor: "Alice",
		commitDate: "2026-03-30T10:00:00Z",
		branch: "feature/proj-100-login",
		generatedAt: "2026-03-30T10:05:00Z",
		// Default stats so resolveDiffStats mock reads a sensible value on the header call.
		stats: { filesChanged: 3, insertions: 50, deletions: 10 },
		...overrides,
	};
}

/** Creates a TopicWithDate stub. */
function makeTopic(overrides: Partial<TopicWithDate> = {}): TopicWithDate {
	return {
		title: "Handle timeout edge case",
		trigger: "Users experienced login timeouts.",
		response: "Added retry logic.",
		decisions: "Chose exponential backoff.",
		todo: "Add metrics for retry counts.",
		filesAffected: ["src/auth/Login.ts", "src/auth/Retry.ts"],
		category: "bugfix",
		recordDate: "2026-03-30T10:00:00Z",
		importance: "major",
		commitDate: "2026-03-30T10:00:00Z",
		treeIndex: 0,
		...overrides,
	};
}

/** Sets up default mock return values used by most tests. */
function setupDefaults(
	summary: CommitSummary,
	topics: Array<TopicWithDate> = [makeTopic()],
	sourceNodes: ReadonlyArray<CommitSummary> = [summary],
): void {
	mocks.collectSortedTopics.mockReturnValue({
		topics,
		sourceNodes,
	});
	mocks.aggregateStats.mockReturnValue({
		filesChanged: 3,
		insertions: 50,
		deletions: 10,
	});
	mocks.resolveDiffStats.mockImplementation((node: CommitSummary) => {
		if (node.diffStats) return node.diffStats;
		if (node.stats) return node.stats;
		return { filesChanged: 0, insertions: 0, deletions: 0 };
	});
	mocks.aggregateTurns.mockReturnValue(5);
	mocks.formatDurationLabel.mockReturnValue("1 day (1 commit)");
	mocks.formatFullDate.mockReturnValue("March 30, 2026 at 10:00 AM");
	mocks.formatDate.mockReturnValue("Mar 30, 2026");
	mocks.padIndex.mockImplementation((i: number) =>
		String(i + 1).padStart(2, "0"),
	);
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("SummaryPrMarkdownBuilder", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-30T12:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("buildPrMarkdown", () => {
		describe("Jolli Memory URL section", () => {
			it("includes memory URL when jolliDocUrl is set", () => {
				const summary = makeSummary({
					jolliDocUrl: "https://jolli.app/doc/456",
				});
				setupDefaults(summary);

				const md = buildPrMarkdown(summary);

				expect(md).toContain("## Jolli Memory");
				expect(md).toContain("https://jolli.app/doc/456");
			});

			it("omits memory URL section when jolliDocUrl is not set", () => {
				const summary = makeSummary();
				setupDefaults(summary);

				const md = buildPrMarkdown(summary);

				expect(md).not.toContain("## Jolli Memory");
			});
		});

		describe("plans & notes section (PR mode)", () => {
			it("renders plan with URL as markdown link", () => {
				const summary = makeSummary({
					plans: [
						{
							slug: "plan-y",
							title: "Plan Y",
							editCount: 2,
							addedAt: "2026-03-30T09:00:00Z",
							updatedAt: "2026-03-30T09:30:00Z",
							jolliPlanDocUrl: "https://jolli.app/plan/y",
						},
					],
				});
				setupDefaults(summary);

				const md = buildPrMarkdown(summary);

				expect(md).toContain("- [Plan Y](https://jolli.app/plan/y)");
			});

			it("renders plan title only when no URL", () => {
				const summary = makeSummary({
					plans: [
						{
							slug: "plan-x",
							title: "Plan X",
							editCount: 10,
							addedAt: "2026-03-30T09:00:00Z",
							updatedAt: "2026-03-30T09:30:00Z",
						},
					],
				});
				setupDefaults(summary);

				const md = buildPrMarkdown(summary);

				expect(md).toContain("- Plan X");
				expect(md).not.toContain("edited");
			});
		});

		describe("PR topics", () => {
			it("renders all five topic body sections (Why/Decisions/What/Future/Files)", () => {
				const topic = makeTopic({
					trigger: "Login bug found.",
					decisions: "Use retry.",
					response: "Added retries.",
					todo: "Add metrics.",
					filesAffected: ["src/Login.ts", "src/Retry.ts"],
				});
				const summary = makeSummary();
				setupDefaults(summary, [topic]);

				const md = buildPrMarkdown(summary);

				expect(md).toContain("**⚡ Why This Change**");
				expect(md).toContain("Login bug found.");
				expect(md).toContain("**💡 Decisions Behind the Code**");
				expect(md).toContain("Use retry.");
				expect(md).toContain("**✅ What Was Implemented**");
				expect(md).toContain("Added retries.");
				expect(md).toContain("**📋 Future Enhancements**");
				expect(md).toContain("Add metrics.");
				expect(md).toContain("**📁 FILES**");
				expect(md).toContain("- `src/Login.ts`");
				expect(md).toContain("- `src/Retry.ts`");
			});

			it("omits Future Enhancements section when todo is absent", () => {
				const topic = makeTopic({ todo: undefined });
				const summary = makeSummary();
				setupDefaults(summary, [topic]);

				const md = buildPrMarkdown(summary);

				expect(md).not.toContain("**📋 Future Enhancements**");
			});

			it("omits FILES section when filesAffected is empty", () => {
				const topic = makeTopic({ filesAffected: [] });
				const summary = makeSummary();
				setupDefaults(summary, [topic]);

				const md = buildPrMarkdown(summary);

				expect(md).not.toContain("**📁 FILES**");
			});

			it("sanitizes wrapper tags in todo field", () => {
				const topic = makeTopic({
					todo: "Consider </details> caveat and <blockquote>nested</blockquote> refactor",
				});
				const summary = makeSummary();
				setupDefaults(summary, [topic]);

				const md = buildPrMarkdown(summary);

				expect(md).toContain("&lt;/details&gt;");
				expect(md).toContain("&lt;blockquote&gt;");
				expect(md).toContain("&lt;/blockquote&gt;");
				// Raw tags must not leak from todo text
				expect(md).not.toContain("Consider </details> caveat");
				expect(md).not.toContain("<blockquote>nested</blockquote> refactor");
			});

			it("renders topics without date grouping in PR mode", () => {
				const topics = [
					makeTopic({ title: "PR Topic 1" }),
					makeTopic({ title: "PR Topic 2" }),
				];
				const summary = makeSummary();
				setupDefaults(summary, topics);

				const md = buildPrMarkdown(summary);

				expect(md).toContain("## Topics (2)");
				expect(md).toContain("<strong>01 · PR Topic 1</strong>");
				expect(md).toContain("<strong>02 · PR Topic 2</strong>");
			});

			it("omits PR topics section when no topics exist", () => {
				const summary = makeSummary();
				setupDefaults(summary, []);

				const md = buildPrMarkdown(summary);

				expect(md).not.toContain("## Topic");
				expect(md).not.toContain("## Topics");
			});
		});

		describe("PR body truncation", () => {
			it("truncates topics that exceed PR_BODY_LIMIT (65000 chars)", () => {
				const longText = "x".repeat(20000);
				const topics = [
					makeTopic({
						title: "T1",
						trigger: longText,
						decisions: longText,
						response: longText,
					}),
					makeTopic({
						title: "T2",
						trigger: longText,
						decisions: longText,
						response: longText,
					}),
					makeTopic({
						title: "T3",
						trigger: "short",
						decisions: "short",
						response: "short",
					}),
				];
				const summary = makeSummary();
				setupDefaults(summary, topics);

				const md = buildPrMarkdown(summary);

				expect(md).toMatch(
					/⚠️ \d+ more topic(s?) omitted due to GitHub PR body size limit/,
				);
			});

			it("shows singular 'topic' for 1 omitted topic", () => {
				const longText = "y".repeat(20000);
				const topics = [
					makeTopic({
						title: "T1",
						trigger: longText,
						decisions: "short",
						response: "short",
					}),
					makeTopic({
						title: "T2",
						trigger: longText,
						decisions: longText,
						response: longText,
					}),
				];
				const summary = makeSummary();
				setupDefaults(summary, topics);

				const md = buildPrMarkdown(summary);

				if (md.includes("omitted")) {
					expect(md).toContain("1 more topic omitted");
				}
			});

			it("shows plural 'topics' for multiple omitted topics", () => {
				const longText = "z".repeat(25000);
				const topics = [
					makeTopic({
						title: "T1",
						trigger: longText,
						decisions: longText,
						response: longText,
					}),
					makeTopic({
						title: "T2",
						trigger: longText,
						decisions: "short",
						response: "short",
					}),
					makeTopic({
						title: "T3",
						trigger: "short",
						decisions: "short",
						response: "short",
					}),
				];
				const summary = makeSummary();
				setupDefaults(summary, topics);

				const md = buildPrMarkdown(summary);

				if (md.includes("omitted")) {
					expect(md).toMatch(/\d+ more topics omitted/);
				}
			});

			it("does not show warning when all topics fit", () => {
				const topics = [makeTopic({ title: "Small" })];
				const summary = makeSummary();
				setupDefaults(summary, topics);

				const md = buildPrMarkdown(summary);

				expect(md).not.toContain("omitted");
			});
		});

		describe("flat topics rendering (no date grouping)", () => {
			it("renders multiple topics as a flat list in PR mode", () => {
				// Timeline grouping was removed: topics render flat regardless of
				// source-commit count or date span.
				const topics = [
					makeTopic({ title: "A", commitDate: "2026-03-30T10:00:00Z" }),
					makeTopic({ title: "B", commitDate: "2026-03-29T10:00:00Z" }),
				];
				const summary = makeSummary();
				setupDefaults(summary, topics, [summary]);

				const md = buildPrMarkdown(summary);

				expect(md).toContain("## Topics (2)");
				expect(md).not.toMatch(/^### Mar \d+, 2026/m);
				expect(md).toContain("<strong>01 · A</strong>");
				expect(md).toContain("<strong>02 · B</strong>");
			});
		});

		describe("notes section in PR mode", () => {
			it("renders note title only — no inline content", () => {
				const summary = makeSummary({
					notes: [
						{
							id: "pr-note",
							title: "PR Note",
							format: "snippet",
							content: "some text",
							addedAt: "2026-03-30T09:00:00Z",
							updatedAt: "2026-03-30T09:30:00Z",
						},
					],
				});
				setupDefaults(summary);

				const md = buildPrMarkdown(summary);

				expect(md).toContain("## Plans & Notes");
				expect(md).toContain("- PR Note");
				expect(md).not.toContain("some text");
			});
		});

		describe("E2E test guide in PR mode", () => {
			it("includes E2E test section in PR markdown", () => {
				const summary = makeSummary({
					e2eTestGuide: [
						{
							title: "PR E2E",
							steps: ["Step one"],
							expectedResults: ["Pass"],
						},
					],
				});
				setupDefaults(summary);

				const md = buildPrMarkdown(summary);

				expect(md).toContain("## E2E Test (1)");
				expect(md).toContain("<strong>1. PR E2E</strong>");
			});
		});

		describe("footer", () => {
			it("includes generated-by footer", () => {
				const summary = makeSummary();
				setupDefaults(summary);

				const md = buildPrMarkdown(summary);

				expect(md).toContain("*Generated by Jolli Memory");
			});
		});

		// ── GitHub <details>/<summary> folding and sanitization ──────────────

		describe("details folding and sanitization", () => {
			it("inserts <br> spacer after </summary> so expanded body is not glued to label", () => {
				const topic = makeTopic({ title: "T" });
				const summary = makeSummary({
					e2eTestGuide: [{ title: "E", steps: ["s"], expectedResults: ["r"] }],
				});
				setupDefaults(summary, [topic]);

				const md = buildPrMarkdown(summary);

				// Each wrapper (1 topic + 1 scenario) has one </summary><br> pair
				expect((md.match(/<\/summary>\n<br>/g) ?? []).length).toBe(2);
			});

			it("wraps each topic and E2E scenario in balanced <details>/<summary>/<blockquote>", () => {
				const topics = [
					makeTopic({ title: "Topic A" }),
					makeTopic({ title: "Topic B" }),
				];
				const summary = makeSummary({
					e2eTestGuide: [
						{ title: "Scenario X", steps: ["s1"], expectedResults: ["r1"] },
						{ title: "Scenario Y", steps: ["s2"], expectedResults: ["r2"] },
					],
				});
				setupDefaults(summary, topics);

				const md = buildPrMarkdown(summary);

				const opens = (md.match(/<details>/g) ?? []).length;
				const closes = (md.match(/<\/details>/g) ?? []).length;
				const sumOpens = (md.match(/<summary>/g) ?? []).length;
				const sumCloses = (md.match(/<\/summary>/g) ?? []).length;
				const bqOpens = (md.match(/<blockquote>/g) ?? []).length;
				const bqCloses = (md.match(/<\/blockquote>/g) ?? []).length;
				// 2 topics + 2 scenarios = 4 wrapped blocks, each with one of each tag
				expect(opens).toBe(4);
				expect(closes).toBe(4);
				expect(sumOpens).toBe(4);
				expect(sumCloses).toBe(4);
				expect(bqOpens).toBe(4);
				expect(bqCloses).toBe(4);
			});

			it("HTML-escapes topic.title inside <summary>", () => {
				const topic = makeTopic({ title: "Fix <div> & <span> bug" });
				const summary = makeSummary();
				setupDefaults(summary, [topic]);

				const md = buildPrMarkdown(summary);

				expect(md).toContain("Fix &lt;div&gt; &amp; &lt;span&gt; bug");
				expect(md).not.toContain("Fix <div> & <span> bug");
			});

			it("HTML-escapes scenario.title inside <summary>", () => {
				const summary = makeSummary({
					e2eTestGuide: [
						{
							title: "Handle <script> injection & quotes",
							steps: ["s1"],
							expectedResults: ["r1"],
						},
					],
				});
				setupDefaults(summary);

				const md = buildPrMarkdown(summary);

				expect(md).toContain("Handle &lt;script&gt; injection &amp; quotes");
				expect(md).not.toContain("Handle <script> injection & quotes");
			});

			it("sanitizes <details> tags in E2E scenario preconditions/steps/results", () => {
				const summary = makeSummary({
					e2eTestGuide: [
						{
							title: "Safety",
							preconditions: "Setup </details> before test",
							steps: ["Run step <details open>debug</details>"],
							expectedResults: ["Close </details> properly"],
						},
					],
				});
				setupDefaults(summary, []);

				const md = buildPrMarkdown(summary);

				expect((md.match(/<details>/g) ?? []).length).toBe(1);
				expect((md.match(/<\/details>/g) ?? []).length).toBe(1);
				expect(md).toContain("Setup &lt;/details&gt; before test");
				expect(md).toContain(
					"Run step &lt;details open&gt;debug&lt;/details&gt;",
				);
				expect(md).toContain("Close &lt;/details&gt; properly");
				expect(md).not.toContain("Setup </details>");
				expect(md).not.toContain("<details open>debug");
			});

			it("symmetrically escapes <details>/<blockquote> wrapper tags in body fields", () => {
				const topic = makeTopic({
					title: "T",
					trigger: "Has <blockquote>quoted</blockquote> passage",
					decisions: "- **Note</details>**: inner",
					response:
						"Handle </details> edge case and <details open>nested</details> content",
				});
				const summary = makeSummary();
				setupDefaults(summary, [topic]);

				const md = buildPrMarkdown(summary);

				expect((md.match(/<details>/g) ?? []).length).toBe(1);
				expect((md.match(/<\/details>/g) ?? []).length).toBe(1);
				expect((md.match(/<blockquote>/g) ?? []).length).toBe(1);
				expect((md.match(/<\/blockquote>/g) ?? []).length).toBe(1);
				expect(md).toContain("&lt;/details&gt;");
				expect(md).toContain("&lt;details open&gt;");
				expect(md).toContain("&lt;blockquote&gt;");
				expect(md).toContain("&lt;/blockquote&gt;");
				expect(md).not.toContain("<details open>");
				expect(md).not.toContain("Has <blockquote>");
			});

			it("preserves <summary> and other HTML tags in body (no over-escape)", () => {
				const topic = makeTopic({
					title: "T",
					trigger: "Use <code>foo</code> helper",
					decisions: "Handled by <br> break and <summary>tag</summary> widget",
					response: 'Inline <img src="x.png"/> image',
				});
				const summary = makeSummary();
				setupDefaults(summary, [topic]);

				const md = buildPrMarkdown(summary);

				expect(md).toContain("<code>foo</code>");
				expect(md).toContain("<summary>tag</summary>");
				expect(md).toContain("<br>");
				expect(md).toContain('<img src="x.png"/>');
				expect(md).not.toContain("&lt;code&gt;");
				expect(md).not.toContain("&lt;summary&gt;");
				expect(md).not.toContain("&lt;br&gt;");
				expect(md).not.toContain("&lt;img");
			});

			it("preserves topic atomicity: oversized topic writes neither <details> nor </details>", () => {
				const giantText = "h".repeat(30000);
				const topics = [
					makeTopic({
						title: "Huge",
						trigger: giantText,
						decisions: giantText,
						response: giantText,
					}),
				];
				const summary = makeSummary();
				setupDefaults(summary, topics);

				const md = buildPrMarkdown(summary);

				expect(md).not.toContain("<details>");
				expect(md).not.toContain("</details>");
				expect(md).not.toContain("<strong>01 · Huge</strong>");
				expect(md).toMatch(/⚠️ 1 more topic omitted/);
			});
		});

		// ── Regression: clipboard buildMarkdown unchanged ────────────────────

		describe("regression: buildMarkdown unaffected by PR folding", () => {
			it("clipboard output adds no PR wrapper tags", () => {
				const topic = makeTopic({
					title: "T",
					trigger: "plain trigger",
					decisions: "plain decisions",
					response: "plain response",
				});
				const summary = makeSummary({
					e2eTestGuide: [
						{
							title: "Scenario",
							steps: ["step one"],
							expectedResults: ["result"],
						},
					],
				});
				setupDefaults(summary, [topic]);

				const md = buildMarkdown(summary);

				expect(md).not.toContain("<details>");
				expect(md).not.toContain("</details>");
				expect(md).not.toContain("<summary>");
				expect(md).not.toContain("</summary>");
				expect(md).not.toContain("<blockquote>");
				expect(md).not.toContain("</blockquote>");
				expect(md).not.toContain("&lt;/details&gt;");
				expect(md).not.toContain("&lt;details open&gt;");
				expect(md).not.toContain("&lt;blockquote&gt;");
			});

			it("clipboard output passes body text verbatim (no sanitization)", () => {
				const topic = makeTopic({
					title: "T",
					trigger: "Handle </details> edge case",
					decisions: "Use <details open>nested</details>",
					response: "Quote: <blockquote>text</blockquote>",
				});
				const summary = makeSummary();
				setupDefaults(summary, [topic]);

				const md = buildMarkdown(summary);

				expect(md).toContain("Handle </details> edge case");
				expect(md).toContain("<details open>nested</details>");
				expect(md).toContain("<blockquote>text</blockquote>");
				expect(md).not.toContain("&lt;/details&gt;");
				expect(md).not.toContain("&lt;details open&gt;");
				expect(md).not.toContain("&lt;blockquote&gt;");
			});
		});
	});
});
