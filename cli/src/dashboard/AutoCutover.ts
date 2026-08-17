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
import type { CutoverBlockRecord } from "./CutoverBlock.js";
import { probeCutoverDrift, readCutoverBlock, runCutover } from "./CutoverEngine.js";
import { resolveCutoverRoute } from "./CutoverRouter.js";
import { canUseDashboardDb } from "./DashboardDb.js";
import {
	existingWorktrees,
	hasLiveWorktree,
	isRepoDisabled,
	type RegisteredRepo,
	readRepoRegistry,
	sameRecordedRoot,
} from "./RepoRegistry.js";

const log = createLogger("AutoCutover");

/**
 * How long a verdict short of `cutover` suppresses the next attempt — for the
 * ONE caller that opts in.
 *
 * **Only the post-commit drain throttles. Every foreground caller — `jolli
 * enable`, `jolli dashboard`, a bare `jolli` — attempts on every invocation.**
 * The split is about who asked. A command the user typed should do the thing it
 * is for; a git hook did not ask for anything, and its path runs on every
 * commit, so an attempt there is a cost nobody chose to pay.
 *
 * What the window actually buys is narrower than it looks, and worth stating
 * because the obvious reading is wrong: it can NEVER delay a successful
 * cutover. A repo that cut over resolves to the `cutover` route and
 * short-circuits ahead of this check, so reaching the throttle at all means the
 * previous attempt did not commit. This is a failure backoff, nothing else.
 *
 * Two hours for that backoff. An attempt is a full re-import of every source at
 * its pinned tip FOLLOWED BY a read of every file that tip lists — not just the
 * read — which is far too expensive to repeat per commit for a repo that keeps
 * answering `not-ready`.
 *
 * Foreground callers used to share this window, and the cost of that was
 * measured in the field: a repo whose earlier attempt had failed was silently
 * skipped by `jolli dashboard`, which reported nothing either way, so the user's
 * only working route was typing `jolli cutover` — the exact command the
 * automatic path exists to make unnecessary. A user in front of a terminal is
 * also the one case where the two-hour assumption is plainly false: they are
 * about to retry regardless.
 *
 * The same window still throttles the drift probe — see {@link maybeProbeDrift} —
 * on its own stamp, and there it applies to EVERY caller. That is not an
 * inconsistency: drift is slow-moving, and no user typed a command asking about
 * it.
 *
 * **The case this window does not cover, and must not be widened to cover.** The
 * cost argument above assumes a repo either switches or has already switched: one
 * in `cutover` short-circuits on a single database query, and one that commits
 * stops costing anything ever again. What it leaves out is a repo that keeps
 * answering `not-ready` for a reason no retry can change — an import that stores
 * nothing while its tip lists artifacts — where the unthrottled foreground path
 * would repeat the FULL import per such repo on every bare `jolli` and every
 * `jolli dashboard`, linear in how many the machine has. That is answered by
 * {@link readCutoverBlock}, not by a window: the engine records WHICH refusal it
 * was together with the inputs the refusal was a function of, and the attempt is
 * skipped only while those inputs are unchanged. A window (or a failure count)
 * cannot tell "the answer would be the same" from "the answer might have
 * changed", which is precisely how the measured field failure two paragraphs up
 * happened — so re-adding one here is still a review blocker.
 */
export const AUTO_CUTOVER_RETRY_MS = 2 * 60 * 60 * 1000;

