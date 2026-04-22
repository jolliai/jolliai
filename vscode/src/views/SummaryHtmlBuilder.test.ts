import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const { aggregateStats, aggregateTurns, formatDurationLabel } = vi.hoisted(
	() => ({
		aggregateStats: vi.fn(() => ({
			insertions: 10,
			deletions: 5,
			filesChanged: 3,
		})),
		aggregateTurns: vi.fn(() => 0),
		formatDurationLabel: vi.fn(() => "2 hours"),
	}),
);

const { buildPrSectionHtml } = vi.hoisted(() => ({
	buildPrSectionHtml: vi.fn(() => ""),
}));

const { buildCss } = vi.hoisted(() => ({
	buildCss: vi.fn(() => "/* css */"),
}));

const { buildPrMarkdown } = vi.hoisted(() => ({
	buildPrMarkdown: vi.fn(() => "pr markdown"),
}));

const { buildScript } = vi.hoisted(() => ({
	buildScript: vi.fn(() => "// script"),
}));

const {
	collectSortedTopics,
	escAttr,
	escHtml,
	formatDate,
	formatFullDate,
	getDisplayDate,
	groupTopicsByDate,
	padIndex,
	renderCalloutText,
	timeAgo,
} = vi.hoisted(() => ({
	collectSortedTopics: vi.fn(() => ({
		topics: [],
		sourceNodes: [],
		showRecordDates: false,
	})),
	escAttr: vi.fn((s: string) => s),
	escHtml: vi.fn((s: string) => s),
	formatDate: vi.fn(() => "Jan 1, 2026"),
	formatFullDate: vi.fn(() => "January 1, 2026 at 12:00 PM"),
	getDisplayDate: vi.fn(
		(e: { generatedAt?: string; commitDate: string }) =>
			e.generatedAt || e.commitDate,
	),
	groupTopicsByDate: vi.fn(() => new Map()),
	padIndex: vi.fn((i: number) => String(i + 1).padStart(2, "0")),
	renderCalloutText: vi.fn((s: string) => s),
	timeAgo: vi.fn(() => "3 hours ago"),
}));

// ─── vi.mock declarations ───────────────────────────────────────────────────

vi.mock("../../../cli/src/core/SummaryTree.js", () => ({
	aggregateStats,
	aggregateTurns,
	formatDurationLabel,
}));

vi.mock("../services/PrCommentService.js", () => ({
	buildPrSectionHtml,
}));

vi.mock("./SummaryCssBuilder.js", () => ({
	buildCss,
}));

vi.mock("./SummaryMarkdownBuilder.js", () => ({
	buildPrMarkdown,
}));

vi.mock("./SummaryScriptBuilder.js", () => ({
	buildScript,
}));

vi.mock("./SummaryUtils.js", () => ({
	collectSortedTopics,
	escAttr,
	escHtml,
	formatDate,
	formatFullDate,
	getDisplayDate,
	groupTopicsByDate,
	padIndex,
	renderCalloutText,
	timeAgo,
}));

// ─── Import SUT ─────────────────────────────────────────────────────────────

import type {
	CommitSummary,
	E2eTestScenario,
	NoteReference,
	PlanReference,
} from "../../../cli/src/Types.js";
import {
	buildE2eTestSection,
	buildHtml,
	renderTopic,
} from "./SummaryHtmlBuilder.js";
import type { TopicWithDate } from "./SummaryUtils.js";

// ─── Test helpers ───────────────────────────────────────────────────────────

function makeSummary(overrides?: Partial<CommitSummary>): CommitSummary {
	return {
		version: 3,
		commitHash: "abcdef1234567890abcdef1234567890abcdef12",
		commitMessage: "feat: add new feature",
		commitAuthor: "Test Author",
		commitDate: "2026-01-15T10:00:00Z",
		branch: "feature/test-branch",
		generatedAt: "2026-01-15T10:05:00Z",
		stats: { filesChanged: 3, insertions: 10, deletions: 5 },
		topics: [],
		...overrides,
	};
}

function makeTopic(overrides?: Partial<TopicWithDate>): TopicWithDate {
	return {
		title: "Test Topic",
		trigger: "Something triggered this",
		response: "Here is the response",
		decisions: "Decided to do X",
		...overrides,
	};
}

function makePlan(overrides?: Partial<PlanReference>): PlanReference {
	return {
		slug: "test-plan",
		title: "Test Plan",
		editCount: 2,
		addedAt: "2026-01-15T10:00:00Z",
		updatedAt: "2026-01-15T10:05:00Z",
		...overrides,
	};
}

function makeNote(overrides?: Partial<NoteReference>): NoteReference {
	return {
		id: "test-note",
		title: "Test Note",
		format: "snippet",
		addedAt: "2026-01-15T10:00:00Z",
		updatedAt: "2026-01-15T10:05:00Z",
		...overrides,
	};
}

