/**
 * AutoCutover — the thing that actually presses the button.
 *
 * `CutoverEngine` has always been complete: fence, import, containment compare,
 * CAS, retry, idempotent resume. What it never had was a caller other than
 * `jolli cutover` typed by hand, so every repo stayed `uncutover` forever —
 * writes dual-wrote to the orphan branch and reads came from the folder layer,
 * and the whole SQLite source-of-truth path was unreachable in practice.
 *
 * The decision this module encodes is that the switch is automatic. That is
 * safe because cutover is a flag scoped to ONE DEVICE and ONE REPO: the fence
 * lives in that clone's `profile.json`, the CAS row lives in this machine's
 * `jollimemory.db`, and nothing about it is pushed, synced, or written back to
 * a remote. There is no other machine to coordinate with and no shared state to
 * corrupt, so there is nothing for a confirmation prompt to protect.
 *
 * Two rules hold everywhere this is called from:
 *
 * - **It never throws and never touches `process.exitCode`.** Every outcome
 *   short of `cutover` is a working state: `uncutover` keeps the orphan branch
 *   authoritative, `legacy-fenced` already writes SQLite and reads the database
 *   and only needs the CAS finished. Both converge on a later attempt, so a
 *   failure here must not turn a successful `jolli enable` red.
 * - **It is throttled per clone**, because the engine's step 2 re-imports every
 *   source at its pinned tip and step 3 then reads every file that tip lists.
 *   Far too expensive to repeat on every commit for a repo that keeps answering
 *   `not-ready`.
 *
 * It also owns the other half of the automatic story. Once a repo IS cut over
 * there is nothing left to press, but the fence can still be bypassed by an old
 * surface that kept writing the frozen branch — so this is where
 * {@link probeCutoverDrift} runs. See {@link maybeProbeDrift}.
 */

import { readRepoProfile, updateRepoProfile } from "../core/RepoProfile.js";
import { createLogger, errMsg } from "../Logger.js";
import { probeCutoverDrift, runCutover } from "./CutoverEngine.js";
import { resolveCutoverRoute } from "./CutoverRouter.js";
import { canUseDashboardDb } from "./DashboardDb.js";

const log = createLogger("AutoCutover");

/**
 * How long a `not-ready` verdict suppresses the next opportunistic attempt.
 *
 * Only the opportunistic caller (the post-commit drain) passes a throttle; the
 * post-import caller does not, because that is the one moment the database is
 * known to have just been filled from the branch — exactly when the compare is
 * most likely to pass, and the moment the user is waiting on setup anyway.
 *
 * Two hours, not six. The window is a cost/latency trade: an attempt is a full
 * re-import of every source at its pinned tip FOLLOWED BY a read of every file
 * that tip lists — not just the read — so it is far too expensive per commit;
 * but a repo that answers `not-ready` for a transient reason (a tip that kept
 * moving, a lock that stayed busy) should not sit un-cutover for most of a
 * working day before anything tries again. Six hours meant at most one attempt
 * per session; two gives a normal day several, at the same per-attempt cost.
 *
 * The same window throttles the drift probe — see {@link maybeProbeDrift} — on
 * its own stamp.
 */
export const AUTO_CUTOVER_RETRY_MS = 2 * 60 * 60 * 1000;

export interface AutoCutoverOptions {
	/** Skip when an attempt ran less than {@link AUTO_CUTOVER_RETRY_MS} ago. */
	readonly throttle?: boolean;
	readonly nowMs?: number;
	readonly dbPath?: string;
}

/**
 * Runs (or resumes) the cutover for `cwd` when it can, reporting nothing.
 *
 * Returns the state the repo ended in, for tests and for callers that want to
 * log it — never for control flow, since every state is workable.
 */
