/**
 * PushProgress — the hand-off files between the pre-push hook and the detached
 * push worker.
 *
 * The hook records the commits, spawns the worker, and polls for a result file
 * for at most its budget. The worker owns every network round-trip and runs to
 * completion regardless of whether anyone is still watching — that is the whole
 * point: an aborted request throws away a docId the server already minted, and
 * the next attempt would then CREATE a duplicate article instead of UPDATEing
 * the existing one (see `withRecoveredDocId`).
 *
 * The result is republished after EVERY settled commit, not once at the end, so
 * a hook that gives up at its deadline can still print the commits that made it.
 * That matters here: one commit's push is a chain of requests (each plan, note
 * and reference, then the summary), so a large push settles gradually.
 *
 * A published result with `complete: true` is a promise that NOTHING more is
 * coming, so the worker guarantees it covers every requested hash. The hook
 * relies on that to avoid telling the user a commit is "still syncing" after the
 * worker has exited.
 *
 * Files live in the same `capture-progress/` directory as the commit-capture
 * stream: the repo is writable for anyone who can push, and worktrees get their
 * own copy for free. `pruneStaleCaptureProgress` sweeps `.json` and `.tmp`
 * alongside its own artifacts. Nothing is deleted on completion — a SIGKILLed
 * worker never reaches its cleanup anyway, and deleting right after a write
 * would race the hook's next poll and turn an early exit into a full-budget wait.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPidAlive, readLockOwnerPid, releaseIfOwned } from "../core/LockPrimitives.js";
import type { CommitPushOutcome } from "../core/PushExecutor.js";
import { captureProgressDir } from "./CaptureProgress.js";

/** Default poll interval for {@link watchPushResult}. */
export const PUSH_RESULT_POLL_MS = 200;

/** What the hook hands to the worker: the commits of THIS push, in push order. */
export interface PushWorkerRequest {
	readonly pushId: string;
	readonly hashes: ReadonlyArray<string>;
}

/** What the worker publishes back — rewritten after every settled commit. */
export interface PushWorkerResult {
	readonly pushId: string;
	/** Outcomes settled SO FAR. Order is completion order, NOT push order. */
	readonly commits: ReadonlyArray<CommitPushOutcome>;
	/**
	 * False while the drain is still running. When true, `commits` covers every
	 * requested hash — the hook prints it verbatim and never adds a "still
	 * syncing" line, which would be false once the worker has exited.
	 */
	readonly complete: boolean;
	/** Set when the run short-circuited (not signed in, push disabled, …). */
	readonly note?: string;
}

export function pushRequestPath(cwd: string, pushId: string): string {
	return join(captureProgressDir(cwd), `push-${pushId}.request.json`);
}

export function pushResultPath(cwd: string, pushId: string): string {
	return join(captureProgressDir(cwd), `push-${pushId}.result.json`);
}

export function pushLockPath(cwd: string, pushId: string): string {
	return join(captureProgressDir(cwd), `push-${pushId}.lock`);
}

/**
 * Writes the worker's input. Throws on failure — the hook uses that to skip the
 * spawn entirely rather than starting a worker that cannot find its work list
 * and then making the user wait out a budget for a result that cannot come.
 *
 * Any artifact left by an earlier run of the SAME pushId is cleared first. A
 * pushId is the ambient trace id when one is set, so uniqueness is a property of
 * how the id was obtained, not something this protocol enforces — and nothing
 * else here would catch the reuse: a leftover `complete` result reads as this
 * push's own outcome (announcing commits this push never sent), and a leftover
 * lock owned by a dead pid reports this push's worker as interrupted before it
 * has even started. Both are removed before the work list is published, so a
 * reused id starts from the same blank slate a fresh one does.
 */
export function writePushRequest(cwd: string, request: PushWorkerRequest): void {
	mkdirSync(captureProgressDir(cwd), { recursive: true });
	rmSync(pushResultPath(cwd, request.pushId), { force: true });
	rmSync(pushLockPath(cwd, request.pushId), { force: true });
	writeAtomic(pushRequestPath(cwd, request.pushId), JSON.stringify(request));
}

/**
 * Reads the worker's input. Validates element types and the pushId round-trip:
 * a malformed file would otherwise degrade into "no eligible entries", which is
 * indistinguishable from a legitimately empty push.
 */
export function readPushRequest(cwd: string, pushId: string): PushWorkerRequest | undefined {
	const parsed = readJson<PushWorkerRequest>(pushRequestPath(cwd, pushId));
	if (!parsed || parsed.pushId !== pushId) return undefined;
	if (!Array.isArray(parsed.hashes)) return undefined;
	if (!parsed.hashes.every((hash) => typeof hash === "string" && hash.length > 0)) return undefined;
	return parsed;
}

