import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ReadStorageResolver.js", () => ({ createReadStorage: vi.fn() }));
vi.mock("./ProcessedSourceStore.js", () => ({
	emptyProcessedSet: vi.fn(() => new Set()),
	readProcessedSet: vi.fn(),
}));
vi.mock("./SourceTimeline.js", () => ({ listPendingSources: vi.fn() }));
vi.mock("./SourceContent.js", () => ({ loadSourceHeadline: vi.fn() }));
vi.mock("./TopicIndexStore.js", () => ({ readTopicIndex: vi.fn() }));
vi.mock("./MemoryBankRepoDiscovery.js", () => ({ discoverRepos: vi.fn() }));

import type { JolliMemoryConfig } from "../Types.js";
import { estimateCompile, estimateSweep } from "./CompileEstimate.js";
import { discoverRepos } from "./MemoryBankRepoDiscovery.js";
import { emptyProcessedSet, readProcessedSet } from "./ProcessedSourceStore.js";
import { createReadStorage } from "./ReadStorageResolver.js";
import { loadSourceHeadline } from "./SourceContent.js";
import { listPendingSources } from "./SourceTimeline.js";
import { readTopicIndex } from "./TopicIndexStore.js";
import type { SourceRef } from "./TopicKBTypes.js";

function refs(n: number): SourceRef[] {
	return Array.from({ length: n }, (_, i) => ({
		type: "summary",
		id: `hash${i}`,
		timestamp: "2026-01-01T00:00:00Z",
	})) as unknown as SourceRef[];
}
function topicIndex(n: number): unknown {
	return { topics: Array.from({ length: n }, (_, i) => ({ stableSlug: `t${i}` })) };
}

beforeEach(() => {
	vi.mocked(createReadStorage).mockResolvedValue({} as never);
	vi.mocked(readProcessedSet).mockResolvedValue(new Set() as never);
	vi.mocked(loadSourceHeadline).mockResolvedValue("x".repeat(120));
	vi.mocked(readTopicIndex).mockResolvedValue(topicIndex(4) as never);
	vi.mocked(listPendingSources).mockResolvedValue(refs(0));
});

