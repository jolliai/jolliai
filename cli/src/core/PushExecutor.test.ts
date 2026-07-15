import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary } from "../Types.js";
import { execGit, getCurrentBranch, getDefaultBranch } from "./GitOps.js";
import { getCanonicalRepoUrl } from "./GitRemoteUtils.js";
import {
	BATCH_MAX_ITEMS,
	BATCH_MAX_TOTAL_CONTENT_CHARS,
	type BatchPushPayload,
	type BatchPushResult,
	BatchUnsupportedError,
	BindingRequiredError,
	ClientOutdatedError,
	NotAuthenticatedError,
	PermissionDeniedError,
} from "./JolliMemoryPushClient.js";
import {
	applyBatchResult,
	assignOwnedAttachments,
	type BuiltBatchItem,
	buildBatchItems,
	pushSummary,
} from "./JolliMemoryPushOrchestrator.js";
import { loadBranchSummaries } from "./PrDescription.js";
import { classifyError, processPrePushInline, processPushPending, triggerPushForNewSummaries } from "./PushExecutor.js";
import { claimForPush, loadPushPending, type PushPendingEntry, updateBatch } from "./PushPendingStore.js";
import { loadConfig } from "./SessionTracker.js";
import { clearSpaceBindingCache, saveSpaceBindingCache } from "./SpaceBindingCache.js";
import { createStorage } from "./StorageFactory.js";
import { getActiveStorage, getIndexEntryMap, getSummary, setActiveStorage } from "./SummaryStore.js";

vi.mock("./SessionTracker.js", () => ({ loadConfig: vi.fn() }));
vi.mock("./SummaryStore.js", () => ({
	getSummary: vi.fn(),
	getIndexEntryMap: vi.fn(),
	getActiveStorage: vi.fn(),
	setActiveStorage: vi.fn(),
}));
vi.mock("./StorageFactory.js", () => ({ createStorage: vi.fn() }));
vi.mock("./GitOps.js", () => ({ execGit: vi.fn(), getCurrentBranch: vi.fn(), getDefaultBranch: vi.fn() }));
vi.mock("./GitRemoteUtils.js", () => ({ getCanonicalRepoUrl: vi.fn() }));
vi.mock("./PrDescription.js", () => ({ loadBranchSummaries: vi.fn() }));
vi.mock("./PushPendingStore.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./PushPendingStore.js")>();
	return { ...actual, loadPushPending: vi.fn(), updateBatch: vi.fn(), claimForPush: vi.fn() };
});
vi.mock("./JolliMemoryPushOrchestrator.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./JolliMemoryPushOrchestrator.js")>();
	return {
		...actual,
		pushSummary: vi.fn(),
		assignOwnedAttachments: vi.fn(),
		buildBatchItems: vi.fn(),
		applyBatchResult: vi.fn(),
	};
});
// Mocked so these tests never touch a real `.jolli/jollimemory/space-binding.json`
// (CWD is a fake path); the cache's own behavior is covered by SpaceBindingCache.test.ts.
vi.mock("./SpaceBindingCache.js", () => ({
	clearSpaceBindingCache: vi.fn(),
	saveSpaceBindingCache: vi.fn(),
}));

const CWD = "/repo";
const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const FAKE_STORAGE = { id: "fake" } as never;

function summary(hash: string, branch = "feature/x"): CommitSummary {
	return {
		commitHash: hash,
		branch,
		generatedAt: "2026-01-01T00:00:00.000Z",
	} as CommitSummary;
}

/** pushBatch mock that succeeds for every item in the payload, per-item docIds 100+. */
function okPushBatch(jmSpace?: { id: number; name: string }) {
	return vi.fn(async (payload: { items: Array<{ commitHash: string }> }) => ({
		results: payload.items.map((item, index) => ({
			commitHash: item.commitHash,
			ok: true,
			summary: {
				docId: 100 + index,
				url: `/articles/doc-${100 + index}`,
				jrn: `jrn:${index}`,
				created: true,
			},
			attachments: [],
		})),
		...(jmSpace !== undefined ? { jmSpace } : {}),
	}));
}

/**
 * Client stub for processPushPending tests. The default pushBatch succeeds for
 * every item; pass an explicit mock to drive failures or capture payloads.
 */
function fakeClient(pushBatch?: ReturnType<typeof vi.fn>) {
	return {
		resolveBaseUrl: vi.fn(async () => "https://acme.jolli.ai"),
		pushBatch: pushBatch ?? okPushBatch(),
	} as never;
}

/** Client stub for the inline batch path — `pushBatch` is injectable per test. */
function fakeBatchClient(pushBatch: ReturnType<typeof vi.fn>) {
	return {
		resolveBaseUrl: vi.fn(async () => "https://acme.jolli.ai"),
		pushBatch,
	} as never;
}

/** Minimal BuiltBatchItem for one summary — mirrors what buildBatchItems produces. */
function builtItem(hash: string, branch = "feature/x"): BuiltBatchItem {
	return {
		item: {
			commitHash: hash,
			branch,
			summary: { title: `t-${hash.substring(0, 4)}`, content: "# body" },
			attachments: [],
		},
		summary: summary(hash, branch),
		attachmentKeys: new Map(),
		batchContentChars: 6,
	};
}

function okBatchResult(...hashes: string[]): BatchPushResult {
	return {
		results: hashes.map((hash, index) => ({
			commitHash: hash,
			ok: true,
			summary: { docId: 100 + index, url: `/articles/doc-${100 + index}`, jrn: `jrn:${index}`, created: true },
			attachments: [],
		})),
	};
}

