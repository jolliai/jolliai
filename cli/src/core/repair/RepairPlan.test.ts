import { beforeEach, describe, expect, it, vi } from "vitest";

// `remountStrandedTree` (used by the idempotency case below) goes through the
// real `withRequiredOrphanWriteLock`, whose acquisition touches real disk.
// Mocked exactly as `SummaryStore.remount.test.ts` does, so this file's bare
// "/repo" cwd never has to be a writable directory.
vi.mock("../Locks.js", () => ({
	acquireOrphanWriteLock: vi.fn(),
	releaseOrphanWriteLock: vi.fn(),
	OrphanWriteBusyError: class OrphanWriteBusyError extends Error {},
}));

import type { CommitSummary } from "../../Types.js";
import { acquireOrphanWriteLock, releaseOrphanWriteLock } from "../Locks.js";
import { remountStrandedTree } from "../SummaryStore.js";
import { buildRepairPlan } from "./RepairPlan.js";
import { findStrandedRoots } from "./StrandedTrees.js";

beforeEach(() => {
	vi.mocked(acquireOrphanWriteLock).mockResolvedValue(true);
	vi.mocked(releaseOrphanWriteLock).mockResolvedValue(undefined);
});

/** A StorageProvider backed by a Map, so a whole repair round trip stays in memory. */
function memoryStorage(seed: Record<string, unknown> = {}) {
	const files = new Map<string, string>();
	for (const [path, value] of Object.entries(seed)) files.set(path, JSON.stringify(value));
	return {
		files,
		provider: {
			kind: "memory",
			readFile: async (path: string) => files.get(path) ?? null,
			writeFiles: async (written: ReadonlyArray<{ path: string; content: string }>) => {
				for (const f of written) files.set(f.path, f.content);
			},
			listFiles: async () => [...files.keys()],
			exists: async () => true,
			ensure: async () => undefined,
		} as never,
	};
}

function summary(hash: string, over: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 5,
		commitHash: hash,
		commitMessage: `msg ${hash}`,
		commitAuthor: "T",
		commitDate: "2026-08-17T00:00:00.000Z",
		branch: "main",
		generatedAt: "2026-08-17T00:00:00.000Z",
		topics: [],
		recap: "",
		...over,
	} as CommitSummary;
}

function indexFields(hash: string) {
	return {
		commitMessage: `msg ${hash}`,
		commitDate: "2026-08-17T00:00:00.000Z",
		branch: "main",
		generatedAt: "2026-08-17T00:00:00.000Z",
		topicCount: 0,
	};
}

