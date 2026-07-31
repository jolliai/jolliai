import { describe, expect, it } from "vitest";
import type { NoteReference, PlanReference, ReferenceCommitRef } from "../Types.js";
import { baseKeyOf, mergeRefsNewWins, snapshotKeyOf } from "./RefMerge.js";

// Moved here from QueueWorker.test.ts when mergeRefsNewWins was hoisted out of
// QueueWorker: both hoisted roots (amend's buildHoistedAmendRoot and squash's
// mergeManyToOne) union their newly-associated refs through it — but with
// DIFFERENT dedupe keys. The key-family tests below are the contract that keeps
// those two apart; using one path's family on the other strands orphan-branch
// files (a snapshot with no summary pointing at it).
describe("mergeRefsNewWins", () => {
	const bySlug = (r: { slug: string }) => r.slug;

	it("returns [] for empty / undefined inputs", () => {
		expect(mergeRefsNewWins(undefined, undefined, bySlug)).toEqual([]);
		expect(mergeRefsNewWins([], [], bySlug)).toEqual([]);
	});

	it("keeps old refs when there are no new refs", () => {
		const old = [{ slug: "a" }, { slug: "b" }];
		expect(mergeRefsNewWins(old, undefined, bySlug)).toEqual(old);
	});

	it("unions non-colliding new refs after the old ones", () => {
		const merged = mergeRefsNewWins([{ slug: "a" }], [{ slug: "b" }], bySlug);
		expect(merged.map(bySlug)).toEqual(["a", "b"]);
	});

	it("new ref wins on key collision (drops the stale old snapshot)", () => {
		const merged = mergeRefsNewWins([{ slug: "a", tag: "old" }], [{ slug: "a", tag: "new" }], bySlug);
		expect(merged).toEqual([{ slug: "a", tag: "new" }]);
	});

	it("keeps the OLD ref's position when a new ref replaces it", () => {
		// Map.set on an existing key updates in place, so a replaced ref does not
		// jump to the end — display order stays stable across an amend.
		const merged = mergeRefsNewWins(
			[{ slug: "a", tag: "old" }, { slug: "b" }],
			[{ slug: "a", tag: "new" }],
			bySlug,
		);
		expect(merged.map(bySlug)).toEqual(["a", "b"]);
	});
});

const AT = "2026-04-01T00:00:00.000Z";
const plan = (slug: string): PlanReference => ({ slug, title: "T", addedAt: AT, updatedAt: AT });
const note = (id: string): NoteReference => ({ id, title: "T", format: "markdown", addedAt: AT, updatedAt: AT });
const reference = (hash: string): ReferenceCommitRef => ({
	source: "linear",
	nativeId: "PROJ-9",
	archivedKey: `linear:PROJ-9-${hash}`,
	title: "Proj nine",
	url: "https://linear.app/x/PROJ-9",
	referencedAt: AT,
	sourceToolName: "mcp__linear__get_issue",
});

describe("baseKeyOf (amend keys)", () => {
	it("strips the -<8 hex> archive stamp from plan slugs and note ids", () => {
		expect(baseKeyOf.plan(plan("my-plan-a1b2c3d4"))).toBe("my-plan");
		expect(baseKeyOf.note(note("note-1-a1b2c3d4"))).toBe("note-1");
	});

	it("leaves an unstamped slug / id untouched", () => {
		expect(baseKeyOf.plan(plan("my-plan"))).toBe("my-plan");
		expect(baseKeyOf.note(note("note-1"))).toBe("note-1");
	});

	it("keys a reference by source:nativeId, ignoring which commit archived it", () => {
		expect(baseKeyOf.reference(reference("aaaaaaaa"))).toBe("linear:PROJ-9");
		expect(baseKeyOf.reference(reference("bbbbbbbb"))).toBe("linear:PROJ-9");
	});

	it("collapses two snapshots of the same item into one ref (the amend contract)", () => {
		// A revived guard re-archives the same plan under the amend's new hash; the
		// old snapshot must NOT be listed alongside it.
		const merged = mergeRefsNewWins([plan("my-plan-aaaaaaaa")], [plan("my-plan-bbbbbbbb")], baseKeyOf.plan);
		expect(merged.map((p) => p.slug)).toEqual(["my-plan-bbbbbbbb"]);
	});
});

describe("snapshotKeyOf (squash keys)", () => {
	it("keys by the hash-stamped identity of the archived file", () => {
		expect(snapshotKeyOf.plan(plan("my-plan-a1b2c3d4"))).toBe("my-plan-a1b2c3d4");
		expect(snapshotKeyOf.note(note("note-1-a1b2c3d4"))).toBe("note-1-a1b2c3d4");
		expect(snapshotKeyOf.reference(reference("aaaaaaaa"))).toBe("linear:PROJ-9-aaaaaaaa");
	});

	// The bug these keys exist to prevent: a squash root hoists refs from N
	// children, and two children can hold the same logical item at different
	// commits (consult PROJ-9 on commit 1, consult it again on commit 3). Both
	// orphan-branch files outlive the squash — reassociateMetadata only re-anchors
	// plans.json rows, nothing renames or deletes a child's snapshot — so both need
	// a pointer. Base keys would keep whichever child was visited last.
	it("keeps BOTH children's snapshots of the same item, where base keys would keep one", () => {
		const twoChildren = [reference("aaaaaaaa"), reference("bbbbbbbb")];

		const withSnapshotKeys = mergeRefsNewWins(twoChildren, undefined, snapshotKeyOf.reference);
		expect(withSnapshotKeys.map((r) => r.archivedKey)).toEqual([
			"linear:PROJ-9-aaaaaaaa",
			"linear:PROJ-9-bbbbbbbb",
		]);

		// Guard the divergence itself: if these two families ever agree, one of the
		// paths is using the wrong one and the assertion above stopped proving anything.
		expect(mergeRefsNewWins(twoChildren, undefined, baseKeyOf.reference)).toHaveLength(1);
	});

	it("keeps both children's plans / notes for the same reason", () => {
		const plans = mergeRefsNewWins(
			[plan("my-plan-aaaaaaaa"), plan("my-plan-bbbbbbbb")],
			undefined,
			snapshotKeyOf.plan,
		);
		expect(plans.map((p) => p.slug)).toEqual(["my-plan-aaaaaaaa", "my-plan-bbbbbbbb"]);

		const notes = mergeRefsNewWins(
			[note("note-1-aaaaaaaa"), note("note-1-bbbbbbbb")],
			undefined,
			snapshotKeyOf.note,
		);
		expect(notes.map((n) => n.id)).toEqual(["note-1-aaaaaaaa", "note-1-bbbbbbbb"]);
	});

	it("still lets a newly consumed ref replace the identical snapshot key", () => {
		const merged = mergeRefsNewWins(
			[{ ...reference("aaaaaaaa"), title: "stale" }],
			[{ ...reference("aaaaaaaa"), title: "fresh" }],
			snapshotKeyOf.reference,
		);
		expect(merged).toHaveLength(1);
		expect(merged[0].title).toBe("fresh");
	});
});
