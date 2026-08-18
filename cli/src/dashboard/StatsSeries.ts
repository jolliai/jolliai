/**
 * The row readers behind the per-day spend series, in one place because two
 * sides now run them: {@link ./DashboardQuery.ts} to answer a live request, and
 * the rollup builder in {@link ./StatsRollup.ts} to pre-compute a settled day.
 *
 * A cached day and a live day have to come out equal to the last decimal, so
 * they read through the SAME query rather than two that agree today. The
 * apportioning in the `category` and `branch` axes is what makes that more than
 * a tidiness rule: both divide by a window `COUNT(*)`, so a second query with a
 * differently-shaped join produces plausible numbers that are quietly wrong.
 *
 * Rows carry `repo_id` because the rollup stores per repo — a single-repo view
 * filters, an all-repos view sums, and neither needs a second cache. The live
 * path ignores the column.
 */

import type { DashboardDbHandle } from "./DashboardDb.js";
import type { DashboardScope, SeriesDimension } from "./DashboardModel.js";
import { scopeFilter, scopeToRepoIds } from "./DashboardScopeUtil.js";

/**
 * Whether a session's per-response rows account for ALL of its tokens — the test
 * that decides which of the two arms counts it, for a query whose `sessions` is
 * aliased `s`.
 *
 * The spend axes read `session_usage_events` (one row per model response, each
 * with its own instant) so that a conversation spanning days contributes to each
 * of them. Only the Claude parser reports per-response usage, so every other
 * source has nothing but a session-level total under a single timestamp and is
 * still placed by it.
 *
 * ⚠ This used to be `NOT EXISTS (…)` — "does this session have any event rows" —
 * and that is an EXISTENCE test standing in for a COMPLETENESS one. The
 * difference is silent data loss, measured on a real database: one session of
 * 2,048,519 tokens / $18.73 had exactly ONE event row worth 52,020 tokens, so it
 * was excluded from the fallback arm while contributing 2.5% of itself to the
 * events arm — 97.5% of its spend appeared nowhere on the page. Across a 30-day
 * window that was 2,775,239 tokens and $23.39 missing from the Tokens card, the
 * Spend headline and every bar.
 *
 * A partial row set is reachable by construction and is not a parser defect:
 *   - `projectSession` REPLACES a session's rows wholesale, so a producer whose
 *     read was cut short by a `beforeTimestamp` cutoff writes only its slice.
 *   - `projectCommitSummary` then restores `sessions` and `session_model_usage`
 *     to the full figures (they are equal, to the token, on the measured
 *     database) but has no `session_usage_events` write at all — so the one
 *     table the charts read is the only one nothing repairs.
 * Both are writer-side facts a read must survive rather than trust.
 *
 * So the rule is: **a session is counted by its events only if its events are
 * complete**, and by its session-level total otherwise. That is never worse than
 * either alternative — the total is always right, and the finer per-day
 * distribution is kept for every session whose rows do add up (55 of the 59
 * measured).
 *
 * `>=`, not `=`: if the rows somehow exceed the stored total, they are the more
 * detailed record and are trusted.
 *
 * ⚠ The `EXISTS` half is not redundant, and a test caught its absence. Written as
 * the sum comparison alone, a session with NO rows and zero tokens compares
 * `0 >= 0` — "covered" — and is counted by an events arm that has nothing to
 * contribute, so it vanishes from the axis entirely. The fallback arm would have
 * emitted a zero-token row, and that row is what registers the series KEY: a
 * `cursor` session with no usage data is a real agent that ran, and dropping it
 * silently removes it from the agent axis's legend. "The events are the whole
 * story" presupposes that there ARE events; say so.
 *
 * ⚠ The two arms must use EXACTLY this predicate and its negation. They are
 * complements, which is what makes the union neither double-count nor drop: a
 * third spelling on either side re-opens one of the two failures.
 */
const EVENTS_COVER_SESSION = `EXISTS (SELECT 1 FROM session_usage_events e0
	                                   WHERE e0.session_event_id = s.event_id)
	                         AND (SELECT COALESCE(SUM(e2.input_tokens + e2.output_tokens + e2.cached_tokens), 0)
	                                FROM session_usage_events e2
	                               WHERE e2.session_event_id = s.event_id)
	                             >= s.input_tokens + s.output_tokens + s.cached_tokens`;

