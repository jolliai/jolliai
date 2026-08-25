/**
 * The per-day cache in front of the spend axes and the token split.
 *
 * Two halves that must agree: {@link buildRollup} runs on the WRITE side and
 * settles days into `stats_daily`; {@link readAvailableDays} and
 * {@link readRollupSeries} run on the read side and use a settled day instead
 * of recomputing it. Both derive their numbers from {@link ./StatsSeries.ts}
 * and their day boundaries from {@link ./LocalDays.ts}, which is what makes a
 * cached day and a live day the same number rather than two numbers that
 * happen to match.
 *
 * ⚠ The cache is never authoritative. Every function here may answer "not
 * available" and the caller must be able to compute the day itself; deleting
 * every row changes only how long a page takes. That property is the whole
 * safety argument, and it is easy to lose by storing something here that the
 * sources can no longer produce.
 *
 * # How a day expires
 *
 * By asking the sources, not by being told. Each day carries the instant it was
 * built, and every table an axis reads carries the instant its rows were last
 * written; a day is stale when any source row belonging to it was written after
 * that. Both halves of that sentence are filters in the SQL — written after the
 * oldest build, AND dated inside the days being asked about — and the second one
 * is what keeps the check cheap rather than growing with the machine's history
 * (see {@link readSourcesWrittenSince}). The alternative — writers recording "this day changed" as they go —
 * fails the way a ledger fails: one write path that forgets to record leaves a
 * permanently wrong number that nothing detects. A new write path here is
 * visible the moment it lands, because the rows it writes carry stamps.
 *
 * The one thing the sources cannot report is a DELETE — a removed row leaves no
 * stamp behind. That gap is closed from the other side, by deleting the day's
 * cached rows whenever source rows are deleted: a day with no rows is a day
 * that was never computed, which already falls back to computing it. Over-
 * rebuilding is the failure mode there, and it is self-correcting.
 */

import { createLogger, errMsg } from "../Logger.js";
import type { DashboardDbHandle } from "./DashboardDb.js";
import { dbHasUnknownMigrations, inTransaction } from "./DashboardDb.js";
import type { DashboardScope, SeriesDimension } from "./DashboardModel.js";
import { scopeFilter, scopeToRepoIds } from "./DashboardScopeUtil.js";
import { addLocalDays, dayKeyToMidnight, localDayKey, machineTimeZone, startOfLocalDay } from "./LocalDays.js";
import {
	type AxisRow,
	MEMORY_LANDED_AT_MS,
	MEMORY_LANDING_JOINS,
	readAxisRows,
	readDatedUsage,
} from "./StatsSeries.js";

const log = createLogger("StatsRollup");

/**
 * The spend axes, every one of them cacheable.
 *
 * ⚠ DERIVED from a `Record` keyed on `SeriesDimension`, never written out as a
 * list, so adding a dimension is a COMPILE error right here. That is not
 * tidiness. An axis missing from this set is never built — but `buildSeries`
 * still treats every settled day as covered, because the plan is computed once
 * for the whole page and knows nothing about which axis is being drawn. The
 * cache would answer nothing for that kind, the live pass would fill only
 * `plan.live`, and the axis would read ZERO on every cached day: a plausible
 * chart, quietly missing most of its history, with nothing to notice it. A hand-
 * written list type-checks fine when the union grows, which is exactly the
 * failure this shape removes.
 */
const ROLLUP_AXIS_SET: Readonly<Record<SeriesDimension, true>> = {
	model: true,
	agent: true,
	project: true,
	branch: true,
	ticket: true,
	category: true,
};

export const ROLLUP_AXES = Object.keys(ROLLUP_AXIS_SET) as ReadonlyArray<SeriesDimension>;

/** `kind` of the row that records a day was computed. See the DDL. */
export const BUILT_KIND = "built";

/** `kind` of the "Where your tokens went" split. */
export const TOKENS_KIND = "tokens";

