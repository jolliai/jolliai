import { describe, expect, it, vi } from "vitest";

vi.mock("../sync/SyncBootstrap.js", () => ({
	// Identity: the test passes its localFolder straight through as the vault root.
	deriveMemoryBankRoot: vi.fn((localFolder: string) => localFolder),
}));
vi.mock("../sync/VaultWriteLock.js", () => ({
	// Default: lock free → run the body and surface its value.
	withVaultWriteLock: vi.fn(async (_root: string, _mode: unknown, body: () => Promise<unknown>) => ({
		ran: true,
		value: await body(),
	})),
}));
vi.mock("./IngestPipeline.js", () => ({
	drainIngest: vi.fn(async (cwd: string) => {
		if (cwd.endsWith("boom")) throw new Error("kaboom");
		return { batches: 1, ingested: 2 };
	}),
}));
vi.mock("./TopicWikiRenderer.js", () => ({ renderTopicKBWiki: vi.fn(async () => {}) }));
vi.mock("./TopicIndexStore.js", () => ({ readTopicIndex: vi.fn(async () => ({ schemaVersion: 1, topics: [] })) }));
vi.mock("./TopicPageStore.js", () => ({ purgeTopicPagesExcept: vi.fn(async () => []) }));
vi.mock("./StorageFactory.js", () => ({ createFolderStorageAtRoot: vi.fn((kbRoot: string) => ({ kbRoot })) }));
vi.mock("./SummaryStore.js", () => ({ setActiveStorage: vi.fn(), getActiveStorage: vi.fn(() => undefined) }));
vi.mock("./MemoryBankRepoDiscovery.js", () => ({
	discoverRepos: vi.fn(async (_localFolder: string, exclude: string[]) => {
		const all = [
			{ folder: "jolli", kbRoot: "/mb/jolli", repoIdentity: "id-jolli" },
			{ folder: "jolliai", kbRoot: "/mb/jolliai" },
			{ folder: "boom", kbRoot: "/mb/boom" },
		];
		return all.filter((t) => !exclude.includes(t.folder));
	}),
}));

import { withVaultWriteLock } from "../sync/VaultWriteLock.js";
import { drainIngest } from "./IngestPipeline.js";
import { discoverRepos } from "./MemoryBankRepoDiscovery.js";
import { compileAllRepos } from "./MultiRepoCompile.js";
import { getActiveStorage, setActiveStorage } from "./SummaryStore.js";
import { readTopicIndex } from "./TopicIndexStore.js";
import { purgeTopicPagesExcept } from "./TopicPageStore.js";

describe("compileAllRepos", () => {
	it("compiles each repo, isolates failures, aggregates totals", async () => {
		const res = await compileAllRepos("/mb", { model: "haiku" } as never);
		expect(res.totalIngested).toBe(4); // jolli(2) + jolliai(2); boom failed(0)
		expect(res.failed).toBe(1);
		expect(res.repos.find((r) => r.folder === "boom")?.error).toContain("kaboom");
		expect(res.repos.find((r) => r.folder === "jolli")?.ingested).toBe(2);
		expect(res.repos.find((r) => r.folder === "jolli")?.repoIdentity).toBe("id-jolli");
		// 3 per-repo swaps + 1 final restore.
		expect(setActiveStorage).toHaveBeenCalledTimes(4);
	});

	it("restores the previous active storage override after the sweep (no leak into the host process)", async () => {
		const prev = { kbRoot: "/previously-active" };
		vi.mocked(getActiveStorage).mockReturnValueOnce(prev as never);

		await compileAllRepos("/mb", { model: "haiku" } as never);

		const calls = vi.mocked(setActiveStorage).mock.calls;
		// The LAST call restores whatever was active before the sweep started.
		expect(calls[calls.length - 1][0]).toBe(prev);
	});

	it("passes compileExcludeFolders through to discovery", async () => {
		const res = await compileAllRepos("/mb", { compileExcludeFolders: ["boom"] } as never);
		expect(discoverRepos).toHaveBeenCalledWith("/mb", ["boom"]);
		expect(res.repos.map((r) => r.folder)).toEqual(["jolli", "jolliai"]);
		expect(res.failed).toBe(0);
		expect(drainIngest).toHaveBeenCalledWith(
			"/mb/jolli",
			expect.anything(),
			expect.objectContaining({ readStorage: { kbRoot: "/mb/jolli" } }),
		);
	});

	it("passes discovered topic slugs through when purging stale topic pages", async () => {
		vi.mocked(readTopicIndex).mockResolvedValueOnce({
			schemaVersion: 1,
			topics: [{ stableSlug: "auth" }, { stableSlug: "storage" }],
			// biome-ignore lint/suspicious/noExplicitAny: minimal topic-index stub
		} as any);
		const res = await compileAllRepos("/mb", { compileExcludeFolders: ["jolliai", "boom"] } as never);
		expect(res.repos.map((r) => r.folder)).toEqual(["jolli"]);
		expect(purgeTopicPagesExcept).toHaveBeenCalledWith(["auth", "storage"], "/mb/jolli", { kbRoot: "/mb/jolli" });
	});

	it("runs the sweep under the canonical vault-write lock (fail-fast, keyed off the vault root)", async () => {
		await compileAllRepos("/mb", { model: "haiku" } as never);
		expect(withVaultWriteLock).toHaveBeenCalledWith("/mb", "fail-fast", expect.any(Function));
	});

	it("skips the sweep (no discovery) when another vault writer holds the lock", async () => {
		// Lock busy → body never runs → ran:false.
		vi.mocked(withVaultWriteLock).mockResolvedValueOnce({ ran: false });
		const res = await compileAllRepos("/mb", { model: "haiku" } as never);
		expect(res.skipped).toBe(true);
		expect(res.repos).toEqual([]);
		expect(res.totalIngested).toBe(0);
		expect(discoverRepos).not.toHaveBeenCalled();
	});

	it("stringifies non-Error throws in the per-repo error field", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: drainIngest mock rejects with a non-Error value
		vi.mocked(drainIngest).mockRejectedValueOnce("plain string failure" as any);
		const res = await compileAllRepos("/mb", { compileExcludeFolders: ["jolliai", "boom"] } as never);
		expect(res.failed).toBe(1);
		expect(res.repos.find((r) => r.folder === "jolli")?.error).toBe("plain string failure");
		expect(res.repos.find((r) => r.folder === "jolli")?.ingested).toBe(0);
	});
});
