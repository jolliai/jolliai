#!/usr/bin/env node
/**
 * PrePushWorker — detached drain of `push-pending.json` to Jolli Space.
 *
 * Two modes, selected by `--push-id`:
 *   - pre-push (`--push-id <id>`): spawned by the pre-push hook. Drains THIS
 *     push's commits, skips the remote-ref confirmation gate (git has not
 *     transferred objects yet), defers orphan deletion for the same reason, and
 *     republishes a result file after every settled commit so the hook can print
 *     partial progress before its deadline. Finishes with a confirmed,
 *     unfiltered tail pass — by then git is done, so the deferred cleanup and
 *     any older backlog can be completed safely.
 *   - compensation (no `--push-id`): the CLI / VS Code activation and sign-in
 *     trigger. Drains whatever is pending, confirmation gate and orphan cleanup
 *     both intact.
 *
 * External orchestrators can use the compensation mode the same way:
 * `node PrePushWorker.js --cwd <repo>`.
 *
 * Both modes push at commit granularity — see the batch-removal note in
 * PushExecutor for why the batch endpoint is no longer used.
 */

import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JolliMemoryPushClient } from "../core/JolliMemoryPushClient.js";
import { type CommitPushOutcome, processPushPending } from "../core/PushExecutor.js";
import { loadPushPending } from "../core/PushPendingStore.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { runWithTrace, traceIdFromEnv } from "../core/TraceContext.js";
import { createLogger, errMsg } from "../Logger.js";
import { CAPTURE_PROGRESS_MAX_AGE_MS, pruneStaleCaptureProgress } from "./CaptureProgress.js";
import {
	acquirePushLock,
	type PushWorkerResult,
	readPushRequest,
	reasonFromNote,
	releasePushLock,
	writePushResult,
} from "./PushProgress.js";

const log = createLogger("PrePushWorker");

/**
 * HTTP timeout for the detached pre-push drain — double the client default.
 * Nothing is waiting on this process, and an aborted request is the expensive
 * failure here: the server may already have minted a docId that the abort
 * discards, making the next attempt CREATE a duplicate article. A request still
 * unanswered after this long is genuinely stuck and should fail normally.
 *
 * Kept at a third of {@link PRE_PUSH_WORKER_MAX_RUNTIME_MS} on purpose: a single
 * stuck request must not swallow most of the run's budget.
 */
const PRE_PUSH_WORKER_TIMEOUT_MS = 60_000;

/**
 * Ceiling on how long this worker keeps STARTING new pushes.
 *
 * A normal push settles in seconds — even a few hundred commits over a healthy
 * connection is well under a minute — so this only trips on a genuinely
 * degraded run (a connection where every request times out) or an unusually
 * large first push. Both are cases where continuing for tens of minutes buys
 * nothing: the user has long since moved on, and the leftovers cost nothing to
 * defer, because a deferred commit stays pending and the compensation channels
 * pick it up. Bounding the run instead trades a little latency for never
 * leaving an invisible process holding the network for hours.
 *
 * The ceiling covers the tail pass too — otherwise that could run just as long
 * right after the scoped pass gave up.
 */
const PRE_PUSH_WORKER_MAX_RUNTIME_MS = 3 * 60 * 1000;

/**
 * Grace after the runtime ceiling before the process force-exits.
 *
 * Sized to let one in-flight request finish and write back: the ceiling stops
 * new pushes but never cancels running ones, so the last batch can still be
 * holding a request for up to {@link PRE_PUSH_WORKER_TIMEOUT_MS}. This timer is
 * the last-resort guard for something wedging outside that path — under normal
 * operation the drain returns well before it fires.
 */
const PRE_PUSH_WORKER_HARD_EXIT_GRACE_MS = 90_000;

/** Drains push-pending.json to Jolli Space. Entry point for the standalone run. */
export async function runPushWorker(cwd: string, trigger = "activation"): Promise<void> {
	if (await readManualDisableFlag(cwd)) {
		log.info("PrePushWorker(%s): skipped — repository manually disabled", trigger);
		return;
	}
	log.info("PrePushWorker(%s): spawned compensation drain starting", trigger);
	const result = await processPushPending(cwd, { source: "activation" });
	log.info(
		"PrePushWorker(%s): drain done — attempted=%d pushed=%d failed=%d%s",
		trigger,
		result.attempted,
		result.pushed,
		result.failed,
		result.note ? ` (${result.note})` : "",
	);
}

