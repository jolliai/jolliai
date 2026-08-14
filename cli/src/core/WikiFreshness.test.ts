import { beforeEach, describe, expect, it, vi } from "vitest";
import { INGEST_CODES } from "./IngestErrors.js";
import type { IngestRunRecord } from "./IngestRunStore.js";
import type { StorageProvider } from "./StorageProvider.js";
import type { SourceRef, SourceType } from "./TopicKBTypes.js";

vi.mock("node:fs", () => ({ existsSync: vi.fn() }));
vi.mock("../graph/GraphArtifactStore.js", () => ({
	graphJsonPath: (root: string) => `${root}/.jolli/graph/graph.json`,
}));
vi.mock("./ProcessedSourceStore.js", () => ({
	readProcessedSet: vi.fn().mockResolvedValue({ schemaVersion: 1, processed: {} }),
}));
vi.mock("./SourceTimeline.js", () => ({ listPendingSources: vi.fn() }));
vi.mock("./IngestRunStore.js", () => ({ readIngestRuns: vi.fn() }));
vi.mock("./ReadStorageResolver.js", () => ({ createReadStorage: vi.fn() }));
vi.mock("./MemoryBankRepoDiscovery.js", () => ({ discoverRepos: vi.fn() }));
vi.mock("./StorageFactory.js", () => ({ createFolderStorageAtRoot: (root: string) => ({ kbRoot: root }) }));

import { existsSync } from "node:fs";
import type { JolliMemoryConfig } from "../Types.js";
import { readIngestRuns } from "./IngestRunStore.js";
import { discoverRepos } from "./MemoryBankRepoDiscovery.js";
import { createReadStorage } from "./ReadStorageResolver.js";
import { listPendingSources } from "./SourceTimeline.js";
import { getAggregateWikiFreshness, getWikiFreshness, WIKI_BEHIND_WARN_MS } from "./WikiFreshness.js";

const mockExists = vi.mocked(existsSync);
const mockPending = vi.mocked(listPendingSources);
const mockRuns = vi.mocked(readIngestRuns);
const mockCreateReadStorage = vi.mocked(createReadStorage);
const mockDiscover = vi.mocked(discoverRepos);

const STORAGE = { kbRoot: "/kb" } as unknown as StorageProvider;

function ref(type: SourceType, id: string): SourceRef {
	return { type, id, timestamp: "2026-08-01T00:00:00.000Z" };
}

function okRun(startedAt: string): IngestRunRecord {
	return {
		startedAt,
		durationMs: 1,
		triggeredBy: "manual",
		outcome: INGEST_CODES.OK,
		batches: 1,
		ingested: 1,
		touchedSlugs: 1,
		routeCalls: 1,
		reconcileCalls: 1,
		topicFailures: [],
	};
}