export interface AutoCutoverOptions {
	/** Skip when an attempt ran less than {@link AUTO_CUTOVER_RETRY_MS} ago. */
	readonly throttle?: boolean;
	readonly nowMs?: number;
	readonly dbPath?: string;
	/**
	 * Called once, immediately before an attempt begins — and NEVER when a gate
	 * short-circuited first.
	 *
	 * An attempt is a full re-import at every source's pinned tip followed by a
	 * read of every file that tip lists: tens of seconds on a real repo, with no
	 * output of its own. In a foreground command that silence is not neutral.
	 * `jolli dashboard` prints "Press Ctrl+C to stop" and then runs this AFTER
	 * its last line, so a user who reads the finished import as "done" presses
	 * Ctrl+C straight into the attempt — and that costs more than the attempt:
	 * the stamp below is written FIRST (deliberately, see there), so the
	 * interrupted run still spends its throttle slot and every automatic caller
	 * stays quiet for the next two hours. Measured in the field exactly that
	 * way. This hook is how a foreground caller gets to say "leave it running"
	 * at the one moment that is true.
	 *
	 * Firing ONLY for a real attempt is the point. A caller that announced work
	 * on every call would print it on the throttled runs too — which are the
	 * common case — and a progress line that is usually a lie is one the user
	 * learns to scroll past.
	 */
	readonly onAttemptStart?: () => void;
	/**
	 * Called instead of {@link onAttemptStart} when a recorded refusal still
	 * applies and no attempt is made.
	 *
	 * A separate hook rather than a flag on the other one, because what a caller
	 * has to say about the two is opposite: `onAttemptStart` asks the user to wait,
	 * this one tells them waiting will not help and names the repair. It is the only
	 * route this state has to a surface — `state` is `"skipped"`, which is also what
	 * a disabled repo and an old runtime answer.
	 */
	readonly onBlocked?: (record: CutoverBlockRecord) => void;
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
	//
	// Logged rather than returned bare, like every other skip below it. This
	// function reports nothing to the user by contract, so a silent return leaves
	// "auto-cutover did nothing" with no trace ANYWHERE — not the terminal (info
	// is console-suppressed in CLI mode) and not `debug.log` either. That is the
	// state a real investigation started from: a repo that would not cut over,
	// four ways to reach that outcome, and evidence for none of them.
	if (!canUseDashboardDb()) {
		log.info("skipping auto-cutover for %s — Node %s has no flag-free node:sqlite", cwd, process.versions.node);
		return "skipped";
	}
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
			if (typeof last === "number" && now - last < AUTO_CUTOVER_RETRY_MS) {
				// The single most likely reason a user sees nothing happen, and it
				// used to be the least visible: reaching this line at all means an
				// earlier attempt did NOT commit (a repo that did short-circuits at
				// the `cutover` route above and never gets here), so the one thing
				// worth saying is when the next attempt is due and how to bypass it.
				log.info(
					"skipping auto-cutover for %s — an attempt ran %d min ago, next due in %d min (jolli cutover ignores this window)",
					cwd,
					Math.round((now - last) / 60_000),
					Math.round((AUTO_CUTOVER_RETRY_MS - (now - last)) / 60_000),
				);
				return "skipped";
			}
		}
		// After the throttle, because that is one profile read and this may fork git
		// for a tip per source; before the stamp and the attempt, because its whole
		// job is to not spend either. Unlike the throttle this applies to EVERY
		// caller: it is not a backoff, it is the answer the last attempt already
		// produced, and it stops applying the moment an input moves.
		const blocked = await readCutoverBlock(cwd, opts.dbPath ? { dbPath: opts.dbPath } : {});
		if (blocked) {
			log.info(
				"skipping auto-cutover for %s — %s, unchanged since %s: %s (jolli cutover ignores this)",
				cwd,
				blocked.code,
				new Date(blocked.at).toISOString(),
				blocked.reason,
			);
			opts.onBlocked?.(blocked);
			return "skipped";
		}
		// Announced before the stamp so a foreground caller's line lands ahead of
		// any work — see {@link AutoCutoverOptions.onAttemptStart}.
		opts.onAttemptStart?.();
		// Its own log line, and not merged into the outcome lines below: those only
		// exist for a run that FINISHED. An attempt killed partway (Ctrl+C, the
		// machine sleeping) is precisely the case worth reconstructing later, and
		// without this its only trace is whatever `CutoverEngine` happened to warn
		// about before it died.
		log.info("auto-cutover: attempting for %s", cwd);
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
		// `stable` on the line, because "deferred, will retry" and "deferred, and
		// nothing changes until an input does" are different facts about this repo —
		// and the second one is why the NEXT call will not appear here at all.
		log.info(
			"auto-cutover deferred for %s (%s)%s: %s",
			cwd,
			after.state,
			outcome.status === "not-ready" && outcome.stable ? ` [blocked: ${outcome.stable}]` : "",
			outcome.reason,
		);
		return after.state === "legacy-fenced" ? "legacy-fenced" : "uncutover";
	} catch (err) {
		// `runCutover` answers with data rather than throwing, so reaching here
		// means something below it did (a profile lock timeout, a git failure).
		// Still not the caller's problem — see the header.
		log.warn("auto-cutover failed for %s: %s", cwd, errMsg(err));
		return "skipped";
	}
}

