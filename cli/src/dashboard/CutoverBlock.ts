/**
 * CutoverBlock — the one cutover refusal that ANOTHER ATTEMPT CANNOT CHANGE, and
 * the witness that decides when it stops applying.
 *
 * `runCutover`'s two import refusals (`no-summary-rows`, `stored-nothing`) are
 * not failures in the sense the rest of the engine's `not-ready` answers are. A
 * moved tip, a busy lock, a git blip: those converge on the next attempt, which
 * is why every foreground caller is deliberately unthrottled. These two do not.
 * They say "the branch lists artifacts and the import took none of them", and
 * that is a property of the tip and of this build's importer — so the identical
 * attempt produces the identical refusal, and a repo in that state re-pays a full
 * re-import on every bare `jolli` and every `jolli dashboard`, forever, once per
 * such repo on the machine (`autoCutoverAllRepos` sweeps the whole roster).
 *
 * **What is stored is a memo, not a throttle.** The distinction is the whole
 * point. A time window and a consecutive-failure count are both approximations
 * of the question "would another attempt answer differently?", and both can be
 * wrong in the direction that matters: they suppress a retry that WOULD now
 * succeed, because neither can notice that the inputs changed. `AUTO_CUTOVER_RETRY_MS`
 * was removed from the foreground callers for exactly that reason and re-adding
 * it there is a review blocker. A witness cannot be wrong that way: it names the
 * inputs the refusal was a function of, so "unchanged" is a proof rather than a
 * guess, and the moment anything moves the record is discarded and the attempt
 * runs with no window at all.
 *
 * **The witness is complete, and that rests on a design choice made elsewhere.**
 * The refusal reads three things: the pinned tips' contents (covered exactly by
 * the tip sha), the importer's own code (covered by the core version), and the
 * import's row counters. That third one would break the memo if the counters
 * described CHANGE — a converged re-run would then report zero and refuse a repo
 * whose rows were all already in place, making the refusal depend on database
 * state that grows under it. `storedNothing` deliberately excludes
 * `updated` / `skipped` / `pruned` for precisely that reason ("they count changes
 * and non-events, not rows written"), so `nodes` and its siblings are what the
 * run WROTE and a re-run over an unchanged tip reports the same numbers. Do not
 * widen `storedNothing` to a change-counter without deleting this module.
 *
 * **Performance is the smaller half of why this exists.** A repo answering
 * either code is BROKEN, not slow — nothing will ever import from it — and today
 * that state has no voice anywhere: the sweep prints "not switched this time" and
 * `--status` says `uncutover`, which is also what a perfectly healthy repo that
 * has simply not been swept yet says. The record is what lets those two surfaces
 * name the refusal and point at a repair. Skipping silently would trade a
 * repeated cost for a permanent silence, which is the failure this file's history
 * is made of.
 *
 * Stored in `repo_state`, key `cutover-blocked` — a per-repo `(repo_id, key,
 * value)` row whose `key` carries no constraint, so adding one is an INSERT and
 * `DASHBOARD_SCHEMA_VERSION` does not move (same reasoning as
 * {@link ../dashboard/ImportState.IMPORT_STATE_KEY}). Deliberately NOT a
 * `profile.json` field: that file is a cross-language, cross-version surface
 * (IntelliJ's `RepoProfileBridge` deserialises it directly, and older CLI builds
 * read it) and it has to stay readable by paths with no SQLite at all, whereas
 * this question is only ever asked when `canUseDashboardDb()` is already true and
 * every other piece of cutover bookkeeping is in the database already.
 */

import { createLogger } from "../Logger.js";
import type { DashboardDbHandle } from "./DashboardDb.js";

const log = createLogger("CutoverBlock");

/** The `repo_state` key. */
export const CUTOVER_BLOCK_KEY = "cutover-blocked";

/**
 * Which import refusal blocked the repo.
 *
 * Only the two refusals `runCutover` asks of the IMPORT are here. The step-3
 * containment compare is a REPORT and refuses nothing (restoring its veto is a
 * review blocker), and every other `not-ready` answer is transient by nature, so
 * neither has a code and neither may acquire one — a code is a claim that
 * retrying is pointless.
 */
export type CutoverBlockCode = "no-summary-rows" | "stored-nothing";

