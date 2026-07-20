import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./GitOps.js", () => ({
	execGit: vi.fn(async () => ({ exitCode: 0, stdout: "treehash123", stderr: "" })),
	getCommitInfo: vi.fn(async () => ({ message: "fix: thing", author: "Dev", date: "2026-01-01T00:00:00Z" })),
	getDiffContent: vi.fn(async () => "diff --git a b"),
	getDiffStats: vi.fn(async () => ({ filesChanged: 1, insertions: 2, deletions: 3 })),
}));
vi.mock("./StorageFactory.js", () => ({ createStorage: vi.fn(async () => ({ tag: "storage" })) }));
vi.mock("./TranscriptReader.js", () => ({ buildMultiSessionContext: vi.fn(() => "conversation") }));
vi.mock("./TranscriptId.js", () => ({ generateTranscriptId: vi.fn(() => "tid-1") }));
vi.mock("./Summarizer.js", () => ({ generateSummary: vi.fn() }));
vi.mock("./SummaryStore.js", () => ({
	getActiveStorage: vi.fn(),
	setActiveStorage: vi.fn(),
	storeSummary: vi.fn(async () => {}),
	getSummary: vi.fn(async () => null),
}));
// Run the lock body inline by default; individual tests override to simulate
// contention (ran:false) or a race where a summary already exists under the lock.
vi.mock("../hooks/CommitCaptureLock.js", () => ({
	COMMIT_CAPTURE_LOCK_WAIT_MS: 1000,
	withCommitCaptureLock: vi.fn(async (_cwd, _hash, _mode, body) => ({ ran: true, value: await body() })),
}));
vi.mock("./CheckpointStore.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./CheckpointStore.js")>()),
	archiveSupersededCheckpoints: vi.fn(async () => 0),
}));

import { withCommitCaptureLock } from "../hooks/CommitCaptureLock.js";
import type { JolliMemoryConfig, StoredTranscript } from "../Types.js";
import { archiveSupersededCheckpoints } from "./CheckpointStore.js";
import { CommitCaptureInProgressError, generateCommitSummary, persistCommitSummary } from "./CommitSummarizer.js";
import { getCommitInfo } from "./GitOps.js";
import { generateSummary } from "./Summarizer.js";
import { getActiveStorage, getSummary, setActiveStorage, storeSummary } from "./SummaryStore.js";

const CREDS = { apiKey: "sk-test" } as unknown as JolliMemoryConfig;

function transcript(over: Record<string, unknown> = {}): StoredTranscript {
	return {
		sessions: [{ sessionId: "s1", source: "claude", transcriptPath: "", entries: [], ...over }],
	} as unknown as StoredTranscript;
}

function summaryResult(over: Record<string, unknown> = {}): unknown {
	return {
		transcriptEntries: 4,
		conversationTurns: 2,
		llm: { model: "claude", stopReason: "end_turn" },
		stats: { filesChanged: 1, insertions: 2, deletions: 3 },
		topics: [{ title: "T", trigger: "why", response: "did", decisions: "chose" }],
		ticketId: "PROJ-1",
		recap: "one-line recap",
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(generateSummary).mockResolvedValue(summaryResult() as never);
	// Default: no summary yet for the hash under test → the under-lock re-check
	// falls through to generation. Individual tests override with a `…Once` value.
	vi.mocked(getSummary).mockResolvedValue(null as never);
	delete process.env.ANTHROPIC_API_KEY;
});

