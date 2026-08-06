import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary } from "../Types.js";
import { execGit, getCurrentBranch, getDefaultBranch } from "./GitOps.js";
import { getCanonicalRepoUrl } from "./GitRemoteUtils.js";
import {
	BindingRequiredError,
	ClientOutdatedError,
	NotAuthenticatedError,
	PermissionDeniedError,
} from "./JolliMemoryPushClient.js";
import { pushSummary } from "./JolliMemoryPushOrchestrator.js";
import { loadBranchSummaries } from "./PrDescription.js";
import { isOutboundPushAllowed } from "./PushControl.js";
import {
	type CommitPushOutcome,
	classifyError,
	processPushPending,
	triggerPushForNewSummaries,
} from "./PushExecutor.js";
import { claimForPush, loadPushPending, type PushPendingEntry, updateBatch } from "./PushPendingStore.js";
import { assignOwnedContext, type ContextSelection } from "./push/ContextPush.js";
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
// Spreads the real module on purpose: `classifyError` and the per-commit catch
// construct/branch on the REAL `PushDisabledError`. A bare factory omitting it
// makes the binding `undefined`, so `instanceof` throws a TypeError that the
// surrounding catch swallows — a missing mock entry becoming silently wrong
// control flow rather than a visible failure.
vi.mock("./PushControl.js", async (orig) => ({
	...(await orig<typeof import("./PushControl.js")>()),
	isOutboundPushAllowed: vi.fn(),
}));
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
	};
});
// Ownership is now computed by the generic context-kind engine, so that is what
// these tests drive. `selectionForCommit` stays REAL: it is the pure projection of
// whatever ownership we inject, and stubbing it would test nothing.
vi.mock("./push/ContextPush.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./push/ContextPush.js")>()),
	assignOwnedContext: vi.fn(),
}));
// Mocked so these tests never touch a real `.jolli/jollimemory/space-binding.json`
// (CWD is a fake path); the cache's own behavior is covered by SpaceBindingCache.test.ts.
vi.mock("./SpaceBindingCache.js", () => ({
	clearSpaceBindingCache: vi.fn(),
	saveSpaceBindingCache: vi.fn(),
}));

const CWD = "/repo";
/** The stamp `claimForPush` returns — the heartbeat's compare-and-swap token. */
const CLAIMED_AT = "2026-01-01T00:00:00.000Z";
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

/**
 * Client stub for processPushPending tests. Uploads go through the mocked
 * `pushSummary`, so the client only has to resolve a base URL.
 */
function fakeClient() {
	return { resolveBaseUrl: vi.fn(async () => "https://acme.jolli.ai") } as never;
}

/** A successful `pushSummary` result for `hash`, optionally carrying extra flags. */
function pushed(hash: string, extra: Record<string, unknown> = {}) {
	return {
		summary: summary(hash),
		summaryUrl: `https://acme.jolli.ai/articles/doc-${hash.substring(0, 4)}`,
		docId: 100,
		...extra,
	} as never;
}

/**
 * Every entry update this run committed, merged across calls. Accounting is
 * persisted per commit AS IT SETTLES, so no single `updateBatch` call holds the
 * whole ledger — asserting on one of them only sees a fragment.
 */
