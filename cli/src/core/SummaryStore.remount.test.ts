import { beforeEach, describe, expect, it, vi } from "vitest";

// `remountStrandedTree` goes through the real `withRequiredOrphanWriteLock`,
// whose lock acquisition touches real disk (see `Locks.ts`'s `ensureSharedLockDir`).
// Mocked here the same way the sibling `SummaryStore.test.ts` mocks it, so this
// file's `cwd` values (a bare, non-existent "/repo") don't have to resolve to a
// writable directory for the lock itself — `remountStrandedTree`'s own logic is
// what's under test, not `Locks.ts`.
vi.mock("./Locks.js", () => ({
	acquireOrphanWriteLock: vi.fn(),
	releaseOrphanWriteLock: vi.fn(),
	OrphanWriteBusyError: class OrphanWriteBusyError extends Error {
		constructor(label: string, timeoutMs: number) {
			super(`${label}: could not acquire orphan-write.lock within ${timeoutMs}ms`);
			this.name = "OrphanWriteBusyError";
		}
	},
}));

import type { CommitSummary } from "../Types.js";
import { acquireOrphanWriteLock, releaseOrphanWriteLock } from "./Locks.js";
import { copyHoistFields, remountStrandedTree } from "./SummaryStore.js";

beforeEach(() => {
	vi.mocked(acquireOrphanWriteLock).mockResolvedValue(true);
	vi.mocked(releaseOrphanWriteLock).mockResolvedValue(undefined);
});

function summary(over: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 5,
		commitHash: "old",
		commitMessage: "m",
		commitAuthor: "T",
		commitDate: "2026-08-17T00:00:00.000Z",
		branch: "main",
		generatedAt: "2026-08-17T00:00:00.000Z",
		topics: [],
		recap: "",
		...over,
	} as CommitSummary;
}

describe("copyHoistFields", () => {
	it("copies every field migrateOneToOne hoists onto a new root", () => {
		const old = summary({
			skills: [{ archivedKey: "k" }],
			jolliSkillsDocId: 11113,
			jolliSkillsDocUrl: "https://example.test/skills",
			transcripts: ["t1", "t2"],
			plans: [{ slug: "p" }],
			notes: [{ slug: "n" }],
			references: [{ key: "r" }],
		} as unknown as Partial<CommitSummary>);

		expect(copyHoistFields(old)).toEqual({
			skills: [{ archivedKey: "k" }],
			jolliSkillsDocId: 11113,
			jolliSkillsDocUrl: "https://example.test/skills",
			transcripts: ["t1", "t2"],
			plans: [{ slug: "p" }],
			notes: [{ slug: "n" }],
			references: [{ key: "r" }],
		});
	});

	it("omits absent fields rather than writing undefined", () => {
		expect(copyHoistFields(summary())).toEqual({});
	});
});