/** The record stored at {@link CUTOVER_BLOCK_KEY}. */
export interface CutoverBlockRecord {
	readonly code: CutoverBlockCode;
	/** The engine's own sentence, so a surface can print WHY without re-deriving it. */
	readonly reason: string;
	/** {@link cutoverBlockWitness} of the attempt that produced this refusal. */
	readonly witness: string;
	/** Epoch ms of that attempt — the "since when" a status line needs. */
	readonly at: number;
}

const BLOCK_CODES = new Set<string>(["no-summary-rows", "stored-nothing"]);

/**
 * This build's core version — the second half of the witness.
 *
 * `__CLI_PKG_VERSION__`, never `__PKG_VERSION__`: a surface's own release number
 * would make the Claude plugin's 1.0.x and a strictly newer 0.99.x core compare
 * backwards, the same trap the daemon handshake documents. Vite and esbuild both
 * define it, so only a raw `tsx` run against the source tree falls back to `dev`
 * — stable across such runs, so the memo still works there; it just cannot tell
 * two source trees apart. That is the right way round: a developer editing the
 * importer is also the one person who can type `jolli cutover` to bypass this.
 */
function coreVersion(): string {
	if (typeof __CLI_PKG_VERSION__ !== "undefined") return __CLI_PKG_VERSION__;
	/* v8 ignore next -- the define is present under vite, esbuild and vitest alike; only a bare tsx run reaches this */
	return "dev";
}

/**
 * The inputs the refusal was a function of, as one comparable string.
 *
 * Sorted by root, because the source order is `collectSources`' lock-acquisition
 * order and a re-listing must not read as a changed input. `NO_ORPHAN_TIP` folds
 * in as the empty tip it already is, so a source that gains or loses its branch
 * changes the witness — which is exactly a changed input.
 */
export function cutoverBlockWitness(sources: ReadonlyArray<{ readonly root: string; readonly tip: string }>): string {
	const pairs = sources.map((s) => `${s.root}@${s.tip}`).sort();
	return [coreVersion(), ...pairs].join("|");
}

/** Reads the record for `repoId` on an already-open handle. */
export function readCutoverBlockRow(db: DashboardDbHandle, repoId: number): CutoverBlockRecord | null {
	const row = db
		.prepare("SELECT value FROM repo_state WHERE repo_id = ? AND key = ?")
		.get(repoId, CUTOVER_BLOCK_KEY) as { value: string } | undefined;
	if (!row) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.value);
	} catch {
		// Unreadable → "no block", which costs one attempt. The opposite default
		// would let a corrupt value stop a healthy repo from ever cutting over, and
		// nothing here is worth that: the attempt is what re-derives the truth.
		log.warn("ignoring an unparseable cutover-blocked record for repo %d", repoId);
		return null;
	}
	const rec = parsed as Partial<CutoverBlockRecord>;
	if (
		typeof rec.code !== "string" ||
		!BLOCK_CODES.has(rec.code) ||
		typeof rec.reason !== "string" ||
		typeof rec.witness !== "string" ||
		typeof rec.at !== "number"
	) {
		// Same default as above, and the same reason. A code this build does not
		// know is included on purpose: a newer build may block on something this one
		// can still get past, and the safe reading of "I do not understand why you
		// stopped" is to try.
		log.warn("ignoring a malformed cutover-blocked record for repo %d", repoId);
		return null;
	}
	return { code: rec.code as CutoverBlockCode, reason: rec.reason, witness: rec.witness, at: rec.at };
}

/** Upserts the record. */
export function writeCutoverBlockRow(db: DashboardDbHandle, repoId: number, record: CutoverBlockRecord): void {
	db.prepare(
		`INSERT INTO repo_state (repo_id, key, value) VALUES (?, ?, ?)
		 ON CONFLICT(repo_id, key) DO UPDATE SET value = excluded.value`,
	).run(repoId, CUTOVER_BLOCK_KEY, JSON.stringify(record));
}

/** Removes the record — "this repo is not known to be blocked". */
export function clearCutoverBlockRow(db: DashboardDbHandle, repoId: number): void {
	db.prepare("DELETE FROM repo_state WHERE repo_id = ? AND key = ?").run(repoId, CUTOVER_BLOCK_KEY);
}