/** `series_key`s under {@link TOKENS_KIND}. */
export const TOKEN_SERIES = ["input", "output", "cached"] as const;

export type TokenSeries = (typeof TOKEN_SERIES)[number];

/**
 * Every `kind` this table stores.
 *
 * The axis names come from the dimension union and the other two are invented
 * here, so they share one namespace and must not collide: a dimension called
 * `tokens` would read a day's token split as if it were an axis, silently. The
 * test that pins this is only meaningful because {@link ROLLUP_AXES} is now
 * DERIVED from `SeriesDimension` — against a hand-written list it asserted that
 * the list did not contain a name, which says nothing about the union.
 */
export const ROLLUP_KINDS: ReadonlyArray<string> = [...ROLLUP_AXES, TOKENS_KIND, BUILT_KIND];

/**
 * How far back a day is worth caching.
 *
 * Not a correctness bound — an older day simply computes live, exactly as every
 * day does today. It bounds the work the staleness scan and the build loop can
 * ever do, so that a machine with years of history does not pay for a range
 * nobody opens. The stock ranges (7 / 14 / 30 days) sit well inside it.
 */
export const ROLLUP_HORIZON_DAYS = 90;

/**
 * Days one call may settle.
 *
 * ⚠ This runs inside the writer's lock, on a path an editor's periodic scan
 * reaches, and that caller waits a few hundred milliseconds for the lock at
 * most. Falling behind costs a slower page; holding the lock costs a dropped
 * write. So the budget is deliberately small and the backlog drains across
 * calls — there is always another call.
 */
export const ROLLUP_MAX_DAYS_PER_BUILD = 14;

/** Sentinel `repo_id`: the day, rather than any one repo. Real ids start at 1. */
const SENTINEL_REPO_ID = 0;

interface StaleSourceRow {
	readonly repo_id: number;
	readonly at_ms: number;
	readonly w: number;
}

/**
 * Every source row that BOTH was written after `sinceMs` AND belongs to a day in
 * `[fromMs, toMs)`, with the instant that decides which day that is.
 *
 * One query per side rather than one per axis: the four session-backed axes and
 * the token split all read the same two tables, and the three memory-backed
 * ones all read the same two.
 *
 * ⚠ BOTH bounds are load-bearing, and the day bound is the one that makes this
 * affordable. `sinceMs` is the oldest `built_at_ms` among the days in play, and
 * that value DECAYS: a settled day is never rebuilt, so it keeps the stamp it was
 * settled with, and on a machine older than the horizon the oldest one is ~90 days
 * back. Filtered on the write stamp alone this therefore returned every row
 * written in the last ~90 days — for a heavy user 10^5 `session_usage_events` rows
 * — materialised into JS and handed to `localDayKey` (an `Intl` format call) one by
 * one, on the writer's lock once per `applyToDb` and twice per dashboard render.
 * The module header's claim that a caught-up machine reads nothing was true only
 * of a fresh cache.
 *
 * With the day bound it is true in general, because the two filters are nearly
 * disjoint in the steady state: the bulk of recently-written rows are dated TODAY,
 * and today is never a candidate (it is still accumulating). What survives both is
 * exactly the interesting set — a row dated in the past but written recently: a
 * re-read of an old session, a backfill, a rebase. On a quiet machine that is
 * empty.
 *
 * The bound is on the same expression each row is BUCKETED by, never on the write
 * stamp — the two are different questions, and filtering the day bound on the
 * stamp would drop precisely the rows this exists to find.
 */
