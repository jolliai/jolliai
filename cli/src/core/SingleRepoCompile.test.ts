import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sync/SyncBootstrap.js", () => ({ deriveMemoryBankRoot: vi.fn((f: string) => f) }));
vi.mock("../sync/VaultWriteLock.js", () => ({
	DEFAULT_VAULT_WRITE_WAIT_MS: 60_000,
	VaultWriteBusyError: class VaultWriteBusyError extends Error {},
	// Lock free: run the guarded body and surface its value.
	withVaultWriteLock: vi.fn(async (_root: string, _mode: unknown, body: () => Promise<unknown>) => ({
		ran: true,
		value: await body(),
	})),
}));
vi.mock("../hooks/QueueWorker.js", () => ({ launchWorker: vi.fn() }));
vi.mock("./IngestPipeline.js", () => ({ drainIngest: vi.fn() }));
vi.mock("./TopicWikiRenderer.js", () => ({ renderTopicKBWiki: vi.fn(async () => {}) }));
vi.mock("./TopicPageStore.js", () => ({ purgeTopicPagesExcept: vi.fn(async () => []) }));
vi.mock("./StorageFactory.js", () => ({ createStorage: vi.fn(async () => ({ tag: "storage" })) }));
vi.mock("./SummaryStore.js", () => ({ setActiveStorage: vi.fn(), getActiveStorage: vi.fn(() => undefined) }));
vi.mock("./ProcessedSourceStore.js", () => ({
	emptyProcessedSet: vi.fn(() => ({ empty: "processed" })),
	saveProcessedSet: vi.fn(async () => {}),
}));
vi.mock("./TopicIndexStore.js", () => ({
	emptyTopicIndex: vi.fn(() => ({ topics: [] })),
	readTopicIndex: vi.fn(async () => ({ topics: [{ stableSlug: "keep" }] })),
	saveTopicIndex: vi.fn(async () => {}),
}));
vi.mock("../graph/GraphBuilder.js", () => ({ buildKnowledgeGraph: vi.fn(async () => ({ built: false })) }));
vi.mock("./SearchIndex.js", () => ({ SearchIndex: { rebuild: vi.fn(async () => {}) } }));

import { buildKnowledgeGraph } from "../graph/GraphBuilder.js";
import type { JolliMemoryConfig } from "../Types.js";
import type { CompileProgressEvent } from "./CompileProgress.js";
import { drainIngest } from "./IngestPipeline.js";
import { saveProcessedSet } from "./ProcessedSourceStore.js";
import { SearchIndex } from "./SearchIndex.js";
import { compileSingleRepo } from "./SingleRepoCompile.js";
import { createStorage } from "./StorageFactory.js";
import { saveTopicIndex } from "./TopicIndexStore.js";
import { purgeTopicPagesExcept } from "./TopicPageStore.js";
import { renderTopicKBWiki } from "./TopicWikiRenderer.js";

const CFG = { apiKey: "sk-test", localFolder: "/mb" } as unknown as JolliMemoryConfig;

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(drainIngest).mockResolvedValue({ ingested: 3, batches: 1, outcome: "OK", topicFailures: [] } as never);
	delete process.env.ANTHROPIC_API_KEY;
});

describe("compileSingleRepo", () => {
	it("returns noApiKey when no credentials are configured", async () => {
		const res = await compileSingleRepo("/repo", { localFolder: "/mb" } as JolliMemoryConfig);
		expect(res).toEqual({ ok: false, failure: { kind: "noApiKey" } });
		expect(drainIngest).not.toHaveBeenCalled();
	});

	it("returns cancelled when the signal is already aborted", async () => {
		const res = await compileSingleRepo("/repo", CFG, { signal: AbortSignal.abort() });
		expect(res).toEqual({ ok: false, failure: { kind: "cancelled" } });
		expect(drainIngest).not.toHaveBeenCalled();
	});

	it("returns cancelled when the signal aborts MID-compile (during the drain), not only when pre-aborted", async () => {
		// The between-phase abort check must catch a signal that fires while a phase is
		// running, not just one aborted before compile started. Abort during the drain →
		// the post-drain check returns cancelled and the graph phase is never entered.
		const controller = new AbortController();
		vi.mocked(drainIngest).mockImplementationOnce(async () => {
			controller.abort();
			return { ingested: 1, batches: 1, outcome: "OK", topicFailures: [] } as never;
		});
		const res = await compileSingleRepo("/repo", CFG, { signal: controller.signal });
		expect(res).toEqual({ ok: false, failure: { kind: "cancelled" } });
		expect(buildKnowledgeGraph).not.toHaveBeenCalled();
	});

	it("skips the graph build when the signal aborts during wiki render (check immediately before the graph phase)", async () => {
		// The graph build is NOT cancellable once started (no signal threaded in), so the
		// only cancel opportunity is the check right before it. Abort during render → that
		// check fires → cancelled, graph never built.
		const controller = new AbortController();
		vi.mocked(renderTopicKBWiki).mockImplementationOnce(async () => {
			controller.abort();
		});
		const res = await compileSingleRepo("/repo", CFG, { signal: controller.signal });
		expect(res).toEqual({ ok: false, failure: { kind: "cancelled" } });
		expect(buildKnowledgeGraph).not.toHaveBeenCalled();
	});

	it("succeeds, threading drain results through", async () => {
		const res = await compileSingleRepo("/repo", CFG);
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.ingested).toBe(3);
			expect(res.batches).toBe(1);
			expect(res.outcome).toBe("OK");
		}
	});

	it("uses explicit folder storage instead of deriving storage from cwd", async () => {
		const storage = { tag: "folder-root" } as never;

		await compileSingleRepo("/mb/repo", CFG, { storage });

		expect(createStorage).not.toHaveBeenCalled();
		expect(drainIngest).toHaveBeenCalledWith("/mb/repo", CFG, expect.objectContaining({ readStorage: storage }));
	});

	it("rebuild resets the processed-set + topic index and purges orphan pages", async () => {
		await compileSingleRepo("/repo", CFG, { rebuild: true });
		expect(saveProcessedSet).toHaveBeenCalledTimes(1);
		expect(saveTopicIndex).toHaveBeenCalledTimes(1);
		// Purge keeps exactly the slugs still in the index after the drain.
		expect(purgeTopicPagesExcept).toHaveBeenCalledTimes(1);
		expect(vi.mocked(purgeTopicPagesExcept).mock.calls[0][0]).toEqual(["keep"]);
	});

	it("a routine (non-rebuild) compile does NOT reset or purge", async () => {
		await compileSingleRepo("/repo", CFG, { rebuild: false });
		expect(saveProcessedSet).not.toHaveBeenCalled();
		expect(saveTopicIndex).not.toHaveBeenCalled();
		expect(purgeTopicPagesExcept).not.toHaveBeenCalled();
	});

	it("emits structured progress in phase order wiki → graph → search-index", async () => {
		const phases: CompileProgressEvent["phase"][] = [];
		await compileSingleRepo("/repo", CFG, { onProgressEvent: (e) => phases.push(e.phase) });
		expect(phases).toEqual(["wiki", "graph", "search-index"]);
		expect(SearchIndex.rebuild).toHaveBeenCalledTimes(1);
	});
});
