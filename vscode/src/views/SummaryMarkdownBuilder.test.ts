/**
 * SummaryMarkdownBuilder tests
 *
 * Tests the clipboard-oriented `buildMarkdown` and `buildClaudeCodeContext`
 * exports. PR-specific output (`buildPrMarkdown`) lives in
 * `SummaryPrMarkdownBuilder.ts` and has its own test file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	aggregateStats: vi.fn(),
	aggregateTurns: vi.fn(),
	formatDurationLabel: vi.fn(),
	// resolveDiffStats: new helper that prefers node.diffStats (new data) and
	// falls back to aggregateStats (legacy path). Tests that previously set up
	// aggregateStats return values keep working without change.
	resolveDiffStats: vi.fn(),
	collectSortedTopics: vi.fn(),
	formatDate: vi.fn(),
	formatFullDate: vi.fn(),
	// Mirrors real SummaryFormat.formatProviderLabel: reads llm.source and maps
	// it to a display label. Tests that verify the footer "· via Anthropic"
	// segment depend on this returning the right label, not undefined.
	formatProviderLabel: vi.fn((summary: { llm?: { source?: string } }) => {
		const labels: Record<string, string> = {
			"anthropic-config": "Anthropic",
			"anthropic-env": "Anthropic (env)",
			"jolli-proxy": "Jolli proxy",
		};
		const src = summary?.llm?.source;
		return src ? (labels[src] ?? undefined) : undefined;
	}),
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
	formatProviderLabel: mocks.formatProviderLabel,
	getDisplayDate: mocks.getDisplayDate,
	padIndex: mocks.padIndex,
}));

import type { CommitSummary } from "../../../cli/src/Types.js";
import {
	buildClaudeCodeContext,
	buildMarkdown,
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
		branch: "feature/proj-100-login",
		generatedAt: "2026-03-30T10:05:00Z",
		// Default stats match commonSetup's aggregateStats return value, so the
		// resolveDiffStats mock can read node.stats directly for the header case.
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
	// resolveDiffStats is the new canonical display-stats helper. Mirrors the
	// real implementation's fallback: node.diffStats → node.stats → zeros.
	// Leaves without stats render as +0 −0, matching the old production code
	// path (which read `node.stats?.insertions ?? 0` directly).
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
				expect(md).toContain("- **Branch:** `feature/proj-100-login`");
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
				mocks.resolveDiffStats.mockReturnValue({
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

			it("renders linear issues with ticketId-prefixed title and upstream URL", () => {
				// Captured during QueueWorker's associateLinearIssuesWithCommit,
				// these end up in summary.linearIssues[]. PR-readers expect to be
				// able to grep "PROJ-1528" out of the description, so ticketId
				// must lead the bullet (not just the title).
				const summary = makeSummary({
					references: [
						{
							archivedKey: "linear:PROJ-1528-786c5330",
							source: "linear",
							nativeId: "PROJ-1528",
							title:
								"Treat referenced Linear issues as a first-class panel item",
							url: "https://linear.app/jolliai/issue/PROJ-1528/treat-referenced-linear-issues-as-a-first-class-panel-item-and",
							referencedAt: "2026-05-14T09:11:43.708Z",
							sourceToolName: "mcp__linear__get_issue",
						},
					],
				});
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).toContain("## Plans & Notes");
				expect(md).toContain(
					"- [PROJ-1528 — Treat referenced Linear issues as a first-class panel item](https://linear.app/jolliai/issue/PROJ-1528/treat-referenced-linear-issues-as-a-first-class-panel-item-and)",
				);
			});

			it("escapes untrusted reference title/url so a crafted entry cannot inject a markdown link into the PR body", () => {
				// title/url come from external trackers (attacker-controlled). A
				// title with `](…)` must not break out of the link text, and a url
				// with `)` / spaces must not close the link early or be reparsed
				// as a link title.
				const summary = makeSummary({
					references: [
						{
							archivedKey: "jira:KAN-9-bbbb2222",
							source: "jira",
							nativeId: "KAN-9",
							title: "Fix login](https://phish.example) click [here",
							url: "https://evil.example/x)/path with space",
							referencedAt: "2026-05-14T09:11:43.708Z",
							sourceToolName: "mcp__claude_ai_Atlassian__getJiraIssue",
						},
					],
				});
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				// `[` / `]` in the title are backslash-escaped — no link break-out.
				expect(md).toContain("Fix login\\]");
				expect(md).toContain("click \\[here");
				expect(md).not.toContain("login](https://phish.example)");
				// `)` and space in the url are percent-encoded — target stays intact.
				expect(md).toContain("https://evil.example/x%29/path%20with%20space");
				expect(md).not.toContain("x)/path with space");
			});

			it("includes linear-issue count in the section header alongside plans/notes", () => {
				const summary = makeSummary({
					plans: [
						{
							slug: "p1",
							title: "P1",
							addedAt: "2026-03-30T09:00:00Z",
							updatedAt: "2026-03-30T09:30:00Z",
						},
					],
					references: [
						{
							archivedKey: "linear:PROJ-1-aaaa1111",
							source: "linear",
							nativeId: "PROJ-1",
							title: "Linear A",
							url: "https://linear.app/x/issue/PROJ-1/a",
							referencedAt: "2026-05-14T09:11:43.708Z",
							sourceToolName: "mcp__linear__get_issue",
						},
						{
							archivedKey: "linear:PROJ-2-aaaa1111",
							source: "linear",
							nativeId: "PROJ-2",
							title: "Linear B",
							url: "https://linear.app/x/issue/PROJ-2/b",
							referencedAt: "2026-05-14T09:11:43.708Z",
							sourceToolName: "mcp__linear__get_issue",
						},
					],
				});
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				// 1 plan + 0 notes + 2 linear = 3 total — header carries the count.
				expect(md).toContain("## Plans & Notes (3)");
			});

			it("renders section with linear issues alone (no plans, no notes)", () => {
				// Until this change the section would be omitted entirely when
				// plans/notes were both empty; now linear issues alone are
				// enough to surface the section.
				const summary = makeSummary({
					references: [
						{
							archivedKey: "linear:PROJ-1-aaaa1111",
							source: "linear",
							nativeId: "PROJ-1",
							title: "Solo",
							url: "https://linear.app/x/issue/PROJ-1/solo",
							referencedAt: "2026-05-14T09:11:43.708Z",
							sourceToolName: "mcp__linear__get_issue",
						},
					],
				});
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).toContain("## Plans & Notes");
				expect(md).toContain(
					"- [PROJ-1 — Solo](https://linear.app/x/issue/PROJ-1/solo)",
				);
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

			it("renders summary.entities (v5+) across multiple sources in deterministic order", () => {
				// Order in input: jira, notion, linear, github — must come out as
				// linear → jira → github → notion per REFERENCE_SOURCE_ORDER. Each
				// bullet uses `nativeId — title` (URL = upstream).
				const summary = makeSummary({
					references: [
						{
							archivedKey: "jira:KAN-5-aaaa1111",
							source: "jira",
							nativeId: "KAN-5",
							title: "Jira ticket",
							url: "https://example.atlassian.net/browse/KAN-5",
							referencedAt: "2026-05-14T09:11:43.708Z",
							sourceToolName: "mcp__claude_ai_Atlassian__getJiraIssue",
						},
						{
							archivedKey: "notion:abcdef12-aaaa1111",
							source: "notion",
							nativeId: "abcdef12",
							title: "Notion page",
							url: "https://notion.so/abcdef12",
							referencedAt: "2026-05-14T09:11:43.708Z",
							sourceToolName: "mcp__claude_ai_Notion__notion-fetch",
						},
						{
							archivedKey: "linear:PROJ-1-aaaa1111",
							source: "linear",
							nativeId: "PROJ-1",
							title: "Linear ticket",
							url: "https://linear.app/x/issue/PROJ-1/linear-ticket",
							referencedAt: "2026-05-14T09:11:43.708Z",
							sourceToolName: "mcp__linear__get_issue",
						},
						{
							archivedKey: "github:owner/repo#42-aaaa1111",
							source: "github",
							nativeId: "owner/repo#42",
							title: "GitHub issue",
							url: "https://github.com/owner/repo/issues/42",
							referencedAt: "2026-05-14T09:11:43.708Z",
							sourceToolName: "mcp__github__issue_read",
						},
					],
				});
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				const idxLinear = md.indexOf("PROJ-1 — Linear ticket");
				const idxJira = md.indexOf("KAN-5 — Jira ticket");
				const idxGithub = md.indexOf("owner/repo#42 — GitHub issue");
				const idxNotion = md.indexOf("abcdef12 — Notion page");
				expect(idxLinear).toBeGreaterThan(-1);
				expect(idxJira).toBeGreaterThan(idxLinear);
				expect(idxGithub).toBeGreaterThan(idxJira);
				expect(idxNotion).toBeGreaterThan(idxGithub);
				expect(md).toContain("## Plans & Notes (4)");
			});

			it("renders source-prefixed references with archivedKey using the canonical layout", () => {
				const summary = makeSummary({
					references: [
						{
							archivedKey: "linear:PROJ-1-aaaa1111",
							source: "linear",
							nativeId: "PROJ-1",
							title: "From references",
							url: "https://linear.app/x/issue/PROJ-1/from-references",
							referencedAt: "2026-05-14T09:11:43.708Z",
							sourceToolName: "mcp__linear__get_issue",
						},
					],
				});
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).toContain("PROJ-1 — From references");
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
				// Explicitly clear the default stats so the child is truly stats-less \u2014
				// mirrors legacy data where a leaf's stats field was never written.
				const child = makeSummary({
					commitHash: "ccc3333300000000",
					commitMessage: "No stats",
					stats: undefined,
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

				expect(md).toContain("## Topics (2)");
				expect(md).toContain("### 01 · Topic A `feature`");
				expect(md).toContain("### 02 · Topic B");
				expect(md).not.toContain("02 · Topic B `");
			});

			it("renders singular 'Topic' for a single topic", () => {
				const summary = makeSummary();
				setupDefaults(summary, [makeTopic()]);

				const md = buildMarkdown(summary);

				expect(md).toContain("## Topic (1)");
			});

			it("renders multiple topics as a flat list (no date grouping)", () => {
				// Timeline grouping was removed: topics now render as a flat list
				// regardless of source-commit count or date span. Date headers
				// (### Mar 30, 2026) must NOT appear; topics use ### at H3 directly.
				const summary = makeSummary();
				const topics = [
					makeTopic({
						title: "Topic X",
						commitDate: "2026-03-30T10:00:00Z",
						category: "bugfix",
					}),
					makeTopic({
						title: "Topic Y",
						commitDate: "2026-03-29T10:00:00Z",
						category: undefined,
					}),
				];
				setupDefaults(summary, topics, [summary]);

				const md = buildMarkdown(summary);

				expect(md).toContain("## Topics (2)");
				expect(md).not.toMatch(/^### Mar \d+, 2026/m);
				expect(md).toContain("### 01 · Topic X `bugfix`");
				expect(md).toContain("### 02 · Topic Y");
			});

			it("omits topics section when no topics exist", () => {
				const summary = makeSummary();
				setupDefaults(summary, []);

				const md = buildMarkdown(summary);

				expect(md).not.toContain("## Topic");
				expect(md).not.toContain("## Topics");
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

			it("appends `· via Anthropic` when the summary's llm metadata carries an anthropic source", () => {
				const summary = makeSummary({
					llm: {
						model: "sonnet",
						inputTokens: 0,
						outputTokens: 0,
						apiLatencyMs: 0,
						stopReason: "end_turn",
						source: "anthropic-config",
					},
				});
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).toContain(
					"*Generated by Jolli Memory · March 30, 2026 at 10:00 AM · via Anthropic*",
				);
			});

			it("appends `· via Jolli proxy` when the summary's llm metadata carries a jolli-proxy source", () => {
				const summary = makeSummary({
					llm: {
						model: "sonnet",
						inputTokens: 0,
						outputTokens: 0,
						apiLatencyMs: 0,
						stopReason: "end_turn",
						source: "jolli-proxy",
					},
				});
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).toContain(
					"*Generated by Jolli Memory · March 30, 2026 at 10:00 AM · via Jolli proxy*",
				);
			});

			it("falls back to the two-segment footer for legacy summaries without llm.source", () => {
				const summary = makeSummary();
				setupDefaults(summary);

				const md = buildMarkdown(summary);

				expect(md).not.toContain("via");
				expect(md).toContain(
					"*Generated by Jolli Memory · March 30, 2026 at 10:00 AM*",
				);
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