function readSourcesWrittenSince(
	db: DashboardDbHandle,
	sinceMs: number,
	fromMs: number,
	toMs: number,
): ReadonlyArray<StaleSourceRow> {
	const sessionSide = db
		.prepare(
			`SELECT s.repo_id, e.responded_at_ms AS at_ms, e.updated_at_ms AS w
			   FROM session_usage_events e JOIN sessions s ON s.event_id = e.session_event_id
			  WHERE e.updated_at_ms > ? AND e.responded_at_ms >= ? AND e.responded_at_ms < ?
			 UNION ALL
			SELECT s.repo_id, s.updated_at_ms AS at_ms, s.written_at_ms AS w
			   FROM sessions s
			  WHERE s.written_at_ms > ? AND s.updated_at_ms >= ? AND s.updated_at_ms < ?`,
		)
		.all(sinceMs, fromMs, toMs, sinceMs, fromMs, toMs) as StaleSourceRow[];
	// The memory side dates a row through `MEMORY_LANDED_AT_MS` — the SAME
	// expression the axes count it with, shared as a fragment rather than restated
	// here, because a restatement is what this used to be and it was wrong for a
	// rewritten commit (see that constant).
	//
	// It deliberately does NOT filter `parent_hash IS NULL`, which is why it
	// composes the fragments instead of reusing `MEMORY_LANDING_CTE`: a write to
	// ANY generation must be visible, since re-grounding one is precisely what
	// moves a row into the set the axes count. Over-invalidating costs one
	// recomputation; the other direction serves a wrong number for ever.
	const memorySide = db
		.prepare(
			`SELECT m.repo_id, ${MEMORY_LANDED_AT_MS} AS at_ms, m.written_at_ms AS w
			   FROM memories m
			   ${MEMORY_LANDING_JOINS}
			  WHERE m.written_at_ms > ?
			    AND ${MEMORY_LANDED_AT_MS} >= ? AND ${MEMORY_LANDED_AT_MS} < ?
			 UNION ALL
			SELECT c.repo_id, c.committed_at_ms AS at_ms, c.written_at_ms AS w
			   FROM commits c
			  WHERE c.written_at_ms > ? AND c.committed_at_ms >= ? AND c.committed_at_ms < ?`,
		)
		.all(sinceMs, fromMs, toMs, sinceMs, fromMs, toMs) as StaleSourceRow[];
	return [...sessionSide, ...memorySide];
}

/** `day -> built_at_ms` for every settled day in `[fromDay, toDay]`. */
function readSentinels(db: DashboardDbHandle, timeZone: string, fromDay: string, toDay: string): Map<string, number> {
	const rows = db
		.prepare(
			`SELECT day, built_at_ms FROM stats_daily
			  WHERE tz = ? AND kind = ? AND repo_id = ? AND day >= ? AND day <= ?`,
		)
		.all(timeZone, BUILT_KIND, SENTINEL_REPO_ID, fromDay, toDay) as ReadonlyArray<{
		day: string;
		built_at_ms: number;
	}>;
	return new Map(rows.map((r) => [r.day, r.built_at_ms]));
}

/**
 * Of `days`, the ones whose cached rows may be used as they stand.
 *
 * A day qualifies when it has been built and no source row belonging to it has
 * been written since. `today` never qualifies, whatever the table holds: it is
 * still accumulating, so a cached copy of it is stale by construction rather
 * than by accident.
 *
 * Days outside the caller's window are ignored, so this is safe to call with a
 * year of day keys — it just answers "none of them" for the ones past the
 * horizon, and the caller computes those live.
 */
