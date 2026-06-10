import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchDoc } from "./SearchIndexTypes.js";

vi.mock("./SearchIndexSource.js", () => ({
	collectSearchDocs: vi.fn(),
	computeSourceSignature: vi.fn(),
}));

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
	{
		// Sibling feature/* branch sharing the "feature" token with feature/auth —
		// guards the branch filter against Orama's token-union `where` semantics.
		id: "topic:billing-cache",
		type: "topic",
		title: "Billing Cache",
		content: "Billing Cache\nThe billing cache also has a 30-minute timeout window.",
		decisions: "",
		branch: ["feature/billing"],
		category: "summary",
		commitDate: "2026-01-04T00:00:00Z",
		slug: "billing-cache",
		hash: "",
	},
];

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "jolli-idx-"));
	vi.mocked(collectSearchDocs).mockResolvedValue(docs);
	vi.mocked(computeSourceSignature).mockResolvedValue("sig-v1");
});
afterEach(async () => {
	SearchIndex.clearCache();
	await rm(dir, { recursive: true, force: true });
});

describe("SearchIndex", () => {
	it("builds from sources and finds a full-text match", async () => {
		const idx = await SearchIndex.open(dir);
		const res = await idx.search({ query: "auth timeout" });
		expect(res.length).toBeGreaterThan(0);
		expect(res.map((r) => r.id)).toContain("topic:auth-timeout");
	});

	it("filters by type", async () => {
		const idx = await SearchIndex.open(dir);
		const commitsOnly = await idx.search({ query: "auth", type: "commit" });
		expect(commitsOnly.every((r) => r.type === "commit")).toBe(true);
	});

	it("clamps an oversized limit so a hostile MCP arg can't trigger Orama's Array.from RangeError", async () => {
		const idx = await SearchIndex.open(dir);
		// `limit` is unbounded MCP tool input. Orama preallocates
		// `Array.from({length: limit})`, which throws RangeError above 2^32-1.
		// The clamp must cap it before it reaches Orama.
		const res = await idx.search({ query: "timeout", limit: 1e10 });
		expect(res.length).toBeGreaterThan(0);
		expect(res.length).toBeLessThanOrEqual(100);
	});

	it("falls back to the default limit when a non-conforming client sends a non-numeric `limit`", async () => {
		const idx = await SearchIndex.open(dir);
		// The MCP SDK validates the request envelope but NOT per-tool arg types, so
		// `limit` can arrive as a string. Without the Number.isFinite guard,
		// Math.trunc("abc") → NaN poisons the clamp and Orama returns 0 hits
		// silently; it must instead fall back to the default and still match.
		const res = await idx.search({ query: "timeout", limit: "abc" as unknown as number });
		expect(res.length).toBeGreaterThan(0);
	});

	it("filters by exact branch membership (multi-branch topic, space-joined)", async () => {
		const idx = await SearchIndex.open(dir);
		// Only topic:auth-timeout lists "main" among its related branches.
		const onMain = await idx.search({ query: "timeout", branch: "main" });
		const ids = onMain.map((r) => r.id);
		expect(ids).toContain("topic:auth-timeout"); // branch "feature/auth main"
		expect(ids).not.toContain("commit:abc123"); // branch "feature/auth" only
		expect(ids).not.toContain("topic:billing-cache"); // branch "feature/billing"
	});

	it("does not leak across slash branches that share a token", async () => {
		const idx = await SearchIndex.open(dir);
		// "feature/auth" shares the "feature" token with "feature/billing"; the
		// exact-membership post-filter must NOT surface the billing topic (Orama's
		// token-union `where` would have).
		const res = await idx.search({ query: "timeout", branch: "feature/auth" });
		const ids = res.map((r) => r.id);
		expect(ids).toContain("topic:auth-timeout");
		expect(ids).toContain("commit:abc123");
		expect(ids).not.toContain("topic:billing-cache");
	});

	it("persists and restores without rebuilding when the signature matches", async () => {
		await SearchIndex.open(dir); // builds + persists
		vi.mocked(collectSearchDocs).mockClear();

		const reopened = await SearchIndex.open(dir); // signature unchanged → restore
		const res = await reopened.search({ query: "timeout" });
		expect(res.length).toBeGreaterThan(0);
		expect(collectSearchDocs).not.toHaveBeenCalled(); // restored, not rebuilt
	});

	it("rebuilds when the source signature changed", async () => {
		await SearchIndex.open(dir); // persists with sig-v1
		vi.mocked(computeSourceSignature).mockResolvedValue("sig-v2");
		vi.mocked(collectSearchDocs).mockClear();

		await SearchIndex.open(dir);
		expect(collectSearchDocs).toHaveBeenCalledTimes(1); // stale → rebuilt
	});

	it("rebuild rebuilds from source and returns the doc count", async () => {
		const { docCount } = await SearchIndex.rebuild(dir);
		expect(docCount).toBe(docs.length);
	});

	it("computes the source signature only once on a cold open (no redundant recompute when it builds)", async () => {
		vi.mocked(computeSourceSignature).mockClear();
		// Cold: empty cache + no persisted manifest → open must build. open should
		// reuse the signature it already computed rather than recomputing it inside
		// the build path (each recompute re-reads index + catalog + topic index).
		await SearchIndex.open(dir);
		expect(computeSourceSignature).toHaveBeenCalledTimes(1);
	});

	it("openCached returns the same instance while the signature is unchanged", async () => {
		const a = await SearchIndex.openCached(dir);
		vi.mocked(collectSearchDocs).mockClear();
		const b = await SearchIndex.openCached(dir);
		expect(b).toBe(a); // memoized — no re-restore/rebuild
		expect(collectSearchDocs).not.toHaveBeenCalled();
	});

	it("openCached reopens when the source signature changes", async () => {
		const a = await SearchIndex.openCached(dir);
		vi.mocked(computeSourceSignature).mockResolvedValue("sig-v2");
		const b = await SearchIndex.openCached(dir);
		expect(b).not.toBe(a); // stale → new index
	});

	it("openCached restores from disk (no rebuild) on a cold cache when the persisted signature matches", async () => {
		// First call builds + persists and memoizes. Dropping the in-memory cache
		// forces the next openCached to miss the memo but find the matching persisted
		// manifest, so it restores from disk rather than recollecting source docs.
		await SearchIndex.openCached(dir);
		SearchIndex.clearCache();
		vi.mocked(collectSearchDocs).mockClear();

		const reopened = await SearchIndex.openCached(dir);
		const res = await reopened.search({ query: "timeout" });
		expect(res.length).toBeGreaterThan(0);
		expect(collectSearchDocs).not.toHaveBeenCalled(); // restored from disk, not rebuilt
	});

	it("rebuilds when the persisted manifest has a stale schema version", async () => {
		const { writeFile } = await import("node:fs/promises");
		const { getJolliMemoryDir } = await import("../Logger.js");
		await SearchIndex.open(dir); // build + persist a current-schema manifest
		// Rewrite the manifest with an outdated schemaVersion (valid JSON, wrong
		// version) so tryRestore rejects it on the version guard, not the JSON parse.
		await writeFile(
			join(getJolliMemoryDir(dir), "search-index.manifest.json"),
			JSON.stringify({ schemaVersion: -1, sourceSignature: "sig-v1", savedAt: "2026-01-01T00:00:00Z" }),
			"utf-8",
		);
		SearchIndex.clearCache();
		vi.mocked(collectSearchDocs).mockClear();

		await SearchIndex.open(dir);
		expect(collectSearchDocs).toHaveBeenCalledTimes(1); // stale schema → rebuilt
	});

	it("returns a rare-branch hit even when other branches flood the top-N (no over-fetch truncation)", async () => {
		// Regression guard (N1): a high-frequency term ("auth") matches many docs on
		// a popular branch and exactly one doc on a rare branch. A branch filter must
		// surface the rare-branch hit regardless of how many higher-scoring docs on
		// OTHER branches exist — i.e. filtering happens in the index, not by post-
		// filtering a globally-ranked top-N window that the rare hit can fall outside.
		const flood: SearchDoc[] = Array.from({ length: 130 }, (_, i) => ({
			id: `commit:flood${i}`,
			type: "commit" as const,
			title: "auth auth auth",
			content: "auth auth auth auth auth", // high TF → outranks the rare doc
			decisions: "",
			branch: ["main"],
			category: "commit",
			commitDate: "2026-01-01T00:00:00Z",
			slug: "",
			hash: `flood${i}`,
		}));
		const rare: SearchDoc = {
			id: "commit:rarehit",
			type: "commit",
			title: "auth",
			content: "auth", // low TF → ranks below the flood
			decisions: "",
			branch: ["feature/rare"],
			category: "commit",
			commitDate: "2026-01-01T00:00:00Z",
			slug: "",
			hash: "rarehit",
		};
		vi.mocked(collectSearchDocs).mockResolvedValue([...flood, rare]);
		const idx = await SearchIndex.open(dir);
		const res = await idx.search({ query: "auth", branch: "feature/rare" });
		expect(res.map((r) => r.id)).toContain("commit:rarehit");
	});

	const cjkDoc: SearchDoc = {
		id: "commit:cjk",
		type: "commit",
		title: "认证超时",
		content: "用户认证会话有三十分钟的硬性超时限制",
		decisions: "",
		branch: ["main"],
		category: "commit",
		commitDate: "2026-01-05T00:00:00Z",
		slug: "",
		hash: "cjk",
	};

	it("finds CJK (Chinese) content by a Chinese query", async () => {
		// The default Orama tokenizer treats CJK characters as separators, so a
		// Chinese body produces zero tokens and is unsearchable. A CJK-aware
		// tokenizer must index n-grams so a Chinese query matches.
		vi.mocked(collectSearchDocs).mockResolvedValue([cjkDoc]);
		const idx = await SearchIndex.open(dir);
		const res = await idx.search({ query: "认证超时" });
		expect(res.map((r) => r.id)).toContain("commit:cjk");
	});

	it("finds CJK content after restoring the persisted index (tokenizer survives restore)", async () => {
		// restore() rebuilds the Orama db with default components — the CJK-aware
		// tokenizer must be re-applied to the restored db, else the query term is
		// tokenized with the default rule and a Chinese query matches nothing even
		// though the index holds the n-grams.
		vi.mocked(collectSearchDocs).mockResolvedValue([cjkDoc]);
		await SearchIndex.open(dir); // build + persist
		SearchIndex.clearCache();
		vi.mocked(collectSearchDocs).mockClear();
		const reopened = await SearchIndex.open(dir); // restore from disk
		expect(collectSearchDocs).not.toHaveBeenCalled(); // confirm it restored, not rebuilt
		const res = await reopened.search({ query: "认证" });
		expect(res.map((r) => r.id)).toContain("commit:cjk");
	});

	it("persists the index under the storage's kbRoot, not cwd, when folder-backed", async () => {
		// P4: the compile sweep warms the index with folder storage rooted at the
		// Memory Bank folder, while the MCP server runs in the git checkout. Keying
		// the index off the storage's kbRoot (not cwd) makes both resolve the same
		// file, so the warm-up isn't wasted.
		const { existsSync } = await import("node:fs");
		const { getJolliMemoryDir } = await import("../Logger.js");
		const kbDir = await mkdtemp(join(tmpdir(), "jolli-kb-"));
		try {
			const storage = { kbRoot: kbDir } as unknown as import("./StorageProvider.js").StorageProvider;
			await SearchIndex.open(dir, storage);
			expect(existsSync(join(getJolliMemoryDir(kbDir), "search-index.json"))).toBe(true);
			expect(existsSync(join(getJolliMemoryDir(dir), "search-index.json"))).toBe(false);
		} finally {
			await rm(kbDir, { recursive: true, force: true });
		}
	});

	it("rebuilds when the persisted manifest is missing/corrupt", async () => {
		const { writeFile } = await import("node:fs/promises");
		const { getJolliMemoryDir } = await import("../Logger.js");
		await SearchIndex.open(dir);
		// Corrupt the manifest so tryRestore throws → open must rebuild.
		await writeFile(join(getJolliMemoryDir(dir), "search-index.manifest.json"), "{ not json", "utf-8");
		vi.mocked(collectSearchDocs).mockClear();
		await SearchIndex.open(dir);
		expect(collectSearchDocs).toHaveBeenCalledTimes(1);
	});
});