describe("getWikiFreshness", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockExists.mockReturnValue(true); // graph exists → everBuilt
		mockPending.mockResolvedValue([]);
		mockRuns.mockResolvedValue([]);
	});

	it("counts pending sources by type", async () => {
		mockPending.mockResolvedValue([ref("summary", "a"), ref("summary", "b"), ref("plan", "p"), ref("note", "n")]);
		const f = await getWikiFreshness("/cwd", STORAGE);
		expect(f.pending).toEqual({ summary: 2, plan: 1, note: 1, userfile: 0, total: 4 });
	});

	it("severity 'never' when nothing was ever built (no graph, no OK run)", async () => {
		mockExists.mockReturnValue(false);
		mockRuns.mockResolvedValue([]);
		mockPending.mockResolvedValue([ref("summary", "a")]);
		const f = await getWikiFreshness("/cwd", STORAGE);
		expect(f.everBuilt).toBe(false);
		expect(f.severity).toBe("never");
	});

	it("severity 'fresh' when built and nothing pending", async () => {
		mockPending.mockResolvedValue([]);
		const f = await getWikiFreshness("/cwd", STORAGE);
		expect(f.severity).toBe("fresh");
	});

	it("severity 'info' when a few summaries are pending and last rebuild is recent", async () => {
		const now = Date.parse("2026-08-10T00:00:00.000Z");
		mockRuns.mockResolvedValue([okRun("2026-08-09T23:00:00.000Z")]);
		mockPending.mockResolvedValue([ref("summary", "a"), ref("summary", "b")]);
		const f = await getWikiFreshness("/cwd", STORAGE, now);
		expect(f.severity).toBe("info");
		expect(f.lastRebuiltAt).toBe("2026-08-09T23:00:00.000Z");
	});

	it("severity 'warn' when more than the count threshold of summaries are pending", async () => {
		mockPending.mockResolvedValue(Array.from({ length: 11 }, (_, i) => ref("summary", `s${i}`)));
		const f = await getWikiFreshness("/cwd", STORAGE);
		expect(f.severity).toBe("warn");
	});

	it("severity 'warn' by time when the last rebuild is older than the window and something is pending", async () => {
		const last = "2026-08-01T00:00:00.000Z";
		const now = Date.parse(last) + WIKI_BEHIND_WARN_MS + 1;
		mockRuns.mockResolvedValue([okRun(last)]);
		mockPending.mockResolvedValue([ref("plan", "p")]); // only a plan; summary=0
		const f = await getWikiFreshness("/cwd", STORAGE, now);
		expect(f.severity).toBe("warn");
	});

	it("does not warn by time when nothing is pending, however old the last rebuild", async () => {
		const now = Date.parse("2030-01-01T00:00:00.000Z");
		mockRuns.mockResolvedValue([okRun("2026-01-01T00:00:00.000Z")]);
		mockPending.mockResolvedValue([]);
		const f = await getWikiFreshness("/cwd", STORAGE, now);
		expect(f.severity).toBe("fresh");
	});

	it("picks the most recent OK run and ignores non-OK outcomes", async () => {
		mockRuns.mockResolvedValue([
			okRun("2026-08-01T00:00:00.000Z"),
			{ ...okRun("2026-08-05T00:00:00.000Z"), outcome: INGEST_CODES.ROUTE_FAILED },
			okRun("2026-08-03T00:00:00.000Z"),
		]);
		mockPending.mockResolvedValue([ref("summary", "a")]);
		const f = await getWikiFreshness("/cwd", STORAGE, Date.parse("2026-08-03T01:00:00.000Z"));
		expect(f.lastRebuiltAt).toBe("2026-08-03T00:00:00.000Z");
	});

	it("everBuilt=false + severity 'never' when graph.json is absent and no run is OK (only a NO_PENDING run)", async () => {
		mockExists.mockReturnValue(false);
		// A run exists but is NOT OK → lastRebuiltAt stays null, everBuilt stays false.
		mockRuns.mockResolvedValue([{ ...okRun("2026-08-01T00:00:00.000Z"), outcome: INGEST_CODES.NO_PENDING }]);
		mockPending.mockResolvedValue([ref("summary", "a")]);
		const f = await getWikiFreshness("/cwd", STORAGE, Date.now());
		expect(f.everBuilt).toBe(false);
		expect(f.lastRebuiltAt).toBeNull();
		expect(f.severity).toBe("never");
	});

	it("everBuilt=true via an OK run even when graph.json is absent (the lastRebuiltAt disjunct)", async () => {
		mockExists.mockReturnValue(false); // no graph.json
		mockRuns.mockResolvedValue([okRun("2026-08-09T00:00:00.000Z")]); // but a clean drain ran
		mockPending.mockResolvedValue([ref("summary", "a")]);
		const f = await getWikiFreshness("/cwd", STORAGE, Date.parse("2026-08-09T01:00:00.000Z"));
		expect(f.everBuilt).toBe(true);
		expect(f.lastRebuiltAt).toBe("2026-08-09T00:00:00.000Z");
		expect(f.severity).toBe("info");
	});

	it("falls back to cwd for the graph path when the storage has no kbRoot (orphan-only)", async () => {
		mockExists.mockReturnValue(true);
		mockPending.mockResolvedValue([]);
		const f = await getWikiFreshness("/cwd", {} as unknown as StorageProvider);
		// existsSync is mocked true, so everBuilt holds via the cwd-rooted graph path.
		expect(f.everBuilt).toBe(true);
		expect(f.severity).toBe("fresh");
	});

	it("resolves its own read storage when none is passed", async () => {
		mockCreateReadStorage.mockResolvedValue(STORAGE);
		mockPending.mockResolvedValue([]);
		await getWikiFreshness("/cwd");
		expect(mockCreateReadStorage).toHaveBeenCalledWith("/cwd");
	});
});

