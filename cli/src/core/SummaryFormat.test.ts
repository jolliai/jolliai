import { describe, expect, it } from "vitest";
import type { CommitSummary, PlanReference } from "../Types.js";
import {
	buildNotePushTitle,
	buildPanelTitle,
	buildPlanPushTitle,
	buildPushTitle,
	collectAllPlans,
	collectSortedTopics,
	formatDate,
	formatFullDate,
	groupTopicsByDate,
	padIndex,
	sortTopics,
	type TopicWithDate,
} from "./SummaryFormat.js";

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
		topics: [{ title: "Topic A", trigger: "t", response: "r", decisions: "d" }],
		...overrides,
	};
}

function makeTopic(overrides: Partial<TopicWithDate> = {}): TopicWithDate {
	return {
		title: "Topic",
		trigger: "trigger",
		response: "response",
		decisions: "decisions",
		...overrides,
	};
}

// ─── formatDate ─────────────────────────────────────────────────────────────

describe("formatDate", () => {
	it("formats an ISO date to short format", () => {
		expect(formatDate("2026-04-05T14:30:00Z")).toBe("Apr 5, 2026");
	});

	it("returns 'Invalid Date' for unparseable input (does not throw)", () => {
		// new Date("not-a-date") produces "Invalid Date" — the catch block only fires on thrown errors
		expect(formatDate("not-a-date")).toBe("Invalid Date");
	});
});

// ─── formatFullDate ─────────────────────────────────────────────────────────

describe("formatFullDate", () => {
	it("formats an ISO date to full date+time", () => {
		const result = formatFullDate("2026-02-27T19:49:00Z");
		expect(result).toContain("2026");
		// Exact day depends on timezone; just check year + month
		expect(result).toContain("February");
	});

	it("returns 'Invalid Date' for unparseable input (does not throw)", () => {
		expect(formatFullDate("garbage")).toBe("Invalid Date");
	});
});

// ─── sortTopics ─────────────────────────────────────────────────────────────

describe("sortTopics", () => {
	it("sorts by recordDate descending (newest first)", () => {
		const topics = [
			makeTopic({ title: "Old", recordDate: "2026-01-01T00:00:00Z" }),
			makeTopic({ title: "New", recordDate: "2026-03-15T00:00:00Z" }),
		];
		const sorted = sortTopics(topics);
		expect(sorted[0].title).toBe("New");
		expect(sorted[1].title).toBe("Old");
	});

	it("sorts major before minor within same day", () => {
		const topics = [
			makeTopic({ title: "Minor", importance: "minor", recordDate: "2026-03-01T10:00:00Z" }),
			makeTopic({ title: "Major", importance: "major", recordDate: "2026-03-01T12:00:00Z" }),
		];
		const sorted = sortTopics(topics);
		expect(sorted[0].title).toBe("Major");
		expect(sorted[1].title).toBe("Minor");
	});

	it("sorts by importance when topics share the same day", () => {
		const topics = [
			makeTopic({ title: "Minor", importance: "minor", recordDate: "2026-03-01T08:00:00Z" }),
			makeTopic({ title: "Major", recordDate: "2026-03-01T12:00:00Z" }),
		];
		const sorted = sortTopics(topics);
		expect(sorted[0].title).toBe("Major");
		expect(sorted[1].title).toBe("Minor");
	});

	it("handles topics without recordDate", () => {
		const topics = [
			makeTopic({ title: "No date" }),
			makeTopic({ title: "Has date", recordDate: "2026-01-01T00:00:00Z" }),
		];
		const sorted = sortTopics(topics);
		expect(sorted[0].title).toBe("Has date");
		expect(sorted[1].title).toBe("No date");
	});

	it("does not mutate the original array", () => {
		const topics = [
			makeTopic({ title: "B", recordDate: "2026-01-01T00:00:00Z" }),
			makeTopic({ title: "A", recordDate: "2026-03-01T00:00:00Z" }),
		];
		const original = [...topics];
		sortTopics(topics);
		expect(topics).toEqual(original);
	});
});