/** One registered repo's outcome in an {@link autoCutoverAllRepos} pass. */
export interface AutoCutoverSweepEntry {
	readonly repoName: string;
	/** The checkout the attempt ran from — the engine collects the rest itself. */
	readonly root: string;
	readonly state: "cutover" | "legacy-fenced" | "uncutover" | "skipped";
	/**
	 * Whether an attempt actually began, as opposed to a gate short-circuiting.
	 *
	 * The caller's reporting hinges on this and cannot derive it from `state`:
	 * `cutover` is the answer both for a repo this pass switched and for one that
	 * was already switched before it started.
	 */
	readonly attempted: boolean;
	/**
	 * Set when a recorded refusal still applied, so no attempt was made.
	 *
	 * Not derivable from the other two fields — `skipped` + `attempted: false` is
	 * also what a repo with no live checkout, a switched-off repo and an
	 * SQLite-less runtime answer, and only one of those four is something the user
	 * has to act on.
	 */
	readonly blocked?: CutoverBlockRecord;
}

export interface AutoCutoverSweepOptions {
	readonly dbPath?: string;
	readonly nowMs?: number;
	/**
	 * A checkout whose repo should be attempted before the rest — normally the
	 * caller's `cwd`.
	 *
	 * The user is standing in that repo, so if they interrupt the pass, the one
	 * they were most likely waiting on has already been tried. Tolerates a path
	 * belonging to no registered repo (registration failed, or it is not a git
	 * worktree at all): the rest of the roster is swept regardless.
	 */
	readonly preferFirst?: string;
	/** Called with the repo name just before its attempt begins. */
	readonly onAttemptStart?: (repoName: string) => void;
}

/**
 * Runs (or resumes) the cutover for EVERY registered repo on this machine.
 *
 * The asymmetry this removes: `runHistoryImport` has always swept the whole
 * roster while the cutover attempt beside it took only `cwd`, so a user had to
 * open `jolli dashboard` once per repository to move each one onto SQLite —
 * against the module header's whole premise that the switch is automatic. Its
 * side effect is deliberate and worth stating plainly: `jolli enable` in one repo
 * now cuts over the others too. Nothing about a cutover leaves this machine, so
 * there is no more to coordinate for N repos than for one.
 *
 * **Sequential, never parallel.** The repos hold different locks so concurrency
 * would be safe, but each attempt forks git per source and prints through the
 * caller's reporter — N at once means a CPU spike and interleaved output for no
 * latency the user can perceive (the page is already up).
 *
 * Reads the WHOLE roster rather than {@link listActiveRepos}, for the same reason
 * `runHistoryImport` does: a repo filtered out upstream cannot be logged as
 * skipped, and a skip nobody records is exactly the silence this file spent a
 * round of fixes removing. The two predicates below are then applied here, in
 * this order.
 *
 * **Takes no `configDir`, and that is a correctness constraint rather than an
 * omission.** `runCutover` reads the registry through a bare `readRepoRegistry()`
 * and looks the repo up by identity; a sweep that selected from a *different*
 * registry would hand it repos it cannot find and collect `not-ready: repo is not
 * registered` for every one of them — silently, since that is also what a genuine
 * unregistered repo answers. Tests redirect the default registry with an isolated
 * HOME instead. Do not "fix" this by threading `configDir` into the engine
 * without auditing its other callers.
 *
 * Never throws, for the same reason {@link maybeAutoCutover} does not.
 */