/**
 * Pre-push mode: drain THIS push's commits, republishing the result after every
 * settled commit so the hook can print partial progress.
 *
 * Three things differ from the compensation drain, all deliberate:
 *   - No remote-ref confirmation. Git has not transferred objects yet, so
 *     `ls-remote` would refuse every entry.
 *   - No orphan deletion. Same reason: if the push is then rejected, deleting
 *     the old articles would leave the remote history intact with its memories
 *     gone, and the pending entry that could restore them already removed.
 *   - A longer HTTP timeout, and a ceiling on new pushes rather than on the run.
 *     Nothing here is ever cancelled mid-flight: aborting throws away a docId the
 *     server already minted, so {@link PRE_PUSH_WORKER_MAX_RUNTIME_MS} stops the
 *     drain from STARTING more work instead, and the rest stays pending.
 *
 * The published result always covers EVERY requested hash. `processPushPending`
 * has several short-circuit returns (not signed in, push disabled, nothing
 * eligible) that report no per-commit outcome at all, and a thrown error skips
 * the rest of the batch. Backfilling them here is what lets the hook print an
 * honest list instead of claiming a commit is still syncing after this process
 * has exited.
 */
export async function runPrePushSync(cwd: string, pushId: string): Promise<void> {
	const stopStartingAt = Date.now() + PRE_PUSH_WORKER_MAX_RUNTIME_MS;
	// Last-resort backstop for a wedge outside the drain (a hung write, a lock
	// that never clears). unref() so it never keeps an otherwise-finished process
	// alive, and exit 0 because a background sync must never look like a failure.
	setTimeout(() => process.exit(0), PRE_PUSH_WORKER_MAX_RUNTIME_MS + PRE_PUSH_WORKER_HARD_EXIT_GRACE_MS).unref();
	// Lock FIRST: everything below (the disable flag reads a git subprocess, the
	// prune stats a directory) takes long enough that a crash in between would be
	// invisible to the hook's liveness probe, costing it a full budget wait.
	acquirePushLock(cwd, pushId);
	const settled: CommitPushOutcome[] = [];
	const publish = (complete: boolean, note?: string): void => {
		writePushResult(cwd, {
			pushId,
			commits: [...settled],
			complete,
			...(note ? { note } : {}),
		} satisfies PushWorkerResult);
	};

	try {
		if (await readManualDisableFlag(cwd)) {
			log.info("PrePushWorker(pre-push): skipped — repository manually disabled");
			// Publish anyway: a silent exit would leave the hook polling until its
			// deadline and then announcing background work that will never happen.
			publish(true, "repository disabled");
			return;
		}
		const request = readPushRequest(cwd, pushId);
		if (!request || request.hashes.length === 0) {
			log.warn("PrePushWorker(pre-push): no usable work list for %s", pushId);
			publish(true, "work list missing");
			return;
		}

		// Opportunistic age-based sweep, same policy as the capture stream: files
		// are never deleted on completion (a killed worker leaves them behind
		// anyway, and deleting right after a write races the hook's next poll).
		pruneStaleCaptureProgress(cwd, CAPTURE_PROGRESS_MAX_AGE_MS);

		let note: string | undefined;
		try {
			const result = await processPushPending(cwd, {
				source: "pre-push",
				hashFilter: new Set(request.hashes),
				skipPushConfirmation: true,
				skipOrphanCleanup: true,
				stopStartingAt,
				client: new JolliMemoryPushClient({ timeoutMs: PRE_PUSH_WORKER_TIMEOUT_MS }),
				onCommitSettled: (outcome) => {
					settled.push(outcome);
					// Republish on every settled commit: the hook may give up at its
					// deadline, and whatever landed by then is still worth printing.
					publish(false);
				},
			});
			note = result.note;
			log.info(
				"PrePushWorker(pre-push): drain done — pushed=%d failed=%d noMemory=%d%s",
				result.pushed,
				result.failed,
				result.skippedNoMemory,
				result.note ? ` (${result.note})` : "",
			);
		} catch (error: unknown) {
			log.error("PrePushWorker(pre-push): drain failed: %s", errMsg(error));
			note = errMsg(error);
		}

		await backfillUnreported(cwd, request.hashes, settled, note);
		publish(true, note);
	} finally {
		// Release only after the terminal result exists: a hook that sees the lock
		// gone while no complete result is published would report "interrupted"
		// for a run that actually finished.
		await releasePushLock(cwd, pushId);
	}

	await runConfirmedTailPass(cwd, stopStartingAt);
}

/**
 * Gives every requested hash the drain did not report on an outcome, so a
 * `complete` result is the whole story.
 *
 * A hash that has left push-pending entirely was drained by someone else (or by
 * an earlier run) — that is a success, not an anomaly, and saying otherwise
 * would send the user to debug.log over nothing. It gets `pushed` with no URL:
 * the commit really is synced, this process just never held the article id.
 */