// ─── groupTopicsByDate ──────────────────────────────────────────────────────

describe("groupTopicsByDate", () => {
	it("groups topics by YYYY-MM-DD", () => {
		const topics = [
			makeTopic({ title: "A", recordDate: "2026-03-01T10:00:00Z" }),
			makeTopic({ title: "B", recordDate: "2026-03-01T14:00:00Z" }),
			makeTopic({ title: "C", recordDate: "2026-03-02T09:00:00Z" }),
		];
		const groups = groupTopicsByDate(topics);
		expect(groups.size).toBe(2);
		expect(groups.get("2026-03-01")).toHaveLength(2);
		expect(groups.get("2026-03-02")).toHaveLength(1);
	});

	it("uses 'unknown' key for topics without recordDate", () => {
		const topics = [makeTopic({ title: "No date" })];
		const groups = groupTopicsByDate(topics);
		expect(groups.get("unknown")).toHaveLength(1);
	});
});

// ─── padIndex ───────────────────────────────────────────────────────────────

describe("padIndex", () => {
	it("pads single digit to two digits", () => {
		expect(padIndex(0)).toBe("01");
		expect(padIndex(8)).toBe("09");
	});

	it("does not pad double digit", () => {
		expect(padIndex(11)).toBe("12");
		expect(padIndex(98)).toBe("99");
	});
});

// ─── buildPanelTitle ────────────────────────────────────────────────────────

describe("buildPanelTitle", () => {
	it("builds title with date, ticket, hash, author", () => {
		const title = buildPanelTitle(leaf({ ticketId: "PROJ-123" }));
		expect(title).toContain("2026-03-01");
		expect(title).toContain("PROJ-123");
		expect(title).toContain("abc1234");
		expect(title).toContain("Test User");
	});

	it("extracts ticket from commit message when ticketId is absent", () => {
		const title = buildPanelTitle(leaf({ commitMessage: "Closes PROJ-456: fix bug" }));
		expect(title).toContain("PROJ-456");
	});

	it("extracts ticket from branch when not in commit message", () => {
		const title = buildPanelTitle(leaf({ commitMessage: "fix bug", branch: "feature/proj-789-refactor" }));
		expect(title).toContain("PROJ-789");
	});

	it("omits ticket when none found", () => {
		const title = buildPanelTitle(leaf({ commitMessage: "update readme", branch: "main" }));
		expect(title).not.toContain("undefined");
		// Still has date, hash, author
		expect(title).toContain("2026-03-01");
	});
});

// ─── buildPushTitle ─────────────────────────────────────────────────────────

describe("buildPushTitle", () => {
	it("includes commit message and sanitizes forbidden characters", () => {
		const title = buildPushTitle(leaf({ commitMessage: 'fix: remove "bad" chars <tag>' }));
		expect(title).not.toContain('"');
		expect(title).not.toContain("<");
		expect(title).not.toContain(">");
		expect(title).toContain("fix");
	});
});

// ─── buildPlanPushTitle / buildNotePushTitle ─────────────────────────────────

describe("buildPlanPushTitle", () => {
	it("appends plan title to panel title", () => {
		const title = buildPlanPushTitle(leaf(), "My Plan");
		expect(title).toContain("My Plan");
		expect(title).toContain("2026-03-01");
	});
});

describe("buildNotePushTitle", () => {
	it("appends note title to panel title", () => {
		const title = buildNotePushTitle(leaf(), "My Note");
		expect(title).toContain("My Note");
		expect(title).toContain("2026-03-01");
	});
});

// ─── collectSortedTopics ────────────────────────────────────────────────────