describe("generateCommitSummary", () => {
	it("throws when no LLM credentials are configured", async () => {
		await expect(generateCommitSummary("/repo", "abc", transcript(), {} as JolliMemoryConfig)).rejects.toThrow(
			/no LLM credentials/i,
		);
	});

	it("lands topics, recap, ticketId and the transcript id on the CommitSummary", async () => {
		const res = await generateCommitSummary("/repo", "abcdef", transcript(), CREDS);
		expect(res.summary.commitHash).toBe("abcdef");
		expect(res.summary.commitMessage).toBe("fix: thing");
		expect(res.summary.topics).toHaveLength(1);
		expect(res.summary.recap).toBe("one-line recap");
		expect(res.summary.ticketId).toBe("PROJ-1");
		expect(res.summary.transcripts).toEqual(["tid-1"]);
		expect(res.summary.treeHash).toBe("treehash123");
		expect(res.topics).toBe(1);
		expect(res.transcriptId).toBe("tid-1");
	});

	it("branch resolution: explicit opts.branch > session gitBranch > 'unknown'", async () => {
		expect(
			(await generateCommitSummary("/repo", "h", transcript(), CREDS, { branch: "feature/x" })).summary.branch,
		).toBe("feature/x");
		expect(
			(await generateCommitSummary("/repo", "h", transcript({ gitBranch: "sess-branch" }), CREDS)).summary.branch,
		).toBe("sess-branch");
		expect((await generateCommitSummary("/repo", "h", transcript(), CREDS)).summary.branch).toBe("unknown");
	});

	it("persists by default, forwarding force", async () => {
		await generateCommitSummary("/repo", "h", transcript(), CREDS, { force: true });
		expect(storeSummary).toHaveBeenCalledTimes(1);
		const call = vi.mocked(storeSummary).mock.calls[0];
		expect(call[1]).toBe("/repo"); // cwd
		expect(call[2]).toBe(true); // force
	});

	it("persist:false produces a draft without storing and without taking the capture lock", async () => {
		const res = await generateCommitSummary("/repo", "h", transcript(), CREDS, { persist: false });
		expect(storeSummary).not.toHaveBeenCalled();
		expect(withCommitCaptureLock).not.toHaveBeenCalled();
		expect(res.summary.topics).toHaveLength(1);
	});

	it("persist runs the pipeline under the per-commit capture lock", async () => {
		await generateCommitSummary("/repo", "abcdef", transcript(), CREDS);
		expect(withCommitCaptureLock).toHaveBeenCalledTimes(1);
		const [lockCwd, lockHash, lockMode] = vi.mocked(withCommitCaptureLock).mock.calls[0];
		expect(lockCwd).toBe("/repo");
		expect(lockHash).toBe("abcdef");
		expect(lockMode).toEqual({ wait: 1000 });
	});

	it("re-checks under the lock and returns the existing summary without running the LLM", async () => {
		const existing = { commitHash: "abcdef", topics: [{ title: "prior" }], transcripts: ["tid-prior"] };
		vi.mocked(getSummary).mockResolvedValueOnce(existing as never);
		const res = await generateCommitSummary("/repo", "abcdef", transcript(), CREDS);
		expect(generateSummary).not.toHaveBeenCalled();
		expect(storeSummary).not.toHaveBeenCalled();
		expect(res.summary).toBe(existing);
		expect(res.topics).toBe(1);
		expect(res.transcriptId).toBe("tid-prior");
	});

	it("does NOT short-circuit on a back-filled summary — the live capture supersedes it", async () => {
		// A back-fill is a lower-fidelity placeholder (no live transcript). When one
		// exists for this hash, the under-lock re-check must fall through to the LLM
		// so storeSummary's promotesBackfill replaces it with the live capture.
		const backfilled = { commitHash: "abcdef", backfilled: true, topics: [{ title: "bf" }], transcripts: ["t"] };
		vi.mocked(getSummary).mockResolvedValueOnce(backfilled as never);
		await generateCommitSummary("/repo", "abcdef", transcript(), CREDS);
		expect(generateSummary).toHaveBeenCalledTimes(1);
		expect(storeSummary).toHaveBeenCalledTimes(1);
	});

	it("force skips the existing-summary re-check and always regenerates", async () => {
		// force=true must not even consult getSummary — it regenerates unconditionally.
		await generateCommitSummary("/repo", "abcdef", transcript(), CREDS, { force: true });
		expect(getSummary).not.toHaveBeenCalled();
		expect(generateSummary).toHaveBeenCalledTimes(1);
		expect(storeSummary).toHaveBeenCalledTimes(1);
	});

	it("throws CommitCaptureInProgressError and skips the LLM when the lock can't be acquired", async () => {
		vi.mocked(withCommitCaptureLock).mockResolvedValueOnce({ ran: false });
		await expect(generateCommitSummary("/repo", "abcdef", transcript(), CREDS)).rejects.toBeInstanceOf(
			CommitCaptureInProgressError,
		);
		expect(generateSummary).not.toHaveBeenCalled();
		expect(storeSummary).not.toHaveBeenCalled();
		// Even on the contention path the process-global override is never touched.
		expect(setActiveStorage).not.toHaveBeenCalled();
		expect(getActiveStorage).not.toHaveBeenCalled();
	});

	it("never touches the process-global storage override — threads storage instead", async () => {
		const storage = { tag: "explicit-storage" } as never;
		await generateCommitSummary("/repo", "h", transcript(), CREDS, { storage });
		// The race the old save/restore invited is gone: nothing reads or mutates
		// the shared global, so concurrent captures can't interleave it.
		expect(setActiveStorage).not.toHaveBeenCalled();
		expect(getActiveStorage).not.toHaveBeenCalled();
		// Persistence still lands, via the explicitly threaded storage (5th arg).
		expect(storeSummary).toHaveBeenCalledTimes(1);
		expect(vi.mocked(storeSummary).mock.calls[0][4]).toBe(storage);
	});

	it("concurrent captures of different hashes each thread their own storage, no global swap", async () => {
		const storageA = { tag: "storage-A" } as never;
		const storageB = { tag: "storage-B" } as never;
		// Two captures racing in one process with DIFFERENT hashes + DIFFERENT
		// storages — the exact shape the desktop cockpit produces. The old
		// setActiveStorage save/restore could leave the global pinned to whichever
		// finished second's `previousStorage` baseline; threaded storage can't.
		await Promise.all([
			generateCommitSummary("/repo-a", "aaa111", transcript(), CREDS, { storage: storageA }),
			generateCommitSummary("/repo-b", "bbb222", transcript(), CREDS, { storage: storageB }),
		]);
		expect(setActiveStorage).not.toHaveBeenCalled();
		expect(getActiveStorage).not.toHaveBeenCalled();
		// Each capture persisted through its OWN storage, regardless of interleaving.
		const byHash = new Map(
			vi.mocked(storeSummary).mock.calls.map((c) => [(c[0] as { commitHash: string }).commitHash, c[4]]),
		);
		expect(byHash.get("aaa111")).toBe(storageA);
		expect(byHash.get("bbb222")).toBe(storageB);
	});
});

