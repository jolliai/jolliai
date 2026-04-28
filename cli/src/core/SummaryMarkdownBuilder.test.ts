import { describe, expect, it } from "vitest";
import type { CommitSummary } from "../Types.js";
import { buildMarkdown, buildPrMarkdown } from "./SummaryMarkdownBuilder.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function leaf(overrides: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 3,
		commitHash: "abc1234567890",
		commitMessage: "feat: add feature",
		commitAuthor: "Test User",
		commitDate: "2026-03-01T10:00:00.000Z",
		branch: "feature/proj-123-thing",
		generatedAt: "2026-03-01T10:01:00.000Z",
		stats: { filesChanged: 2, insertions: 10, deletions: 5 },
		topics: [
			{
				title: "Topic A",
				trigger: "Because of X",
				response: "Implemented Y",
				decisions: "Chose Z over W",
				todo: "Follow up with Q",
				filesAffected: ["src/main.ts", "src/util.ts"],
				category: "feature",
			},
		],
		...overrides,
	};
}

// ─── buildMarkdown ──────────────────────────────────────────────────────────

describe("buildMarkdown", () => {
	it("renders H1 with commit message", () => {
		const md = buildMarkdown(leaf());
		expect(md).toContain("# feat: add feature");
	});

	it("renders properties section with commit metadata", () => {
		const md = buildMarkdown(leaf());
		expect(md).toContain("**Commit:** `abc1234567890`");
		expect(md).toContain("**Branch:** `feature/proj-123-thing`");
		expect(md).toContain("**Author:** Test User");
		expect(md).toContain("**Changes:**");
		expect(md).toContain("2 files changed");
	});

	it("renders conversation turns when present", () => {
		const md = buildMarkdown(leaf({ conversationTurns: 5 }));
		expect(md).toContain("**Conversations:** 5 turns");
	});

	it("uses singular 'turn' for 1", () => {
		const md = buildMarkdown(leaf({ conversationTurns: 1 }));
		expect(md).toContain("1 turn");
		expect(md).not.toContain("1 turns");
	});

	it("renders Jolli Memory URL when present", () => {
		const md = buildMarkdown(leaf({ jolliDocUrl: "https://acme.jolli.app/articles?doc=42" }));
		expect(md).toContain("**Jolli Memory:**");
		expect(md).toContain("https://acme.jolli.app/articles?doc=42");
	});

	it("renders topics with all fields", () => {
		const md = buildMarkdown(leaf());
		expect(md).toContain("Topic A");
		expect(md).toContain("Because of X");
		expect(md).toContain("Implemented Y");
		expect(md).toContain("Chose Z over W");
		expect(md).toContain("Follow up with Q");
		expect(md).toContain("`src/main.ts`");
	});

	it("renders plans and notes section", () => {
		const md = buildMarkdown(
			leaf({
				plans: [
					{
						slug: "p1",
						title: "Plan One",
						editCount: 1,
						addedAt: "2026-01-01",
						updatedAt: "2026-01-01",
						jolliPlanDocUrl: "https://jolli.app/plan/1",
					},
				],
				notes: [
					{
						id: "n1",
						title: "Note One",
						format: "markdown",
						addedAt: "2026-01-01",
						updatedAt: "2026-01-01",
					},
				],
			}),
		);
		expect(md).toContain("## Plans & Notes");
		expect(md).toContain("[Plan One](https://jolli.app/plan/1)");
		expect(md).toContain("- Note One");
	});

	it("omits plans section when no plans or notes", () => {
		const md = buildMarkdown(leaf());
		expect(md).not.toContain("## Plans & Notes");
	});

	it("renders E2E test section", () => {
		const md = buildMarkdown(
			leaf({
				e2eTestGuide: [
					{
						title: "Login flow",
						preconditions: "User exists",
						steps: ["Go to login", "Enter creds"],
						expectedResults: ["Redirected to dashboard"],
					},
				],
			}),
		);
		expect(md).toContain("## E2E Test (1)");
		expect(md).toContain("### 1. Login flow");
		expect(md).toContain("**Preconditions:** User exists");
		expect(md).toContain("1. Go to login");
		expect(md).toContain("- Redirected to dashboard");
	});

	it("renders E2E test without preconditions", () => {
		const md = buildMarkdown(
			leaf({
				e2eTestGuide: [
					{
						title: "Quick test",
						steps: ["Click button"],
						expectedResults: ["Modal opens"],
					},
				],
			}),
		);
		expect(md).toContain("### 1. Quick test");
		expect(md).not.toContain("**Preconditions:**");
	});

	it("renders source commits for squash summaries", () => {
		const child1 = leaf({
			commitHash: "aaa11111111",
			commitMessage: "first commit",
			commitDate: "2026-03-01T08:00:00.000Z",
		});
		const child2 = leaf({
			commitHash: "bbb22222222",
			commitMessage: "second commit",
			commitDate: "2026-03-02T08:00:00.000Z",
		});
		// Parent is a container node with no own topics, children have the topics
		const md = buildMarkdown(leaf({ topics: [], children: [child2, child1] }));
		expect(md).toContain("## Source Commits (2)");
		expect(md).toContain("`bbb22222`");
		expect(md).toContain("second commit");
	});

	it("renders source commits with conversation turns", () => {
		const child1 = leaf({
			commitHash: "aaa11111111",
			commitMessage: "first",
			commitDate: "2026-03-01T08:00:00.000Z",
			conversationTurns: 3,
		});
		const child2 = leaf({
			commitHash: "bbb22222222",
			commitMessage: "second",
			commitDate: "2026-03-02T08:00:00.000Z",
		});
		const md = buildMarkdown(leaf({ topics: [], children: [child2, child1] }));
		expect(md).toContain("3 turns");
	});

	it("renders source commits with missing stats", () => {
		const child1 = leaf({
			commitHash: "aaa11111111",
			commitMessage: "first",
			commitDate: "2026-03-01T08:00:00.000Z",
			stats: undefined,
		});
		const child2 = leaf({
			commitHash: "bbb22222222",
			commitMessage: "second",
			commitDate: "2026-03-02T08:00:00.000Z",
		});
		const md = buildMarkdown(leaf({ topics: [], children: [child2, child1] }));
		expect(md).toContain("+0");
	});

	it("renders note with URL as a link", () => {
		const md = buildMarkdown(
			leaf({
				notes: [
					{
						id: "n1",
						title: "Note With Link",
						format: "markdown",
						addedAt: "2026-01-01",
						updatedAt: "2026-01-01",
						jolliNoteDocUrl: "https://jolli.app/note/1",
					},
				],
			}),
		);
		expect(md).toContain("[Note With Link](https://jolli.app/note/1)");
	});

	it("omits source commits for leaf nodes", () => {
		const md = buildMarkdown(leaf());
		expect(md).not.toContain("## Source Commits");
	});

	it("renders footer", () => {
		const md = buildMarkdown(leaf());
		expect(md).toContain("Generated by Jolli Memory");
	});

	it("uses singular file for 1 file changed", () => {
		const md = buildMarkdown(leaf({ stats: { filesChanged: 1, insertions: 5, deletions: 2 } }));
		expect(md).toContain("1 file changed");
		expect(md).not.toContain("1 files");
	});

	it("reads from diffStats (new data) rather than aggregating children — fixes squash over-count", () => {
		// Squash root with diffStats set (new data). Children have their own stats,
		// which if aggregated would yield filesChanged=4 (2+2). The real git diff
		// says filesChanged=1. The display must show 1.
		const squashRoot: CommitSummary = {
			...leaf(),
			stats: undefined,
			diffStats: { filesChanged: 1, insertions: 42, deletions: 5 },
			topics: undefined,
			children: [
				leaf({
					commitHash: "child1",
					stats: { filesChanged: 2, insertions: 20, deletions: 2 },
					topics: [{ title: "c1", trigger: "t", response: "r", decisions: "d" }],
				}),
				leaf({
					commitHash: "child2",
					stats: { filesChanged: 2, insertions: 22, deletions: 3 },
					topics: [{ title: "c2", trigger: "t", response: "r", decisions: "d" }],
				}),
			],
		};
		const md = buildMarkdown(squashRoot);
		expect(md).toContain("1 file changed, +42 insertions");
		expect(md).not.toContain("4 files");
	});

	it("falls back to aggregate for legacy squash root (no diffStats, no stats, has children)", () => {
		// Mimics a v3 squash root on disk today: no diffStats anywhere, no stats on
		// the container. resolveDiffStats must walk children — same as today's
		// aggregateStats — so the rendered number is pixel-identical to today.
		const legacySquashRoot: CommitSummary = {
			...leaf(),
			stats: undefined,
			diffStats: undefined,
			topics: undefined,
			children: [
				leaf({
					commitHash: "child1",
					stats: { filesChanged: 2, insertions: 20, deletions: 2 },
					topics: [{ title: "c1", trigger: "t", response: "r", decisions: "d" }],
				}),
				leaf({
					commitHash: "child2",
					stats: { filesChanged: 2, insertions: 22, deletions: 3 },
					topics: [{ title: "c2", trigger: "t", response: "r", decisions: "d" }],
				}),
			],
		};
		const md = buildMarkdown(legacySquashRoot);
		// Aggregate: 2 + 2 = 4 files, 20 + 22 = 42 insertions, 2 + 3 = 5 deletions
		expect(md).toContain("4 files changed, +42 insertions, −5 deletions");
	});

	it("Source Commits section uses each child's real diff via resolveDiffStats", () => {
		const squashRoot: CommitSummary = {
			...leaf(),
			stats: undefined,
			diffStats: { filesChanged: 2, insertions: 30, deletions: 4 },
			topics: undefined,
			children: [
				leaf({
					commitHash: "childAAA",
					commitMessage: "first",
					commitDate: "2026-03-02T10:00:00.000Z",
					stats: { filesChanged: 1, insertions: 7, deletions: 1 },
					topics: [{ title: "c1", trigger: "t", response: "r", decisions: "d" }],
				}),
				leaf({
					commitHash: "childBBB",
					commitMessage: "second",
					commitDate: "2026-03-03T10:00:00.000Z",
					stats: { filesChanged: 1, insertions: 23, deletions: 3 },
					topics: [{ title: "c2", trigger: "t", response: "r", decisions: "d" }],
				}),
			],
		};
		const md = buildMarkdown(squashRoot);
		// Each child row renders its own real diff, not aggregated
		expect(md).toContain("+7 ");
		expect(md).toContain("+23 ");
	});

	it("renders v3 squash topics as a single flat list (no date grouping)", () => {
		// Timeline grouping was removed: all topics under v4 root share the
		// root's date anyway, and v3 legacy data falls back to flat rendering
		// via the same path. This test pins the flat-list contract.
		const child1 = leaf({
			commitHash: "aaa",
			commitDate: "2026-03-01T10:00:00.000Z",
			generatedAt: "2026-03-01T10:01:00.000Z",
			topics: [{ title: "Day 1 topic", trigger: "t", response: "r", decisions: "d", category: "feature" }],
		});
		const child2 = leaf({
			commitHash: "bbb",
			commitDate: "2026-03-05T10:00:00.000Z",
			generatedAt: "2026-03-05T10:01:00.000Z",
			topics: [{ title: "Day 5 topic", trigger: "t", response: "r", decisions: "d" }],
		});
		const squash = leaf({
			commitDate: "2026-03-05T12:00:00.000Z",
			generatedAt: "2026-03-05T12:01:00.000Z",
			topics: [],
			children: [child2, child1],
		});
		const md = buildMarkdown(squash);
		// No `### Mar X, 2026` date headers under the flat model.
		expect(md).not.toMatch(/### Mar \d+, 2026/);
		// Category label is still rendered on each topic when present.
		expect(md).toContain("`feature`");
		expect(md).toContain("Day 1 topic");
		expect(md).toContain("Day 5 topic");
	});

	it("renders topic without todo or files", () => {
		const md = buildMarkdown(
			leaf({
				topics: [{ title: "Simple", trigger: "t", response: "r", decisions: "d" }],
			}),
		);
		expect(md).toContain("Simple");
		expect(md).not.toContain("Future Enhancements");
		expect(md).not.toContain("FILES");
	});

	it("renders topic with category label", () => {
		const md = buildMarkdown(
			leaf({
				topics: [{ title: "Cat topic", trigger: "t", response: "r", decisions: "d", category: "bugfix" }],
			}),
		);
		expect(md).toContain("`bugfix`");
	});

	it("renders empty summary section when no topics", () => {
		const md = buildMarkdown(leaf({ topics: [] }));
		expect(md).not.toContain("## Summary");
		expect(md).not.toContain("## Summaries");
	});

	it("uses singular 'Summary' header for single topic", () => {
		const md = buildMarkdown(leaf());
		expect(md).toContain("## Summary (1)");
	});

	it("uses plural 'Summaries' header for multiple topics", () => {
		const md = buildMarkdown(
			leaf({
				topics: [
					{ title: "A", trigger: "t", response: "r", decisions: "d" },
					{ title: "B", trigger: "t", response: "r", decisions: "d" },
				],
			}),
		);
		expect(md).toContain("## Summaries (2)");
	});
});

// ─── buildPrMarkdown ────────────────────────────────────────────────────────

describe("buildPrMarkdown", () => {
	it("includes Jolli Memory URL when present", () => {
		const md = buildPrMarkdown(leaf({ jolliDocUrl: "https://jolli.app/doc/42" }));
		expect(md).toContain("## Jolli Memory");
		expect(md).toContain("https://jolli.app/doc/42");
	});

	it("omits Jolli Memory section when URL absent", () => {
		const md = buildPrMarkdown(leaf());
		expect(md).not.toContain("## Jolli Memory");
	});

	it("renders simplified topic body (no todo or files)", () => {
		const md = buildPrMarkdown(leaf());
		expect(md).toContain("Topic A");
		expect(md).toContain("Because of X");
		expect(md).not.toContain("Future Enhancements");
		expect(md).not.toContain("FILES");
	});

	it("renders plans and E2E sections", () => {
		const md = buildPrMarkdown(
			leaf({
				plans: [{ slug: "p1", title: "My Plan", editCount: 1, addedAt: "", updatedAt: "" }],
				e2eTestGuide: [{ title: "Test", steps: ["step"], expectedResults: ["result"] }],
			}),
		);
		expect(md).toContain("## Plans & Notes");
		expect(md).toContain("## E2E Test");
	});

	it("renders footer", () => {
		const md = buildPrMarkdown(leaf());
		expect(md).toContain("Generated by Jolli Memory");
	});

	it("does not include properties or source commits sections", () => {
		const md = buildPrMarkdown(
			leaf({
				children: [leaf({ commitHash: "child1" })],
			}),
		);
		expect(md).not.toContain("**Commit:**");
		expect(md).not.toContain("## Source Commits");
	});

	it("handles truncation for large PR bodies", () => {
		// Create many topics to exceed the PR body limit
		const manyTopics = Array.from({ length: 200 }, (_, i) => ({
			title: `Topic ${i}`,
			trigger: "A".repeat(300),
			response: "B".repeat(300),
			decisions: "C".repeat(300),
		}));
		const md = buildPrMarkdown(leaf({ topics: manyTopics }));
		// Should have truncation notice
		expect(md).toContain("omitted due to GitHub PR body size limit");
	});

	it("omits summaries section when no topics exist", () => {
		const md = buildPrMarkdown(leaf({ topics: [] }));
		expect(md).not.toContain("## Summary");
		expect(md).not.toContain("## Summaries");
	});

	it("renders v3 squash topics as a flat list in PR markdown (no date grouping)", () => {
		const child1 = leaf({
			commitHash: "aaa11111111",
			commitDate: "2026-03-01T10:00:00.000Z",
			generatedAt: "2026-03-01T10:01:00.000Z",
			topics: [{ title: "Day 1 PR topic", trigger: "t1", response: "r1", decisions: "d1" }],
		});
		const child2 = leaf({
			commitHash: "bbb22222222",
			commitDate: "2026-03-05T10:00:00.000Z",
			generatedAt: "2026-03-05T10:01:00.000Z",
			topics: [{ title: "Day 5 PR topic", trigger: "t5", response: "r5", decisions: "d5" }],
		});
		const squash = leaf({
			commitDate: "2026-03-05T12:00:00.000Z",
			generatedAt: "2026-03-05T12:01:00.000Z",
			topics: [],
			children: [child2, child1],
		});
		const md = buildPrMarkdown(squash);
		expect(md).not.toMatch(/### Mar \d+, 2026/);
		expect(md).toContain("Day 1 PR topic");
		expect(md).toContain("Day 5 PR topic");
		// Should NOT contain full topic body fields (todo/files)
		expect(md).not.toContain("Future Enhancements");
		expect(md).not.toContain("FILES");
	});

	it("truncates date-grouped topics when exceeding PR body limit", () => {
		// Build two children on different days, each with many large topics.
		// generatedAt must differ per child so showRecordDates=true.
		const bigTopics = Array.from({ length: 100 }, (_, i) => ({
			title: `Big Topic ${i}`,
			trigger: "X".repeat(400),
			response: "Y".repeat(400),
			decisions: "Z".repeat(400),
		}));
		const child1 = leaf({
			commitHash: "ccc33333333",
			commitDate: "2026-04-01T10:00:00.000Z",
			generatedAt: "2026-04-01T10:01:00.000Z",
			topics: bigTopics.slice(0, 50),
		});
		const child2 = leaf({
			commitHash: "ddd44444444",
			commitDate: "2026-04-10T10:00:00.000Z",
			generatedAt: "2026-04-10T10:01:00.000Z",
			topics: bigTopics.slice(50),
		});
		const squash = leaf({
			commitDate: "2026-04-10T12:00:00.000Z",
			generatedAt: "2026-04-10T12:01:00.000Z",
			topics: [],
			children: [child2, child1],
		});
		const md = buildPrMarkdown(squash);
		expect(md).toContain("omitted due to GitHub PR body size limit");
	});

	it("uses singular omitted message when exactly 1 topic omitted", () => {
		// First topic is large but fits within the 65000-char limit;
		// second topic pushes total over the limit, resulting in exactly 1 omission.
		const topics = [
			{ title: "Big", trigger: "A".repeat(64800), response: "r", decisions: "d" },
			{ title: "Tiny overflow", trigger: "t", response: "r", decisions: "d" },
		];
		const md = buildPrMarkdown(leaf({ topics }));
		expect(md).toContain("1 more summary omitted");
	});

	it("uses singular Summary header for single topic", () => {
		const md = buildPrMarkdown(leaf());
		expect(md).toContain("## Summary (1)");
	});

	it("uses plural Summaries header for multiple topics", () => {
		const md = buildPrMarkdown(
			leaf({
				topics: [
					{ title: "A", trigger: "t", response: "r", decisions: "d" },
					{ title: "B", trigger: "t", response: "r", decisions: "d" },
				],
			}),
		);
		expect(md).toContain("## Summaries (2)");
	});
});
