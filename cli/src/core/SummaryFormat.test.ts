import { describe, expect, it } from "vitest";
import type { CommitSummary, NoteReference, PlanReference } from "../Types.js";
import {
	buildNotePushTitle,
	buildPanelTitle,
	buildPlanPushTitle,
	buildPushTitle,
	buildReferencePushTitle,
	collectAllNotes,
	collectAllNotesWithHosts,
	collectAllPlans,
	collectAllPlansWithHosts,
	collectSortedTopics,
	formatDate,
	formatFullDate,
	formatProviderLabel,
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
	it("sorts by source date descending (newest first)", () => {
		const topics = [
			makeTopic({ title: "Old", commitDate: "2026-01-01T00:00:00Z" }),
			makeTopic({ title: "New", commitDate: "2026-03-15T00:00:00Z" }),
		];
		const sorted = sortTopics(topics);
		expect(sorted[0].title).toBe("New");
		expect(sorted[1].title).toBe("Old");
	});

	it("prefers generatedAt over commitDate for the date key", () => {
		// generatedAt is the "(re)summary generation time" — always wins when present.
		const topics = [
			makeTopic({
				title: "Old",
				commitDate: "2026-03-15T00:00:00Z",
				generatedAt: "2026-01-01T00:00:00Z",
			}),
			makeTopic({
				title: "New",
				commitDate: "2026-01-01T00:00:00Z",
				generatedAt: "2026-03-15T00:00:00Z",
			}),
		];
		const sorted = sortTopics(topics);
		expect(sorted[0].title).toBe("New");
		expect(sorted[1].title).toBe("Old");
	});

	it("sorts major before minor within same day", () => {
		const topics = [
			makeTopic({ title: "Minor", importance: "minor", commitDate: "2026-03-01T10:00:00Z" }),
			makeTopic({ title: "Major", importance: "major", commitDate: "2026-03-01T12:00:00Z" }),
		];
		const sorted = sortTopics(topics);
		expect(sorted[0].title).toBe("Major");
		expect(sorted[1].title).toBe("Minor");
	});

	it("sorts by importance when topics share the same day", () => {
		const topics = [
			makeTopic({ title: "Minor", importance: "minor", commitDate: "2026-03-01T08:00:00Z" }),
			makeTopic({ title: "Major", commitDate: "2026-03-01T12:00:00Z" }),
		];
		const sorted = sortTopics(topics);
		expect(sorted[0].title).toBe("Major");
		expect(sorted[1].title).toBe("Minor");
	});

	it("handles topics without any date (lands at the bottom)", () => {
		const topics = [
			makeTopic({ title: "No date" }),
			makeTopic({ title: "Has date", commitDate: "2026-01-01T00:00:00Z" }),
		];
		const sorted = sortTopics(topics);
		expect(sorted[0].title).toBe("Has date");
		expect(sorted[1].title).toBe("No date");
	});

	it("does not mutate the original array", () => {
		const topics = [
			makeTopic({ title: "B", commitDate: "2026-01-01T00:00:00Z" }),
			makeTopic({ title: "A", commitDate: "2026-03-01T00:00:00Z" }),
		];
		const original = [...topics];
		sortTopics(topics);
		expect(topics).toEqual(original);
	});

	it("exercises both dayA>dayB and dayA<dayB branches via 3-element sort", () => {
		// With 3+ elements, V8's TimSort invokes the compare callback in both
		// directions (compare(a,b) AND compare(b,a) for adjacent pairs), so
		// both `-1` and `1` ternary outcomes get hit in a single test call.
		const topics = [
			makeTopic({ title: "Mid", commitDate: "2026-02-01T00:00:00Z" }),
			makeTopic({ title: "Old", commitDate: "2026-01-01T00:00:00Z" }),
			makeTopic({ title: "New", commitDate: "2026-03-15T00:00:00Z" }),
		];
		const sorted = sortTopics(topics);
		expect(sorted.map((t) => t.title)).toEqual(["New", "Mid", "Old"]);
	});

	it("treats topics with no date as same-day (sort by importance only)", () => {
		// Both topics have no generatedAt/commitDate — both fall to the "" → ""
		// dayKey, so the sort collapses to importance ordering. This pins the
		// `commitDate || ""` final-fallback branch.
		const topics = [
			makeTopic({ title: "Minor", importance: "minor" }),
			makeTopic({ title: "Major", importance: "major" }),
		];
		const sorted = sortTopics(topics);
		expect(sorted[0].importance).toBe("major");
		expect(sorted[1].importance).toBe("minor");
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
	it("returns the commit message with forbidden characters sanitized", () => {
		const title = buildPushTitle(leaf({ commitMessage: 'fix: remove "bad" chars <tag>' }));
		expect(title).not.toContain('"');
		expect(title).not.toContain("<");
		expect(title).not.toContain(">");
		expect(title).toContain("fix");
		// No date/ticket/hash/author prefix.
		expect(title).not.toContain("2026-03-01");
		expect(title).not.toContain("abc1234");
	});
});

// ─── buildPlanPushTitle / buildNotePushTitle ─────────────────────────────────

describe("buildPlanPushTitle", () => {
	it("returns the plan title without metadata prefix", () => {
		const title = buildPlanPushTitle(leaf(), "My Plan");
		expect(title).toBe("My Plan");
	});
});

describe("buildNotePushTitle", () => {
	it("returns the note title without metadata prefix", () => {
		const title = buildNotePushTitle(leaf(), "My Note");
		expect(title).toBe("My Note");
	});
});

describe("buildReferencePushTitle", () => {
	it("leads with the source label + nativeId for tracker sources", () => {
		expect(buildReferencePushTitle({ source: "linear", nativeId: "ENG-123", title: "Fix login bug" })).toBe(
			"Linear · ENG-123 — Fix login bug",
		);
		expect(buildReferencePushTitle({ source: "github", nativeId: "owner/repo#42", title: "Bug" })).toBe(
			// `/` in the nativeId is stripped by sanitizeTitle (path-unsafe), leaving a space.
			"GitHub · owner repo#42 — Bug",
		);
	});

	it("leads with the source label alone for machine-id sources (no ugly id prefix)", () => {
		// Slack/Notion nativeIds are machine ids, so the display title is title-only;
		// the source label still scopes the slug into a per-source namespace.
		expect(buildReferencePushTitle({ source: "slack", nativeId: "C1-1700000000.1", title: "Deploy thread" })).toBe(
			"Slack · Deploy thread",
		);
		expect(buildReferencePushTitle({ source: "notion", nativeId: "abcdef12", title: "Onboarding doc" })).toBe(
			"Notion · Onboarding doc",
		);
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
		const { topics } = collectSortedTopics(summary);
		expect(topics).toHaveLength(2);
	});

	it("returns sourceNodes for the Source Commits section", () => {
		// v3 squash root with 2 children — sourceNodes lists both leaf descendants.
		const summary = leaf({
			topics: [],
			children: [leaf({ commitHash: "aaa" }), leaf({ commitHash: "bbb" })],
		});
		const { sourceNodes } = collectSortedTopics(summary);
		expect(sourceNodes).toHaveLength(2);
	});

	it("returns empty topics for a summary with no topics", () => {
		const { topics } = collectSortedTopics(leaf({ topics: undefined }));
		expect(topics).toHaveLength(0);
	});

	it("assigns a stable treeIndex to each topic for edit/delete operations", () => {
		const summary = leaf({
			topics: [
				{ title: "A", trigger: "t", response: "r", decisions: "d" },
				{ title: "B", trigger: "t", response: "r", decisions: "d" },
				{ title: "C", trigger: "t", response: "r", decisions: "d" },
			],
		});
		const { topics } = collectSortedTopics(summary);
		// treeIndex matches the original collectDisplayTopics order, independent
		// of post-sort display order.
		expect(topics.every((t) => typeof t.treeIndex === "number")).toBe(true);
		const indices = topics.map((t) => t.treeIndex).sort();
		expect(indices).toEqual([0, 1, 2]);
	});
});

// ─── collectAllPlans ────────────────────────────────────────────────────────

describe("collectAllPlans", () => {
	it("collects plans from a leaf node", () => {
		const plan: PlanReference = {
			slug: "plan-one",
			title: "Plan One",
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
			addedAt: "2026-01-01",
			updatedAt: "2026-01-10",
		};
		const newer: PlanReference = {
			slug: "plan-x",
			title: "Plan X v2",
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
			addedAt: "2026-01-01",
			updatedAt: "2026-01-20",
		};
		const older: PlanReference = {
			slug: "plan-x",
			title: "Plan X v1",
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
					plans: [{ slug: "p1", title: "P1", addedAt: "2026-01-01", updatedAt: "2026-01-01" }],
					children: [
						leaf({
							commitHash: "grandchild",
							plans: [
								{
									slug: "p2",
									title: "P2",
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

// ─── collectAllNotes ────────────────────────────────────────────────────────

function noteRef(overrides: Partial<NoteReference> = {}): NoteReference {
	return {
		id: "note-1",
		title: "Note 1",
		format: "markdown",
		addedAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("collectAllNotes", () => {
	it("collects notes from a leaf node", () => {
		const notes = collectAllNotes(leaf({ notes: [noteRef()] }));
		expect(notes).toHaveLength(1);
		expect(notes[0].id).toBe("note-1");
	});

	it("deduplicates by id, keeping the most recently updated", () => {
		const older = noteRef({ id: "note-x", title: "v1", updatedAt: "2026-01-10" });
		const newer = noteRef({ id: "note-x", title: "v2", updatedAt: "2026-01-20" });
		const summary = leaf({
			notes: [older],
			children: [leaf({ notes: [newer], commitHash: "child1" })],
		});
		const notes = collectAllNotes(summary);
		expect(notes).toHaveLength(1);
		expect(notes[0].title).toBe("v2");
	});

	it("keeps newer note when an older duplicate is encountered later in the walk", () => {
		const newer = noteRef({ id: "note-x", title: "v2", updatedAt: "2026-01-20" });
		const older = noteRef({ id: "note-x", title: "v1", updatedAt: "2026-01-10" });
		const summary = leaf({
			notes: [newer],
			children: [leaf({ notes: [older], commitHash: "child1" })],
		});
		const notes = collectAllNotes(summary);
		expect(notes).toHaveLength(1);
		expect(notes[0].title).toBe("v2");
	});

	it("returns empty array when no notes exist", () => {
		expect(collectAllNotes(leaf())).toHaveLength(0);
	});

	it("collects notes from nested children", () => {
		const summary = leaf({
			children: [
				leaf({
					commitHash: "child1",
					notes: [noteRef({ id: "n1" })],
					children: [leaf({ commitHash: "grandchild", notes: [noteRef({ id: "n2" })] })],
				}),
			],
		});
		const notes = collectAllNotes(summary);
		expect(notes).toHaveLength(2);
	});
});

// ─── collectAllPlansWithHosts ───────────────────────────────────────────────

describe("collectAllPlansWithHosts", () => {
	it("reports the host commit hash for each plan", () => {
		const plan: PlanReference = {
			slug: "p1",
			title: "P1",
			addedAt: "2026-01-01",
			updatedAt: "2026-01-01",
		};
		const summary = leaf({ commitHash: "root123", plans: [plan] });
		const result = collectAllPlansWithHosts(summary);
		expect(result).toHaveLength(1);
		expect(result[0].planRef.slug).toBe("p1");
		expect(result[0].hostCommitHash).toBe("root123");
	});

	it("reports the child commit hash when the plan lives in a child", () => {
		const plan: PlanReference = {
			slug: "p1",
			title: "P1",
			addedAt: "2026-01-01",
			updatedAt: "2026-01-01",
		};
		const summary = leaf({ commitHash: "root123", children: [leaf({ commitHash: "child456", plans: [plan] })] });
		const result = collectAllPlansWithHosts(summary);
		expect(result).toHaveLength(1);
		expect(result[0].hostCommitHash).toBe("child456");
	});

	it("dedupes by slug and keeps the winner's host hash", () => {
		const older: PlanReference = {
			slug: "p1",
			title: "v1",
			addedAt: "2026-01-01",
			updatedAt: "2026-01-10",
		};
		const newer: PlanReference = {
			slug: "p1",
			title: "v2",
			addedAt: "2026-01-01",
			updatedAt: "2026-01-20",
		};
		const summary = leaf({
			commitHash: "root",
			plans: [older],
			children: [leaf({ commitHash: "child", plans: [newer] })],
		});
		const result = collectAllPlansWithHosts(summary);
		expect(result).toHaveLength(1);
		expect(result[0].planRef.title).toBe("v2");
		expect(result[0].hostCommitHash).toBe("child");
	});

	it("returns empty array when no plans exist", () => {
		expect(collectAllPlansWithHosts(leaf())).toHaveLength(0);
	});
});

// ─── collectAllNotesWithHosts ───────────────────────────────────────────────

describe("collectAllNotesWithHosts", () => {
	it("reports the host commit hash for each note", () => {
		const summary = leaf({ commitHash: "root123", notes: [noteRef()] });
		const result = collectAllNotesWithHosts(summary);
		expect(result).toHaveLength(1);
		expect(result[0].noteRef.id).toBe("note-1");
		expect(result[0].hostCommitHash).toBe("root123");
	});

	it("reports the child commit hash when the note lives in a child", () => {
		const summary = leaf({
			commitHash: "root",
			children: [leaf({ commitHash: "child", notes: [noteRef({ id: "n1" })] })],
		});
		const result = collectAllNotesWithHosts(summary);
		expect(result).toHaveLength(1);
		expect(result[0].hostCommitHash).toBe("child");
	});

	it("dedupes by id and keeps the winner's host hash", () => {
		const older = noteRef({ id: "n1", title: "v1", updatedAt: "2026-01-10" });
		const newer = noteRef({ id: "n1", title: "v2", updatedAt: "2026-01-20" });
		const summary = leaf({
			commitHash: "root",
			notes: [older],
			children: [leaf({ commitHash: "child", notes: [newer] })],
		});
		const result = collectAllNotesWithHosts(summary);
		expect(result).toHaveLength(1);
		expect(result[0].noteRef.title).toBe("v2");
		expect(result[0].hostCommitHash).toBe("child");
	});

	it("returns empty array when no notes exist", () => {
		expect(collectAllNotesWithHosts(leaf())).toHaveLength(0);
	});
});

// ─── formatProviderLabel ────────────────────────────────────────────────────

describe("formatProviderLabel", () => {
	it("returns undefined when no llm source", () => {
		expect(formatProviderLabel({ children: [] } as never)).toBeUndefined();
	});
	it("maps a single source to its label", () => {
		const s = { llm: { source: "anthropic-config" }, children: [] };
		expect(formatProviderLabel(s as never)).toBe("Anthropic");
	});
	it("prefixes mixed sources", () => {
		const s = {
			llm: { source: "anthropic-config" },
			children: [{ llm: { source: "jolli-proxy" }, children: [] }],
		};
		expect(formatProviderLabel(s as never)).toBe("mixed: Anthropic, Jolli proxy");
	});
	it("renders the specific local-agent tool in the footer", () => {
		const summary = {
			llm: {
				model: "m",
				inputTokens: 1,
				outputTokens: 1,
				apiLatencyMs: 1,
				stopReason: null,
				source: "local-agent",
				localAgentTool: "cursor-agent",
			},
			children: [],
		} as unknown as CommitSummary;
		expect(formatProviderLabel(summary)).toBe("Local agent - Cursor");
	});
	it("falls back to bare 'Local agent' when the tool is absent (old summary)", () => {
		const summary = {
			llm: {
				model: "m",
				inputTokens: 1,
				outputTokens: 1,
				apiLatencyMs: 1,
				stopReason: null,
				source: "local-agent",
			},
			children: [],
		} as unknown as CommitSummary;
		expect(formatProviderLabel(summary)).toBe("Local agent");
	});
});