export function readAvailableDays(
	db: DashboardDbHandle,
	timeZone: string,
	days: ReadonlyArray<string>,
	nowMs: number,
): ReadonlySet<string> {
	if (days.length === 0) return new Set();
	const today = localDayKey(nowMs, timeZone);
	const candidates = days.filter((d) => d < today).sort();
	const first = candidates[0];
	const last = candidates[candidates.length - 1];
	if (first === undefined || last === undefined) return new Set();

	const sentinels = readSentinels(db, timeZone, first, last);
	if (sentinels.size === 0) return new Set();

	// Bounded by the OLDEST day in play: a row written before every candidate was
	// built cannot have invalidated any of them, so it need not be read at all.
	const oldestBuild = Math.min(...sentinels.values());
	// And bounded again by the candidate days' own span, which is what keeps this
	// scan from growing with the machine's history — see `readSourcesWrittenSince`.
	// Every key here came out of `localDayKey`, and `localMidnight` resolves every
	// real local day — including a spring-forward day whose 00:00 is skipped, which
	// it maps to that day's first existing instant rather than rejecting (that
	// rejection is what used to make these fallbacks reachable, and made a
	// window spanning such a day hang the forward walk before it ever reached
	// here). So `dayKeyToMidnight` round-trips by construction and the fallbacks
	// are unreachable; they are kept as the WIDEST range rather than the narrowest
	// so any residual impossible key degrades to over-reading (one extra scan)
	// instead of silently declaring stale days fresh, or hanging the day step on a
	// not-a-number bound.
	const rangeFromMs = dayKeyToMidnight(first, timeZone) ?? 0;
	const lastStartMs = dayKeyToMidnight(last, timeZone);
	const rangeToMs = lastStartMs === undefined ? Number.MAX_SAFE_INTEGER : addLocalDays(lastStartMs, 1, timeZone);
	// Intersected with what was ASKED for, not just with the range it spans. The
	// sentinel read is bounded by `first`..`last` because that is one indexed scan
	// instead of an `IN` of up to 90 keys — but the range is not the question. Every
	// caller in production passes a CONTIGUOUS window, where the two coincide; a
	// caller that passes two distant days got back every settled day between them,
	// which reads as "these are cached" for days it never mentioned.
	const requested = new Set(candidates);
	const available = new Set([...sentinels.keys()].filter((d) => requested.has(d)));
	for (const row of readSourcesWrittenSince(db, oldestBuild, rangeFromMs, rangeToMs)) {
		const day = localDayKey(row.at_ms, timeZone);
		const builtAt = sentinels.get(day);
		// STRICTLY greater, and `>=` was considered and rejected. `built_at_ms` is
		// captured BEFORE the day's rows are read, so any write this build could have
		// missed carries a stamp at or after it — which leaves exactly one row that
		// slips through: one stamped in the SAME millisecond as `nowMs` that also
		// committed after the read began. That is a sub-millisecond cross-process
		// race whose cost is one cached day serving a stale number until the next
		// write touches it.
		//
		// `>=` closes it and opens something worse. A caller with a coarse or pinned
		// clock (`applyToDb` takes `now` as an option, and both the backfill and the
		// tests supply one) stamps the rows it writes and the day it then settles from
		// the same value, so every settled day reads as stale IMMEDIATELY — the cache
		// silently stops being used, which is the one failure mode with no signal at
		// all. A 1 ms race that costs one stale day beats a comparison that can
		// disable the whole mechanism.
		if (builtAt !== undefined && row.w > builtAt) available.delete(day);
	}
	return available;
}

/**
 * How one window splits between cached days and days that must be computed.
 *
 * ⚠ `live` is what the caller must FILTER on, not merely a hint about the span:
 * `liveFromMs`..`liveToMs` is the enclosing range, so a cached day sitting
 * between two live ones is inside it. A row from such a day would be added on
 * top of the cached copy already counted — the one way this cache can produce a
 * number larger than the truth rather than merely staler.
 */
export interface DayPlan {
	/** Every local day the window covers, in order. */
	readonly dayKeys: ReadonlyArray<string>;
	readonly cached: ReadonlyArray<string>;
	readonly live: ReadonlySet<string>;
	/** Range enclosing every live day; both 0 when none are. */
	readonly liveFromMs: number;
	readonly liveToMs: number;
}

/**
 * Splits `[fromMs, toMs)` into the days that can be read and the ones that must
 * be recomputed.
 *
 * One scan of the cache per request, shared by every card, so the fallback
 * decision cannot come out differently for two figures on the same page.
 */
