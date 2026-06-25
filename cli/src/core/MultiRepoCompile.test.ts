import { describe, expect, it, vi } from "vitest";

vi.mock("../sync/SyncBootstrap.js", () => ({
	// Identity: the test passes its localFolder straight through as the vault root.
	deriveMemoryBankRoot: vi.fn((localFolder: string) => localFolder),
}));
vi.mock("../sync/VaultWriteLock.js", () => ({
	DEFAULT_VAULT_WRITE_WAIT_MS: 60_000,
	// Stand-in for the real typed busy signal the guard throws on a busy miss; the
	// default message matches the real class so the substring assertion holds.
	VaultWriteBusyError: class VaultWriteBusyError extends Error {
		constructor(message = "could not acquire vault-write.lock within budget") {
			super(message);
			this.name = "VaultWriteBusyError";
		}
	},
	// Default: lock free → run the body and surface its value.
	withVaultWriteLock: vi.fn(async (_root: string, _mode: unknown, body: () => Promise<unknown>) => ({
		ran: true,
		value: await body(),
	})),
}));
vi.mock("../hooks/QueueWorker.js", () => ({ launchWorker: vi.fn() }));
vi.mock("./IngestPipeline.js", () => ({
	drainIngest: vi.fn(async (cwd: string) => {
		if (cwd.endsWith("boom")) throw new Error("kaboom");
		return { batches: 1, ingested: 2 };
	}),
}));
vi.mock("./TopicWikiRenderer.js", () => ({ renderTopicKBWiki: vi.fn(async () => {}) }));
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
vi.mock("./SearchIndex.js", () => ({ SearchIndex: { rebuild: vi.fn() } }));
// Default: graph build is a no-op so the sweep's other assertions are unaffected.
vi.mock("../graph/GraphBuilder.js", () => ({ buildKnowledgeGraph: vi.fn(async () => ({ built: false })) }));