/** The events arm's guard: count these rows only when they are the whole story. */
const HAS_DATED_USAGE = `(${EVENTS_COVER_SESSION})`;

/** The fallback arm's guard — the exact negation, never a separate spelling. */
const NO_DATED_USAGE = `NOT (${EVENTS_COVER_SESSION})`;

/**
 * The two joins the landing rule needs, for a query whose `memories` is aliased
 * `m`: the memory's own commit as `cm`, and whichever live commit aliases it as
 * `al`.
 *
 * Exported as a fragment because {@link MEMORY_LANDED_AT_MS} is only meaningful
 * with them in scope, and a caller that spells the alias sub-select itself is
 * one edit away from spelling it differently — see that constant for what that
 * costs.
 */
export const MEMORY_LANDING_JOINS = `LEFT JOIN commits cm ON cm.repo_id = m.repo_id AND cm.hash = m.commit_hash
	  LEFT JOIN (
	      SELECT a.repo_id, a.target_hash, c.hash AS live_hash, MAX(c.committed_at_ms) AS at_ms
	        FROM commit_aliases a
	        JOIN commits c ON c.repo_id = a.repo_id AND c.hash = a.old_hash
	       GROUP BY a.repo_id, a.target_hash
	  ) al ON al.repo_id = m.repo_id AND al.target_hash = m.commit_hash`;

/**
 * WHICH DAY a memory's spend belongs to — the single expression every side of
 * the cache must date a memory by, valid wherever {@link MEMORY_LANDING_JOINS}
 * is in scope.
 *
 * ⚠ Its own constant because SEVERAL places ask this question and they are not
 * allowed to answer it differently: the axes (which count the memory), the
 * rollup's staleness test (which decides whose cached day just went stale), and
 * every write path that has to forget a day outright — deletes, re-grounding and
 * aliasing in `SotWrite`, plus the commit prune in `DbBackfill`. Counting them
 * here was itself a hazard: the count went stale before the list did, and the
 * prune was reached LAST, having restated the rule by hand in the meantime.
 *
 * The alias term is what makes them disagree if it is dropped — the rollup's
 * memory side used to be
 * `COALESCE(c.committed_at_ms, m.commit_date_ms)`, which for a REWRITTEN commit
 * is a different day entirely: the memory's own commit row is gone, so that
 * spelling fell through to `commit_date_ms` — an AUTHOR date, measured up to 400
 * days from the committer date in this repo's own rebase fixture — while the axis
 * counted the memory on the aliasing commit's committer date. The staleness test
 * then marked a day nothing was drawn on and left the day that really changed
 * serving its old numbers, permanently, since an old day gets no further writes.
 */
export const MEMORY_LANDED_AT_MS = `COALESCE(cm.committed_at_ms, al.at_ms, m.commit_date_ms)`;

/**
 * Where a memory's spend LANDS on the calendar, following a rewritten commit.
 *
 * Lives here rather than in the page because the rollup builds its cached days
 * through {@link readAxisRows} too: a landing rule that differs between the two
 * would settle a day under one attribution and serve it under another.
 *
 * `parent_hash IS NULL` inside the CTE is not a filter the callers could add
 * afterwards — `memories` holds one row per GENERATION, so a re-summarised
 * commit has several, and the window `COUNT(*)` that apportions the axis would
 * count them all. It is also why the staleness test cannot reuse this CTE and
 * composes the two fragments above instead: it must see a write to ANY
 * generation, since re-grounding one is exactly what moves a row into this set.
 */
export const MEMORY_LANDING_CTE = `WITH memory_landing AS (
	SELECT m.repo_id, m.commit_hash,
	       COALESCE(cm.hash, al.live_hash, m.commit_hash) AS live_hash,
	       ${MEMORY_LANDED_AT_MS} AS at_ms
	  FROM memories m
	  ${MEMORY_LANDING_JOINS}
	 WHERE m.parent_hash IS NULL
)`;

