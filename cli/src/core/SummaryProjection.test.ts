import { describe, expect, it } from "vitest";
import type { CommitSummary, NoteReference, PlanReference } from "../Types.js";
import { buildHit } from "./SummaryProjection.js";

function leaf(overrides: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 4,
		commitHash: "06d0f72912345abcdef0123456789abcdef01234",
		commitMessage: "feat: thing",
		commitAuthor: "Test User",
		commitDate: "2026-03-01T10:00:00.000Z",
		branch: "feature/test",
		generatedAt: "2026-03-01T10:01:00.000Z",
		stats: { filesChanged: 2, insertions: 10, deletions: 5 },
		topics: [{ title: "Topic A", trigger: "t", response: "r", decisions: "d" }],
		...overrides,
	};
}

function planRef(o: Partial<PlanReference> = {}): PlanReference {
	return {
		slug: "auth-redesign",
		title: "Auth Redesign",
		addedAt: "2026-01-01",
		updatedAt: "2026-01-01",
		...o,
	};
}

function noteRef(o: Partial<NoteReference> = {}): NoteReference {
	return {
		id: "note-1",
		title: "A note",
		format: "markdown",
		addedAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...o,
	};
}

describe("buildHit", () => {
	it("projects a v4 summary's identity, recap, topics, and diffStats", () => {
		const hit = buildHit(
			leaf({
				ticketId: "JIRA-123",
				diffStats: { filesChanged: 3, insertions: 10, deletions: 2 },
				recap: "did stuff",
			}),
		);
		expect(hit.hash).toBe("06d0f729");
		expect(hit.fullHash).toBe("06d0f72912345abcdef0123456789abcdef01234");
		expect(hit.commitMessage).toBe("feat: thing");
		expect(hit.commitAuthor).toBe("Test User");
		expect(hit.branch).toBe("feature/test");
		expect(hit.ticketId).toBe("JIRA-123");
		expect(hit.diffStats).toEqual({ filesChanged: 3, insertions: 10, deletions: 2 });
		expect(hit.recap).toBe("did stuff");
		expect(hit.topics).toHaveLength(1);
		expect(hit.topics[0]).toEqual({
			title: "Topic A",
			trigger: "t",
			response: "r",
			decisions: "d",
		});
	});

	it("walks v3 nested children for topics via collectDisplayTopics", () => {
		const hit = buildHit(
			leaf({
				version: 3,
				topics: undefined,
				children: [
					leaf({
						commitHash: "child1234567890abcdef0123456789abcdef0123",
						topics: [{ title: "Child Topic", trigger: "ct", response: "cr", decisions: "cd" }],
					}),
				],
			}),
		);
		// Child topics surface in the projection — same recursion contract as
		// collectDisplayTopics.
		expect(hit.topics.length).toBeGreaterThanOrEqual(1);
		const titles = hit.topics.map((t) => t.title);
		expect(titles).toContain("Child Topic");
	});

	it("emits plan stubs from root-level plans (slug + title only)", () => {
		const hit = buildHit(leaf({ plans: [planRef()] }));
		expect(hit.plans).toEqual([{ slug: "auth-redesign", title: "Auth Redesign" }]);
	});

	it("emits note stubs from root-level notes (id + title only)", () => {
		const hit = buildHit(leaf({ notes: [noteRef()] }));
		expect(hit.notes).toEqual([{ id: "note-1", title: "A note" }]);
	});

	it("collects plan / note stubs from nested children (v3 legacy)", () => {
		const hit = buildHit(
			leaf({
				children: [
					leaf({
						commitHash: "child1234567890abcdef0123456789abcdef0123",
						plans: [planRef({ slug: "child-plan", title: "Child Plan" })],
						notes: [noteRef({ id: "child-note", title: "Child Note" })],
					}),
				],
			}),
		);
		expect(hit.plans?.[0].slug).toBe("child-plan");
		expect(hit.notes?.[0].id).toBe("child-note");
	});

	it("normalizes plan stub slug to the base slug (archive suffix stripped)", () => {
		// Plan was archived at the root commit (06d0f729...) and its slug carries
		// the matching short-hash suffix. Stub slug must be the archive-stripped
		// canonical form so it matches RecallPayload.plans entries.
		const hit = buildHit(
			leaf({
				plans: [planRef({ slug: "auth-redesign-06d0f729", title: "Auth Redesign" })],
			}),
		);
		expect(hit.plans?.[0].slug).toBe("auth-redesign");
	});

	it("dedupes stubs by slug / id when the same ref appears in root and child", () => {
		// Same logical plan referenced both at root and in a child — should
		// surface once. Same for notes.
		const hit = buildHit(
			leaf({
				plans: [planRef({ slug: "auth-redesign" })],
				notes: [noteRef({ id: "n1" })],
				children: [
					leaf({
						commitHash: "child1234567890abcdef0123456789abcdef0123",
						plans: [planRef({ slug: "auth-redesign", title: "Older" })],
						notes: [noteRef({ id: "n1", title: "Older note" })],
					}),
				],
			}),
		);
		expect(hit.plans).toHaveLength(1);
		expect(hit.notes).toHaveLength(1);
	});

	it("omits plans / notes / optional fields when not present (no empty arrays)", () => {
		const hit = buildHit(leaf({ topics: [{ title: "T", trigger: "t", response: "r", decisions: "d" }] }));
		expect(hit.plans).toBeUndefined();
		expect(hit.notes).toBeUndefined();
		expect(hit.recap).toBeUndefined();
		expect(hit.ticketId).toBeUndefined();
	});

	it("preserves topic optional fields (todo / filesAffected / category / importance)", () => {
		const hit = buildHit(
			leaf({
				topics: [
					{
						title: "T",
						trigger: "t",
						response: "r",
						decisions: "d",
						todo: "todo-thing",
						filesAffected: ["src/a.ts"],
						category: "feature",
						importance: "major",
					},
				],
			}),
		);
		expect(hit.topics[0].todo).toBe("todo-thing");
		expect(hit.topics[0].filesAffected).toEqual(["src/a.ts"]);
		expect(hit.topics[0].category).toBe("feature");
		expect(hit.topics[0].importance).toBe("major");
	});

	it("strips empty filesAffected arrays (keeps shape clean)", () => {
		const hit = buildHit(
			leaf({
				topics: [{ title: "T", trigger: "t", response: "r", decisions: "d", filesAffected: [] }],
			}),
		);
		expect(hit.topics[0].filesAffected).toBeUndefined();
	});

	it("preserves commitType when present", () => {
		const hit = buildHit(leaf({ commitType: "squash" }));
		expect(hit.commitType).toBe("squash");
	});

	// Stub-level dedup runs AFTER base-slug normalization, so two plan refs that
	// look distinct (`plan` and `plan-<hostHash>`) but collapse to the same base
	// slug must fold into a single stub.
	it("dedupes plan stubs that collapse to the same base slug after normalization", () => {
		// Root commit hash starts with `06d0f729` — both slugs strip to "auth".
		const hit = buildHit(
			leaf({
				commitHash: "06d0f72912345abcdef0123456789abcdef01234",
				plans: [planRef({ slug: "auth" }), planRef({ slug: "auth-06d0f729", title: "v2" })],
			}),
		);
		expect(hit.plans).toHaveLength(1);
		expect(hit.plans?.[0].slug).toBe("auth");
	});

	// Same fold for notes — id comes through dedupeById; if two ids land equal
	// only the first survives.
	it("dedupes note stubs when two refs share an id across different hosts", () => {
		const hit = buildHit(
			leaf({
				commitHash: "06d0f72912345abcdef0123456789abcdef01234",
				notes: [noteRef({ id: "n1", title: "First" })],
				children: [
					leaf({
						commitHash: "abcdef1234567890abcdef0123456789abcdef00",
						notes: [noteRef({ id: "n1", title: "Second", updatedAt: "2024-01-01T00:00:00Z" })],
					}),
				],
			}),
		);
		expect(hit.notes).toHaveLength(1);
	});
});