async function backfillUnreported(
	cwd: string,
	hashes: ReadonlyArray<string>,
	settled: CommitPushOutcome[],
	note: string | undefined,
): Promise<void> {
	const reported = new Set(settled.map((outcome) => outcome.hash));
	if (hashes.every((hash) => reported.has(hash))) return;
	// A failed read leaves `stillPending` undefined, which falls back to the
	// note-derived reason — never to a false "already synced".
	const stillPending = await loadPushPending(cwd)
		.then((file) => new Set(Object.keys(file.entries)))
		.catch((err: unknown) => {
			log.debug("Could not re-read push-pending while backfilling outcomes: %s", errMsg(err));
			return undefined;
		});
	const reason = reasonFromNote(note);
	for (const hash of hashes) {
		if (reported.has(hash)) continue;
		if (stillPending && !stillPending.has(hash)) {
			settled.push({ hash, status: "pushed" });
			continue;
		}
		settled.push({ hash, status: "deferred", reason });
	}
}

/**
 * Confirmed, unfiltered drain run after the scoped pass has published its
 * result. By now git has finished transferring, so `ls-remote` can confirm and
 * two things that nothing else would reach get finished:
 *   - the orphan cleanup our own pass deferred (those entries were kept as
 *     patches, and only a confirmed drain may delete remote articles);
 *   - any backlog left by earlier pushes.
 *
 * Without this, deferred cleanup would wait for an activation trigger — which a
 * pure-CLI user may not hit for days, long enough for the 7-day prune to drop
 * the entries and strand the articles.
 *
 * A rejected push simply fails confirmation and everything stays pending, which
 * is exactly the behaviour that makes deferring safe in the first place. Failures
 * are swallowed: the scoped pass is already published and must not be undone by
 * a problem in this best-effort tail.
 */
async function runConfirmedTailPass(cwd: string, stopStartingAt: number): Promise<void> {
	if (Date.now() >= stopStartingAt) {
		log.info("PrePushWorker(pre-push): skipping the confirmed tail pass — run time limit already reached");
		return;
	}
	try {
		const result = await processPushPending(cwd, {
			source: "pre-push",
			stopStartingAt,
			// Same budget as the scoped pass: this path publishes too, so an
			// aborted request loses a docId here exactly as it would there.
			client: new JolliMemoryPushClient({ timeoutMs: PRE_PUSH_WORKER_TIMEOUT_MS }),
		});
		log.info(
			"PrePushWorker(pre-push): confirmed tail pass — pushed=%d failed=%d%s",
			result.pushed,
			result.failed,
			result.note ? ` (${result.note})` : "",
		);
	} catch (error: unknown) {
		log.warn("PrePushWorker(pre-push): confirmed tail pass failed: %s", errMsg(error));
	}
}

// --- Script entry point (only when run directly, not when imported) ---
/* v8 ignore start */
function isMainScript(): boolean {
	const argv1 = process.argv[1];
	if (process.env.VITEST || !argv1) return false;

	const resolvedArgv = resolve(argv1);
	const resolvedScript = resolve(fileURLToPath(import.meta.url));
	if (resolvedArgv !== resolvedScript) return false;

	// Only auto-run when the entrypoint itself is PrePushWorker. esbuild (CJS,
	// no code splitting) can inline this module into sibling bundles, where
	// import.meta.url is aliased to the same __jmImportMetaUrl — without the
	// basename check the guard would fire inside those bundles too. Same
	// pattern as QueueWorker/PostCommitHook.
	const entryName = basename(resolvedArgv).toLowerCase();
	return entryName === "prepushworker.js" || entryName === "prepushworker.ts";
}

if (isMainScript()) {
	const args = process.argv.slice(2);
	const readArg = (name: string): string | undefined => {
		const index = args.indexOf(name);
		return index >= 0 && args[index + 1] ? args[index + 1] : undefined;
	};
	const cwd = readArg("--cwd") ?? process.cwd();
	const trigger = readArg("--trigger") ?? "activation";
	const pushId = readArg("--push-id");

	runWithTrace(traceIdFromEnv(), () => {
		// `--push-id` selects the pre-push drain: scoped to one push's commits,
		// unbudgeted, and it publishes a result file the hook may be polling for.
		// Everything else is the compensation drain.
		const run = pushId ? runPrePushSync(cwd, pushId) : runPushWorker(cwd, trigger);
		return run.catch((error: unknown) => {
			log.error("PrePushWorker fatal error: %s", error instanceof Error ? error.message : String(error));
			process.exit(0); // never signal failure — this is a background sync
		});
	});
}
/* v8 ignore stop */
