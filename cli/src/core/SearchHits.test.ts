import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchDoc } from "./SearchIndexTypes.js";

vi.mock("./SearchIndexSource.js", () => ({
	collectSearchDocs: vi.fn(),
	computeSourceSignature: vi.fn(),
}));

import { searchHits } from "./SearchHits.js";
import { SearchIndex } from "./SearchIndex.js";
import { collectSearchDocs, computeSourceSignature } from "./SearchIndexSource.js";

const docs: SearchDoc[] = [
	{
		id: "topic:auth-timeout",
		type: "topic",
		title: "Auth Timeout",
		content: "Auth Timeout\nThe auth session has a 30-minute hard timeout.",
		decisions: "",
		branch: ["feature/auth", "main"],
		category: "summary",
		commitDate: "2026-01-03T00:00:00Z",
		slug: "auth-timeout",
		hash: "",
	},
	{
		id: "commit:abc123",
		type: "commit",
		title: "add auth timeout",
		content: "add auth timeout\nChose a 30-min hard cap.",
		decisions: "Chose a 30-min hard cap.",
		branch: ["feature/auth"],
		category: "commit",
		commitDate: "2026-01-02T00:00:00Z",
		slug: "",
		hash: "abc123",
	},
];

const seededTerm = "timeout";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "jolli-hits-"));
	vi.mocked(collectSearchDocs).mockResolvedValue(docs);
	vi.mocked(computeSourceSignature).mockResolvedValue("sig-v1");
});
afterEach(async () => {
	SearchIndex.clearCache();
	await rm(dir, { recursive: true, force: true });
});

describe("searchHits", () => {
	it("throws on empty query", async () => {
		await expect(searchHits(dir, { query: "  " })).rejects.toThrow(/query/i);
	});

	it("throws on empty string query", async () => {
		await expect(searchHits(dir, { query: "" })).rejects.toThrow(/query/i);
	});

	it("returns BM25 hits for a seeded term", async () => {
		const hits = await searchHits(dir, { query: seededTerm });
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]).toHaveProperty("hash");
		expect(hits[0]).toHaveProperty("snippet");
	});

	it("forwards branch filter to the index", async () => {
		const hits = await searchHits(dir, { query: seededTerm, branch: "main" });
		// Only topic:auth-timeout has branch "main"
		expect(hits.map((h) => h.id)).toContain("topic:auth-timeout");
		expect(hits.map((h) => h.id)).not.toContain("commit:abc123");
	});

	it("forwards type filter to the index", async () => {
		const hits = await searchHits(dir, { query: seededTerm, type: "commit" });
		expect(hits.every((h) => h.type === "commit")).toBe(true);
	});

	it("forwards limit to the index", async () => {
		const hits = await searchHits(dir, { query: seededTerm, limit: 1 });
		expect(hits.length).toBeLessThanOrEqual(1);
	});

	it("forwards the storage argument to SearchIndex.openCached", async () => {
		// The storage arg determines where the index dir resolves (kbRoot vs cwd).
		// We use a distinct temp dir as a fake kbRoot and verify the index is written
		// there (same contract as the SearchIndex storage-routing test).
		const { existsSync } = await import("node:fs");
		const { getJolliMemoryDir } = await import("../Logger.js");
		const kbDir = await mkdtemp(join(tmpdir(), "jolli-kb-"));
		try {
			const storage = { kbRoot: kbDir } as unknown as import("./StorageProvider.js").StorageProvider;
			await searchHits(dir, { query: seededTerm }, storage);
			expect(existsSync(join(getJolliMemoryDir(kbDir), "search-index.json"))).toBe(true);
		} finally {
			await rm(kbDir, { recursive: true, force: true });
		}
	});
});
