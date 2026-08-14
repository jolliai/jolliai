import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitPushOutcome } from "../core/PushExecutor.js";
import { mergeEntries } from "../core/PushPendingStore.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createStorage } from "../core/StorageFactory.js";
import { getIndexEntryMap, getSummary } from "../core/SummaryStore.js";
import { execFileAsyncHidden } from "../util/Subprocess.js";
import { PRE_PUSH_SYNC_BUDGET_MS, parsePushRefs, prePushEntry } from "./PrePushHook.js";
import { triggerPendingPushRetry } from "./PushCompensation.js";
import { type PushWorkerResult, watchPushResult, writePushRequest, writePushResult } from "./PushProgress.js";

const mockReadManualDisableFlag = vi.hoisted(() => vi.fn().mockResolvedValue(false));
const mockReadPushDisabledState = vi.hoisted(() => vi.fn().mockResolvedValue({ disabled: false }));

vi.mock("../core/SessionTracker.js", () => ({ loadConfig: vi.fn() }));
vi.mock("../dashboard/CutoverRouter.js", () => ({
	// Pre-cutover default (plain fn — survives mock resets).
	resolveCutoverRoute: async () => ({ state: "uncutover" }),
}));

vi.mock("../core/RepoProfile.js", () => ({
	// Pre-cutover default: no fence (plain fn — survives mock resets).
	readCutoverFence: async () => null,
	readManualDisableFlag: mockReadManualDisableFlag,
}));
vi.mock("../core/PushControl.js", () => ({
	readPushDisabledState: mockReadPushDisabledState,
}));
vi.mock("../core/PushPendingStore.js", () => ({ mergeEntries: vi.fn() }));
vi.mock("./PushCompensation.js", () => ({ triggerPendingPushRetry: vi.fn() }));
// reasonFromNote stays real: it is a pure mapping the hook's output depends on.
vi.mock("./PushProgress.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./PushProgress.js")>()),
	writePushRequest: vi.fn(),
	writePushResult: vi.fn(),
	watchPushResult: vi.fn(),
}));
vi.mock("../core/StorageFactory.js", () => ({ createStorage: vi.fn() }));
vi.mock("../core/SummaryStore.js", () => ({ getIndexEntryMap: vi.fn(), getSummary: vi.fn() }));
vi.mock("../util/Subprocess.js", () => ({ execFileAsyncHidden: vi.fn() }));

const CWD = "/repo";
const ZERO = "0".repeat(40);
const LOCAL = "1".repeat(40);
const REMOTE = "2".repeat(40);
const REMOTE_NAME = "origin";

const PUSH_ID = "trace-abc";

/** A finished worker run that settled `commits` and nothing else. */
function completed(commits: ReadonlyArray<CommitPushOutcome>, note?: string) {
	const result: PushWorkerResult = { pushId: PUSH_ID, commits, complete: true, ...(note ? { note } : {}) };
	return { ended: "complete" as const, result };
}

