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
import { scopeFilter, scopeToRepoId } from "./DashboardScopeUtil.js";

/**
 * A session whose usage could not be placed on a calendar.
 *
 * The spend axes read `session_usage_events` — one row per model response, each
 * with its own instant — so a conversation spanning days contributes to each of
 * them. Only the Claude parser reports per-response usage today, so every other
 * source still has nothing but a session-level total under a single timestamp
 * and keeps being placed by it.
 *
 * The two must not double-count, hence this predicate on the fallback side: a
 * session contributes its events OR its total, never both.
 */
const NO_DATED_USAGE = `NOT EXISTS (SELECT 1 FROM session_usage_events e2 WHERE e2.session_event_id = s.event_id)`;

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
	const filter = scopeFilter(scopeToRepoId(db, scope), "s.repo_id");
	return db
		.prepare(
			`SELECT s.repo_id, e.responded_at_ms AS bucket_at_ms, e.input_tokens AS input,
			        e.output_tokens AS output, e.cached_tokens AS cached
			   FROM session_usage_events e JOIN sessions s ON s.event_id = e.session_event_id
			  WHERE e.responded_at_ms >= ? AND e.responded_at_ms < ?${filter.sql}
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
		const filter = scopeFilter(scopeToRepoId(db, scope), "s.repo_id");
		return db
			.prepare(
				`SELECT s.repo_id, e.responded_at_ms AS bucket_at_ms, e.model AS key,
				        e.input_tokens + e.output_tokens + e.cached_tokens AS tokens,
				        COALESCE(e.est_cost_usd, 0) AS cost
				   FROM session_usage_events e JOIN sessions s ON s.event_id = e.session_event_id
				  WHERE e.responded_at_ms >= ? AND e.responded_at_ms < ?${filter.sql}
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
		const filter = scopeFilter(scopeToRepoId(db, scope), "s.repo_id");
		return db
			.prepare(
				`SELECT s.repo_id, e.responded_at_ms AS bucket_at_ms, s.source AS key,
				        e.input_tokens + e.output_tokens + e.cached_tokens AS tokens,
				        COALESCE(e.est_cost_usd, 0) AS cost
				   FROM session_usage_events e JOIN sessions s ON s.event_id = e.session_event_id
				  WHERE e.responded_at_ms >= ? AND e.responded_at_ms < ?${filter.sql}
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
		const filter = scopeFilter(scopeToRepoId(db, scope), "s.repo_id");
		return db
			.prepare(
				`SELECT s.repo_id, e.responded_at_ms AS bucket_at_ms, r.repo_name AS key,
				        e.input_tokens + e.output_tokens + e.cached_tokens AS tokens,
				        COALESCE(e.est_cost_usd, 0) AS cost
				   FROM session_usage_events e
				   JOIN sessions s ON s.event_id = e.session_event_id
				   JOIN repos r ON r.id = s.repo_id
				  WHERE e.responded_at_ms >= ? AND e.responded_at_ms < ?${filter.sql}
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
		const filter = scopeFilter(scopeToRepoId(db, scope), "m.repo_id");
		// One row per TOPIC, with the commit's tokens shared across its topics —
		// category belongs to a topic, and the old per-commit mode erased every
		// category that never won a commit's vote (security and docs vanished
		// entirely on this repo's data). Sharing keeps the axis summing to the
		// real total, the property the mode existed to protect; the cost
		// figures are apportioned by design, not exact per-topic spend.
		// The LEFT JOIN keeps memories with no topics on the axis: their window
		// COUNT(*) is 1 and their whole spend lands in '(uncategorised)'.
		return db
			.prepare(
				`SELECT m.repo_id, COALESCE(cm.committed_at_ms, m.commit_date_ms) AS bucket_at_ms,
				        COALESCE(t.category, '(uncategorised)') AS key,
				        COALESCE(m.tokens, 0) * 1.0
				          / COUNT(*) OVER (PARTITION BY m.repo_id, m.commit_hash) AS tokens,
				        COALESCE(m.est_cost_usd, 0) * 1.0
				          / COUNT(*) OVER (PARTITION BY m.repo_id, m.commit_hash) AS cost
				   FROM memories m
				   LEFT JOIN memory_topics t ON t.repo_id = m.repo_id AND t.commit_hash = m.commit_hash
				   LEFT JOIN commits cm ON cm.repo_id = m.repo_id AND cm.hash = m.commit_hash
				  WHERE m.tokens IS NOT NULL
				    AND COALESCE(cm.committed_at_ms, m.commit_date_ms) >= ?
				    AND COALESCE(cm.committed_at_ms, m.commit_date_ms) < ?${filter.sql}`,
			)
			.all(fromMs, toMs, ...filter.params) as AxisRow[];
	}
	if (dimension === "branch") {
		const filter = scopeFilter(scopeToRepoId(db, scope), "c.repo_id");
		// A commit reachable from several branches contributes to each — the axis
		// answers "where did the spend land", not "sum to the exact total". That
		// licenses duplication ACROSS SERIES, never in the day totals, which is
		// why the spend is apportioned exactly as the category axis apportions
		// across topics. `commit_branches` is a per-branch `git rev-list` union,
		// so every commit on `main` is also listed under every feature branch
		// based off it: unapportioned, one 10k-token commit on a repo with five
		// such branches added 60k tokens (and 6x the cost) to the day.
		return db
			.prepare(
				`SELECT c.repo_id, c.committed_at_ms AS bucket_at_ms, br.name AS key,
				        COALESCE(m.tokens, 0) * 1.0
				          / COUNT(*) OVER (PARTITION BY c.repo_id, c.hash) AS tokens,
				        COALESCE(m.est_cost_usd, 0) * 1.0
				          / COUNT(*) OVER (PARTITION BY c.repo_id, c.hash) AS cost
				   FROM commits c JOIN commit_branches b ON b.commit_id = c.id
			                        JOIN branches br ON br.id = b.branch_id
			                        JOIN memories m ON m.repo_id = c.repo_id AND m.commit_hash = c.hash
				  WHERE m.tokens IS NOT NULL AND c.committed_at_ms >= ? AND c.committed_at_ms < ?${filter.sql}`,
			)
			.all(fromMs, toMs, ...filter.params) as AxisRow[];
	}
	const filter = scopeFilter(scopeToRepoId(db, scope), "c.repo_id");
	return db
		.prepare(
			`SELECT c.repo_id, c.committed_at_ms AS bucket_at_ms,
			        COALESCE(m.ticket_id, '(no ticket)') AS key,
			        COALESCE(m.tokens, 0) AS tokens, COALESCE(m.est_cost_usd, 0) AS cost
			   FROM commits c JOIN memories m ON m.repo_id = c.repo_id AND m.commit_hash = c.hash
			  WHERE m.tokens IS NOT NULL AND c.committed_at_ms >= ? AND c.committed_at_ms < ?${filter.sql}`,
		)
		.all(fromMs, toMs, ...filter.params) as AxisRow[];
}
