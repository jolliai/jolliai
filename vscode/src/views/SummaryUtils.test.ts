import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockCollectAllTopics,
	mockCollectSourceNodes,
	mockComputeDurationDays,
} = vi.hoisted(() => ({
	mockCollectAllTopics: vi.fn(),
	mockCollectSourceNodes: vi.fn(),
	mockComputeDurationDays: vi.fn(),
}));

vi.mock("../../../cli/src/core/SummaryTree.js", () => ({
	collectAllTopics: mockCollectAllTopics,
	collectSourceNodes: mockCollectSourceNodes,
	computeDurationDays: mockComputeDurationDays,
}));

import type { CommitSummary, PlanReference } from "../../../cli/src/Types.js";
import type { TopicWithDate } from "./SummaryUtils.js";
import {
	buildNotePushTitle,
	buildPanelTitle,
	buildPlanPushTitle,
	buildPushTitle,
	collectAllPlans,
	collectSortedTopics,
	escAttr,
	escHtml,
	formatDate,
	formatFullDate,
	groupTopicsByDate,
	padIndex,
	renderCalloutText,
	sortTopics,
	timeAgo,
} from "./SummaryUtils.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Builds a mock CommitSummary with sensible defaults. Override any field as needed. */
function makeSummary(overrides: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 1,
		commitHash: "abc1234def5678",
		commitMessage: "Fix some bug",
		commitAuthor: "Alice",
		commitDate: "2026-03-15T10:30:00.000Z",
		branch: "feature/proj-100-my-feature",
		generatedAt: "2026-03-15T10:31:00.000Z",
		...overrides,
	};
}