describe("remountStrandedTree", () => {
	it("keeps the target's own topics and recap while attaching the stranded tree", async () => {
		const stored: CommitSummary[] = [];
		const storage = {
			readFile: async () => null,
			writeFiles: async (files: ReadonlyArray<{ path: string; content: string }>) => {
				for (const f of files) if (f.path.startsWith("summaries/")) stored.push(JSON.parse(f.content));
			},
			listFiles: async () => [],
			exists: async () => true,
			ensure: async () => undefined,
		} as never;

		const target = summary({
			commitHash: "new",
			topics: [{ title: "fresh" }],
			recap: "fresh recap",
		} as unknown as Partial<CommitSummary>);
		const stranded = summary({
			commitHash: "old",
			skills: [{ archivedKey: "k" }],
			transcripts: ["t1"],
		} as unknown as Partial<CommitSummary>);

		await remountStrandedTree(target, stranded, "/repo", storage);

		// Structural guard against the double-acquisition this task exists to
		// prevent: with `acquireOrphanWriteLock` mocked as an unconditional
		// no-op, nothing else here would fail if `remountStrandedTree` called
		// the public `storeSummary` (which acquires again) instead of the
		// lock-free `storeSummaryLocked`. Pinning the call count is what makes
		// that regression visible.
		expect(acquireOrphanWriteLock).toHaveBeenCalledTimes(1);

		const written = stored.find((s) => s.commitHash === "new");
		expect(written?.topics).toEqual([{ title: "fresh" }]);
		expect(written?.recap).toBe("fresh recap");
		expect(written?.children?.[0]?.commitHash).toBe("old");
		expect(written?.skills).toEqual([{ archivedKey: "k" }]);
		expect(written?.transcripts).toEqual(["t1"]);
	});

	it("unions the target's OWN hoisted arrays with the stranded root's instead of overwriting them", async () => {
		const stored: CommitSummary[] = [];
		const storage = {
			readFile: async () => null,
			writeFiles: async (files: ReadonlyArray<{ path: string; content: string }>) => {
				for (const f of files) if (f.path.startsWith("summaries/")) stored.push(JSON.parse(f.content));
			},
			listFiles: async () => [],
			exists: async () => true,
			ensure: async () => undefined,
		} as never;

		// The shape the feature exists for: commit A amended to B, B's own hook
		// already generated a normal memory carrying B's session. A copy-not-union
		// merge drops every one of these from the tree entirely -- `children` is
		// `[strandedRoot]` alone, so the target's own IDs survive nowhere.
		const target = summary({
			commitHash: "new",
			topics: [{ title: "fresh" }],
			transcripts: ["t-target"],
			skills: [{ archivedKey: "target-key", source: "claude", skill: "target-skill" }],
			plans: [{ slug: "plan-target-11111111" }],
			notes: [{ id: "note-target-11111111" }],
			references: [{ archivedKey: "ref-target-11111111" }],
		} as unknown as Partial<CommitSummary>);
		const stranded = summary({
			commitHash: "old",
			transcripts: ["t-stranded"],
			skills: [{ archivedKey: "stranded-key", source: "claude", skill: "stranded-skill" }],
			plans: [{ slug: "plan-stranded-22222222" }],
			notes: [{ id: "note-stranded-22222222" }],
			references: [{ archivedKey: "ref-stranded-22222222" }],
		} as unknown as Partial<CommitSummary>);

		await remountStrandedTree(target, stranded, "/repo", storage);

		const written = stored.find((s) => s.commitHash === "new");
		expect(written?.transcripts?.slice().sort()).toEqual(["t-stranded", "t-target"]);
		expect(written?.skills?.map((s) => s.archivedKey).sort()).toEqual(["stranded-key", "target-key"]);
		expect(written?.plans?.map((p) => p.slug).sort()).toEqual(["plan-stranded-22222222", "plan-target-11111111"]);
		expect(written?.notes?.map((n) => n.id).sort()).toEqual(["note-stranded-22222222", "note-target-11111111"]);
		expect(written?.references?.map((r) => r.archivedKey).sort()).toEqual([
			"ref-stranded-22222222",
			"ref-target-11111111",
		]);
	});

	it("keeps the newest skill-usage article and orphans the loser rather than stranding it", async () => {
		const stored: CommitSummary[] = [];
		const storage = {
			readFile: async () => null,
			writeFiles: async (files: ReadonlyArray<{ path: string; content: string }>) => {
				for (const f of files) if (f.path.startsWith("summaries/")) stored.push(JSON.parse(f.content));
			},
			listFiles: async () => [],
			exists: async () => true,
			ensure: async () => undefined,
		} as never;

		const target = summary({
			commitHash: "new",
			commitDate: "2026-08-17T02:00:00.000Z",
			generatedAt: "2026-08-17T02:00:00.000Z",
			jolliSkillsDocId: 900,
			jolliSkillsDocUrl: "https://example.test/skills/900",
		} as unknown as Partial<CommitSummary>);
		const stranded = summary({
			commitHash: "old",
			commitDate: "2026-08-17T01:00:00.000Z",
			generatedAt: "2026-08-17T01:00:00.000Z",
			jolliSkillsDocId: 800,
			jolliSkillsDocUrl: "https://example.test/skills/800",
		} as unknown as Partial<CommitSummary>);

		await remountStrandedTree(target, stranded, "/repo", storage);

		const written = stored.find((s) => s.commitHash === "new");
		// The target is the newer memory, so its article is the one updated in
		// place; the stranded root's id must be banked for cleanup, never dropped.
		expect(written?.jolliSkillsDocId).toBe(900);
		expect(written?.jolliSkillsDocUrl).toBe("https://example.test/skills/900");
		expect(written?.orphanedDocIds).toEqual([800]);
	});

	it("hoists the stranded root's own orphanedDocIds and unresolvedOrphanHashes onto the merged root", async () => {
		// A stranded root that was itself a squash carries pending-cleanup ids
		// (Space articles awaiting deletion). Push reads orphanedDocIds at the ROOT
		// only, and the v5 normalize step that would drain descendants is a no-op —
		// so ids left on the stranded child leak forever. remount must hoist them.
		const stored: CommitSummary[] = [];
		const storage = {
			readFile: async () => null,
			writeFiles: async (files: ReadonlyArray<{ path: string; content: string }>) => {
				for (const f of files) if (f.path.startsWith("summaries/")) stored.push(JSON.parse(f.content));
			},
			listFiles: async () => [],
			exists: async () => true,
			ensure: async () => undefined,
		} as never;

		const target = summary({ commitHash: "new", orphanedDocIds: [900] } as unknown as Partial<CommitSummary>);
		const stranded = summary({
			commitHash: "old",
			orphanedDocIds: [700],
			unresolvedOrphanHashes: ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"],
			// A descendant of the stranded tree with its own pending cleanup id.
			children: [summary({ commitHash: "olderchild", orphanedDocIds: [701] } as Partial<CommitSummary>)],
		} as unknown as Partial<CommitSummary>);

		await remountStrandedTree(target, stranded, "/repo", storage);

		const written = stored.find((s) => s.commitHash === "new");
		expect([...(written?.orphanedDocIds ?? [])].sort((a, b) => a - b)).toEqual([700, 701, 900]);
		expect(written?.unresolvedOrphanHashes).toEqual(["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]);
	});

	it("refuses when the target already has children", async () => {
		const target = summary({
			commitHash: "new",
			children: [summary({ commitHash: "existing" })],
		} as Partial<CommitSummary>);
		await expect(remountStrandedTree(target, summary(), "/repo", {} as never)).rejects.toThrow(
			/already has children/,
		);
	});
});
