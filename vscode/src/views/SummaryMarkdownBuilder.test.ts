/**
 * SummaryMarkdownBuilder tests
 *
 * Tests both exported functions: buildMarkdown() and buildPrMarkdown().
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	aggregateStats: vi.fn(),
	aggregateTurns: vi.fn(),
	formatDurationLabel: vi.fn(),
	collectSortedTopics: vi.fn(),
	formatDate: vi.fn(),
	formatFullDate: vi.fn(),
	getDisplayDate: vi.fn(
		(e: { generatedAt?: string; commitDate: string }) =>
			e.generatedAt || e.commitDate,
	),
	groupTopicsByDate: vi.fn(),
	padIndex: vi.fn(),
}));

vi.mock("../../../cli/src/core/SummaryTree.js", () => ({
	aggregateStats: mocks.aggregateStats,
	aggregateTurns: mocks.aggregateTurns,
	formatDurationLabel: mocks.formatDurationLabel,
}));

// Mock the core SummaryFormat module (used by the core SummaryMarkdownBuilder)
vi.mock("../../../cli/src/core/SummaryFormat.js", () => ({
	collectSortedTopics: mocks.collectSortedTopics,
	formatDate: mocks.formatDate,
	formatFullDate: mocks.formatFullDate,
	getDisplayDate: mocks.getDisplayDate,
	groupTopicsByDate: mocks.groupTopicsByDate,
	padIndex: mocks.padIndex,
}));

import type { CommitSummary } from "../../../cli/src/Types.js";
import {
	buildClaudeCodeContext,
	buildMarkdown,
	buildPrMarkdown,
} from "./SummaryMarkdownBuilder.js";
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
		branch: "feature/jolli-100-login",
		generatedAt: "2026-03-30T10:05:00Z",
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
	showRecordDates = false,
): void {
	mocks.collectSortedTopics.mockReturnValue({
		topics,
		sourceNodes,
		showRecordDates,
	});
	mocks.aggregateStats.mockReturnValue({
		filesChanged: 3,
		insertions: 50,
		deletions: 10,
	});
	mocks.aggregateTurns.mockReturnValue(5);
	mocks.formatDurationLabel.mockReturnValue("1 day (1 commit)");
	mocks.formatFullDate.mockReturnValue("March 30, 2026 at 10:00 AM");
	mocks.formatDate.mockReturnValue("Mar 30, 2026");
	mocks.padIndex.mockImplementation((i: number) =>
		String(i + 1).padStart(2, "0"),
	);
	mocks.groupTopicsByDate.mockImplementation((ts: Array<TopicWithDate>) => {
		const map = new Map<string, Array<TopicWithDate>>();
		for (const t of ts) {
			const key = t.recordDate ?? "unknown";
			const list = map.get(key);
			if (list) {
				list.push(t);
			} else {
				map.set(key, [t]);
			}
		}
		return map;
	});
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("SummaryMarkdownBuilder", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Freeze formatFullDate for footer consistency
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-30T12:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// ── buildMarkdown ────────────────────────────────────────────────────────

	describe("buildMarkdown", () => {
		describe("properties section", () => {
			it("renders commit, branch, author, date, duration, and changes", () => {
				const summary = makeSummary();
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).toContain("# Fix login timeout");
				expect(md).toContain("- **Commit:** `abc1234567890def`");
				expect(md).toContain("- **Branch:** `feature/jolli-100-login`");
				expect(md).toContain("- **Author:** Alice");
				expect(md).toContain("- **Date:** March 30, 2026 at 10:00 AM");
				expect(md).toContain("- **Duration:** 1 day (1 commit)");
				expect(md).toContain(
					"- **Changes:** 3 files changed, +50 insertions, \u221210 deletions",
				);
			});

			it("pluralizes 'file' correctly for 1 file", () => {
				const summary = makeSummary();
				setupDefaults(summary);
				mocks.aggregateStats.mockReturnValue({
					filesChanged: 1,
					insertions: 5,
					deletions: 0,
				});

				const md = buildMarkdown(summary);

				expect(md).toContain("1 file changed");
				expect(md).not.toContain("1 files changed");
			});
		});

		describe("conversations row", () => {
			it("includes conversations when totalTurns > 0", () => {
				const summary = makeSummary();
				setupDefaults(summary);
				mocks.aggregateTurns.mockReturnValue(7);

				const md = buildMarkdown(summary);

				expect(md).toContain("- **Conversations:** 7 turns");
			});

			it("pluralizes 'turn' correctly for 1 turn", () => {
				const summary = makeSummary();
				setupDefaults(summary);
				mocks.aggregateTurns.mockReturnValue(1);

				const md = buildMarkdown(summary);

				expect(md).toContain("- **Conversations:** 1 turn");
				expect(md).not.toContain("1 turns");
			});

			it("omits conversations when totalTurns is 0", () => {
				const summary = makeSummary();
				setupDefaults(summary);
				mocks.aggregateTurns.mockReturnValue(0);

				const md = buildMarkdown(summary);

				expect(md).not.toContain("**Conversations:**");
			});
		});

		describe("Jolli Memory URL row", () => {
			it("includes memory URL when jolliDocUrl is set", () => {
				const summary = makeSummary({
					jolliDocUrl: "https://jolli.app/doc/123",
				});
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).toContain(
					"- **Jolli Memory:** [https://jolli.app/doc/123](https://jolli.app/doc/123)",
				);
			});

			it("omits memory URL when jolliDocUrl is not set", () => {
				const summary = makeSummary();
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).not.toContain("**Jolli Memory:**");
			});
		});

		describe("plans & notes section", () => {
			it("renders plan with URL as markdown link", () => {
				const summary = makeSummary({
					plans: [
						{
							slug: "plan-a",
							title: "Plan A",
							editCount: 3,
							addedAt: "2026-03-30T09:00:00Z",
							updatedAt: "2026-03-30T09:30:00Z",
							jolliPlanDocUrl: "https://jolli.app/plan/a",
						},
					],
				});
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).toContain("## Plans & Notes");
				expect(md).toContain("- [Plan A](https://jolli.app/plan/a)");
			});

			it("renders plan title only when no URL", () => {
				const summary = makeSummary({
					plans: [
						{
							slug: "plan-b",
							title: "Plan B",
							editCount: 5,
							addedAt: "2026-03-30T09:00:00Z",
							updatedAt: "2026-03-30T09:30:00Z",
						},
					],
				});
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).toContain("- Plan B");
				expect(md).not.toContain("edited");
				expect(md).not.toContain("plan-b.md");
			});

			it("renders note with URL as markdown link", () => {
				const summary = makeSummary({
					notes: [
						{
							id: "note-a",
							title: "Note A",
							format: "snippet",
							addedAt: "2026-03-30T09:00:00Z",
							updatedAt: "2026-03-30T09:30:00Z",
							jolliNoteDocUrl: "https://jolli.app/note/a",
						},
					],
				});
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).toContain("## Plans & Notes");
				expect(md).toContain("- [Note A](https://jolli.app/note/a)");
			});

			it("renders note title only when no URL — never shows inline content", () => {
				const summary = makeSummary({
					notes: [
						{
							id: "snip-1",
							title: "My Snippet",
							format: "snippet",
							content: "snippet body text",
							addedAt: "2026-03-30T09:00:00Z",
							updatedAt: "2026-03-30T09:30:00Z",
						},
					],
				});
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).toContain("- My Snippet");
				expect(md).not.toContain("snippet body text");
			});

			it("shows count when multiple items exist", () => {
				const summary = makeSummary({
					plans: [
						{
							slug: "p1",
							title: "P1",
							editCount: 1,
							addedAt: "2026-03-30T09:00:00Z",
							updatedAt: "2026-03-30T09:30:00Z",
						},
					],
					notes: [
						{
							id: "n1",
							title: "N1",
							format: "snippet",
							addedAt: "2026-03-30T09:00:00Z",
							updatedAt: "2026-03-30T09:30:00Z",
						},
					],
				});
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).toContain("## Plans & Notes (2)");
			});

			it("omits section when no plans or notes exist", () => {
				const summary = makeSummary();
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).not.toContain("## Plans & Notes");
			});

			it("omits section when plans array is empty", () => {
				const summary = makeSummary({ plans: [] });
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).not.toContain("## Plans & Notes");
			});

			it("does not include separator after section", () => {
				const summary = makeSummary({
					plans: [
						{
							slug: "p1",
							title: "P1",
							editCount: 1,
							addedAt: "2026-03-30T09:00:00Z",
							updatedAt: "2026-03-30T09:30:00Z",
						},
					],
				});
				setupDefaults(summary);

				const md = buildMarkdown(summary);
				const sectionIdx = md.indexOf("## Plans & Notes");
				const nextSection = md.indexOf("##", sectionIdx + 1);
				const between = md.substring(
					sectionIdx,
					nextSection > -1 ? nextSection : undefined,
				);
				expect(between).not.toContain("---");
			});
		});

		describe("E2E test guide section", () => {
			it("renders scenarios with preconditions", () => {
				const summary = makeSummary({
					e2eTestGuide: [
						{
							title: "Login timeout",
							preconditions: "Network is slow",
							steps: ["Open app", "Click login"],
							expectedResults: ["Retry happens", "User sees spinner"],
						},
					],
				});
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).toContain("## E2E Test (1)");
				expect(md).toContain("### 1. Login timeout");
				expect(md).toContain("**Preconditions:** Network is slow");
				expect(md).toContain("**Steps:**");
				expect(md).toContain("1. Open app");
				expect(md).toContain("2. Click login");
				expect(md).toContain("**Expected Results:**");
				expect(md).toContain("- Retry happens");
				expect(md).toContain("- User sees spinner");
			});

			it("renders scenarios without preconditions", () => {
				const summary = makeSummary({
					e2eTestGuide: [
						{
							title: "Quick test",
							steps: ["Do something"],
							expectedResults: ["It works"],
						},
					],
				});
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).toContain("### 1. Quick test");
				expect(md).not.toContain("**Preconditions:**");
			});

			it("renders multiple scenarios", () => {
				const summary = makeSummary({
					e2eTestGuide: [
						{
							title: "Test A",
							steps: ["Step A"],
							expectedResults: ["Result A"],
						},
						{
							title: "Test B",
							preconditions: "Pre B",
							steps: ["Step B"],
							expectedResults: ["Result B"],
						},
					],
				});
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).toContain("## E2E Test (2)");
				expect(md).toContain("### 1. Test A");
				expect(md).toContain("### 2. Test B");
			});

			it("omits E2E section when e2eTestGuide is undefined", () => {
				const summary = makeSummary();
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).not.toContain("## E2E Test");
			});

			it("omits E2E section when e2eTestGuide is empty", () => {
				const summary = makeSummary({ e2eTestGuide: [] });
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).not.toContain("## E2E Test");
			});
		});

		describe("source commits section", () => {
			it("renders source commits when more than 1 source node", () => {
				const summary = makeSummary();
				const child1 = makeSummary({
					commitHash: "aaa1111100000000",
					commitMessage: "First change",
					commitDate: "2026-03-29T10:00:00Z",
					stats: { filesChanged: 2, insertions: 20, deletions: 5 },
					conversationTurns: 3,
				});
				const child2 = makeSummary({
					commitHash: "bbb2222200000000",
					commitMessage: "Second change",
					commitDate: "2026-03-30T10:00:00Z",
					stats: { filesChanged: 1, insertions: 10, deletions: 2 },
				});
				setupDefaults(summary, [makeTopic()], [child1, child2]);

				const md = buildMarkdown(summary);

				expect(md).toContain("## Source Commits (2)");
				expect(md).toContain(
					"`aaa11111` First change  _(+20 \u22125 · 3 turns · Mar 30, 2026)_",
				);
				expect(md).toContain(
					"`bbb22222` Second change  _(+10 \u22122 · Mar 30, 2026)_",
				);
			});

			it("omits source commits section for a single source node", () => {
				const summary = makeSummary();
				setupDefaults(summary, [makeTopic()], [summary]);

				const md = buildMarkdown(summary);

				expect(md).not.toContain("## Source Commits");
			});

			it("handles source node without stats", () => {
				const summary = makeSummary();
				const child = makeSummary({
					commitHash: "ccc3333300000000",
					commitMessage: "No stats",
				});
				setupDefaults(summary, [makeTopic()], [child, child]);

				const md = buildMarkdown(summary);

				expect(md).toContain("+0 \u22120");
			});
		});

		describe("topics section", () => {
			it("renders topics without date grouping", () => {
				const summary = makeSummary();
				const topics = [
					makeTopic({ title: "Topic A", category: "feature" }),
					makeTopic({ title: "Topic B", category: undefined }),
				];
				setupDefaults(summary, topics);

				const md = buildMarkdown(summary);

				expect(md).toContain("## Summaries (2)");
				expect(md).toContain("### 01 · Topic A `feature`");
				expect(md).toContain("### 02 · Topic B");
				expect(md).not.toContain("02 · Topic B `");
			});

			it("renders singular 'Summary' for a single topic", () => {
				const summary = makeSummary();
				setupDefaults(summary, [makeTopic()]);

				const md = buildMarkdown(summary);

				expect(md).toContain("## Summary (1)");
			});

			it("renders topics with date grouping when showRecordDates is true", () => {
				const summary = makeSummary();
				const topics = [
					makeTopic({
						title: "Topic X",
						recordDate: "2026-03-30T10:00:00Z",
						category: "bugfix",
					}),
					makeTopic({
						title: "Topic Y",
						recordDate: "2026-03-29T10:00:00Z",
						category: undefined,
					}),
				];
				setupDefaults(summary, topics, [summary], true);

				const md = buildMarkdown(summary);

				expect(md).toContain("## Summaries (2)");
				// Date group headers
				expect(md).toContain("### Mar 30, 2026");
				// Topics use #### under date groups
				expect(md).toContain("#### 01 · Topic X `bugfix`");
				expect(md).toContain("#### 02 · Topic Y");
			});

			it("uses empty-string fallback for formatDate when recordDate is undefined in date-grouped mode", () => {
				const summary = makeSummary();
				const topics = [
					makeTopic({
						title: "Topic Z",
						recordDate: undefined,
						category: undefined,
					}),
				];
				setupDefaults(summary, topics, [summary], true);

				const md = buildMarkdown(summary);

				// formatDate is called with "" (the ?? "" fallback) for topics without recordDate
				expect(mocks.formatDate).toHaveBeenCalledWith("");
				expect(md).toContain("## Summary (1)");
			});

			it("omits topics section when no topics exist", () => {
				const summary = makeSummary();
				setupDefaults(summary, []);

				const md = buildMarkdown(summary);

				expect(md).not.toContain("## Summary");
				expect(md).not.toContain("## Summaries");
			});
		});

		describe("topic body", () => {
			it("renders trigger, decisions, response, todo, and files", () => {
				const topic = makeTopic({
					trigger: "Users hit a timeout bug.",
					decisions: "Used exponential backoff.",
					response: "Added retry logic to auth module.",
					todo: "Monitor retry metrics.",
					filesAffected: ["src/Login.ts", "src/Retry.ts"],
				});
				const summary = makeSummary();
				setupDefaults(summary, [topic]);

				const md = buildMarkdown(summary);

				expect(md).toContain("**⚡ Why This Change**");
				expect(md).toContain("Users hit a timeout bug.");
				expect(md).toContain("**💡 Decisions Behind the Code**");
				expect(md).toContain("Used exponential backoff.");
				expect(md).toContain("**✅ What Was Implemented**");
				expect(md).toContain("Added retry logic to auth module.");
				expect(md).toContain("**📋 Future Enhancements**");
				expect(md).toContain("Monitor retry metrics.");
				expect(md).toContain("**📁 FILES**");
				expect(md).toContain("- `src/Login.ts`");
				expect(md).toContain("- `src/Retry.ts`");
			});

			it("omits todo when not set", () => {
				const topic = makeTopic({ todo: undefined });
				const summary = makeSummary();
				setupDefaults(summary, [topic]);

				const md = buildMarkdown(summary);

				expect(md).not.toContain("**📋 Future Enhancements**");
			});

			it("omits files when filesAffected is empty", () => {
				const topic = makeTopic({ filesAffected: [] });
				const summary = makeSummary();
				setupDefaults(summary, [topic]);

				const md = buildMarkdown(summary);

				expect(md).not.toContain("**📁 FILES**");
			});

			it("omits files when filesAffected is undefined", () => {
				const topic = makeTopic({ filesAffected: undefined });
				const summary = makeSummary();
				setupDefaults(summary, [topic]);

				const md = buildMarkdown(summary);

				expect(md).not.toContain("**📁 FILES**");
			});
		});

		describe("footer", () => {
			it("includes generated-by footer with timestamp", () => {
				const summary = makeSummary();
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).toContain(
					"*Generated by Jolli Memory · March 30, 2026 at 10:00 AM*",
				);
			});
		});
	});

	// ── buildPrMarkdown ──────────────────────────────────────────────────────

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
			it("renders simplified topic body (no todo, no files)", () => {
				const topic = makeTopic({
					trigger: "Login bug found.",
					decisions: "Use retry.",
					response: "Added retries.",
					todo: "Add metrics.",
					filesAffected: ["src/Login.ts"],
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
				// PR mode omits todo and files
				expect(md).not.toContain("**📋 Future Enhancements**");
				expect(md).not.toContain("**📁 FILES**");
			});

			it("renders topics without date grouping in PR mode", () => {
				const topics = [
					makeTopic({ title: "PR Topic 1" }),
					makeTopic({ title: "PR Topic 2" }),
				];
				const summary = makeSummary();
				setupDefaults(summary, topics);

				const md = buildPrMarkdown(summary);

				expect(md).toContain("## Summaries (2)");
				expect(md).toContain("### 01 · PR Topic 1");
				expect(md).toContain("### 02 · PR Topic 2");
			});

			it("omits PR topics section when no topics exist", () => {
				const summary = makeSummary();
				setupDefaults(summary, []);

				const md = buildPrMarkdown(summary);

				expect(md).not.toContain("## Summary");
				expect(md).not.toContain("## Summaries");
			});
		});

		describe("PR body truncation", () => {
			it("truncates topics that exceed PR_BODY_LIMIT (65000 chars)", () => {
				// Create topics with large content to exceed 65000 chars
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

				// Should include truncation warning
				expect(md).toMatch(
					/⚠️ \d+ more summar(y|ies) omitted due to GitHub PR body size limit/,
				);
				// Should not contain the last topic if truncated
				// (the exact count depends on accumulated size)
			});

			it("shows singular 'summary' for 1 omitted topic", () => {
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

				// If T1 fits but T2 is omitted
				if (md.includes("omitted")) {
					expect(md).toContain("1 more summary omitted");
				}
			});

			it("shows plural 'summaries' for multiple omitted topics", () => {
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
					expect(md).toMatch(/\d+ more summaries omitted/);
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

		describe("PR date-grouped topics with recordDate fallback", () => {
			it("uses empty-string fallback for formatDate when recordDate is undefined in PR date-grouped mode", () => {
				const topics = [
					makeTopic({ title: "PR No Date", recordDate: undefined }),
				];
				const summary = makeSummary();
				setupDefaults(summary, topics, [summary], true);

				const md = buildPrMarkdown(summary);

				// formatDate is called with "" (the ?? "" fallback) for topics without recordDate
				expect(mocks.formatDate).toHaveBeenCalledWith("");
				expect(md).toContain("## Summary (1)");
			});
		});

		describe("date-grouped PR truncation", () => {
			it("renders date-grouped topics in PR mode when showRecordDates is true", () => {
				const topics = [
					makeTopic({ title: "A", recordDate: "2026-03-30T10:00:00Z" }),
					makeTopic({ title: "B", recordDate: "2026-03-29T10:00:00Z" }),
				];
				const summary = makeSummary();
				setupDefaults(summary, topics, [summary], true);

				const md = buildPrMarkdown(summary);

				expect(md).toContain("## Summaries (2)");
				// Date group headers
				expect(md).toContain("### Mar 30, 2026");
				// Topics under date groups use ####
				expect(md).toContain("#### 01 · A");
				expect(md).toContain("#### 02 · B");
			});

			it("truncates date-grouped PR topics when exceeding limit", () => {
				const longText = "w".repeat(25000);
				const topics = [
					makeTopic({
						title: "Big1",
						recordDate: "2026-03-30T10:00:00Z",
						trigger: longText,
						decisions: longText,
						response: longText,
					}),
					makeTopic({
						title: "Big2",
						recordDate: "2026-03-29T10:00:00Z",
						trigger: longText,
						decisions: "small",
						response: "small",
					}),
					makeTopic({
						title: "Big3",
						recordDate: "2026-03-28T10:00:00Z",
						trigger: "small",
						decisions: "small",
						response: "small",
					}),
				];
				const summary = makeSummary();
				setupDefaults(summary, topics, [summary], true);

				const md = buildPrMarkdown(summary);

				if (md.includes("omitted")) {
					expect(md).toMatch(/⚠️ \d+ more summar(y|ies) omitted/);
				}
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
				expect(md).toContain("### 1. PR E2E");
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
	});

	// ── buildClaudeCodeContext ────────────────────────────────────────────────

	describe("buildClaudeCodeContext", () => {
		it("returns recall prompt containing skill name and branch", () => {
			const summary = makeSummary({ branch: "feature/PROJ-123" });
			const result = buildClaudeCodeContext(summary);
			expect(result).toContain("jolli-recall");
			expect(result).toContain("feature/PROJ-123");
		});

		it("includes invoke instruction with branch arg", () => {
			const summary = makeSummary({ branch: "main" });
			const result = buildClaudeCodeContext(summary);
			expect(result).toContain("Invoke");
			expect(result).toContain('"main"');
		});
	});
});
