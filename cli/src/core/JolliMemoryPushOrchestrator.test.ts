import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary, NoteReference, PlanReference, ReferenceCommitRef } from "../Types.js";

vi.mock("./GitOps.js", () => ({ getDefaultBranch: vi.fn() }));
vi.mock("./PrDescription.js", () => ({ loadBranchSummaries: vi.fn() }));
vi.mock("./PushPendingStore.js", () => ({ loadPushPending: vi.fn() }));
vi.mock("./SummaryStore.js", () => ({
	getActiveStorage: vi.fn(),
	getIndexEntryMap: vi.fn(async () => new Map()),
	getSummary: vi.fn(),
	readNoteFromBranch: vi.fn(),
	readPlanFromBranch: vi.fn(),
	readReferenceFromBranch: vi.fn(),
	storeSummary: vi.fn(),
}));
vi.mock("./GitRemoteUtils.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./GitRemoteUtils.js")>();
	return { ...actual, getCanonicalRepoUrl: vi.fn() };
});
// Mocked so these tests never touch a real `.jolli/jollimemory/space-binding.json`
// (cwd is a fake path); the cache's own behavior is covered by SpaceBindingCache.test.ts.
vi.mock("./SpaceBindingCache.js", () => ({
	clearSpaceBindingCache: vi.fn(),
	saveSpaceBindingCache: vi.fn(),
}));

import { getDefaultBranch } from "./GitOps.js";
import { buildBranchRelativePath, getCanonicalRepoUrl } from "./GitRemoteUtils.js";
import {
	BATCH_MAX_ATTACHMENTS_PER_ITEM,
	type BatchItemResult,
	BindingAlreadyExistsError,
	BindingRequiredError,
	ClientOutdatedError,
	type JolliMemoryPushClient,
	NotAuthenticatedError,
	type PushPayload,
	type PushResult,
} from "./JolliMemoryPushClient.js";
import {
	applyBatchResult,
	applyNoteUrls,
	applyPlanUrls,
	applyReferenceUrls,
	assignOwnedAttachments,
	buildBatchItems,
	buildPushMarkdown,
	canReuseDocId,
	docUrlPlaceholder,
	latestPlanPerName,
	type PushContext,
	pushBranchToJolli,
	pushSummary,
	referenceBaseKey,
	resolveSpaceId,
	serializeSummaryJson,
} from "./JolliMemoryPushOrchestrator.js";
import { loadBranchSummaries } from "./PrDescription.js";
import { loadPushPending } from "./PushPendingStore.js";
import { clearSpaceBindingCache, saveSpaceBindingCache } from "./SpaceBindingCache.js";
import { buildPushTitle } from "./SummaryFormat.js";
import {
	getActiveStorage,
	getIndexEntryMap,
	getSummary,
	readNoteFromBranch,
	readPlanFromBranch,
	readReferenceFromBranch,
	storeSummary,
} from "./SummaryStore.js";

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