export async function maybeAutoCutover(
	cwd: string,
	opts: AutoCutoverOptions = {},
): Promise<"cutover" | "legacy-fenced" | "uncutover" | "skipped"> {
	// No flag-free `node:sqlite` → no database to cut over TO. Same gate every
	// other dashboard entry point self-applies.
	if (!canUseDashboardDb()) return "skipped";
	const now = opts.nowMs ?? Date.now();
	try {
		// Cheap check first: `cutover` is done and `blocked` has no safe backend
		// to move to (the repo needs `doctor --recover`, not another attempt).
		const route = await resolveCutoverRoute(cwd, opts.dbPath ? { dbPath: opts.dbPath } : {});
		if (route.state === "cutover") {
			await maybeProbeDrift(cwd, now, opts);
			return "cutover";
		}
		if (route.state === "blocked") {
			log.info("skipping auto-cutover for %s — routing is blocked: %s", cwd, route.reason);
			return "skipped";
		}
		if (opts.throttle) {
			const last = (await readRepoProfile(cwd)).cutoverAttemptedAtMs;
			if (typeof last === "number" && now - last < AUTO_CUTOVER_RETRY_MS) return "skipped";
		}
		// Stamped BEFORE the attempt, not after: a run that dies partway (the
		// process is killed, the machine sleeps) must still spend its slot, or a
		// repeatedly-crashing compare would re-run on every single commit.
		await updateRepoProfile(cwd, { cutoverAttemptedAtMs: now });

		const outcome = await runCutover(cwd, opts.dbPath ? { dbPath: opts.dbPath } : {});
		if (outcome.status === "committed" || outcome.status === "already-cutover") {
			log.info("auto-cutover: %s is now served from SQLite", cwd);
			return "cutover";
		}
		// `not-ready` / `retry-exhausted`. Expected, and not a problem: a moved tip,
		// an unregistered repo, a compare that has not converged. Which of the two
		// workable states the repo landed in is re-read rather than inferred —
		// `retry-exhausted` in particular leaves it FENCED, which is the state
		// worth naming in the log because writes are already going to SQLite.
		const after = await resolveCutoverRoute(cwd, opts.dbPath ? { dbPath: opts.dbPath } : {});
		log.info("auto-cutover deferred for %s (%s): %s", cwd, after.state, outcome.reason);
		return after.state === "legacy-fenced" ? "legacy-fenced" : "uncutover";
	} catch (err) {
		// `runCutover` answers with data rather than throwing, so reaching here
		// means something below it did (a profile lock timeout, a git failure).
		// Still not the caller's problem — see the header.
		log.warn("auto-cutover failed for %s: %s", cwd, errMsg(err));
		return "skipped";
	}
}

/**
 * The automatic half of the post-cutover safety net.
 *
 * `runCutover` no longer refuses to begin when an old surface is installed on
 * this machine — one un-upgraded extension used to pin every repo here at
 * `uncutover` forever. What that refusal guarded is a surface that keeps writing
 * the FROZEN branch afterwards, and the answer to it is `probeCutoverDrift`,
 * which reports such a write and catch-up imports it so the memory is not
 * stranded. That answer is only worth anything if something calls it: reads come
 * from SQLite after the fence, so a bypassed write is INVISIBLE, and a user with
 * no symptom has no reason to type `jolli cutover --probe`. This is that
 * something.
 *
 * It runs on the calls that find a repo ALREADY cut over, never on the call that
 * does the cutting — that one returns through the CAS, and the tips a probe
 * would compare are the ones it pinned itself moments earlier.
 *
 * Three further properties, each deliberate:
 *
 * - **Always throttled, even for the caller that passes no `throttle`.** That
 *   caller's reason (the database was just filled from the branch, so the
 *   compare is most likely to pass right now) is about the CUTOVER; it says
 *   nothing about drift, which is slow-moving by nature.
 * - **Its own stamp.** `cutoverAttemptedAtMs` stops being written the moment the
 *   repo reaches `cutover`, which is the only state this runs in — sharing it
 *   would make the first probe fire and every later one read a stamp nobody
 *   updates.
 * - **Its own try/catch.** The caller's returns `"skipped"`, which would be a
 *   lie about a repo that is cut over and working.
 */
async function maybeProbeDrift(cwd: string, now: number, opts: AutoCutoverOptions): Promise<void> {
	try {
		const last = (await readRepoProfile(cwd)).cutoverDriftProbedAtMs;
		if (typeof last === "number" && now - last < AUTO_CUTOVER_RETRY_MS) return;
		// Stamped BEFORE, for the same reason the attempt is: a probe that dies
		// partway must still spend its slot.
		await updateRepoProfile(cwd, { cutoverDriftProbedAtMs: now });
		const drift = await probeCutoverDrift(cwd, { nowMs: now, ...(opts.dbPath ? { dbPath: opts.dbPath } : {}) });
		if (drift.length === 0) return;
		// `probeCutoverDrift` already warns per drifted source. This line adds the
		// only thing it cannot: what the user should do about it.
		log.warn(
			"%d source(s) drifted in %s — the stranded memories were imported, but something is still writing the frozen branch (an old client or an un-restarted IDE). Run `jolli cutover --probe` after stopping it.",
			drift.length,
			cwd,
		);
	} catch (err) {
		log.warn("cutover drift probe failed for %s: %s", cwd, errMsg(err));
	}
}