function flushedUpdates() {
	return new Map(vi.mocked(updateBatch).mock.calls.flatMap((call) => [...call[1]]));
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
	vi.mocked(isOutboundPushAllowed).mockResolvedValue(true);
	vi.mocked(getSummary).mockImplementation(async (hash: string) => summary(hash));
	vi.mocked(loadBranchSummaries).mockResolvedValue({
		summaries: [summary(HASH_A), summary(HASH_B)],
		missingCount: 0,
	});
	vi.mocked(assignOwnedContext).mockReturnValue(new Map());
	vi.mocked(pushSummary).mockResolvedValue({
		summary: summary(HASH_A),
		summaryUrl: "https://acme.jolli.ai/a",
		docId: 1,
	});
	vi.mocked(updateBatch).mockResolvedValue(undefined);
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
			claimedAt: CLAIMED_AT,
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

	it("keeps entries and no-ops when push is disabled for the repo (Story 2)", async () => {
		vi.mocked(isOutboundPushAllowed).mockResolvedValue(false);
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });
		expect(r.note).toBe("push disabled for this repo");
		expect(pushSummary).not.toHaveBeenCalled();
		expect(updateBatch).not.toHaveBeenCalled();
	});

	// The entry gate runs once, before the loop. A toggle DURING the drain must stop
	// the remaining sends too — VS Code re-checks inside its HTTP client and IntelliJ
	// inside the bridge, and this is the native CLI's equivalent. Critically the held
	// entry must stay pending with no attempt recorded: marking it failed (or burning a
	// retry) would punish the user for their own setting and could exhaust the budget.
	it("holds the remaining entries — no failure, no retry burn — when disabled mid-drain (Story 2)", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(), [HASH_B]: entry() },
		});
		// Allowed at the drain's entry gate, revoked before any per-commit send.
		vi.mocked(isOutboundPushAllowed).mockResolvedValueOnce(true).mockResolvedValue(false);

		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });

		expect(pushSummary).not.toHaveBeenCalled();
		expect(r.failed).toBe(0);
		// Every patch written is claim-release-ONLY (`patch: {}`). An empty patch is
		// what distinguishes "held" from "failed": `updateBatch` clears `claimedAt` and
		// touches nothing else, so no `lastError` is recorded and no retry is burned.
		const patches = vi
			.mocked(updateBatch)
			.mock.calls.flatMap(([, updates]) => [...updates.values()])
			.filter((u) => u.kind === "patch");
		expect(patches).toEqual([
			{ kind: "patch", patch: {} },
			{ kind: "patch", patch: {} },
		]);
	});

	// Regression: the claim release above is not cosmetic. `applyPushDisabled` fires the
	// re-enable drain the moment the user toggles push back on, and that drain is ONE
	// detached pass with no retry of its own — so a claim this run left behind makes
	// `claimForPush` skip the entry (claims are honoured for CLAIM_STALE_MS = 5 min) and
	// the backlog sits until some unrelated later trigger. The mirror site in
	// Releasing here is what makes the re-enable drain immediate.
	it("releases the claim on every held entry so the re-enable drain can re-claim immediately", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(), [HASH_B]: entry() },
		});
		vi.mocked(isOutboundPushAllowed).mockResolvedValueOnce(true).mockResolvedValue(false);

		await processPushPending(CWD, { source: "activation", client: fakeClient() });

		const flushed = flushedUpdates();
		expect(flushed.get(HASH_A)).toEqual({ kind: "patch", patch: {} });
		expect(flushed.get(HASH_B)).toEqual({ kind: "patch", patch: {} });
	});

	it("releases the claim when the per-commit gate holds a push", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		// Batch-ineligible → the legacy per-commit fallback, whose own gate is the one
		// under test here (the batch loop never runs: there are no eligible groups).
		vi.mocked(isOutboundPushAllowed).mockResolvedValueOnce(true).mockResolvedValue(false);

		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });

		expect(pushSummary).not.toHaveBeenCalled();
		expect(r.pushed).toBe(0);
		expect(r.failed).toBe(0);
		const flushed = flushedUpdates();
		expect(flushed.get(HASH_A)).toEqual({ kind: "patch", patch: {} });
	});

	it("releases the claim when the orchestrator's own live re-check rejects a fallback push", async () => {
		const { PushDisabledError } = await import("./PushControl.js");
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		// Both gates pass; the toggle lands between the attachment sends, so the refusal
		// arrives as the orchestrator's typed error instead.
		vi.mocked(pushSummary).mockRejectedValue(new PushDisabledError());

		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });

		// Held, not failed — and no retry burned, which is what the empty patch proves.
		expect(r.pushed).toBe(0);
		expect(r.failed).toBe(0);
		const flushed = flushedUpdates();
		expect(flushed.get(HASH_A)).toEqual({ kind: "patch", patch: {} });
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
		await processPushPending(CWD, {
			source: "post-queue",
			hashFilter: new Set([HASH_A]),
			client: fakeClient(),
		});
		expect(pushSummary).toHaveBeenCalledTimes(1);
		expect(vi.mocked(pushSummary).mock.calls[0][0].commitHash).toBe(HASH_A);
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
		const batch = flushedUpdates();
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
		const batch = flushedUpdates();
		expect(batch.get(HASH_A)).toEqual({ kind: "patch", patch: {} });
	});

	it("pushes a candidate with memory and deletes its entry on success", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });
		expect(r.pushed).toBe(1);
		expect(pushSummary).toHaveBeenCalledTimes(1);
		const batch = flushedUpdates();
		expect(batch.get(HASH_A)).toEqual({ kind: "delete" });
		// Compensation leaves orphan cleanup enabled; only pre-push defers it.
		expect(vi.mocked(pushSummary).mock.calls[0][3]).toEqual({ skipOrphanCleanup: false });
	});

	it("grafts the recovered docId/url into the push", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(0, { pushedDocId: 55, pushedUrl: "https://acme.jolli.ai/articles/doc-55" }) },
		});

		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });

		expect(r.pushed).toBe(1);
		expect(pushSummary).toHaveBeenCalledTimes(1);
		expect(vi.mocked(pushSummary).mock.calls[0][0]).toMatchObject({
			jolliDocId: 55,
			jolliDocUrl: "https://acme.jolli.ai/articles/doc-55",
		});
	});

	it("keeps the raced-away guard on the per-commit path", async () => {
		vi.mocked(loadBranchSummaries).mockResolvedValue({ summaries: [], missingCount: 0 });
		vi.mocked(getSummary)
			.mockResolvedValueOnce(summary(HASH_A)) // memory check
			.mockResolvedValueOnce(null); // fallback pushOne re-read
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });
		expect(r.failed).toBe(1);
		expect(pushSummary).not.toHaveBeenCalled();
		const batch = flushedUpdates();
		expect(batch.get(HASH_A)).toEqual({ kind: "delete" });
	});

	it("persists the server's Space echo as the binding cache after a successful individual push", async () => {
		// Only the per-commit fallback carries the echo — batch responses have none.
		vi.mocked(pushSummary).mockResolvedValue(pushed(HASH_A, { jmSpace: { id: 7, name: "Acme Core" } }));
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });

		await processPushPending(CWD, { source: "activation", client: fakeClient() });

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

		await processPushPending(CWD, { source: "activation", client: fakeClient() });

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

		vi.mocked(pushSummary).mockResolvedValue(pushed(HASH_A, { jmSpace: { id: 7, name: "Acme Core" } }));
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });

		expect(r.pushed).toBe(1);
		expect(saveSpaceBindingCache).toHaveBeenCalledWith(CWD, {
			repoUrl: "https://github.com/acme/repo",
			origin: "https://acme.jolli.ai",
			jmSpaceId: 7,
			spaceName: "Acme Core",
			canPush: true,
		});
	});

	it("clears the binding cache when a push is rejected with binding_required", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		vi.mocked(pushSummary).mockRejectedValue(new BindingRequiredError("https://github.com/acme/repo"));

		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });

		expect(r.failed).toBe(1);
		expect(clearSpaceBindingCache).toHaveBeenCalledWith(CWD);
		expect(saveSpaceBindingCache).not.toHaveBeenCalled();
		// The 412 stays a held (non-counted) retry, exactly as before the cache.
		const batch = flushedUpdates();
		expect(batch.get(HASH_A)).toMatchObject({ kind: "patch", patch: { lastError: "binding-required" } });
	});

	it("clears the binding cache when a push is rejected with permission denied", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		vi.mocked(pushSummary).mockRejectedValue(new PermissionDeniedError());

		await processPushPending(CWD, { source: "activation", client: fakeClient() });

		expect(clearSpaceBindingCache).toHaveBeenCalledWith(CWD);
	});

	it("clears the binding cache when an individual push is rejected as unauthenticated", async () => {
		vi.mocked(pushSummary).mockRejectedValue(new NotAuthenticatedError());
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });

		await processPushPending(CWD, { source: "activation", client: fakeClient() });

		expect(clearSpaceBindingCache).toHaveBeenCalledWith(CWD);
	});

	it("does not clear the binding cache on an operational (network) failure", async () => {
		vi.mocked(pushSummary).mockRejectedValue(new Error("ECONNRESET"));
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });

		await processPushPending(CWD, { source: "activation", client: fakeClient() });

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

		const result = await processPushPending(CWD, { source: "activation", client: fakeClient() });

		expect(result.pushed).toBe(1);
		expect(execGit).toHaveBeenCalledWith(["ls-remote", "--refs", pushUrl, remoteRef], CWD);
		expect(pushSummary).toHaveBeenCalledTimes(1);
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

	it("passes the owned selection into each commit's push (cross-commit dedup)", async () => {
		vi.mocked(assignOwnedContext).mockReturnValue(
			new Map([["plan", { owned: new Map([[HASH_A, [{ slug: "p-1234abcd" }]]]), seeds: new Map() }]]) as never,
		);
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		await processPushPending(CWD, { source: "activation", client: fakeClient() });
		// A kind-agnostic ContextSelection, not the legacy `{plans, notes, references}`
		// shape: naming only those three would mean "push zero skills".
		const selection = vi.mocked(pushSummary).mock.calls[0][2] as ContextSelection;
		expect(selection.get("plan")).toHaveLength(1);
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
		vi.mocked(assignOwnedContext).mockReturnValue(
			new Map([["plan", { owned: new Map([[HASH_A, [{ slug: "off-plan" }]]]), seeds: new Map() }]]) as never,
		);
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(0, { branch: offBranch }) },
		});

		await processPushPending(CWD, { source: "activation", client: fakeClient() });

		expect(assignOwnedContext).toHaveBeenCalledWith([offSummary]);
		const selection = vi.mocked(pushSummary).mock.calls[0][2] as ContextSelection;
		expect(selection.get("plan")).toHaveLength(1);
	});

	it("increments retryCount when the push fails operationally", async () => {
		vi.mocked(pushSummary).mockRejectedValue(new Error("network down"));
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry(1) } });
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });
		expect(r.failed).toBe(1);
		const batch = flushedUpdates();
		const update = batch.get(HASH_A);
		expect(update).toMatchObject({ kind: "patch" });
		if (update?.kind === "patch") {
			expect(update.patch.retryCount).toBe(2);
			expect(update.patch.lastError).toContain("network down");
		}
	});

	it("does NOT increment retryCount on NotAuthenticated mid-push", async () => {
		vi.mocked(pushSummary).mockRejectedValue(new NotAuthenticatedError());
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry(1) } });
		await processPushPending(CWD, { source: "activation", client: fakeClient() });
		const batch = flushedUpdates();
		const update = batch.get(HASH_A);
		if (update?.kind === "patch") {
			expect(update.patch.retryCount).toBeUndefined();
			expect(update.patch.lastError).toBe("not-authenticated");
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
		const batch = flushedUpdates();
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
			claimedAt: CLAIMED_AT,
		});
		await processPushPending(CWD, { source: "activation", client: fakeClient() });
		expect(pushSummary).toHaveBeenCalledTimes(1);
		expect(vi.mocked(pushSummary).mock.calls[0][0].commitHash).toBe(HASH_B);
	});

	it("returns early when every candidate was already claimed by another process", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		vi.mocked(claimForPush).mockResolvedValue({ claimed: new Set(), entries: {}, claimedAt: CLAIMED_AT });
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });
		expect(r.note).toBe("all entries claimed by another process");
		expect(pushSummary).not.toHaveBeenCalled();
	});
});
describe("processPushPending — pre-push options", () => {
	const PUSH_TARGET = { remote: "origin", remoteRef: "refs/heads/feature/x", localSha: HASH_A };

	it("skips the remote-ref confirmation gate when the pre-push worker asks for it", async () => {
		// The worker runs while git still holds the hook open, so no ref has moved
		// and ls-remote would refuse every entry. The control case below keeps the
		// gate and drains nothing, which is what makes this meaningful.
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(0, { pushTargets: [PUSH_TARGET] }) },
		});
		const r = await processPushPending(CWD, {
			source: "pre-push",
			skipPushConfirmation: true,
			client: fakeClient(),
		});
		expect(r.pushed).toBe(1);
		expect(execGit).not.toHaveBeenCalledWith(expect.arrayContaining(["ls-remote"]), CWD);
	});

	it("still enforces the confirmation gate for the compensation drains", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(0, { pushTargets: [PUSH_TARGET] }) },
		});
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });
		expect(r.note).toBe("push not confirmed");
		expect(pushSummary).not.toHaveBeenCalled();
	});

	it("passes the orphan-cleanup deferral through to pushSummary", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		await processPushPending(CWD, {
			source: "pre-push",
			skipPushConfirmation: true,
			skipOrphanCleanup: true,
			client: fakeClient(),
		});
		expect(vi.mocked(pushSummary).mock.calls[0][3]).toEqual({ skipOrphanCleanup: true });
	});

	it("keeps the entry pending when orphan cleanup is still outstanding", async () => {
		// Dropping it would strand those articles with nothing left pointing at
		// them — only a confirmed drain may delete them.
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		vi.mocked(pushSummary).mockResolvedValue(pushed(HASH_A, { cleanupPending: true }));
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });
		expect(r.pushed).toBe(1);
		expect(flushedUpdates().get(HASH_A)).toEqual({ kind: "patch", patch: {} });
	});

	it("records the minted ids when the local write-back failed, without burning a retry", async () => {
		// The article exists server-side; only the bookkeeping needs another go, so
		// the next drain must UPDATE it rather than CREATE a duplicate.
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry(1) } });
		vi.mocked(pushSummary).mockResolvedValue(
			pushed(HASH_A, { writeBackFailed: true, docId: 77, summaryUrl: "https://acme.jolli.ai/articles/doc-77" }),
		);
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });
		expect(r.pushed).toBe(1);
		const update = flushedUpdates().get(HASH_A);
		expect(update).toEqual({
			kind: "patch",
			patch: {
				lastAttemptAt: expect.any(String),
				lastError: expect.stringContaining("persisting the article id locally failed"),
				pushedDocId: 77,
				pushedUrl: "https://acme.jolli.ai/articles/doc-77",
			},
		});
		// retryCount is deliberately absent: the push itself succeeded.
		expect(update).not.toHaveProperty("patch.retryCount");
	});

	it("commits each entry's accounting as it settles, not in one batch at the end", async () => {
		// A drain at commit granularity outlives the claim TTL, so buffering the
		// whole ledger would let a crash replay commits that already published.
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(), [HASH_B]: entry() },
		});
		await processPushPending(CWD, { source: "activation", client: fakeClient() });
		const perCommitWrites = vi.mocked(updateBatch).mock.calls.filter((call) => call[1].size === 1);
		expect(perCommitWrites).toHaveLength(2);
	});

	it("stops starting new pushes once the runtime ceiling passes", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(), [HASH_B]: entry() },
		});
		const settled: CommitPushOutcome[] = [];
		const r = await processPushPending(CWD, {
			source: "pre-push",
			skipPushConfirmation: true,
			stopStartingAt: Date.now() - 1,
			client: fakeClient(),
			onCommitSettled: (o) => settled.push(o),
		});
		// Nothing was sent, nothing failed, and no retry was burned — the entries
		// look exactly like ones this drain never reached.
		expect(pushSummary).not.toHaveBeenCalled();
		expect(r.pushed).toBe(0);
		expect(r.failed).toBe(0);
		expect(settled.map((o) => o.status)).toEqual(["deferred", "deferred"]);
		expect(flushedUpdates().get(HASH_B)).toEqual({ kind: "patch", patch: {} });
	});

	it("reports hashes another process already claimed instead of dropping them", async () => {
		// The pre-push hook lists every commit of the push; an unreported one would
		// render as "still running" long after this drain exits.
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(), [HASH_B]: entry() },
		});
		vi.mocked(claimForPush).mockResolvedValue({
			claimed: new Set([HASH_B]),
			entries: { [HASH_B]: entry() },
			claimedAt: CLAIMED_AT,
		});
		const settled: CommitPushOutcome[] = [];
		await processPushPending(CWD, {
			source: "pre-push",
			skipPushConfirmation: true,
			client: fakeClient(),
			onCommitSettled: (o) => settled.push(o),
		});
		expect(settled).toContainEqual({
			hash: HASH_A,
			status: "deferred",
			reason: "another sync is already handling this commit",
		});
	});

	it("reports settled outcomes on early-exit paths too", async () => {
		// The contract on `commits` has to hold on EVERY return, or the worker
		// cannot promise its published result covers each requested hash.
		vi.mocked(loadConfig).mockResolvedValue({});
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const r = await processPushPending(CWD, {
			source: "pre-push",
			client: fakeClient(),
			onCommitSettled: () => {},
		});
		expect(r.note).toBe("not signed in");
		expect(r.commits).toEqual([]);
	});

	it("omits the commits array entirely when no callback was supplied", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const r = await processPushPending(CWD, { source: "activation", client: fakeClient() });
		expect(r.commits).toBeUndefined();
	});

	it("reports retry-exhausted entries rather than skipping them silently", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry(99) } });
		const settled: CommitPushOutcome[] = [];
		await processPushPending(CWD, {
			source: "pre-push",
			client: fakeClient(),
			onCommitSettled: (o) => settled.push(o),
		});
		expect(settled).toEqual([{ hash: HASH_A, status: "failed", reason: "failed repeatedly — giving up" }]);
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