export function planDays(
	db: DashboardDbHandle,
	timeZone: string,
	fromMs: number,
	toMs: number,
	nowMs: number,
): DayPlan {
	const dayKeys: string[] = [];
	const startByDay = new Map<string, number>();
	for (let cursor = fromMs; cursor < toMs; cursor = addLocalDays(cursor, 1, timeZone)) {
		const key = localDayKey(cursor, timeZone);
		dayKeys.push(key);
		startByDay.set(key, startOfLocalDay(cursor, timeZone));
	}
	const available = readAvailableDays(db, timeZone, dayKeys, nowMs);
	const live = new Set(dayKeys.filter((d) => !available.has(d)));
	let liveFromMs = 0;
	let liveToMs = 0;
	if (live.size > 0) {
		const starts = [...live].map((d) => startByDay.get(d) ?? 0);
		liveFromMs = Math.min(...starts);
		liveToMs = addLocalDays(Math.max(...starts), 1, timeZone);
	}
	return { dayKeys, cached: dayKeys.filter((d) => available.has(d)), live, liveFromMs, liveToMs };
}

interface RollupRow {
	readonly day: string;
	readonly series_key: string;
	readonly value: number;
	readonly cost_usd: number;
}

/**
 * Cached rows for one kind over `days`, summed across the repos in `scope`.
 *
 * Callers must pass only days {@link readAvailableDays} returned; nothing here
 * re-checks that, because the check needs the whole window at once and doing it
 * per read would make the fallback decision inconsistent within one page.
 */
export function readRollupSeries(
	db: DashboardDbHandle,
	timeZone: string,
	kind: string,
	days: ReadonlyArray<string>,
	scope: DashboardScope,
): ReadonlyArray<RollupRow> {
	if (days.length === 0) return [];
	const filter = scopeFilter(scopeToRepoIds(db, scope), "repo_id");
	const placeholders = days.map(() => "?").join(", ");
	return db
		.prepare(
			`SELECT day, series_key, SUM(value) AS value, SUM(cost_usd) AS cost_usd
			   FROM stats_daily
			  WHERE tz = ? AND kind = ? AND day IN (${placeholders})${filter.sql}
			  GROUP BY day, series_key`,
		)
		.all(timeZone, kind, ...days, ...filter.params) as RollupRow[];
}

/** Accumulator key — a repo's contribution to one series on one day. */
function cellKey(repoId: number, seriesKey: string): string {
	return `${repoId}\u0000${seriesKey}`;
}

interface Cell {
	repoId: number;
	seriesKey: string;
	value: number;
	cost: number;
}

function accumulate(rows: ReadonlyArray<AxisRow>): Map<string, Cell> {
	const cells = new Map<string, Cell>();
	for (const row of rows) {
		const key = cellKey(row.repo_id, row.key);
		const cell = cells.get(key);
		if (cell) {
			cell.value += row.tokens;
			cell.cost += row.cost;
		} else {
			cells.set(key, { repoId: row.repo_id, seriesKey: row.key, value: row.tokens, cost: row.cost });
		}
	}
	return cells;
}

/**
 * Recomputes one day from scratch and replaces its cached rows.
 *
 * Whole-day replacement, not an incremental adjustment. Two axes apportion a
 * commit's spend across its topics or its branches, so an incremental update
 * would have to compute a difference against a divisor that itself changed —
 * and an arithmetic slip there accumulates forever with nothing to detect it. A
 * rebuild is self-correcting: whatever was wrong yesterday is right today.
 *
 * The DELETE and the INSERTs share one transaction so a day is never half
 * updated — one axis refreshed beside another still holding last week's values
 * would be worse than an uncached day, because it looks computed.
 */