function entry(retryCount = 0, overrides: Partial<PushPendingEntry> = {}): PushPendingEntry {
	return { branch: "feature/x", enqueuedAt: new Date().toISOString(), retryCount, ...overrides };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(loadConfig).mockResolvedValue({ jolliApiKey: "sk-jol-x" });
	vi.mocked(getActiveStorage).mockReturnValue(FAKE_STORAGE);
	vi.mocked(createStorage).mockResolvedValue(FAKE_STORAGE);
	vi.mocked(getCurrentBranch).mockResolvedValue("feature/x");
	vi.mocked(getDefaultBranch).mockResolvedValue("main");
	vi.mocked(getIndexEntryMap).mockResolvedValue(new Map());
	vi.mocked(execGit).mockResolvedValue({ stdout: "", stderr: "", exitCode: 1 });
	vi.mocked(getCanonicalRepoUrl).mockResolvedValue("https://github.com/acme/repo");
	vi.mocked(getSummary).mockImplementation(async (hash: string) => summary(hash));
	vi.mocked(loadBranchSummaries).mockResolvedValue({
		summaries: [summary(HASH_A), summary(HASH_B)],
		missingCount: 0,
	});
	vi.mocked(assignOwnedAttachments).mockReturnValue({
		ownedPlans: new Map(),
		ownedNotes: new Map(),
		ownedReferences: new Map(),
		seedPlanDocIds: new Map(),
		seedNoteDocIds: new Map(),
		seedReferenceDocIds: new Map(),
	});
	vi.mocked(pushSummary).mockResolvedValue({ summary: summary(HASH_A), summaryUrl: "https://acme.jolli.ai/a" });
	vi.mocked(updateBatch).mockResolvedValue(undefined);
	vi.mocked(buildBatchItems).mockImplementation(async (summaries) => summaries.map((s) => builtItem(s.commitHash)));
	vi.mocked(applyBatchResult).mockResolvedValue({ writtenBack: 0, childSkipped: 0 });
	// Default: every candidate is claimed successfully, and the returned
	// `entries` mirror whatever the current `loadPushPending` mock has been
	// set up to return — so tests that seed a specific retryCount into
	// loadPushPending see the same value on the failure path. Tests that
	// exercise concurrent-claim races override this to return an empty /
	// partial set.
	vi.mocked(claimForPush).mockImplementation(async (cwd, candidates) => {
		const pendingResult = await vi.mocked(loadPushPending)(cwd);
		const pendingEntries = pendingResult.entries;
		return {
			claimed: new Set(candidates),
			entries: Object.fromEntries(candidates.map((h) => [h, pendingEntries[h] ?? entry()])),
		};
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("classifyError", () => {
	it("does not increment retry for config/permanent failures", () => {
		expect(classifyError(new NotAuthenticatedError()).increment).toBe(false);
		expect(classifyError(new PermissionDeniedError()).increment).toBe(false);
		expect(classifyError(new BindingRequiredError("r")).increment).toBe(false);
		expect(classifyError(new ClientOutdatedError()).increment).toBe(false);
	});
	it("labels a permission failure distinctly from not-signed-in", () => {
		expect(classifyError(new PermissionDeniedError()).message).toBe("permission-denied");
		expect(classifyError(new NotAuthenticatedError()).message).toBe("not-authenticated");
	});
	it("increments retry for operational failures", () => {
		const c = classifyError(new Error("ECONNRESET"));
		expect(c.increment).toBe(true);
		expect(c.message).toContain("ECONNRESET");
	});
});

describe("processPushPending", () => {
	it("no-ops with no pending entries", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: {} });
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });
		expect(r.note).toBe("no pending entries");
		expect(pushSummary).not.toHaveBeenCalled();
	});

	it("keeps entries and no-ops when not signed in", async () => {
		vi.mocked(loadConfig).mockResolvedValue({});
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });
		expect(r.note).toBe("not signed in");
		expect(updateBatch).not.toHaveBeenCalled();
	});

	it("skips entries that exhausted the retry budget", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry(3) } });
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });
		expect(r.skippedRetryExhausted).toBe(1);
		expect(pushSummary).not.toHaveBeenCalled();
	});

	it("honors the hashFilter (post-queue path)", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(), [HASH_B]: entry() },
		});
		const pushBatch = okPushBatch();
		await processPushPending(CWD, {
			source: "post-queue",
			hashFilter: new Set([HASH_A]),
			client: fakeClient(pushBatch),
		});
		expect(pushBatch).toHaveBeenCalledTimes(1);
		const payload = pushBatch.mock.calls[0][0] as { items: Array<{ commitHash: string }> };
		expect(payload.items.map((item) => item.commitHash)).toEqual([HASH_A]);
	});

	it("skips candidates whose memory isn't generated yet and releases the claim so the post-queue trigger can re-claim", async () => {
		vi.mocked(getSummary).mockResolvedValue(null);
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });
		expect(r.skippedNoMemory).toBe(1);
		expect(pushSummary).not.toHaveBeenCalled();
		// Empty patch releases claimedAt so QueueWorker's post-drain trigger
		// (triggerPushForNewSummaries) can re-claim once the summary lands.
		expect(updateBatch).toHaveBeenCalledTimes(1);
		const batch = vi.mocked(updateBatch).mock.calls[0][1];
		expect(batch.get(HASH_A)).toEqual({ kind: "patch", patch: {} });
	});

	it("skips tree-hash-resolved summaries (commitHash mismatch) to avoid pushing stale pre-squash content, releasing the claim so the post-queue trigger can re-claim", async () => {
		vi.mocked(getSummary).mockResolvedValue(summary(HASH_B));
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });
		expect(r.skippedNoMemory).toBe(1);
		expect(pushSummary).not.toHaveBeenCalled();
		// Empty patch releases claimedAt — same mechanism as the missing-summary
		// case above. Without it, the immediate post-queue push would be blocked
		// by the still-fresh claimedAt for up to CLAIM_STALE_MS (5 min).
		expect(updateBatch).toHaveBeenCalledTimes(1);
		const batch = vi.mocked(updateBatch).mock.calls[0][1];
		expect(batch.get(HASH_A)).toEqual({ kind: "patch", patch: {} });
	});

	it("pushes a candidate with memory in one batch request and deletes it on success", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const pushBatch = okPushBatch();
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient(pushBatch) });
		expect(r.pushed).toBe(1);
		expect(pushBatch).toHaveBeenCalledTimes(1);
		expect(pushSummary).not.toHaveBeenCalled();
		const batch = vi.mocked(updateBatch).mock.calls[0][1];
		expect(batch.get(HASH_A)).toEqual({ kind: "delete" });
		// Compensation opts into orphan cleanup during write-back.
		expect(applyBatchResult).toHaveBeenCalledWith(expect.any(Array), expect.any(Array), expect.any(Object), {
			cleanupOrphans: true,
		});
	});

	it("keeps a pushed entry pending with the minted ids when its write-back fails", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		vi.mocked(applyBatchResult).mockResolvedValueOnce({
			writtenBack: 0,
			childSkipped: 0,
			writeBackFailures: [{ commitHash: HASH_A, docId: 100, url: "https://acme.jolli.ai/articles/doc-100" }],
		});

		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });

		expect(r.pushed).toBe(1);
		const batch = vi.mocked(updateBatch).mock.calls.at(-1)?.[1];
		expect(batch?.get(HASH_A)).toEqual({
			kind: "patch",
			patch: {
				lastAttemptAt: expect.any(String),
				lastError: "pushed, but persisting the article id locally failed — will retry the write-back",
				pushedDocId: 100,
				pushedUrl: "https://acme.jolli.ai/articles/doc-100",
			},
		});
	});

	it("grafts the recovered docId/url into the individual fallback push", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(0, { pushedDocId: 55, pushedUrl: "https://acme.jolli.ai/articles/doc-55" }) },
		});
		vi.mocked(buildBatchItems).mockImplementation(async (summaries) =>
			summaries.map((s) => ({ ...builtItem(s.commitHash), batchIneligibleReason: "attachment too large" })),
		);

		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });

		expect(r.pushed).toBe(1);
		expect(pushSummary).toHaveBeenCalledTimes(1);
		expect(vi.mocked(pushSummary).mock.calls[0][0]).toMatchObject({
			jolliDocId: 55,
			jolliDocUrl: "https://acme.jolli.ai/articles/doc-55",
		});
	});

	it("chunks more than BATCH_MAX_ITEMS commits into multiple batch requests", async () => {
		const entries: Record<string, PushPendingEntry> = {};
		for (let i = 0; i < BATCH_MAX_ITEMS + 1; i++) {
			entries[`h-${String(i).padStart(3, "0")}`] = entry();
		}
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries });
		const pushBatch = okPushBatch();
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient(pushBatch) });
		expect(pushBatch).toHaveBeenCalledTimes(2);
		expect(r.pushed).toBe(BATCH_MAX_ITEMS + 1);
	});

	it("splits batch requests before their combined content exceeds the server limit", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(), [HASH_B]: entry() },
		});
		const charsPerItem = Math.floor(BATCH_MAX_TOTAL_CONTENT_CHARS / 2) + 1;
		vi.mocked(buildBatchItems).mockResolvedValueOnce([
			{ ...builtItem(HASH_A), batchContentChars: charsPerItem },
			{ ...builtItem(HASH_B), batchContentChars: charsPerItem },
		]);
		const pushBatch = okPushBatch();

		const result = await processPushPending(CWD, { source: "activation", client: fakeClient(pushBatch) });

		expect(result.pushed).toBe(2);
		expect(pushBatch).toHaveBeenCalledTimes(2);
		expect(pushBatch.mock.calls[0][0].items).toHaveLength(1);
		expect(pushBatch.mock.calls[1][0].items).toHaveLength(1);
	});

	it("uses the per-commit path for an item that cannot pass the batch schema", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		vi.mocked(buildBatchItems).mockResolvedValueOnce([
			{ ...builtItem(HASH_A), batchIneligibleReason: "attachment count exceeds the batch limit" },
		]);
		const pushBatch = okPushBatch();

		const result = await processPushPending(CWD, { source: "activation", client: fakeClient(pushBatch) });

		expect(result.pushed).toBe(1);
		expect(pushBatch).not.toHaveBeenCalled();
		expect(pushSummary).toHaveBeenCalledTimes(1);
	});

	it("falls back to per-commit pushSummary when the server lacks batch support", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const pushBatch = vi.fn(async () => {
			throw new BatchUnsupportedError();
		});
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient(pushBatch) });
		expect(pushSummary).toHaveBeenCalledTimes(1);
		expect(r.pushed).toBe(1);
		const batch = vi.mocked(updateBatch).mock.calls[0][1];
		expect(batch.get(HASH_A)).toEqual({ kind: "delete" });
	});

	it("keeps a successful compensation entry pending while orphan cleanup remains", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		vi.mocked(applyBatchResult).mockResolvedValueOnce({
			writtenBack: 1,
			childSkipped: 0,
			cleanupPendingHashes: [HASH_A],
		});

		const result = await processPushPending(CWD, { source: "activation", client: fakeClient() });

		expect(result.pushed).toBe(1);
		const batch = vi.mocked(updateBatch).mock.calls.at(-1)?.[1];
		expect(batch?.get(HASH_A)).toEqual({ kind: "patch", patch: {} });
	});

	it("keeps the raced-away guard on the per-commit fallback path", async () => {
		vi.mocked(loadBranchSummaries).mockResolvedValue({ summaries: [], missingCount: 0 });
		vi.mocked(getSummary)
			.mockResolvedValueOnce(summary(HASH_A)) // memory check
			.mockResolvedValueOnce(null); // fallback pushOne re-read
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const pushBatch = vi.fn(async () => {
			throw new BatchUnsupportedError();
		});
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient(pushBatch) });
		expect(r.failed).toBe(1);
		expect(pushSummary).not.toHaveBeenCalled();
		const batch = vi.mocked(updateBatch).mock.calls[0][1];
		expect(batch.get(HASH_A)).toEqual({ kind: "delete" });
	});

	it("persists the server's Space echo as the binding cache after a successful individual push", async () => {
		// Only the per-commit fallback carries the echo — batch responses have none.
		vi.mocked(pushSummary).mockResolvedValue({
			summary: summary(HASH_A),
			summaryUrl: "https://acme.jolli.ai/a",
			jmSpace: { id: 7, name: "Acme Core" },
		});
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const pushBatch = vi.fn(async () => {
			throw new BatchUnsupportedError();
		});

		await processPushPending(CWD, { source: "activation", client: fakeClient(pushBatch) });

		expect(saveSpaceBindingCache).toHaveBeenCalledWith(CWD, {
			repoUrl: "https://github.com/acme/repo",
			origin: "https://acme.jolli.ai",
			jmSpaceId: 7,
			spaceName: "Acme Core",
			canPush: true,
		});
	});

	it("leaves the binding cache untouched when the server echoes no Space (older server)", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const pushBatch = vi.fn(async () => {
			throw new BatchUnsupportedError();
		});

		await processPushPending(CWD, { source: "activation", client: fakeClient(pushBatch) });

		expect(saveSpaceBindingCache).not.toHaveBeenCalled();
		expect(clearSpaceBindingCache).not.toHaveBeenCalled();
	});

	it("leaves the binding cache untouched after a successful batch push with no Space echo (older server)", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });

		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });

		expect(r.pushed).toBe(1);
		expect(saveSpaceBindingCache).not.toHaveBeenCalled();
		expect(clearSpaceBindingCache).not.toHaveBeenCalled();
	});

	it("persists the batch top-level Space echo as the binding cache", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });

		const r = await processPushPending(CWD, {
			source: "activation",
			client: fakeClient(okPushBatch({ id: 7, name: "Acme Core" })),
		});

		expect(r.pushed).toBe(1);
		expect(saveSpaceBindingCache).toHaveBeenCalledWith(CWD, {
			repoUrl: "https://github.com/acme/repo",
			origin: "https://acme.jolli.ai",
			jmSpaceId: 7,
			spaceName: "Acme Core",
			canPush: true,
		});
	});

	it("clears the binding cache when a batch push is rejected with binding_required", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const pushBatch = vi.fn(async () => {
			throw new BindingRequiredError("https://github.com/acme/repo");
		});

		const r = await processPushPending(CWD, { source: "activation", client: fakeClient(pushBatch) });

		expect(r.failed).toBe(1);
		expect(clearSpaceBindingCache).toHaveBeenCalledWith(CWD);
		expect(saveSpaceBindingCache).not.toHaveBeenCalled();
		// The 412 stays a held (non-counted) retry, exactly as before the cache.
		const batch = vi.mocked(updateBatch).mock.calls[0][1];
		expect(batch.get(HASH_A)).toMatchObject({ kind: "patch", patch: { lastError: "binding-required" } });
	});

	it("clears the binding cache when a batch push is rejected with permission denied", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const pushBatch = vi.fn(async () => {
			throw new PermissionDeniedError();
		});

		await processPushPending(CWD, { source: "activation", client: fakeClient(pushBatch) });

		expect(clearSpaceBindingCache).toHaveBeenCalledWith(CWD);
	});

	it("clears the binding cache when an individual push is rejected as unauthenticated", async () => {
		vi.mocked(pushSummary).mockRejectedValue(new NotAuthenticatedError());
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const pushBatch = vi.fn(async () => {
			throw new BatchUnsupportedError();
		});

		await processPushPending(CWD, { source: "activation", client: fakeClient(pushBatch) });

		expect(clearSpaceBindingCache).toHaveBeenCalledWith(CWD);
	});

	it("does not clear the binding cache on an operational (network) failure", async () => {
		vi.mocked(pushSummary).mockRejectedValue(new Error("ECONNRESET"));
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const pushBatch = vi.fn(async () => {
			throw new BatchUnsupportedError();
		});

		await processPushPending(CWD, { source: "activation", client: fakeClient(pushBatch) });

		expect(clearSpaceBindingCache).not.toHaveBeenCalled();
	});

	it("waits for remote confirmation before publishing a newly pushed commit", async () => {
		const remoteRef = "refs/heads/feature/x";
		const pushUrl = "ssh://git@example.com/acme/repo.git";
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "remote") return { stdout: `${pushUrl}\n`, stderr: "", exitCode: 0 };
			return { stdout: `${HASH_A}\t${remoteRef}\n`, stderr: "", exitCode: 0 };
		});
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: {
				[HASH_A]: entry(0, { pushTargets: [{ remote: "origin", remoteRef, localSha: HASH_A }] }),
			},
		});

		const pushBatch = okPushBatch();
		const result = await processPushPending(CWD, { source: "activation", client: fakeClient(pushBatch) });

		expect(result.pushed).toBe(1);
		expect(execGit).toHaveBeenCalledWith(["ls-remote", "--refs", pushUrl, remoteRef], CWD);
		expect(pushBatch).toHaveBeenCalledTimes(1);
	});

	it("keeps the entry when the remote ref does not contain the pushed SHA", async () => {
		const remoteRef = "refs/heads/feature/x";
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "remote") return { stdout: "origin\n", stderr: "", exitCode: 0 };
			if (args[0] === "ls-remote") return { stdout: `${HASH_B}\t${remoteRef}\n`, stderr: "", exitCode: 0 };
			return { stdout: "", stderr: "", exitCode: 1 };
		});
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: {
				[HASH_A]: entry(0, { pushTargets: [{ remote: "origin", remoteRef, localSha: HASH_A }] }),
			},
		});

		const result = await processPushPending(CWD, { source: "activation", client: fakeClient() });

		expect(result.note).toBe("push not confirmed");
		expect(pushSummary).not.toHaveBeenCalled();
		expect(updateBatch).not.toHaveBeenCalled();
	});

	it("accepts a pushed SHA that is an ancestor of a later remote tip", async () => {
		const remoteRef = "refs/heads/feature/x";
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "remote") return { stdout: "", stderr: "unknown remote", exitCode: 2 };
			if (args[0] === "ls-remote") return { stdout: `${HASH_B}\t${remoteRef}\n`, stderr: "", exitCode: 0 };
			return { stdout: "", stderr: "", exitCode: 0 };
		});
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: {
				[HASH_A]: entry(0, { pushTargets: [{ remote: "origin", remoteRef, localSha: HASH_A }] }),
			},
		});

		const result = await processPushPending(CWD, { source: "activation", client: fakeClient() });

		expect(result.pushed).toBe(1);
		expect(execGit).toHaveBeenCalledWith(["ls-remote", "--refs", "origin", remoteRef], CWD);
		expect(execGit).toHaveBeenCalledWith(["merge-base", "--is-ancestor", HASH_A, HASH_B], CWD);
	});

	it("keeps the entry when the remote ref cannot be queried", async () => {
		const remoteRef = "refs/heads/feature/x";
		vi.mocked(execGit).mockResolvedValue({ stdout: "", stderr: "offline", exitCode: 1 });
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: {
				[HASH_A]: entry(0, { pushTargets: [{ remote: "origin", remoteRef, localSha: HASH_A }] }),
			},
		});

		const result = await processPushPending(CWD, { source: "activation", client: fakeClient() });

		expect(result.note).toBe("push not confirmed");
		expect(pushSummary).not.toHaveBeenCalled();
	});

	it("passes owned attachments into the batch build (cross-commit dedup)", async () => {
		vi.mocked(assignOwnedAttachments).mockReturnValue({
			ownedPlans: new Map([[HASH_A, [{ slug: "p-1234abcd" }]]]) as never,
			ownedNotes: new Map(),
			ownedReferences: new Map(),
			seedPlanDocIds: new Map(),
			seedNoteDocIds: new Map(),
			seedReferenceDocIds: new Map(),
		});
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		await processPushPending(CWD, { source: "activation", client: fakeClient() });
		const ownership = vi.mocked(buildBatchItems).mock.calls[0][1];
		expect(ownership.ownedPlans.get(HASH_A)).toHaveLength(1);
	});

	it("builds attachment ownership from an off-current branch context", async () => {
		const offBranch = "feature/off-current";
		const offSummary = summary(HASH_A, offBranch);
		vi.mocked(getSummary).mockResolvedValue(offSummary);
		vi.mocked(getIndexEntryMap).mockResolvedValue(
			new Map([
				[
					HASH_A,
					{
						commitHash: HASH_A,
						parentCommitHash: null,
						branch: offBranch,
						commitMessage: "off branch",
						commitDate: "2026-01-01T00:00:00.000Z",
						generatedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			]),
		);
		vi.mocked(assignOwnedAttachments).mockReturnValue({
			ownedPlans: new Map([[HASH_A, [{ slug: "off-plan" }]]]) as never,
			ownedNotes: new Map(),
			ownedReferences: new Map(),
			seedPlanDocIds: new Map(),
			seedNoteDocIds: new Map(),
			seedReferenceDocIds: new Map(),
		});
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(0, { branch: offBranch }) },
		});

		await processPushPending(CWD, { source: "activation", client: fakeClient() });

		expect(assignOwnedAttachments).toHaveBeenCalledWith([offSummary]);
		const ownership = vi.mocked(buildBatchItems).mock.calls[0][1];
		expect(ownership.ownedPlans.get(HASH_A)).toHaveLength(1);
	});

	it("increments retryCount when the batch request fails operationally", async () => {
		const pushBatch = vi.fn(async () => {
			throw new Error("network down");
		});
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry(1) } });
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient(pushBatch) });
		expect(r.failed).toBe(1);
		const batch = vi.mocked(updateBatch).mock.calls[0][1];
		const update = batch.get(HASH_A);
		expect(update).toMatchObject({ kind: "patch" });
		if (update?.kind === "patch") {
			expect(update.patch.retryCount).toBe(2);
			expect(update.patch.lastError).toContain("network down");
		}
	});

	it("does NOT increment retryCount on NotAuthenticated mid-push", async () => {
		const pushBatch = vi.fn(async () => {
			throw new NotAuthenticatedError();
		});
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry(1) } });
		await processPushPending(CWD, { source: "activation", client: fakeClient(pushBatch) });
		const batch = vi.mocked(updateBatch).mock.calls[0][1];
		const update = batch.get(HASH_A);
		if (update?.kind === "patch") {
			expect(update.patch.retryCount).toBeUndefined();
			expect(update.patch.lastError).toBe("not-authenticated");
		}
	});

	it("records a per-item batch failure with a counted retry", async () => {
		const pushBatch = vi.fn(async () => ({
			results: [{ commitHash: HASH_A, ok: false, attachments: [], error: "boom", errorCode: "push_failed" }],
		}));
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry(1) } });
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient(pushBatch) });
		expect(r.failed).toBe(1);
		const batch = vi.mocked(updateBatch).mock.calls[0][1];
		const update = batch.get(HASH_A);
		if (update?.kind === "patch") {
			expect(update.patch.retryCount).toBe(2);
			expect(update.patch.lastError).toBe("boom");
		}
	});

	it("creates storage when none is active", async () => {
		vi.mocked(getActiveStorage).mockReturnValue(undefined);
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		await processPushPending(CWD, { source: "activation", client: fakeClient() });
		expect(createStorage).toHaveBeenCalledWith(CWD, CWD);
		expect(setActiveStorage).toHaveBeenCalled();
	});

	it("skips all entries when syncOnPush is disabled (not just the pre-push hook path)", async () => {
		vi.mocked(loadConfig).mockResolvedValue({ jolliApiKey: "sk-jol-x", syncOnPush: false });
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });
		expect(r.note).toBe("syncOnPush disabled");
		expect(pushSummary).not.toHaveBeenCalled();
		expect(updateBatch).not.toHaveBeenCalled();
	});

	it("deletes (does not push) a pending entry whose commit is now a child in the index", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		vi.mocked(getIndexEntryMap).mockResolvedValue(
			new Map([
				[
					HASH_A,
					{
						commitHash: HASH_A,
						parentCommitHash: HASH_B,
						commitMessage: "",
						commitDate: "",
						branch: "feature/x",
						generatedAt: "",
					},
				],
			]),
		);
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });
		expect(pushSummary).not.toHaveBeenCalled();
		const batch = vi.mocked(updateBatch).mock.calls[0][1];
		expect(batch.get(HASH_A)).toEqual({ kind: "delete" });
		expect(r.note).toBe("all candidates were merged children");
		expect(r.deletedChildren).toBe(1);
	});

	it("skips entries a concurrent process already claimed", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(), [HASH_B]: entry() },
		});
		// Concurrent process already claimed HASH_A; we only get HASH_B.
		vi.mocked(claimForPush).mockResolvedValue({
			claimed: new Set([HASH_B]),
			entries: { [HASH_B]: entry() },
		});
		const pushBatch = okPushBatch();
		await processPushPending(CWD, { source: "activation", client: fakeClient(pushBatch) });
		expect(pushBatch).toHaveBeenCalledTimes(1);
		const payload = pushBatch.mock.calls[0][0] as { items: Array<{ commitHash: string }> };
		expect(payload.items.map((item) => item.commitHash)).toEqual([HASH_B]);
	});

	it("returns early when every candidate was already claimed by another process", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		vi.mocked(claimForPush).mockResolvedValue({ claimed: new Set(), entries: {} });
		const pushBatch = okPushBatch();
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient(pushBatch) });
		expect(r.note).toBe("all entries claimed by another process");
		expect(pushBatch).not.toHaveBeenCalled();
	});
});

