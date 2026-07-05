import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary, NoteReference, PlanReference } from "../Types.js";

vi.mock("./GitOps.js", () => ({ getDefaultBranch: vi.fn() }));
vi.mock("./PrDescription.js", () => ({ loadBranchSummaries: vi.fn() }));
vi.mock("./SummaryStore.js", () => ({
	getActiveStorage: vi.fn(),
	readNoteFromBranch: vi.fn(),
	readPlanFromBranch: vi.fn(),
	storeSummary: vi.fn(),
}));
vi.mock("./GitRemoteUtils.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./GitRemoteUtils.js")>();
	return { ...actual, getCanonicalRepoUrl: vi.fn() };
});

import { getDefaultBranch } from "./GitOps.js";
import { buildBranchRelativePath, getCanonicalRepoUrl } from "./GitRemoteUtils.js";
import {
	BindingAlreadyExistsError,
	BindingRequiredError,
	ClientOutdatedError,
	type JolliMemoryPushClient,
	NotAuthenticatedError,
	type PushPayload,
	type PushResult,
} from "./JolliMemoryPushClient.js";
import {
	applyNoteUrls,
	applyPlanUrls,
	assignOwnedAttachments,
	buildPushMarkdown,
	latestPlanPerName,
	type PushContext,
	pushBranchToJolli,
	pushSummary,
	resolveSpaceId,
	serializeSummaryJson,
} from "./JolliMemoryPushOrchestrator.js";
import { loadBranchSummaries } from "./PrDescription.js";
import { buildPushTitle } from "./SummaryFormat.js";
import { getActiveStorage, readNoteFromBranch, readPlanFromBranch, storeSummary } from "./SummaryStore.js";

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
		const s = { commitHash: "a", jolliDocId: 5, jolliDocUrl: "u", orphanedDocIds: [1] } as unknown as CommitSummary;
		const json = JSON.parse(serializeSummaryJson(s) ?? "{}");
		expect(json.jolliDocId).toBeUndefined();
		expect(json.jolliDocUrl).toBeUndefined();
		expect(json.orphanedDocIds).toBeUndefined();
		expect(json.commitHash).toBe("a");
	});

	it("returns undefined when serialized JSON exceeds the byte cap", () => {
		const huge = "x".repeat(2_000_000);
		const s = { commitHash: "a", commitMessage: huge } as unknown as CommitSummary;
		expect(serializeSummaryJson(s)).toBeUndefined();
	});
});

// ─── applyPlanUrls / applyNoteUrls ──────────────────────────────────────────

describe("applyPlanUrls", () => {
	it("merges docId/url by slug", () => {
		const plans = [plan({ slug: "p1" })];
		const out = applyPlanUrls(plans, [{ slug: "p1", url: "https://j/articles?doc=9", docId: 9 }]);
		expect(out?.[0].jolliPlanDocId).toBe(9);
		expect(out?.[0].jolliPlanDocUrl).toBe("https://j/articles?doc=9");
	});

	it("leaves plans unmatched by slug untouched", () => {
		const plans = [plan({ slug: "p1" })];
		const out = applyPlanUrls(plans, [{ slug: "other", url: "u", docId: 1 }]);
		expect(out?.[0].jolliPlanDocId).toBeUndefined();
	});

	it("returns the input unchanged when plans is undefined or planUrls is empty", () => {
		expect(applyPlanUrls(undefined, [{ slug: "p1", url: "u", docId: 1 }])).toBeUndefined();
		const plans = [plan({ slug: "p1" })];
		expect(applyPlanUrls(plans, [])).toBe(plans);
	});
});

describe("applyNoteUrls", () => {
	it("merges docId/url by id", () => {
		const notes = [note({ id: "n1" })];
		const out = applyNoteUrls(notes, [{ id: "n1", url: "https://j/articles?doc=3", docId: 3 }]);
		expect(out[0].jolliNoteDocId).toBe(3);
		expect(out[0].jolliNoteDocUrl).toBe("https://j/articles?doc=3");
	});

	it("leaves notes unmatched by id untouched", () => {
		const notes = [note({ id: "n1" })];
		const out = applyNoteUrls(notes, [{ id: "other", url: "u", docId: 1 }]);
		expect(out[0].jolliNoteDocId).toBeUndefined();
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

function fakePushResult(overrides: Partial<PushResult> = {}): PushResult {
	return { url: "unused", docId: 42, jrn: "jrn:1", created: true, ...overrides };
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
	}> = {},
): JolliMemoryPushClient {
	return {
		push: vi.fn(overrides.push ?? (async () => fakePushResult())),
		listSpaces: vi.fn(overrides.listSpaces ?? (async () => ({ spaces: [], defaultSpaceId: null }))),
		createBinding: vi.fn(overrides.createBinding ?? (async () => ({ bindingId: 1, jmSpaceId: 1, repoName: "r" }))),
		deleteDoc: vi.fn(overrides.deleteDoc ?? (async () => undefined)),
		resolveBaseUrl: vi.fn(overrides.resolveBaseUrl ?? (async () => BASE)),
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