function makeScenario(overrides?: Partial<E2eTestScenario>): E2eTestScenario {
	return {
		title: "Test Scenario",
		steps: ["Step 1", "Step 2"],
		expectedResults: ["Result 1"],
		...overrides,
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SummaryHtmlBuilder", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Restore default mock implementations
		aggregateStats.mockReturnValue({
			insertions: 10,
			deletions: 5,
			filesChanged: 3,
		});
		aggregateTurns.mockReturnValue(0);
		formatDurationLabel.mockReturnValue("2 hours");
		buildPrSectionHtml.mockReturnValue("");
		buildCss.mockReturnValue("/* css */");
		buildPrMarkdown.mockReturnValue("pr markdown");
		buildScript.mockReturnValue("// script");
		collectSortedTopics.mockReturnValue({
			topics: [],
			sourceNodes: [],
			showRecordDates: false,
		});
		escAttr.mockImplementation((s: string) => s);
		escHtml.mockImplementation((s: string) => s);
		formatDate.mockReturnValue("Jan 1, 2026");
		formatFullDate.mockReturnValue("January 1, 2026 at 12:00 PM");
		padIndex.mockImplementation((i: number) => String(i + 1).padStart(2, "0"));
		renderCalloutText.mockImplementation((s: string) => s);
		timeAgo.mockReturnValue("3 hours ago");
		groupTopicsByDate.mockReturnValue(new Map());
	});

	// ─── buildHtml ────────────────────────────────────────────────────────────

	describe("buildHtml", () => {
		it("returns a valid HTML document structure", () => {
			const html = buildHtml(makeSummary());
			expect(html).toContain("<!DOCTYPE html>");
			expect(html).toContain('<html lang="en">');
			expect(html).toContain("<head>");
			expect(html).toContain("</head>");
			expect(html).toContain("<body>");
			expect(html).toContain("</body>");
			expect(html).toContain("</html>");
			expect(html).toContain("<title>Commit Memory</title>");
		});

		it("includes CSS from buildCss() in a style tag", () => {
			const html = buildHtml(makeSummary());
			expect(html).toContain("<style>/* css */</style>");
			expect(buildCss).toHaveBeenCalled();
		});

		it("includes script from buildScript()", () => {
			const html = buildHtml(makeSummary());
			expect(html).toContain("<script>// script</script>");
			expect(buildScript).toHaveBeenCalled();
		});

		it("includes CSP meta tag when nonce is provided", () => {
			const html = buildHtml(makeSummary(), { nonce: "abc123" });
			expect(html).toContain('http-equiv="Content-Security-Policy"');
			expect(html).toContain("'nonce-abc123'");
			expect(html).toContain("style-src 'nonce-abc123'");
			expect(html).toContain("script-src 'nonce-abc123'");
			expect(html).toContain('<style nonce="abc123">');
			expect(html).toContain('<script nonce="abc123">');
		});

		it("does not include CSP when nonce is undefined", () => {
			const html = buildHtml(makeSummary());
			expect(html).not.toContain("Content-Security-Policy");
			expect(html).not.toContain("nonce=");
		});

		it('shows "No summaries available" message when topics are empty', () => {
			collectSortedTopics.mockReturnValue({
				topics: [],
				sourceNodes: [],
				showRecordDates: false,
			});
			const html = buildHtml(makeSummary());
			expect(html).toContain("No summaries available for this commit.");
		});

		it("renders topics without timeline for a single topic", () => {
			const topic = makeTopic();
			collectSortedTopics.mockReturnValue({
				topics: [topic],
				sourceNodes: [makeSummary()],
				showRecordDates: false,
			});
			const html = buildHtml(makeSummary());
			expect(html).not.toContain("timeline");
			// renderTopic is called directly — verify by checking for toggle structure
			expect(html).toContain("toggle");
		});

		it("renders timeline when showRecordDates is true with multiple topics", () => {
			const topics = [
				makeTopic({ title: "Topic 1", recordDate: "2026-01-15T10:00:00Z" }),
				makeTopic({ title: "Topic 2", recordDate: "2026-01-14T10:00:00Z" }),
			];
			const grouped = new Map<string, Array<TopicWithDate>>();
			grouped.set("2026-01-15", [topics[0]]);
			grouped.set("2026-01-14", [topics[1]]);
			groupTopicsByDate.mockReturnValue(grouped);
			collectSortedTopics.mockReturnValue({
				topics,
				sourceNodes: [makeSummary(), makeSummary()],
				showRecordDates: true,
			});
			const html = buildHtml(makeSummary());
			expect(html).toContain("timeline");
			expect(html).toContain("timeline-group");
			expect(html).toContain("timeline-header");
		});

		it('shows correct section header count — "1 summary" for singular', () => {
			collectSortedTopics.mockReturnValue({
				topics: [makeTopic()],
				sourceNodes: [makeSummary()],
				showRecordDates: false,
			});
			const html = buildHtml(makeSummary());
			expect(html).toContain("Summary");
			expect(html).toContain("1 summary extracted from this commit");
		});

		it('shows correct section header count — "3 summaries" for plural', () => {
			collectSortedTopics.mockReturnValue({
				topics: [makeTopic(), makeTopic(), makeTopic()],
				sourceNodes: [makeSummary()],
				showRecordDates: false,
			});
			const html = buildHtml(makeSummary());
			expect(html).toContain("Summaries");
			expect(html).toContain("3 summaries extracted from this commit");
		});

		it("header includes commit hash, branch, author, date", () => {
			const summary = makeSummary({
				commitHash: "deadbeef12345678deadbeef12345678deadbeef",
				branch: "main",
				commitAuthor: "Jane Doe",
				commitDate: "2026-03-01T08:00:00Z",
			});
			const html = buildHtml(summary);
			// Hash is substring(0,8)
			expect(html).toContain("deadbeef");
			expect(html).toContain("main");
			expect(html).toContain("Jane Doe");
			// timeAgo and formatFullDate are mocked
			expect(html).toContain("3 hours ago");
			expect(html).toContain("January 1, 2026 at 12:00 PM");
		});

		it("does not show conversations row when turns is 0", () => {
			aggregateTurns.mockReturnValue(0);
			const html = buildHtml(makeSummary());
			// The "All Conversations" section header always exists, but the
			// properties "Conversations" row with stat-turns should be absent.
			expect(html).not.toContain("stat-turns");
		});

		it("shows conversations row when turns > 0", () => {
			aggregateTurns.mockReturnValue(5);
			const html = buildHtml(makeSummary());
			expect(html).toContain("Conversations");
			expect(html).toContain("5 turns");
		});

		it("shows singular turn label for 1 conversation turn", () => {
			aggregateTurns.mockReturnValue(1);
			const html = buildHtml(makeSummary());
			expect(html).toContain("Conversations");
			expect(html).toContain("1 turn");
			expect(html).not.toContain("1 turns");
		});

		it("shows Jolli Memory row when jolliDocUrl is set", () => {
			const html = buildHtml(
				makeSummary({ jolliDocUrl: "https://jolli.app/memory/123" }),
			);
			expect(html).toContain("Jolli Memory");
			expect(html).toContain("https://jolli.app/memory/123");
			expect(html).toContain('id="jolliRow"');
		});

		it("does not show Jolli Memory row when jolliDocUrl is undefined", () => {
			const html = buildHtml(makeSummary({ jolliDocUrl: undefined }));
			expect(html).not.toContain("jolliRow");
		});

		it("shows Jolli Memory row with published plans links", () => {
			const plans: Array<PlanReference> = [
				makePlan({
					slug: "plan-a",
					title: "Plan A",
					jolliPlanDocUrl: "https://jolli.app/plan/a",
				}),
				makePlan({
					slug: "plan-b",
					title: "Plan B",
					jolliPlanDocUrl: undefined,
				}),
			];
			const html = buildHtml(
				makeSummary({ jolliDocUrl: "https://jolli.app/memory/123", plans }),
			);
			expect(html).toContain("https://jolli.app/plan/a");
			expect(html).toContain("jolli-plans-block");
		});

		it("shows push label 'Update on Jolli' when jolliDocUrl exists", () => {
			const html = buildHtml(
				makeSummary({ jolliDocUrl: "https://jolli.app/memory/123" }),
			);
			expect(html).toContain("Update on Jolli");
		});

		it("shows push label 'Push to Jolli' when jolliDocUrl is undefined", () => {
			const html = buildHtml(makeSummary({ jolliDocUrl: undefined }));
			expect(html).toContain("Push to Jolli");
		});

		it("shows push label 'Push to Jolli & Local' when pushAction is 'both' and no jolliDocUrl", () => {
			const html = buildHtml(makeSummary({ jolliDocUrl: undefined }), {
				pushAction: "both",
			});
			expect(html).toContain("Push to Jolli &amp; Local");
		});

		it("shows push label 'Update on Jolli & Local' when pushAction is 'both' and jolliDocUrl exists", () => {
			const html = buildHtml(
				makeSummary({ jolliDocUrl: "https://jolli.app/memory/123" }),
				{
					pushAction: "both",
				},
			);
			expect(html).toContain("Update on Jolli &amp; Local");
		});

		it("adds data-push-action attribute to push button", () => {
			const html = buildHtml(makeSummary(), { pushAction: "both" });
			expect(html).toContain('data-push-action="both"');
		});

		it("defaults data-push-action to 'jolli' when not specified", () => {
			const html = buildHtml(makeSummary());
			expect(html).toContain('data-push-action="jolli"');
		});

		it("shows commit message tooltip in Jolli Memory row", () => {
			const html = buildHtml(
				makeSummary({
					jolliDocUrl: "https://jolli.app/memory/123",
					commitMessage: "feat: something",
				}),
			);
			expect(html).toContain("feat: something");
		});

		it("shows 'View on Jolli' tooltip when commitMessage is empty", () => {
			const html = buildHtml(
				makeSummary({
					jolliDocUrl: "https://jolli.app/memory/123",
					commitMessage: "",
				}),
			);
			expect(html).toContain("View on Jolli");
		});

		it("shows Jolli Memory row without plans block when no published plan URLs", () => {
			const plans = [makePlan({ jolliPlanDocUrl: undefined })];
			const html = buildHtml(
				makeSummary({ jolliDocUrl: "https://jolli.app/memory/123", plans }),
			);
			expect(html).toContain("jolliRow");
			expect(html).not.toContain("jolli-plans-block");
		});

		it("shows Jolli Memory row with published notes links", () => {
			const notes = [
				makeNote({
					id: "note-a",
					title: "Note A",
					jolliNoteDocUrl: "https://jolli.app/note/a",
				}),
				makeNote({ id: "note-b", title: "Note B", jolliNoteDocUrl: undefined }),
			];
			const html = buildHtml(
				makeSummary({ jolliDocUrl: "https://jolli.app/memory/123", notes }),
			);
			expect(html).toContain("https://jolli.app/note/a");
			expect(html).toContain("jolli-plans-block");
			expect(html).toContain("Plans &amp; Notes");
		});

		it("omits notes block when no published note URLs", () => {
			const notes = [makeNote({ jolliNoteDocUrl: undefined })];
			const html = buildHtml(
				makeSummary({ jolliDocUrl: "https://jolli.app/memory/123", notes }),
			);
			// Should not show a notes block, only jolli row
			const jolliSection = html.slice(
				html.indexOf("jolliRow"),
				html.indexOf("jolliRow") + 500,
			);
			expect(jolliSection).not.toContain(">Plans &amp; Notes<");
		});

		it("plans section is always present with 'No plans or notes' placeholder when empty", () => {
			const html = buildHtml(makeSummary({ plans: undefined }));
			expect(html).toContain("plansAndNotesSection");
			expect(html).toContain(
				"No plans or notes associated with this commit yet.",
			);
			expect(html).toContain("+ Add");
		});

		it("plans section renders plan items", () => {
			const plans = [
				makePlan({ slug: "my-plan", title: "My Plan", editCount: 3 }),
			];
			// collectSortedTopics returns empty topics, but the plans appear via buildPlansSection
			const html = buildHtml(makeSummary({ plans }));
			expect(html).toContain("my-plan");
			expect(html).toContain("My Plan");
			expect(html).toContain("my-plan.md");
			expect(html).not.toContain("edited");
		});

		it("notes section renders snippet note with content preview", () => {
			const notes = [
				makeNote({
					id: "snip-1",
					title: "My Snippet",
					format: "snippet",
					content: "Hello world",
				}),
			];
			const html = buildHtml(makeSummary({ notes }));
			expect(html).toContain("snip-1");
			expect(html).toContain("My Snippet");
			expect(html).toContain("snippet");
			expect(html).toContain("Hello world");
		});

		it("notes section renders markdown note with filename fallback", () => {
			const notes = [
				makeNote({ id: "md-1", title: "My Markdown", format: "markdown" }),
			];
			const html = buildHtml(makeSummary({ notes }));
			expect(html).toContain("md-1");
			expect(html).toContain("My Markdown");
			expect(html).toContain("markdown");
			expect(html).toContain("md-1.md");
		});

		it("notes section includes remove button with data attributes", () => {
			const notes = [makeNote({ id: "rm-note", title: "Remove Me" })];
			const html = buildHtml(makeSummary({ notes }));
			expect(html).toContain('data-action="removeNote"');
			expect(html).toContain('data-note-id="rm-note"');
			expect(html).toContain('data-note-title="Remove Me"');
		});

		it("plans section shows count badge when more than 1 plan", () => {
			const plans = [makePlan({ slug: "p1" }), makePlan({ slug: "p2" })];
			const html = buildHtml(makeSummary({ plans }));
			expect(html).toContain('class="section-count">2</span>');
		});

		it("plans section omits count badge when exactly 1 plan", () => {
			const plans = [makePlan()];
			const html = buildHtml(makeSummary({ plans }));
			// The Plans section title should not contain section-count
			const plansHeader = html.slice(
				html.indexOf("Plans"),
				html.indexOf("Plans") + 100,
			);
			expect(plansHeader).not.toContain("section-count");
		});

		it("note titles are clickable preview links", () => {
			const notes = [makeNote({ id: "preview-note", title: "Preview Me" })];
			const html = buildHtml(makeSummary({ notes }));
			expect(html).toContain('data-action="previewNote"');
			expect(html).toContain('data-note-id="preview-note"');
			expect(html).toContain("plan-title-link");
		});

		it("note items show translate button when id is in noteTranslateSet", () => {
			const notes = [makeNote({ id: "translate-note" })];
			const noteTranslateSet = new Set(["translate-note"]);
			const html = buildHtml(makeSummary({ notes }), { noteTranslateSet });
			expect(html).toContain("note-translate-btn");
			expect(html).toContain("Translate to English");
		});

		it("note items do not show translate button when id is not in noteTranslateSet", () => {
			const notes = [makeNote({ id: "no-translate" })];
			const noteTranslateSet = new Set(["other-note"]);
			const html = buildHtml(makeSummary({ notes }), { noteTranslateSet });
			expect(html).not.toContain("note-translate-btn");
		});

		it("plan items show translate button when slug is in planTranslateSet", () => {
			const plans = [makePlan({ slug: "translate-me" })];
			const translateSet = new Set(["translate-me"]);
			const html = buildHtml(makeSummary({ plans }), {
				planTranslateSet: translateSet,
			});
			expect(html).toContain("plan-translate-btn");
			expect(html).toContain("Translate to English");
		});

		it("plan items do not show translate button when slug is not in planTranslateSet", () => {
			const plans = [makePlan({ slug: "no-translate" })];
			const translateSet = new Set(["other-slug"]);
			const html = buildHtml(makeSummary({ plans }), {
				planTranslateSet: translateSet,
			});
			expect(html).not.toContain("plan-translate-btn");
		});

		it("E2E test section with no scenarios shows generate button", () => {
			const html = buildHtml(makeSummary({ e2eTestGuide: undefined }));
			expect(html).toContain("e2eTestSection");
			expect(html).toContain("generateE2eBtn");
			expect(html).toContain("Generate");
		});

		it("E2E test section with scenarios shows edit/regen/delete buttons", () => {
			const scenarios = [makeScenario()];
			const html = buildHtml(makeSummary({ e2eTestGuide: scenarios }));
			expect(html).toContain("editE2eBtn");
			expect(html).toContain("regenE2eBtn");
			expect(html).toContain("deleteE2eBtn");
		});

		it("source commits section not shown for single source", () => {
			collectSortedTopics.mockReturnValue({
				topics: [],
				sourceNodes: [makeSummary()],
				showRecordDates: false,
			});
			const html = buildHtml(makeSummary());
			expect(html).not.toContain("Source Commits");
		});

		it("source commits section shown for multiple sources", () => {
			const source1 = makeSummary({
				commitHash: "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
				commitMessage: "first commit",
				conversationTurns: 3,
				stats: { filesChanged: 1, insertions: 5, deletions: 2 },
			});
			const source2 = makeSummary({
				commitHash: "ffff6666aaaa7777bbbb8888cccc9999dddd0000",
				commitMessage: "second commit",
				stats: { filesChanged: 2, insertions: 8, deletions: 1 },
			});
			collectSortedTopics.mockReturnValue({
				topics: [],
				sourceNodes: [source1, source2],
				showRecordDates: false,
			});
			const html = buildHtml(makeSummary());
			expect(html).toContain("Source Commits");
			expect(html).toContain("aaaa1111");
			expect(html).toContain("ffff6666");
			expect(html).toContain("first commit");
			expect(html).toContain("second commit");
		});

		it("source commit row shows turns when conversationTurns is set", () => {
			const source = makeSummary({
				commitHash: "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
				conversationTurns: 7,
				stats: { filesChanged: 1, insertions: 1, deletions: 0 },
			});
			collectSortedTopics.mockReturnValue({
				topics: [],
				sourceNodes: [source, makeSummary()],
				showRecordDates: false,
			});
			const html = buildHtml(makeSummary());
			expect(html).toContain("7 turns");
		});

		it("source commit row shows singular turn label", () => {
			const source = makeSummary({
				commitHash: "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
				conversationTurns: 1,
				stats: { filesChanged: 1, insertions: 1, deletions: 0 },
			});
			collectSortedTopics.mockReturnValue({
				topics: [],
				sourceNodes: [source, makeSummary()],
				showRecordDates: false,
			});
			const html = buildHtml(makeSummary());
			expect(html).toContain("1 turn");
			expect(html).not.toMatch(/1 turns/);
		});

		it("source commit row omits turns suffix when conversationTurns is falsy", () => {
			const source = makeSummary({
				commitHash: "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
				conversationTurns: 0,
				stats: { filesChanged: 1, insertions: 1, deletions: 0 },
			});
			collectSortedTopics.mockReturnValue({
				topics: [],
				sourceNodes: [source, makeSummary()],
				showRecordDates: false,
			});
			const html = buildHtml(makeSummary());
			expect(html).not.toContain("stat-turns");
		});

		it("All Conversations section shows empty message when no transcripts", () => {
			const html = buildHtml(makeSummary());
			expect(html).toContain("All Conversations");
			expect(html).toContain(
				"No conversation transcripts saved for this commit.",
			);
			expect(html).toContain("PRIVATE");
		});

		it("All Conversations section with empty set shows empty message", () => {
			const html = buildHtml(makeSummary(), { transcriptHashSet: new Set() });
			expect(html).toContain(
				"No conversation transcripts saved for this commit.",
			);
		});

		it("All Conversations section with transcripts shows Manage button and modal", () => {
			const transcripts = new Set(["hash1", "hash2"]);
			const html = buildHtml(makeSummary(), { transcriptHashSet: transcripts });
			expect(html).toContain("Manage");
			expect(html).toContain("openTranscriptsBtn");
			expect(html).toContain("transcriptModal");
			expect(html).toContain("modal-overlay");
			expect(html).toContain("modal-container");
			expect(html).toContain("deleteTranscriptsBtn");
			expect(html).toContain("modalSaveBtn");
		});

		it("header shows correct singular/plural for file changes", () => {
			aggregateStats.mockReturnValue({
				insertions: 1,
				deletions: 1,
				filesChanged: 1,
			});
			const html = buildHtml(makeSummary());
			expect(html).toContain("1 file changed");
			expect(html).toContain("1 insertion(+)");
			expect(html).toContain("1 deletion(-)");
		});

		it("header shows correct plural for multiple file changes", () => {
			aggregateStats.mockReturnValue({
				insertions: 10,
				deletions: 5,
				filesChanged: 3,
			});
			const html = buildHtml(makeSummary());
			expect(html).toContain("3 files changed");
			expect(html).toContain("10 insertions(+)");
			expect(html).toContain("5 deletions(-)");
		});

		it("includes duration row", () => {
			const html = buildHtml(makeSummary());
			expect(html).toContain("Duration");
			expect(html).toContain("2 hours");
			expect(formatDurationLabel).toHaveBeenCalled();
		});

		it("includes footer with 'Generated by Jolli Memory'", () => {
			const html = buildHtml(makeSummary());
			expect(html).toContain("Generated by Jolli Memory");
			expect(html).toContain("page-footer");
		});

		it("includes toggleAllBtn", () => {
			const html = buildHtml(makeSummary());
			expect(html).toContain("toggleAllBtn");
			expect(html).toContain("Collapse All");
		});

		it("includes copyMdBtn and pushJolliBtn", () => {
			const html = buildHtml(makeSummary());
			expect(html).toContain("copyMdBtn");
			expect(html).toContain("pushJolliBtn");
		});

		it("calls buildPrSectionHtml with commit message and PR markdown", () => {
			buildHtml(makeSummary({ commitMessage: "test msg" }));
			expect(buildPrSectionHtml).toHaveBeenCalledWith(
				"test msg",
				"pr markdown",
			);
		});

		it("includes hash copy button with full hash in data attribute", () => {
			const hash = "abcdef1234567890abcdef1234567890abcdef12";
			const html = buildHtml(makeSummary({ commitHash: hash }));
			expect(html).toContain(`data-hash="${hash}"`);
			expect(html).toContain("hash-copy");
		});

		it("timeline renders correct group count labels", () => {
			const topics = [
				makeTopic({ title: "T1", recordDate: "2026-01-15T10:00:00Z" }),
				makeTopic({ title: "T2", recordDate: "2026-01-15T11:00:00Z" }),
				makeTopic({ title: "T3", recordDate: "2026-01-14T10:00:00Z" }),
			];
			const grouped = new Map<string, Array<TopicWithDate>>();
			grouped.set("2026-01-15", [topics[0], topics[1]]);
			grouped.set("2026-01-14", [topics[2]]);
			groupTopicsByDate.mockReturnValue(grouped);
			collectSortedTopics.mockReturnValue({
				topics,
				sourceNodes: [makeSummary(), makeSummary()],
				showRecordDates: true,
			});
			const html = buildHtml(makeSummary());
			expect(html).toContain("2 memories");
			expect(html).toContain("1 memory");
		});

		it("source commit row handles missing stats gracefully", () => {
			const source = makeSummary({
				commitHash: "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
				stats: undefined,
			});
			collectSortedTopics.mockReturnValue({
				topics: [],
				sourceNodes: [source, makeSummary()],
				showRecordDates: false,
			});
			const html = buildHtml(makeSummary());
			// With undefined stats, insertions/deletions default to 0
			expect(html).toContain("+0");
		});
	});

	// ─── buildE2eTestSection ─────────────────────────────────────────────────

	describe("buildE2eTestSection", () => {
		it("shows placeholder with Generate button when no scenarios", () => {
			const html = buildE2eTestSection(
				makeSummary({ e2eTestGuide: undefined }),
			);
			expect(html).toContain("e2eTestSection");
			expect(html).toContain("e2e-placeholder");
			expect(html).toContain("generateE2eBtn");
			expect(html).toContain("Generate");
			expect(html).not.toContain("editE2eBtn");
		});

		it("shows placeholder when scenarios is empty array", () => {
			const html = buildE2eTestSection(makeSummary({ e2eTestGuide: [] }));
			expect(html).toContain("generateE2eBtn");
		});

		it("renders each scenario with steps and expected results", () => {
			const scenarios = [
				makeScenario({
					title: "Login flow",
					steps: ["Go to login", "Enter credentials"],
					expectedResults: ["User is logged in"],
				}),
				makeScenario({
					title: "Logout flow",
					steps: ["Click logout"],
					expectedResults: ["User sees login page"],
				}),
			];
			const html = buildE2eTestSection(
				makeSummary({ e2eTestGuide: scenarios }),
			);
			expect(html).toContain("Login flow");
			expect(html).toContain("Logout flow");
			expect(html).toContain("Go to login");
			expect(html).toContain("Enter credentials");
			expect(html).toContain("User is logged in");
			expect(html).toContain("Click logout");
			expect(html).toContain("User sees login page");
			// Count badge
			expect(html).toContain(`<span class="section-count">2</span>`);
		});

		it("shows edit/regen/delete buttons when scenarios exist", () => {
			const html = buildE2eTestSection(
				makeSummary({ e2eTestGuide: [makeScenario()] }),
			);
			expect(html).toContain("editE2eBtn");
			expect(html).toContain("regenE2eBtn");
			expect(html).toContain("deleteE2eBtn");
		});

		it("renders preconditions block when preconditions are set", () => {
			const scenarios = [
				makeScenario({ preconditions: "Must be logged in as admin" }),
			];
			const html = buildE2eTestSection(
				makeSummary({ e2eTestGuide: scenarios }),
			);
			expect(html).toContain("Preconditions");
			expect(html).toContain("Must be logged in as admin");
			expect(html).toContain("preconditions");
		});

		it("does not render preconditions block when preconditions are absent", () => {
			const scenarios = [makeScenario({ preconditions: undefined })];
			const html = buildE2eTestSection(
				makeSummary({ e2eTestGuide: scenarios }),
			);
			expect(html).not.toContain("Preconditions");
		});

		it("renders scenario toggle with correct ID and padded index", () => {
			const scenarios = [makeScenario({ title: "Scenario A" })];
			const html = buildE2eTestSection(
				makeSummary({ e2eTestGuide: scenarios }),
			);
			expect(html).toContain('id="e2e-scenario-0"');
			expect(html).toContain("e2e-scenario");
			expect(padIndex).toHaveBeenCalledWith(0);
		});

		it("renders steps in an ordered list", () => {
			const scenarios = [
				makeScenario({ steps: ["First step", "Second step"] }),
			];
			const html = buildE2eTestSection(
				makeSummary({ e2eTestGuide: scenarios }),
			);
			expect(html).toContain("<ol>");
			expect(html).toContain("<li>First step</li>");
			expect(html).toContain("<li>Second step</li>");
		});

		it("renders expected results in an unordered list", () => {
			const scenarios = [
				makeScenario({
					expectedResults: ["Sees success message", "Data is saved"],
				}),
			];
			const html = buildE2eTestSection(
				makeSummary({ e2eTestGuide: scenarios }),
			);
			expect(html).toContain("<ul>");
			expect(html).toContain("<li>Sees success message</li>");
			expect(html).toContain("<li>Data is saved</li>");
		});
	});

	// ─── renderTopic ────────────────────────────────────────────────────────

	describe("renderTopic", () => {
		it("renders toggle with correct ID based on displayIndex", () => {
			const html = renderTopic(makeTopic(), 5);
			expect(html).toContain('id="topic-5"');
		});

		it("uses treeIndex for edit/delete when available", () => {
			const topic = makeTopic({ treeIndex: 42 });
			const html = renderTopic(topic, 5);
			expect(html).toContain('id="topic-42"');
			expect(html).toContain('data-topic-index="42"');
		});

		it("falls back to displayIndex when treeIndex is undefined", () => {
			const topic = makeTopic({ treeIndex: undefined });
			const html = renderTopic(topic, 7);
			expect(html).toContain('id="topic-7"');
			expect(html).toContain('data-topic-index="7"');
		});

		it("shows category pill when category is set", () => {
			const html = renderTopic(makeTopic({ category: "feature" }), 0);
			expect(html).toContain("cat-pill");
			expect(html).toContain("cat-feature");
			expect(html).toContain("feature");
		});

		it("does not show category pill when category is undefined", () => {
			const html = renderTopic(makeTopic({ category: undefined }), 0);
			expect(html).not.toContain("cat-pill");
		});

		it('adds "minor" class when importance is minor', () => {
			const html = renderTopic(makeTopic({ importance: "minor" }), 0);
			expect(html).toContain("toggle-header minor");
		});

		it('does not add "minor" class when importance is major', () => {
			const html = renderTopic(makeTopic({ importance: "major" }), 0);
			expect(html).not.toContain("toggle-header minor");
		});

		it('does not add "minor" class when importance is undefined', () => {
			const html = renderTopic(makeTopic({ importance: undefined }), 0);
			expect(html).not.toContain("toggle-header minor");
		});

		it("embeds topic data as JSON in data-topic attribute", () => {
			const topic = makeTopic({
				title: "My Title",
				trigger: "My Trigger",
				response: "My Response",
				decisions: "My Decisions",
				todo: "My Todo",
				filesAffected: ["file1.ts", "file2.ts"],
			});
			const html = renderTopic(topic, 0);
			expect(html).toContain("data-topic=");
			// Verify the JSON structure via escAttr mock (pass-through)
			const jsonStr = JSON.stringify({
				title: "My Title",
				trigger: "My Trigger",
				response: "My Response",
				decisions: "My Decisions",
				todo: "My Todo",
				filesAffected: "file1.ts\nfile2.ts",
			});
			expect(escAttr).toHaveBeenCalledWith(jsonStr);
		});

		it("embeds topic data with empty todo and filesAffected when absent", () => {
			const topic = makeTopic({ todo: undefined, filesAffected: undefined });
			const html = renderTopic(topic, 0);
			expect(html).toContain("data-topic=");
			const jsonStr = JSON.stringify({
				title: "Test Topic",
				trigger: "Something triggered this",
				response: "Here is the response",
				decisions: "Decided to do X",
				todo: "",
				filesAffected: "",
			});
			expect(escAttr).toHaveBeenCalledWith(jsonStr);
		});

		it("renders callout blocks for trigger, decisions, and response", () => {
			const html = renderTopic(
				makeTopic({ trigger: "trig", decisions: "dec", response: "resp" }),
				0,
			);
			expect(html).toContain('data-field="trigger"');
			expect(html).toContain('data-field="decisions"');
			expect(html).toContain('data-field="response"');
			expect(renderCalloutText).toHaveBeenCalledWith("trig");
			expect(renderCalloutText).toHaveBeenCalledWith("dec");
			expect(renderCalloutText).toHaveBeenCalledWith("resp");
		});

		it("hides todo block when no todo", () => {
			const html = renderTopic(makeTopic({ todo: undefined }), 0);
			expect(html).toContain('data-field="todo"');
			// The todo block should have the hidden class
			expect(html).toMatch(/callout todo.*hidden/);
		});

		it("shows todo block when todo exists", () => {
			const html = renderTopic(makeTopic({ todo: "Fix this later" }), 0);
			expect(html).toContain('data-field="todo"');
			// Should NOT have the hidden class on todo
			const todoMatch = html.match(/class="callout todo[^"]*"/);
			expect(todoMatch).toBeTruthy();
			expect(todoMatch?.[0]).not.toContain("hidden");
			expect(renderCalloutText).toHaveBeenCalledWith("Fix this later");
		});

		it("hides files block when no files", () => {
			const html = renderTopic(makeTopic({ filesAffected: undefined }), 0);
			expect(html).toMatch(/callout files.*hidden/);
		});

		it("hides files block when filesAffected is empty array", () => {
			const html = renderTopic(makeTopic({ filesAffected: [] }), 0);
			expect(html).toMatch(/callout files.*hidden/);
		});

		it("shows files block when filesAffected has entries", () => {
			const html = renderTopic(
				makeTopic({ filesAffected: ["src/App.ts", "src/Main.ts"] }),
				0,
			);
			const filesMatch = html.match(/class="callout files[^"]*"/);
			expect(filesMatch).toBeTruthy();
			expect(filesMatch?.[0]).not.toContain("hidden");
			expect(html).toContain("files-affected-item");
			expect(html).toContain("src/App.ts");
			expect(html).toContain("src/Main.ts");
		});

		it("renders padded display index", () => {
			const html = renderTopic(makeTopic(), 0);
			expect(padIndex).toHaveBeenCalledWith(0);
			expect(html).toContain("01");
		});

		it("renders title through escHtml", () => {
			const html = renderTopic(makeTopic({ title: "Important Change" }), 0);
			expect(escHtml).toHaveBeenCalledWith("Important Change");
			expect(html).toContain("Important Change");
		});

		it("renders edit and delete action buttons", () => {
			const html = renderTopic(makeTopic(), 3);
			expect(html).toContain("topic-edit-btn");
			expect(html).toContain("topic-delete-btn");
			expect(html).toContain('data-topic-index="3"');
		});

		it("timeline uses dayKey fallback when first topic has no recordDate", () => {
			const topicNoDate = makeTopic({ title: "NoDate", recordDate: undefined });
			const grouped = new Map<string, Array<TopicWithDate>>();
			grouped.set("2026-01-15", [topicNoDate]);
			groupTopicsByDate.mockReturnValue(grouped);
			collectSortedTopics.mockReturnValue({
				topics: [topicNoDate],
				sourceNodes: [makeSummary(), makeSummary()],
				showRecordDates: true,
			});

			buildHtml(makeSummary());

			// formatDate should be called with the dayKey "2026-01-15" (the fallback)
			expect(formatDate).toHaveBeenCalledWith("2026-01-15");
		});

		it("maps all category types to correct CSS classes", () => {
			const categoryMap: Record<string, string> = {
				feature: "cat-feature",
				ux: "cat-feature",
				bugfix: "cat-bugfix",
				security: "cat-bugfix",
				refactor: "cat-refactor",
				performance: "cat-refactor",
				"tech-debt": "cat-infra",
				devops: "cat-infra",
				test: "cat-docs",
				docs: "cat-docs",
			};
			for (const [category, expectedClass] of Object.entries(categoryMap)) {
				const html = renderTopic(
					makeTopic({ category: category as TopicWithDate["category"] }),
					0,
				);
				expect(html).toContain(expectedClass);
			}
		});
	});
});