export async function autoCutoverAllRepos(
	opts: AutoCutoverSweepOptions = {},
): Promise<ReadonlyArray<AutoCutoverSweepEntry>> {
	if (!canUseDashboardDb()) {
		log.info("skipping the auto-cutover sweep — Node %s has no flag-free node:sqlite", process.versions.node);
		return [];
	}
	let roster: ReadonlyArray<RegisteredRepo>;
	try {
		roster = (await readRepoRegistry()).repos;
	} catch (err) {
		log.warn("auto-cutover sweep could not read the repo registry: %s", errMsg(err));
		return [];
	}
	const entries: AutoCutoverSweepEntry[] = [];
	for (const repo of orderRoster(roster, opts.preferFirst)) {
		// FIRST, and it cannot be folded into `existingWorktrees`: that helper
		// deliberately never returns empty (it falls back to `worktreeRoot`), so a
		// repo whose every checkout is gone is indistinguishable from a healthy one
		// in its return value. Without this the attempt would write a profile into
		// a path that does not exist.
		if (!hasLiveWorktree(repo)) {
			log.info("auto-cutover sweep skipping %s — no registered checkout exists on disk", repo.repoName);
			entries.push({ repoName: repo.repoName, root: repo.worktreeRoot, state: "skipped", attempted: false });
			continue;
		}
		const root = existingWorktrees(repo)[0] as string;
		// The SHARED predicate, never a hand-rolled `readManualDisableFlagSync(root)`.
		// A registry row is one repo IDENTITY while `profile.json` is per CLONE, so
		// the question is `every` checkout, not this one: asking a single root turns
		// "the user switched off one of two clones" into "skip the whole project".
		// It is also deliberately the same predicate `DbBackfill` asks, so "which
		// repos do I import" and "which repos do I cut over" cannot disagree.
		if (isRepoDisabled(repo)) {
			log.info("auto-cutover sweep skipping %s — Jolli is switched off in every checkout", repo.repoName);
			entries.push({ repoName: repo.repoName, root, state: "skipped", attempted: false });
			continue;
		}
		let attempted = false;
		let blocked: CutoverBlockRecord | undefined;
		const state = await maybeAutoCutover(root, {
			...(opts.dbPath ? { dbPath: opts.dbPath } : {}),
			...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
			onAttemptStart: () => {
				attempted = true;
				opts.onAttemptStart?.(repo.repoName);
			},
			onBlocked: (record) => {
				blocked = record;
			},
		});
		entries.push({ repoName: repo.repoName, root, state, attempted, ...(blocked ? { blocked } : {}) });
	}
	return entries;
}

/**
 * The roster with `preferFirst`'s repo moved to the front, if it has one.
 *
 * Matched on the checkout paths rather than by resolving the path's repo
 * identity, which would fork git for an ordering detail — and would have to
 * answer for a `preferFirst` that is not a worktree at all. An unmatched value
 * simply leaves the order alone.
 */
function orderRoster(
	roster: ReadonlyArray<RegisteredRepo>,
	preferFirst: string | undefined,
): ReadonlyArray<RegisteredRepo> {
	if (!preferFirst) return roster;
	const index = roster.findIndex((repo) =>
		(repo.worktrees && repo.worktrees.length > 0 ? repo.worktrees : [repo.worktreeRoot]).some((wt) =>
			sameRecordedRoot(wt, preferFirst),
		),
	);
	if (index <= 0) return roster;
	const preferred = roster[index] as RegisteredRepo;
	return [preferred, ...roster.slice(0, index), ...roster.slice(index + 1)];
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
