import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CommitPushOutcome,
	type ProcessPushPendingOptions,
	type ProcessPushPendingResult,
	processPushPending,
} from "../core/PushExecutor.js";
import { loadPushPending } from "../core/PushPendingStore.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { runPrePushSync, runPushWorker } from "./PrePushWorker.js";
import { type PushWorkerResult, readPushRequest, releasePushLock, writePushResult } from "./PushProgress.js";

vi.mock("../core/PushExecutor.js", () => ({ processPushPending: vi.fn() }));
vi.mock("../core/RepoProfile.js", () => ({ readManualDisableFlag: vi.fn().mockResolvedValue(false) }));
vi.mock("../core/PushPendingStore.js", () => ({ loadPushPending: vi.fn() }));
vi.mock("./CaptureProgress.js", () => ({
	CAPTURE_PROGRESS_MAX_AGE_MS: 3_600_000,
	pruneStaleCaptureProgress: vi.fn(),
}));
vi.mock("./PushProgress.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./PushProgress.js")>()),
	acquirePushLock: vi.fn(),
	releasePushLock: vi.fn(),
	readPushRequest: vi.fn(),
	writePushResult: vi.fn(),
}));

const CWD = "/repo";
const PUSH_ID = "trace-1";
const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);

const EMPTY_RESULT: ProcessPushPendingResult = {
	attempted: 0,
	pushed: 0,
	failed: 0,
	skippedNoMemory: 0,
	skippedRetryExhausted: 0,
	deletedChildren: 0,
};

/** Every result the worker published, oldest first. */
function published(): PushWorkerResult[] {
	return vi.mocked(writePushResult).mock.calls.map((call) => call[1]);
}

/** The terminal publish — what the hook renders when it sees `complete`. */
function terminal(): PushWorkerResult | undefined {
	const complete = published().filter((result) => result.complete);
	return complete[complete.length - 1];
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(readManualDisableFlag).mockResolvedValue(false);
	vi.mocked(processPushPending).mockResolvedValue(EMPTY_RESULT);
	vi.mocked(readPushRequest).mockReturnValue({ pushId: PUSH_ID, hashes: [HASH_A, HASH_B] });
	vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: {} });
});

describe("runPushWorker", () => {
	it("drains push-pending.json via the activation compensation path", async () => {
		await runPushWorker(CWD, "cli-auth-login");
		expect(processPushPending).toHaveBeenCalledWith(CWD, { source: "activation" });
	});

	it("does nothing when the repository is manually disabled", async () => {
		vi.mocked(readManualDisableFlag).mockResolvedValueOnce(true);
		await runPushWorker(CWD);
		expect(processPushPending).not.toHaveBeenCalled();
	});
});