describe("collectSortedTopics", () => {
	it("collects and sorts topics from a leaf node", () => {
		const summary = leaf({
			topics: [
				{ title: "A", trigger: "t", response: "r", decisions: "d" },
				{ title: "B", trigger: "t", response: "r", decisions: "d" },
			],
		});
		const { topics, showRecordDates } = collectSortedTopics(summary);
		expect(topics).toHaveLength(2);
		expect(showRecordDates).toBe(false);
	});

	it("returns showRecordDates=true for multi-day squash", () => {
		const summary = leaf({
			commitDate: "2026-03-05T10:00:00.000Z",
			generatedAt: "2026-03-05T10:01:00.000Z",
			topics: [],
			children: [
				leaf({
					commitDate: "2026-03-01T10:00:00.000Z",
					generatedAt: "2026-03-01T10:00:10.000Z",
					commitHash: "aaa",
				}),
				leaf({
					commitDate: "2026-03-05T09:00:00.000Z",
					generatedAt: "2026-03-05T09:00:10.000Z",
					commitHash: "bbb",
				}),
			],
		});
		const { showRecordDates } = collectSortedTopics(summary);
		expect(showRecordDates).toBe(true);
	});

	it("returns empty topics for a summary with no topics", () => {
		const { topics } = collectSortedTopics(leaf({ topics: undefined }));
		expect(topics).toHaveLength(0);
	});
});

// ─── collectAllPlans ────────────────────────────────────────────────────────

describe("collectAllPlans", () => {
	it("collects plans from a leaf node", () => {
		const plan: PlanReference = {
			slug: "plan-one",
			title: "Plan One",
			editCount: 2,
			addedAt: "2026-01-01",
			updatedAt: "2026-01-15",
		};
		const plans = collectAllPlans(leaf({ plans: [plan] }));
		expect(plans).toHaveLength(1);
		expect(plans[0].slug).toBe("plan-one");
	});

	it("deduplicates by slug, keeping the most recently updated", () => {
		const older: PlanReference = {
			slug: "plan-x",
			title: "Plan X v1",
			editCount: 1,
			addedAt: "2026-01-01",
			updatedAt: "2026-01-10",
		};
		const newer: PlanReference = {
			slug: "plan-x",
			title: "Plan X v2",
			editCount: 3,
			addedAt: "2026-01-01",
			updatedAt: "2026-01-20",
		};
		const summary = leaf({
			plans: [older],
			children: [leaf({ plans: [newer], commitHash: "child1" })],
		});
		const plans = collectAllPlans(summary);
		expect(plans).toHaveLength(1);
		expect(plans[0].title).toBe("Plan X v2");
	});

	it("keeps newer plan when older duplicate is encountered later", () => {
		const newer: PlanReference = {
			slug: "plan-x",
			title: "Plan X v2",
			editCount: 3,
			addedAt: "2026-01-01",
			updatedAt: "2026-01-20",
		};
		const older: PlanReference = {
			slug: "plan-x",
			title: "Plan X v1",
			editCount: 1,
			addedAt: "2026-01-01",
			updatedAt: "2026-01-10",
		};
		// Newer is in parent, older is in child — older should NOT overwrite newer
		const summary = leaf({
			plans: [newer],
			children: [leaf({ plans: [older], commitHash: "child1" })],
		});
		const plans = collectAllPlans(summary);
		expect(plans).toHaveLength(1);
		expect(plans[0].title).toBe("Plan X v2");
	});

	it("returns empty array when no plans exist", () => {
		expect(collectAllPlans(leaf())).toHaveLength(0);
	});

	it("collects plans from nested children", () => {
		const summary = leaf({
			children: [
				leaf({
					commitHash: "child1",
					plans: [{ slug: "p1", title: "P1", editCount: 1, addedAt: "2026-01-01", updatedAt: "2026-01-01" }],
					children: [
						leaf({
							commitHash: "grandchild",
							plans: [
								{
									slug: "p2",
									title: "P2",
									editCount: 1,
									addedAt: "2026-01-01",
									updatedAt: "2026-01-01",
								},
							],
						}),
					],
				}),
			],
		});
		const plans = collectAllPlans(summary);
		expect(plans).toHaveLength(2);
	});
});