describe("processPrePushInline", () => {
	const farDeadline = () => Date.now() + 60_000;

	it("no-ops with no pending entries", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: {} });
		const r = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(vi.fn()),
		});
		expect(r.note).toBe("no pending entries");
		expect(claimForPush).not.toHaveBeenCalled();
	});

	it("keeps entries untouched when syncOnPush is disabled", async () => {
		vi.mocked(loadConfig).mockResolvedValue({ jolliApiKey: "sk-jol-x", syncOnPush: false });
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const r = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(vi.fn()),
		});
		expect(r.note).toBe("syncOnPush disabled");
		expect(updateBatch).not.toHaveBeenCalled();
	});

	it("keeps entries untouched when not signed in", async () => {
		vi.mocked(loadConfig).mockResolvedValue({});
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const r = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(vi.fn()),
		});
		expect(r.note).toBe("not signed in");
		expect(updateBatch).not.toHaveBeenCalled();
	});

	it("marks retry-exhausted entries as failed in the result list", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry(3) } });
		const r = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(vi.fn()),
		});
		expect(r.skippedRetryExhausted).toBe(1);
		expect(r.note).toBe("no eligible entries");
		expect(r.commits).toEqual([{ hash: HASH_A, status: "failed", reason: "failed repeatedly — giving up" }]);
	});

	it("claims ONLY this push's commits — leftover entries stay for the compensation channels", async () => {
		const leftover = "c".repeat(40);
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [leftover]: entry(), [HASH_A]: entry() },
		});
		const pushBatch = vi.fn(async () => okBatchResult(HASH_A));
		const r = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(pushBatch),
		});
		expect(claimForPush).toHaveBeenCalledWith(CWD, [HASH_A]);
		expect(r.commits.map((c) => c.hash)).toEqual([HASH_A]);
	});

	it("caps the candidate list at BATCH_MAX_ITEMS and defers the overflow", async () => {
		const hashes = Array.from({ length: BATCH_MAX_ITEMS + 5 }, (_, i) => `hash-${String(i).padStart(3, "0")}`);
		const entries: Record<string, PushPendingEntry> = {};
		for (const hash of hashes) entries[hash] = entry();
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries });
		const pushBatch = vi.fn(async () => ({ results: [] }));
		const r = await processPrePushInline(CWD, {
			priorityHashes: hashes,
			deadlineAt: farDeadline(),
			client: fakeBatchClient(pushBatch),
		});
		const candidates = vi.mocked(claimForPush).mock.calls[0][1];
		expect(candidates).toHaveLength(BATCH_MAX_ITEMS);
		expect(r.commits.filter((c) => c.status === "deferred")).toHaveLength(5);
	});

	it("returns early when every candidate was already claimed by another process", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		vi.mocked(claimForPush).mockResolvedValue({ claimed: new Set(), entries: {} });
		const r = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(vi.fn()),
		});
		expect(r.note).toBe("all entries claimed by another process");
	});

	it("releases claims and reports notAttempted when the budget is already exhausted", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const pushBatch = vi.fn();
		const r = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: Date.now() - 1,
			client: fakeBatchClient(pushBatch),
		});
		expect(r.notAttempted).toBe(1);
		expect(r.note).toBe("budget exhausted");
		expect(pushBatch).not.toHaveBeenCalled();
		expect(r.commits).toEqual([{ hash: HASH_A, status: "deferred", reason: "timed out — will sync later" }]);
		const batch = vi.mocked(updateBatch).mock.calls[0][1];
		expect(batch.get(HASH_A)).toEqual({ kind: "patch", patch: {} });
	});

	it("releases no-memory candidates and deletes merged children before the batch", async () => {
		const child = "e".repeat(40);
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(), [child]: entry() },
		});
		vi.mocked(getIndexEntryMap).mockResolvedValue(
			new Map([
				[
					child,
					{
						commitHash: child,
						parentCommitHash: HASH_B,
						commitMessage: "",
						commitDate: "",
						branch: "feature/x",
						generatedAt: "",
					},
				],
			]),
		);
		vi.mocked(getSummary).mockResolvedValue(null);
		const r = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A, child],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(vi.fn()),
		});
		expect(r.skippedNoMemory).toBe(1);
		expect(r.deletedChildren).toBe(1);
		expect(r.note).toBe("no candidates with memory");
		expect(r.commits).toEqual([
			{ hash: HASH_A, status: "generating", reason: "memory still generating — will sync later" },
			{ hash: child, status: "merged", reason: "merged into another commit's memory" },
		]);
		const batch = vi.mocked(updateBatch).mock.calls[0][1];
		expect(batch.get(HASH_A)).toEqual({ kind: "patch", patch: {} });
		expect(batch.get(child)).toEqual({ kind: "delete" });
	});

	it("pushes with-memory candidates in one batch, deletes successes, and writes back", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(), [HASH_B]: entry() },
		});
		const pushBatch = vi.fn(async (_payload: unknown) => okBatchResult(HASH_A, HASH_B));
		const r = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A, HASH_B],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(pushBatch),
		});
		expect(r.pushed).toBe(2);
		expect(r.failed).toBe(0);
		expect(pushBatch).toHaveBeenCalledTimes(1);
		const payload = pushBatch.mock.calls[0][0] as { repoUrl?: string; items: Array<{ commitHash: string }> };
		expect(payload.repoUrl).toBe("https://github.com/acme/repo");
		expect(payload.items.map((i) => i.commitHash).sort()).toEqual([HASH_A, HASH_B]);
		const batch = vi.mocked(updateBatch).mock.calls.at(-1)?.[1];
		expect(batch?.get(HASH_A)).toEqual({ kind: "delete" });
		expect(batch?.get(HASH_B)).toEqual({ kind: "delete" });
		expect(applyBatchResult).toHaveBeenCalledTimes(1);
		// Per-commit outcomes carry the resolved absolute article URLs, in push order.
		expect(r.commits).toEqual([
			{ hash: HASH_A, status: "pushed", url: "https://acme.jolli.ai/articles/doc-100" },
			{ hash: HASH_B, status: "pushed", url: "https://acme.jolli.ai/articles/doc-101" },
		]);
	});

	it("persists the batch top-level Space echo as the binding cache", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const pushBatch = vi.fn(async () => ({ ...okBatchResult(HASH_A), jmSpace: { id: 7, name: "Acme Core" } }));

		await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(pushBatch),
		});

		expect(saveSpaceBindingCache).toHaveBeenCalledWith(CWD, {
			repoUrl: "https://github.com/acme/repo",
			origin: "https://acme.jolli.ai",
			jmSpaceId: 7,
			spaceName: "Acme Core",
			canPush: true,
		});
	});

	it("leaves the binding cache untouched when the batch echoes no Space (older server)", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const pushBatch = vi.fn(async () => okBatchResult(HASH_A));

		await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(pushBatch),
		});

		expect(saveSpaceBindingCache).not.toHaveBeenCalled();
		expect(clearSpaceBindingCache).not.toHaveBeenCalled();
	});

	it("defers inline overflow beyond the server's total-content limit", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(), [HASH_B]: entry() },
		});
		vi.mocked(buildBatchItems).mockResolvedValueOnce([
			{ ...builtItem(HASH_A), batchContentChars: BATCH_MAX_TOTAL_CONTENT_CHARS - 1 },
			builtItem(HASH_B),
		]);
		const pushBatch = vi.fn(async (_payload: BatchPushPayload) => okBatchResult(HASH_A));

		const result = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A, HASH_B],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(pushBatch),
		});

		expect(result.pushed).toBe(1);
		expect(result.notAttempted).toBe(1);
		expect(pushBatch).toHaveBeenCalledTimes(1);
		expect(pushBatch.mock.calls[0][0].items.map((item: { commitHash: string }) => item.commitHash)).toEqual([
			HASH_A,
		]);
		const updateCalls = vi.mocked(updateBatch).mock.calls;
		expect(updateCalls.at(-1)?.[1].get(HASH_A)).toEqual({ kind: "delete" });
		const releasedOverflow = updateCalls.find((call) => call[1].has(HASH_B))?.[1];
		expect(releasedOverflow?.get(HASH_B)).toEqual({ kind: "patch", patch: {} });
		expect(result.commits[1]).toEqual({
			hash: HASH_B,
			status: "deferred",
			reason: "batch content limit reached — will sync later",
		});
	});

	it("keeps an inline success pending when confirmed orphan cleanup is still required", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		vi.mocked(applyBatchResult).mockResolvedValueOnce({
			writtenBack: 1,
			childSkipped: 0,
			cleanupPendingHashes: [HASH_A],
		});

		const result = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(vi.fn(async () => okBatchResult(HASH_A))),
		});

		expect(result.pushed).toBe(1);
		const batch = vi.mocked(updateBatch).mock.calls.at(-1)?.[1];
		expect(batch?.get(HASH_A)).toEqual({ kind: "patch", patch: {} });
	});

	it("keeps an inline success pending with the minted ids when its write-back fails", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		vi.mocked(applyBatchResult).mockResolvedValueOnce({
			writtenBack: 0,
			childSkipped: 0,
			writeBackFailures: [{ commitHash: HASH_A, docId: 100, url: "https://acme.jolli.ai/articles/doc-100" }],
		});

		const result = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(vi.fn(async () => okBatchResult(HASH_A))),
		});

		// The push itself succeeded — the commit still reports as pushed.
		expect(result.pushed).toBe(1);
		const batch = vi.mocked(updateBatch).mock.calls.at(-1)?.[1];
		expect(batch?.get(HASH_A)).toEqual({
			kind: "patch",
			patch: {
				lastAttemptAt: expect.any(String),
				lastError: "pushed, but persisting the article id locally failed — will retry the write-back",
				pushedDocId: 100,
				pushedUrl: "https://acme.jolli.ai/articles/doc-100",
			},
		});
	});

	it("grafts the recovered docId/url from the pending entry into the batch build", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(0, { pushedDocId: 55, pushedUrl: "https://acme.jolli.ai/articles/doc-55" }) },
		});

		await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(vi.fn(async () => okBatchResult(HASH_A))),
		});

		const builtSummaries = vi.mocked(buildBatchItems).mock.calls[0][0];
		expect(builtSummaries[0]).toMatchObject({
			jolliDocId: 55,
			jolliDocUrl: "https://acme.jolli.ai/articles/doc-55",
		});
	});

	it("never overrides a summary's own docId with the recovered one", async () => {
		vi.mocked(getSummary).mockImplementation(async (hash: string) => ({
			...summary(hash),
			jolliDocId: 7,
			jolliDocUrl: "https://acme.jolli.ai/articles/doc-7",
		}));
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(0, { pushedDocId: 55, pushedUrl: "https://acme.jolli.ai/articles/doc-55" }) },
		});

		await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(vi.fn(async () => okBatchResult(HASH_A))),
		});

		const builtSummaries = vi.mocked(buildBatchItems).mock.calls[0][0];
		expect(builtSummaries[0]).toMatchObject({ jolliDocId: 7, jolliDocUrl: "https://acme.jolli.ai/articles/doc-7" });
	});

	it("records a per-item failure with a counted retry while the rest succeed", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(1), [HASH_B]: entry() },
		});
		const pushBatch = vi.fn(async () => ({
			results: [
				{ commitHash: HASH_A, ok: false, attachments: [], error: "boom", errorCode: "push_failed" },
				...okBatchResult(HASH_B).results,
			],
		}));
		const r = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A, HASH_B],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(pushBatch),
		});
		expect(r.pushed).toBe(1);
		expect(r.failed).toBe(1);
		const batch = vi.mocked(updateBatch).mock.calls.at(-1)?.[1];
		const update = batch?.get(HASH_A);
		expect(update).toMatchObject({ kind: "patch" });
		if (update?.kind === "patch") {
			expect(update.patch.retryCount).toBe(2);
			expect(update.patch.lastError).toBe("boom");
		}
		expect(batch?.get(HASH_B)).toEqual({ kind: "delete" });
		expect(r.commits).toEqual([
			{ hash: HASH_A, status: "failed", reason: "boom" },
			{ hash: HASH_B, status: "pushed", url: "https://acme.jolli.ai/articles/doc-100" },
		]);
	});

	it("marks a hash missing from the response as failed", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const pushBatch = vi.fn(async () => ({ results: [] }));
		const r = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(pushBatch),
		});
		expect(r.failed).toBe(1);
		const batch = vi.mocked(updateBatch).mock.calls.at(-1)?.[1];
		const update = batch?.get(HASH_A);
		if (update?.kind === "patch") {
			expect(update.patch.lastError).toBe("missing batch result");
		}
		expect(r.commits).toEqual([{ hash: HASH_A, status: "failed", reason: "missing batch result" }]);
	});

	it("counts the retry on a whole-request operational failure", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry(1) } });
		const pushBatch = vi.fn(async () => {
			throw new Error("network down");
		});
		const r = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(pushBatch),
		});
		expect(r.failed).toBe(1);
		const batch = vi.mocked(updateBatch).mock.calls.at(-1)?.[1];
		const update = batch?.get(HASH_A);
		if (update?.kind === "patch") {
			expect(update.patch.retryCount).toBe(2);
			expect(update.patch.lastError).toContain("network down");
		}
		expect(r.commits).toEqual([{ hash: HASH_A, status: "failed", reason: "network down" }]);
	});

	it("holds the retry count on a whole-request config failure (not signed in mid-flight)", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry(1) } });
		const pushBatch = vi.fn(async () => {
			throw new NotAuthenticatedError();
		});
		const r = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(pushBatch),
		});
		const batch = vi.mocked(updateBatch).mock.calls.at(-1)?.[1];
		const update = batch?.get(HASH_A);
		if (update?.kind === "patch") {
			expect(update.patch.retryCount).toBeUndefined();
			expect(update.patch.lastError).toBe("not-authenticated");
		}
		// The result list shows the friendly wording, not the raw error code.
		expect(r.commits).toEqual([{ hash: HASH_A, status: "failed", reason: "not signed in to Jolli" }]);
		// The server just contradicted any cached binding — the inline drain drops it too.
		expect(clearSpaceBindingCache).toHaveBeenCalledWith(CWD);
	});

	it("labels a space-permission failure distinctly in the result list (no retry burn)", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry(1) } });
		const pushBatch = vi.fn(async () => {
			throw new PermissionDeniedError("Insufficient space permissions");
		});
		const r = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(pushBatch),
		});
		expect(r.commits).toEqual([
			{ hash: HASH_A, status: "failed", reason: "no permission to write to the bound Jolli Space" },
		]);
		const batch = vi.mocked(updateBatch).mock.calls.at(-1)?.[1];
		const update = batch?.get(HASH_A);
		if (update?.kind === "patch") {
			expect(update.patch.retryCount).toBeUndefined();
			expect(update.patch.lastError).toBe("permission-denied");
		}
		// A 403 also invalidates the cached binding (canPush flipped server-side).
		expect(clearSpaceBindingCache).toHaveBeenCalledWith(CWD);
	});

	it("releases claims without retry burn when the server lacks batch support", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const pushBatch = vi.fn(async () => {
			throw new BatchUnsupportedError();
		});
		const r = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(pushBatch),
		});
		expect(r.notAttempted).toBe(1);
		expect(r.note).toBe("server lacks batch support");
		expect(r.commits).toEqual([
			{ hash: HASH_A, status: "deferred", reason: "server does not support batch push yet" },
		]);
		const batch = vi.mocked(updateBatch).mock.calls.at(-1)?.[1];
		expect(batch?.get(HASH_A)).toEqual({ kind: "patch", patch: {} });
	});

	it("releases claims without retry burn when the request aborts at the deadline", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const abortError = new Error("This operation was aborted");
		abortError.name = "AbortError";
		const pushBatch = vi.fn(async () => {
			throw abortError;
		});
		const r = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(pushBatch),
		});
		expect(r.notAttempted).toBe(1);
		expect(r.note).toBe("deadline exceeded");
		expect(r.commits).toEqual([{ hash: HASH_A, status: "deferred", reason: "timed out — will sync later" }]);
		const batch = vi.mocked(updateBatch).mock.calls.at(-1)?.[1];
		expect(batch?.get(HASH_A)).toEqual({ kind: "patch", patch: {} });
	});

	it("marks entries claimed by a concurrent process as deferred in the result list", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		vi.mocked(claimForPush).mockResolvedValue({ claimed: new Set(), entries: {} });
		const r = await processPrePushInline(CWD, {
			priorityHashes: [HASH_A],
			deadlineAt: farDeadline(),
			client: fakeBatchClient(vi.fn()),
		});
		expect(r.note).toBe("all entries claimed by another process");
		expect(r.commits).toEqual([
			{ hash: HASH_A, status: "deferred", reason: "another sync is already handling this commit" },
		]);
	});
});

describe("triggerPushForNewSummaries", () => {
	it("no-ops on an empty hash list", () => {
		triggerPushForNewSummaries(CWD, []);
		// nothing scheduled — loadPushPending never called
		expect(loadPushPending).not.toHaveBeenCalled();
	});

	it("schedules a post-queue drain filtered to the given hashes", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		triggerPushForNewSummaries(CWD, [HASH_A]);
		// setImmediate → wait a tick
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		expect(loadPushPending).toHaveBeenCalled();
	});
});
