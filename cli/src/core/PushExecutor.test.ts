import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary } from "../Types.js";
import { execGit, getCurrentBranch, getDefaultBranch } from "./GitOps.js";
import { getCanonicalRepoUrl } from "./GitRemoteUtils.js";
import { BindingRequiredError, ClientOutdatedError, NotAuthenticatedError } from "./JolliMemoryPushClient.js";
import { assignOwnedAttachments, pushSummary } from "./JolliMemoryPushOrchestrator.js";
import { loadBranchSummaries } from "./PrDescription.js";
import { classifyError, processPushPending, triggerPushForNewSummaries } from "./PushExecutor.js";
import { claimForPush, loadPushPending, type PushPendingEntry, updateBatch } from "./PushPendingStore.js";
import { loadConfig } from "./SessionTracker.js";
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
	return { ...actual, pushSummary: vi.fn(), assignOwnedAttachments: vi.fn() };
});

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

function fakeClient() {
	return { resolveBaseUrl: vi.fn(async () => "https://acme.jolli.ai") } as never;
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
		expect(classifyError(new BindingRequiredError("r")).increment).toBe(false);
		expect(classifyError(new ClientOutdatedError()).increment).toBe(false);
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
		const r = await processPushPending(CWD, { source: "pre-push", client: fakeClient() });
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
		const r = await processPushPending(CWD, { source: "pre-push", client: fakeClient() });
		expect(r.skippedRetryExhausted).toBe(1);
		expect(pushSummary).not.toHaveBeenCalled();
	});

	it("honors the hashFilter (post-queue path)", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({
			version: 1,
			entries: { [HASH_A]: entry(), [HASH_B]: entry() },
		});
		await processPushPending(CWD, { source: "post-queue", hashFilter: new Set([HASH_A]), client: fakeClient() });
		expect(pushSummary).toHaveBeenCalledTimes(1);
	});

	it("skips candidates whose memory isn't generated yet and releases the claim so the post-queue trigger can re-claim", async () => {
		vi.mocked(getSummary).mockResolvedValue(null);
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const r = await processPushPending(CWD, { source: "pre-push", client: fakeClient() });
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
		const r = await processPushPending(CWD, { source: "pre-push", client: fakeClient() });
		expect(r.skippedNoMemory).toBe(1);
		expect(pushSummary).not.toHaveBeenCalled();
		// Empty patch releases claimedAt — same mechanism as the missing-summary
		// case above. Without it, the immediate post-queue push would be blocked
		// by the still-fresh claimedAt for up to CLAIM_STALE_MS (5 min).
		expect(updateBatch).toHaveBeenCalledTimes(1);
		const batch = vi.mocked(updateBatch).mock.calls[0][1];
		expect(batch.get(HASH_A)).toEqual({ kind: "patch", patch: {} });
	});

	it("pushes a candidate with memory and deletes it on success", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const r = await processPushPending(CWD, { source: "pre-push", client: fakeClient() });
		expect(r.pushed).toBe(1);
		expect(pushSummary).toHaveBeenCalledTimes(1);
		const batch = vi.mocked(updateBatch).mock.calls[0][1];
		expect(batch.get(HASH_A)).toEqual({ kind: "delete" });
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

	it("passes owned attachments to pushSummary (cross-commit dedup)", async () => {
		vi.mocked(assignOwnedAttachments).mockReturnValue({
			ownedPlans: new Map([[HASH_A, [{ slug: "p-1234abcd" }]]]) as never,
			ownedNotes: new Map(),
			ownedReferences: new Map(),
			seedPlanDocIds: new Map(),
			seedNoteDocIds: new Map(),
			seedReferenceDocIds: new Map(),
		});
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		await processPushPending(CWD, { source: "pre-push", client: fakeClient() });
		const attachments = vi.mocked(pushSummary).mock.calls[0][2];
		expect(attachments?.plans).toHaveLength(1);
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
		expect(vi.mocked(pushSummary).mock.calls[0][2]?.plans).toHaveLength(1);
	});

	it("increments retryCount on an operational failure", async () => {
		vi.mocked(pushSummary).mockRejectedValue(new Error("network down"));
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry(1) } });
		const r = await processPushPending(CWD, { source: "pre-push", client: fakeClient() });
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
		vi.mocked(pushSummary).mockRejectedValue(new NotAuthenticatedError());
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry(1) } });
		await processPushPending(CWD, { source: "pre-push", client: fakeClient() });
		const batch = vi.mocked(updateBatch).mock.calls[0][1];
		const update = batch.get(HASH_A);
		if (update?.kind === "patch") {
			expect(update.patch.retryCount).toBeUndefined();
			expect(update.patch.lastError).toBe("not-authenticated");
		}
	});

	it("drops a candidate that raced away (summary gone by push time)", async () => {
		// Passes the memory check (truthy first) but the pushOne fallback getSummary
		// returns null (deleted meanwhile). loadBranchSummaries empty → byHash miss
		// forces the fallback lookup.
		vi.mocked(loadBranchSummaries).mockResolvedValue({ summaries: [], missingCount: 0 });
		vi.mocked(getSummary)
			.mockResolvedValueOnce(summary(HASH_A)) // memory check
			.mockResolvedValueOnce(null); // pushOne fallback
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		const r = await processPushPending(CWD, { source: "pre-push", client: fakeClient() });
		expect(r.failed).toBe(1);
		expect(pushSummary).not.toHaveBeenCalled();
		const batch = vi.mocked(updateBatch).mock.calls[0][1];
		expect(batch.get(HASH_A)).toEqual({ kind: "delete" });
	});

	it("creates storage when none is active", async () => {
		vi.mocked(getActiveStorage).mockReturnValue(undefined);
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		await processPushPending(CWD, { source: "pre-push", client: fakeClient() });
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
		const r = await processPushPending(CWD, { source: "pre-push", client: fakeClient() });
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
		await processPushPending(CWD, { source: "pre-push", client: fakeClient() });
		expect(pushSummary).toHaveBeenCalledTimes(1);
		expect(pushSummary).toHaveBeenCalledWith(
			expect.objectContaining({ commitHash: HASH_B }),
			expect.any(Object),
			expect.any(Object),
		);
	});

	it("returns early when every candidate was already claimed by another process", async () => {
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_A]: entry() } });
		vi.mocked(claimForPush).mockResolvedValue({ claimed: new Set(), entries: {} });
		const r = await processPushPending(CWD, { source: "pre-push", client: fakeClient() });
		expect(r.note).toBe("all entries claimed by another process");
		expect(pushSummary).not.toHaveBeenCalled();
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
