import { describe, expect, it, vi } from "vitest";
import type { SummaryIndexEntry } from "../Types.js";
import { cleanupAllBranchesStaleChildMarkdown, cleanupBranchStaleChildMarkdown } from "./StaleChildMarkdownCleanup.js";
import type { StorageProvider } from "./StorageProvider.js";

vi.mock("./SummaryStore.js", async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, getIndexEntryMap: vi.fn() };
});

const { getIndexEntryMap } = await import("./SummaryStore.js");

function e(commitHash: string, branch: string, parent: string | null): SummaryIndexEntry {
	return {
		commitHash,
		parentCommitHash: parent,
		commitMessage: `msg-${commitHash}`,
		commitDate: "2026-05-12T00:00:00Z",
		branch,
		generatedAt: "2026-05-12T00:00:00Z",
	};
}

interface RecordingStorage extends StorageProvider {
	readonly deletions: SummaryIndexEntry[];
	readonly pruneCalls: string[][];
}

function makeStorage(opts: { withPrune?: boolean; pruneThrows?: boolean } = {}): RecordingStorage {
	const deletions: SummaryIndexEntry[] = [];
	const pruneCalls: string[][] = [];
	const base: RecordingStorage = {
		readFile: vi.fn(),
		writeFiles: vi.fn(),
		listFiles: vi.fn(),
		exists: vi.fn(),
		ensure: vi.fn(),
		deleteVisibleMarkdown: async (entry) => {
			deletions.push(entry);
		},
		deletions,
		pruneCalls,
	};
	if (opts.withPrune !== false) {
		base.pruneBranchMappings = async (branches) => {
			pruneCalls.push([...branches]);
			if (opts.pruneThrows) throw new Error("prune-fail");
			return branches.length;
		};
	}
	return base;
}