/**
 * Publishes (or republishes) the worker's outcome. Best-effort: a result nobody
 * reads changes nothing about the push that already happened, so a write failure
 * must never break the worker's own accounting.
 */
export function writePushResult(cwd: string, result: PushWorkerResult): void {
	try {
		mkdirSync(captureProgressDir(cwd), { recursive: true });
		writeAtomic(pushResultPath(cwd, result.pushId), JSON.stringify(result));
	} catch {
		// best-effort: the hook falls back to its timeout line
	}
}

/** Reads a published result; undefined before the worker's first publish. */
export function readPushResult(cwd: string, pushId: string): PushWorkerResult | undefined {
	const parsed = readJson<PushWorkerResult>(pushResultPath(cwd, pushId));
	if (!parsed || parsed.pushId !== pushId || !Array.isArray(parsed.commits)) return undefined;
	return parsed;
}

/** Marks "this worker is alive" for the hook's liveness probe. Best-effort. */
export function acquirePushLock(cwd: string, pushId: string): void {
	try {
		mkdirSync(captureProgressDir(cwd), { recursive: true });
		writeFileSync(pushLockPath(cwd, pushId), String(process.pid), "utf-8");
	} catch {
		// best-effort: only the liveness probe degrades
	}
}

/** Releases the lock, PID-guarded so a stale release cannot delete a live lock. */
export async function releasePushLock(cwd: string, pushId: string): Promise<void> {
	await releaseIfOwned(pushLockPath(cwd, pushId), "push worker lock");
}

/**
 * True when the lock exists but its owner is gone — the worker was killed and
 * will never publish again. An ABSENT lock is NOT dead: the worker may not have
 * started yet, or may have finished and released. Same semantics as
 * {@link isCaptureWorkerDead}.
 */
export async function isPushWorkerDead(cwd: string, pushId: string): Promise<boolean> {
	const pid = await readLockOwnerPid(pushLockPath(cwd, pushId));
	return pid !== null && !isPidAlive(pid);
}

/**
 * Human-readable reason for a commit the drain never reported on, derived from
 * its short-circuit note. Used by the worker to backfill outcomes (so a complete
 * result really does cover every hash) and by the hook as its fallback wording.
 *
 * `undefined` deliberately does NOT mean "fine": every known short-circuit sets
 * a note, so an unreported hash with no note is an anomaly worth pointing at the
 * log for. The caller handles the one benign case — a hash that left
 * push-pending entirely — before falling back here.
 */
export function reasonFromNote(note: string | undefined): string {
	switch (note) {
		case "not signed in":
			return "not signed in to Jolli";
		case "push disabled for this repo":
			return "outbound push disabled for this repo";
		case "syncOnPush disabled":
			return "push sync is turned off";
		case "all entries claimed by another process":
			return "another sync is already handling this commit";
		case "push not confirmed":
			return "push not confirmed on the remote";
		case "no pending entries":
		case "no eligible entries":
			return "nothing left to sync";
		case undefined:
			return "not reached — see .jolli/jollimemory/debug.log";
		default:
			return note;
	}
}

/** How a {@link watchPushResult} loop ended. */
export type PushWatchEnd = "complete" | "timeout" | "worker-dead";

export interface WatchPushResultOptions {
	readonly deadlineAt: number;
	readonly pollMs?: number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
	readonly readResult?: () => PushWorkerResult | undefined;
	readonly workerDead?: () => Promise<boolean>;
}

/**
 * Polls until the worker reports completion, is detected dead, or the deadline
 * passes. Always returns the LAST result seen, even on timeout or death, so the
 * caller can print whatever settled before giving up.
 *
 * The liveness probe runs AFTER the result read on every iteration: a worker
 * that publishes its final result and exits in the same tick must be reported as
 * "complete", never as "worker-dead".
 */
export async function watchPushResult(
	cwd: string,
	pushId: string,
	opts: WatchPushResultOptions,
): Promise<{ ended: PushWatchEnd; result?: PushWorkerResult }> {
	const pollMs = opts.pollMs ?? PUSH_RESULT_POLL_MS;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const clock = opts.now ?? Date.now;
	const read = opts.readResult ?? (() => readPushResult(cwd, pushId));
	const dead = opts.workerDead ?? (() => isPushWorkerDead(cwd, pushId));

	let latest: PushWorkerResult | undefined;
	for (;;) {
		const current = read();
		if (current) latest = current;
		if (latest?.complete) return { ended: "complete", result: latest };
		if (clock() >= opts.deadlineAt) return { ended: "timeout", ...(latest && { result: latest }) };
		if (await dead()) return { ended: "worker-dead", ...(latest && { result: latest }) };
		await sleep(pollMs);
	}
}

function writeAtomic(path: string, content: string): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		// Missing (worker has not published yet) or torn mid-rename — same answer.
		return undefined;
	}
}
