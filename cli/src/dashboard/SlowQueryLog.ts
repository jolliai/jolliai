/**
 * Slow-query logging for the dashboard database.
 *
 * `node:sqlite` is SYNCHRONOUS, so a slow statement is not a slow I/O wait that
 * something else can fill — it is the whole process stopped. On the dashboard
 * server that is the request; inside a git hook it is the commit. Nothing in the
 * product could say which statement it was, so every investigation started by
 * re-deriving it with an ad-hoc harness against a copy of a real database. This
 * makes the database say so itself.
 *
 * It exists because the answer is never guessable from the SQL. Two measured
 * examples from this schema, both a single expression away from their fast form
 * and neither visibly suspicious:
 *
 *   - the spend axes' `EXISTS (…) AND (SELECT SUM(…) …)` cover test — a
 *     correlated AGGREGATE, re-run per candidate row: **1008 ms**, against 23 ms
 *     for the same question asked as a grouped CTE.
 *   - `readSessionAggregates`' two-table join, whose index covered the join
 *     columns but not the column it SELECTs, so the planner fell back to a
 *     whole-repo scan: **~2.1 s**, against 30 ms with a covering index.
 *
 * ## The four decisions in here
 *
 * **`info`, not `warn`.** This wraps EVERY dashboard open, and most of them are
 * not the dashboard: `StatsWriter` runs from `post-commit`, `SessionStart` and
 * the editor tick. `warn` goes to stderr even in CLI mode (see `createLogger`),
 * so a slow write would print SQL into the terminal of someone running `git
 * commit`. `info` reaches `debug.log` and stops there — recorded, not shown,
 * the same call `buildRollupQuietly` makes for the same reason.
 *
 * **Parameters are never logged.** They carry worktree paths, commit hashes and
 * branch names; the SQL alone identifies the statement, which is the whole job.
 * The parameter COUNT is logged, because a mismatch there is a real bug shape
 * and the count is not itself content.
 *
 * **Every occurrence is logged, with no per-statement throttle.** Repetition is
 * not noise here, it is the finding: coaching ran one 1.4 s read twice per
 * render, and `forgetRollupDays` reached `cachedZones` once per session in a
 * backfill — both are invisible in a deduplicated log and obvious in a raw one.
 * A statement over the threshold is already rare by construction; if it is not,
 * that is the thing to fix.
 *
 * **A throw is timed too** (`finally`, not a trailing call). A statement that
 * spends four seconds and then fails is worth exactly as much as one that
 * spends four seconds and succeeds, and the error alone does not carry the
 * duration.
 */

import { createLogger } from "../Logger.js";
// Type-only, so this closes no runtime cycle with `DashboardDb.ts` (which imports
// this module for real) — and it is what makes the guarantee below a compile
// error rather than a comment. A local structural restatement of these two
// interfaces cannot notice the day one of them grows a member.
import type { DashboardDbHandle, DashboardStatement } from "./DashboardDb.js";

const log = createLogger("SlowQuery");

/**
 * Default threshold. 200 ms is chosen against what this schema's reads actually
 * cost: the whole stats model builds in ~260 ms when nothing is pathological and
 * its individual statements are single-digit to low-tens of ms, so 200 ms cannot
 * fire for a healthy query while every regression measured on this database
 * (1008 ms, 1345 ms, 2.1 s) clears it by 5x or more.
 */
export const DEFAULT_SLOW_QUERY_MS = 200;

/** How much of the statement text reaches the log. */
const SQL_LOG_LIMIT = 240;

/**
 * Threshold in milliseconds, or `null` to disable logging entirely.
 *
 * `JOLLI_SLOW_SQL_MS` overrides it for one run — `0` logs every statement (what
 * you want while profiling a single command), `off` silences it. An
 * unparseable value falls back to the default rather than disabling: a typo in
 * a debugging env var must not silently switch off the thing being debugged.
 */
export function resolveSlowQueryThresholdMs(env: NodeJS.ProcessEnv = process.env): number | null {
	const raw = env.JOLLI_SLOW_SQL_MS?.trim();
	if (raw === undefined || raw === "") return DEFAULT_SLOW_QUERY_MS;
	if (raw.toLowerCase() === "off") return null;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SLOW_QUERY_MS;
}