describe("runPrePushSync", () => {
	it("drains only this push's commits, unconfirmed and without deleting orphans", async () => {
		await runPrePushSync(CWD, PUSH_ID);
		const opts = vi.mocked(processPushPending).mock.calls[0][1] as ProcessPushPendingOptions;
		expect(opts.source).toBe("pre-push");
		expect([...(opts.hashFilter ?? [])]).toEqual([HASH_A, HASH_B]);
		expect(opts.skipPushConfirmation).toBe(true);
		expect(opts.skipOrphanCleanup).toBe(true);
		expect(opts.stopStartingAt).toBeGreaterThan(Date.now());
		expect(opts.client).toBeDefined();
	});

	it("republishes after every settled commit so a timed-out hook can still print", async () => {
		vi.mocked(processPushPending).mockImplementation(async (_cwd, options) => {
			options.onCommitSettled?.({ hash: HASH_A, status: "pushed", url: "https://jolli.ai/a" });
			options.onCommitSettled?.({ hash: HASH_B, status: "failed", reason: "boom" });
			return EMPTY_RESULT;
		});
		await runPrePushSync(CWD, PUSH_ID);
		const partials = published().filter((result) => !result.complete);
		expect(partials).toHaveLength(2);
		expect(partials[0].commits).toHaveLength(1);
		expect(partials[1].commits).toHaveLength(2);
	});

	it("publishes the terminal result before releasing the lock", async () => {
		const order: string[] = [];
		vi.mocked(writePushResult).mockImplementation((_cwd, result) => {
			if (result.complete) order.push("publish");
		});
		vi.mocked(releasePushLock).mockImplementation(async () => {
			order.push("release");
		});
		await runPrePushSync(CWD, PUSH_ID);
		// A hook that sees the lock gone with no complete result would report an
		// interruption for a run that actually finished.
		expect(order).toEqual(["publish", "release"]);
	});

	it("backfills every hash the drain never reported on", async () => {
		// `complete` promises nothing more is coming, so the hook needs an outcome
		// for each requested hash or it would render one as "still syncing".
		vi.mocked(processPushPending).mockImplementation(async (_cwd, options) => {
			options.onCommitSettled?.({ hash: HASH_A, status: "pushed" });
			return { ...EMPTY_RESULT, note: "not signed in" };
		});
		// HASH_B is still pending, so it takes the note-derived reason rather than
		// the "someone else already drained it" branch.
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_B]: {} as never } });
		await runPrePushSync(CWD, PUSH_ID);
		expect(terminal()?.commits).toEqual([
			{ hash: HASH_A, status: "pushed" },
			{ hash: HASH_B, status: "deferred", reason: "not signed in to Jolli" },
		]);
	});

	it("calls a hash that already left push-pending synced, not unreachable", async () => {
		// Another channel drained it. Saying "see debug.log" would send the user
		// after a problem that does not exist.
		vi.mocked(processPushPending).mockResolvedValue({ ...EMPTY_RESULT, note: "no eligible entries" });
		vi.mocked(loadPushPending).mockResolvedValue({ version: 1, entries: { [HASH_B]: {} as never } });
		await runPrePushSync(CWD, PUSH_ID);
		const commits = terminal()?.commits ?? [];
		expect(commits).toContainEqual({ hash: HASH_A, status: "pushed" });
		expect(commits).toContainEqual({ hash: HASH_B, status: "deferred", reason: "nothing left to sync" });
	});

	it("falls back to the note when push-pending cannot be re-read", async () => {
		vi.mocked(processPushPending).mockResolvedValue({ ...EMPTY_RESULT, note: "not signed in" });
		vi.mocked(loadPushPending).mockRejectedValue(new Error("unreadable"));
		await runPrePushSync(CWD, PUSH_ID);
		// Never a false "already synced" on a failed read.
		expect(terminal()?.commits.every((c) => c.status === "deferred")).toBe(true);
	});

	it("still publishes a terminal result when the drain throws", async () => {
		vi.mocked(processPushPending).mockRejectedValueOnce(new Error("drain exploded"));
		await runPrePushSync(CWD, PUSH_ID);
		expect(terminal()?.complete).toBe(true);
		expect(terminal()?.note).toContain("drain exploded");
		expect(releasePushLock).toHaveBeenCalled();
	});

	it("publishes instead of exiting silently when the repo is disabled", async () => {
		// A silent exit leaves the hook polling to its deadline and then announcing
		// background work that will never happen.
		vi.mocked(readManualDisableFlag).mockResolvedValue(true);
		await runPrePushSync(CWD, PUSH_ID);
		expect(terminal()).toMatchObject({ complete: true, note: "repository disabled" });
		expect(processPushPending).not.toHaveBeenCalled();
	});

	it("publishes instead of exiting silently when the work list is missing", async () => {
		vi.mocked(readPushRequest).mockReturnValue(undefined);
		await runPrePushSync(CWD, PUSH_ID);
		expect(terminal()).toMatchObject({ complete: true, note: "work list missing" });
		expect(processPushPending).not.toHaveBeenCalled();
	});

	it("finishes with a confirmed unfiltered tail pass", async () => {
		// By now git has transferred, so ls-remote can confirm — this is what
		// completes the deferred orphan cleanup instead of waiting for activation.
		await runPrePushSync(CWD, PUSH_ID);
		const tail = vi.mocked(processPushPending).mock.calls[1][1] as ProcessPushPendingOptions;
		expect(tail.source).toBe("pre-push");
		expect(tail.hashFilter).toBeUndefined();
		expect(tail.skipPushConfirmation).toBeUndefined();
		expect(tail.skipOrphanCleanup).toBeUndefined();
		// Same HTTP budget as the scoped pass: this path publishes too.
		expect(tail.client).toBeDefined();
	});

	it("skips the tail pass when the runtime ceiling is already spent", async () => {
		vi.mocked(processPushPending).mockImplementation(async (_cwd, options) => {
			// Simulate a scoped pass that ran right up to its ceiling.
			if (options.stopStartingAt) vi.setSystemTime(new Date(options.stopStartingAt + 1));
			return EMPTY_RESULT;
		});
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			await runPrePushSync(CWD, PUSH_ID);
		} finally {
			vi.useRealTimers();
		}
		expect(processPushPending).toHaveBeenCalledTimes(1);
	});

	it("does not fail the run when the tail pass throws", async () => {
		vi.mocked(processPushPending).mockResolvedValueOnce(EMPTY_RESULT).mockRejectedValueOnce(new Error("tail boom"));
		await expect(runPrePushSync(CWD, PUSH_ID)).resolves.toBeUndefined();
		// The scoped pass is already published and must not be undone by the tail.
		expect(terminal()?.complete).toBe(true);
	});
});

/** Guards the outcome shape the hook's renderer depends on. */
describe("published outcome shape", () => {
	it("keeps commits in the order they settled", async () => {
		const order: CommitPushOutcome[] = [
			{ hash: HASH_B, status: "pushed" },
			{ hash: HASH_A, status: "generating", reason: "memory still generating — will sync later" },
		];
		vi.mocked(processPushPending).mockImplementation(async (_cwd, options) => {
			for (const outcome of order) options.onCommitSettled?.(outcome);
			return EMPTY_RESULT;
		});
		await runPrePushSync(CWD, PUSH_ID);
		// Completion order, not push order — the hook re-sorts when rendering.
		expect(terminal()?.commits.map((c) => c.hash)).toEqual([HASH_B, HASH_A]);
	});
});