/**
 * The landing day of one memory row, as a standalone query returning `at_ms`.
 *
 * For the write paths: a row about to be deleted, re-grounded or re-aliased has
 * to be asked which cached day it contributes to BEFORE the change, because a
 * deletion leaves no write stamp and neither `parent_hash` nor `commit_aliases`
 * carries one at all. Placeholders are `(repo_id, commit_hash)`.
 *
 * ⚠ It also answers AFTER a change, and `pruneUnreachableCommits` is the caller
 * that needs it that way: deleting a commit row moves its memory to whichever
 * term wins next (`al.at_ms`, then `commit_date_ms`), and asking afterwards is how
 * that caller learns the destination day without knowing which term that is.
 * Restating the rule instead — as a bare `commit_date_ms`, which reads like the
 * obvious fallback — silently skips the alias term, i.e. exactly the rewritten
 * commit a prune is about.
 *
 * No `parent_hash IS NULL` here, deliberately: the re-grounding caller asks about
 * rows that are still parked as children, and `(repo_id, commit_hash)` is the
 * PRIMARY KEY, so the answer is one row either way.
 */
export const MEMORY_LANDED_AT_SQL = `SELECT ${MEMORY_LANDED_AT_MS} AS at_ms
	  FROM memories m
	  ${MEMORY_LANDING_JOINS}
	 WHERE m.repo_id = ? AND m.commit_hash = ?`;

/**
 * The same landing rule read from the COMMIT end: "which memory belongs to this
 * commit". Joins as `JOIN memories m ON m.repo_id = c.repo_id AND (${MEMORY_FOR_COMMIT})`,
 * with the commit aliased `c`.
 *
 * **Two spellings of one rule is a deliberate, measured exception.** The CTE
 * exposes `live_hash` as a COALESCE — a computed column SQLite cannot index — so
 * an axis entering from `commits` and joining `ml.live_hash = c.hash` re-scans
 * the materialised CTE per commit: 3,146 ms for the branch axis on a 165 MB
 * database, against 1.1 ms for this predicate. The axes that keep the CTE join
 * it on `commit_hash`, a real column, and measure 38 ms.
 *
 * The naive repair is wrong in both directions and both were measured: a plain
 * `m.commit_hash = c.hash` drops a rewritten commit's memory outright, while
 * adding a bare `OR c.hash = al.target_hash` double-counts it until
 * `pruneUnreachableCommits` sweeps. The `NOT EXISTS` is what closes that.
 */
const MEMORY_FOR_COMMIT = `m.commit_hash = c.hash
	     OR (m.commit_hash = (SELECT a.target_hash FROM commit_aliases a
	                           WHERE a.repo_id = c.repo_id AND a.old_hash = c.hash)
	         AND NOT EXISTS (SELECT 1 FROM commits c2
	                          WHERE c2.repo_id = c.repo_id AND c2.hash = m.commit_hash))`;

/**
 * Token segments placed on the day they were actually spent.
 *
 * The same UNION the spend axes use, kept in one place because the guard on the
 * fallback side is the easy half to forget: without {@link NO_DATED_USAGE}
 * every Claude session is counted twice, once as its responses and once as its
 * total.
 */
export interface DatedUsageRow {
	readonly repo_id: number;
	readonly bucket_at_ms: number;
	readonly input: number;
	readonly output: number;
	readonly cached: number;
}

export function readDatedUsage(
	db: DashboardDbHandle,
	scope: DashboardScope,
	fromMs: number,
	toMs: number,
): ReadonlyArray<DatedUsageRow> {
	const filter = scopeFilter(scopeToRepoIds(db, scope), "s.repo_id");
	return db
		.prepare(
			`SELECT s.repo_id, e.responded_at_ms AS bucket_at_ms, e.input_tokens AS input,
			        e.output_tokens AS output, e.cached_tokens AS cached
			   FROM session_usage_events e JOIN sessions s ON s.event_id = e.session_event_id
			  WHERE e.responded_at_ms >= ? AND e.responded_at_ms < ?${filter.sql} AND ${HAS_DATED_USAGE}
			 UNION ALL
			SELECT s.repo_id, s.updated_at_ms AS bucket_at_ms, s.input_tokens AS input,
			        s.output_tokens AS output, s.cached_tokens AS cached
			   FROM sessions s
			  WHERE s.updated_at_ms >= ? AND s.updated_at_ms < ?${filter.sql} AND ${NO_DATED_USAGE}`,
		)
		.all(fromMs, toMs, ...filter.params, fromMs, toMs, ...filter.params) as DatedUsageRow[];
}

/** One contribution to a spend axis: a keyed amount at an instant. */
export interface AxisRow {
	readonly repo_id: number;
	readonly bucket_at_ms: number;
	readonly key: string;
	readonly tokens: number;
	readonly cost: number;
}

