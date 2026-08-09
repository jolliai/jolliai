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
 * - **It is throttled per clone**, because the engine's step 3 reads every file
 *   the frozen tip lists. That is right after an import and far too expensive
 *   to repeat on every commit for a repo that keeps answering `not-ready`.
 */

import { readRepoProfile, updateRepoProfile } from "../core/RepoProfile.js";
import { createLogger, errMsg } from "../Logger.js";
import { runCutover } from "./CutoverEngine.js";
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
 */
export const AUTO_CUTOVER_RETRY_MS = 6 * 60 * 60 * 1000;

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
		if (route.state === "cutover") return "cutover";
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
		// `not-ready` / `retry-exhausted`. Expected, and not a problem: a stale
		// surface, a moved tip, a compare that has not converged. Which of the two
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