/**
 * One line's worth of SQL: whitespace collapsed, truncated.
 *
 * These statements are written as indented multi-line template literals, so the
 * raw text would spread one log entry over twenty lines and bury the timing.
 * Truncation keeps the PREFIX because that is what identifies the statement —
 * `SELECT s.repo_id, e.responded_at_ms …` is already unambiguous among the
 * handful of readers here.
 */
export function condenseSql(sql: string): string {
	const flat = sql.replace(/\s+/g, " ").trim();
	return flat.length > SQL_LOG_LIMIT ? `${flat.slice(0, SQL_LOG_LIMIT)}…` : flat;
}

export interface SlowQueryOptions {
	/** Milliseconds, or `null` to return the handle unwrapped. */
	readonly thresholdMs?: number | null;
	/** `ro` / `rw` — which kind of open this was, so a hook write is legible beside a page read. */
	readonly role?: string;
	/** Injectable for tests; `performance.now` in production. */
	readonly now?: () => number;
	/** Injectable for tests. */
	readonly onSlow?: (entry: SlowQueryEntry) => void;
}

export interface SlowQueryEntry {
	readonly ms: number;
	readonly method: "all" | "get" | "run" | "exec";
	readonly sql: string;
	readonly params: number;
	readonly role: string;
	/** Rows returned by `all`; absent for the other methods. */
	readonly rows?: number;
}

function defaultSink(entry: SlowQueryEntry): void {
	const rows = entry.rows === undefined ? "" : ` rows=${entry.rows}`;
	log.info(
		"%dms %s [%s] params=%d%s :: %s",
		Math.round(entry.ms),
		entry.method,
		entry.role,
		entry.params,
		rows,
		entry.sql,
	);
}

/**
 * Wraps a database handle so statements slower than the threshold are logged.
 *
 * Returns the handle UNCHANGED when logging is off, so the disabled path costs
 * nothing at all — not even a property lookup through a wrapper. When it is on,
 * the cost of a fast statement is two `performance.now()` calls and one
 * comparison, which is beneath the resolution of anything this measures.
 *
 * ⚠ The wrapper is structural, not a subclass, and it exposes exactly the three
 * members `DashboardDbHandle` declares. If that interface ever grows one
 * (`iterate`, `backup`, `function`), it must be added here in the same change or
 * callers reach a handle that silently lacks it — so the object below is
 * annotated with the REAL interface and returned without a cast, which turns
 * that omission into a compile error here. The earlier shape — a
 * `<T extends Handle>` generic returning `wrapped as T` against a local copy of
 * the interface — could not deliver that: `as T` is a downcast assertion TypeScript
 * always permits, so a new member type-checked clean and failed at runtime, which
 * is the one outcome this note promised it would not.
 */
export function instrumentDashboardDb(db: DashboardDbHandle, options: SlowQueryOptions = {}): DashboardDbHandle {
	// `in`, not `??`: `null` is the caller's way of saying "off", and `??` treats
	// it as absent — so `{ thresholdMs: null }` would resolve the env default and
	// instrument the handle, which is the exact opposite of what was asked.
	const thresholdMs = "thresholdMs" in options ? options.thresholdMs : resolveSlowQueryThresholdMs();
	if (thresholdMs === null || thresholdMs === undefined) return db;
	const now = options.now ?? (() => performance.now());
	const sink = options.onSlow ?? defaultSink;
	const role = options.role ?? "rw";

	const timed = <R>(method: SlowQueryEntry["method"], sql: string, params: number, call: () => R): R => {
		const started = now();
		let rows: number | undefined;
		try {
			const result = call();
			if (method === "all" && Array.isArray(result)) rows = result.length;
			return result;
		} finally {
			const ms = now() - started;
			if (ms >= thresholdMs) {
				sink({ ms, method, sql: condenseSql(sql), params, role, ...(rows === undefined ? {} : { rows }) });
			}
		}
	};

	const wrapped: DashboardDbHandle = {
		exec: (sql: string) => timed("exec", sql, 0, () => db.exec(sql)),
		close: () => db.close(),
		prepare: (sql: string): DashboardStatement => {
			const stmt = db.prepare(sql);
			return {
				all: (...params) => timed("all", sql, params.length, () => stmt.all(...params)),
				get: (...params) => timed("get", sql, params.length, () => stmt.get(...params)),
				run: (...params) => timed("run", sql, params.length, () => stmt.run(...params)),
			};
		},
	};
	return wrapped;
}