/**
 * Every row feeding one spend axis over `[fromMs, toMs)`.
 *
 * `dimension` is the EFFECTIVE axis — the caller has already resolved the
 * below-memory-tier fallback, which is a display decision and has no business
 * reaching a cache: a repo that crosses the tier later must not find its stored
 * `branch` days holding model data.
 */
export function readAxisRows(
	db: DashboardDbHandle,
	scope: DashboardScope,
	dimension: SeriesDimension,
	fromMs: number,
	toMs: number,
): ReadonlyArray<AxisRow> {
	if (dimension === "model") {
		const filter = scopeFilter(scopeToRepoIds(db, scope), "s.repo_id");
		return db
			.prepare(
				`SELECT s.repo_id, e.responded_at_ms AS bucket_at_ms, e.model AS key,
				        e.input_tokens + e.output_tokens + e.cached_tokens AS tokens,
				        COALESCE(e.est_cost_usd, 0) AS cost
				   FROM session_usage_events e JOIN sessions s ON s.event_id = e.session_event_id
				  WHERE e.responded_at_ms >= ? AND e.responded_at_ms < ?${filter.sql} AND ${HAS_DATED_USAGE}
				 UNION ALL
				SELECT s.repo_id, s.updated_at_ms AS bucket_at_ms, u.model AS key,
				        u.input_tokens + u.output_tokens + u.cached_tokens AS tokens,
				        COALESCE(u.est_cost_usd, 0) AS cost
				   FROM session_model_usage u JOIN sessions s ON s.event_id = u.session_event_id
				  WHERE s.updated_at_ms >= ? AND s.updated_at_ms < ?${filter.sql} AND ${NO_DATED_USAGE}`,
			)
			.all(fromMs, toMs, ...filter.params, fromMs, toMs, ...filter.params) as AxisRow[];
	}
	if (dimension === "agent") {
		const filter = scopeFilter(scopeToRepoIds(db, scope), "s.repo_id");
		return db
			.prepare(
				`SELECT s.repo_id, e.responded_at_ms AS bucket_at_ms, s.source AS key,
				        e.input_tokens + e.output_tokens + e.cached_tokens AS tokens,
				        COALESCE(e.est_cost_usd, 0) AS cost
				   FROM session_usage_events e JOIN sessions s ON s.event_id = e.session_event_id
				  WHERE e.responded_at_ms >= ? AND e.responded_at_ms < ?${filter.sql} AND ${HAS_DATED_USAGE}
				 UNION ALL
				SELECT s.repo_id, s.updated_at_ms AS bucket_at_ms, s.source AS key,
				        s.input_tokens + s.output_tokens + s.cached_tokens AS tokens,
				        COALESCE(s.est_cost_usd, 0) AS cost
				   FROM sessions s
				  WHERE s.updated_at_ms >= ? AND s.updated_at_ms < ?${filter.sql} AND ${NO_DATED_USAGE}`,
			)
			.all(fromMs, toMs, ...filter.params, fromMs, toMs, ...filter.params) as AxisRow[];
	}
	if (dimension === "project") {
		const filter = scopeFilter(scopeToRepoIds(db, scope), "s.repo_id");
		return db
			.prepare(
				`SELECT s.repo_id, e.responded_at_ms AS bucket_at_ms, r.repo_name AS key,
				        e.input_tokens + e.output_tokens + e.cached_tokens AS tokens,
				        COALESCE(e.est_cost_usd, 0) AS cost
				   FROM session_usage_events e
				   JOIN sessions s ON s.event_id = e.session_event_id
				   JOIN repos r ON r.id = s.repo_id
				  WHERE e.responded_at_ms >= ? AND e.responded_at_ms < ?${filter.sql} AND ${HAS_DATED_USAGE}
				 UNION ALL
				SELECT s.repo_id, s.updated_at_ms AS bucket_at_ms, r.repo_name AS key,
				        s.input_tokens + s.output_tokens + s.cached_tokens AS tokens,
				        COALESCE(s.est_cost_usd, 0) AS cost
				   FROM sessions s JOIN repos r ON r.id = s.repo_id
				  WHERE s.updated_at_ms >= ? AND s.updated_at_ms < ?${filter.sql} AND ${NO_DATED_USAGE}`,
			)
			.all(fromMs, toMs, ...filter.params, fromMs, toMs, ...filter.params) as AxisRow[];
	}
	if (dimension === "category") {
		const filter = scopeFilter(scopeToRepoIds(db, scope), "m.repo_id");
		// One row per TOPIC, with the commit's tokens shared across its topics —
		// category belongs to a topic, and the old per-commit mode erased every
		// category that never won a commit's vote (security and docs vanished
		// entirely on this repo's data). Sharing keeps the axis summing to the
		// real total, the property the mode existed to protect; the cost
		// figures are apportioned by design, not exact per-topic spend.
		// The LEFT JOIN keeps memories with no topics on the axis: their window
		// COUNT(*) is 1 and their whole spend lands in '(uncategorised)'.
		//
		// `parent_hash IS NULL` and the landing CTE both matter most HERE: this is
		// where the double-count was worst (measured 9.5x) precisely because the
		// LEFT JOIN keeps predecessors whose commit row is gone.
		return db
			.prepare(
				`${MEMORY_LANDING_CTE}
				 SELECT m.repo_id, ml.at_ms AS bucket_at_ms,
				        COALESCE(t.category, '(uncategorised)') AS key,
				        COALESCE(m.tokens, 0) * 1.0
				          / COUNT(*) OVER (PARTITION BY m.repo_id, m.commit_hash) AS tokens,
				        COALESCE(m.est_cost_usd, 0) * 1.0
				          / COUNT(*) OVER (PARTITION BY m.repo_id, m.commit_hash) AS cost
				   FROM memories m
				   JOIN memory_landing ml ON ml.repo_id = m.repo_id AND ml.commit_hash = m.commit_hash
				   LEFT JOIN memory_topics t ON t.repo_id = m.repo_id AND t.commit_hash = m.commit_hash
				  WHERE m.tokens IS NOT NULL
				    AND m.parent_hash IS NULL
				    AND ml.at_ms >= ? AND ml.at_ms < ?${filter.sql}`,
			)
			.all(fromMs, toMs, ...filter.params) as AxisRow[];
	}
	if (dimension === "branch") {
		const filter = scopeFilter(scopeToRepoIds(db, scope), "c.repo_id");
		// `commit_branches` now holds ONE row per commit — the branch it was
		// committed on — so this axis answers "what did the work on this branch
		// cost", which is the per-PR question, and a commit counts once.
		//
		// **The apportioning division is kept deliberately even though the divisor
		// is 1 for anything this build wrote.** It is the transition safeguard: a
		// database written by an older client still holds that client's per-branch
		// `git rev-list` UNION (every commit on `main` also listed under every
		// feature branch based off it) until the first sweep re-projects each commit.
		// Unapportioned against those rows, one 10k-token commit on a repo with five
		// such branches would add 60k tokens — and 6x the cost — to the day. Dividing
		// keeps the reading sane until the rows converge, then costs nothing.
		return db
			.prepare(
				`SELECT c.repo_id, c.committed_at_ms AS bucket_at_ms, br.name AS key,
				        COALESCE(m.tokens, 0) * 1.0
				          / COUNT(*) OVER (PARTITION BY c.repo_id, c.hash) AS tokens,
				        COALESCE(m.est_cost_usd, 0) * 1.0
				          / COUNT(*) OVER (PARTITION BY c.repo_id, c.hash) AS cost
				   FROM commits c
				   JOIN commit_branches b ON b.commit_id = c.id
				   JOIN branches br ON br.id = b.branch_id
				   JOIN memories m ON m.repo_id = c.repo_id AND (${MEMORY_FOR_COMMIT})
				  WHERE m.tokens IS NOT NULL AND m.parent_hash IS NULL
				    AND c.committed_at_ms >= ? AND c.committed_at_ms < ?${filter.sql}`,
			)
			.all(fromMs, toMs, ...filter.params) as AxisRow[];
	}
	const filter = scopeFilter(scopeToRepoIds(db, scope), "c.repo_id");
	return db
		.prepare(
			`SELECT c.repo_id, c.committed_at_ms AS bucket_at_ms,
			        COALESCE(m.ticket_id, '(no ticket)') AS key,
			        COALESCE(m.tokens, 0) AS tokens, COALESCE(m.est_cost_usd, 0) AS cost
			   FROM commits c
			   JOIN memories m ON m.repo_id = c.repo_id AND (${MEMORY_FOR_COMMIT})
			  WHERE m.tokens IS NOT NULL AND m.parent_hash IS NULL
			    AND c.committed_at_ms >= ? AND c.committed_at_ms < ?${filter.sql}`,
		)
		.all(fromMs, toMs, ...filter.params) as AxisRow[];
}
