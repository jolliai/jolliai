/**
 * SummaryPrAggregateMarkdownBuilder tests
 *
 * Builds aggregated PR markdown for multi-summary branches. Uses the real
 * single-summary helpers (`SummaryPrMarkdownBuilder`, `SummaryMarkdownBuilder`)
 * — only the core SummaryFormat helpers (`collectSortedTopics`, `padIndex`,
 * `formatFullDate`, `getDisplayDate`) are mocked, matching the pattern used
 * by `SummaryPrMarkdownBuilder.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	CommitSummary,
	E2eTestScenario,
	NoteReference,
	PlanReference,
	TopicSummary,
} from "../../../cli/src/Types.js";

const mocks = vi.hoisted(() => ({
	collectSortedTopics: vi.fn(),
	formatFullDate: vi.fn(() => "2026-05-06 00:00:00 UTC"),
	getDisplayDate: vi.fn(
		(e: { generatedAt?: string; commitDate: string }) =>
			e.generatedAt || e.commitDate,
	),
	padIndex: vi.fn((i: number) => String(i + 1).padStart(2, "0")),
	formatDate: vi.fn(),
	aggregateStats: vi.fn(),
	aggregateTurns: vi.fn(),
	formatDurationLabel: vi.fn(),
	resolveDiffStats: vi.fn(),
}));

vi.mock("../../../cli/src/core/SummaryFormat.js", () => ({
	collectSortedTopics: mocks.collectSortedTopics,
	formatFullDate: mocks.formatFullDate,
	getDisplayDate: mocks.getDisplayDate,
	padIndex: mocks.padIndex,
	formatDate: mocks.formatDate,
}));

vi.mock("../../../cli/src/core/SummaryTree.js", () => ({
	aggregateStats: mocks.aggregateStats,
	aggregateTurns: mocks.aggregateTurns,
	formatDurationLabel: mocks.formatDurationLabel,
	resolveDiffStats: mocks.resolveDiffStats,
}));

import { buildAggregatedPrMarkdown } from "./SummaryPrAggregateMarkdownBuilder.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────

interface SummaryOpts {
	hash: string;
	message?: string;
	recap?: string;
	jolliDocUrl?: string;
	plans?: ReadonlyArray<PlanReference>;
	notes?: ReadonlyArray<NoteReference>;
	e2eTestGuide?: ReadonlyArray<E2eTestScenario>;
	topics?: ReadonlyArray<TopicSummary>;
}

function makeSummary(opts: SummaryOpts): CommitSummary {
	return {
		version: 3,
		commitHash: opts.hash,
		commitMessage: opts.message ?? `commit-${opts.hash.substring(0, 7)}`,
		commitAuthor: "tester",
		commitDate: "2026-05-06T00:00:00Z",
		generatedAt: "2026-05-06T00:00:00Z",
		branch: "feature/x",
		stats: { filesChanged: 1, insertions: 1, deletions: 0 },
		recap: opts.recap,
		jolliDocUrl: opts.jolliDocUrl,
		plans: opts.plans,
		notes: opts.notes,
		e2eTestGuide: opts.e2eTestGuide,
		topics: opts.topics,
	} as unknown as CommitSummary;
}

function makeTopic(overrides: Partial<TopicSummary> = {}): TopicSummary {
	return {
		title: "Topic title",
		trigger: "Trigger text",
		response: "Response text",
		decisions: "Decisions text",
		todo: "Todo text",
		filesAffected: ["src/file.ts"],
		category: "feature",
		importance: "major",
		...overrides,
	};
}

function makeScenario(
	overrides: Partial<E2eTestScenario> = {},
): E2eTestScenario {
	return {
		title: "Scenario title",
		preconditions: "Preconditions text",
		steps: ["Step one", "Step two"],
		expectedResults: ["Expect one"],
		...overrides,
	};
}

beforeEach(() => {
	// Default: no topics in any summary unless test overrides.
	mocks.collectSortedTopics.mockReturnValue({ topics: [], sourceNodes: [] });
});

afterEach(() => {
	vi.clearAllMocks();
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("buildAggregatedPrMarkdown", () => {
	it("throws when summaries.length < 2 (precondition for caller routing)", () => {
		expect(() =>
			buildAggregatedPrMarkdown([makeSummary({ hash: "AAAA1234" })], 0),
		).toThrow(/summaries.length >= 2/);
		expect(() => buildAggregatedPrMarkdown([], 0)).toThrow(
			/summaries.length >= 2/,
		);
	});

	it("renders top directory header as (M) when missingCount === 0", () => {
		const summaries = [
			makeSummary({ hash: "AAAA1234", message: "feat: add X" }),
			makeSummary({ hash: "BBBB5678", message: "fix: handle Y" }),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		expect(md).toContain("## Commits in this PR (2)");
		expect(md).not.toContain("of");
		expect(md).toMatch(/1\. feat: add X \(`AAAA123`\)/);
		expect(md).toMatch(/2\. fix: handle Y \(`BBBB567`\)/);
	});

	it("renders top directory header as (M of N) when missingCount > 0", () => {
		const summaries = [
			makeSummary({ hash: "AAAA1234" }),
			makeSummary({ hash: "BBBB5678" }),
			makeSummary({ hash: "CCCC9012" }),
		];
		const md = buildAggregatedPrMarkdown(summaries, 2);
		expect(md).toContain("## Commits in this PR (3 of 5)");
		expect(md).toContain("> Note: 2 commit(s) without summary were skipped.");
	});

	it("appends [Memory](url) link when jolliDocUrl is set; omits otherwise", () => {
		const summaries = [
			makeSummary({
				hash: "AAAA1234",
				message: "with url",
				jolliDocUrl: "https://jolli.example/articles?doc=1",
			}),
			makeSummary({ hash: "BBBB5678", message: "no url" }),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		expect(md).toContain(
			"1. with url (`AAAA123`) — [Memory](https://jolli.example/articles?doc=1)",
		);
		expect(md).toContain("2. no url (`BBBB567`)");
		// No spurious — [Memory]( on the no-url line.
		expect(md).not.toMatch(/no url \(`BBBB567`\) — \[Memory\]/);
	});

	it("dedupes plans across commits using jolliPlanDocUrl ?? slug:<slug>", () => {
		// Same plan referenced by two commits; one entry has URL, one doesn't.
		// Both should dedupe via the slug fallback because URL key differs.
		const planA1: PlanReference = {
			slug: "feature-a",
			title: "Feature A",
			editCount: 3,
			addedAt: "2026-05-01T00:00:00Z",
			updatedAt: "2026-05-02T00:00:00Z",
			jolliPlanDocUrl: "https://jolli.example/articles?doc=10",
		};
		// Note: A2 has the SAME slug+URL → duplicates by URL.
		const planA2: PlanReference = { ...planA1 };
		// planB is a separate plan entirely.
		const planB: PlanReference = {
			slug: "feature-b",
			title: "Feature B",
			editCount: 1,
			addedAt: "2026-05-03T00:00:00Z",
			updatedAt: "2026-05-03T00:00:00Z",
		};
		const summaries = [
			makeSummary({ hash: "AAAA1234", plans: [planA1, planB] }),
			makeSummary({ hash: "BBBB5678", plans: [planA2] }),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		// Plans & Notes header includes total count = 2 (deduped)
		expect(md).toContain("## Plans & Notes (2)");
		// Only one entry per dedup key
		expect(md.match(/Feature A/g)?.length).toBe(1);
		expect(md.match(/Feature B/g)?.length).toBe(1);
	});

	it("dedupes plans by slug when neither has a URL", () => {
		const draftA1: PlanReference = {
			slug: "draft-x",
			title: "Draft X",
			editCount: 1,
			addedAt: "2026-05-01T00:00:00Z",
			updatedAt: "2026-05-01T00:00:00Z",
		};
		const draftA2: PlanReference = { ...draftA1, editCount: 2 }; // same slug, no URL
		const summaries = [
			makeSummary({ hash: "AAAA1234", plans: [draftA1] }),
			makeSummary({ hash: "BBBB5678", plans: [draftA2] }),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		expect(md.match(/Draft X/g)?.length).toBe(1);
	});

	it("dedupes notes by jolliNoteDocUrl ?? id:<id>", () => {
		const noteA1: NoteReference = {
			id: "note-1",
			title: "Note 1",
			format: "markdown",
			addedAt: "2026-05-01T00:00:00Z",
			updatedAt: "2026-05-01T00:00:00Z",
			jolliNoteDocUrl: "https://jolli.example/articles?doc=20",
		};
		const noteA2: NoteReference = { ...noteA1 }; // same URL → dedup
		const noteB: NoteReference = {
			id: "note-2",
			title: "Note 2",
			format: "markdown",
			addedAt: "2026-05-01T00:00:00Z",
			updatedAt: "2026-05-01T00:00:00Z",
		};
		const summaries = [
			makeSummary({ hash: "AAAA1234", notes: [noteA1, noteB] }),
			makeSummary({ hash: "BBBB5678", notes: [noteA2] }),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		expect(md.match(/Note 1/g)?.length).toBe(1);
		expect(md.match(/Note 2/g)?.length).toBe(1);
	});

	it("emits Quick recap blocks only for commits with non-empty recap, header carries the (N) count", () => {
		const summaries = [
			makeSummary({
				hash: "AAAA1234",
				message: "first",
				recap: "First recap content.",
			}),
			makeSummary({ hash: "BBBB5678", message: "second" }), // no recap
			makeSummary({
				hash: "CCCC9012",
				message: "third",
				recap: "Third recap content.",
			}),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		// Header matches single-summary "## Quick recap" + (N) count style.
		expect(md).toContain("## Quick recap (2)");
		expect(md).not.toContain("## Per-Commit Recap");
		expect(md).toContain("### Commit 1 of 3: first (`AAAA123`)");
		expect(md).toContain("First recap content.");
		expect(md).not.toContain("### Commit 2 of 3:");
		expect(md).toContain("### Commit 3 of 3: third (`CCCC901`)");
		expect(md).toContain("Third recap content.");
	});

	it("omits Quick recap section entirely when no commit has a recap", () => {
		const summaries = [
			makeSummary({ hash: "AAAA1234" }),
			makeSummary({ hash: "BBBB5678" }),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		expect(md).not.toContain("## Quick recap");
		expect(md).not.toContain("## Per-Commit Recap");
	});

	it("flattens E2E scenarios across commits with [shortHash] prefix", () => {
		const summaries = [
			makeSummary({
				hash: "AAAA1234",
				e2eTestGuide: [
					makeScenario({ title: "Login flow" }),
					makeScenario({ title: "Logout flow" }),
				],
			}),
			makeSummary({
				hash: "BBBB5678",
				e2eTestGuide: [makeScenario({ title: "Session expiry" })],
			}),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		expect(md).toContain("## E2E Test (3)");
		expect(md).toContain("1. [AAAA123] Login flow");
		expect(md).toContain("2. [AAAA123] Logout flow");
		expect(md).toContain("3. [BBBB567] Session expiry");
	});

	it("omits E2E section when no commit has scenarios", () => {
		const summaries = [
			makeSummary({ hash: "AAAA1234" }),
			makeSummary({ hash: "BBBB5678" }),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		expect(md).not.toContain("## E2E Test");
	});

	it("flattens topics across commits with [shortHash] prefix using padIndex", () => {
		const sA = makeSummary({ hash: "AAAA1234" });
		const sB = makeSummary({ hash: "BBBB5678" });
		// collectSortedTopics is mocked: return per-summary topics in insertion order
		mocks.collectSortedTopics.mockImplementation((s: CommitSummary) => {
			if (s.commitHash === "AAAA1234") {
				return {
					topics: [makeTopic({ title: "T-A1" }), makeTopic({ title: "T-A2" })],
					sourceNodes: [],
				};
			}
			return {
				topics: [makeTopic({ title: "T-B1" })],
				sourceNodes: [],
			};
		});
		const md = buildAggregatedPrMarkdown([sA, sB], 0);
		expect(md).toContain("## Topics (3)");
		// padIndex mock returns 01, 02, 03
		expect(md).toContain("01 · [AAAA123] T-A1");
		expect(md).toContain("02 · [AAAA123] T-A2");
		expect(md).toContain("03 · [BBBB567] T-B1");
	});

	it("uses 'Topic' (singular) header when exactly 1 topic across all commits", () => {
		mocks.collectSortedTopics.mockImplementation((s: CommitSummary) => {
			if (s.commitHash === "AAAA1234") {
				return {
					topics: [makeTopic({ title: "Only topic" })],
					sourceNodes: [],
				};
			}
			return { topics: [], sourceNodes: [] };
		});
		const md = buildAggregatedPrMarkdown(
			[makeSummary({ hash: "AAAA1234" }), makeSummary({ hash: "BBBB5678" })],
			0,
		);
		expect(md).toContain("## Topic (1)");
		expect(md).not.toContain("## Topics");
	});

	it("preserves intra-commit topic order under chronological commit order", () => {
		mocks.collectSortedTopics.mockImplementation((s: CommitSummary) => {
			if (s.commitHash === "AAAA1234") {
				return {
					topics: [makeTopic({ title: "T-1" }), makeTopic({ title: "T-2" })],
					sourceNodes: [],
				};
			}
			return {
				topics: [makeTopic({ title: "T-3" }), makeTopic({ title: "T-4" })],
				sourceNodes: [],
			};
		});
		const md = buildAggregatedPrMarkdown(
			[makeSummary({ hash: "AAAA1234" }), makeSummary({ hash: "BBBB5678" })],
			0,
		);
		const idxT1 = md.indexOf("T-1");
		const idxT2 = md.indexOf("T-2");
		const idxT3 = md.indexOf("T-3");
		const idxT4 = md.indexOf("T-4");
		expect(idxT1).toBeLessThan(idxT2);
		expect(idxT2).toBeLessThan(idxT3);
		expect(idxT3).toBeLessThan(idxT4);
	});

	it("appends missing-summary footnote only when missingCount > 0", () => {
		const summaries = [
			makeSummary({ hash: "AAAA1234" }),
			makeSummary({ hash: "BBBB5678" }),
		];
		expect(buildAggregatedPrMarkdown(summaries, 0)).not.toContain(
			"without summary were skipped",
		);
		expect(buildAggregatedPrMarkdown(summaries, 1)).toContain(
			"> Note: 1 commit(s) without summary were skipped.",
		);
		expect(buildAggregatedPrMarkdown(summaries, 4)).toContain(
			"> Note: 4 commit(s) without summary were skipped.",
		);
	});

	it("truncates Topics at 65K and emits an omitted footnote", () => {
		// Build many large topics to force truncation
		const bigText = "x".repeat(2500);
		const bigTopics = Array.from({ length: 40 }, (_, i) =>
			makeTopic({
				title: `T-${i}`,
				trigger: bigText,
				response: bigText,
				decisions: bigText,
			}),
		);
		mocks.collectSortedTopics.mockImplementation((s: CommitSummary) => {
			if (s.commitHash === "AAAA1234") {
				return { topics: bigTopics, sourceNodes: [] };
			}
			return { topics: [], sourceNodes: [] };
		});
		const md = buildAggregatedPrMarkdown(
			[makeSummary({ hash: "AAAA1234" }), makeSummary({ hash: "BBBB5678" })],
			0,
		);
		expect(md).toMatch(
			/> ⚠️ \d+ more topics? omitted due to GitHub PR body size limit\./,
		);
		expect(md.length).toBeLessThan(65_500);
	});

	it("truncates E2E at 60K and emits an omitted footnote", () => {
		const bigText = "y".repeat(3000);
		const bigScenarios = Array.from({ length: 30 }, (_, i) =>
			makeScenario({
				title: `Sc-${i}`,
				preconditions: bigText,
				steps: [bigText, bigText],
				expectedResults: [bigText],
			}),
		);
		const summaries = [
			makeSummary({ hash: "AAAA1234", e2eTestGuide: bigScenarios }),
			makeSummary({ hash: "BBBB5678" }),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		expect(md).toMatch(
			/> ⚠️ \d+ more scenarios? omitted due to GitHub PR body size limit\./,
		);
	});

	it("truncates Per-Commit Recap at 50K and emits an omitted footnote", () => {
		const bigRecap = "z".repeat(20000);
		// 5 commits, each with a 20K recap → triggers the 50K soft limit.
		const summaries = Array.from({ length: 5 }, (_, i) =>
			makeSummary({
				hash: `AAAA${String(i).padStart(4, "0")}`,
				message: `commit-${i}`,
				recap: bigRecap,
			}),
		);
		const md = buildAggregatedPrMarkdown(summaries, 0);
		expect(md).toMatch(
			/> ⚠️ \d+ more commits?'? recap omitted due to GitHub PR body size limit\./,
		);
	});

	it("uses singular possessive 'commit's' when exactly one recap is omitted", () => {
		// Two small recaps fit, then one giant recap pushes past the 50K Recap
		// soft-limit alone — exactly 1 truncated.
		const summaries = [
			makeSummary({ hash: "AAAA1234", recap: "small recap A" }),
			makeSummary({ hash: "BBBB5678", recap: "small recap B" }),
			makeSummary({ hash: "CCCC9012", recap: "z".repeat(60000) }),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		expect(md).toContain("1 more commit's recap omitted");
		// Make sure it's not the plural form.
		expect(md).not.toMatch(/[02-9] more commits' recap omitted/);
	});

	it("uses plural possessive 'commits'' when 2+ recaps are omitted", () => {
		// First recap (~40K) fits; the next two (45K each) push past the 50K
		// Recap soft-limit, so both are omitted.
		const summaries = [
			makeSummary({ hash: "AAAA1234", recap: "z".repeat(40000) }),
			makeSummary({ hash: "BBBB5678", recap: "z".repeat(45000) }),
			makeSummary({ hash: "CCCC9012", recap: "z".repeat(45000) }),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		expect(md).toMatch(/2 more commits' recap omitted/);
		// And none of the singular form should appear.
		expect(md).not.toContain("commit's recap omitted");
	});

	it("does not produce adjacent '---' separators when Topics is absent", () => {
		// Recap + E2E present, Topics absent. Earlier impl emitted trailing '---'
		// in both Recap and E2E, then footer added another '---', causing
		// '---\n\n---' adjacency. Layout fix: only footer emits the final rule.
		const summaries = [
			makeSummary({
				hash: "AAAA1234",
				recap: "first recap",
				e2eTestGuide: [makeScenario({ title: "S1" })],
			}),
			makeSummary({
				hash: "BBBB5678",
				recap: "second recap",
				e2eTestGuide: [makeScenario({ title: "S2" })],
			}),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		expect(md).not.toMatch(/---\s*\n\s*---/);
	});

	it("never exceeds GitHub's 65536-char body limit even with markers + missing footnote + maxed sections", () => {
		// Pile content into all three truncating sections + missingCount > 0
		// to stress-test the 64500 internal budget against the 65536 hard cap.
		const bigText = "x".repeat(2500);
		const bigTopics = Array.from({ length: 60 }, (_, i) =>
			makeTopic({
				title: `T-${i}`,
				trigger: bigText,
				response: bigText,
				decisions: bigText,
			}),
		);
		const bigScenarios = Array.from({ length: 30 }, (_, i) =>
			makeScenario({
				title: `Sc-${i}`,
				preconditions: bigText,
				steps: [bigText, bigText],
				expectedResults: [bigText],
			}),
		);
		const bigRecap = "z".repeat(15000);
		mocks.collectSortedTopics.mockImplementation((s: CommitSummary) => {
			if (s.commitHash === "AAAA1234")
				return { topics: bigTopics, sourceNodes: [] };
			return { topics: [], sourceNodes: [] };
		});
		const summaries = [
			makeSummary({
				hash: "AAAA1234",
				recap: bigRecap,
				e2eTestGuide: bigScenarios,
			}),
			makeSummary({ hash: "BBBB5678", recap: bigRecap }),
			makeSummary({ hash: "CCCC9012", recap: bigRecap }),
		];
		const md = buildAggregatedPrMarkdown(summaries, 4);
		// Simulate caller wrapping with markers (adds ~80 chars).
		const wrapped = `<!-- jollimemory-summary-start -->\n${md}\n<!-- jollimemory-summary-end -->`;
		expect(wrapped.length).toBeLessThanOrEqual(65536);
	});

	it("strips backticks from commit messages in the directory header (no triple-backtick injection)", () => {
		const summaries = [
			makeSummary({
				hash: "AAAA1234",
				message: "fix `foo` and `bar`", // contains backticks
			}),
			makeSummary({ hash: "BBBB5678", message: "ok" }),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		// No raw backtick from the message should land in the directory line —
		// the only backticks on directory lines come from the (`shortHash`)
		// inline code-span. Verify there's no triple-backtick anywhere.
		expect(md).not.toContain("```");
		// And the message text retains the words minus the offending characters.
		expect(md).toContain("fix foo and bar");
	});

	it("renders an E2E scenario without preconditions (omits the **Preconditions:** line)", () => {
		const summaries = [
			makeSummary({
				hash: "AAAA1234",
				e2eTestGuide: [
					{
						title: "No-precondition scenario",
						steps: ["Step 1"],
						expectedResults: ["Expected"],
					},
				],
			}),
			makeSummary({ hash: "BBBB5678" }),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		expect(md).toContain("No-precondition scenario");
		// E2E body should not include the Preconditions header when not provided.
		// (Other scenarios across other tests do include it.)
		const e2eBlockMatch = md.match(
			/\[AAAA123\] No-precondition scenario[\s\S]*?<\/details>/,
		);
		expect(e2eBlockMatch).not.toBeNull();
		expect(e2eBlockMatch?.[0]).not.toContain("**Preconditions:**");
	});

	it("uses singular 'scenario' (no plural 's') when exactly 1 E2E scenario is omitted", () => {
		// One small scenario fits; one giant scenario overflows the 60K budget
		// alone. omitted == 1 deterministically.
		const tiny = makeScenario({ title: "Tiny" });
		const giant = makeScenario({
			title: "Giant",
			preconditions: "z".repeat(50000),
			steps: ["z".repeat(20000)],
			expectedResults: ["z".repeat(20000)],
		});
		const summaries = [
			makeSummary({ hash: "AAAA1234", e2eTestGuide: [tiny, giant] }),
			makeSummary({ hash: "BBBB5678" }),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		expect(md).toContain("1 more scenario omitted");
		expect(md).not.toContain("scenarios omitted");
	});

	it("uses singular 'topic' (no plural 's') when exactly 1 topic is omitted", () => {
		// One small topic fits; one giant topic overflows alone → omitted=1.
		const smallTopic = makeTopic({ title: "Tiny" });
		const giantTrigger = "x".repeat(70000); // alone > PR_BODY_LIMIT
		const giantTopic = makeTopic({
			title: "Giant",
			trigger: giantTrigger,
			response: giantTrigger,
			decisions: giantTrigger,
		});
		mocks.collectSortedTopics.mockImplementation((s: CommitSummary) => {
			if (s.commitHash === "AAAA1234") {
				return { topics: [smallTopic, giantTopic], sourceNodes: [] };
			}
			return { topics: [], sourceNodes: [] };
		});
		const md = buildAggregatedPrMarkdown(
			[makeSummary({ hash: "AAAA1234" }), makeSummary({ hash: "BBBB5678" })],
			0,
		);
		expect(md).toContain("1 more topic omitted");
		expect(md).not.toContain("topics omitted");
	});

	it("does not strip backticks from non-directory sections (recap rendering preserves them)", () => {
		const summaries = [
			makeSummary({
				hash: "AAAA1234",
				message: "ok msg",
				recap: "Use the `foo()` API to bar.",
			}),
			makeSummary({ hash: "BBBB5678", message: "ok msg2" }),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		expect(md).toContain("Use the `foo()` API to bar.");
	});

	it("ends with the standard footer", () => {
		const md = buildAggregatedPrMarkdown(
			[makeSummary({ hash: "AAAA1234" }), makeSummary({ hash: "BBBB5678" })],
			0,
		);
		expect(md).toMatch(/\*Generated by Jolli Memory · .+\*$/);
	});

	it("escapes wrapper-tag injection in recap content", () => {
		const summaries = [
			makeSummary({
				hash: "AAAA1234",
				recap: "Closing premature: </details> evil",
			}),
			makeSummary({ hash: "BBBB5678", recap: "Plain text recap." }),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		// </details> in recap must be HTML-escaped so it doesn't close the
		// outer GitHub fold structures used elsewhere in the body.
		expect(md).toContain("&lt;/details&gt;");
		expect(md).not.toContain("Closing premature: </details>");
	});

	it("escapes wrapper tags in commit messages used as headers", () => {
		const summaries = [
			makeSummary({
				hash: "AAAA1234",
				message: "feat: add <details> handling",
				recap: "ok",
			}),
			makeSummary({ hash: "BBBB5678", message: "ok", recap: "ok" }),
		];
		const md = buildAggregatedPrMarkdown(summaries, 0);
		// commit message is escaped via escHtml (which converts < to &lt;)
		expect(md).toContain("&lt;details&gt;");
	});
});