function plan(overrides: Partial<PlanReference> = {}): PlanReference {
	return {
		slug: "p1",
		title: "P1",
		addedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function reference(overrides: Partial<ReferenceCommitRef> = {}): ReferenceCommitRef {
	return {
		archivedKey: "linear:ENG-1-a1b2c3d4",
		source: "linear",
		nativeId: "ENG-1",
		title: "Fix login bug",
		url: "https://linear.app/acme/issue/ENG-1",
		referencedAt: "2026-01-01T00:00:00.000Z",
		sourceToolName: "Claude Code",
		...overrides,
	};
}

function note(overrides: Partial<NoteReference> = {}): NoteReference {
	return {
		id: "n1",
		title: "N1",
		format: "markdown",
		addedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

// ─── serializeSummaryJson ───────────────────────────────────────────────────

describe("serializeSummaryJson", () => {
	it("strips push-state fields", () => {
		const s = {
			commitHash: "a",
			jolliDocId: 5,
			jolliDocUrl: "u",
			orphanedDocIds: [1],
			unresolvedOrphanHashes: ["old-hash"],
		} as unknown as CommitSummary;
		const json = JSON.parse(serializeSummaryJson(s) ?? "{}");
		expect(json.jolliDocId).toBeUndefined();
		expect(json.jolliDocUrl).toBeUndefined();
		expect(json.orphanedDocIds).toBeUndefined();
		expect(json.unresolvedOrphanHashes).toBeUndefined();
		expect(json.commitHash).toBe("a");
	});

	it("keeps nested plan/note/reference docId/url (needed for rendering the article links)", () => {
		const s = {
			commitHash: "a",
			plans: [{ slug: "p1", jolliPlanDocId: 9, jolliPlanDocUrl: "pu" }],
			notes: [{ id: "n1", jolliNoteDocId: 8, jolliNoteDocUrl: "nu" }],
			references: [{ archivedKey: "linear:E-1-abcd1234", jolliReferenceDocId: 7, jolliReferenceDocUrl: "ru" }],
		} as unknown as CommitSummary;
		const json = JSON.parse(serializeSummaryJson(s) ?? "{}");
		expect(json.plans[0].jolliPlanDocId).toBe(9);
		expect(json.plans[0].jolliPlanDocUrl).toBe("pu");
		expect(json.notes[0].jolliNoteDocUrl).toBe("nu");
		expect(json.references[0].jolliReferenceDocUrl).toBe("ru");
	});

	it("returns undefined when serialized JSON exceeds the byte cap", () => {
		const huge = "x".repeat(2_000_000);
		const s = { commitHash: "a", commitMessage: huge } as unknown as CommitSummary;
		expect(serializeSummaryJson(s)).toBeUndefined();
	});
});

// ─── applyPlanUrls / applyNoteUrls ──────────────────────────────────────────

describe("applyPlanUrls", () => {
	it("merges docId/url by slug (the URL's origin is the minting env)", () => {
		const plans = [plan({ slug: "p1" })];
		const out = applyPlanUrls(plans, [{ slug: "p1", url: "https://j/articles?doc=9", docId: 9 }]);
		expect(out?.[0].jolliPlanDocId).toBe(9);
		expect(out?.[0].jolliPlanDocUrl).toBe("https://j/articles?doc=9");
	});

	it("leaves plans unmatched by slug untouched", () => {
		const plans = [plan({ slug: "p1" })];
		const out = applyPlanUrls(plans, [{ slug: "other", url: "u", docId: 1 }]);
		expect(out?.[0].jolliPlanDocId).toBeUndefined();
		expect(out?.[0].jolliPlanDocUrl).toBeUndefined();
	});

	it("returns the input unchanged when plans is undefined or planUrls is empty", () => {
		expect(applyPlanUrls(undefined, [{ slug: "p1", url: "u", docId: 1 }])).toBeUndefined();
		const plans = [plan({ slug: "p1" })];
		expect(applyPlanUrls(plans, [])).toBe(plans);
	});
});

describe("applyNoteUrls", () => {
	it("merges docId/url by id (the URL's origin is the minting env)", () => {
		const notes = [note({ id: "n1" })];
		const out = applyNoteUrls(notes, [{ id: "n1", url: "https://j/articles?doc=3", docId: 3 }]);
		expect(out[0].jolliNoteDocId).toBe(3);
		expect(out[0].jolliNoteDocUrl).toBe("https://j/articles?doc=3");
	});

	it("leaves notes unmatched by id untouched", () => {
		const notes = [note({ id: "n1" })];
		const out = applyNoteUrls(notes, [{ id: "other", url: "u", docId: 1 }]);
		expect(out[0].jolliNoteDocId).toBeUndefined();
		expect(out[0].jolliNoteDocUrl).toBeUndefined();
	});
});

describe("applyReferenceUrls", () => {
	it("merges docId/url by archivedKey (the URL's origin is the minting env)", () => {
		const refs = [reference({ archivedKey: "linear:ENG-1-aaaa1111" })];
		const out = applyReferenceUrls(refs, [
			{ archivedKey: "linear:ENG-1-aaaa1111", url: "https://j/articles?doc=5", docId: 5 },
		]);
		expect(out[0].jolliReferenceDocId).toBe(5);
		expect(out[0].jolliReferenceDocUrl).toBe("https://j/articles?doc=5");
	});

	it("leaves references unmatched by archivedKey untouched", () => {
		const refs = [reference({ archivedKey: "linear:ENG-1-aaaa1111" })];
		const out = applyReferenceUrls(refs, [{ archivedKey: "linear:ENG-9-zzzz9999", url: "u", docId: 1 }]);
		expect(out[0].jolliReferenceDocId).toBeUndefined();
		expect(out[0].jolliReferenceDocUrl).toBeUndefined();
	});

	it("returns the input unchanged when referenceUrls is empty", () => {
		const refs = [reference()];
		expect(applyReferenceUrls(refs, [])).toBe(refs);
	});
});

describe("referenceBaseKey", () => {
	it("keys on the stable <source>:<nativeId> (ignoring the per-commit archivedKey suffix)", () => {
		expect(
			referenceBaseKey(reference({ source: "linear", nativeId: "ENG-1", archivedKey: "linear:ENG-1-aaaa1111" })),
		).toBe("linear:ENG-1");
	});
});

describe("canReuseDocId", () => {
	it("reuses when the stored doc URL's origin matches the current env", () => {
		expect(canReuseDocId("https://jolli.ai/acme/o/eng/articles/x-5", "https://jolli.ai")).toBe(true);
	});

	it("does NOT reuse when the stored doc URL is from a different backend", () => {
		expect(canReuseDocId("https://jolli-local.me/t/articles/x-5", "https://jolli.ai")).toBe(false);
	});

	it("reuses legacy (url-less) data so an upgrade doesn't orphan already-pushed docs", () => {
		expect(canReuseDocId(undefined, "https://jolli.ai")).toBe(true);
	});

	it("treats an unparseable stored URL as env-agnostic rather than throwing", () => {
		expect(canReuseDocId("not-a-url", "https://jolli.ai")).toBe(true);
	});
});

// ─── latestPlanPerName ──────────────────────────────────────────────────────

describe("latestPlanPerName", () => {
	it("picks the latest snapshot per base name", () => {
		const older = plan({ slug: "refactor-auth-a1b2c3d4", updatedAt: "2026-01-01T00:00:00.000Z" });
		const newer = plan({ slug: "refactor-auth-b2c3d4e5", updatedAt: "2026-02-01T00:00:00.000Z" });
		const out = latestPlanPerName([older, newer]);
		expect(out).toHaveLength(1);
		expect(out[0].slug).toBe("refactor-auth-b2c3d4e5");
	});

	it("carries an older snapshot's docId/url forward to an un-pushed latest snapshot", () => {
		const older = plan({
			slug: "refactor-auth-a1b2c3d4",
			updatedAt: "2026-01-01T00:00:00.000Z",
			jolliPlanDocId: 42,
			jolliPlanDocUrl: "https://j/articles?doc=42",
		});
		const newer = plan({ slug: "refactor-auth-b2c3d4e5", updatedAt: "2026-02-01T00:00:00.000Z" });
		const out = latestPlanPerName([older, newer]);
		expect(out).toHaveLength(1);
		expect(out[0].slug).toBe("refactor-auth-b2c3d4e5");
		expect(out[0].jolliPlanDocId).toBe(42);
		expect(out[0].jolliPlanDocUrl).toBe("https://j/articles?doc=42");
	});

	it("returns lone plans untouched", () => {
		const p = plan({ slug: "solo" });
		expect(latestPlanPerName([p])).toEqual([p]);
	});

	it("tiebreaks equal updatedAt by slug, deterministically, regardless of input order", () => {
		const a = plan({ slug: "alpha", updatedAt: "2026-01-01T00:00:00.000Z" });
		const b = plan({ slug: "bravo", updatedAt: "2026-01-01T00:00:00.000Z" });
		const c = plan({ slug: "charlie", updatedAt: "2026-01-01T00:00:00.000Z" });
		const forward = latestPlanPerName([a, b, c]).map((p) => p.slug);
		const reversed = latestPlanPerName([c, b, a]).map((p) => p.slug);
		expect(forward).toEqual(["alpha", "bravo", "charlie"]);
		expect(reversed).toEqual(forward);
	});

	it("sorts descending by updatedAt regardless of input order (exercises both comparator directions)", () => {
		const older = plan({ slug: "aaa", updatedAt: "2026-01-01T00:00:00.000Z" });
		const newer = plan({ slug: "bbb", updatedAt: "2026-02-01T00:00:00.000Z" });
		expect(latestPlanPerName([older, newer]).map((p) => p.slug)).toEqual(["bbb", "aaa"]);
		expect(latestPlanPerName([newer, older]).map((p) => p.slug)).toEqual(["bbb", "aaa"]);
	});

	it("treats fully identical slugs as equal in the tiebreak (defensive fallback)", () => {
		const dup1 = plan({ slug: "dup", updatedAt: "2026-01-01T00:00:00.000Z", title: "First" });
		const dup2 = plan({ slug: "dup", updatedAt: "2026-01-01T00:00:00.000Z", title: "Second" });
		expect(latestPlanPerName([dup1, dup2])).toHaveLength(1);
	});

	it("does not inherit a docId when the latest snapshot already carries its own", () => {
		const older = plan({
			slug: "refactor-auth-a1b2c3d4",
			updatedAt: "2026-01-01T00:00:00.000Z",
			jolliPlanDocId: 1,
		});
		const newer = plan({
			slug: "refactor-auth-b2c3d4e5",
			updatedAt: "2026-02-01T00:00:00.000Z",
			jolliPlanDocId: 2,
			jolliPlanDocUrl: "https://j/articles?doc=2",
		});
		const out = latestPlanPerName([older, newer]);
		expect(out).toHaveLength(1);
		expect(out[0].jolliPlanDocId).toBe(2);
	});
});

// ─── assignOwnedAttachments ─────────────────────────────────────────────────

describe("assignOwnedAttachments", () => {
	it("dedups a plan recurring across two commits to one owner, carrying the seed docId forward", () => {
		const commit1 = leaf({
			commitHash: "c1",
			plans: [plan({ slug: "refactor-auth-a1b2c3d4", updatedAt: "2026-01-01T00:00:00.000Z", jolliPlanDocId: 7 })],
		});
		const commit2 = leaf({
			commitHash: "c2",
			plans: [plan({ slug: "refactor-auth-b2c3d4e5", updatedAt: "2026-02-01T00:00:00.000Z" })],
		});
		const { ownedPlans, seedPlanDocIds } = assignOwnedAttachments([commit1, commit2]);

		// One owner only, and it's the commit with the newest revision.
		expect(ownedPlans.has("c1")).toBe(false);
		expect(ownedPlans.get("c2")).toHaveLength(1);
		expect(ownedPlans.get("c2")?.[0].jolliPlanDocId).toBe(7);
		expect(seedPlanDocIds.get("refactor-auth")).toBe(7);
	});

	it("dedups a note recurring across two commits to one owner", () => {
		const commit1 = leaf({
			commitHash: "c1",
			notes: [note({ id: "n1", updatedAt: "2026-01-01T00:00:00.000Z", jolliNoteDocId: 11 })],
		});
		const commit2 = leaf({
			commitHash: "c2",
			notes: [note({ id: "n1", updatedAt: "2026-02-01T00:00:00.000Z" })],
		});
		const { ownedNotes, seedNoteDocIds } = assignOwnedAttachments([commit1, commit2]);

		expect(ownedNotes.has("c1")).toBe(false);
		expect(ownedNotes.get("c2")).toHaveLength(1);
		expect(ownedNotes.get("c2")?.[0].jolliNoteDocId).toBe(11);
		expect(seedNoteDocIds.get("n1")).toBe(11);
	});

	it("returns empty maps for summaries with no plans/notes", () => {
		const { ownedPlans, ownedNotes, seedPlanDocIds, seedNoteDocIds } = assignOwnedAttachments([leaf()]);
		expect(ownedPlans.size).toBe(0);
		expect(ownedNotes.size).toBe(0);
		expect(seedPlanDocIds.size).toBe(0);
		expect(seedNoteDocIds.size).toBe(0);
	});

	it("adopts a docId discovered on an older revision processed after the winner (plans)", () => {
		const winnerCommit = leaf({
			commitHash: "c1",
			plans: [plan({ slug: "refactor-auth-b2c3d4e5", updatedAt: "2026-02-01T00:00:00.000Z" })],
		});
		const olderWithDocId = leaf({
			commitHash: "c2",
			plans: [
				plan({ slug: "refactor-auth-a1b2c3d4", updatedAt: "2026-01-01T00:00:00.000Z", jolliPlanDocId: 55 }),
			],
		});
		const { ownedPlans, seedPlanDocIds } = assignOwnedAttachments([winnerCommit, olderWithDocId]);
		// The winner is still the newer revision, but it inherits the seed docId from the older one.
		expect(ownedPlans.get("c1")).toHaveLength(1);
		expect(ownedPlans.get("c1")?.[0].jolliPlanDocId).toBe(55);
		expect(ownedPlans.has("c2")).toBe(false);
		expect(seedPlanDocIds.get("refactor-auth")).toBe(55);
	});

	it("adopts a docId discovered on an older revision processed after the winner (notes)", () => {
		const winnerCommit = leaf({
			commitHash: "c1",
			notes: [note({ id: "n1", updatedAt: "2026-02-01T00:00:00.000Z" })],
		});
		const olderWithDocId = leaf({
			commitHash: "c2",
			notes: [note({ id: "n1", updatedAt: "2026-01-01T00:00:00.000Z", jolliNoteDocId: 77 })],
		});
		const { ownedNotes, seedNoteDocIds } = assignOwnedAttachments([winnerCommit, olderWithDocId]);
		expect(ownedNotes.get("c1")).toHaveLength(1);
		expect(ownedNotes.get("c1")?.[0].jolliNoteDocId).toBe(77);
		expect(seedNoteDocIds.get("n1")).toBe(77);
	});

	it("groups multiple distinct owned plans under the same owner commit", () => {
		const summary = leaf({
			commitHash: "c1",
			plans: [plan({ slug: "plan-one" }), plan({ slug: "plan-two" })],
		});
		const { ownedPlans } = assignOwnedAttachments([summary]);
		expect(ownedPlans.get("c1")).toHaveLength(2);
	});

	it("leaves an older, no-op revision alone when it neither wins nor introduces a new seed docId (plans)", () => {
		const winner = leaf({
			commitHash: "c1",
			plans: [plan({ slug: "p-a1b2c3d4", updatedAt: "2026-03-01T00:00:00.000Z" })],
		});
		const staleNoOp = leaf({
			commitHash: "c2",
			plans: [plan({ slug: "p-b2c3d4e5", updatedAt: "2026-02-01T00:00:00.000Z" })],
		});
		const { ownedPlans } = assignOwnedAttachments([winner, staleNoOp]);
		expect(ownedPlans.get("c1")).toHaveLength(1);
		expect(ownedPlans.has("c2")).toBe(false);
	});

	it("leaves an older, no-op revision alone when it neither wins nor introduces a new seed docId (notes)", () => {
		const winner = leaf({ commitHash: "c1", notes: [note({ id: "n1", updatedAt: "2026-03-01T00:00:00.000Z" })] });
		const staleNoOp = leaf({
			commitHash: "c2",
			notes: [note({ id: "n1", updatedAt: "2026-02-01T00:00:00.000Z" })],
		});
		const { ownedNotes } = assignOwnedAttachments([winner, staleNoOp]);
		expect(ownedNotes.get("c1")).toHaveLength(1);
		expect(ownedNotes.has("c2")).toBe(false);
	});

	it("owns a note with no known docId anywhere (fresh push, no seed)", () => {
		const summary = leaf({ commitHash: "c1", notes: [note({ id: "n1" })] });
		const { ownedNotes, seedNoteDocIds } = assignOwnedAttachments([summary]);
		expect(ownedNotes.get("c1")).toEqual([note({ id: "n1" })]);
		expect(seedNoteDocIds.size).toBe(0);
	});

	it("keeps the winner's own docId when an older revision carries a different one (plans)", () => {
		// Both snapshots share base-key "refactor-auth" but carry DIFFERENT docIds
		// (e.g. each was pushed separately before a squash hoisted them together).
		// The latest revision's article (docId 20) must own the push — the older
		// revision's docId 10 must not clobber it, which would push the latest
		// content to article 10 and orphan/leak article 20.
		const winner = leaf({
			commitHash: "c1",
			plans: [
				plan({ slug: "refactor-auth-a1b2c3d4", updatedAt: "2026-03-01T00:00:00.000Z", jolliPlanDocId: 20 }),
			],
		});
		const olderDifferentDocId = leaf({
			commitHash: "c2",
			plans: [
				plan({ slug: "refactor-auth-b2c3d4e5", updatedAt: "2026-02-01T00:00:00.000Z", jolliPlanDocId: 10 }),
			],
		});
		const { ownedPlans, seedPlanDocIds } = assignOwnedAttachments([winner, olderDifferentDocId]);
		expect(ownedPlans.get("c1")?.[0].jolliPlanDocId).toBe(20);
		expect(ownedPlans.has("c2")).toBe(false);
		expect(seedPlanDocIds.get("refactor-auth")).toBe(20);
	});

	it("picks the same latest snapshot as latestPlanPerName on an equal-updatedAt tie (slug tiebreak)", () => {
		// Two same-base snapshots with identical updatedAt but different slugs. Both
		// dedup paths must agree on the winner (smaller slug), or pushSummary would
		// push one slug and weave the URL against the other, dropping the markdown link.
		const plans = [
			plan({ slug: "auth-b2222222", updatedAt: "2026-01-01T00:00:00.000Z" }),
			plan({ slug: "auth-a1111111", updatedAt: "2026-01-01T00:00:00.000Z" }),
		];
		const summary = leaf({ commitHash: "c1", plans });
		const { ownedPlans } = assignOwnedAttachments([summary]);
		const ownedSlug = ownedPlans.get("c1")?.[0].slug;
		const latestSlug = latestPlanPerName(plans)[0].slug;
		expect(ownedSlug).toBe("auth-a1111111");
		expect(ownedSlug).toBe(latestSlug);
	});

	it("keeps the winner's own docId when an older revision carries a different one (notes)", () => {
		const winner = leaf({
			commitHash: "c1",
			notes: [note({ id: "n1", updatedAt: "2026-03-01T00:00:00.000Z", jolliNoteDocId: 20 })],
		});
		const olderDifferentDocId = leaf({
			commitHash: "c2",
			notes: [note({ id: "n1", updatedAt: "2026-02-01T00:00:00.000Z", jolliNoteDocId: 10 })],
		});
		const { ownedNotes, seedNoteDocIds } = assignOwnedAttachments([winner, olderDifferentDocId]);
		expect(ownedNotes.get("c1")?.[0].jolliNoteDocId).toBe(20);
		expect(ownedNotes.has("c2")).toBe(false);
		expect(seedNoteDocIds.get("n1")).toBe(20);
	});

	it("dedupes a reference recurring across commits to ONE owner commit (latest referencedAt wins)", () => {
		// Same ticket (ENG-1) referenced on two commits — different per-commit archivedKeys.
		const older = leaf({
			commitHash: "c1",
			references: [reference({ archivedKey: "linear:ENG-1-c1", referencedAt: "2026-01-01T00:00:00.000Z" })],
		});
		const newer = leaf({
			commitHash: "c2",
			references: [reference({ archivedKey: "linear:ENG-1-c2", referencedAt: "2026-02-01T00:00:00.000Z" })],
		});
		const { ownedReferences } = assignOwnedAttachments([older, newer]);
		// Only the newest-referencedAt commit owns the single push.
		expect(ownedReferences.get("c2")?.[0].archivedKey).toBe("linear:ENG-1-c2");
		expect(ownedReferences.has("c1")).toBe(false);
	});

	it("carries a prior commit's reference docId forward to the winner that lacks one (seeded)", () => {
		const winner = leaf({
			commitHash: "c1",
			references: [reference({ archivedKey: "linear:ENG-1-c1", referencedAt: "2026-03-01T00:00:00.000Z" })],
		});
		const olderWithDocId = leaf({
			commitHash: "c2",
			references: [
				reference({
					archivedKey: "linear:ENG-1-c2",
					referencedAt: "2026-02-01T00:00:00.000Z",
					jolliReferenceDocId: 55,
					jolliReferenceDocUrl: "https://jolli.ai/articles?doc=55",
				}),
			],
		});
		const { ownedReferences, seedReferenceDocIds } = assignOwnedAttachments([winner, olderWithDocId]);
		expect(ownedReferences.get("c1")?.[0].jolliReferenceDocId).toBe(55);
		// The seed URL rides with the seed docId so the woven URL matches the id it points at.
		expect(ownedReferences.get("c1")?.[0].jolliReferenceDocUrl).toBe("https://jolli.ai/articles?doc=55");
		expect(ownedReferences.has("c2")).toBe(false);
		expect(seedReferenceDocIds.get("linear:ENG-1")).toBe(55);
	});

	it("keeps distinct references (different <source>:<nativeId>) as separate owned pushes", () => {
		const summary = leaf({
			references: [
				reference({ source: "linear", nativeId: "ENG-1", archivedKey: "linear:ENG-1-c1" }),
				reference({ source: "github", nativeId: "acme/repo#7", archivedKey: "github:acme/repo#7-c1" }),
			],
		});
		const { ownedReferences } = assignOwnedAttachments([summary]);
		expect(ownedReferences.get(summary.commitHash)).toHaveLength(2);
	});
});

// ─── buildPushMarkdown ──────────────────────────────────────────────────────

describe("resolveSpaceId", () => {
	function spaceClient(spaces: { id: number; name: string; slug: string }[]): JolliMemoryPushClient {
		return {
			listSpaces: vi.fn(async () => ({ spaces, defaultSpaceId: null })),
		} as unknown as JolliMemoryPushClient;
	}
	const SPACES = [
		{ id: 7, name: "2026", slug: "annual" },
		{ id: 2, name: "Widgets", slug: "widgets" },
	];

	it("resolves a Space whose name is all digits by name, not by treating it as an id", async () => {
		// Regression: `--space 2026` must bind to the Space *named* "2026" (id 7),
		// not to whatever has id 2026 (nonexistent, or someone else's space).
		expect(await resolveSpaceId(spaceClient(SPACES), "2026")).toBe(7);
	});
	it("resolves by exact slug", async () => {
		expect(await resolveSpaceId(spaceClient(SPACES), "widgets")).toBe(2);
	});
	it("resolves by exact name", async () => {
		expect(await resolveSpaceId(spaceClient(SPACES), "Widgets")).toBe(2);
	});
	it("falls back to treating a numeric string as a raw id when no name/slug matches", async () => {
		expect(await resolveSpaceId(spaceClient([]), "42")).toBe(42);
	});
	it("throws when a non-numeric string matches no name or slug", async () => {
		await expect(resolveSpaceId(spaceClient(SPACES), "nope")).rejects.toThrow("nope");
	});
});

describe("buildPushMarkdown", () => {
	it("renders H1, properties, and topic sections", () => {
		const md = buildPushMarkdown(leaf());
		expect(md).toContain("# feat: add feature");
		expect(md).toContain("**Commit:** `abc1234567890`");
		expect(md).toContain("**Branch:** `feature/proj-123-thing`");
		expect(md).toContain("## Topic (1)");
		expect(md).toContain("### 01 · Topic A `feature`");
		expect(md).toContain("*Generated by Jolli Memory");
	});

	it("includes references in the Context section (push-only behavior)", () => {
		const md = buildPushMarkdown(
			leaf({
				references: [
					{
						archivedKey: "linear:PROJ-123",
						source: "linear",
						nativeId: "PROJ-123",
						title: "Fix bug",
						url: "https://linear.app/x",
						referencedAt: "2026-01-01T00:00:00.000Z",
						sourceToolName: "Claude Code",
					},
				],
			}),
		);
		expect(md).toContain("## Context");
		expect(md).toContain("PROJ-123");
	});

	it("links the Context reference row to the Space article when jolliReferenceDocUrl is set", () => {
		const md = buildPushMarkdown(
			leaf({
				references: [
					reference({
						nativeId: "ENG-7",
						title: "Ship it",
						url: "https://linear.app/x",
						jolliReferenceDocUrl: "https://jolli.ai/articles?doc=77",
					}),
				],
			}),
		);
		// Points at the pushed Space article, not the external link.
		expect(md).toContain("(https://jolli.ai/articles?doc=77)");
		expect(md).not.toContain("(https://linear.app/x)");
	});

	it("renders the source commits section for multi-record summaries", () => {
		const md = buildPushMarkdown(
			leaf({
				children: [leaf({ commitHash: "c1" }), leaf({ commitHash: "c2" })],
			}),
		);
		expect(md).toContain("## Source Commits");
	});

	it("renders the E2E test guide section when present", () => {
		const md = buildPushMarkdown(
			leaf({
				e2eTestGuide: [
					{
						title: "Scenario 1",
						preconditions: "Logged in",
						steps: ["Click button"],
						expectedResults: ["Sees result"],
					},
				],
			}),
		);
		expect(md).toContain("## E2E Test (1)");
		expect(md).toContain("Scenario 1");
	});

	it("renders conversation turns and the Jolli Memory link when present", () => {
		const md = buildPushMarkdown(leaf({ conversationTurns: 5, jolliDocUrl: "https://j/articles?doc=1" }));
		expect(md).toContain("**Conversations:** 5 turns");
		expect(md).toContain("**Jolli Memory:** [https://j/articles?doc=1](https://j/articles?doc=1)");
	});

	it("uses singular units for a single file changed and a single conversation turn", () => {
		const md = buildPushMarkdown(
			leaf({ stats: { filesChanged: 1, insertions: 1, deletions: 0 }, conversationTurns: 1 }),
		);
		expect(md).toContain("1 file changed");
		expect(md).toContain("**Conversations:** 1 turn");
		expect(md).not.toContain("1 turns");
	});

	it("renders an E2E scenario with no preconditions", () => {
		const md = buildPushMarkdown(
			leaf({
				e2eTestGuide: [{ title: "Scenario 1", steps: ["Click button"], expectedResults: ["Sees result"] }],
			}),
		);
		expect(md).toContain("### 1. Scenario 1");
		expect(md).not.toContain("**Preconditions:**");
	});

	it("omits the Topics section when there are no topics", () => {
		const md = buildPushMarkdown(leaf({ topics: [] }));
		expect(md).not.toContain("## Topic");
	});

	it("renders a topic without a category (no code-fenced label)", () => {
		const md = buildPushMarkdown(
			leaf({
				topics: [
					{
						title: "Topic B",
						trigger: "trigger",
						response: "response",
						decisions: "decisions",
						filesAffected: [],
					},
				],
			}),
		);
		expect(md).toContain("### 01 · Topic B");
	});

	it("renders per-child conversation turn counts in the source commits section", () => {
		const md = buildPushMarkdown(
			leaf({
				children: [
					leaf({ commitHash: "c1", conversationTurns: 3 }),
					leaf({ commitHash: "c2", conversationTurns: 0 }),
				],
			}),
		);
		expect(md).toContain("## Source Commits");
		expect(md).toContain("3 turns");
	});
});

// ─── pushSummary ────────────────────────────────────────────────────────────

const BASE = "https://jolli.ai";
const ENV_KEY = "https://jolli.ai";

// `url: ""` (falsy) makes resolveArticleUrl fall back to the `?doc=<id>` form, which
// keeps the URL-shape assertions below stable; the slug branch is covered directly
// in the `resolveArticleUrl` describe. A test that needs the slug shape overrides `url`.
function fakePushResult(overrides: Partial<PushResult> = {}): PushResult {
	return { url: "", docId: 42, jrn: "jrn:1", created: true, ...overrides };
}

/** Builds a stub client — only the methods `pushSummary`/`pushBranchToJolli` call are ever invoked. */
function fakeClient(
	overrides: Partial<{
		push: (payload: PushPayload) => Promise<PushResult>;
		listSpaces: () => Promise<{
			spaces: Array<{ id: number; name: string; slug: string }>;
			defaultSpaceId: number | null;
		}>;
		createBinding: (args: { repoUrl: string; repoName: string; jmSpaceId: number }) => Promise<{
			bindingId: number;
			jmSpaceId: number;
			repoName: string;
		}>;
		deleteDoc: (docId: number) => Promise<void>;
		resolveBaseUrl: () => Promise<string>;
		resolveEnvKey: () => Promise<string>;
	}> = {},
): JolliMemoryPushClient {
	return {
		push: vi.fn(overrides.push ?? (async () => fakePushResult())),
		listSpaces: vi.fn(overrides.listSpaces ?? (async () => ({ spaces: [], defaultSpaceId: null }))),
		createBinding: vi.fn(overrides.createBinding ?? (async () => ({ bindingId: 1, jmSpaceId: 1, repoName: "r" }))),
		deleteDoc: vi.fn(overrides.deleteDoc ?? (async () => undefined)),
		resolveBaseUrl: vi.fn(overrides.resolveBaseUrl ?? (async () => BASE)),
		resolveEnvKey: vi.fn(overrides.resolveEnvKey ?? (async () => ENV_KEY)),
	} as unknown as JolliMemoryPushClient;
}

function baseCtx(client: JolliMemoryPushClient, overrides: Partial<PushContext> = {}): PushContext {
	return { cwd: "/repo", baseUrl: BASE, repoUrl: "https://github.com/jolliai/jolli", client, ...overrides };
}

describe("pushSummary", () => {
	beforeEach(() => {
		vi.mocked(storeSummary).mockReset().mockResolvedValue(undefined);
		vi.mocked(readPlanFromBranch).mockReset().mockResolvedValue(null);
		vi.mocked(readNoteFromBranch).mockReset().mockResolvedValue(null);
		vi.mocked(loadPushPending).mockReset().mockResolvedValue({ version: 1, entries: {} });
		vi.mocked(getIndexEntryMap).mockReset().mockResolvedValue(new Map());
		vi.mocked(readReferenceFromBranch).mockReset().mockResolvedValue(null);
		vi.mocked(saveSpaceBindingCache).mockReset().mockResolvedValue(undefined);
		vi.mocked(clearSpaceBindingCache).mockReset().mockResolvedValue(undefined);
	});

	it("passes the server's jmSpace echo through on the result (absent on older servers)", async () => {
		const withEcho = fakeClient({
			push: async () => fakePushResult({ jmSpace: { id: 7, name: "Acme Core" } }),
		});
		const echoed = await pushSummary(leaf(), baseCtx(withEcho));
		expect(echoed.jmSpace).toEqual({ id: 7, name: "Acme Core" });

		const withoutEcho = fakeClient();
		const plain = await pushSummary(leaf(), baseCtx(withoutEcho));
		expect(plain.jmSpace).toBeUndefined();
	});

	it("deletes the freshly-pushed article and skips force-store when the commit became a child mid-push", async () => {
		const client = fakeClient();
		const summary = leaf();
		vi.mocked(getIndexEntryMap).mockResolvedValue(
			new Map<
				string,
				{
					readonly commitHash: string;
					readonly parentCommitHash: string | null;
					readonly commitMessage: string;
					readonly commitDate: string;
					readonly branch: string;
					readonly generatedAt: string;
				}
			>([
				[
					summary.commitHash,
					{
						commitHash: summary.commitHash,
						parentCommitHash: "def4567890",
						commitMessage: "",
						commitDate: "",
						branch: summary.branch,
						generatedAt: "",
					},
				],
			]),
		);

		await pushSummary(summary, baseCtx(client));

		expect(client.push).toHaveBeenCalledTimes(1);
		expect(client.deleteDoc).toHaveBeenCalledWith(42);
		expect(storeSummary).not.toHaveBeenCalled();
	});

	it("tolerates a best-effort deleteDoc failure when unwinding a mid-push re-parent", async () => {
		const client = fakeClient({ deleteDoc: async () => Promise.reject(new Error("network")) });
		const summary = leaf();
		vi.mocked(getIndexEntryMap).mockResolvedValue(
			new Map<
				string,
				{
					readonly commitHash: string;
					readonly parentCommitHash: string | null;
					readonly commitMessage: string;
					readonly commitDate: string;
					readonly branch: string;
					readonly generatedAt: string;
				}
			>([
				[
					summary.commitHash,
					{
						commitHash: summary.commitHash,
						parentCommitHash: "def4567890",
						commitMessage: "",
						commitDate: "",
						branch: summary.branch,
						generatedAt: "",
					},
				],
			]),
		);

		await expect(pushSummary(summary, baseCtx(client))).resolves.toEqual(
			expect.objectContaining({ summaryUrl: `${BASE}/articles?doc=42` }),
		);
		expect(storeSummary).not.toHaveBeenCalled();
	});

	it("pushes the summary payload and writes the docId/docUrl back via storeSummary(force=true)", async () => {
		const client = fakeClient();
		const summary = leaf();
		const ctx = baseCtx(client);

		const { summary: pushed, summaryUrl } = await pushSummary(summary, ctx);

		expect(client.push).toHaveBeenCalledWith(
			expect.objectContaining({
				docType: "summary",
				repoUrl: ctx.repoUrl,
				relativePath: buildBranchRelativePath(summary.branch),
				title: buildPushTitle(summary),
				commitHash: summary.commitHash,
			}),
		);
		expect(summaryUrl).toBe(`${BASE}/articles?doc=42`);
		expect(pushed.jolliDocId).toBe(42);
		expect(pushed.jolliDocUrl).toBe(summaryUrl);
		expect(storeSummary).toHaveBeenCalledWith(
			expect.objectContaining({ jolliDocId: 42, jolliDocUrl: summaryUrl }),
			"/repo",
			true,
			undefined,
			undefined,
		);
	});

	it("includes docId in the payload when the summary already carries jolliDocId", async () => {
		const client = fakeClient();
		const summary = leaf({ jolliDocId: 7, jolliDocUrl: `${BASE}/articles?doc=7` });
		await pushSummary(summary, baseCtx(client));

		expect(client.push).toHaveBeenCalledWith(expect.objectContaining({ docId: 7 }));
	});

	it("omits docId from the payload on a first push", async () => {
		const client = fakeClient();
		await pushSummary(leaf(), baseCtx(client));

		const payload = vi.mocked(client.push).mock.calls[0][0];
		expect(payload.docId).toBeUndefined();
	});

	it("writes back a doc URL whose origin keys to the current push env", async () => {
		const client = fakeClient();
		const { summary: pushed } = await pushSummary(leaf(), baseCtx(client));
		// No separate env tag — the written-back URL's origin IS the env, so a
		// same-env re-push would reuse this docId.
		expect(canReuseDocId(pushed.jolliDocUrl, ENV_KEY)).toBe(true);
	});

	it("reuses the docId when the summary's stored URL origin matches the current env", async () => {
		const client = fakeClient();
		const summary = leaf({ jolliDocId: 7, jolliDocUrl: `${BASE}/articles?doc=7` });
		await pushSummary(summary, baseCtx(client));
		expect(client.push).toHaveBeenCalledWith(expect.objectContaining({ docId: 7 }));
	});

	it("does NOT reuse the docId when the summary was pushed to a different backend (creates fresh)", async () => {
		const client = fakeClient();
		const summary = leaf({
			jolliDocId: 7,
			jolliDocUrl: "https://jolli-local.me/t/articles?doc=7",
		});
		const { summary: pushed } = await pushSummary(summary, baseCtx(client));

		const payload = vi.mocked(client.push).mock.calls[0][0];
		expect(payload.docId).toBeUndefined();
		// Write-back carries the freshly-created docId and a current-env URL.
		expect(canReuseDocId(pushed.jolliDocUrl, ENV_KEY)).toBe(true);
		expect(pushed.jolliDocId).toBe(42);
	});

	it("pushes an owned plan attachment once and writes its docId/url back onto the summary's plans", async () => {
		const client = fakeClient({
			push: async (payload) =>
				payload.docType === "plan" ? fakePushResult({ docId: 99 }) : fakePushResult({ docId: 42 }),
		});
		vi.mocked(readPlanFromBranch).mockResolvedValue("# Plan content");
		const p = plan({ slug: "p1" });
		const summary = leaf({ plans: [p] });

		const { summary: pushed } = await pushSummary(summary, baseCtx(client), { plans: [p], notes: [] });

		expect(client.push).toHaveBeenCalledWith(
			expect.objectContaining({ docType: "plan", commitHash: summary.commitHash }),
		);
		expect(pushed.plans?.[0].jolliPlanDocId).toBe(99);
		expect(pushed.plans?.[0].jolliPlanDocUrl).toBe(`${BASE}/articles?doc=99`);
	});

	it("includes docId in the plan payload when the plan already carries jolliPlanDocId", async () => {
		const client = fakeClient();
		vi.mocked(readPlanFromBranch).mockResolvedValue("# Plan content");
		const p = plan({ slug: "p1", jolliPlanDocId: 33 });
		const summary = leaf({ plans: [p] });

		await pushSummary(summary, baseCtx(client), { plans: [p], notes: [] });

		expect(client.push).toHaveBeenCalledWith(expect.objectContaining({ docType: "plan", docId: 33 }));
	});

	it("skips a plan whose content can't be read from the branch (no attachment push, no failure)", async () => {
		const client = fakeClient();
		vi.mocked(readPlanFromBranch).mockResolvedValue(null);
		const p = plan({ slug: "missing" });
		const summary = leaf({ plans: [p] });

		await pushSummary(summary, baseCtx(client), { plans: [p], notes: [] });

		expect(client.push).toHaveBeenCalledTimes(1); // only the summary push
	});

	it("pushes a note attachment and writes its docId/url back", async () => {
		const client = fakeClient({
			push: async (payload) =>
				payload.docType === "note" ? fakePushResult({ docId: 55 }) : fakePushResult({ docId: 42 }),
		});
		vi.mocked(readNoteFromBranch).mockResolvedValue("note body");
		const n = note({ id: "n1", format: "markdown" });
		const summary = leaf({ notes: [n] });

		const { summary: pushed } = await pushSummary(summary, baseCtx(client), { plans: [], notes: [n] });

		expect(pushed.notes?.[0].jolliNoteDocId).toBe(55);
		expect(pushed.notes?.[0].jolliNoteDocUrl).toBe(`${BASE}/articles?doc=55`);
	});

	it("includes docId in the note payload when the note already carries jolliNoteDocId", async () => {
		const client = fakeClient();
		vi.mocked(readNoteFromBranch).mockResolvedValue("note body");
		const n = note({ id: "n1", format: "markdown", jolliNoteDocId: 66 });
		const summary = leaf({ notes: [n] });

		await pushSummary(summary, baseCtx(client), { plans: [], notes: [n] });

		expect(client.push).toHaveBeenCalledWith(expect.objectContaining({ docType: "note", docId: 66 }));
	});

	it("skips a note whose content can't be read from the branch (no attachment push, no failure)", async () => {
		const client = fakeClient();
		vi.mocked(readNoteFromBranch).mockResolvedValue(null);
		const n = note({ id: "missing", format: "markdown" });
		const summary = leaf({ notes: [n] });

		await pushSummary(summary, baseCtx(client), { plans: [], notes: [n] });

		expect(client.push).toHaveBeenCalledTimes(1); // only the summary push
	});

	it("propagates BindingRequiredError from a note push (fatal)", async () => {
		const client = fakeClient({
			push: async (payload) => {
				if (payload.docType === "note") throw new BindingRequiredError("repo-x");
				return fakePushResult();
			},
		});
		vi.mocked(readNoteFromBranch).mockResolvedValue("note body");
		const n = note({ id: "n1", format: "markdown" });
		const summary = leaf({ notes: [n] });

		await expect(pushSummary(summary, baseCtx(client), { plans: [], notes: [n] })).rejects.toBeInstanceOf(
			BindingRequiredError,
		);
	});

	it("propagates ClientOutdatedError from a note push (fatal, not swallowed as best-effort)", async () => {
		const client = fakeClient({
			push: async (payload) => {
				if (payload.docType === "note") throw new ClientOutdatedError();
				return fakePushResult();
			},
		});
		vi.mocked(readNoteFromBranch).mockResolvedValue("note body");
		const n = note({ id: "n1", format: "markdown" });
		const summary = leaf({ notes: [n] });

		await expect(pushSummary(summary, baseCtx(client), { plans: [], notes: [n] })).rejects.toBeInstanceOf(
			ClientOutdatedError,
		);
	});

	it("logs and continues past a non-fatal note push failure", async () => {
		const client = fakeClient({
			push: async (payload) => {
				if (payload.docType === "note") throw new Error("HTTP 500");
				return fakePushResult();
			},
		});
		vi.mocked(readNoteFromBranch).mockResolvedValue("note body");
		const n = note({ id: "n1", format: "markdown" });
		const summary = leaf({ notes: [n] });

		const { summaryUrl } = await pushSummary(summary, baseCtx(client), { plans: [], notes: [n] });
		expect(summaryUrl).toBe(`${BASE}/articles?doc=42`);
	});

	it("logs and continues past a non-fatal note push failure that throws a non-Error value", async () => {
		const client = fakeClient({
			push: async (payload) => {
				if (payload.docType === "note") throw "note push exploded";
				return fakePushResult();
			},
		});
		vi.mocked(readNoteFromBranch).mockResolvedValue("note body");
		const n = note({ id: "n1", format: "markdown" });
		const summary = leaf({ notes: [n] });

		const { summaryUrl } = await pushSummary(summary, baseCtx(client), { plans: [], notes: [n] });
		expect(summaryUrl).toBe(`${BASE}/articles?doc=42`);
	});

	it("uses a snippet note's inline content instead of reading from the branch", async () => {
		const client = fakeClient();
		const n = note({ id: "n1", format: "snippet", content: "inline body" });
		const summary = leaf({ notes: [n] });

		await pushSummary(summary, baseCtx(client), { plans: [], notes: [n] });

		expect(readNoteFromBranch).not.toHaveBeenCalled();
		expect(client.push).toHaveBeenCalledWith(expect.objectContaining({ docType: "note", content: "inline body" }));
	});

	it("propagates BindingRequiredError from an attachment push (fatal)", async () => {
		const client = fakeClient({
			push: async (payload) => {
				if (payload.docType === "plan") throw new BindingRequiredError("repo-x");
				return fakePushResult();
			},
		});
		vi.mocked(readPlanFromBranch).mockResolvedValue("# Plan");
		const p = plan({ slug: "p1" });
		const summary = leaf({ plans: [p] });

		await expect(pushSummary(summary, baseCtx(client), { plans: [p], notes: [] })).rejects.toBeInstanceOf(
			BindingRequiredError,
		);
	});

	it("propagates ClientOutdatedError from a plan push (fatal, not swallowed as best-effort)", async () => {
		const client = fakeClient({
			push: async (payload) => {
				if (payload.docType === "plan") throw new ClientOutdatedError();
				return fakePushResult();
			},
		});
		vi.mocked(readPlanFromBranch).mockResolvedValue("# Plan");
		const p = plan({ slug: "p1" });
		const summary = leaf({ plans: [p] });

		await expect(pushSummary(summary, baseCtx(client), { plans: [p], notes: [] })).rejects.toBeInstanceOf(
			ClientOutdatedError,
		);
	});

	it("logs and continues past a non-fatal attachment push failure", async () => {
		const client = fakeClient({
			push: async (payload) => {
				if (payload.docType === "plan") throw new Error("HTTP 500");
				return fakePushResult();
			},
		});
		vi.mocked(readPlanFromBranch).mockResolvedValue("# Plan");
		const p = plan({ slug: "p1" });
		const summary = leaf({ plans: [p] });

		const { summaryUrl } = await pushSummary(summary, baseCtx(client), { plans: [p], notes: [] });
		expect(summaryUrl).toBe(`${BASE}/articles?doc=42`);
	});

	it("logs and continues past a non-fatal plan push failure that throws a non-Error value", async () => {
		const client = fakeClient({
			push: async (payload) => {
				if (payload.docType === "plan") throw "plan push exploded";
				return fakePushResult();
			},
		});
		vi.mocked(readPlanFromBranch).mockResolvedValue("# Plan");
		const p = plan({ slug: "p1" });
		const summary = leaf({ plans: [p] });

		const { summaryUrl } = await pushSummary(summary, baseCtx(client), { plans: [p], notes: [] });
		expect(summaryUrl).toBe(`${BASE}/articles?doc=42`);
	});

	it("propagates BindingRequiredError from the summary push itself", async () => {
		const client = fakeClient({
			push: async () => {
				throw new BindingRequiredError("repo-x");
			},
		});
		await expect(pushSummary(leaf(), baseCtx(client))).rejects.toBeInstanceOf(BindingRequiredError);
	});

	it("deletes orphaned docs after a successful push and drops the deleted ids from the persisted summary", async () => {
		const client = fakeClient();
		const summary = leaf({ orphanedDocIds: [1, 2] });

		await pushSummary(summary, baseCtx(client));

		expect(client.deleteDoc).toHaveBeenCalledWith(1);
		expect(client.deleteDoc).toHaveBeenCalledWith(2);
		const lastStoreCall = vi.mocked(storeSummary).mock.calls.at(-1);
		expect(lastStoreCall?.[0].orphanedDocIds).toBeUndefined();
	});

	it("keeps orphaned ids that fail to delete, for retry on the next push", async () => {
		const client = fakeClient({
			deleteDoc: async (id: number) => {
				if (id === 2) throw new Error("delete failed");
			},
		});
		const summary = leaf({ orphanedDocIds: [1, 2] });

		await pushSummary(summary, baseCtx(client));

		const lastStoreCall = vi.mocked(storeSummary).mock.calls.at(-1);
		expect(lastStoreCall?.[0].orphanedDocIds).toEqual([2]);
	});

	it("keeps every orphaned id (skips the deleted-count log) when every delete fails", async () => {
		const client = fakeClient({
			deleteDoc: async () => {
				throw new Error("delete failed");
			},
		});
		const summary = leaf({ orphanedDocIds: [1, 2] });

		await pushSummary(summary, baseCtx(client));

		const lastStoreCall = vi.mocked(storeSummary).mock.calls.at(-1);
		expect(lastStoreCall?.[0].orphanedDocIds).toEqual([1, 2]);
	});

	it("does not fail the overall push when orphan cleanup itself throws", async () => {
		const client = fakeClient();
		vi.mocked(storeSummary)
			.mockResolvedValueOnce(undefined) // the write-back store
			.mockRejectedValueOnce(new Error("cleanup store failed")); // the cleanup store
		const summary = leaf({ orphanedDocIds: [1] });

		const { summaryUrl } = await pushSummary(summary, baseCtx(client));
		expect(summaryUrl).toBe(`${BASE}/articles?doc=42`);
	});

	it("does not fail the overall push when orphan cleanup throws a non-Error value", async () => {
		const client = fakeClient();
		vi.mocked(storeSummary)
			.mockResolvedValueOnce(undefined) // the write-back store
			.mockRejectedValueOnce("cleanup exploded (string, not Error)"); // the cleanup store
		const summary = leaf({ orphanedDocIds: [1] });

		const { summaryUrl } = await pushSummary(summary, baseCtx(client));
		expect(summaryUrl).toBe(`${BASE}/articles?doc=42`);
	});

	it("resolves unresolvedOrphanHashes into orphanedDocIds for cleanup", async () => {
		const client = fakeClient();
		const summary = leaf({ unresolvedOrphanHashes: ["child1hash", "child2hash"] });
		vi.mocked(getSummary)
			.mockResolvedValueOnce(leaf({ commitHash: "child1hash", jolliDocId: 201 }))
			.mockResolvedValueOnce(leaf({ commitHash: "child2hash", jolliDocId: 202 }));

		await pushSummary(summary, baseCtx(client));

		expect(client.deleteDoc).toHaveBeenCalledWith(201);
		expect(client.deleteDoc).toHaveBeenCalledWith(202);
		const resolveStoreCall = vi.mocked(storeSummary).mock.calls[1];
		expect(resolveStoreCall?.[0].unresolvedOrphanHashes).toBeUndefined();
		expect(resolveStoreCall?.[0].orphanedDocIds).toEqual([201, 202]);
	});

	it("discards unresolvedOrphanHashes that still have no jolliDocId (never pushed)", async () => {
		const client = fakeClient();
		const summary = leaf({ unresolvedOrphanHashes: ["child1hash", "child2hash"] });
		vi.mocked(getSummary)
			.mockResolvedValueOnce(leaf({ commitHash: "child1hash" }))
			.mockResolvedValueOnce(null);

		await pushSummary(summary, baseCtx(client));

		expect(client.deleteDoc).not.toHaveBeenCalled();
		const resolveStoreCall = vi.mocked(storeSummary).mock.calls[1];
		expect(resolveStoreCall?.[0].unresolvedOrphanHashes).toBeUndefined();
		expect(resolveStoreCall?.[0].orphanedDocIds).toBeUndefined();
	});

	it("retains an unresolved hash while its pre-push worker is still pending", async () => {
		const client = fakeClient();
		const summary = leaf({ unresolvedOrphanHashes: ["child1hash", "child2hash"] });
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: {
				child1hash: {
					branch: "feature/x",
					enqueuedAt: "2026-01-01T00:00:00.000Z",
					retryCount: 0,
				},
			},
		});
		vi.mocked(getSummary).mockResolvedValue(null);

		await pushSummary(summary, baseCtx(client));

		const resolveStoreCall = vi.mocked(storeSummary).mock.calls[1];
		expect(resolveStoreCall?.[0].unresolvedOrphanHashes).toEqual(["child1hash"]);
	});

	it("conservatively retains unresolved hashes when the pending file cannot be read", async () => {
		const client = fakeClient();
		const summary = leaf({ unresolvedOrphanHashes: ["child1hash"] });
		vi.mocked(loadPushPending).mockRejectedValue(new Error("lock unavailable"));
		vi.mocked(getSummary).mockResolvedValue(null);

		const result = await pushSummary(summary, baseCtx(client));

		expect(result.summary.unresolvedOrphanHashes).toEqual(["child1hash"]);
		expect(storeSummary).toHaveBeenCalledTimes(1);
	});

	it("merges resolved orphan hashes with existing orphanedDocIds", async () => {
		const client = fakeClient();
		const summary = leaf({
			orphanedDocIds: [100],
			unresolvedOrphanHashes: ["child1hash"],
		});
		vi.mocked(getSummary).mockResolvedValueOnce(leaf({ commitHash: "child1hash", jolliDocId: 201 }));

		await pushSummary(summary, baseCtx(client));

		expect(client.deleteDoc).toHaveBeenCalledWith(100);
		expect(client.deleteDoc).toHaveBeenCalledWith(201);
	});

	it("pushes a reference as a standalone `reference` article and writes its docId/url back", async () => {
		const client = fakeClient({
			push: async (payload) =>
				payload.docType === "reference" ? fakePushResult({ docId: 77 }) : fakePushResult({ docId: 42 }),
		});
		const ref = reference({ archivedKey: "linear:ENG-1-a1b2c3d4" });
		const summary = leaf({ references: [ref] });

		const { summary: pushed } = await pushSummary(summary, baseCtx(client), {
			plans: [],
			notes: [],
			references: [ref],
		});

		expect(client.push).toHaveBeenCalledWith(
			expect.objectContaining({ docType: "reference", commitHash: summary.commitHash }),
		);
		expect(pushed.references?.[0].jolliReferenceDocId).toBe(77);
		expect(pushed.references?.[0].jolliReferenceDocUrl).toBe(`${BASE}/articles?doc=77`);
	});

	it("reuses the reference docId when its stored URL origin matches the current env", async () => {
		const client = fakeClient();
		const ref = reference({ jolliReferenceDocId: 77, jolliReferenceDocUrl: `${BASE}/articles?doc=77` });
		const summary = leaf({ references: [ref] });
		await pushSummary(summary, baseCtx(client), { plans: [], notes: [], references: [ref] });

		expect(client.push).toHaveBeenCalledWith(expect.objectContaining({ docType: "reference", docId: 77 }));
	});

	it("does NOT reuse the reference docId when it was minted against a different backend", async () => {
		const client = fakeClient();
		const ref = reference({
			jolliReferenceDocId: 77,
			jolliReferenceDocUrl: "https://jolli-local.me/t/articles?doc=77",
		});
		const summary = leaf({ references: [ref] });
		await pushSummary(summary, baseCtx(client), { plans: [], notes: [], references: [ref] });

		const refPayload = vi.mocked(client.push).mock.calls.find((c) => c[0].docType === "reference")?.[0];
		expect(refPayload?.docId).toBeUndefined();
	});

	it("pushes the summary's own references when no attachment selection is given", async () => {
		const client = fakeClient();
		const summary = leaf({ references: [reference()] });
		await pushSummary(summary, baseCtx(client));
		expect(client.push).toHaveBeenCalledWith(expect.objectContaining({ docType: "reference" }));
	});
});

// ─── pushBranchToJolli ──────────────────────────────────────────────────────

describe("pushBranchToJolli", () => {
	beforeEach(() => {
		vi.mocked(storeSummary).mockReset().mockResolvedValue(undefined);
		vi.mocked(readPlanFromBranch).mockReset().mockResolvedValue(null);
		vi.mocked(readNoteFromBranch).mockReset().mockResolvedValue(null);
		vi.mocked(getActiveStorage).mockReset().mockReturnValue(undefined);
		vi.mocked(getCanonicalRepoUrl).mockReset().mockResolvedValue("https://github.com/jolliai/jolli");
		vi.mocked(getDefaultBranch).mockReset().mockResolvedValue("main");
		vi.mocked(loadBranchSummaries).mockReset();
		vi.mocked(saveSpaceBindingCache).mockReset().mockResolvedValue(undefined);
		vi.mocked(clearSpaceBindingCache).mockReset().mockResolvedValue(undefined);
	});

	it("persists the binding cache when a pushed summary echoes the bound Space", async () => {
		vi.mocked(loadBranchSummaries).mockResolvedValue({ summaries: [leaf()], missingCount: 0 });
		const client = fakeClient({
			push: async () => fakePushResult({ jmSpace: { id: 7, name: "Acme Core" } }),
		});

		const result = await pushBranchToJolli({ cwd: "/repo", client });

		expect(result.type).toBe("pushed");
		expect(saveSpaceBindingCache).toHaveBeenCalledWith("/repo", {
			repoUrl: "https://github.com/jolliai/jolli",
			origin: BASE,
			jmSpaceId: 7,
			spaceName: "Acme Core",
			canPush: true,
		});
	});

	it("leaves the binding cache untouched when the server echoes no Space (older server)", async () => {
		vi.mocked(loadBranchSummaries).mockResolvedValue({ summaries: [leaf()], missingCount: 0 });
		const client = fakeClient();

		await pushBranchToJolli({ cwd: "/repo", client });

		expect(saveSpaceBindingCache).not.toHaveBeenCalled();
		expect(clearSpaceBindingCache).not.toHaveBeenCalled();
	});

	it("clears the binding cache after an explicit --space bind (rebuilt by the push echo / next probe)", async () => {
		vi.mocked(loadBranchSummaries).mockResolvedValue({ summaries: [leaf()], missingCount: 0 });
		const client = fakeClient({
			listSpaces: async () => ({ spaces: [{ id: 5, name: "Eng", slug: "eng" }], defaultSpaceId: null }),
		});

		await pushBranchToJolli({ cwd: "/repo", client, space: "eng" });

		expect(clearSpaceBindingCache).toHaveBeenCalledWith("/repo");
	});

	it("pushes every summary on base..HEAD and returns their urls", async () => {
		const s1 = leaf({ commitHash: "c1" });
		const s2 = leaf({ commitHash: "c2" });
		vi.mocked(loadBranchSummaries).mockResolvedValue({ summaries: [s1, s2], missingCount: 1 });
		const client = fakeClient({
			push: async () => fakePushResult({ docId: 10 }),
		});

		const result = await pushBranchToJolli({ cwd: "/repo", client });

		expect(result).toEqual({
			type: "pushed",
			pushed: 2,
			skipped: 1,
			urls: [`${BASE}/articles?doc=10`, `${BASE}/articles?doc=10`],
		});
		expect(client.push).toHaveBeenCalledTimes(2);
	});

	it("dedups a plan recurring across two commits to a single push (assignOwnedAttachments)", async () => {
		const recurringPlan = plan({ slug: "refactor-a1b2c3d4", updatedAt: "2026-02-01T00:00:00.000Z" });
		const s1 = leaf({
			commitHash: "c1",
			plans: [plan({ slug: "refactor-a1b2c3d4", updatedAt: "2026-01-01T00:00:00.000Z" })],
		});
		const s2 = leaf({ commitHash: "c2", plans: [recurringPlan] });
		vi.mocked(loadBranchSummaries).mockResolvedValue({ summaries: [s1, s2], missingCount: 0 });
		vi.mocked(readPlanFromBranch).mockResolvedValue("# Plan content");
		const client = fakeClient({
			push: async (payload) =>
				payload.docType === "plan" ? fakePushResult({ docId: 77 }) : fakePushResult({ docId: 10 }),
		});

		await pushBranchToJolli({ cwd: "/repo", client });

		// One owner (c2, the latest revision) pushes the plan exactly once.
		const planPushes = vi.mocked(client.push).mock.calls.filter(([p]) => p.docType === "plan");
		expect(planPushes).toHaveLength(1);
		expect(planPushes[0][0].commitHash).toBe("c2");
	});

	it("returns binding_required (with the space list) when the client throws BindingRequiredError and no space was given", async () => {
		vi.mocked(loadBranchSummaries).mockResolvedValue({ summaries: [leaf()], missingCount: 0 });
		const spaces = [{ id: 1, name: "Eng", slug: "eng" }];
		const client = fakeClient({
			push: async () => {
				throw new BindingRequiredError("https://github.com/jolliai/jolli");
			},
			listSpaces: async () => ({ spaces, defaultSpaceId: 1 }),
		});

		const result = await pushBranchToJolli({ cwd: "/repo", client });

		expect(result).toEqual({
			type: "binding_required",
			repoUrl: "https://github.com/jolliai/jolli",
			spaces,
			defaultSpaceId: 1,
		});
	});

	it("still returns binding_required (empty space list) when listSpaces itself fails", async () => {
		vi.mocked(loadBranchSummaries).mockResolvedValue({ summaries: [leaf()], missingCount: 0 });
		const client = fakeClient({
			push: async () => {
				throw new BindingRequiredError("https://github.com/jolliai/jolli");
			},
			// The enrichment call fails — the outcome must NOT downgrade to a generic
			// error, or the caller loses the "re-run with --space" affordance.
			listSpaces: async () => {
				throw new Error("network down");
			},
		});

		const result = await pushBranchToJolli({ cwd: "/repo", client });

		expect(result).toEqual({
			type: "binding_required",
			repoUrl: "https://github.com/jolliai/jolli",
			spaces: [],
			defaultSpaceId: null,
		});
	});

	it("creates a binding first when `space` is given and unbound, then pushes", async () => {
		vi.mocked(loadBranchSummaries).mockResolvedValue({ summaries: [leaf()], missingCount: 0 });
		const client = fakeClient({
			listSpaces: async () => ({ spaces: [{ id: 5, name: "Eng", slug: "eng" }], defaultSpaceId: null }),
		});

		const result = await pushBranchToJolli({ cwd: "/repo", client, space: "eng" });

		expect(client.listSpaces).toHaveBeenCalled(); // to resolve the "eng" slug to an id
		expect(client.createBinding).toHaveBeenCalledWith(
			expect.objectContaining({ repoUrl: "https://github.com/jolliai/jolli" }),
		);
		expect(result.type).toBe("pushed");
	});

	it("resolves a numeric `space` option to a raw id when it matches no name/slug", async () => {
		vi.mocked(loadBranchSummaries).mockResolvedValue({ summaries: [leaf()], missingCount: 0 });
		const client = fakeClient();

		await pushBranchToJolli({ cwd: "/repo", client, space: "42" });

		// resolveSpaceId lists spaces first (so a digit-named Space can win by name);
		// "42" matches none here, so it falls back to the raw id 42.
		expect(client.listSpaces).toHaveBeenCalled();
		expect(client.createBinding).toHaveBeenCalledWith(expect.objectContaining({ jmSpaceId: 42 }));
	});

	it("fails closed (does not push) when a 409 omits the existing space and it can't be confirmed", async () => {
		vi.mocked(loadBranchSummaries).mockResolvedValue({ summaries: [leaf()], missingCount: 0 });
		const client = fakeClient({
			listSpaces: async () => ({ spaces: [{ id: 5, name: "Eng", slug: "eng" }], defaultSpaceId: null }),
			// Server reports the repo is already bound but omits which space
			// (existingSpaceId undefined) — we can't confirm it matches `eng`.
			createBinding: async () => {
				throw new BindingAlreadyExistsError();
			},
		});

		const result = await pushBranchToJolli({ cwd: "/repo", client, space: "eng" });
		expect(result.type).toBe("error");
		expect(result.type === "error" && result.message).toContain("another Jolli Space");
		// It must NOT have pushed to a space it couldn't confirm.
		expect(client.push).not.toHaveBeenCalled();
	});

	it("still pushes when the existing binding is the SAME space the user requested", async () => {
		vi.mocked(loadBranchSummaries).mockResolvedValue({ summaries: [leaf()], missingCount: 0 });
		const client = fakeClient({
			listSpaces: async () => ({ spaces: [{ id: 5, name: "Eng", slug: "eng" }], defaultSpaceId: null }),
			// Already bound to space 5 — the same one `eng` resolves to.
			createBinding: async () => {
				throw new BindingAlreadyExistsError("already", 5);
			},
		});

		const result = await pushBranchToJolli({ cwd: "/repo", client, space: "eng" });
		expect(result.type).toBe("pushed");
	});

	it("errors (does not silently push to the wrong space) when bound to a DIFFERENT space", async () => {
		vi.mocked(loadBranchSummaries).mockResolvedValue({ summaries: [leaf()], missingCount: 0 });
		const client = fakeClient({
			listSpaces: async () => ({ spaces: [{ id: 5, name: "Eng", slug: "eng" }], defaultSpaceId: null }),
			// User asked for `eng` (id 5) but the repo is already bound to space 9.
			createBinding: async () => {
				throw new BindingAlreadyExistsError("already", 9);
			},
		});

		const result = await pushBranchToJolli({ cwd: "/repo", client, space: "eng" });

		expect(result.type).toBe("error");
		expect(result.type === "error" && result.message).toContain("9");
		// It must NOT have pushed anything to the wrong space.
		expect(client.push).not.toHaveBeenCalled();
	});

	it("propagates a non-BindingAlreadyExistsError from a proactive createBinding as a fatal error", async () => {
		const client = fakeClient({
			listSpaces: async () => ({ spaces: [{ id: 5, name: "Eng", slug: "eng" }], defaultSpaceId: null }),
			createBinding: async () => {
				throw new Error("binding server exploded");
			},
		});

		const result = await pushBranchToJolli({ cwd: "/repo", client, space: "eng" });
		expect(result).toEqual({ type: "error", message: "binding server exploded" });
	});

	it("resolves a given `space` value that matches only a Space's name (not its slug)", async () => {
		vi.mocked(loadBranchSummaries).mockResolvedValue({ summaries: [leaf()], missingCount: 0 });
		const client = fakeClient({
			listSpaces: async () => ({
				spaces: [{ id: 9, name: "Engineering Team", slug: "eng-team" }],
				defaultSpaceId: null,
			}),
		});

		const result = await pushBranchToJolli({ cwd: "/repo", client, space: "Engineering Team" });

		expect(client.createBinding).toHaveBeenCalledWith(expect.objectContaining({ jmSpaceId: 9 }));
		expect(result.type).toBe("pushed");
	});

	it("throws when a given `space` name/slug matches no known space", async () => {
		const client = fakeClient({ listSpaces: async () => ({ spaces: [], defaultSpaceId: null }) });

		const result = await pushBranchToJolli({ cwd: "/repo", client, space: "nonexistent" });
		expect(result).toEqual({ type: "error", message: 'No Jolli Space matches "nonexistent"' });
	});

	it("maps NotAuthenticatedError to a type:error result", async () => {
		const client = fakeClient({
			push: async () => {
				throw new NotAuthenticatedError("not signed in");
			},
		});
		vi.mocked(loadBranchSummaries).mockResolvedValue({ summaries: [leaf()], missingCount: 0 });

		const result = await pushBranchToJolli({ cwd: "/repo", client });
		expect(result).toEqual({ type: "error", message: "not signed in" });
	});

	it("maps an unexpected error to a type:error result", async () => {
		vi.mocked(getCanonicalRepoUrl).mockRejectedValue(new Error("git blew up"));
		const client = fakeClient();

		const result = await pushBranchToJolli({ cwd: "/repo", client });
		expect(result).toEqual({ type: "error", message: "git blew up" });
	});

	it("surfaces a ClientOutdatedError from an attachment push as a fatal type:error (not a silent pushed success)", async () => {
		vi.mocked(loadBranchSummaries).mockResolvedValue({
			summaries: [leaf({ plans: [plan({ slug: "p1" })] })],
			missingCount: 0,
		});
		vi.mocked(readPlanFromBranch).mockResolvedValue("# Plan");
		const client = fakeClient({
			push: async (payload) => {
				if (payload.docType === "plan") throw new ClientOutdatedError("update the CLI");
				return fakePushResult();
			},
		});

		const result = await pushBranchToJolli({ cwd: "/repo", client });
		expect(result).toEqual({ type: "error", message: "update the CLI" });
	});

	it("maps a thrown non-Error value to a type:error result", async () => {
		vi.mocked(getCanonicalRepoUrl).mockRejectedValue("repo resolution exploded (string, not Error)");
		const client = fakeClient();

		const result = await pushBranchToJolli({ cwd: "/repo", client });
		expect(result).toEqual({ type: "error", message: "repo resolution exploded (string, not Error)" });
	});

	it("defaults the base branch via getDefaultBranch when baseBranch is omitted", async () => {
		vi.mocked(loadBranchSummaries).mockResolvedValue({ summaries: [], missingCount: 0 });
		const client = fakeClient();

		await pushBranchToJolli({ cwd: "/repo", client });

		expect(getDefaultBranch).toHaveBeenCalledWith("/repo");
		expect(loadBranchSummaries).toHaveBeenCalledWith("/repo", "main");
	});

	it("constructs a real JolliMemoryPushClient when no client override is given", async () => {
		vi.mocked(getCanonicalRepoUrl).mockRejectedValue(new Error("stop before any network call"));
		const result = await pushBranchToJolli({ cwd: "/repo" });
		expect(result.type).toBe("error");
	});
});

// ─── Batch push helpers ──────────────────────────────────────────────────────

describe("docUrlPlaceholder", () => {
	it("builds the lockstep placeholder shape", () => {
		expect(docUrlPlaceholder("plan-0")).toBe("{{jolli:doc:plan-0}}");
	});
});

describe("buildBatchItems", () => {
	beforeEach(() => {
		vi.mocked(readPlanFromBranch).mockReset().mockResolvedValue(null);
		vi.mocked(readNoteFromBranch).mockReset().mockResolvedValue(null);
		vi.mocked(readReferenceFromBranch).mockReset().mockResolvedValue(null);
	});

	function owned(overrides: {
		plans?: Map<string, ReadonlyArray<PlanReference>>;
		notes?: Map<string, ReadonlyArray<NoteReference>>;
		references?: Map<string, ReadonlyArray<ReferenceCommitRef>>;
	}) {
		return {
			ownedPlans: overrides.plans ?? new Map(),
			ownedNotes: overrides.notes ?? new Map(),
			ownedReferences: overrides.references ?? new Map(),
		};
	}

	it("builds one item per summary with placeholder-woven markdown and attachment keys", async () => {
		const summary = leaf({ plans: [plan()] });
		vi.mocked(readPlanFromBranch).mockResolvedValue("# Plan body");
		const ctx = baseCtx(fakeClient());

		const built = await buildBatchItems(
			[summary],
			owned({ plans: new Map([[summary.commitHash, [plan()]]]) }),
			ctx,
		);

		expect(built).toHaveLength(1);
		const item = built[0].item;
		expect(item.commitHash).toBe(summary.commitHash);
		expect(item.branch).toBe(summary.branch);
		expect(item.attachments).toHaveLength(1);
		expect(item.attachments[0]).toMatchObject({ clientKey: "plan-0", docType: "plan", content: "# Plan body" });
		// The placeholder is woven into the summary markdown where the plan URL goes.
		expect(item.summary.content).toContain(docUrlPlaceholder("plan-0"));
		// Write-back bookkeeping maps the clientKey to the plan's slug.
		expect(built[0].attachmentKeys.get("plan-0")).toEqual({ kind: "plan", key: "p1" });
		expect(built[0].batchContentChars).toBe(
			item.summary.content.length + (item.summary.summaryJson?.length ?? 0) + item.attachments[0].content.length,
		);
		expect(built[0].batchIneligibleReason).toBeUndefined();
	});

	it("marks an item with too many attachments for the per-commit fallback", async () => {
		const plans = Array.from({ length: BATCH_MAX_ATTACHMENTS_PER_ITEM + 1 }, (_, index) =>
			plan({ slug: `p-${index}` }),
		);
		const summary = leaf({ plans });
		vi.mocked(readPlanFromBranch).mockResolvedValue("# Plan body");

		const built = await buildBatchItems(
			[summary],
			owned({ plans: new Map([[summary.commitHash, plans]]) }),
			baseCtx(fakeClient()),
		);

		expect(built[0].item.attachments).toHaveLength(BATCH_MAX_ATTACHMENTS_PER_ITEM + 1);
		expect(built[0].batchIneligibleReason).toBe("attachment count exceeds the batch limit");
	});

	it("skips a plan whose content is unreadable (no attachment, no placeholder)", async () => {
		const summary = leaf({ plans: [plan()] });
		vi.mocked(readPlanFromBranch).mockResolvedValue(null);
		const ctx = baseCtx(fakeClient());

		const built = await buildBatchItems(
			[summary],
			owned({ plans: new Map([[summary.commitHash, [plan()]]]) }),
			ctx,
		);

		expect(built[0].item.attachments).toHaveLength(0);
		expect(built[0].item.summary.content).not.toContain("{{jolli:doc:");
	});

	it("carries a reusable docId when the stored doc URL matches the push env", async () => {
		const summary = leaf({ plans: [plan()] });
		vi.mocked(readPlanFromBranch).mockResolvedValue("# Plan body");
		const reusable = plan({ jolliPlanDocId: 42, jolliPlanDocUrl: `${BASE}/articles/p-42` });
		const ctx = baseCtx(fakeClient());

		const built = await buildBatchItems(
			[summary],
			owned({ plans: new Map([[summary.commitHash, [reusable]]]) }),
			ctx,
		);

		expect(built[0].item.attachments[0].docId).toBe(42);
	});

	it("drops a docId minted on a different backend (env mismatch)", async () => {
		const summary = leaf({ plans: [plan()] });
		vi.mocked(readPlanFromBranch).mockResolvedValue("# Plan body");
		const foreign = plan({ jolliPlanDocId: 42, jolliPlanDocUrl: "https://other.jolli.dev/articles/p-42" });
		const ctx = baseCtx(fakeClient());

		const built = await buildBatchItems(
			[summary],
			owned({ plans: new Map([[summary.commitHash, [foreign]]]) }),
			ctx,
		);

		expect(built[0].item.attachments[0].docId).toBeUndefined();
	});

	it("carries the summary's own reusable docId and summaryJson", async () => {
		const summary = leaf({ jolliDocId: 7, jolliDocUrl: `${BASE}/articles/s-7` });
		const ctx = baseCtx(fakeClient());

		const built = await buildBatchItems([summary], owned({}), ctx);

		expect(built[0].item.summary.docId).toBe(7);
		expect(built[0].item.summary.summaryJson).toBeDefined();
	});

	it("reads note bodies from the inline content field without hitting storage", async () => {
		const summary = leaf({ notes: [note({ content: "inline note body" })] });
		const ctx = baseCtx(fakeClient());

		const built = await buildBatchItems(
			[summary],
			owned({ notes: new Map([[summary.commitHash, [note({ content: "inline note body" })]]]) }),
			ctx,
		);

		expect(built[0].item.attachments[0]).toMatchObject({
			clientKey: "note-0",
			docType: "note",
			content: "inline note body",
		});
		expect(readNoteFromBranch).not.toHaveBeenCalled();
	});
});

describe("applyBatchResult", () => {
	beforeEach(() => {
		vi.mocked(storeSummary).mockReset().mockResolvedValue(undefined);
		vi.mocked(getIndexEntryMap).mockReset().mockResolvedValue(new Map());
		vi.mocked(getSummary).mockReset().mockResolvedValue(null);
		vi.mocked(loadPushPending).mockReset().mockResolvedValue({ version: 1, entries: {} });
		vi.mocked(readPlanFromBranch).mockReset().mockResolvedValue("# Plan body");
		vi.mocked(readNoteFromBranch).mockReset().mockResolvedValue(null);
		vi.mocked(readReferenceFromBranch).mockReset().mockResolvedValue(null);
	});

	async function buildOne(summary: CommitSummary, plans: ReadonlyArray<PlanReference> = []) {
		const ctx = baseCtx(fakeClient());
		const built = await buildBatchItems(
			[summary],
			{
				ownedPlans: new Map(plans.length > 0 ? [[summary.commitHash, plans]] : []),
				ownedNotes: new Map(),
				ownedReferences: new Map(),
			},
			ctx,
		);
		return { ctx, built };
	}

	function okResult(summary: CommitSummary, attachments: BatchItemResult["attachments"] = []): BatchItemResult {
		return {
			commitHash: summary.commitHash,
			ok: true,
			summary: { docId: 9, url: "/articles/s-9", jrn: "jrn:9", created: true },
			attachments,
		};
	}

	it("writes back the summary docId/url and woven attachment URLs on success", async () => {
		const summary = leaf({ plans: [plan()] });
		const { ctx, built } = await buildOne(summary, [plan()]);

		const outcome = await applyBatchResult(
			built,
			[okResult(summary, [{ clientKey: "plan-0", ok: true, docId: 11, url: "/articles/p-11" }])],
			ctx,
		);

		expect(outcome).toEqual({ writtenBack: 1, childSkipped: 0 });
		expect(storeSummary).toHaveBeenCalledTimes(1);
		const stored = vi.mocked(storeSummary).mock.calls[0][0] as CommitSummary;
		expect(stored.jolliDocId).toBe(9);
		expect(stored.jolliDocUrl).toBe(`${BASE}/articles/s-9`);
		expect(stored.plans?.[0]).toMatchObject({ jolliPlanDocId: 11, jolliPlanDocUrl: `${BASE}/articles/p-11` });
	});

	it("deletes the freshly-pushed article and skips write-back when the commit became a child mid-push", async () => {
		const summary = leaf();
		const { ctx, built } = await buildOne(summary);
		vi.mocked(getIndexEntryMap).mockResolvedValue(
			new Map([
				[
					summary.commitHash,
					{
						commitHash: summary.commitHash,
						parentCommitHash: "def4567890",
						commitMessage: "",
						commitDate: "",
						branch: summary.branch,
						generatedAt: "",
					},
				],
			]),
		);

		const outcome = await applyBatchResult(built, [okResult(summary)], ctx);

		expect(outcome).toEqual({ writtenBack: 0, childSkipped: 1 });
		expect(ctx.client.deleteDoc).toHaveBeenCalledWith(9);
		expect(storeSummary).not.toHaveBeenCalled();
	});

	it("deletes only the CREATEd attachments alongside the article on the mid-push child guard", async () => {
		const summary = leaf();
		const { ctx, built } = await buildOne(summary);
		vi.mocked(getIndexEntryMap).mockResolvedValue(
			new Map([
				[
					summary.commitHash,
					{
						commitHash: summary.commitHash,
						parentCommitHash: "def4567890",
						commitMessage: "",
						commitDate: "",
						branch: summary.branch,
						generatedAt: "",
					},
				],
			]),
		);

		const outcome = await applyBatchResult(
			built,
			[
				okResult(summary, [
					{ clientKey: "plan-0", ok: true, docId: 11, url: "/articles/p-11", created: true },
					{ clientKey: "note-0", ok: true, docId: 12, url: "/articles/n-12", created: false },
					{ clientKey: "note-1", ok: true, created: true },
					{ clientKey: "ref-0", ok: false, error: "boom" },
				]),
			],
			ctx,
		);

		expect(outcome).toEqual({ writtenBack: 0, childSkipped: 1 });
		expect(ctx.client.deleteDoc).toHaveBeenCalledWith(9);
		expect(ctx.client.deleteDoc).toHaveBeenCalledWith(11);
		expect(ctx.client.deleteDoc).toHaveBeenCalledTimes(2);
		expect(storeSummary).not.toHaveBeenCalled();
	});

	it("tolerates a best-effort delete failure on the mid-push child guard", async () => {
		const summary = leaf();
		const ctx = baseCtx(fakeClient({ deleteDoc: async () => Promise.reject(new Error("network")) }));
		const built = await buildBatchItems(
			[summary],
			{ ownedPlans: new Map(), ownedNotes: new Map(), ownedReferences: new Map() },
			ctx,
		);
		vi.mocked(getIndexEntryMap).mockResolvedValue(
			new Map([
				[
					summary.commitHash,
					{
						commitHash: summary.commitHash,
						parentCommitHash: "def4567890",
						commitMessage: "",
						commitDate: "",
						branch: summary.branch,
						generatedAt: "",
					},
				],
			]),
		);

		// The created attachment's delete fails too — both stay best-effort.
		await expect(
			applyBatchResult(
				built,
				[
					okResult(summary, [
						{ clientKey: "plan-0", ok: true, docId: 11, url: "/articles/p-11", created: true },
					]),
				],
				ctx,
			),
		).resolves.toEqual({
			writtenBack: 0,
			childSkipped: 1,
		});
	});

	it("skips failed items and items with no matching built entry", async () => {
		const summary = leaf();
		const { ctx, built } = await buildOne(summary);

		const outcome = await applyBatchResult(
			built,
			[
				{ commitHash: summary.commitHash, ok: false, attachments: [], error: "boom" },
				{ ...okResult(summary), commitHash: "f".repeat(40) },
			],
			ctx,
		);

		expect(outcome).toEqual({ writtenBack: 0, childSkipped: 0 });
		expect(storeSummary).not.toHaveBeenCalled();
	});

	it("reports a per-item write-back failure with the minted ids (article is already published)", async () => {
		const summary = leaf();
		const { ctx, built } = await buildOne(summary);
		vi.mocked(storeSummary).mockRejectedValue(new Error("disk full"));

		const outcome = await applyBatchResult(built, [okResult(summary)], ctx);

		expect(outcome).toEqual({
			writtenBack: 0,
			childSkipped: 0,
			writeBackFailures: [{ commitHash: summary.commitHash, docId: 9, url: `${BASE}/articles/s-9` }],
		});
	});

	it("treats every commit as a root when the summary index cannot be read", async () => {
		const summary = leaf();
		const { ctx, built } = await buildOne(summary);
		vi.mocked(getIndexEntryMap).mockRejectedValue(new Error("index unavailable"));

		const outcome = await applyBatchResult(built, [okResult(summary)], ctx);

		expect(outcome).toEqual({ writtenBack: 1, childSkipped: 0 });
		expect(ctx.client.deleteDoc).not.toHaveBeenCalled();
		expect(storeSummary).toHaveBeenCalledTimes(1);
	});

	it("deletes orphaned articles when cleanupOrphans is set (compensation path)", async () => {
		const summary = leaf({ orphanedDocIds: [42] });
		const { ctx, built } = await buildOne(summary);

		const outcome = await applyBatchResult(built, [okResult(summary)], ctx, { cleanupOrphans: true });

		expect(outcome).toEqual({ writtenBack: 1, childSkipped: 0 });
		expect(ctx.client.deleteDoc).toHaveBeenCalledWith(42);
		// Two persists: the docId/url write-back, then the cleaned orphan list.
		expect(storeSummary).toHaveBeenCalledTimes(2);
	});

	it("skips orphan cleanup by default (budget-bound inline pre-push path)", async () => {
		const summary = leaf({ orphanedDocIds: [42] });
		const { ctx, built } = await buildOne(summary);

		const outcome = await applyBatchResult(built, [okResult(summary)], ctx);

		expect(ctx.client.deleteDoc).not.toHaveBeenCalled();
		expect(outcome).toEqual({ writtenBack: 1, childSkipped: 0, cleanupPendingHashes: [summary.commitHash] });
	});

	it("keeps the write-back result when orphan cleanup itself fails", async () => {
		const summary = leaf({ orphanedDocIds: [42] });
		const ctx = baseCtx(fakeClient({ deleteDoc: async () => Promise.reject(new Error("network")) }));
		const built = await buildBatchItems(
			[summary],
			{ ownedPlans: new Map(), ownedNotes: new Map(), ownedReferences: new Map() },
			ctx,
		);

		const outcome = await applyBatchResult(built, [okResult(summary)], ctx, { cleanupOrphans: true });

		expect(outcome).toEqual({ writtenBack: 1, childSkipped: 0, cleanupPendingHashes: [summary.commitHash] });
	});

	it("resolves orphan hashes before cleanup on the compensation batch path", async () => {
		const summary = leaf({ unresolvedOrphanHashes: ["child1hash"] });
		const { ctx, built } = await buildOne(summary);
		vi.mocked(getSummary).mockResolvedValueOnce(leaf({ commitHash: "child1hash", jolliDocId: 201 }));

		const outcome = await applyBatchResult(built, [okResult(summary)], ctx, { cleanupOrphans: true });

		expect(ctx.client.deleteDoc).toHaveBeenCalledWith(201);
		expect(outcome).toEqual({ writtenBack: 1, childSkipped: 0 });
	});
});