/** A watch that gave up while the worker kept running, having seen `commits`. */
function timedOut(commits: ReadonlyArray<CommitPushOutcome>) {
	if (commits.length === 0) return { ended: "timeout" as const };
	const result: PushWorkerResult = { pushId: PUSH_ID, commits, complete: false };
	return { ended: "timeout" as const, result };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(loadConfig).mockResolvedValue({ jolliApiKey: "sk-jol-x" });
	vi.mocked(mergeEntries).mockResolvedValue(undefined);
	vi.mocked(triggerPendingPushRetry).mockReturnValue(true);
	vi.mocked(writePushRequest).mockReturnValue(undefined);
	vi.mocked(watchPushResult).mockResolvedValue(completed([]));
	vi.mocked(createStorage).mockResolvedValue({} as never);
	vi.mocked(getIndexEntryMap).mockResolvedValue(new Map());
	vi.mocked(getSummary).mockResolvedValue(null);
	vi.mocked(execFileAsyncHidden).mockResolvedValue({ stdout: "c1\nc2\n", stderr: "" });
	mockReadManualDisableFlag.mockResolvedValue(false);
	mockReadPushDisabledState.mockResolvedValue({ disabled: false });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("parsePushRefs", () => {
	it("parses well-formed lines and skips blanks/short lines", () => {
		const stdin = `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n\nbad line\n`;
		const refs = parsePushRefs(stdin);
		expect(refs).toHaveLength(1);
		expect(refs[0]).toMatchObject({ localRef: "refs/heads/x", localSha: LOCAL, remoteSha: REMOTE });
	});
});

describe("prePushEntry", () => {
	it("does not record pending pushes while the repo is manually disabled", async () => {
		mockReadManualDisableFlag.mockResolvedValue(true);
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		expect(loadConfig).not.toHaveBeenCalled();
		expect(mergeEntries).not.toHaveBeenCalled();
	});

	it("no-ops entirely when syncOnPush is false (no file write, no inline sync)", async () => {
		vi.mocked(loadConfig).mockResolvedValue({ jolliApiKey: "sk-jol-x", syncOnPush: false });
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		expect(mergeEntries).not.toHaveBeenCalled();
		expect(triggerPendingPushRetry).not.toHaveBeenCalled();
	});

	it("records commits but skips inline sync when outbound push is disabled for the repo (spec 306)", async () => {
		mockReadPushDisabledState.mockResolvedValue({ disabled: true });
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		// Entries are still recorded (a later re-enable catches up) but no sync runs.
		expect(mergeEntries).toHaveBeenCalled();
		expect(triggerPendingPushRetry).not.toHaveBeenCalled();
		// A genuine opt-out is the ONE case that may point at --enable.
		expect(stderr.mock.calls.flat().join("")).toContain("jolli push-control --enable");
	});

	it("does NOT offer --enable when the OFF came from an unreadable store (spec 306)", async () => {
		// --enable rebuilds a corrupt store from empty and drops EVERY repo's
		// opt-out. This notice prints on every `git push`, so recommending it here
		// would be the most-seen path to silent data loss in the feature. Point at
		// `jolli push-control`, which explains the trade-off, and name the file.
		mockReadPushDisabledState.mockResolvedValue({
			disabled: true,
			error: "Push-control store at /g/push-control.json is corrupt",
		});
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		expect(mergeEntries).toHaveBeenCalled();
		expect(triggerPendingPushRetry).not.toHaveBeenCalled();
		const written = stderr.mock.calls.flat().join("");
		expect(written).toContain("can't read your outbound-push setting");
		expect(written).toContain("/g/push-control.json");
		expect(written).not.toContain("--enable");
	});

	it("records commits but does NOT sync inline when not signed in", async () => {
		vi.mocked(loadConfig).mockResolvedValue({});
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		expect(mergeEntries).toHaveBeenCalledWith(CWD, ["c1", "c2"], "x", {
			remote: REMOTE_NAME,
			remoteRef: "refs/heads/x",
			localSha: LOCAL,
		});
		expect(triggerPendingPushRetry).not.toHaveBeenCalled();
	});

	it("lists at most three exact root memories when not signed in", async () => {
		const hashes = ["1", "2", "3", "4", "5", "6"].map((digit) => digit.repeat(40));
		vi.mocked(loadConfig).mockResolvedValue({});
		vi.mocked(execFileAsyncHidden).mockImplementation(async (_file, args) => {
			if (args?.[0] === "show") {
				return {
					stdout: [
						`${hashes[0]}\tFirst memory`,
						`${hashes[1]}\t${"a".repeat(80)}`,
						`${hashes[4]}\tThird memory`,
						`${hashes[5]}\tFourth memory`,
					].join("\n"),
					stderr: "",
				};
			}
			return { stdout: `${hashes.join("\n")}\n`, stderr: "" };
		});
		vi.mocked(getIndexEntryMap).mockResolvedValue(
			new Map([
				[hashes[0], { commitHash: hashes[0], parentCommitHash: null } as never],
				[hashes[1], { commitHash: hashes[1], parentCommitHash: null } as never],
				[hashes[2], { commitHash: hashes[2], parentCommitHash: null } as never],
				[hashes[3], { commitHash: hashes[3], parentCommitHash: hashes[0] } as never],
				[hashes[4], { commitHash: hashes[4], parentCommitHash: null } as never],
				[hashes[5], { commitHash: hashes[5], parentCommitHash: null } as never],
			]),
		);
		vi.mocked(getSummary).mockImplementation(async (hash) => {
			if (hash === hashes[2]) return { commitHash: hashes[0] } as never;
			return { commitHash: hash } as never;
		});
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);

		const output = String(stderrSpy.mock.calls[0][0]);
		expect(output).toContain("jollimemory: not signed in");
		expect(output).toContain(`${hashes[0].substring(0, 8)} First memory`);
		expect(output).toContain(`${hashes[1].substring(0, 8)} ${"a".repeat(49)}…`);
		expect(output).toContain(`${hashes[4].substring(0, 8)} Third memory`);
		expect(output).not.toContain(hashes[3].substring(0, 8));
		expect(output).not.toContain("Fourth memory");
		expect(output).toContain("  ...");
		expect(output).toContain("Run `jolli auth login` to sign in");
		expect(triggerPendingPushRetry).not.toHaveBeenCalled();
	});

	it("omits the signed-out notice when this push has no generated memories", async () => {
		vi.mocked(loadConfig).mockResolvedValue({});
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);

		expect(stderrSpy).not.toHaveBeenCalled();
		expect(getSummary).not.toHaveBeenCalled();
	});

	it("prints no ellipsis when three or fewer signed-out memories are pending", async () => {
		const hash = "7".repeat(40);
		vi.mocked(loadConfig).mockResolvedValue({});
		vi.mocked(execFileAsyncHidden).mockImplementation(async (_file, args) => {
			if (args?.[0] === "show") return { stdout: `${hash}\tOne memory\n`, stderr: "" };
			return { stdout: `${hash}\n`, stderr: "" };
		});
		vi.mocked(getIndexEntryMap).mockResolvedValue(
			new Map([[hash, { commitHash: hash, parentCommitHash: null } as never]]),
		);
		vi.mocked(getSummary).mockResolvedValue({ commitHash: hash } as never);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);

		const output = String(stderrSpy.mock.calls[0][0]);
		expect(output).toContain("One memory");
		expect(output).not.toContain("  ...");
	});

	it("swallows signed-out notice failures so the push is never blocked", async () => {
		vi.mocked(loadConfig).mockResolvedValue({});
		vi.mocked(createStorage).mockRejectedValue(new Error("storage unavailable"));
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		await expect(
			prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME),
		).resolves.toBeUndefined();
		expect(stderrSpy).not.toHaveBeenCalled();
		expect(triggerPendingPushRetry).not.toHaveBeenCalled();
	});

	it("stops the signed-out preview scan at the deadline instead of reading storage per commit", async () => {
		vi.mocked(loadConfig).mockResolvedValue({});
		vi.mocked(getIndexEntryMap).mockResolvedValue(
			new Map([["c1", { commitHash: "c1", parentCommitHash: null } as never]]),
		);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		// Anchor the budget in the past so the preview deadline is already over.
		const expiredStart = Date.now() - PRE_PUSH_SYNC_BUDGET_MS - 1;
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME, expiredStart);

		expect(getSummary).not.toHaveBeenCalled();
		expect(stderrSpy).not.toHaveBeenCalled();
	});

	it("records commits and spawns the detached sync worker when signed in", async () => {
		const startedAtMs = 1_000_000;
		await prePushEntry(
			CWD,
			`refs/heads/feature/y ${LOCAL} refs/heads/feature/y ${REMOTE}\n`,
			REMOTE_NAME,
			startedAtMs,
		);
		expect(mergeEntries).toHaveBeenCalledWith(CWD, ["c1", "c2"], "feature/y", {
			remote: REMOTE_NAME,
			remoteRef: "refs/heads/feature/y",
			localSha: LOCAL,
		});
		expect(writePushRequest).toHaveBeenCalledWith(CWD, { pushId: expect.any(String), hashes: ["c1", "c2"] });
		const [, trigger, extraArgs] = vi.mocked(triggerPendingPushRetry).mock.calls[0];
		expect(trigger).toBe("pre-push");
		expect(extraArgs?.[0]).toBe("--push-id");
		// The watch budget is anchored at process start, not at spawn time.
		expect(vi.mocked(watchPushResult).mock.calls[0][2]).toMatchObject({
			deadlineAt: startedAtMs + PRE_PUSH_SYNC_BUDGET_MS,
		});
	});

	it("records entries BEFORE spawning the worker (write-first crash safety)", async () => {
		const order: string[] = [];
		vi.mocked(mergeEntries).mockImplementation(async () => {
			order.push("merge");
		});
		vi.mocked(triggerPendingPushRetry).mockImplementation(() => {
			order.push("sync");
			return true;
		});
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		expect(order).toEqual(["merge", "sync"]);
	});

	it("swallows result-watch failures so the push is never blocked", async () => {
		vi.mocked(watchPushResult).mockRejectedValue(new Error("watch boom"));
		await expect(
			prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME),
		).resolves.toBeUndefined();
	});

	it("prints a per-commit result list to stderr (URL for pushed, reason for pending)", async () => {
		vi.mocked(execFileAsyncHidden).mockImplementation(async (_file, args) => {
			if (args?.[0] === "show") {
				return { stdout: "c1\tfix login bug\nc2\tadd retry logic\n", stderr: "" };
			}
			return { stdout: "c1\nc2\n", stderr: "" };
		});
		vi.mocked(watchPushResult).mockResolvedValue(
			completed([
				{ hash: "c1", status: "pushed", url: "https://jolli.ai/articles/fix-login-bug-9" },
				{ hash: "c2", status: "generating", reason: "memory still generating — will sync later" },
			]),
		);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		const output = String(stderrSpy.mock.calls[0][0]);
		expect(output).toContain("jollimemory: push to Jolli Space");
		expect(output).toContain("✓ c1");
		expect(output).toContain("fix login bug");
		expect(output).toContain("https://jolli.ai/articles/fix-login-bug-9");
		expect(output).toContain("… c2");
		expect(output).toContain("memory still generating — will sync later");
	});

	it("prints a short failure reason for failed commits", async () => {
		vi.mocked(watchPushResult).mockResolvedValue(
			completed([{ hash: "c1", status: "failed", reason: "network timeout" }]),
		);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		const output = String(stderrSpy.mock.calls[0][0]);
		expect(output).toContain("✗ c1");
		expect(output).toContain("network timeout");
	});

	it("truncates over-long commit subjects in the result list", async () => {
		const longSubject = "a".repeat(80);
		vi.mocked(execFileAsyncHidden).mockImplementation(async (_file, args) => {
			if (args?.[0] === "show") return { stdout: `c1\t${longSubject}\n`, stderr: "" };
			return { stdout: "c1\n", stderr: "" };
		});
		vi.mocked(watchPushResult).mockResolvedValue(
			completed([{ hash: "c1", status: "pushed", url: "https://jolli.ai/a" }]),
		);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		const output = String(stderrSpy.mock.calls[0][0]);
		expect(output).toContain(`${"a".repeat(49)}…`);
		expect(output).not.toContain("a".repeat(60));
	});

	it("renders the list even when commit subjects cannot be resolved", async () => {
		vi.mocked(execFileAsyncHidden).mockImplementation(async (_file, args) => {
			if (args?.[0] === "show") throw new Error("git boom");
			return { stdout: "c1\n", stderr: "" };
		});
		vi.mocked(watchPushResult).mockResolvedValue(
			completed([{ hash: "c1", status: "pushed", url: "https://jolli.ai/a" }]),
		);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		const output = String(stderrSpy.mock.calls[0][0]);
		expect(output).toContain("✓ c1");
		expect(output).toContain("https://jolli.ai/a");
	});

	it("labels commits the finished worker never reported from its note, not as background work", async () => {
		// A `complete` result promises nothing more is coming, so an unreported hash
		// must never be rendered as "still syncing" — the worker has already exited.
		vi.mocked(watchPushResult).mockResolvedValue(completed([], "not signed in"));
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		const output = String(stderrSpy.mock.calls[0][0]);
		expect(output).toContain("not signed in to Jolli");
		expect(output).not.toContain("in the background");
	});

	it("prints settled commits and marks the rest as background work on timeout", async () => {
		vi.mocked(watchPushResult).mockResolvedValue(
			timedOut([{ hash: "c1", status: "pushed", url: "https://jolli.ai/a" }]),
		);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		const output = String(stderrSpy.mock.calls[0][0]);
		expect(output).toContain("✓ c1");
		expect(output).toContain("https://jolli.ai/a");
		// c2 never settled, and the worker is still alive — this wording is true.
		expect(output).toContain("… c2");
		expect(output).toContain("syncing in the background");
	});

	it("prints a single background notice when the watch times out with no results yet", async () => {
		vi.mocked(watchPushResult).mockResolvedValue(timedOut([]));
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		const output = String(stderrSpy.mock.calls[0][0]);
		expect(output).toContain("syncing 2 commit(s) to Jolli Space in the background");
	});

	it("reports an interrupted sync when the worker died, never as background work", async () => {
		vi.mocked(watchPushResult).mockResolvedValue({
			ended: "worker-dead",
			result: { pushId: PUSH_ID, commits: [{ hash: "c1", status: "pushed" }], complete: false },
		});
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
		expect(output).toContain("✓ c1");
		expect(output).toContain("interrupted — still pending");
		expect(output).toContain("background sync was interrupted");
		expect(output).not.toContain("syncing in the background");
	});

	it("degrades immediately when the work list cannot be written, without waiting out the budget", async () => {
		vi.mocked(writePushRequest).mockImplementation(() => {
			throw new Error("disk full");
		});
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		expect(triggerPendingPushRetry).not.toHaveBeenCalled();
		expect(watchPushResult).not.toHaveBeenCalled();
		expect(String(stderrSpy.mock.calls[0][0])).toContain("background sync could not start");
	});

	it("degrades immediately when the worker cannot be spawned", async () => {
		vi.mocked(triggerPendingPushRetry).mockReturnValue(false);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		expect(watchPushResult).not.toHaveBeenCalled();
		expect(String(stderrSpy.mock.calls[0][0])).toContain("background sync could not start");
	});

	it("publishes a terminal result when the spawn fails asynchronously", async () => {
		// ENOENT/EACCES arrive on the child's error event, after spawn returned. The
		// published result is what lets the poll loop exit on its next tick.
		vi.mocked(triggerPendingPushRetry).mockImplementation((_cwd, _trigger, _args, onSpawnError) => {
			onSpawnError?.(new Error("spawn ENOENT"));
			return true;
		});
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		expect(writePushResult).toHaveBeenCalledWith(
			CWD,
			expect.objectContaining({ complete: true, commits: [], note: expect.stringContaining("spawn ENOENT") }),
		);
	});

	it("skips delete pushes (all-zero local sha)", async () => {
		await prePushEntry(CWD, `(delete) ${ZERO} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		expect(mergeEntries).not.toHaveBeenCalled();
		expect(triggerPendingPushRetry).not.toHaveBeenCalled();
	});

	it("uses --not --remotes for a brand-new remote branch (zero remote sha)", async () => {
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${ZERO}\n`, REMOTE_NAME);
		const args = vi.mocked(execFileAsyncHidden).mock.calls[0][1];
		expect(args).toEqual(["rev-list", "--reverse", LOCAL, "--not", "--remotes"]);
	});

	it("excludes commits already on a remote from the remote..local range", async () => {
		// The range alone is not "what this push introduces": a rebased branch
		// absorbs commits from its updated base that its own remote tip predates,
		// and git transfers none of them. Without --not --remotes they are enqueued
		// and reported as "memory still generating" forever — no memory for another
		// author's commit is ever generated on this machine.
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		const args = vi.mocked(execFileAsyncHidden).mock.calls[0][1];
		expect(args).toEqual(["rev-list", "--reverse", `${REMOTE}..${LOCAL}`, "--not", "--remotes"]);
	});

	it("no-ops when rev-list yields no commits", async () => {
		vi.mocked(execFileAsyncHidden).mockResolvedValue({ stdout: "\n", stderr: "" });
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		expect(mergeEntries).not.toHaveBeenCalled();
		expect(triggerPendingPushRetry).not.toHaveBeenCalled();
	});

	it("tolerates a git rev-list failure (logs, skips that ref)", async () => {
		vi.mocked(execFileAsyncHidden).mockRejectedValue(new Error("git boom"));
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		expect(mergeEntries).not.toHaveBeenCalled();
	});

	it("keeps a non-heads ref name as-is (e.g. a tag push)", async () => {
		await prePushEntry(CWD, `refs/tags/v1 ${LOCAL} refs/tags/v1 ${REMOTE}\n`, REMOTE_NAME);
		expect(mergeEntries).toHaveBeenCalledWith(CWD, ["c1", "c2"], "refs/tags/v1", {
			remote: REMOTE_NAME,
			remoteRef: "refs/tags/v1",
			localSha: LOCAL,
		});
	});

	it("records a separate confirmation target for each pushed ref update", async () => {
		const other = "3".repeat(40);
		await prePushEntry(
			CWD,
			`refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\nrefs/heads/x ${other} refs/heads/x ${REMOTE}\n`,
			REMOTE_NAME,
		);
		const branchCalls = vi.mocked(mergeEntries).mock.calls.filter((c) => c[2] === "x");
		expect(branchCalls).toHaveLength(2);
		expect(branchCalls.map((call) => call[3]?.localSha)).toEqual([LOCAL, other]);
	});
});