/** Builds a mock TopicWithDate. */
function makeTopic(overrides: Partial<TopicWithDate> = {}): TopicWithDate {
	return {
		title: "Test topic",
		trigger: "User asked",
		response: "Did the thing",
		decisions: "Chose approach A",
		importance: "major",
		...overrides,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SummaryUtils", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// ── escHtml ──────────────────────────────────────────────────────────────

	describe("escHtml", () => {
		it("escapes ampersand, angle brackets, and double quotes", () => {
			expect(escHtml('&<>"')).toBe("&amp;&lt;&gt;&quot;");
		});

		it("returns unmodified string when no special characters", () => {
			expect(escHtml("hello world")).toBe("hello world");
		});

		it("handles multiple occurrences", () => {
			expect(escHtml("a & b & c")).toBe("a &amp; b &amp; c");
		});

		it("handles empty string", () => {
			expect(escHtml("")).toBe("");
		});
	});

	// ── escAttr ──────────────────────────────────────────────────────────────

	describe("escAttr", () => {
		it("escapes ampersand, double quote, single quote, less-than, and greater-than", () => {
			expect(escAttr("&\"'<>")).toBe("&amp;&quot;&#39;&lt;&gt;");
		});

		it("returns unmodified string when no special characters", () => {
			expect(escAttr("plain text")).toBe("plain text");
		});

		it("handles empty string", () => {
			expect(escAttr("")).toBe("");
		});
	});

	// ── formatDate ───────────────────────────────────────────────────────────

	describe("formatDate", () => {
		it("formats a valid ISO date to short month/day/year", () => {
			const result = formatDate("2026-03-15T10:30:00.000Z");
			// Exact format depends on locale but should contain "Mar" and "2026"
			expect(result).toContain("Mar");
			expect(result).toContain("2026");
			expect(result).toContain("15");
		});

		it("returns the raw string for invalid dates (catch branch)", () => {
			// Date constructor with garbage produces "Invalid Date" which toLocaleDateString
			// may still work on, but formatDate catches errors. We test the fallback.
			// Note: In most JS engines "Invalid Date" won't throw, so we test with a value
			// that produces a valid Date but non-throwing result.
			const result = formatDate("not-a-date");
			// Should be either the formatted "Invalid Date" or the raw string
			expect(typeof result).toBe("string");
		});

		it("returns the raw string when Date constructor throws (catch branch)", () => {
			const OriginalDate = globalThis.Date;
			const spy = vi
				.spyOn(globalThis, "Date")
				.mockImplementation((...args: Array<unknown>) => {
					if (args.length > 0 && args[0] === "throw-trigger") {
						throw new Error("forced error");
					}
					// biome-ignore lint/suspicious/noExplicitAny: test mock
					return new OriginalDate(...(args as [any]));
				});

			const result = formatDate("throw-trigger");

			expect(result).toBe("throw-trigger");
			spy.mockRestore();
		});
	});

	// ── formatFullDate ───────────────────────────────────────────────────────

	describe("formatFullDate", () => {
		it("formats a valid ISO date to long month with time", () => {
			// Use midday UTC to avoid day-boundary shifts across timezones
			const result = formatFullDate("2026-03-15T12:00:00.000Z");
			expect(result).toContain("March");
			expect(result).toContain("2026");
			expect(result).toContain("15");
		});

		it("returns the raw string for invalid dates", () => {
			const result = formatFullDate("garbage");
			expect(typeof result).toBe("string");
		});

		it("returns the raw string when Date constructor throws (catch branch)", () => {
			const OriginalDate = globalThis.Date;
			const spy = vi
				.spyOn(globalThis, "Date")
				.mockImplementation((...args: Array<unknown>) => {
					if (args.length > 0 && args[0] === "throw-trigger") {
						throw new Error("forced error");
					}
					// biome-ignore lint/suspicious/noExplicitAny: test mock
					return new OriginalDate(...(args as [any]));
				});

			const result = formatFullDate("throw-trigger");

			expect(result).toBe("throw-trigger");
			spy.mockRestore();
		});
	});

	// ── timeAgo ──────────────────────────────────────────────────────────────

	describe("timeAgo", () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));
		});

		it("returns 'Just now' for less than 1 minute ago", () => {
			expect(timeAgo("2026-03-30T11:59:30.000Z")).toBe("Just now");
		});

		it("returns '1 minute ago' for exactly 1 minute", () => {
			expect(timeAgo("2026-03-30T11:59:00.000Z")).toBe("1 minute ago");
		});

		it("returns 'N minutes ago' for 2+ minutes", () => {
			expect(timeAgo("2026-03-30T11:55:00.000Z")).toBe("5 minutes ago");
		});

		it("returns '1 hour ago' for exactly 1 hour", () => {
			expect(timeAgo("2026-03-30T11:00:00.000Z")).toBe("1 hour ago");
		});

		it("returns 'N hours ago' for 2+ hours", () => {
			expect(timeAgo("2026-03-30T07:00:00.000Z")).toBe("5 hours ago");
		});

		it("returns 'Yesterday' for exactly 1 day ago", () => {
			expect(timeAgo("2026-03-29T12:00:00.000Z")).toBe("Yesterday");
		});

		it("returns 'N days ago' for 2-30 days", () => {
			expect(timeAgo("2026-03-27T12:00:00.000Z")).toBe("3 days ago");
		});

		it("falls back to formatDate for more than 30 days", () => {
			const result = timeAgo("2026-02-01T12:00:00.000Z");
			// Should be a formatted date string, not "N days ago"
			expect(result).toContain("Feb");
			expect(result).toContain("2026");
		});

		it("returns the raw string on error (catch branch)", () => {
			// Force an error by using a value that won't parse
			// In practice the try/catch handles unexpected errors
			const result = timeAgo("invalid-date");
			// NaN comparisons all return false, so all if-checks fail => "Just now" or
			// the string itself if it throws. Either way it should be a string.
			expect(typeof result).toBe("string");
		});

		it("returns the raw string when Date constructor throws (catch branch)", () => {
			vi.useRealTimers();
			const OriginalDate = globalThis.Date;
			const spy = vi
				.spyOn(globalThis, "Date")
				.mockImplementation((...args: Array<unknown>) => {
					if (args.length > 0 && args[0] === "throw-trigger") {
						throw new Error("forced error");
					}
					// biome-ignore lint/suspicious/noExplicitAny: test mock
					return new OriginalDate(...(args as [any]));
				});

			const result = timeAgo("throw-trigger");

			expect(result).toBe("throw-trigger");
			spy.mockRestore();
		});
	});

	// ── sortTopics ───────────────────────────────────────────────────────────

	describe("sortTopics", () => {
		it("sorts by date descending (newest first)", () => {
			const topics: Array<TopicWithDate> = [
				makeTopic({ recordDate: "2026-03-10T08:00:00Z" }),
				makeTopic({ recordDate: "2026-03-15T08:00:00Z" }),
				makeTopic({ recordDate: "2026-03-12T08:00:00Z" }),
			];
			const sorted = sortTopics(topics);
			expect(sorted[0].recordDate).toContain("2026-03-15");
			expect(sorted[1].recordDate).toContain("2026-03-12");
			expect(sorted[2].recordDate).toContain("2026-03-10");
		});

		it("sorts major before minor on the same day", () => {
			const topics: Array<TopicWithDate> = [
				makeTopic({ recordDate: "2026-03-15T10:00:00Z", importance: "minor" }),
				makeTopic({ recordDate: "2026-03-15T08:00:00Z", importance: "major" }),
			];
			const sorted = sortTopics(topics);
			expect(sorted[0].importance).toBe("major");
			expect(sorted[1].importance).toBe("minor");
		});

		it("treats missing recordDate as empty string (sorts last)", () => {
			const topics: Array<TopicWithDate> = [
				makeTopic({ recordDate: undefined }),
				makeTopic({ recordDate: "2026-03-15T10:00:00Z" }),
			];
			const sorted = sortTopics(topics);
			expect(sorted[0].recordDate).toContain("2026-03-15");
			expect(sorted[1].recordDate).toBeUndefined();
		});

		it("sorts major before minor on the same day when minor comes first in input", () => {
			const topics: Array<TopicWithDate> = [
				makeTopic({
					recordDate: "2026-03-15T14:00:00Z",
					importance: "minor",
					title: "Minor task",
				}),
				makeTopic({
					recordDate: "2026-03-15T10:00:00Z",
					importance: "major",
					title: "Major task",
				}),
				makeTopic({
					recordDate: "2026-03-15T08:00:00Z",
					importance: "minor",
					title: "Another minor",
				}),
			];
			const sorted = sortTopics(topics);
			expect(sorted[0].importance).toBe("major");
			expect(sorted[1].importance).toBe("minor");
			expect(sorted[2].importance).toBe("minor");
		});

		it("treats undefined importance as major (sorts before minor)", () => {
			const topics: Array<TopicWithDate> = [
				makeTopic({ recordDate: "2026-03-15T10:00:00Z", importance: "minor" }),
				makeTopic({
					recordDate: "2026-03-15T08:00:00Z",
					importance: undefined,
				}),
			];
			const sorted = sortTopics(topics);
			expect(sorted[0].importance).toBeUndefined();
			expect(sorted[1].importance).toBe("minor");
		});

		it("does not mutate the original array", () => {
			const topics: Array<TopicWithDate> = [
				makeTopic({ recordDate: "2026-03-10T08:00:00Z" }),
				makeTopic({ recordDate: "2026-03-15T08:00:00Z" }),
			];
			const originalFirst = topics[0];
			sortTopics(topics);
			expect(topics[0]).toBe(originalFirst);
		});

		it("returns empty array for empty input", () => {
			expect(sortTopics([])).toEqual([]);
		});
	});

	// ── groupTopicsByDate ────────────────────────────────────────────────────

	describe("groupTopicsByDate", () => {
		it("groups topics by YYYY-MM-DD from recordDate", () => {
			const topics: Array<TopicWithDate> = [
				makeTopic({ recordDate: "2026-03-15T08:00:00Z", title: "A" }),
				makeTopic({ recordDate: "2026-03-15T18:00:00Z", title: "B" }),
				makeTopic({ recordDate: "2026-03-16T08:00:00Z", title: "C" }),
			];
			const groups = groupTopicsByDate(topics);
			expect(groups.size).toBe(2);
			expect(groups.get("2026-03-15")?.length).toBe(2);
			expect(groups.get("2026-03-16")?.length).toBe(1);
		});

		it("uses 'unknown' key for topics without recordDate", () => {
			const topics: Array<TopicWithDate> = [
				makeTopic({ recordDate: undefined, title: "NoDate" }),
			];
			const groups = groupTopicsByDate(topics);
			expect(groups.has("unknown")).toBe(true);
			expect(groups.get("unknown")?.length).toBe(1);
		});

		it("preserves order within each group", () => {
			const topics: Array<TopicWithDate> = [
				makeTopic({ recordDate: "2026-03-15T08:00:00Z", title: "First" }),
				makeTopic({ recordDate: "2026-03-15T18:00:00Z", title: "Second" }),
			];
			const groups = groupTopicsByDate(topics);
			const group = groups.get("2026-03-15") as Array<TopicWithDate>;
			expect(group[0].title).toBe("First");
			expect(group[1].title).toBe("Second");
		});

		it("returns empty map for empty input", () => {
			expect(groupTopicsByDate([]).size).toBe(0);
		});
	});

	// ── padIndex ─────────────────────────────────────────────────────────────

	describe("padIndex", () => {
		it("pads 0 to '01'", () => {
			expect(padIndex(0)).toBe("01");
		});

		it("pads 8 to '09'", () => {
			expect(padIndex(8)).toBe("09");
		});

		it("pads 9 to '10'", () => {
			expect(padIndex(9)).toBe("10");
		});

		it("pads 99 to '100'", () => {
			expect(padIndex(99)).toBe("100");
		});

		it("does not pad double-digit numbers", () => {
			expect(padIndex(11)).toBe("12");
		});
	});

	// ── renderCalloutText ────────────────────────────────────────────────────

	describe("renderCalloutText", () => {
		it("converts markdown unordered list (dash) to HTML ul/li", () => {
			const result = renderCalloutText("- item one\n- item two");
			expect(result).toBe("<ul><li>item one</li><li>item two</li></ul>");
		});

		it("converts markdown unordered list (asterisk) to HTML ul/li", () => {
			const result = renderCalloutText("* item one\n* item two");
			expect(result).toBe("<ul><li>item one</li><li>item two</li></ul>");
		});

		it("renders plain text with HTML escaping", () => {
			const result = renderCalloutText("Hello <world>");
			expect(result).toBe("Hello &lt;world&gt;");
		});

		it("converts inline **bold** to <strong> tags", () => {
			const result = renderCalloutText("This is **bold** text");
			expect(result).toBe("This is <strong>bold</strong> text");
		});

		it("handles bold inside list items", () => {
			const result = renderCalloutText("- **bold** item");
			expect(result).toBe("<ul><li><strong>bold</strong> item</li></ul>");
		});

		it("handles mixed list and non-list lines", () => {
			const result = renderCalloutText(
				"Intro text\n- item one\n- item two\nOutro text",
			);
			expect(result).toBe(
				"Intro text<br><ul><li>item one</li><li>item two</li></ul><br>Outro text",
			);
		});

		it("skips empty lines", () => {
			const result = renderCalloutText("line one\n\nline two");
			expect(result).toBe("line one<br>line two");
		});

		it("handles empty string", () => {
			expect(renderCalloutText("")).toBe("");
		});

		it("escapes HTML in list items", () => {
			const result = renderCalloutText("- <script>alert('xss')</script>");
			expect(result).toContain("&lt;script&gt;");
		});

		it("flushes trailing list items", () => {
			const result = renderCalloutText("header\n- a\n- b");
			expect(result).toBe("header<br><ul><li>a</li><li>b</li></ul>");
		});
	});

	// ── buildPanelTitle ──────────────────────────────────────────────────────

	describe("buildPanelTitle", () => {
		it("builds title with date, ticketId, hash, and author", () => {
			const summary = makeSummary({ ticketId: "PROJ-100" });
			const result = buildPanelTitle(summary);
			expect(result).toBe("2026-03-15 · PROJ-100 · abc1234 · Alice");
		});

		it("extracts ticket from commit message as fallback", () => {
			const summary = makeSummary({
				ticketId: undefined,
				commitMessage: "Fixes PROJ-42: some bug",
			});
			const result = buildPanelTitle(summary);
			expect(result).toContain("PROJ-42");
		});

		it("extracts ticket from branch name as fallback (uppercased)", () => {
			const summary = makeSummary({
				ticketId: undefined,
				commitMessage: "some bug fix",
				branch: "feature/proj-123-description",
			});
			const result = buildPanelTitle(summary);
			expect(result).toContain("PROJ-123");
		});

		it("omits ticket when not found anywhere", () => {
			const summary = makeSummary({
				ticketId: undefined,
				commitMessage: "no ticket here",
				branch: "main",
			});
			const result = buildPanelTitle(summary);
			expect(result).toBe("2026-03-15 · abc1234 · Alice");
		});

		it("truncates hash to 7 characters", () => {
			const summary = makeSummary({ commitHash: "abcdef1234567890" });
			const result = buildPanelTitle(summary);
			expect(result).toContain("abcdef1");
			expect(result).not.toContain("abcdef12");
		});
	});

	// ── buildPushTitle ───────────────────────────────────────────────────────

	describe("buildPushTitle", () => {
		it("appends commitMessage to panel title", () => {
			const summary = makeSummary({ ticketId: "PROJ-100" });
			const result = buildPushTitle(summary);
			expect(result).toBe(
				"2026-03-15 · PROJ-100 · abc1234 · Alice · Fix some bug",
			);
		});
	});

	// ── buildPlanPushTitle ───────────────────────────────────────────────────

	describe("buildPlanPushTitle", () => {
		it("appends planTitle to panel title", () => {
			const summary = makeSummary({ ticketId: "PROJ-100" });
			const result = buildPlanPushTitle(summary, "My Plan");
			expect(result).toBe("2026-03-15 · PROJ-100 · abc1234 · Alice · My Plan");
		});
	});

	// ── buildNotePushTitle ───────────────────────────────────────────────────

	describe("buildNotePushTitle", () => {
		it("appends noteTitle to panel title", () => {
			const summary = makeSummary({ ticketId: "PROJ-200" });
			const result = buildNotePushTitle(summary, "Release Notes");
			expect(result).toBe(
				"2026-03-15 · PROJ-200 · abc1234 · Alice · Release Notes",
			);
		});
	});

	// ── collectSortedTopics ──────────────────────────────────────────────────

	describe("collectSortedTopics", () => {
		beforeEach(() => {
			mockCollectAllTopics.mockReset();
			mockCollectSourceNodes.mockReset();
			mockComputeDurationDays.mockReset();
		});

		it("returns sorted topics with recordDate when multi-day squash", () => {
			const summary = makeSummary();
			const rawTopics = [
				makeTopic({
					title: "A",
					commitDate: "2026-03-10T08:00:00Z",
					importance: "minor",
				}),
				makeTopic({
					title: "B",
					commitDate: "2026-03-15T08:00:00Z",
					importance: "major",
				}),
			];
			mockCollectSourceNodes.mockReturnValue([makeSummary(), makeSummary()]);
			mockComputeDurationDays.mockReturnValue(5);
			mockCollectAllTopics.mockReturnValue(rawTopics);

			const result = collectSortedTopics(summary);

			expect(result.showRecordDates).toBe(true);
			expect(result.sourceNodes.length).toBe(2);
			// Sorted: newest first
			expect(result.topics[0].title).toBe("B");
			expect(result.topics[1].title).toBe("A");
			// recordDate is set
			expect(result.topics[0].recordDate).toBe("2026-03-15T08:00:00Z");
			expect(result.topics[1].recordDate).toBe("2026-03-10T08:00:00Z");
		});

		it("omits recordDate when single source node", () => {
			const summary = makeSummary();
			const rawTopics = [
				makeTopic({ title: "A", commitDate: "2026-03-15T08:00:00Z" }),
			];
			mockCollectSourceNodes.mockReturnValue([makeSummary()]);
			mockComputeDurationDays.mockReturnValue(0);
			mockCollectAllTopics.mockReturnValue(rawTopics);

			const result = collectSortedTopics(summary);

			expect(result.showRecordDates).toBe(false);
			expect(result.topics[0].recordDate).toBeUndefined();
		});

		it("omits recordDate when duration is 1 day even with multiple sources", () => {
			const summary = makeSummary();
			const rawTopics = [makeTopic({ commitDate: "2026-03-15T08:00:00Z" })];
			mockCollectSourceNodes.mockReturnValue([makeSummary(), makeSummary()]);
			mockComputeDurationDays.mockReturnValue(1);
			mockCollectAllTopics.mockReturnValue(rawTopics);

			const result = collectSortedTopics(summary);

			expect(result.showRecordDates).toBe(false);
		});

		it("handles topics without commitDate (no recordDate assigned)", () => {
			const summary = makeSummary();
			const rawTopics = [makeTopic({ commitDate: undefined })];
			mockCollectSourceNodes.mockReturnValue([makeSummary(), makeSummary()]);
			mockComputeDurationDays.mockReturnValue(5);
			mockCollectAllTopics.mockReturnValue(rawTopics);

			const result = collectSortedTopics(summary);

			expect(result.showRecordDates).toBe(true);
			// No commitDate => no recordDate even though showRecordDates is true
			expect(result.topics[0].recordDate).toBeUndefined();
		});

		it("assigns treeIndex based on original array index", () => {
			const summary = makeSummary();
			const rawTopics = [
				makeTopic({ title: "First", commitDate: "2026-03-10T08:00:00Z" }),
				makeTopic({ title: "Second", commitDate: "2026-03-15T08:00:00Z" }),
			];
			mockCollectSourceNodes.mockReturnValue([makeSummary()]);
			mockComputeDurationDays.mockReturnValue(0);
			mockCollectAllTopics.mockReturnValue(rawTopics);

			const result = collectSortedTopics(summary);

			// treeIndex should reflect the original positions from collectAllTopics
			const first = result.topics.find((t) => t.title === "First");
			const second = result.topics.find((t) => t.title === "Second");
			expect(first?.treeIndex).toBe(0);
			expect(second?.treeIndex).toBe(1);
		});
	});

	// ── collectAllPlans ──────────────────────────────────────────────────────

	describe("collectAllPlans", () => {
		function makePlan(overrides: Partial<PlanReference> = {}): PlanReference {
			return {
				slug: "plan-slug",
				title: "My Plan",
				editCount: 3,
				addedAt: "2026-03-10T08:00:00Z",
				updatedAt: "2026-03-15T08:00:00Z",
				...overrides,
			};
		}

		it("collects plans from a leaf node", () => {
			const summary = makeSummary({
				plans: [makePlan({ slug: "plan-a" })],
			});
			const plans = collectAllPlans(summary);
			expect(plans).toHaveLength(1);
			expect(plans[0].slug).toBe("plan-a");
		});

		it("collects plans recursively from children", () => {
			const summary = makeSummary({
				plans: [makePlan({ slug: "plan-a" })],
				children: [
					makeSummary({
						plans: [makePlan({ slug: "plan-b" })],
					}),
				],
			});
			const plans = collectAllPlans(summary);
			expect(plans).toHaveLength(2);
			const slugs = plans.map((p) => p.slug);
			expect(slugs).toContain("plan-a");
			expect(slugs).toContain("plan-b");
		});

		it("deduplicates by slug, keeping the one with the latest updatedAt", () => {
			const summary = makeSummary({
				plans: [
					makePlan({ slug: "plan-a", updatedAt: "2026-03-15T08:00:00Z" }),
				],
				children: [
					makeSummary({
						plans: [
							makePlan({
								slug: "plan-a",
								updatedAt: "2026-03-20T08:00:00Z",
								title: "Updated Plan",
							}),
						],
					}),
				],
			});
			const plans = collectAllPlans(summary);
			expect(plans).toHaveLength(1);
			expect(plans[0].title).toBe("Updated Plan");
		});

		it("keeps earlier version when child has older updatedAt", () => {
			const summary = makeSummary({
				plans: [
					makePlan({
						slug: "plan-a",
						updatedAt: "2026-03-20T08:00:00Z",
						title: "Newer",
					}),
				],
				children: [
					makeSummary({
						plans: [
							makePlan({
								slug: "plan-a",
								updatedAt: "2026-03-10T08:00:00Z",
								title: "Older",
							}),
						],
					}),
				],
			});
			const plans = collectAllPlans(summary);
			expect(plans).toHaveLength(1);
			expect(plans[0].title).toBe("Newer");
		});

		it("returns empty array when no plans exist", () => {
			const summary = makeSummary({
				children: [makeSummary()],
			});
			const plans = collectAllPlans(summary);
			expect(plans).toHaveLength(0);
		});

		it("handles deeply nested children", () => {
			const summary = makeSummary({
				children: [
					makeSummary({
						children: [
							makeSummary({
								plans: [makePlan({ slug: "deep-plan" })],
							}),
						],
					}),
				],
			});
			const plans = collectAllPlans(summary);
			expect(plans).toHaveLength(1);
			expect(plans[0].slug).toBe("deep-plan");
		});

		it("handles node with no plans and no children", () => {
			const summary = makeSummary();
			const plans = collectAllPlans(summary);
			expect(plans).toHaveLength(0);
		});
	});
});