describe("getAggregateWikiFreshness", () => {
	const CONFIG = { localFolder: "/mb" } as unknown as JolliMemoryConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		mockExists.mockReturnValue(true); // graph exists → everBuilt for every repo
		mockRuns.mockResolvedValue([]);
		mockPending.mockResolvedValue([]);
	});

	it("aggregates behind repos only, summing pending and listing their names", async () => {
		mockDiscover.mockResolvedValue([
			{ folder: "acme", kbRoot: "/mb/acme" },
			{ folder: "beta", kbRoot: "/mb/beta" },
		]);
		// acme behind by 3 summaries; beta fresh.
		mockPending.mockImplementation(async (cwd) =>
			cwd === "/mb/acme" ? [ref("summary", "a1"), ref("summary", "a2"), ref("summary", "a3")] : [],
		);
		const f = await getAggregateWikiFreshness("/mb", CONFIG);
		expect(f.behindRepoNames).toEqual(["acme"]);
		expect(f.pending).toEqual({ summary: 3, total: 3 });
		expect(f.severity).toBe("info");
		expect(f.repos).toHaveLength(2);
	});

	it("severity 'fresh' and no behind repos when every repo is up to date", async () => {
		mockDiscover.mockResolvedValue([
			{ folder: "acme", kbRoot: "/mb/acme" },
			{ folder: "beta", kbRoot: "/mb/beta" },
		]);
		mockPending.mockResolvedValue([]);
		const f = await getAggregateWikiFreshness("/mb", CONFIG);
		expect(f.behindRepoNames).toEqual([]);
		expect(f.severity).toBe("fresh");
		expect(f.pending).toEqual({ summary: 0, total: 0 });
	});

	it("severity 'warn' when the folder-wide summary count crosses the threshold (each repo only 'info')", async () => {
		mockDiscover.mockResolvedValue([
			{ folder: "acme", kbRoot: "/mb/acme" },
			{ folder: "beta", kbRoot: "/mb/beta" },
		]);
		// 6 + 6 = 12 > 10, though neither repo alone is warn.
		mockPending.mockImplementation(async () => Array.from({ length: 6 }, (_, i) => ref("summary", `s${i}`)));
		const f = await getAggregateWikiFreshness("/mb", CONFIG);
		expect(f.severity).toBe("warn");
		expect(f.pending.summary).toBe(12);
		expect(f.behindRepoNames).toEqual(["acme", "beta"]);
	});

	it("severity 'warn' when a single repo is itself warn (>10 pending summaries)", async () => {
		mockDiscover.mockResolvedValue([{ folder: "acme", kbRoot: "/mb/acme" }]);
		mockPending.mockResolvedValue(Array.from({ length: 11 }, (_, i) => ref("summary", `s${i}`)));
		const f = await getAggregateWikiFreshness("/mb", CONFIG);
		expect(f.severity).toBe("warn");
		expect(f.behindRepoNames).toEqual(["acme"]);
	});

	it("lastRebuiltAt is the most recent OK run across repos", async () => {
		mockDiscover.mockResolvedValue([
			{ folder: "acme", kbRoot: "/mb/acme" },
			{ folder: "beta", kbRoot: "/mb/beta" },
		]);
		mockRuns.mockImplementation(async (cwd) =>
			cwd === "/mb/acme" ? [okRun("2026-08-01T00:00:00.000Z")] : [okRun("2026-08-05T00:00:00.000Z")],
		);
		const f = await getAggregateWikiFreshness("/mb", CONFIG);
		expect(f.lastRebuiltAt).toBe("2026-08-05T00:00:00.000Z");
		expect(f.everBuilt).toBe(true);
	});

	it("excludes a never-built repo that has nothing pending (not 'behind' — Rebuild could never clear it)", async () => {
		mockDiscover.mockResolvedValue([
			{ folder: "acme", kbRoot: "/mb/acme" },
			{ folder: "empty", kbRoot: "/mb/empty" },
		]);
		// acme: behind by 2. empty: never built AND nothing pending → not behind.
		mockExists.mockImplementation((p) => String(p).startsWith("/mb/acme")); // graph only for acme
		mockPending.mockImplementation(async (cwd) =>
			cwd === "/mb/acme" ? [ref("summary", "a1"), ref("summary", "a2")] : [],
		);
		const f = await getAggregateWikiFreshness("/mb", CONFIG);
		expect(f.behindRepoNames).toEqual(["acme"]);
		expect(f.pending).toEqual({ summary: 2, total: 2 });
		expect(f.severity).toBe("info");
	});

	it("empty folder (no repos) yields an all-fresh, empty snapshot", async () => {
		mockDiscover.mockResolvedValue([]);
		const f = await getAggregateWikiFreshness("/mb", CONFIG);
		expect(f).toMatchObject({ repos: [], behindRepoNames: [], severity: "fresh", lastRebuiltAt: null });
	});
});