function buildDay(db: DashboardDbHandle, timeZone: string, day: string, nowMs: number): void {
	const startMs = dayKeyToMidnight(day, timeZone);
	if (startMs === undefined) return;
	const endMs = addLocalDays(startMs, 1, timeZone);
	const allRepos: DashboardScope = { kind: "all" };

	const perKind = new Map<string, Map<string, Cell>>();
	for (const axis of ROLLUP_AXES) {
		perKind.set(axis, accumulate(readAxisRows(db, allRepos, axis, startMs, endMs)));
	}
	const tokenCells = new Map<string, Cell>();
	for (const row of readDatedUsage(db, allRepos, startMs, endMs)) {
		const segments: ReadonlyArray<readonly [TokenSeries, number]> = [
			["input", row.input],
			["output", row.output],
			["cached", row.cached],
		];
		for (const [seriesKey, amount] of segments) {
			const key = cellKey(row.repo_id, seriesKey);
			const cell = tokenCells.get(key);
			if (cell) cell.value += amount;
			else tokenCells.set(key, { repoId: row.repo_id, seriesKey, value: amount, cost: 0 });
		}
	}
	perKind.set(TOKENS_KIND, tokenCells);

	inTransaction(db, () => {
		db.prepare("DELETE FROM stats_daily WHERE tz = ? AND day = ?").run(timeZone, day);
		const insert = db.prepare(
			`INSERT INTO stats_daily (repo_id, tz, day, kind, series_key, value, cost_usd, built_at_ms, updated_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const [kind, cells] of perKind) {
			for (const cell of cells.values()) {
				insert.run(cell.repoId, timeZone, day, kind, cell.seriesKey, cell.value, cell.cost, nowMs, nowMs);
			}
		}
		// Last, and inside the same transaction: its presence is what marks the
		// day usable, so it must not exist without the rows it speaks for.
		insert.run(SENTINEL_REPO_ID, timeZone, day, BUILT_KIND, "", 0, 0, nowMs, nowMs);
	});
}

export interface BuildRollupOptions {
	readonly now?: () => number;
	readonly timeZone?: string;
	readonly maxDays?: number;
}

/**
 * Settles up to {@link ROLLUP_MAX_DAYS_PER_BUILD} days, newest first.
 *
 * Newest first because that is what a reader opens: the stock ranges all end
 * today, so the most recent unsettled day is the one a page is about to ask
 * for. A backlog therefore shortens from the end that matters, and an old gap
 * that nobody looks at can wait indefinitely without costing anyone a slow
 * page.
 *
 * Returns the number of days settled — for logging and tests; no caller should
 * branch on it, since zero is the normal steady state.
 */
export function buildRollup(db: DashboardDbHandle, opts: BuildRollupOptions = {}): number {
	const nowMs = (opts.now ?? Date.now)();
	const timeZone = opts.timeZone ?? machineTimeZone();
	const budget = opts.maxDays ?? ROLLUP_MAX_DAYS_PER_BUILD;
	if (budget <= 0) return 0;

	// Yesterday backwards: today is still accumulating and is never cached.
	const days: string[] = [];
	let cursor = addLocalDays(startOfLocalDay(nowMs, timeZone), -1, timeZone);
	for (let i = 0; i < ROLLUP_HORIZON_DAYS; i++) {
		days.push(localDayKey(cursor, timeZone));
		cursor = addLocalDays(cursor, -1, timeZone);
	}

	const available = readAvailableDays(db, timeZone, days, nowMs);
	const pending = days.filter((d) => !available.has(d)).slice(0, budget);
	let built = 0;
	for (const day of pending) {
		buildDay(db, timeZone, day, nowMs);
		built++;
	}
	if (built > 0) log.debug("settled %d day(s) of stats, %s..%s", built, pending[built - 1], pending[0]);
	return built;
}

/**
 * Forgets the cached days covering `atMs` instants, in every zone.
 *
 * The counterpart to staleness-by-write-stamp: a deleted row leaves nothing
 * behind to notice, so whoever deletes says so here. Every zone, because a
 * single instant falls on different calendar days in different ones and this
 * process does not know which zones have cached rows — the table is small and
 * a day dropped needlessly only costs one recomputation.
 */
export function forgetRollupDays(db: DashboardDbHandle, atMs: ReadonlyArray<number>): void {
	if (atMs.length === 0) return;
	const zones = db.prepare("SELECT DISTINCT tz FROM stats_daily").all() as ReadonlyArray<{ tz: string }>;
	if (zones.length === 0) return;
	// One statement per ZONE rather than per zone-day. This is reached once per
	// session event whose usage rows are being replaced, so a batch runs it
	// hundreds of times; there is normally exactly one zone, and the day set is
	// small, so the `IN` collapses the whole call to a single DELETE.
	for (const { tz } of zones) {
		const days = [...new Set(atMs.map((ms) => localDayKey(ms, tz)))];
		db.prepare(`DELETE FROM stats_daily WHERE tz = ? AND day IN (${days.map(() => "?").join(", ")})`).run(
			tz,
			...days,
		);
	}
}

/**
 * Runs {@link buildRollup} as a side effect of a write, swallowing failures.
 *
 * The rollup is derived, so a build that throws must not fail the write that
 * triggered it: the caller's events are already durable and the only cost of
 * skipping is a slower page.
 *
 * ⚠ At `info`, NOT `debug`. The default file threshold is `info`, so a `debug`
 * line here is written nowhere — which made this the exact failure the note
 * below warns about, silent in the one place someone would look. `info` reaches
 * `debug.log` while staying off the terminal in CLI mode (see `createLogger`),
 * which is what a derived-data miss deserves: recorded, not shown.
 *
 * The failure worth catching this way is a STANDING one, and the likeliest is
 * structural rather than transient: {@link ./DashboardDb.ts}'s `inTransaction`
 * issues `BEGIN IMMEDIATE`, which SQLite refuses inside an open transaction, so
 * a caller that ever wraps `applyToDb` in one turns every build here into a
 * throw. Nothing would break — the page just recomputes every day forever, and
 * without a line in the log there is nothing to connect that to a cause.
 */
export function buildRollupQuietly(db: DashboardDbHandle, opts: BuildRollupOptions = {}): void {
	try {
		// A build older than the file does not maintain this cache. Nothing here
		// refuses such a build — that is right for the source tables — but the cache
		// is different: its expiry test reads the write stamps of every source table,
		// and a build that does not know a table added since cannot see that table
		// change. It would settle a day that is already incomplete and then keep
		// answering with it. Declining to write costs a recomputation per render;
		// writing costs a wrong number with no signal. The current build that next
		// writes rebuilds the day.
		//
		// The question is "has a newer build written here", and it is now asked of the
		// migration log by name rather than of a version number. The number could only
		// answer by proxy: it moved with DDL, so it missed a newer build whose change
		// added no columns, and fired for one whose additions this build can read
		// perfectly well.
		if (dbHasUnknownMigrations(db)) {
			// The wording is strong because the state is not the rare one the old
			// sentence implied: a database that has ever been opened by a RELEASED
			// build carries migration names a development line may not have — and a
			// machine running mixed surface versions (the whole point of the
			// `dist-paths` version race) reaches that state routinely. While it holds,
			// nothing settles into `stats_daily` and every dashboard render recomputes
			// its full window.
			//
			// ⚠ `info`, never `warn`, and that is the same rule `SlowQueryLog`
			// documents at length. `warn` goes to stderr regardless of
			// `setSilentConsole` (see `Logger.createLogger`), and this line is NOT on a
			// dashboard path: `applyStatsEvents` reaches it from every producer —
			// `ProducerHooks.safeApply` passes no `skipRollup` — so a `warn` here
			// prints to the terminal of `jolli recall`, onto the MCP server's stderr
			// (and thereby into an agent's context), and out of the StopHook. Those
			// processes are short-lived, so "once per process" would have been once per
			// invocation. A warning that fires on every recall for a version-mixed
			// install is not a signal. Visibility belongs to the surface that asked:
			// `jolli doctor --schema-log` names the migrations and says what is off.
			log.info(
				"stats rollup is OFF: the database carries migrations this build does not know, so cached daily stats are never written and every dashboard render recomputes its full window. `jolli doctor --schema-log` lists the unknown names.",
			);
			return;
		}
		buildRollup(db, opts);
	} catch (err) {
		log.info("stats rollup skipped: %s", errMsg(err));
	}
}