describe("persistCommitSummary", () => {
	it("stores with force, threading storage and never touching the global override", async () => {
		const summary = { commitHash: "abcdef012345" } as never;
		const t = transcript();
		const storage = { tag: "explicit-storage" } as never;
		await persistCommitSummary("/repo", summary, t, "tid-9", { force: true, storage });
		expect(storeSummary).toHaveBeenCalledTimes(1);
		const call = vi.mocked(storeSummary).mock.calls[0];
		expect(call[0]).toBe(summary);
		expect(call[2]).toBe(true); // force
		expect(call[3]).toEqual({ transcript: { id: "tid-9", data: t } });
		expect(call[4]).toBe(storage); // threaded, not via the global override
		expect(setActiveStorage).not.toHaveBeenCalled();
		expect(getActiveStorage).not.toHaveBeenCalled();
	});
});

describe("checkpoint retirement", () => {
	const folderStorage = { tag: "storage", kbRoot: "/kb/myrepo" } as never;

	it("retires branch checkpoints after a persisted commit summary (scoped by commit date)", async () => {
		await generateCommitSummary("/repo", "abc123", transcript(), CREDS, {
			branch: "feature/x",
			storage: folderStorage,
		});
		expect(vi.mocked(archiveSupersededCheckpoints)).toHaveBeenCalledTimes(1);
		const [kbRoot, branch, opts] = vi.mocked(archiveSupersededCheckpoints).mock.calls[0];
		expect(kbRoot).toBe("/kb/myrepo");
		expect(branch).toBe("feature/x");
		// `before` is rounded UP to the end of the commit's second (…00.999Z, not
		// …00.000Z): git author dates are second-precision, checkpoint createdAt
		// values carry real ms, so a checkpoint captured in the commit's own
		// second must still fall within `createdAt <= before` and be archived.
		expect(opts).toMatchObject({ supersededBy: "abc123", before: "2026-01-01T00:00:00.999Z" });
	});

	it("rounds the archival bound up to the end of the commit's second (same-second checkpoints included)", async () => {
		vi.mocked(getCommitInfo).mockResolvedValueOnce({
			message: "fix: thing",
			author: "Dev",
			date: "2026-03-04T05:06:07Z",
		} as never);
		await generateCommitSummary("/repo", "abc123", transcript(), CREDS, {
			branch: "feature/x",
			storage: folderStorage,
		});
		const [, , opts] = vi.mocked(archiveSupersededCheckpoints).mock.calls[0];
		expect(opts).toMatchObject({ before: "2026-03-04T05:06:07.999Z" });
	});

	it("does not retire on a draft (persist:false)", async () => {
		await generateCommitSummary("/repo", "abc123", transcript(), CREDS, {
			branch: "feature/x",
			storage: folderStorage,
			persist: false,
		});
		expect(vi.mocked(archiveSupersededCheckpoints)).not.toHaveBeenCalled();
	});

	it("skips retirement when the branch is 'unknown' or storage has no kbRoot", async () => {
		// Branch 'unknown' (no explicit branch, no session branch) → skip.
		await generateCommitSummary("/repo", "abc123", transcript(), CREDS, { storage: folderStorage });
		// Non-folder storage (no kbRoot) → skip even with a real branch.
		await generateCommitSummary("/repo", "abc123", transcript(), CREDS, { branch: "feature/x" });
		expect(vi.mocked(archiveSupersededCheckpoints)).not.toHaveBeenCalled();
	});

	it("skips retirement when the commit date can't be parsed", async () => {
		const summary = { commitHash: "abcdef012345", branch: "feature/x", commitDate: "not-a-date" } as never;
		await persistCommitSummary("/repo", summary, transcript(), "tid-9", { storage: folderStorage });
		expect(vi.mocked(archiveSupersededCheckpoints)).not.toHaveBeenCalled();
	});
});