describe("StaleChildMarkdownCleanup", () => {
	describe("cleanupBranchStaleChildMarkdown", () => {
		it("deletes entries with parent!=null on the named branch (keeps the head)", async () => {
			// v4 Hoist chain: a (head, parent=null), b (hoisted child of a), c
			// (hoisted child of b — an older squashed version's older version).
			// New semantics: keep 'a' (head), delete 'b' and 'c' (stale children).
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "main", null)],
					["b", e("b", "main", "a")],
					["c", e("c", "main", "b")],
				]),
			);
			const storage = makeStorage();
			const result = await cleanupBranchStaleChildMarkdown("/cwd", "main", storage);
			expect(result.deleted).toBe(2);
			expect(storage.deletions.map((d) => d.commitHash).sort()).toEqual(["b", "c"]);
		});

		it("does not touch entries on other branches", async () => {
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "main", null)],
					["b", e("b", "main", "a")],
					["x", e("x", "feature", null)],
					["y", e("y", "feature", "x")],
				]),
			);
			const storage = makeStorage();
			await cleanupBranchStaleChildMarkdown("/cwd", "main", storage);
			// Only main's stale child (b) deleted; feature's stale child (y) untouched.
			expect(storage.deletions.map((d) => d.commitHash)).toEqual(["b"]);
		});

		it("keeps multiple heads on the same branch (independent commits)", async () => {
			// Two independent commits on one branch, each a Hoist root with no children:
			// nothing to clean up.
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "main", null)],
					["x", e("x", "main", null)],
				]),
			);
			const storage = makeStorage();
			const result = await cleanupBranchStaleChildMarkdown("/cwd", "main", storage);
			expect(result.deleted).toBe(0);
			expect(storage.deletions).toEqual([]);
		});

		it("keeps a series of plain commits on the active branch across many branches in the index", async () => {
			// Customer-shaped fixture: the index carries plain-commit heads from
			// several historical branches plus the active branch. The cleanup
			// pass is scoped to one branch, so heads on the OTHER branches must
			// never be touched even when they share the same parent=null shape.
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a1", e("a1", "feat-2747", null)],
					["a2", e("a2", "feat-2747", null)],
					["a3", e("a3", "feat-2747", null)],
					["a4", e("a4", "feat-2747", null)],
					["a5", e("a5", "feat-2747", null)],
					["b1", e("b1", "feat-2841", null)],
					["b2", e("b2", "feat-2841", null)],
					["c1", e("c1", "feat-2719", null)],
				]),
			);
			const storage = makeStorage();
			const result = await cleanupBranchStaleChildMarkdown("/cwd", "feat-2747", storage);
			expect(result.deleted).toBe(0);
			expect(result.failed).toBe(0);
			expect(storage.deletions).toEqual([]);
		});

		it("is a no-op when storage lacks deleteVisibleMarkdown", async () => {
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "main", null)],
					["b", e("b", "main", "a")],
				]),
			);
			const storage = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn(),
				ensure: vi.fn(),
			} satisfies StorageProvider;
			const result = await cleanupBranchStaleChildMarkdown("/cwd", "main", storage);
			expect(result.deleted).toBe(0);
		});
	});

	describe("cleanupAllBranchesStaleChildMarkdown", () => {
		it("walks every branch and deletes parent!=null entries (keeps every head)", async () => {
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "main", null)],
					["b", e("b", "main", "a")],
					["x", e("x", "feature", null)],
					["y", e("y", "feature", "x")],
				]),
			);
			const storage = makeStorage();
			const result = await cleanupAllBranchesStaleChildMarkdown("/cwd", storage);
			expect(result.deleted).toBe(2);
			expect(storage.deletions.map((d) => d.commitHash).sort()).toEqual(["b", "y"]);
		});

		it("is a no-op when storage lacks deleteVisibleMarkdown", async () => {
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "main", null)],
					["b", e("b", "main", "a")],
				]),
			);
			const storage = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn(),
				ensure: vi.fn(),
			} satisfies StorageProvider;
			const result = await cleanupAllBranchesStaleChildMarkdown("/cwd", storage);
			expect(result.deleted).toBe(0);
		});
	});

	describe("ghost-branch mapping pruning", () => {
		it("cleanupBranchStaleChildMarkdown prunes the branch when it has only hoisted children (cross-branch hoist)", async () => {
			// Cross-branch hoist: head landed on 'bug/main' as 'a'; 'b' is a
			// hoisted child whose .branch field retains its origin name
			// 'feature/ghost'. After cleanup deletes b.md, 'feature/ghost' is
			// left in the index with zero heads → prune.
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "bug/main", null)],
					["b", e("b", "feature/ghost", "a")],
				]),
			);
			const storage = makeStorage();
			await cleanupBranchStaleChildMarkdown("/cwd", "feature/ghost", storage);
			expect(storage.pruneCalls).toEqual([["feature/ghost"]]);
		});

		it("cleanupBranchStaleChildMarkdown does NOT prune when the branch still has a head", async () => {
			// Same-branch amend: 'a' is the new head on 'main', 'b' is the
			// hoisted prior version, also on 'main'. After cleanup 'main' still
			// has a head → no prune.
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "main", null)],
					["b", e("b", "main", "a")],
				]),
			);
			const storage = makeStorage();
			await cleanupBranchStaleChildMarkdown("/cwd", "main", storage);
			expect(storage.pruneCalls).toEqual([]);
		});

		it("cleanupBranchStaleChildMarkdown does NOT prune when the branch is absent from the index (fresh-repo mapping)", async () => {
			// Mapping was created via resolveFolderForBranch before any commit
			// landed; index has zero entries for this branch. Must not prune,
			// else fresh-repo branches vanish from the sidebar before they
			// ever produced a summary.
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([["a", e("a", "main", null)]]),
			);
			const storage = makeStorage();
			await cleanupBranchStaleChildMarkdown("/cwd", "freshly-checked-out", storage);
			expect(storage.pruneCalls).toEqual([]);
		});

		it("cleanupBranchStaleChildMarkdown is a no-op when storage lacks pruneBranchMappings (orphan-only)", async () => {
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "bug/main", null)],
					["b", e("b", "feature/ghost", "a")],
				]),
			);
			const storage = makeStorage({ withPrune: false });
			const result = await cleanupBranchStaleChildMarkdown("/cwd", "feature/ghost", storage);
			expect(result.deleted).toBe(1);
			expect(storage.pruneCalls).toEqual([]);
		});

		it("cleanupBranchStaleChildMarkdown does NOT prune the mapping when a stale-child delete failed", async () => {
			// Cross-branch hoist where the visible .md unlink fails (e.g. EACCES /
			// EBUSY on a user-edited or VS-Code-locked file). The branch index
			// snapshot still shows zero heads, but the orphaned .md is still on
			// disk — pruning the mapping would hide the branch from the sidebar
			// while leaving the orphan file invisible-but-present. The guard
			// keeps the mapping until a later cleanup pass succeeds.
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "bug/main", null)],
					["b", e("b", "feature/ghost", "a")],
				]),
			);
			const storage: RecordingStorage = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn(),
				ensure: vi.fn(),
				deleteVisibleMarkdown: async () => {
					throw new Error("EACCES");
				},
				pruneBranchMappings: async (branches) => {
					storage.pruneCalls.push([...branches]);
					return branches.length;
				},
				deletions: [],
				pruneCalls: [],
			};
			const result = await cleanupBranchStaleChildMarkdown("/cwd", "feature/ghost", storage);
			expect(result.failed).toBe(1);
			expect(storage.pruneCalls).toEqual([]);
		});

		it("cleanupBranchStaleChildMarkdown swallows pruneBranchMappings failures and still reports the .md deletion result", async () => {
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "bug/main", null)],
					["b", e("b", "feature/ghost", "a")],
				]),
			);
			const storage = makeStorage({ pruneThrows: true });
			const result = await cleanupBranchStaleChildMarkdown("/cwd", "feature/ghost", storage);
			// Delete tally still reflects the visible .md deletion; prune
			// failure is a side-channel that must never demote the op result.
			expect(result.deleted).toBe(1);
			expect(result.failed).toBe(0);
		});

		it("cleanupAllBranchesStaleChildMarkdown prunes every ghost branch in one batch", async () => {
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "bug/main", null)],
					["b", e("b", "feature/ghost-1", "a")],
					["c", e("c", "feature/ghost-2", "a")],
					["d", e("d", "live-branch", null)],
				]),
			);
			const storage = makeStorage();
			await cleanupAllBranchesStaleChildMarkdown("/cwd", storage);
			expect(storage.pruneCalls).toHaveLength(1);
			expect([...storage.pruneCalls[0]].sort()).toEqual(["feature/ghost-1", "feature/ghost-2"]);
		});

		it("cleanupAllBranchesStaleChildMarkdown does NOT call pruneBranchMappings when there is nothing to prune", async () => {
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "main", null)],
					["b", e("b", "main", "a")],
					["x", e("x", "feature", null)],
				]),
			);
			const storage = makeStorage();
			await cleanupAllBranchesStaleChildMarkdown("/cwd", storage);
			expect(storage.pruneCalls).toEqual([]);
		});

		it("cleanupAllBranchesStaleChildMarkdown swallows pruneBranchMappings failures", async () => {
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "bug/main", null)],
					["b", e("b", "feature/ghost", "a")],
				]),
			);
			const storage = makeStorage({ pruneThrows: true });
			const result = await cleanupAllBranchesStaleChildMarkdown("/cwd", storage);
			expect(result.deleted).toBe(1);
			expect(result.failed).toBe(0);
		});
	});

	describe("error handling", () => {
		it("counts failures when deleteVisibleMarkdown throws on every call", async () => {
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "main", null)],
					["b", e("b", "main", "a")],
					["c", e("c", "main", "b")],
				]),
			);
			const storage: StorageProvider & {
				readonly deletions: SummaryIndexEntry[];
			} = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn(),
				ensure: vi.fn(),
				deleteVisibleMarkdown: async () => {
					throw new Error("disk error");
				},
				deletions: [],
			};
			const result = await cleanupBranchStaleChildMarkdown("/cwd", "main", storage);
			expect(result.deleted).toBe(0);
			expect(result.failed).toBe(2);
		});

		it("continues deletion even if one fails", async () => {
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "main", null)],
					["b", e("b", "main", "a")],
					["c", e("c", "main", "b")],
				]),
			);
			let callCount = 0;
			const deletions: SummaryIndexEntry[] = [];
			const storage: StorageProvider & {
				readonly deletions: SummaryIndexEntry[];
			} = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn(),
				ensure: vi.fn(),
				deleteVisibleMarkdown: async (entry) => {
					callCount++;
					if (entry.commitHash === "b") {
						throw new Error("failed");
					}
					deletions.push(entry);
				},
				deletions,
			};
			const result = await cleanupBranchStaleChildMarkdown("/cwd", "main", storage);
			expect(result.deleted).toBe(1);
			expect(result.failed).toBe(1);
			expect(storage.deletions.map((d) => d.commitHash)).toEqual(["c"]);
			expect(callCount).toBe(2);
		});

		it("counts failures in cleanupAllBranchesStaleChildMarkdown when deletion throws", async () => {
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "main", null)],
					["b", e("b", "main", "a")],
					["x", e("x", "feature", null)],
					["y", e("y", "feature", "x")],
				]),
			);
			const deletions: SummaryIndexEntry[] = [];
			const storage: StorageProvider & {
				readonly deletions: SummaryIndexEntry[];
			} = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn(),
				ensure: vi.fn(),
				deleteVisibleMarkdown: async (entry) => {
					if (entry.commitHash === "b") {
						throw new Error("disk error");
					}
					deletions.push(entry);
				},
				deletions,
			};
			const result = await cleanupAllBranchesStaleChildMarkdown("/cwd", storage);
			expect(result.deleted).toBe(1);
			expect(result.failed).toBe(1);
			expect(storage.deletions.map((d) => d.commitHash)).toEqual(["y"]);
		});
	});
});