import { buildKnowledgeGraph } from "../graph/GraphBuilder.js";
import { withVaultWriteLock } from "../sync/VaultWriteLock.js";
import { drainIngest } from "./IngestPipeline.js";
import { discoverRepos } from "./MemoryBankRepoDiscovery.js";
import { compileAllRepos } from "./MultiRepoCompile.js";
import { SearchIndex } from "./SearchIndex.js";
import { getActiveStorage, setActiveStorage } from "./SummaryStore.js";
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

	it("reports self-contained `<label> — <repo>` phase lines (no [i/total], no separate render line)", async () => {
		const messages: string[] = [];
		await compileAllRepos("/mb", { model: "haiku" } as never, { onProgress: (m) => messages.push(m) });
		// wiki is one phase per repo (ingest + render merged); the line names the repo.
		expect(messages).toContain("Building knowledge wiki — jolli");
		expect(messages).toContain("Building knowledge graph — jolli");
		// boom (3rd) reports the wiki phase before drainIngest throws.
		expect(messages).toContain("Building knowledge wiki — boom");
		// No legacy counter prefix and no separate "rendering" line.
		expect(messages.some((m) => /^\[\d+\/\d+\]/.test(m))).toBe(false);
		expect(messages.some((m) => m.includes("rendering"))).toBe(false);
		expect(messages.some((m) => m.includes("ingesting sources"))).toBe(false);
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

	it("drains each repo with a per-write writeGuard that acquires vault-write.lock in wait mode (lock released during the LLM phase)", async () => {
		await compileAllRepos("/mb", { compileExcludeFolders: ["jolliai", "boom"] } as never);
		// drainIngest receives a writeGuard — the seam that re-acquires the lock per
		// write so the reconcile LLM phase runs UNLOCKED and a concurrent commit-summary
		// worker can interleave. NOT one lock held across the whole sweep.
		const opts = vi.mocked(drainIngest).mock.calls[0][2];
		expect(opts?.writeGuard).toBeTypeOf("function");
		// Invoking the guard acquires the canonical vault lock (wait-mode, keyed off the
		// vault root) with the pending-worker wakeup hook.
		await opts?.writeGuard?.(async () => {});
		expect(withVaultWriteLock).toHaveBeenCalledWith("/mb", { wait: 60_000 }, expect.any(Function), {
			launch: expect.any(Function),
		});
	});

	it("the per-write guard rejects with VaultWriteBusyError when an individual write can't acquire the lock", async () => {
		await compileAllRepos("/mb", { compileExcludeFolders: ["jolliai", "boom"] } as never);
		const guard = vi.mocked(drainIngest).mock.calls[0][2]?.writeGuard;
		// Lock busy on this one write → withVaultWriteLock reports ran:false → the
		// guard surfaces it as a TYPED VaultWriteBusyError (not a bare Error) so
		// drainIngest's page-write catch holds the page as a benign conflict instead
		// of mislabeling it a real write fault.
		vi.mocked(withVaultWriteLock).mockResolvedValueOnce({ ran: false });
		await expect(guard?.(async () => {})).rejects.toThrow("could not acquire vault-write.lock");
	});

	it("does NOT purge topic pages during a routine sweep (would delete a page a concurrent ingest just added — data loss)", async () => {
		await compileAllRepos("/mb", { compileExcludeFolders: ["jolliai", "boom"] } as never);
		expect(purgeTopicPagesExcept).not.toHaveBeenCalled();
	});

	it("stringifies non-Error throws in the per-repo error field", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: drainIngest mock rejects with a non-Error value
		vi.mocked(drainIngest).mockRejectedValueOnce("plain string failure" as any);
		const res = await compileAllRepos("/mb", { compileExcludeFolders: ["jolliai", "boom"] } as never);
		expect(res.failed).toBe(1);
		expect(res.repos.find((r) => r.folder === "jolli")?.error).toBe("plain string failure");
		expect(res.repos.find((r) => r.folder === "jolli")?.ingested).toBe(0);
	});

	it("reindexes each repo after wiki render", async () => {
		vi.mocked(SearchIndex.rebuild).mockResolvedValue({ index: {} as never, docCount: 5 });
		// Restrict to a single repo so the assertions are unambiguous.
		const res = await compileAllRepos("/mb", { compileExcludeFolders: ["jolliai", "boom"] } as never);
		expect(res.totalIngested).toBe(2);
		expect(SearchIndex.rebuild).toHaveBeenCalledWith("/mb/jolli", { kbRoot: "/mb/jolli" });
		expect(SearchIndex.rebuild).toHaveBeenCalledTimes(1);
	});

	it("swallows a reindex failure without failing the repo", async () => {
		vi.mocked(SearchIndex.rebuild).mockRejectedValue(new Error("orama boom"));
		const res = await compileAllRepos("/mb", { compileExcludeFolders: ["jolliai", "boom"] } as never);
		expect(res.failed).toBe(0); // index failure is non-fatal
		expect(res.totalIngested).toBe(2);
	});

	it("swallows a non-Error reindex rejection without failing the repo", async () => {
		// The reindex catch stringifies a bare-value rejection via String(idxErr)
		// rather than reading `.message`; it must stay non-fatal like the Error path.
		// biome-ignore lint/suspicious/noExplicitAny: rejecting with a non-Error value is the point
		vi.mocked(SearchIndex.rebuild).mockRejectedValue("orama string boom" as any);
		const res = await compileAllRepos("/mb", { compileExcludeFolders: ["jolliai", "boom"] } as never);
		expect(res.failed).toBe(0);
		expect(res.totalIngested).toBe(2);
	});

	it("relays graph-build sub-progress as a parenthesised detail on the graph phase line", async () => {
		vi.mocked(buildKnowledgeGraph).mockImplementationOnce(async (_cwd, _storage, _config, opts) => {
			opts?.onProgress?.("distilling topics");
			return { built: true };
		});
		const messages: string[] = [];
		await compileAllRepos("/mb", { compileExcludeFolders: ["jolliai", "boom"] } as never, {
			onProgress: (m) => messages.push(m),
		});
		expect(messages).toContain("Building knowledge graph — jolli (distilling topics)");
	});

	it("swallows a graph-build failure without failing the repo (non-fatal)", async () => {
		vi.mocked(buildKnowledgeGraph).mockRejectedValueOnce(new Error("graph boom"));
		const res = await compileAllRepos("/mb", { compileExcludeFolders: ["jolliai", "boom"] } as never);
		expect(res.failed).toBe(0); // graph failure is non-fatal
		expect(res.totalIngested).toBe(2);
	});

	it("swallows a non-Error graph-build rejection without failing the repo", async () => {
		// The graph catch stringifies a bare-value rejection via String(graphErr)
		// rather than reading `.message`; it must stay non-fatal like the Error path.
		// biome-ignore lint/suspicious/noExplicitAny: rejecting with a non-Error value is the point
		vi.mocked(buildKnowledgeGraph).mockRejectedValueOnce("graph string boom" as any);
		const res = await compileAllRepos("/mb", { compileExcludeFolders: ["jolliai", "boom"] } as never);
		expect(res.failed).toBe(0);
		expect(res.totalIngested).toBe(2);
	});
});
