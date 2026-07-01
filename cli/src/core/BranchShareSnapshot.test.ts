import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary, TopicSummary } from "../Types.js";

// Source the branch's summaries from the shared reader (loadBranchSummaries) and
// the default-branch resolver — both git-backed, so mock them here. Plan/note
// bodies are read from storage; mock those too. resolveEffectiveTopics + buildMarkdown
// stay real (pure, operate on the summary objects we construct).
const h = vi.hoisted(() => ({
	loadBranchSummaries: vi.fn(),
	getDefaultBranch: vi.fn(),
	readPlanFromBranch: vi.fn(),
	readNoteFromBranch: vi.fn(),
}));

vi.mock("./PrDescription.js", () => ({ loadBranchSummaries: h.loadBranchSummaries }));
vi.mock("./GitOps.js", async (orig) => ({
	...(await orig<typeof import("./GitOps.js")>()),
	getDefaultBranch: h.getDefaultBranch,
}));
vi.mock("./SummaryStore.js", async (orig) => ({
	...(await orig<typeof import("./SummaryStore.js")>()),
	readPlanFromBranch: h.readPlanFromBranch,
	readNoteFromBranch: h.readNoteFromBranch,
}));

import { assembleBranchShareSnapshot, resolveShareHead } from "./BranchShareSnapshot.js";

const HASH = { c1: "a".repeat(40), c2: "b".repeat(40), c3: "c".repeat(40) };

function topic(title: string): TopicSummary {
	return { title, trigger: `why ${title}`, response: `did ${title}`, decisions: `chose ${title}` };
}

function makeSummary(over: Partial<CommitSummary> & Pick<CommitSummary, "commitHash">): CommitSummary {
	return {
		version: 4,
		commitMessage: `msg-${over.commitHash.slice(0, 4)}`,
		commitAuthor: "Dev",
		commitDate: "2026-01-01T00:00:00.000Z",
		branch: "feature/x",
		generatedAt: "2026-01-01T00:00:00.000Z",
		topics: [topic("t1")],
		...over,
	};
}

/** Drives the shared reader to return `summaries` (chronological, oldest-first). */
function withSummaries(summaries: CommitSummary[]): void {
	h.loadBranchSummaries.mockResolvedValue({ summaries, missingCount: 0 });
}

beforeEach(() => {
	for (const fn of Object.values(h)) fn.mockReset();
	h.getDefaultBranch.mockResolvedValue("main");
	h.loadBranchSummaries.mockResolvedValue({ summaries: [], missingCount: 0 });
	h.readPlanFromBranch.mockResolvedValue(null);
	h.readNoteFromBranch.mockResolvedValue(null);
});