describe("buildRepairPlan", () => {
	it("plans a remount when the target already has a memory", async () => {
		const plan = await buildRepairPlan("/repo", undefined, {
			stranded: [{ oldHash: "old", root: { commitHash: "old" }, conversationCount: 26, skillCount: 7 }] as never,
			pair: async () => ({ kind: "paired", newHash: "new" }),
			targetHasMemory: async () => true,
			subjectOf: async () => "the target's subject",
		});
		expect(plan).toEqual([
			{
				kind: "remount",
				targetHash: "new",
				targetSubject: "the target's subject",
				source: expect.objectContaining({ oldHash: "old" }),
			},
		]);
	});

	it("plans a migrate when the target has no memory", async () => {
		const plan = await buildRepairPlan("/repo", undefined, {
			stranded: [{ oldHash: "old", root: { commitHash: "old" }, conversationCount: 0, skillCount: 0 }] as never,
			pair: async () => ({ kind: "paired", newHash: "new" }),
			targetHasMemory: async () => false,
		});
		expect(plan[0]).toMatchObject({ kind: "migrate", targetHash: "new", needsLlm: false });
	});

	it("marks a multi-source migrate as needing an LLM call", async () => {
		const plan = await buildRepairPlan("/repo", undefined, {
			stranded: [
				{ oldHash: "a", root: { commitHash: "a" }, conversationCount: 0, skillCount: 0 },
				{ oldHash: "b", root: { commitHash: "b" }, conversationCount: 0, skillCount: 0 },
			] as never,
			pair: async () => ({ kind: "paired", newHash: "new" }),
			targetHasMemory: async () => false,
		});
		expect(plan).toHaveLength(1);
		expect(plan[0]).toMatchObject({ kind: "migrate", needsLlm: true });
	});

	// The spec's idempotency requirement, exercised end to end against a real
	// write rather than asserted about an empty list: seed a stranded root,
	// remount it, and show the INDEX now gives it a parent, which is the
	// mechanism that makes detection stop matching it. Asserting that empty
	// input yields empty output — the shape this replaced — stays green even
	// if `remountStrandedTree` left the old root a root.
	it("is idempotent: a repaired root gains a parent in the index and is never planned again", async () => {
		const target = summary("new", { topics: [{ title: "own" }] } as unknown as Partial<CommitSummary>);
		const stranded = summary("old", { transcripts: ["t1"] } as unknown as Partial<CommitSummary>);
		const { files, provider } = memoryStorage({
			"index.json": {
				version: 3,
				entries: [
					{ commitHash: "new", parentCommitHash: null, ...indexFields("new") },
					{ commitHash: "old", parentCommitHash: null, ...indexFields("old") },
				],
			},
			"summaries/new.json": target,
			"summaries/old.json": stranded,
		});
		// "new" is the live commit; "old" is the hash the branch no longer has.
		const reachableCommits = async () => new Set(["new"]);

		const before = await findStrandedRoots("/repo", { storage: provider, reachableCommits });
		expect(before.map((t) => t.oldHash)).toEqual(["old"]);

		await remountStrandedTree(target, before[0]?.root as CommitSummary, "/repo", provider);

		const index = JSON.parse(files.get("index.json") as string) as {
			entries: Array<{ commitHash: string; parentCommitHash?: string | null }>;
		};
		expect(index.entries.find((e) => e.commitHash === "old")?.parentCommitHash).toBe("new");

		const after = await findStrandedRoots("/repo", { storage: provider, reachableCommits });
		expect(after).toEqual([]);
		expect(
			await buildRepairPlan("/repo", undefined, {
				stranded: after,
				pair: async () => ({ kind: "none" }),
				targetHasMemory: async () => true,
			}),
		).toEqual([]);
	});

	it("reports unsupported instead of dropping extras when several sources pair to a target that already has a memory", async () => {
		const plan = await buildRepairPlan("/repo", undefined, {
			stranded: [
				{ oldHash: "a", root: { commitHash: "a" }, conversationCount: 0, skillCount: 0 },
				{ oldHash: "b", root: { commitHash: "b" }, conversationCount: 0, skillCount: 0 },
			] as never,
			pair: async () => ({ kind: "paired", newHash: "new" }),
			targetHasMemory: async () => true,
		});
		expect(plan).toHaveLength(1);
		expect(plan[0]).toMatchObject({ kind: "unsupported", targetHash: "new" });
		const action = plan[0] as { sources: ReadonlyArray<{ oldHash: string }> };
		expect(action.sources.map((s) => s.oldHash)).toEqual(["a", "b"]);
	});

	it("reports an unpaired source instead of guessing", async () => {
		const plan = await buildRepairPlan("/repo", undefined, {
			stranded: [{ oldHash: "a", root: { commitHash: "a" }, conversationCount: 0, skillCount: 0 }] as never,
			pair: async () => ({ kind: "conflict", candidates: ["x", "y"] }),
			targetHasMemory: async () => false,
		});
		expect(plan[0]).toMatchObject({ kind: "unpaired", reason: "conflict" });
	});

	describe("--from/--to override", () => {
		const source = [
			{ oldHash: "abc123deadbeef", root: { commitHash: "abc123deadbeef" }, conversationCount: 3, skillCount: 1 },
		] as never;

		it("resolves an abbreviated --to to its full sha before deciding the action", async () => {
			// The failure this pins: with the abbreviation, the has-memory probe
			// misses, the plan says `migrate`, migrateOneToOne's idempotency
			// guard sees the FULL hash already in the index and returns
			// silently, and the command prints a success that wrote nothing.
			const targetHasMemory = vi.fn(async (hash: string) => hash === "f".repeat(40));
			const plan = await buildRepairPlan(
				"/repo",
				{ from: "abc123", to: "ffffffff" },
				{
					stranded: source,
					targetHasMemory,
					resolveTarget: async () => "f".repeat(40),
					isReachable: async () => true,
					subjectOf: async () => null,
				},
			);
			expect(targetHasMemory).toHaveBeenCalledWith("f".repeat(40), "/repo");
			expect(plan).toEqual([
				{
					kind: "remount",
					targetHash: "f".repeat(40),
					targetSubject: null,
					source: expect.objectContaining({ oldHash: "abc123deadbeef" }),
				},
			]);
		});

		it("refuses a --to git cannot resolve rather than guessing a target", async () => {
			await expect(
				buildRepairPlan(
					"/repo",
					{ from: "abc123", to: "nope" },
					{ stranded: source, resolveTarget: async () => null, isReachable: async () => true },
				),
			).rejects.toThrow(/does not resolve to a commit/);
		});

		it("refuses a --to that is itself unreachable, which would strand the tree again", async () => {
			await expect(
				buildRepairPlan(
					"/repo",
					{ from: "abc123", to: "deadbee" },
					{
						stranded: source,
						resolveTarget: async () => "d".repeat(40),
						isReachable: async () => false,
					},
				),
			).rejects.toThrow(/not reachable from any ref/);
		});

		it("refuses a --from that matches no stranded tree", async () => {
			await expect(
				buildRepairPlan(
					"/repo",
					{ from: "zzzz", to: "ffffffff" },
					{ stranded: source, resolveTarget: async () => "f".repeat(40), isReachable: async () => true },
				),
			).rejects.toThrow(/no stranded memory tree found for zzzz/);
		});

		it("refuses an ambiguous --from prefix rather than silently repairing the first match", async () => {
			// The tool prints 8-char hashes and invites abbreviation. A prefix that
			// matches two stranded roots must refuse — the same guard `--to` gets via
			// rev-parse --verify — not repair whichever happens to be first.
			const twoRoots = [
				{
					oldHash: "abcd1111deadbeef",
					root: { commitHash: "abcd1111deadbeef" },
					conversationCount: 1,
					skillCount: 0,
				},
				{
					oldHash: "abcd2222deadbeef",
					root: { commitHash: "abcd2222deadbeef" },
					conversationCount: 1,
					skillCount: 0,
				},
			] as never;
			await expect(
				buildRepairPlan(
					"/repo",
					{ from: "abcd", to: "ffffffff" },
					{ stranded: twoRoots, resolveTarget: async () => "f".repeat(40), isReachable: async () => true },
				),
			).rejects.toThrow(/ambiguous/i);
		});

		it("plans a migrate when the resolved target has no memory of its own", async () => {
			const plan = await buildRepairPlan(
				"/repo",
				{ from: "abc123", to: "ffffffff" },
				{
					stranded: source,
					targetHasMemory: async () => false,
					resolveTarget: async () => "f".repeat(40),
					isReachable: async () => true,
				},
			);
			expect(plan[0]).toMatchObject({ kind: "migrate", targetHash: "f".repeat(40), needsLlm: false });
		});
	});
});
