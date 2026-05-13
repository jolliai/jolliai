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

function makeStorage(): StorageProvider & {
	readonly deletions: SummaryIndexEntry[];
} {
	const deletions: SummaryIndexEntry[] = [];
	return {
		readFile: vi.fn(),
		writeFiles: vi.fn(),
		listFiles: vi.fn(),
		exists: vi.fn(),
		ensure: vi.fn(),
		deleteVisibleMarkdown: async (entry) => {
			deletions.push(entry);
		},
		deletions,
	};
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