describe("assembleBranchShareSnapshot", () => {
	it("returns null when the branch has no generated summaries", async () => {
		expect(await assembleBranchShareSnapshot("feature/x", "/repo")).toBeNull();
	});

	it("sources from loadBranchSummaries(base..HEAD) — chronological content, count, head", async () => {
		withSummaries([
			makeSummary({ commitHash: HASH.c1, topics: [topic("a"), topic("b")] }),
			makeSummary({ commitHash: HASH.c2, topics: [topic("c")] }),
		]);
		const snap = await assembleBranchShareSnapshot("feature/x", "/repo");
		expect(h.getDefaultBranch).toHaveBeenCalledWith("/repo");
		expect(h.loadBranchSummaries).toHaveBeenCalledWith("/repo", "main");
		expect(snap).not.toBeNull();
		if (!snap) return;
		expect(snap.branch).toBe("feature/x");
		expect(snap.commitHashes).toEqual([HASH.c1, HASH.c2]);
		expect(snap.headCommitHash).toBe(HASH.c2); // newest included (last chronological)
		expect(snap.decisionCount).toBe(3);
		expect(snap.titles).toEqual(["a", "b", "c"]);
		expect(snap.content.indexOf("msg-aaaa")).toBeLessThan(snap.content.indexOf("msg-bbbb"));
	});

	it("embeds plan content as an expandable section, gated by includePlans", async () => {
		withSummaries([
			makeSummary({
				commitHash: HASH.c1,
				plans: [
					{
						slug: "p1",
						title: "My Plan",
						addedAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
		]);
		h.readPlanFromBranch.mockResolvedValue("# My Plan\n\nThe full plan body.");

		const def = await assembleBranchShareSnapshot("feature/x", "/repo");
		expect(def?.content).toContain("## Plans & Notes");
		expect(def?.content).toContain("<details>");
		expect(def?.content).toContain("Plan — My Plan");
		expect(def?.content).toContain("The full plan body.");

		const noPlans = await assembleBranchShareSnapshot("feature/x", "/repo", { includePlans: false });
		expect(noPlans?.content).not.toContain("My Plan");
		expect(noPlans?.content).not.toContain("Plans & Notes");
	});

	it("embeds note content (file or snippet fallback), gated by includeNotes", async () => {
		withSummaries([
			makeSummary({
				commitHash: HASH.c1,
				notes: [
					{
						id: "n1",
						title: "Doc Note",
						format: "markdown",
						addedAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
					{
						id: "n2",
						title: "Snippet Note",
						format: "snippet",
						content: "inline snippet body",
						addedAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
		]);
		h.readNoteFromBranch.mockImplementation(async (id: string) => (id === "n1" ? "markdown note body" : null));

		const def = await assembleBranchShareSnapshot("feature/x", "/repo");
		expect(def?.content).toContain("Note — Doc Note");
		expect(def?.content).toContain("markdown note body");
		expect(def?.content).toContain("Note — Snippet Note");
		expect(def?.content).toContain("inline snippet body"); // file missing → snippet fallback

		const noNotes = await assembleBranchShareSnapshot("feature/x", "/repo", { includeNotes: false });
		expect(noNotes?.content).not.toContain("Doc Note");
	});

	it("HTML-escapes plan/note titles in the <summary> tag", async () => {
		withSummaries([
			makeSummary({
				commitHash: HASH.c1,
				plans: [
					{
						slug: "p1",
						title: "</summary><script>alert(1)</script>",
						addedAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
		]);
		const snap = await assembleBranchShareSnapshot("feature/x", "/repo");
		expect(snap?.content).toContain("&lt;/summary&gt;&lt;script&gt;");
		expect(snap?.content).not.toContain("<summary></summary><script>");
	});

	it("shows a placeholder when a plan body cannot be read", async () => {
		withSummaries([
			makeSummary({
				commitHash: HASH.c1,
				plans: [
					{
						slug: "missing",
						title: "Ghost Plan",
						addedAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
		]);
		const snap = await assembleBranchShareSnapshot("feature/x", "/repo");
		expect(snap?.content).toContain("Plan — Ghost Plan");
		expect(snap?.content).toContain("(no content captured)");
	});

	it("dedupes same-named plans to a single block, keeping the latest updatedAt's body", async () => {
		// Same title, different slugs (e.g. plan recreated) — share only the latest.
		withSummaries([
			makeSummary({
				commitHash: HASH.c1,
				plans: [
					{
						slug: "old-slug",
						title: "Refactor plan",
						addedAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
			makeSummary({
				commitHash: HASH.c2,
				plans: [
					{
						slug: "new-slug",
						title: "Refactor plan",
						addedAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-02T00:00:00.000Z",
					},
				],
			}),
		]);
		h.readPlanFromBranch.mockImplementation(async (slug: string) =>
			slug === "new-slug" ? "newest body" : "stale body",
		);
		const snap = await assembleBranchShareSnapshot("feature/x", "/repo");
		// One block (title appears once), body read from the latest-updated slug.
		expect(snap?.content.match(/Plan — Refactor plan/g)?.length).toBe(1);
		expect(snap?.content).toContain("newest body");
		expect(snap?.content).not.toContain("stale body");
	});

	it("keeps the newer same-named plan when a later commit carries an older updatedAt", async () => {
		withSummaries([
			makeSummary({
				commitHash: HASH.c1,
				plans: [
					{
						slug: "new-slug",
						title: "Refactor plan",
						addedAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-02-01T00:00:00.000Z",
					},
				],
			}),
			makeSummary({
				commitHash: HASH.c2,
				plans: [
					{
						slug: "old-slug",
						title: "Refactor plan",
						addedAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
		]);
		h.readPlanFromBranch.mockImplementation(async (slug: string) =>
			slug === "new-slug" ? "newest body" : "stale body",
		);
		const snap = await assembleBranchShareSnapshot("feature/x", "/repo");
		expect(snap?.content.match(/Plan — Refactor plan/g)?.length).toBe(1);
		expect(snap?.content).toContain("newest body");
		expect(snap?.content).not.toContain("stale body");
	});

	it("dedupes same-named notes to a single block (case/space-insensitive)", async () => {
		withSummaries([
			makeSummary({
				commitHash: HASH.c1,
				notes: [
					{
						id: "n1",
						title: "Design Note",
						format: "snippet",
						content: "stale note body",
						addedAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
			makeSummary({
				commitHash: HASH.c2,
				notes: [
					{
						id: "n2",
						title: "  design note  ",
						format: "snippet",
						content: "newest note body",
						addedAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-02T00:00:00.000Z",
					},
				],
			}),
		]);
		const snap = await assembleBranchShareSnapshot("feature/x", "/repo");
		expect(snap?.content).toContain("newest note body");
		expect(snap?.content).not.toContain("stale note body");
	});

	it("does not choke when includePlans is false and a summary has no plans", async () => {
		withSummaries([makeSummary({ commitHash: HASH.c1 })]);
		const snap = await assembleBranchShareSnapshot("feature/x", "/repo", { includePlans: false });
		expect(snap?.commitHashes).toEqual([HASH.c1]);
	});

	it("commit share: restricts to the one commit drawn from the branch set", async () => {
		withSummaries([
			makeSummary({ commitHash: HASH.c1, topics: [topic("a"), topic("b")] }),
			makeSummary({ commitHash: HASH.c2, topics: [topic("c")] }),
		]);
		const snap = await assembleBranchShareSnapshot("feature/x", "/repo", { commitHash: HASH.c2 });
		expect(snap?.commitHashes).toEqual([HASH.c2]);
		expect(snap?.headCommitHash).toBe(HASH.c2);
		expect(snap?.decisionCount).toBe(1); // only c2's topic
		expect(snap?.content).toContain("msg-bbbb");
		expect(snap?.content).not.toContain("msg-aaaa");
	});

	it("commit share: null when the commit is not on the branch", async () => {
		withSummaries([makeSummary({ commitHash: HASH.c1 })]);
		expect(await assembleBranchShareSnapshot("feature/x", "/repo", { commitHash: HASH.c3 })).toBeNull();
	});
});

describe("resolveShareHead", () => {
	it("returns the newest included summary's hash (same source as assemble)", async () => {
		withSummaries([makeSummary({ commitHash: HASH.c1 }), makeSummary({ commitHash: HASH.c2 })]);
		expect(await resolveShareHead("feature/x", "/repo")).toBe(HASH.c2);
	});

	it("returns undefined when the branch has no summaries", async () => {
		expect(await resolveShareHead("feature/x", "/repo")).toBeUndefined();
	});

	it("tolerates an undefined cwd", async () => {
		withSummaries([makeSummary({ commitHash: HASH.c1 })]);
		expect(await resolveShareHead("feature/x")).toBe(HASH.c1);
		expect(h.loadBranchSummaries).toHaveBeenCalledWith("", "main");
	});

	it("commit share: returns that commit's hash (frozen, never stale)", async () => {
		withSummaries([makeSummary({ commitHash: HASH.c1 }), makeSummary({ commitHash: HASH.c2 })]);
		expect(await resolveShareHead("feature/x", "/repo", HASH.c2)).toBe(HASH.c2);
	});
});