describe("estimateCompile", () => {
	it("short-circuits on empty pending, still reporting index size", async () => {
		vi.mocked(readTopicIndex).mockResolvedValue(topicIndex(7) as never);
		vi.mocked(listPendingSources).mockResolvedValue(refs(0));
		const est = await estimateCompile("/mb/a");
		expect(est.pending).toEqual([]);
		expect(est.estTokens).toBe(0);
		expect(est.estUsd).toBe(0);
		expect(est.batches).toBe(0);
		expect(est.indexSize).toBe(7);
	});

	it("estimates every source for a rebuild instead of reading the processed watermark", async () => {
		vi.mocked(emptyProcessedSet).mockReturnValue(new Set() as never);
		vi.mocked(readProcessedSet).mockClear();
		vi.mocked(listPendingSources).mockResolvedValue(refs(3));

		const est = await estimateCompile("/mb/a", { rebuild: true });

		expect(emptyProcessedSet).toHaveBeenCalledOnce();
		expect(readProcessedSet).not.toHaveBeenCalled();
		expect(est.pending).toHaveLength(3);
		expect(est.estTokens).toBeGreaterThan(0);
	});

	it("computes batch count from pending / batchSize", async () => {
		vi.mocked(listPendingSources).mockResolvedValue(refs(120));
		expect((await estimateCompile("/mb/a")).batches).toBe(3); // ceil(120 / 50)
		expect((await estimateCompile("/mb/a", { batchSize: 40 })).batches).toBe(3); // ceil(120 / 40)
		expect((await estimateCompile("/mb/a", { batchSize: 200 })).batches).toBe(1);
	});

	it("produces positive token/USD estimates that scale with pending count", async () => {
		vi.mocked(listPendingSources).mockResolvedValue(refs(10));
		const small = await estimateCompile("/mb/a");
		vi.mocked(listPendingSources).mockResolvedValue(refs(100));
		const big = await estimateCompile("/mb/a");
		expect(small.estTokens).toBeGreaterThan(0);
		expect(big.estTokens).toBeGreaterThan(small.estTokens);
		expect(big.estUsd).toBeGreaterThan(small.estUsd);
	});

	it("rounds estUsd to at most 4 decimal places", async () => {
		vi.mocked(listPendingSources).mockResolvedValue(refs(37));
		const est = await estimateCompile("/mb/a");
		expect(est.estUsd).toBe(Math.round(est.estUsd * 10_000) / 10_000);
	});

	it("prices estUsd by the configured model and stamps pricesAsOf", async () => {
		vi.mocked(listPendingSources).mockResolvedValue(refs(50));
		const sonnet = await estimateCompile("/mb/a", { model: "claude-sonnet-5" });
		const opus = await estimateCompile("/mb/a", { model: "claude-opus-4-8" });
		const unknown = await estimateCompile("/mb/a", { model: "no-such-model" });
		// Opus ($5/$25) costs more than Sonnet ($3/$15) for identical token estimates.
		expect(opus.estUsd).toBeGreaterThan(sonnet.estUsd);
		// An unknown model falls back to the default (Sonnet) rate.
		expect(unknown.estUsd).toBe(sonnet.estUsd);
		expect(sonnet.pricesAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("prices a SHORT model alias the same as its resolved id (not the sonnet fallback)", async () => {
		vi.mocked(listPendingSources).mockResolvedValue(refs(50));
		// config.model is typically an alias like "opus"; resolveModelId maps it to a
		// full id that IS in the price table. Before the fix this fell through to the
		// sonnet fallback and under-priced opus.
		const opusAlias = await estimateCompile("/mb/a", { model: "opus" });
		const sonnetAlias = await estimateCompile("/mb/a", { model: "sonnet" });
		expect(opusAlias.estUsd).toBeGreaterThan(sonnetAlias.estUsd);
	});

	it("prices the 'haiku' alias at Haiku rates, not the sonnet fallback", async () => {
		vi.mocked(listPendingSources).mockResolvedValue(refs(50));
		// `haiku` resolves to the DATE-SUFFIXED id `claude-haiku-4-5-20251001`, unlike
		// opus/sonnet whose aliases resolve to un-suffixed ids. That twin key was
		// missing, so this alias fell through to the sonnet fallback and over-priced
		// a Haiku-configured repo ~3×. Haiku ($1/$5) must land strictly BELOW sonnet
		// ($3/$15) — equality would mean the fallback fired again.
		const haikuAlias = await estimateCompile("/mb/a", { model: "haiku" });
		const sonnetAlias = await estimateCompile("/mb/a", { model: "sonnet" });
		expect(haikuAlias.estUsd).toBeGreaterThan(0);
		expect(haikuAlias.estUsd).toBeLessThan(sonnetAlias.estUsd);
	});

	it("caps the reconcile-context term at min(indexSize, batchSize) per batch", async () => {
		// One batch of sources against a HUGE index: the per-batch topic count must
		// be capped at batchSize, so a 10x bigger index does NOT 10x the estimate.
		vi.mocked(listPendingSources).mockResolvedValue(refs(10));
		vi.mocked(readTopicIndex).mockResolvedValue(topicIndex(50) as never);
		const smallIndex = await estimateCompile("/mb/a", { batchSize: 50 });
		vi.mocked(readTopicIndex).mockResolvedValue(topicIndex(500) as never);
		const bigIndex = await estimateCompile("/mb/a", { batchSize: 50 });
		// With the cap both are bounded by batchSize (50) topics/batch → identical.
		expect(bigIndex.estTokens).toBe(smallIndex.estTokens);
	});
});

describe("estimateSweep", () => {
	const config = { compileExcludeFolders: [] } as unknown as JolliMemoryConfig;

	it("aggregates per-repo estimates and sorts biggest-first", async () => {
		vi.mocked(discoverRepos).mockResolvedValue([
			{ folder: "small", kbRoot: "/mb/small" },
			{ folder: "big", kbRoot: "/mb/big" },
		] as never);
		vi.mocked(listPendingSources).mockImplementation(async (cwd: string) =>
			cwd.includes("big") ? refs(50) : refs(5),
		);

		const res = await estimateSweep("/mb", config);
		expect(res.perRepo.map((r) => r.repo)).toEqual(["big", "small"]); // sorted by sources desc
		expect(res.total.sources).toBe(55);
		expect(res.total.tokens).toBeGreaterThan(0);
		expect(res.total.usd).toBe(Math.round(res.total.usd * 10_000) / 10_000);
	});

	it("isolates a per-repo estimate failure (non-fatal, contributes 0)", async () => {
		vi.mocked(discoverRepos).mockResolvedValue([
			{ folder: "ok", kbRoot: "/mb/ok" },
			{ folder: "boom", kbRoot: "/mb/boom" },
		] as never);
		vi.mocked(listPendingSources).mockImplementation(async (cwd: string) => {
			if (cwd.includes("boom")) throw new Error("kaboom");
			return refs(8);
		});

		const res = await estimateSweep("/mb", config);
		expect(res.total.sources).toBe(8); // boom contributes 0
		const boom = res.perRepo.find((r) => r.repo === "boom");
		expect(boom?.error).toContain("kaboom");
		expect(boom?.sources).toBe(0);
	});

	it("passes compileExcludeFolders through to discovery", async () => {
		vi.mocked(discoverRepos).mockResolvedValue([] as never);
		await estimateSweep("/mb", { compileExcludeFolders: ["temp", "*-archive"] } as unknown as JolliMemoryConfig);
		expect(discoverRepos).toHaveBeenCalledWith("/mb", ["temp", "*-archive"]);
	});
});
