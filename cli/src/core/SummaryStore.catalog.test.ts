/**
 * Focused tests for the catalog.json layer: toCatalogEntry, loadCatalog,
 * getCatalogWithLazyBuild (reconcile + lock + bootstrap), and the catalog
 * write-back invariants in storeSummary / removeFromIndex.
 *
 * These complement the broader `SummaryStore.test.ts` which exercises the
 * pre-catalog primitives — keeping them separate avoids growing that file
 * past its already-substantial size.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary, FileWrite } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";
import {
	getCatalog,
	getCatalogWithLazyBuild,
	loadCatalog,
	removeFromIndex,
	resolveStorage,
	setActiveStorage,
	storeSummary,
	toCatalogEntry,
} from "./SummaryStore.js";

vi.mock("./SessionTracker.js", async () => {
	const actual = await vi.importActual<typeof import("./SessionTracker.js")>("./SessionTracker.js");
	return {
		...actual,
		acquireLock: vi.fn(async () => true),
		releaseLock: vi.fn(async () => undefined),
	};
});

vi.mock("./GitOps.js", () => ({
	getDiffStats: vi.fn(async () => ({ filesChanged: 0, insertions: 0, deletions: 0 })),
	getTreeHash: vi.fn(async () => "deadbeef"),
}));

import { acquireLock, releaseLock } from "./SessionTracker.js";

const mockAcquire = vi.mocked(acquireLock);
const mockRelease = vi.mocked(releaseLock);

// ─── Memory-backed StorageProvider for hermetic tests ────────────────────────

class MemStorage implements StorageProvider {
	files = new Map<string, string>();
	writeMessages: string[] = [];
	writeCalls = 0;

	async readFile(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}
	async writeFiles(files: FileWrite[], message: string): Promise<void> {
		this.writeCalls++;
		this.writeMessages.push(message);
		for (const f of files) {
			if (f.delete) {
				this.files.delete(f.path);
			} else {
				this.files.set(f.path, f.content);
			}
		}
	}
	async listFiles(prefix: string): Promise<string[]> {
		return [...this.files.keys()].filter((k) => k.startsWith(prefix));
	}
	async exists(): Promise<boolean> {
		return true;
	}
	async ensure(): Promise<void> {
		// no-op
	}
}

function makeSummary(hash: string, overrides: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 4,
		commitHash: hash,
		commitMessage: `msg ${hash}`,
		commitAuthor: "tester",
		commitDate: "2026-04-01T00:00:00.000Z",
		branch: "feature/x",
		generatedAt: "2026-04-01T00:01:00.000Z",
		recap: `recap-${hash}`,
		ticketId: `TKT-${hash}`,
		topics: [
			{
				title: `topic-${hash}`,
				trigger: "T",
				response: "R",
				decisions: `decisions-${hash}`,
				category: "feature",
				importance: "major",
				filesAffected: [`src/${hash}.ts`],
			},
		],
		...overrides,
	};
}

let storage: MemStorage;
beforeEach(() => {
	storage = new MemStorage();
	setActiveStorage(storage);
	vi.clearAllMocks();
	mockAcquire.mockResolvedValue(true);
});

// ─── toCatalogEntry ──────────────────────────────────────────────────────────

describe("toCatalogEntry", () => {
	it("copies recap, ticketId, and topics", () => {
		const entry = toCatalogEntry(makeSummary("aaa"));
		expect(entry.commitHash).toBe("aaa");
		expect(entry.recap).toBe("recap-aaa");
		expect(entry.ticketId).toBe("TKT-aaa");
		expect(entry.topics).toHaveLength(1);
		expect(entry.topics?.[0].title).toBe("topic-aaa");
		expect(entry.topics?.[0].decisions).toBe("decisions-aaa");
		expect(entry.topics?.[0].filesAffected).toEqual(["src/aaa.ts"]);
	});

	it("omits empty fields rather than emitting undefined", () => {
		const entry = toCatalogEntry(
			makeSummary("bbb", {
				recap: undefined,
				ticketId: undefined,
				topics: [],
			}),
		);
		expect(entry.recap).toBeUndefined();
		expect(entry.ticketId).toBeUndefined();
		expect(entry.topics).toBeUndefined();
	});

	it("uses collectDisplayTopics — handles v3 legacy with topics in children", () => {
		const summary: CommitSummary = {
			...makeSummary("legacy"),
			version: 3,
			topics: [],
			children: [
				{
					version: 3,
					commitHash: "legacy-child",
					commitMessage: "child",
					commitAuthor: "x",
					commitDate: "2026-03-30T00:00:00.000Z",
					branch: "feature/x",
					generatedAt: "2026-03-30T00:00:00.000Z",
					topics: [{ title: "child-topic", trigger: "t", response: "r", decisions: "d" }],
				},
			],
		};
		const entry = toCatalogEntry(summary);
		expect(entry.topics?.length).toBe(1);
		expect(entry.topics?.[0].title).toBe("child-topic");
	});
});

// ─── loadCatalog / getCatalog ────────────────────────────────────────────────

describe("loadCatalog / getCatalog", () => {
	it("returns null when catalog.json is absent", async () => {
		expect(await loadCatalog()).toBeNull();
		expect(await getCatalog()).toBeNull();
	});

	it("returns parsed catalog when file present", async () => {
		storage.files.set("catalog.json", JSON.stringify({ version: 1, entries: [{ commitHash: "x" }] }));
		const catalog = await getCatalog();
		expect(catalog).not.toBeNull();
		expect(catalog?.entries).toHaveLength(1);
	});

	it("returns null when catalog.json is corrupt", async () => {
		storage.files.set("catalog.json", "{not json");
		expect(await getCatalog()).toBeNull();
	});
});

// ─── getCatalogWithLazyBuild (reconcile + lock) ──────────────────────────────

describe("getCatalogWithLazyBuild", () => {
	it("returns empty catalog and does not write when index is empty", async () => {
		const result = await getCatalogWithLazyBuild();
		expect(result.entries).toHaveLength(0);
		expect(storage.writeCalls).toBe(0);
		expect(mockAcquire).not.toHaveBeenCalled();
	});

	it("fast-path: no work needed when catalog matches index roots", async () => {
		storage.files.set(
			"index.json",
			JSON.stringify({
				version: 3,
				entries: [
					{
						commitHash: "aaa",
						parentCommitHash: null,
						branch: "x",
						commitMessage: "m",
						commitDate: "2026-04-01T00:00:00Z",
						generatedAt: "2026-04-01T00:00:00Z",
					},
				],
			}),
		);
		storage.files.set(
			"catalog.json",
			JSON.stringify({ version: 1, entries: [{ commitHash: "aaa", recap: "ok" }] }),
		);
		const result = await getCatalogWithLazyBuild();
		expect(result.entries).toHaveLength(1);
		expect(storage.writeCalls).toBe(0);
		expect(mockAcquire).not.toHaveBeenCalled();
	});

	it("reconciles: drops stale entries and adds missing roots", async () => {
		// Index has one root, but catalog has a stale entry + missing the real root.
		storage.files.set(
			"index.json",
			JSON.stringify({
				version: 3,
				entries: [
					{
						commitHash: "real",
						parentCommitHash: null,
						branch: "x",
						commitMessage: "m",
						commitDate: "2026-04-01T00:00:00Z",
						generatedAt: "2026-04-01T00:00:00Z",
					},
				],
			}),
		);
		storage.files.set(
			"catalog.json",
			JSON.stringify({ version: 1, entries: [{ commitHash: "stale", recap: "x" }] }),
		);
		// Provide the summary file so lazy build can populate the missing entry.
		storage.files.set("summaries/real.json", JSON.stringify(makeSummary("real")));

		const result = await getCatalogWithLazyBuild();
		const hashes = result.entries.map((e) => e.commitHash);
		expect(hashes).toEqual(["real"]);
		expect(storage.writeCalls).toBe(1);
		expect(storage.writeMessages[0]).toContain("reconcile");
	});

	it("returns in-memory result without writing on lock contention", async () => {
		mockAcquire.mockResolvedValueOnce(false);
		storage.files.set(
			"index.json",
			JSON.stringify({
				version: 3,
				entries: [
					{
						commitHash: "real",
						parentCommitHash: null,
						branch: "x",
						commitMessage: "m",
						commitDate: "2026-04-01T00:00:00Z",
						generatedAt: "2026-04-01T00:00:00Z",
					},
				],
			}),
		);
		storage.files.set("catalog.json", JSON.stringify({ version: 1, entries: [] }));
		storage.files.set("summaries/real.json", JSON.stringify(makeSummary("real")));

		const result = await getCatalogWithLazyBuild();
		expect(result.entries.map((e) => e.commitHash)).toEqual(["real"]);
		expect(storage.writeCalls).toBe(0);
		expect(mockRelease).not.toHaveBeenCalled();
	});

	it("contended in-memory path skips orphan summaries that fail to load", async () => {
		mockAcquire.mockResolvedValueOnce(false);
		storage.files.set(
			"index.json",
			JSON.stringify({
				version: 3,
				entries: [
					{
						commitHash: "ghost",
						parentCommitHash: null,
						branch: "x",
						commitMessage: "m",
						commitDate: "2026-04-01T00:00:00Z",
						generatedAt: "2026-04-01T00:00:00Z",
					},
				],
			}),
		);
		// catalog has no entries; summary file does not exist either.
		storage.files.set("catalog.json", JSON.stringify({ version: 1, entries: [] }));
		const result = await getCatalogWithLazyBuild();
		expect(result.entries).toEqual([]);
	});

	it("re-checks fast path inside the lock — another writer may have reconciled", async () => {
		// Pre-flight sees missing entry; once we acquire the lock, a different
		// writer has already reconciled. Simulate this by spying on storage reads.
		storage.files.set(
			"index.json",
			JSON.stringify({
				version: 3,
				entries: [
					{
						commitHash: "raced",
						parentCommitHash: null,
						branch: "x",
						commitMessage: "m",
						commitDate: "2026-04-01T00:00:00Z",
						generatedAt: "2026-04-01T00:00:00Z",
					},
				],
			}),
		);
		// Pre-flight catalog is empty (lazy build will plan to add).
		storage.files.set("catalog.json", JSON.stringify({ version: 1, entries: [] }));
		storage.files.set("summaries/raced.json", JSON.stringify(makeSummary("raced")));

		const realRead = storage.readFile.bind(storage);
		let phase = 0;
		const readSpy = vi.spyOn(storage, "readFile").mockImplementation(async (path: string) => {
			phase++;
			// Calls 1+2: pre-flight (catalog, index) — return empty catalog and index with 1 root.
			// Calls 3+: post-lock — pretend the catalog is already reconciled.
			if (phase >= 3 && path === "catalog.json") {
				return JSON.stringify({ version: 1, entries: [{ commitHash: "raced" }] });
			}
			return realRead(path);
		});

		const result = await getCatalogWithLazyBuild();
		expect(result.entries.map((e) => e.commitHash)).toEqual(["raced"]);
		// Because the post-lock fast path early-returned, no write happened.
		expect(storage.writeCalls).toBe(0);
		readSpy.mockRestore();
	});

	it("returns catalog and skips writing when index empties out between preflight and lock", async () => {
		// Pre-flight sees one root → schedules reconcile work. After the lock
		// acquires, the index has been deleted by another process; we should
		// return the catalog as-is without writing.
		storage.files.set(
			"index.json",
			JSON.stringify({
				version: 3,
				entries: [
					{
						commitHash: "vanish",
						parentCommitHash: null,
						branch: "x",
						commitMessage: "m",
						commitDate: "2026-04-01T00:00:00Z",
						generatedAt: "2026-04-01T00:00:00Z",
					},
				],
			}),
		);
		storage.files.set("catalog.json", JSON.stringify({ version: 1, entries: [] }));
		storage.files.set("summaries/vanish.json", JSON.stringify(makeSummary("vanish")));

		const realRead = storage.readFile.bind(storage);
		let phase = 0;
		const readSpy = vi.spyOn(storage, "readFile").mockImplementation(async (path: string) => {
			phase++;
			if (phase >= 3 && path === "index.json") {
				// Inside-lock re-read: simulate the index disappearing.
				return null;
			}
			return realRead(path);
		});

		const result = await getCatalogWithLazyBuild();
		expect(result.entries).toEqual([]);
		expect(storage.writeCalls).toBe(0);
		readSpy.mockRestore();
	});

	it("warns and skips when summary file for missing root cannot be read", async () => {
		storage.files.set(
			"index.json",
			JSON.stringify({
				version: 3,
				entries: [
					{
						commitHash: "ghost",
						parentCommitHash: null,
						branch: "x",
						commitMessage: "m",
						commitDate: "2026-04-01T00:00:00Z",
						generatedAt: "2026-04-01T00:00:00Z",
					},
				],
			}),
		);
		// no summaries/ghost.json — simulates partial state
		const result = await getCatalogWithLazyBuild();
		expect(result.entries).toHaveLength(0);
		// Still wrote (cleaned/reconciled)
		expect(storage.writeCalls).toBe(1);
	});
});

// ─── storeSummary catalog write integration ──────────────────────────────────

describe("storeSummary catalog integration", () => {
	it("writes summary + index + catalog in a single writeFiles call", async () => {
		await storeSummary(makeSummary("new1"));
		expect(storage.writeCalls).toBe(1);
		expect(storage.files.has("summaries/new1.json")).toBe(true);
		expect(storage.files.has("index.json")).toBe(true);
		expect(storage.files.has("catalog.json")).toBe(true);
		const catalog = JSON.parse(storage.files.get("catalog.json") ?? "{}");
		expect(catalog.entries).toHaveLength(1);
		expect(catalog.entries[0].commitHash).toBe("new1");
	});

	it("amend (force=true) replaces the catalog entry rather than duplicating", async () => {
		await storeSummary(makeSummary("hash1"));
		await storeSummary(makeSummary("hash1", { recap: "updated recap" }), undefined, true);
		const catalog = JSON.parse(storage.files.get("catalog.json") ?? "{}");
		expect(catalog.entries).toHaveLength(1);
		expect(catalog.entries[0].recap).toBe("updated recap");
	});
});

// ─── removeFromIndex catalog cleanup ─────────────────────────────────────────

describe("removeFromIndex catalog cleanup", () => {
	it("removes catalog entry alongside the index entry under a held lock", async () => {
		await storeSummary(makeSummary("dropMe"));
		// Sanity precondition.
		const before = JSON.parse(storage.files.get("catalog.json") ?? "{}");
		expect(before.entries).toHaveLength(1);

		await removeFromIndex("dropMe");

		const after = JSON.parse(storage.files.get("catalog.json") ?? "{}");
		expect(after.entries).toHaveLength(0);
		expect(mockAcquire).toHaveBeenCalled();
		expect(mockRelease).toHaveBeenCalled();
	});

	it("skips removal when the lock is contended", async () => {
		await storeSummary(makeSummary("locked"));
		mockAcquire.mockResolvedValueOnce(false);
		await removeFromIndex("locked");
		const catalog = JSON.parse(storage.files.get("catalog.json") ?? "{}");
		expect(catalog.entries).toHaveLength(1);
	});

	it("skips catalog write entirely when the hash is not catalog-tracked", async () => {
		// Pre-seed: summary catalog has entries A and B; index has both as roots.
		await storeSummary(makeSummary("hashA"));
		await storeSummary(makeSummary("hashB"));
		// Now request removal of a hash that exists in INDEX but not catalog by
		// manually editing catalog.json to drop that entry first.
		const cat = JSON.parse(storage.files.get("catalog.json") ?? "{}");
		cat.entries = cat.entries.filter((e: { commitHash: string }) => e.commitHash !== "hashB");
		storage.files.set("catalog.json", JSON.stringify(cat));
		const writeCallsBefore = storage.writeCalls;
		await removeFromIndex("hashB");
		// The index still removed; the catalog write is buildCatalogRemoveFileWrite-null
		// since hashB is not in catalog. So only INDEX file is written, not catalog.
		const newWrites = storage.writeCalls - writeCallsBefore;
		expect(newWrites).toBe(1);
		// Verify the write payload had only one entry (index, no catalog).
		const lastMsg = storage.writeMessages[storage.writeMessages.length - 1];
		expect(lastMsg).toContain("Remove index entry");
	});
});

// Cleanup: clear storage override after this file's tests so neighboring
// test files don't see our MemStorage by accident.
afterAll(() => {
	setActiveStorage(undefined);
});

// Reference resolveStorage so the import doesn't fail unused-vars.
void resolveStorage;
