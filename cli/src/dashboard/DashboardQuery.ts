/**
 * DashboardQuery — read-only queries that turn the dashboard database into a
 * `DashboardModel` for one page render.
 *
 * ## The single time-zone engine
 *
 * Every local-time decision in the dashboard — "today"'s boundaries, heatmap
 * day buckets, the hour histogram, streaks — goes through the JS/IANA helpers
 * in this file, driven by one `timeZone` string. SQLite's `localtime` is never
 * used: it answers with the process's zone at query time, drifts on Windows,
 * and cannot agree with the boundaries computed here. The database itself
 * stores only UTC epoch-ms; SQL filters rows by `*_ms` range (index-friendly)
 * and the bucketing happens in JS with `Intl`, which is DST-aware and
 * identical across platforms.
 *
 * Everything here opens the database read-only. There is deliberately no way
 * to reach a write from a query.
 */

import { existsSync } from "node:fs";
import { collectDisplayTopics } from "../core/SummaryTree.js";
import { TOOL_RECORDING_SOURCES } from "../core/TranscriptParser.js";
import type { TranscriptRepairState } from "../core/TranscriptRepair.js";
import { createLogger, errMsg } from "../Logger.js";
import type { CommitSummary } from "../Types.js";
import { ACTIVITY_BUCKET_MS } from "./ActivityBuckets.js";
import type { DashboardDbHandle } from "./DashboardDb.js";
import type {
	AdoptionTier,
	CommitInsightKind,
	ConcurrencyModel,
	CoverageNote,
	DashboardMenus,
	DashboardModel,
	DashboardRange,
	DashboardScope,
	DashboardView,
	DaySeriesPoint,
	DecisionRecord,
	DecisionsCard,
	FunStats,
	GraphModel,
	HeatmapCell,
	HourBucket,
	KnowledgeModel,
	McpServerRow,
	MemoryCard,
	RecentSession,
	RepoOption,
	SeriesDimension,
	SettingsPageModel,
	StandupCommit,
	StandupInsight,
	StandupModel,
	StandupWorkspace,
	StatsModel,
	TokenBreakdown,
	ToolUsage,
	ToolUsageAgentShare,
	ToolUsageAgentTotal,
	ToolUsageList,
	ToolUsagePage,
	ToolUsageRow,
} from "./DashboardModel.js";
import {
	commitCategoryLabels,
	placeholders,
	type ResolvedScope,
	resolveScope,
	scopeFilter,
	scopeToRepoIds,
	splitDecisionBullets,
	stripPluginPrefixSql,
} from "./DashboardScopeUtil.js";
import {
	addLocalDays,
	dayKeyToMidnight,
	localDayKey,
	localHour,
	machineTimeZone,
	startOfLocalDay,
} from "./LocalDays.js";
import { buildMemories, isReachable, type ReachableCommits } from "./MemoriesQuery.js";
import { volumeReachable } from "./RepoForget.js";
import { type DayPlan, planDays, readRollupSeries, TOKENS_KIND } from "./StatsRollup.js";
import { MEMORY_LANDING_CTE, readAxisRows, readDatedUsage } from "./StatsSeries.js";
import { WORKTREE_STATUS_MAX_AGE_MS } from "./StatsWriter.js";

const log = createLogger("DashboardQuery");

import {
	isRecallMcpToolName,
	MEMORY_CARD_MAJOR_LINES,
	MEMORY_CARDS_LIMIT,
	RECALL_MCP_TOOL_NAME,
	TOOL_ROWS_LIMIT,
} from "./DashboardModel.js";

/**
 * The heatmap's own span, deliberately NOT range-scoped: it is the long view by
 * definition, and the mockup labels it "12 weeks · all agents" regardless of the
 * selected range.
 */
const HEATMAP_DAYS = 84; // 12 weeks

/** The fixed-width ranges. `custom` is excluded — it carries its own bounds. */
type PresetRange = Exclude<DashboardRange, "custom">;

/** Local days each preset range covers, counting today. */
const RANGE_DAYS: Readonly<Record<PresetRange, number>> = { today: 1, week: 7, "2w": 14, month: 30, "3m": 90 };

/** The range a malformed or empty custom request falls back to. */
const DEFAULT_RANGE: PresetRange = "month";

/**
 * How far back a custom range may reach, in local days.
 *
 * Not a data-retention statement — it is a scan bound. A custom window is the
 * one input that can ask for an arbitrarily wide `sessions` / `commits` scan on
 * a read-only connection the HTTP service holds open per request, so it gets a
 * ceiling. Asking for more is clamped (never rejected): the reader still gets
 * the most recent year, and `rangeFrom` reports the window they actually got.
 */
const MAX_CUSTOM_DAYS = 366;

/** A session updated within this window renders as "live". */
const LIVE_WINDOW_MS = 10 * 60 * 1000;
/** Local hour at or after which a session counts as night-owl work. */
const NIGHT_OWL_HOUR = 21;

// ── Range resolution ────────────────────────────────────────────────────────

/** A range request resolved into concrete bounds and day keys. */
interface ResolvedWindow {
	/** What the page ended up showing — `custom` only if the request survived. */
	readonly range: DashboardRange;
	/** Inclusive lower bound, epoch-ms. */
	readonly startMs: number;
	/** EXCLUSIVE upper bound, epoch-ms — one past the last day's local midnight. */
	readonly endMs: number;
	readonly from: string;
	readonly to: string;
}

/**
 * Resolves an explicit `from`/`to` pair, or `undefined` when it is unusable and
 * the caller should fall back to the default preset.
 *
 * Rejects (falls back): a malformed or non-existent day, and a reversed pair —
 * these mean the request was wrong, and silently "fixing" a reversed pair by
 * swapping would answer a question nobody asked.
 *
 * Clamps (still answers): a `to` in the future, since no data can exist there;
 * and a `from` older than {@link MAX_CUSTOM_DAYS}. Both keep a well-formed
 * request useful instead of bouncing it, and `from`/`to` report what was used.
 */
function resolveCustomWindow(
	fromKey: string | undefined,
	toKey: string | undefined,
	todayStart: number,
	timeZone: string,
): ResolvedWindow | undefined {
	if (!fromKey || !toKey) return undefined;
	const fromMs = dayKeyToMidnight(fromKey, timeZone);
	const toMs = dayKeyToMidnight(toKey, timeZone);
	if (fromMs === undefined || toMs === undefined || fromMs > toMs) return undefined;

	const lastDay = Math.min(toMs, todayStart);
	const firstDay = Math.max(fromMs, addLocalDays(todayStart, -(MAX_CUSTOM_DAYS - 1), timeZone));
	// Both clamps pull toward today, so they can only cross when the whole
	// request sits beyond one of them (entirely in the future, or entirely
	// before the cap). Nothing is recorded there either way — fall back.
	if (firstDay > lastDay) return undefined;

	const from = localDayKey(firstDay, timeZone);
	const to = localDayKey(lastDay, timeZone);
	return {
		range: "custom",
		startMs: firstDay,
		endMs: addLocalDays(lastDay, 1, timeZone),
		from,
		to,
	};
}

/** Turns the requested range into the one window every figure is computed over. */
function resolveWindow(
	range: DashboardRange | undefined,
	customFrom: string | undefined,
	customTo: string | undefined,
	nowMs: number,
	timeZone: string,
): ResolvedWindow {
	if (range === "custom") {
		const custom = resolveCustomWindow(customFrom, customTo, startOfLocalDay(nowMs, timeZone), timeZone);
		if (custom) return custom;
	}
	const preset: PresetRange = range && range !== "custom" ? range : DEFAULT_RANGE;
	const startMs = addLocalDays(nowMs, -(RANGE_DAYS[preset] - 1), timeZone);
	return {
		range: preset,
		startMs,
		endMs: addLocalDays(nowMs, 1, timeZone),
		from: localDayKey(startMs, timeZone),
		to: localDayKey(nowMs, timeZone),
	};
}

// ── Query plumbing ──────────────────────────────────────────────────────────

/**
 * Every git identity that counts as "me", unioned across the registered repos
 * (each can carry its own `user.email`). Emails and names are kept apart
 * because they are matched differently — see {@link authorFilter}.
 */
export interface AuthorIdentity {
	readonly emails: ReadonlyArray<string>;
	readonly names: ReadonlyArray<string>;
}

export interface QueryOptions {
	readonly view: DashboardView;
	readonly scope: DashboardScope;
	/** Window the KPIs and series cover. Defaults to the 30-day dashboard view. */
	readonly range?: DashboardRange;
	/**
	 * Inclusive local `YYYY-MM-DD` bounds, read only when `range` is `"custom"`.
	 * An unusable pair falls back to the default preset rather than erroring —
	 * see {@link resolveCustomWindow} for which inputs reject vs clamp.
	 */
	readonly customFrom?: string;
	readonly customTo?: string;
	/** Axis for the series. Defaults to "model"; branch/ticket need memory. */
	readonly dimension?: SeriesDimension;
	/** Memories view: which memory's detail to build. Absent renders the tree with no selection. */
	readonly hash?: string;
	/**
	 * Memories view: which repo owns {@link hash}, when two clones share it.
	 * Narrows the DETAIL only — see `buildMemories` for why this is not `scope`.
	 */
	readonly detailRepoIdentity?: string;
	/**
	 * Memories view: the async-read repair verdict for {@link hash}'s memory —
	 * which of spec §9's three sentences an EMPTY conversations list prints. Read
	 * by `readMemoryTranscriptRepairState` (it stats the machine-global Claude
	 * owners ledger, which this synchronous layer cannot do) and threaded in the
	 * same way {@link reachableCommits} and the three page models below are.
	 * Absent leaves the client on the plainest wording.
	 */
	readonly transcriptRepairState?: TranscriptRepairState;
	/**
	 * The async-read per-repo git reachability sets, keyed by `repo_identity`.
	 * Absent (or a repo missing from the map) renders every row unfiltered —
	 * see {@link ReachableCommits}. Read by the memories tree, and by the
	 * stats/standup commit and memory-card queries: a squashed-away commit is
	 * gone from git but not from `commits`/`memories`, so without this the
	 * Memory Activity feed renders one card per pre-squash predecessor and the
	 * "N of M captured" line counts commits that no longer exist.
	 */
	readonly reachableCommits?: ReachableCommits;
	/**
	 * Standup view: the local git identity, read async per repo by the server.
	 * Absent — or present with nothing usable in it — leaves the board
	 * unfiltered; see {@link authorFilter} for why that fail-open matters.
	 */
	readonly authorIdentity?: AuthorIdentity;
	/** Knowledge view: the async-read Memory Bank `_wiki` file lists. Absent renders an empty list. */
	readonly knowledgeModel?: KnowledgeModel;
	/** Graph view: the async-read Memory Bank repo list. Absent renders an empty list. */
	readonly graphModel?: GraphModel;
	/** Settings view: the async-read config/memory-bank snapshot. Absent on every other view. */
	readonly settingsModel?: SettingsPageModel;
	/**
	 * Which optional sidebar rows to show, read from config by the server (this
	 * builder is synchronous and the flags live in a file). Absent means BOTH
	 * hidden — the same polarity `config.json` has, so a caller that does not
	 * know about them cannot switch one on by omission.
	 */
	readonly menus?: DashboardMenus;
	/**
	 * Every checkout path the repo registry records, keyed by `repo_identity` —
	 * read async by the server, because the registry is a file and this builder is
	 * synchronous. Absent, or absent for one identity, falls back to that row's
	 * `worktree_root`; see {@link isMissingWorktree} for why the fallback is not
	 * good enough on its own.
	 *
	 * Paths only, deliberately — not a precomputed liveness verdict. Probing them
	 * here is what puts them through {@link worktreeExists}' memo, and a caller
	 * that answered "live?" itself would be making one uncached `existsSync` per
	 * clone per request, which is the cost that memo exists to bound.
	 */
	readonly registryRoots?: ReadonlyMap<string, ReadonlyArray<string>>;
	readonly timeZone?: string;
	readonly nowMs?: number;
}

/**
 * WHERE fragment + params restricting `commits` to the local user's own work.
 *
 * Standup only, and deliberately not applied to the stats page: "how much did
 * this repo do" is a repo question, while a standup is a first-person report —
 * the page draws a Copy-as-standup draft the user posts as their own, so a
 * teammate's commit in it is a false claim, not just noise. The two are easy to
 * conflate because a single-developer repo makes them identical.
 *
 * Matches email OR name, both taken from `git config` rather than from any
 * commit: the same person legitimately appears under a work email locally and a
 * noreply address after a remote rewrite, and a name-only identity is all some
 * imports carry. Emails compare case-folded (they are case-insensitive in
 * practice and git does not normalise them); names compare exactly, since a name
 * is display text and two people can differ only by case.
 *
 * FAILS OPEN. An identity with nothing usable in it — no git, an unconfigured
 * machine, a `repos` row with no worktree — returns no filter, so the board
 * shows every commit rather than going blank. A blank standup reads as "you did
 * nothing", which is a worse lie than an unfiltered one, and the unfiltered case
 * is visible (the header states whose commits are shown) where an empty page
 * would be silent.
 */
function authorFilter(identity: AuthorIdentity | undefined, alias: string): { sql: string; params: unknown[] } {
	const emails = (identity?.emails ?? []).map((email) => email.trim().toLowerCase()).filter((email) => email !== "");
	const names = (identity?.names ?? []).map((name) => name.trim()).filter((name) => name !== "");
	if (emails.length === 0 && names.length === 0) return { sql: "", params: [] };
	const clauses: string[] = [];
	const params: unknown[] = [];
	if (emails.length > 0) {
		clauses.push(`LOWER(${alias}.author_email) IN (${placeholders(emails.length)})`);
		params.push(...emails);
	}
	if (names.length > 0) {
		clauses.push(`${alias}.author_name IN (${placeholders(names.length)})`);
		params.push(...names);
	}
	return { sql: ` AND (${clauses.join(" OR ")})`, params };
}

interface SessionRow {
	readonly event_id: string;
	readonly repo_identity: string;
	readonly source: string;
	readonly session_id: string;
	readonly title: string | null;
	readonly updated_at_ms: number;
	readonly message_count: number | null;
	readonly duration_ms: number | null;
	readonly input_tokens: number;
	readonly output_tokens: number;
	readonly cached_tokens: number;
	readonly est_cost_usd: number | null;
	readonly token_coverage: string;
	readonly repo_name: string;
}

function sessionsInRange(db: DashboardDbHandle, scope: DashboardScope, fromMs: number, toMs: number): SessionRow[] {
	const filter = scopeFilter(scopeToRepoIds(db, scope), "s.repo_id");
	return db
		.prepare(
			`SELECT s.event_id, r.repo_identity, s.source, s.session_id, s.title, s.updated_at_ms,
			        s.message_count, s.duration_ms, s.input_tokens, s.output_tokens, s.cached_tokens,
			        s.est_cost_usd, s.token_coverage, r.repo_name
			   FROM sessions s JOIN repos r ON r.id = s.repo_id
			  WHERE s.updated_at_ms >= ? AND s.updated_at_ms < ?${filter.sql}
			  ORDER BY s.updated_at_ms DESC`,
		)
		.all(fromMs, toMs, ...filter.params) as SessionRow[];
}

interface CommitRow {
	readonly hash: string;
	readonly message: string | null;
	readonly branch: string | null;
	readonly committed_at_ms: number;
	readonly files_changed: number | null;
	readonly insertions: number | null;
	readonly deletions: number | null;
	readonly repo_name: string;
	/** Keys the reachability filter — `repo_name` is a display label and can collide. */
	readonly repo_identity: string;
	/** Memory-tier columns — null until the summary pipeline enriches the commit. */
	readonly turns: number | null;
	readonly tokens: number | null;
	readonly est_cost_usd: number | null;
	readonly ticket_id: string | null;
	/**
	 * `memories.root_hash` — NOT NULL on every real memory row (see SotSchema),
	 * so a LEFT JOIN miss is the one column guaranteed to come back null. Existence
	 * signal for "does this commit have a memory at all", distinct from `turns`/
	 * `tokens`, which a captured-but-sparse memory can legitimately leave null.
	 */
	readonly root_hash: string | null;
}

function commitsInRange(
	db: DashboardDbHandle,
	scope: DashboardScope,
	fromMs: number,
	toMs: number,
	/** Standup only — every other caller reports repo-wide activity. See {@link authorFilter}. */
	identity?: AuthorIdentity,
): CommitRow[] {
	const filter = scopeFilter(scopeToRepoIds(db, scope), "c.repo_id");
	const author = authorFilter(identity, "c");
	// The memory-tier columns come from `memories` (A3b): the commits copies
	// fall behind whenever a memory regenerates, while the memory row is
	// refreshed live by the same worker pass that emits commit.summary.
	//
	// A commit whose hash was rewritten (rebase/amend) after it was summarized
	// keeps its memory filed under the pre-rewrite hash; `commit_aliases` maps
	// the surviving `commits.hash` back to it (`old_hash` -> the memory's
	// `target_hash`). Skipping this second path is exactly what undercounted
	// Memory Activity's "captured" figure — every rewritten-but-tracked commit
	// read as a gap. COALESCE prefers the direct match; the two can never both
	// be non-null for the same commit; since a landed memory's own commit_hash
	// is never also an alias's old_hash (landAliases only aliases hashes with
	// no memory row of their own).
	return db
		.prepare(
			`SELECT c.hash, c.message, c.branch, c.committed_at_ms, c.files_changed, c.insertions, c.deletions,
			        COALESCE(m.turns, ma.turns) AS turns, COALESCE(m.tokens, ma.tokens) AS tokens,
			        COALESCE(m.est_cost_usd, ma.est_cost_usd) AS est_cost_usd,
			        COALESCE(m.ticket_id, ma.ticket_id) AS ticket_id,
			        COALESCE(m.root_hash, ma.root_hash) AS root_hash, r.repo_name, r.repo_identity
			   FROM commits c JOIN repos r ON r.id = c.repo_id
			   LEFT JOIN memories m ON m.repo_id = c.repo_id AND m.commit_hash = c.hash
			   LEFT JOIN commit_aliases al ON al.repo_id = c.repo_id AND al.old_hash = c.hash
			   LEFT JOIN memories ma ON ma.repo_id = al.repo_id AND ma.commit_hash = al.target_hash
			  WHERE c.committed_at_ms >= ? AND c.committed_at_ms < ?${filter.sql}${author.sql}
			  ORDER BY c.committed_at_ms DESC`,
		)
		.all(fromMs, toMs, ...filter.params, ...author.params) as CommitRow[];
}

/**
 * Insights derived at query time from the memory's own topics — the summary
 * schema has no `insights` field; what the retired commit_insights rows held
 * was ALWAYS this derivation (each topic's `decisions` and `todo`, in topic
 * order), performed at event-build time. Doing it in SQL keeps the rule in
 * one place and means a regenerated memory can never leave stale insights
 * behind. `ord` preserves the old idx ordering: topic position x2, decisions
 * before todo. addressed_to was never populated by the live deriver and stays
 * NULL. Legacy v3 memories whose root carries no topics degrade to no
 * insights — same as the old event path when the root display set was empty.
 *
 * `topic_title` carries the OWNING topic's title alongside the insight text.
 * The Decisions card renders that title and nothing else (see
 * {@link buildDecisionsCard}), so it has to travel with the row: the `text` a
 * decision row holds is the whole `decisions` block, which is prose and has no
 * title in it to recover. Both branches select it so the column exists whatever
 * `kind` a consumer filters to.
 *
 * **Both branches filter `m.parent_hash IS NULL`** — the same "current
 * generation" rule {@link buildSeries} states at length, for the same reason and
 * with the same trap. `memories` holds one row per GENERATION, so a branch
 * amended or squashed four times keeps its predecessors' topics, and every
 * consumer of this CTE joins `commits`, which retains the predecessors' rows.
 * Unfiltered, one decision is counted once per rewrite — directly beside
 * `memoriesCreated`, which filters the same history out via `isReachable`.
 */
const TOPIC_INSIGHTS_CTE = `WITH topic_insights AS (
	SELECT m.repo_id, m.commit_hash, 'decision' AS kind,
	       TRIM(json_extract(t.value, '$.decisions')) AS text,
	       TRIM(COALESCE(json_extract(t.value, '$.title'), '')) AS topic_title,
	       NULL AS addressed_to, t.key * 2 AS ord
	  FROM memories m, json_each(m.summary_json, '$.topics') t
	 WHERE m.parent_hash IS NULL
	   AND TRIM(COALESCE(json_extract(t.value, '$.decisions'), '')) <> ''
	UNION ALL
	SELECT m.repo_id, m.commit_hash, 'todo' AS kind,
	       TRIM(json_extract(t.value, '$.todo')) AS text,
	       TRIM(COALESCE(json_extract(t.value, '$.title'), '')) AS topic_title,
	       NULL AS addressed_to, t.key * 2 + 1 AS ord
	  FROM memories m, json_each(m.summary_json, '$.topics') t
	 WHERE m.parent_hash IS NULL
	   AND TRIM(COALESCE(json_extract(t.value, '$.todo'), '')) <> ''
)`;

const totalTokens = (row: SessionRow): number => row.input_tokens + row.output_tokens + row.cached_tokens;

// ── Stats page ──────────────────────────────────────────────────────────────

/**
 * Detects the adoption tier from the data itself: the memory tier is "the
 * summary pipeline has enriched at least one commit", which is exactly a
 * commit carrying turns/tokens or a mined insight. Space stays future work.
 */
export function detectTier(db: DashboardDbHandle): AdoptionTier {
	const row = db
		.prepare(
			`SELECT EXISTS (SELECT 1 FROM memories WHERE turns IS NOT NULL OR tokens IS NOT NULL OR ticket_id IS NOT NULL)
			      + EXISTS (SELECT 1 FROM memories, json_each(memories.summary_json, '$.topics') t
			                 WHERE TRIM(COALESCE(json_extract(t.value, '$.decisions'), '')) <> ''
			                    OR TRIM(COALESCE(json_extract(t.value, '$.todo'), '')) <> '') AS n`,
		)
		.get() as { n: number } | undefined;
	return (row?.n ?? 0) > 0 ? "memory" : "installed";
}

interface SeriesResult {
	readonly series: DaySeriesPoint[];
	readonly seriesKeys: string[];
	readonly seriesDimension: SeriesDimension;
}

/**
 * The token card's segments, placed on the day each response happened.
 *
 * Reads the same two sources the spend axes do, through the same plan: settled
 * days come out of the rollup's `tokens` kind, the rest out of
 * {@link readDatedUsage}. Keeping the two halves on one plan is what makes the
 * card's total equal the sum of its own bars — the failure this replaces put a
 * three-day conversation's whole token count on the day it ended.
 */
function readTokenTotals(
	db: DashboardDbHandle,
	scope: DashboardScope,
	timeZone: string,
	plan: DayPlan,
): TokenBreakdown {
	const perDay = new Map<string, { input: number; output: number; cached: number }>();
	for (const day of plan.dayKeys) perDay.set(day, { input: 0, output: 0, cached: 0 });

	for (const row of readRollupSeries(db, timeZone, TOKENS_KIND, plan.cached, scope)) {
		const cell = perDay.get(row.day);
		if (!cell) continue;
		if (row.series_key === "input") cell.input += row.value;
		else if (row.series_key === "output") cell.output += row.value;
		else if (row.series_key === "cached") cell.cached += row.value;
	}
	if (plan.live.size > 0) {
		for (const row of readDatedUsage(db, scope, plan.liveFromMs, plan.liveToMs)) {
			const day = localDayKey(row.bucket_at_ms, timeZone);
			if (!plan.live.has(day)) continue;
			const cell = perDay.get(day);
			if (!cell) continue;
			cell.input += row.input;
			cell.output += row.output;
			cell.cached += row.cached;
		}
	}

	let input = 0;
	let output = 0;
	let cached = 0;
	for (const cell of perDay.values()) {
		input += cell.input;
		output += cell.output;
		cached += cell.cached;
	}
	// Rounded at emission rather than per row, for the reason `buildSeries`
	// records: a cached day sums pre-aggregated subtotals while a live day sums
	// raw rows, and the apportioning axes make both fractional.
	return {
		input: Math.round(input),
		output: Math.round(output),
		cached: Math.round(cached),
		perDay: [...perDay.entries()].map(([date, v]) => ({
			date,
			input: Math.round(v.input),
			output: Math.round(v.output),
			cached: Math.round(v.cached),
		})),
	};
}

/**
 * One dimension's per-day series over the window `plan` was cut for.
 *
 * The window arrives as the PLAN and not as a `fromMs`/`toMs` pair: `plan.dayKeys`
 * is already every local day in it, produced by the same walk this used to repeat
 * — and repeating it meant two ways of deciding which days a chart has, one of
 * which could disagree with the cache's own split.
 *
 * See {@link ./StatsSeries.ts} for the axis SQL itself and the rules it encodes
 * (`m.parent_hash IS NULL`, and the two spellings of the rewritten-commit landing
 * rule); the numbers here are that reader's rows, bucketed.
 */
function buildSeries(
	db: DashboardDbHandle,
	scope: DashboardScope,
	dimension: SeriesDimension,
	tier: AdoptionTier,
	timeZone: string,
	plan: DayPlan,
): SeriesResult {
	// Memory-only axes fall back to `model` below the memory tier, so a stale URL
	// renders real data instead of an empty chart pretending to be one.
	//
	// The fallback is resolved HERE and never reaches the cache: it is a display
	// decision, and a repo that crosses the tier later must not find its stored
	// `branch` days holding model data.
	const memoryOnly = dimension === "branch" || dimension === "ticket" || dimension === "category";
	const effective: SeriesDimension = memoryOnly && tier === "installed" ? "model" : dimension;

	const seriesByDay = new Map<string, { tokens: number; cost: number; bySeries: Map<string, number> }>();
	for (const day of plan.dayKeys) seriesByDay.set(day, { tokens: 0, cost: 0, bySeries: new Map() });
	const seriesKeys = new Set<string>();
	const add = (day: string, key: string, tokens: number, cost: number) => {
		const bucket = seriesByDay.get(day);
		if (!bucket) return;
		bucket.tokens += tokens;
		bucket.cost += cost;
		bucket.bySeries.set(key, (bucket.bySeries.get(key) ?? 0) + tokens);
		seriesKeys.add(key);
	};

	// Settled days come out of the cache; the rest are computed. The two sets are
	// disjoint by construction, and the live pass filters on day MEMBERSHIP rather
	// than on the range — see DayPlan for why the range alone is not enough.
	//
	// Both halves ultimately read `readAxisRows`: the cache was built through it,
	// and the live pass calls it directly. That is not a tidiness rule — the
	// `category` and `branch` axes divide by a window `COUNT(*)`, so a second
	// query with a differently-shaped join would make a cached day and a live day
	// disagree by an apportioning fraction that nothing would ever flag.
	for (const row of readRollupSeries(db, timeZone, effective, plan.cached, scope)) {
		add(row.day, row.series_key, row.value, row.cost_usd);
	}
	if (plan.live.size > 0) {
		for (const row of readAxisRows(db, scope, effective, plan.liveFromMs, plan.liveToMs)) {
			const day = localDayKey(row.bucket_at_ms, timeZone);
			if (plan.live.has(day)) add(day, row.key, row.tokens, row.cost);
		}
	}
	return {
		series: [...seriesByDay.entries()].map(([date, b]) => ({
			date,
			// Rounded at emission: the category axis apportions a commit's tokens
			// across its topics, so per-day sums can be fractional. Token counts are
			// integers to every consumer; rounding here (not per row) keeps the
			// day's error under half a token.
			tokens: Math.round(b.tokens),
			estCostUsd: b.cost,
			// Sorted, because insertion order is not the same on both halves of a
			// plan: the cache returns a day's series ordered by `series_key`, while a
			// live day arrives in whatever order the axis query emits. Object key
			// order survives `JSON.stringify` all the way to the browser, so without
			// this a day's legend would silently reorder itself the moment that day
			// settled — same numbers, visibly different chart.
			bySeries: Object.fromEntries(
				[...b.bySeries.entries()]
					.sort(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0))
					.map(([k, v]) => [k, Math.round(v)]),
			),
		})),
		seriesKeys: [...seriesKeys].sort(),
		seriesDimension: effective,
	};
}

/**
 * The cost the Spend card actually DRAWS, which is not quite the sum of
 * `estCostUsd`.
 *
 * `apportionedCost` in `stats.js` spreads each day's measured total across that
 * day's series keys by token share, so a day whose per-key tokens all round to
 * zero — the category axis apportions a commit across its topics and rounds —
 * spreads to nothing and draws no bar. The headline is the sum of what is drawn,
 * deliberately: money that is not drawn must not be in the total either.
 *
 * Anything compared AGAINST that headline has to sum the same way, or the two
 * disagree by exactly those days. Hence this being one function rather than a
 * `reduce` at each site.
 */
function drawnCost(result: SeriesResult): number {
	// Read by TYPE, not with `??`. `bySeries` is a plain object here
	// (`Object.fromEntries`) and in the browser (`JSON.parse`), so a series key
	// colliding with an Object.prototype member — a branch really can be named
	// `constructor` — hands back the INHERITED function on any day that key is
	// absent, which is most days. `?? 0` passes it through: `number + function`
	// is string concatenation, `> 0` on the result is false, and that day's cost
	// leaves the headline silently. Same read as `apportionedCost` and
	// `JD.topSeries`, which were hardened first.
	const read = (point: DaySeriesPoint, key: string): number =>
		typeof point.bySeries[key] === "number" ? point.bySeries[key] : 0;
	return result.series.reduce((sum, point) => {
		const tokens = result.seriesKeys.reduce((n, key) => n + read(point, key), 0);
		return tokens > 0 ? sum + point.estCostUsd : sum;
	}, 0);
}

/** Price-table date behind the cost figures, from the newest priced session. */
function readPricesAsOf(db: DashboardDbHandle, scope: DashboardScope): string | undefined {
	const filter = scopeFilter(scopeToRepoIds(db, scope), "repo_id");
	const row = db
		.prepare(
			`SELECT prices_as_of FROM sessions
			  WHERE prices_as_of IS NOT NULL${filter.sql}
			  ORDER BY updated_at_ms DESC LIMIT 1`,
		)
		.get(...filter.params) as { prices_as_of?: string } | undefined;
	return row?.prices_as_of;
}

/**
 * Longest fallback title {@link decisionTitle} will emit, past which it answers
 * `""` instead.
 *
 * Sized off the real corpus rather than picked: the 8,950 stored topic titles on
 * this machine run 32..117 characters (p50 68, p99 94), so a genuine title never
 * reaches this bound and only the fallback can. It is the fallback's no-colon
 * branch that needs it — that one hands back the whole first bullet, measured at
 * 314 characters on a real decisions block, which is precisely the paragraph
 * `decisionTitle` exists to keep off a one-line card.
 */
const DECISION_TITLE_MAX = 120;

/**
 * What the Decisions card renders: the owning topic's title.
 *
 * `TopicSummary.title` is required by the summary schema, so the fallback here
 * is for malformed or pre-schema payloads only, never the normal path. It takes
 * the first bullet of the decisions block (already `**`-stripped by
 * {@link splitDecisionBullets}) and, since these are written `Title: body`,
 * keeps the clause before the first colon. An empty answer is better than a
 * paragraph: the card is one line wide, and the block it would otherwise print
 * has been measured at ~1,900 characters.
 *
 * Which is why the bound is enforced rather than assumed. A bullet with no
 * `: ` to cut at leaves the whole thing standing, so the "clause" this returns
 * was only ever short by convention — see {@link DECISION_TITLE_MAX}.
 */
function decisionTitle(topicTitle: string | null, text: string): string {
	const title = topicTitle?.trim();
	if (title) return title;
	const [first] = splitDecisionBullets(text);
	if (!first) return "";
	const colon = first.indexOf(": ");
	const derived = colon > 0 ? first.slice(0, colon) : first;
	// Dropped whole, not truncated with an ellipsis: half a sentence reads as a
	// title that got cut, while nothing at all reads as "this memory recorded no
	// title" — which is the truth for the malformed payload this branch is for,
	// and the card already renders no quote when the title comes back empty.
	return derived.length <= DECISION_TITLE_MAX ? derived : "";
}

/**
 * Decisions mined from commit memories in the window — the standalone
 * Decisions card. Reuses {@link TOPIC_INSIGHTS_CTE}'s `decision` rows (the same
 * source the Standup page's insight list reads) rather than re-deriving the
 * `json_each` walk a second time.
 *
 * `latest` carries the topic TITLE, not the decision text: the card shows one
 * line and nothing else (JOLLI-2192). `repoIdentity` rides along because the
 * card's title is a link into that memory's row — `repoName` is a display
 * label two registered repos can share, so it cannot address one.
 *
 * That link's hash is `i.commit_hash` — the MEMORY's — and never `c.hash`. The
 * two differ for exactly the commits the alias join below exists for: a hash
 * rewritten after it was summarized leaves the memory filed under the
 * pre-rewrite hash while `commits` has moved on to the new one. `/memories?hash=`
 * resolves against `memories.commit_hash`, so selecting `c.hash` sent those
 * commits to a detail pane that could not resolve — the one link this card has,
 * silently doing nothing, on the rows least likely to be noticed.
 *
 * Carries no "recalled" figure: that needs recall receipts, which — like the
 * feed's `MemoryCard.reuse` — nothing records yet.
 */
function buildDecisionsCard(
	db: DashboardDbHandle,
	scope: DashboardScope,
	fromMs: number,
	toMs: number,
	timeZone: string,
): DecisionsCard {
	const filter = scopeFilter(scopeToRepoIds(db, scope), "c.repo_id");
	const rows = db
		.prepare(
			`${TOPIC_INSIGHTS_CTE}
			 SELECT i.text, i.topic_title, i.commit_hash, c.committed_at_ms, r.repo_name, r.repo_identity
			   FROM commits c
			   JOIN repos r ON r.id = c.repo_id
			   LEFT JOIN commit_aliases al ON al.repo_id = c.repo_id AND al.old_hash = c.hash
			   -- See commitsInRange: a rewritten commit's decisions are still filed
			   -- under the pre-rewrite hash, reachable only through the alias.
			   JOIN topic_insights i ON i.repo_id = c.repo_id AND (i.commit_hash = c.hash OR i.commit_hash = al.target_hash)
			  WHERE i.kind = 'decision' AND c.committed_at_ms >= ? AND c.committed_at_ms < ?${filter.sql}
			  -- i.ord for the same reason buildStandupInsights carries it: one commit
			  -- contributes several decision rows sharing its timestamp, so the date
			  -- alone does not pick a first row — and rows[0] here IS the card (its
			  -- one line and its one deep link).
			  ORDER BY c.committed_at_ms DESC, i.ord`,
		)
		.all(fromMs, toMs, ...filter.params) as ReadonlyArray<{
		text: string;
		topic_title: string | null;
		commit_hash: string;
		committed_at_ms: number;
		repo_name: string;
		repo_identity: string;
	}>;

	const perDayMap = new Map<string, number>();
	for (let dayStart = fromMs; dayStart < toMs; dayStart = addLocalDays(dayStart, 1, timeZone)) {
		perDayMap.set(localDayKey(dayStart, timeZone), 0);
	}
	for (const row of rows) {
		const key = localDayKey(row.committed_at_ms, timeZone);
		perDayMap.set(key, (perDayMap.get(key) ?? 0) + 1);
	}

	const first = rows[0];
	const latest: DecisionRecord | undefined = first
		? {
				title: decisionTitle(first.topic_title, first.text),
				commitHash: first.commit_hash,
				repoName: first.repo_name,
				repoIdentity: first.repo_identity,
				committedAtMs: first.committed_at_ms,
			}
		: undefined;

	return {
		keptCount: rows.length,
		repoCount: new Set(rows.map((r) => r.repo_name)).size,
		...(latest ? { latest } : {}),
		perDay: [...perDayMap.entries()].map(([date, count]) => ({ date, count })),
	};
}

function buildStats(
	db: DashboardDbHandle,
	scope: DashboardScope,
	timeZone: string,
	nowMs: number,
	tier: AdoptionTier,
	dimension: SeriesDimension,
	window: ResolvedWindow,
	reachable?: ReachableCommits,
): StatsModel {
	const tomorrowStart = addLocalDays(nowMs, 1, timeZone);
	const heatmapStart = addLocalDays(nowMs, -(HEATMAP_DAYS - 1), timeZone);
	// The KPI row, the series and the session feed share ONE window — the
	// selected range — so every figure on the page answers the same question.
	// The heatmap and the records row keep their own 12-week span (HEATMAP_DAYS).
	// One sweep over the heatmap window feeds the heatmap, the hour histogram and
	// the records row. A PRESET range is always inside that sweep, so its rows
	// are a filter over what is already in memory; a custom range can start
	// before it or end before today, which needs its own scan.
	const windowSessions = sessionsInRange(db, scope, heatmapStart, tomorrowStart);
	const windowCommits = commitsInRange(db, scope, heatmapStart, tomorrowStart);
	const insideSweep = window.startMs >= heatmapStart && window.endMs <= tomorrowStart;
	const inWindow = (ms: number) => ms >= window.startMs && ms < window.endMs;
	const rangeSessions = insideSweep
		? windowSessions.filter((s) => inWindow(s.updated_at_ms))
		: sessionsInRange(db, scope, window.startMs, window.endMs);

	// The plan splits the window into days already settled in the rollup cache and
	// days that still have to be computed. Resolved per window, because a plan is
	// only valid for the range it was cut for — the prior window below cuts its
	// own.
	const plan = planDays(db, timeZone, window.startMs, window.endMs, nowMs);

	// "Tokens" — input/output/cache over the range, day-bucketed for the card's
	// chart, placed on the day each response actually happened.
	//
	// NOT from `rangeSessions`, and that is a different answer rather than a
	// cheaper one: a session carries one cumulative total under a single
	// timestamp, so a conversation spanning three days put all of its tokens on
	// the last one. `rangeSessions` still answers everything that is genuinely
	// about sessions — how many there were, when the machine was last active —
	// and nothing about how much they spent.
	//
	// One consequence worth stating: a usage line the parser cannot date is
	// counted in the session's own totals but dropped from the events (see
	// `readTranscript`), so these figures can sit a hair BELOW the session-level
	// ones. That is the right side to err on for a per-DAY card — an undatable
	// token has no day to be shown on.
	const tokenBreakdown = readTokenTotals(db, scope, timeZone, plan);

	// Cost/token series along the requested dimension, over the range.
	const seriesResult = buildSeries(db, scope, dimension, tier, timeZone, plan);

	// Cost vs the immediately preceding window of equal length — the Spend card's
	// own self-trend, and BOTH ends are the same series the card draws.
	//
	// It used to be a sum of `sessions.est_cost_usd` over each window, which is a
	// different clock AND a different population from the headline directly above
	// it: on `branch`/`ticket`/`category` the series is memory rows windowed on
	// committer date, so a window with sessions but no summarized commits read
	// "$0.00" with an arrow beside it claiming +200%. Even on `model` the two
	// disagree — the series reads `session_model_usage`, not `sessions`. A
	// self-trend is only worth printing if it trends the number it sits next to.
	const priorRangeFrom = window.startMs - (window.endMs - window.startMs);
	const priorPlan = planDays(db, timeZone, priorRangeFrom, window.startMs, nowMs);
	const priorSeries = buildSeries(db, scope, dimension, tier, timeZone, priorPlan);
	const priorDrawn = drawnCost(priorSeries);
	const costTrendPct =
		priorDrawn > 0 ? Math.round(((drawnCost(seriesResult) - priorDrawn) / priorDrawn) * 100) : undefined;

	// Memory-tier KPI sub-lines. `undefined` below the tier so the card renders
	// the mockup's "—" instead of asserting a real zero.
	const rangeCommits = insideSweep
		? windowCommits.filter((c) => inWindow(c.committed_at_ms))
		: commitsInRange(db, scope, window.startMs, window.endMs);
	// `root_hash`, not turns/tokens: a captured memory can legitimately leave
	// those null (see CommitRow), which would undercount "captured" and inflate
	// the Memory Activity gap count against commits that were never actually gaps.
	//
	// Reachability filters the CAPTURED side only, never `totalCommits` or the
	// heatmap: those answer "what did I do", where a commit that has since been
	// squashed away still happened. "Captured" sits directly above the memory
	// card list and has to count the same rows that list renders — otherwise a
	// branch of forty squashed predecessors reads as "41 captured" over two
	// cards.
	const memoriesCreated =
		tier === "installed"
			? undefined
			: rangeCommits.filter((c) => c.root_hash != null && isReachable(reachable, c.repo_identity, c.hash)).length;
	const decisions =
		tier === "installed" ? undefined : buildDecisionsCard(db, scope, window.startMs, window.endMs, timeZone);

	const pricesAsOf = readPricesAsOf(db, scope);

	// Heatmap + hour histogram from the same window sweep. Commits count as
	// their own dimension: sessions older than the live-log window survive only
	// as stored summaries, so commit dates carry the long tail of history and a
	// commit-only day must not render as inactive.
	const heatmapByDay = new Map<string, { sessions: number; commits: number; tokens: number }>();
	for (let dayStart = heatmapStart; dayStart < tomorrowStart; dayStart = addLocalDays(dayStart, 1, timeZone)) {
		heatmapByDay.set(localDayKey(dayStart, timeZone), { sessions: 0, commits: 0, tokens: 0 });
	}
	const hourCounts = new Array<number>(24).fill(0);
	let nightOwl = 0;
	for (const s of windowSessions) {
		const cell = heatmapByDay.get(localDayKey(s.updated_at_ms, timeZone));
		if (cell) {
			cell.sessions += 1;
			cell.tokens += totalTokens(s);
		}
		const hour = localHour(s.updated_at_ms, timeZone);
		hourCounts[hour] += 1;
		if (hour >= NIGHT_OWL_HOUR) nightOwl += 1;
	}
	for (const c of windowCommits) {
		const cell = heatmapByDay.get(localDayKey(c.committed_at_ms, timeZone));
		if (cell) cell.commits += 1;
	}
	const heatmap: HeatmapCell[] = [...heatmapByDay.entries()].map(([date, cell]) => ({ date, ...cell }));
	const hours: HourBucket[] = hourCounts.map((sessions, hour) => ({ hour, sessions }));

	// Fun stats.
	const longest = windowSessions.reduce<SessionRow | null>(
		(best, s) => ((s.duration_ms ?? 0) > (best?.duration_ms ?? 0) ? s : best),
		null,
	);
	let biggestDayDate: string | undefined;
	let biggestDayTokens = 0;
	for (const [date, cell] of heatmapByDay) {
		if (cell.tokens > biggestDayTokens) {
			biggestDayTokens = cell.tokens;
			biggestDayDate = date;
		}
	}
	const fun: FunStats = {
		legendarySessionMinutes: Math.round((longest?.duration_ms ?? 0) / 60_000),
		...(longest?.title ? { legendarySessionTitle: longest.title } : {}),
		...(longest && longest.message_count != null ? { legendarySessionTurns: longest.message_count } : {}),
		...(biggestDayDate ? { biggestDayDate } : {}),
		biggestDayTokens,
		nightOwlSharePct: windowSessions.length > 0 ? Math.round((nightOwl / windowSessions.length) * 100) : 0,
	};

	// The feed follows the range, not the 12-week sweep: on a custom window that
	// predates the sweep, showing this month's sessions under a January heading
	// would be actively misleading.
	const recentSessions = rangeSessions.slice(0, 20).map((s) => toRecentSession(s, nowMs));
	// The memory-tier feed. Built unconditionally: an installed-tier repo simply
	// has no summarized commits, so this comes back empty and the renderer shows
	// the session list instead.
	const memoryFeed = buildMemoryCards(db, scope, window, reachable);
	const concurrency = buildConcurrency(db, window);

	return {
		...seriesResult,
		heatmap,
		hours,
		tokenBreakdown,
		...(costTrendPct !== undefined ? { costTrendPct } : {}),
		// Reported by the builder, not inferred from the page it returned: the feed
		// is cut inside it, so `length === MEMORY_CARDS_LIMIT` is equally "the
		// window holds exactly that many" and "the twenty most recent of three
		// hundred" — and the page has no constant to compare against either way.
		...(memoryFeed.capped ? { memoryCardsCapped: true } : {}),
		fun,
		recentSessions,
		memoryCards: memoryFeed.cards,
		totalCommits: rangeCommits.length,
		range: window.range,
		rangeFrom: window.from,
		rangeTo: window.to,
		toolUsage: buildToolUsage(db, scope, window),
		...(concurrency !== undefined ? { concurrency } : {}),
		...(pricesAsOf ? { pricesAsOf } : {}),
		...(memoriesCreated !== undefined ? { memoriesCreated } : {}),
		...(decisions !== undefined ? { decisionsCaptured: decisions.keptCount, decisions } : {}),
	};
}

function toRecentSession(s: SessionRow, nowMs: number): RecentSession {
	return {
		sessionId: s.session_id,
		source: s.source,
		title: s.title ?? `${s.source} session`,
		messageCount: s.message_count ?? 0,
		updatedAtMs: s.updated_at_ms,
		repoName: s.repo_name,
		isLive: nowMs - s.updated_at_ms < LIVE_WINDOW_MS,
	};
}

// ── Standup page ────────────────────────────────────────────────────────────

/**
 * Render order for standup insights: risks first, notes last.
 *
 * The first three entries never match anything — {@link TOPIC_INSIGHTS_CTE} emits
 * only `decision` and `todo` — so today this sorts TODOs ahead of decisions and
 * nothing else. Kept whole rather than trimmed to the producible pair: the order
 * is the answer to "where would a risk go", which is a question the list should
 * still answer if the summarizer learns to record one. See `CommitInsightKind`.
 */
const INSIGHT_ORDER: ReadonlyArray<CommitInsightKind> = ["blocker", "question", "gotcha", "todo", "decision"];

/** Insights mined from the standup window's commit memories. */
function buildStandupInsights(
	db: DashboardDbHandle,
	scope: DashboardScope,
	fromMs: number,
	toMs: number,
	identity: AuthorIdentity | undefined,
): StandupInsight[] {
	const filter = scopeFilter(scopeToRepoIds(db, scope), "c.repo_id");
	// Same filter as the commit columns, and for a stronger reason: the Risks
	// column is a list of things the reader is expected to answer for. A
	// teammate's blocker rendered here is work silently reassigned to whoever
	// reads the board.
	const author = authorFilter(identity, "c");
	const rows = db
		.prepare(
			`${TOPIC_INSIGHTS_CTE}
			 SELECT i.kind, i.text, i.addressed_to, c.hash, c.committed_at_ms, r.repo_name
			   FROM commits c
			   JOIN repos r ON r.id = c.repo_id
			   LEFT JOIN commit_aliases al ON al.repo_id = c.repo_id AND al.old_hash = c.hash
			   -- See commitsInRange / buildDecisionsCard: a rewritten commit's insights
			   -- are still filed under the pre-rewrite hash, reachable only through the
			   -- alias. Without this join an amended commit's blockers and questions
			   -- vanish from Standup while its decisions still render on the Decisions
			   -- card, which reads the same table through the alias.
			   JOIN topic_insights i ON i.repo_id = c.repo_id AND (i.commit_hash = c.hash OR i.commit_hash = al.target_hash)
			  WHERE c.committed_at_ms >= ? AND c.committed_at_ms < ?${filter.sql}${author.sql}
			  ORDER BY c.committed_at_ms DESC, i.ord`,
		)
		.all(fromMs, toMs, ...filter.params, ...author.params) as ReadonlyArray<{
		kind: string;
		text: string;
		addressed_to: string | null;
		hash: string;
		committed_at_ms: number;
		repo_name: string;
	}>;
	return rows
		.map((row) => ({
			kind: row.kind as CommitInsightKind,
			text: row.text,
			commitHash: row.hash,
			repoName: row.repo_name,
			committedAtMs: row.committed_at_ms,
			...(row.addressed_to ? { addressedTo: row.addressed_to } : {}),
		}))
		.sort((a, b) => INSIGHT_ORDER.indexOf(a.kind) - INSIGHT_ORDER.indexOf(b.kind));
}

function buildStandup(
	db: DashboardDbHandle,
	scope: DashboardScope,
	timeZone: string,
	nowMs: number,
	tier: AdoptionTier,
	identity: AuthorIdentity | undefined,
): StandupModel {
	const todayStart = startOfLocalDay(nowMs, timeZone);
	const tomorrowStart = addLocalDays(nowMs, 1, timeZone);
	const yesterdayStart = addLocalDays(nowMs, -1, timeZone);

	/* What the header states the board is filtered to. Derived from the SAME
	   identity the queries were given (and by the same emptiness rule), so the
	   label can never claim a filter that did not run — including the fail-open
	   case, where it stays absent and the page says so. */
	const authoredBy = authorFilter(identity, "c").sql
		? (identity?.emails.find((email) => email.trim() !== "") ?? identity?.names.find((name) => name.trim() !== ""))
		: undefined;

	const categoryLabels = commitCategoryLabels(db, scope);
	const toStandupCommit = (c: CommitRow): StandupCommit => {
		const workCategory = categoryLabels.get(`${c.repo_identity}\0${c.hash}`);
		return {
			hash: c.hash,
			message: c.message ?? "",
			...(c.branch ? { branch: c.branch } : {}),
			committedAtMs: c.committed_at_ms,
			repoName: c.repo_name,
			...(c.files_changed != null ? { filesChanged: c.files_changed } : {}),
			...(c.insertions != null ? { insertions: c.insertions } : {}),
			...(c.deletions != null ? { deletions: c.deletions } : {}),
			/* Memory-tier columns, absent (not zero) until the summary pipeline fills
			   them: the board's outcome rows read them, and a 0 would render as a real
			   "$0.00 est · 0 turns" rather than as "not known for this commit". */
			...(c.turns != null ? { turns: c.turns } : {}),
			...(c.est_cost_usd != null ? { estCostUsd: c.est_cost_usd } : {}),
			...(c.ticket_id ? { ticketId: c.ticket_id } : {}),
			...(workCategory ? { workCategory } : {}),
		};
	};

	const filter = scopeFilter(scopeToRepoIds(db, scope), "w.repo_id");
	const workspaceRows = db
		.prepare(
			// Stale observations are dropped, not shown: the row says "there is
			// uncommitted work on this branch right now", and only another
			// observation of the same branch can correct it — so a committed,
			// abandoned or deleted branch keeps claiming changes forever. See
			// WORKTREE_STATUS_MAX_AGE_MS.
			`SELECT w.branch, w.files_changed, w.insertions, w.deletions, r.repo_name
			   FROM worktree_status w JOIN repos r ON r.id = w.repo_id
			  WHERE (w.files_changed > 0 OR w.insertions > 0 OR w.deletions > 0)
			    AND w.observed_at_ms >= ?${filter.sql}
			  ORDER BY w.observed_at_ms DESC`,
		)
		.all(nowMs - WORKTREE_STATUS_MAX_AGE_MS, ...filter.params) as ReadonlyArray<{
		branch: string | null;
		files_changed: number | null;
		insertions: number | null;
		deletions: number | null;
		repo_name: string;
	}>;
	const workspaces: StandupWorkspace[] = workspaceRows.map((w) => ({
		repoName: w.repo_name,
		...(w.branch ? { branch: w.branch } : {}),
		filesChanged: w.files_changed ?? 0,
		insertions: w.insertions ?? 0,
		deletions: w.deletions ?? 0,
	}));

	return {
		today: localDayKey(nowMs, timeZone),
		yesterday: localDayKey(yesterdayStart, timeZone),
		/* Sessions and workspaces carry no author filter, and need none: an agent
		   session and an uncommitted diff are this machine's own working state, so
		   they are already first-person. Only `commits` can hold a teammate's row. */
		yesterdaySessions: sessionsInRange(db, scope, yesterdayStart, todayStart).map((s) => toRecentSession(s, nowMs)),
		yesterdayCommits: commitsInRange(db, scope, yesterdayStart, todayStart, identity).map(toStandupCommit),
		todaySessions: sessionsInRange(db, scope, todayStart, tomorrowStart).map((s) => toRecentSession(s, nowMs)),
		todayCommits: commitsInRange(db, scope, todayStart, tomorrowStart, identity).map(toStandupCommit),
		workspaces,
		...(authoredBy ? { authoredBy } : {}),
		...(tier !== "installed"
			? { insights: buildStandupInsights(db, scope, yesterdayStart, tomorrowStart, identity) }
			: {}),
	};
}

// ── File heat ───────────────────────────────────────────────────────────────

/**
 * The window's most-touched files, plus how much of the window has file data.
 *
 * Two queries rather than one grouped scan: the ranking needs `commit_files`
 * joined to the window, while the coverage ratio needs the count of commits in
 * the window REGARDLESS of whether they have file rows — a join can only ever
 * see the commits that do, so it cannot compute its own denominator.
 */

/** One `memories` row, joined to its repo name. */
interface MemoryCardRow {
	readonly repo_identity: string;
	readonly commit_hash: string;
	readonly commit_message: string | null;
	readonly committed_at_ms: number;
	readonly recap: string | null;
	readonly turns: number | null;
	readonly est_cost_usd: number | null;
	readonly branch: string | null;
	readonly insertions: number | null;
	readonly deletions: number | null;
	readonly summary_json: string;
	readonly repo_name: string;
}

/**
 * First recorded decision, as one line. Returns undefined when no topic
 * recorded one, letting the caller fall back to the recap rather than
 * printing an empty "Decision:".
 */
function firstDecisionLine(topics: ReadonlyArray<{ readonly decisions?: string }>): string | undefined {
	for (const topic of topics) {
		const [first] = splitDecisionBullets(topic.decisions);
		if (first) return first;
	}
	return undefined;
}

/**
 * The model that did the work, picked by output tokens.
 *
 * Deliberately NOT `summary.llm.model`: that records which model *wrote the
 * summary*, so a card would advertise the summarizer instead of the agent that
 * produced the commit.
 */
function dominantWorkingModel(summary: CommitSummary): string | undefined {
	const models = summary.conversationModels ?? [];
	let best: { model: string; output: number } | undefined;
	for (const entry of models) {
		const output = entry.output ?? 0;
		if (!entry.model) continue;
		if (!best || output > best.output) best = { model: entry.model, output };
	}
	return best?.model;
}

interface MemoryCardFeed {
	readonly cards: MemoryCard[];
	/**
	 * More memories in the window than {@link cards} carries.
	 *
	 * Travels out of here rather than being inferred from `cards.length`,
	 * because that length cannot tell a window holding exactly
	 * {@link MEMORY_CARDS_LIMIT} memories (complete) from one holding three
	 * hundred (cut). Only this function still holds the un-cut set.
	 */
	readonly capped: boolean;
}

/**
 * The "What my agents did" feed at the memory tier: commits paired with the
 * session summary that produced them.
 *
 * Reads the SOT tables rather than the `commits` read model — the decision text
 * and the working models live in the summary payload, which only exists there.
 * Category is derived with the same `collectDisplayTopics` helper so the card
 * agrees with the query-time labels built from `memory_topics` (same topics,
 * same tie rule).
 */
function buildMemoryCards(
	db: DashboardDbHandle,
	scope: DashboardScope,
	window: ResolvedWindow,
	reachable?: ReachableCommits,
): MemoryCardFeed {
	// `repo_id` belongs to the memory row (`c`), not the joined repo lookup
	// (`r`).  Using `r.repo_id` only breaks the scoped form of the query; the
	// catch below then intentionally degrades to an empty feed, which used to
	// make every `?repo=...` dashboard look like it had no Memory Activity.
	const repoScope = scopeToRepoIds(db, scope);
	const filter = scopeFilter(repoScope, "c.repo_id");
	let rows: ReadonlyArray<MemoryCardRow>;
	let decisionCounts: ReadonlyMap<string, number> = new Map();
	let capped = false;
	try {
		// Two steps, because the reachability filter can only run in JS (git, not
		// the DB — see `ReachableCommits`) and a rewritten-away commit keeps its
		// `memories` row forever: filtering a LIMIT-ed page would leave the feed
		// showing the two survivors of the twenty most recent rows instead of the
		// twenty most recent surviving memories. Step one is deliberately narrow —
		// the payload blob is only read for the page that is actually rendered.
		//
		// Windowed, sorted and stamped on {@link MEMORY_LANDING_CTE}'s `at_ms` —
		// the LANDED committer date — for the reason stated there: the memory's own
		// `commit_date_ms` is an author date (`%aI` via `CommitSummary.commitDate`,
		// against the `%cI` every other window in this file uses), so windowing on
		// it put a rebased or cherry-picked commit in a different bucket from the
		// "N of M captured" line directly above the list, and the header counted
		// memories the feed did not show.
		const keys = db
			.prepare(
				`${MEMORY_LANDING_CTE}
				 SELECT c.commit_hash, ml.live_hash, r.repo_identity
				   FROM memories c
				   JOIN repos r ON r.id = c.repo_id
				   JOIN memory_landing ml ON ml.repo_id = c.repo_id AND ml.commit_hash = c.commit_hash
				  WHERE c.parent_hash IS NULL
				    AND ml.at_ms >= ? AND ml.at_ms < ?${filter.sql}
				  ORDER BY ml.at_ms DESC`,
			)
			.all(window.startMs, window.endMs, ...filter.params) as ReadonlyArray<{
			commit_hash: string;
			live_hash: string;
			repo_identity: string;
		}>;
		// Reachability is asked about `live_hash`, never the memory's own hash: a
		// rewritten commit's memory stays filed under a hash no ref reaches, so
		// asking about that one drops from the feed exactly the memories
		// `memoriesCreated` has just counted through the alias — the two figures
		// sit in the same card.
		const eligible = keys.filter((k) => isReachable(reachable, k.repo_identity, k.live_hash));
		const page = eligible.slice(0, MEMORY_CARDS_LIMIT);
		// Decided HERE, where the un-cut set is still in hand. `cards.length` cannot
		// answer it: a window holding exactly the limit is complete, and reporting
		// it as capped makes the card say "showing the 20 most recent" of 20.
		capped = eligible.length > MEMORY_CARDS_LIMIT;
		if (page.length === 0) return { cards: [], capped: false };
		const holes = page.map(() => "?").join(",");
		rows = db
			.prepare(
				// {@link MEMORY_LANDING_CTE}'s `at_ms` again — the SAME expression the
				// key query selected and windowed on, not a restatement of it. Both the
				// sort and the timestamp the card renders have to come from that one
				// clock: ordering on `c.commit_date_ms` re-sorted the page by AUTHOR
				// date after it had been selected on the committer date, and STAMPING a
				// row with it rendered a date that can fall outside the window the row
				// was selected for. A near-miss spelling is what this replaces —
				// `COALESCE(cm.committed_at_ms, c.commit_date_ms)` agrees with `at_ms`
				// only while the memory's own commit row survives, and skips the alias
				// hop in exactly the rewritten case both queries exist to handle.
				`${MEMORY_LANDING_CTE}
				 SELECT c.commit_hash, c.commit_message, ml.at_ms AS committed_at_ms,
				        c.recap, c.turns, c.est_cost_usd,
				        c.branch, c.insertions, c.deletions, c.summary_json, r.repo_identity, r.repo_name
				   FROM memories c
				   JOIN repos r ON r.id = c.repo_id
				   JOIN memory_landing ml ON ml.repo_id = c.repo_id AND ml.commit_hash = c.commit_hash
				  WHERE c.parent_hash IS NULL AND c.commit_hash IN (${holes})${filter.sql}
				  ORDER BY ml.at_ms DESC`,
			)
			.all(...page.map((k) => k.commit_hash), ...filter.params) as ReadonlyArray<MemoryCardRow>;
		// `IN (hashes)` is keyed on the hash alone, so an unscoped dashboard whose
		// repos share a commit (a fork, a vendored tree) can match a row the page
		// did not select. Re-narrowing to the selected (repo, hash) pairs keeps the
		// card count at the limit and the rows the ones that survived the filter.
		const selected = new Set(page.map((k) => `${k.repo_identity}\0${k.commit_hash}`));
		rows = rows.filter((row) => selected.has(`${row.repo_identity}\0${row.commit_hash}`));
		// Its own catch, deliberately NOT the one below: `rows` is already resolved
		// at this point, and the counts feed one optional badge per card. Sharing
		// the outer catch made a failure in a decorative query return the empty
		// feed the rest of this function had just finished computing.
		try {
			decisionCounts = decisionCountsFor(db, repoScope, page);
		} catch (err) {
			log.warn("memory card decision counts unavailable: %s", errMsg(err));
		}
	} catch (err) {
		// The feed is one card on one page; a query failure degrades it to the
		// tier-0 session list rather than taking the whole dashboard down.
		log.warn("memory cards unavailable: %s", errMsg(err));
		return { cards: [], capped: false };
	}

	const cards = rows.map((row) => {
		// Not guarded: `memories` computes STORED generated columns with
		// `json_extract`, so SQLite rejects a malformed payload at INSERT
		// ("malformed JSON") — no unparseable row can exist to read here. Pinned by
		// a schema test rather than by a defensive branch that could never run.
		const summary = JSON.parse(row.summary_json) as CommitSummary;
		const topics = collectDisplayTopics(summary);
		const counts = new Map<string, number>();
		for (const topic of topics) {
			if (topic.category) counts.set(topic.category, (counts.get(topic.category) ?? 0) + 1);
		}
		const category = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
		const decision = firstDecisionLine(topics) ?? row.recap ?? undefined;
		const decisionCount = decisionCounts.get(`${row.repo_identity}\0${row.commit_hash}`) ?? 0;
		const changed = (row.insertions ?? 0) + (row.deletions ?? 0);
		return {
			repoIdentity: row.repo_identity,
			commitHash: row.commit_hash,
			title: row.commit_message ?? "",
			...(category ? { category } : {}),
			severity: changed >= MEMORY_CARD_MAJOR_LINES ? ("major" as const) : ("minor" as const),
			committedAtMs: row.committed_at_ms,
			...(decision ? { decision } : {}),
			...(decisionCount > 0 ? { decisionCount } : {}),
			...(row.est_cost_usd != null ? { estCostUsd: row.est_cost_usd } : {}),
			...(row.turns != null ? { turns: row.turns } : {}),
			...(row.insertions != null ? { insertions: row.insertions } : {}),
			...(row.deletions != null ? { deletions: row.deletions } : {}),
			...(row.branch ? { branch: row.branch } : {}),
			...withModel(summary),
			repoName: row.repo_name,
		};
	});
	return { cards, capped };
}

/**
 * Decisions recorded per memory card, keyed `repoIdentity\0commitHash`.
 *
 * Counts {@link TOPIC_INSIGHTS_CTE} rows — one per topic that recorded any
 * decision — which is EXACTLY what `buildDecisionsCard`'s `keptCount` counts,
 * and that figure is rendered as "N decisions" directly above this list. A
 * per-bullet count (`splitDecisionBullets`) would be defensible on its own and
 * is wrong here: the two numbers sit in the same card and would disagree.
 *
 * Scoped on `i.repo_id` as well as the hash, for the reason spelled out in
 * `buildMemoryCards`: an unscoped dashboard whose repos share a commit (a fork,
 * a vendored tree) would otherwise add another project's decisions to this row.
 *
 * No `commit_aliases` join, unlike the Decisions card: that one enters from the
 * `commits` side, where a rewritten commit's insights are filed under the
 * pre-rewrite hash. `topic_insights` is derived FROM `memories`, and these cards
 * are selected from `memories` too, so both sides already name the same hash.
 */
function decisionCountsFor(
	db: DashboardDbHandle,
	repoScope: ResolvedScope,
	page: ReadonlyArray<{ commit_hash: string; repo_identity: string }>,
): ReadonlyMap<string, number> {
	const filter = scopeFilter(repoScope, "i.repo_id");
	const holes = page.map(() => "?").join(",");
	const rows = db
		.prepare(
			`${TOPIC_INSIGHTS_CTE}
			 SELECT r.repo_identity, i.commit_hash, COUNT(*) AS n
			   FROM topic_insights i
			   JOIN repos r ON r.id = i.repo_id
			  WHERE i.kind = 'decision' AND i.commit_hash IN (${holes})${filter.sql}
			  GROUP BY r.repo_identity, i.commit_hash`,
		)
		.all(...page.map((k) => k.commit_hash), ...filter.params) as ReadonlyArray<{
		repo_identity: string;
		commit_hash: string;
		n: number;
	}>;
	return new Map(rows.map((row) => [`${row.repo_identity}\0${row.commit_hash}`, row.n]));
}

/** Spreads the working model in only when one is recorded. */
function withModel(summary: CommitSummary): { model?: string } {
	const model = dominantWorkingModel(summary);
	return model ? { model } : {};
}

// ── Concurrency ──────────────────────────────────────────────────────────────

/**
 * The concurrency figure. Takes a window but NOT a scope: it is machine-global
 * by design (see {@link ConcurrencyModel}).
 */
function buildConcurrency(db: DashboardDbHandle, window: ResolvedWindow): ConcurrencyModel | undefined {
	const rows = db
		.prepare(
			// COUNT(DISTINCT session_event_id) would be WRONG: `sessions` is unique
			// on (repo_id, source, session_id), so one agent session that touched
			// two repos is two rows with two event ids and would count as two
			// agents. Machine-global aggregation makes that certain, not latent.
			`SELECT a.bucket_ms AS bucket_ms,
			        COUNT(DISTINCT s.source || ':' || s.session_id) AS n
			   FROM session_activity a
			   JOIN sessions s ON s.event_id = a.session_event_id
			  WHERE a.bucket_ms >= ? AND a.bucket_ms < ?
			  GROUP BY a.bucket_ms
			  ORDER BY a.bucket_ms`,
		)
		.all(window.startMs, window.endMs) as ReadonlyArray<{ bucket_ms: number; n: number }>;
	if (rows.length === 0) return undefined;

	const buckets = rows.map((r) => ({ bucketMs: r.bucket_ms, sessions: r.n }));
	const peak = buckets.reduce((max, b) => (b.sessions > max ? b.sessions : max), 0);
	const total = buckets.reduce((sum, b) => sum + b.sessions, 0);

	// Derived per query, never a declared list: the declarative alternative is
	// the shape of `PARSER_BACKED_SOURCES`, which omits `kimi` even though
	// `getParserForSource` accepts it.
	const measured = new Set(
		(
			db
				.prepare(
					`SELECT DISTINCT s.source AS source
					   FROM session_activity a
					   JOIN sessions s ON s.event_id = a.session_event_id
					  WHERE a.bucket_ms >= ? AND a.bucket_ms < ?`,
				)
				.all(window.startMs, window.endMs) as ReadonlyArray<{ source: string }>
		).map((r) => r.source),
	);
	// "Uncovered" is asked of the SESSIONS, not of the chart, and the two are
	// different questions — which is why this is its own query rather than
	// `seen − measured`.
	//
	// `measured` above is window-scoped on `bucket_ms`, so it answers "did this
	// source draw a bar". A session is admitted to the window by `updated_at_ms`
	// instead, and the two need not agree: a conversation resumed just after
	// midnight, or one from a source whose `updatedAt` is its store row's own
	// timestamp rather than its last turn, is in-window while every one of its
	// buckets predates the window. Subtracting `measured` reported that agent as
	// carrying no per-turn timestamps at all, when the truth is only that its
	// timestamps are older than the range being looked at.
	//
	// NOT a boundary-rounding problem, which is the tempting reading and is
	// wrong: `resolveWindow` puts both bounds through `addLocalDays`, which snaps
	// to a local midnight, and every IANA offset is a multiple of 15 minutes — so
	// a window bound is always bucket-aligned, and a bucket holding an in-window
	// turn is always in-window itself.
	//
	// `EXISTS` over the session's own activity rows, unwindowed, is the honest
	// test: a session that produced ANY bucket proves its source can be measured.
	// What is left is what the label means — transcripts with no turn timestamps.
	const uncovered = (
		db
			.prepare(
				`SELECT s.source AS source
				   FROM sessions s
				  WHERE s.updated_at_ms >= ? AND s.updated_at_ms < ?
				  GROUP BY s.source
				 HAVING SUM(EXISTS (SELECT 1 FROM session_activity a WHERE a.session_event_id = s.event_id)) = 0`,
			)
			.all(window.startMs, window.endMs) as ReadonlyArray<{ source: string }>
	).map((r) => r.source);

	return {
		buckets,
		bucketMinutes: ACTIVITY_BUCKET_MS / 60_000,
		peak,
		meanActive: total / buckets.length,
		measuredSources: [...measured].sort(),
		uncoveredSources: uncovered.sort(),
	};
}

// ── Tool / skill / MCP usage ────────────────────────────────────────────────

/** Most calls first, then by source, so equal-volume agents order deterministically. */
function sortAgents<T extends ToolUsageAgentShare>(agents: ReadonlyArray<T>): T[] {
	return [...agents].sort((a, b) => b.calls - a.calls || a.source.localeCompare(b.source));
}

/**
 * The WHERE clause every query in this section shares — the window, applied to
 * the CALL's own time, plus the page's repo scope.
 *
 * Windowed by the CALL, like the Recall card — see {@link TOOL_CALL_TIME_SQL}.
 * The two panels report the same rows from the same table, so a `jolli-recall`
 * bucket landing on one day here and another day there is a contradiction the
 * reader has no way to resolve.
 *
 * Built once and threaded into each query rather than re-derived per query: the
 * three lists, their totals, the per-row agent splits and the recall row must
 * all be answering about the same set of rows, and `scopeToRepoIds` is a lookup
 * this section would otherwise repeat six times.
 */
function toolUsageWhere(
	db: DashboardDbHandle,
	scope: DashboardScope,
	window: ResolvedWindow,
): { sql: string; params: unknown[] } {
	const filter = scopeFilter(scopeToRepoIds(db, scope), "s.repo_id");
	return {
		sql: `${TOOL_CALL_TIME_SQL} >= ? AND ${TOOL_CALL_TIME_SQL} < ?${filter.sql}`,
		params: [window.startMs, window.endMs, ...filter.params],
	};
}

/** `session_tool_use.kind` each list is drawn from — two of the three share one. */
const TOOL_LIST_KIND: Readonly<Record<ToolUsageList, string>> = { skill: "skill", tool: "mcp", server: "mcp" };

/**
 * The MCP server a row is grouped under, plugin alias folded away.
 *
 * Unguarded {@link stripPluginPrefixSql} rather than `mcpFoldedIdentifierSql`:
 * every query reading these two constants pins `t.kind = ?` to
 * {@link TOOL_LIST_KIND}, so the rows are MCP by construction. The memory-detail
 * activity query in `MemoriesQuery.ts` mixes kinds and takes the guarded form.
 */
const SERVER_KEY_SQL = stripPluginPrefixSql("t.server");

/** The tool a row is grouped under — same fold, because the name embeds the server. */
const TOOL_KEY_SQL = stripPluginPrefixSql("t.tool_name");

/**
 * What identifies a row in each list.
 *
 * `skill` deliberately keeps the RAW column. The fold exists for MCP
 * identifiers, where `plugin_…` is a registration alias the host prepended; a
 * skill name is a name the user chose, so a skill that happened to start with
 * `plugin_` would be silently renamed by a rule that has nothing to do with it.
 * Claude's own plugin skills are namespaced `jolli:init`, not `plugin_jolli_…`,
 * so there is no duplicate to merge on that list in the first place.
 */
const TOOL_LIST_KEY: Readonly<Record<ToolUsageList, string>> = {
	skill: "t.tool_name",
	tool: TOOL_KEY_SQL,
	server: SERVER_KEY_SQL,
};

/**
 * `ORDER BY` per list — the ranking, and the tiebreak that makes it pageable.
 *
 * A ranked list must be ordered by the figure its rows PRINT, or the card
 * contradicts itself twice over. Both MCP lists print calls and size their bars
 * by calls, so ranking them by sessions was wrong in a way that read as a
 * rendering fault rather than a sort one: measured on a real database, the
 * servers card came out jollimemory (32 sessions / 68 calls), codegraph
 * (27 / 149), dbhub (9 / 76) — descending sessions, visibly unsorted calls — and
 * because `rankedList` sizes every bar against the FIRST row, codegraph asked
 * for 219% and dbhub for 112%, both clamped by `.rl-bar`'s `overflow: hidden`,
 * so three different volumes all rendered as one full-width bar. Skills ranks by
 * ADOPTION deliberately: one session hammering /simplify 200 times should not
 * outrank /code-review reached from three, and that card's own doc comment is
 * the authority for its list.
 *
 * The trailing name is not decoration. `LIMIT`/`OFFSET` only partition a list
 * cleanly when the order is TOTAL: two rows tied on both counts may come back in
 * either order per query, so an untiebroken sort can hand the same row to two
 * pages and never hand over the one it displaced. The un-paged version leaned on
 * SQLite's own row order for ties, which was good enough while every row was
 * read exactly once.
 */
/*
 * The trailing name is the OUTPUT alias, not `t.<column>`. Two of the three
 * lists now group by an expression rather than by a bare column (see
 * {@link TOOL_LIST_KEY}), and ordering by the raw column there would tiebreak on
 * a value the row is no longer keyed by — so two aliases folded into one row
 * could still order by whichever raw spelling SQLite reached first, which is
 * exactly the unstable order this tiebreak exists to prevent.
 */
const TOOL_LIST_ORDER: Readonly<Record<ToolUsageList, string>> = {
	skill: "session_count DESC, call_count DESC, tool_name ASC",
	tool: "call_count DESC, session_count DESC, tool_name ASC",
	server: "call_count DESC, session_count DESC, server ASC",
};

/**
 * How many rows a list has in the window, and how many calls they account for.
 *
 * Both figures are what a card's header line prints, and both must come from
 * here rather than from the page it renders: a client summing the rows it holds
 * says "8 servers · 61 calls" on a machine with 15 servers and 375 calls, and
 * says something different after every click. `totalCount` is also the client's
 * "there is another page" test, so it travels with every page — see
 * {@link ToolUsagePage}.
 */
function toolListTotals(
	db: DashboardDbHandle,
	where: { sql: string; params: unknown[] },
	list: ToolUsageList,
): { totalCount: number; callsTotal: number } {
	const keyColumn = TOOL_LIST_KEY[list];
	const row = db
		.prepare(
			`SELECT COUNT(DISTINCT ${keyColumn}) AS row_count,
			        COALESCE(SUM(t.calls), 0) AS call_count
			   FROM session_tool_use t
			   JOIN sessions s ON s.event_id = t.session_event_id
			  WHERE ${where.sql}
			    AND t.kind = ?${list === "server" ? " AND t.server IS NOT NULL" : ""}`,
		)
		.get(...where.params, TOOL_LIST_KIND[list]) as { row_count: number; call_count: number } | undefined;
	return { totalCount: row?.row_count ?? 0, callsTotal: row?.call_count ?? 0 };
}

/**
 * The per-agent split for the rows of ONE page, keyed by whatever identifies a
 * row in that list (`tool_name`, or `server` for the roll-up).
 *
 * Its own query restricted to the page's keys, rather than a fold over every row
 * in the window: that fold is what the un-paged version did, and keeping it
 * would defeat the `LIMIT` it now sits behind — reading the agent split of 42
 * MCP tools to render 8 of them.
 *
 * Only CALLS come from here, never sessions. A session belongs to exactly one
 * source, so per-source call buckets sum back exactly; a per-source SESSION
 * count does not survive being re-summed at a coarser grouping, which is what a
 * server row's split would be — see {@link ToolUsageAgentShare}.
 */
function toolRowAgents(
	db: DashboardDbHandle,
	where: { sql: string; params: unknown[] },
	list: ToolUsageList,
	keys: ReadonlyArray<string>,
): Map<string, ToolUsageAgentShare[]> {
	const byKey = new Map<string, ToolUsageAgentShare[]>();
	// `IN ()` is a syntax error, and an empty page has nothing to attribute.
	if (keys.length === 0) return byKey;
	const keyColumn = TOOL_LIST_KEY[list];
	const rows = db
		.prepare(
			`SELECT ${keyColumn} AS row_key, s.source,
			        COALESCE(SUM(t.calls), 0) AS call_count
			   FROM session_tool_use t
			   JOIN sessions s ON s.event_id = t.session_event_id
			  WHERE ${where.sql}
			    AND t.kind = ? AND ${keyColumn} IN (${placeholders(keys.length)})
			  GROUP BY ${keyColumn}, s.source`,
		)
		.all(...where.params, TOOL_LIST_KIND[list], ...keys) as ReadonlyArray<{
		row_key: string;
		source: string;
		call_count: number;
	}>;
	for (const row of rows) {
		byKey.set(row.row_key, [...(byKey.get(row.row_key) ?? []), { source: row.source, calls: row.call_count }]);
	}
	for (const [key, agents] of byKey) byKey.set(key, sortAgents(agents));
	return byKey;
}

/** One page of the Skills list, or of the MCPs card's "by tool" split. */
function toolNameRowsPage(
	db: DashboardDbHandle,
	where: { sql: string; params: unknown[] },
	list: "skill" | "tool",
	offset: number,
	limit: number,
): ToolUsageRow[] {
	const kind = TOOL_LIST_KIND[list];
	const rows = db
		.prepare(
			// Grouped by name alone: the kind is already pinned by the WHERE, so this
			// is the same bucket the old `(kind, tool_name)` grouping produced, and
			// COUNT(DISTINCT) over the whole group is the same number as the sum of
			// its per-source counts (a session has exactly one source).
			`SELECT ${TOOL_LIST_KEY[list]} AS tool_name,
			        COUNT(DISTINCT t.session_event_id) AS session_count,
			        COALESCE(SUM(t.calls), 0) AS call_count
			   FROM session_tool_use t
			   JOIN sessions s ON s.event_id = t.session_event_id
			  WHERE ${where.sql} AND t.kind = ?
			  GROUP BY ${TOOL_LIST_KEY[list]}
			  ORDER BY ${TOOL_LIST_ORDER[list]}
			  LIMIT ? OFFSET ?`,
		)
		.all(...where.params, kind, limit, offset) as ReadonlyArray<{
		tool_name: string;
		session_count: number;
		call_count: number;
	}>;
	const agents = toolRowAgents(
		db,
		where,
		list,
		rows.map((row) => row.tool_name),
	);
	return rows.map((row) => ({
		name: row.tool_name,
		kind: list === "skill" ? ("skill" as const) : ("mcp" as const),
		sessions: row.session_count,
		calls: row.call_count,
		agents: agents.get(row.tool_name) ?? [],
	}));
}

/**
 * One page of the MCP-server roll-up.
 *
 * Servers get their OWN grouping rather than a roll-up of the per-tool rows.
 * Session counts there are per tool, so neither combining rule is right:
 * summing double-counts a session that called two of a server's tools, and the
 * max — what this used to do — undercounts two sessions that each called a
 * different one. `COUNT(DISTINCT session_event_id)` grouped by server is the
 * figure the UI already presents this as.
 *
 * `tool_count` is also why the agent split cannot just be an `s.source` column
 * added here: `COUNT(DISTINCT tool_name)` per source double-counts a tool called
 * from two agents once the buckets are summed back together.
 */
function serverRowsPage(
	db: DashboardDbHandle,
	where: { sql: string; params: unknown[] },
	offset: number,
	limit: number,
): McpServerRow[] {
	const rows = db
		.prepare(
			// `tool_count` counts the FOLDED tool key, not `t.tool_name`. The name
			// embeds the server (`<server>.<tool>`), so a server reached under two
			// registrations carries two spellings of each of its tools — counting the
			// raw column would report a merged 5-tool server as having 10.
			`SELECT ${SERVER_KEY_SQL} AS server,
			        COUNT(DISTINCT t.session_event_id) AS session_count,
			        COALESCE(SUM(t.calls), 0) AS call_count,
			        COUNT(DISTINCT ${TOOL_KEY_SQL}) AS tool_count
			   FROM session_tool_use t
			   JOIN sessions s ON s.event_id = t.session_event_id
			  WHERE ${where.sql}
			    AND t.kind = 'mcp' AND t.server IS NOT NULL
			  GROUP BY ${SERVER_KEY_SQL}
			  ORDER BY ${TOOL_LIST_ORDER.server}
			  LIMIT ? OFFSET ?`,
		)
		.all(...where.params, limit, offset) as ReadonlyArray<{
		server: string;
		session_count: number;
		call_count: number;
		tool_count: number;
	}>;
	const agents = toolRowAgents(
		db,
		where,
		"server",
		rows.map((row) => row.server),
	);
	return rows.map((row) => ({
		server: row.server,
		sessions: row.session_count,
		calls: row.call_count,
		tools: row.tool_count,
		agents: agents.get(row.server) ?? [],
	}));
}

/**
 * The recall tool's own row, from its own query.
 *
 * Never filtered out of the MCP-tool page: recall can rank outside the first
 * page on a busy machine even with real volume of its own, and now that the page
 * is one of several, the reader may never load the one carrying it.
 *
 * Matched against EVERY spelling of the tool (see {@link isRecallMcpToolName}):
 * a plugin-registered server namespaces the row, and an equality test on the
 * bare name reported "no recall calls" forever on those installs. SQL narrows
 * with a suffix `LIKE` and the JS predicate decides — the pattern is derived
 * from the canonical name, which carries no `_` or `%` and so needs no `ESCAPE`,
 * and a name that merely ends in the same letters is rejected in JS rather than
 * counted. Reported under the canonical name: the row is about the recall
 * feature, not about which manifest registered the server.
 */
function recallToolRow(db: DashboardDbHandle, where: { sql: string; params: unknown[] }): ToolUsageRow | undefined {
	const rows = db
		.prepare(
			`SELECT t.tool_name, s.source,
			        COUNT(DISTINCT t.session_event_id) AS session_count,
			        COALESCE(SUM(t.calls), 0) AS call_count
			   FROM session_tool_use t
			   JOIN sessions s ON s.event_id = t.session_event_id
			  WHERE ${where.sql}
			    AND t.kind = 'mcp' AND t.tool_name LIKE ?
			  GROUP BY t.tool_name, s.source`,
		)
		.all(...where.params, `%${RECALL_MCP_TOOL_NAME}`) as ReadonlyArray<{
		tool_name: string;
		source: string;
		session_count: number;
		call_count: number;
	}>;
	const matched = rows.filter((row) => isRecallMcpToolName(row.tool_name));
	if (matched.length === 0) return undefined;
	const agents = new Map<string, number>();
	for (const row of matched) agents.set(row.source, (agents.get(row.source) ?? 0) + row.call_count);
	return {
		name: RECALL_MCP_TOOL_NAME,
		kind: "mcp",
		// Summed across spellings. A session that used two of them counts twice,
		// which needs the same server registered under two namespaces at once —
		// pathological, and not worth a second query to be exact about.
		sessions: matched.reduce((n, row) => n + row.session_count, 0),
		calls: matched.reduce((n, row) => n + row.call_count, 0),
		agents: sortAgents([...agents].map(([source, calls]) => ({ source, calls }))),
	};
}

/** What one `/api/tool-usage` request names: a list, a position, and the page's window. */
export interface ToolUsagePageOptions {
	readonly scope: DashboardScope;
	readonly list: ToolUsageList;
	/** Row index to start at. Negative or fractional input is floored to a valid one. */
	readonly offset: number;
	/**
	 * Rows per page. Defaults to {@link TOOL_ROWS_LIMIT}, the size the first page
	 * rode in at — which is also what a "Show more" click asks for.
	 *
	 * A bigger one is the poll path: re-reading a list the reader has already
	 * expanded takes as many rows as are on screen, so it can be compared against
	 * them. That number comes from the client, so the route caps it before this
	 * ever sees it (`TOOL_USAGE_MAX_LIMIT` in DashboardServer).
	 */
	readonly limit?: number;
	readonly range?: DashboardRange;
	readonly customFrom?: string;
	readonly customTo?: string;
	readonly timeZone?: string;
	readonly nowMs?: number;
}

/**
 * ONE page of one tool-usage list — the `/api/tool-usage` answer behind a card's
 * "Show more" button.
 *
 * Paged in SQL rather than by slicing a full read: the un-paged version grouped
 * every `session_tool_use` row in the window, folded the per-agent split for all
 * of them, and then kept 8 — so a machine with 42 MCP tools paid for 42 to
 * render 8, and the other 34 were unreachable no matter what the reader did.
 * Every figure a card states about the whole set now comes from a COUNT/SUM (see
 * {@link toolListTotals}) instead of from the rows on screen.
 *
 * OFFSET rather than a cursor, unlike the Memories tree: what this pages over is
 * an aggregate the query recomputes, not a list git can shorten under the reader,
 * so the only movement is new calls arriving mid-browse — which shifts a row by
 * one slot at worst. The client dedupes by row identity for that case, and
 * {@link TOOL_LIST_ORDER}'s name tiebreak is what keeps the partition clean
 * otherwise.
 */
export function buildToolUsagePage(db: DashboardDbHandle, opts: ToolUsagePageOptions): ToolUsagePage {
	const timeZone = opts.timeZone ?? machineTimeZone();
	const window = resolveWindow(opts.range, opts.customFrom, opts.customTo, opts.nowMs ?? Date.now(), timeZone);
	const where = toolUsageWhere(db, opts.scope, window);
	// Floored, not rejected — for both, and for the same reason: an offset is a
	// position in a list and a width is a row count, so a bad one has a nearest sane
	// answer rather than an error. The floor is all this does to the limit; its
	// MAGNITUDE is bounded one layer out, where the route clamps a caller-supplied
	// one to TOOL_USAGE_MAX_LIMIT, so nothing here has to defend the SQL against an
	// unbounded read. Kept symmetric with `offset` anyway because this is the only
	// exported entry point: a second caller would otherwise be the first thing
	// standing between a fractional or negative width and the SQL.
	const offset = Math.max(0, Math.trunc(opts.offset) || 0);
	// `Number.isFinite` rather than `|| TOOL_ROWS_LIMIT`, which cannot tell NaN from
	// a zero: the falsy test sent `0` and `0.5` to the DEFAULT page of 8, so the one
	// caller this guard exists for would have received 8 rows where both this comment
	// and the route's own clamp say 1. Absent still means one page; a number that
	// floors below one row means one row.
	//
	// `Infinity` lands on the default page too, and that is the honest answer rather
	// than an oversight: clamping needs a width to clamp TO, and this layer
	// deliberately has no upper bound (the route holds it, see TOOL_USAGE_MAX_LIMIT).
	// So an unbounded request has no nearest sane width the way a fractional one has
	// a nearest sane row count, and one page is the only answer left that is not a
	// whole-table read.
	const requestedLimit = Math.trunc(opts.limit ?? TOOL_ROWS_LIMIT);
	const limit = Number.isFinite(requestedLimit) ? Math.max(1, requestedLimit) : TOOL_ROWS_LIMIT;
	const { totalCount } = toolListTotals(db, where, opts.list);
	if (opts.list === "server") {
		return { list: "server", offset, rows: serverRowsPage(db, where, offset, limit), totalCount };
	}
	return { list: opts.list, offset, rows: toolNameRowsPage(db, where, opts.list, offset, limit), totalCount };
}

/**
 * Skills, MCP servers and the tool mix over the window, each row carrying the
 * agents that produced it — the FIRST page of each of the three lists, plus the
 * totals they page against.
 *
 * Not every agent's transcripts can be read for tool calls, so the coverage
 * numbers are computed from `sessions` — the full population — and never from
 * the join. `uncoveredSources` names the agents that contributed sessions but no
 * tool records, because "linear: 3 sessions" is a very different statement
 * depending on whether the other 40 sessions could have been counted and were
 * not.
 *
 * Adoption (`sessions`) leads the Skills ranking over volume (`calls`)
 * deliberately: a single session that hammered one tool 200 times is not
 * evidence that the tool matters, whereas a tool reached for across many
 * separate sessions is. The per-agent splits are ordered by volume instead —
 * they answer "who ran this", where the count IS the point. See
 * {@link TOOL_LIST_ORDER}.
 */
function buildToolUsage(db: DashboardDbHandle, scope: DashboardScope, window: ResolvedWindow): ToolUsage {
	const where = toolUsageWhere(db, scope, window);
	const skillTotals = toolListTotals(db, where, "skill");
	const serverTotals = toolListTotals(db, where, "server");
	const mcpToolTotals = toolListTotals(db, where, "tool");
	const skills = toolNameRowsPage(db, where, "skill", 0, TOOL_ROWS_LIMIT);
	const mcpTools = toolNameRowsPage(db, where, "tool", 0, TOOL_ROWS_LIMIT);
	const servers = serverRowsPage(db, where, 0, TOOL_ROWS_LIMIT);
	const recallCalls = recallToolRow(db, where);

	// Per-kind agent totals, from their own grouping so `sessions` is a real
	// COUNT(DISTINCT) rather than a re-sum of the pages above — and over EVERY row
	// in the window, so an agent whose every skill ranks past the first page still
	// shows up in the card's header line.
	const agentRows = db
		.prepare(
			`SELECT t.kind, s.source,
			        COUNT(DISTINCT t.session_event_id) AS session_count,
			        COALESCE(SUM(t.calls), 0) AS call_count
			   FROM session_tool_use t
			   JOIN sessions s ON s.event_id = t.session_event_id
			  WHERE ${where.sql}
			    AND t.kind IN ('skill','mcp')
			  GROUP BY t.kind, s.source`,
		)
		.all(...where.params) as ReadonlyArray<{
		kind: string;
		source: string;
		session_count: number;
		call_count: number;
	}>;
	const agentTotals = (kind: string): ToolUsageAgentTotal[] =>
		sortAgents(
			agentRows
				.filter((row) => row.kind === kind)
				.map((row) => ({ source: row.source, sessions: row.session_count, calls: row.call_count })),
		);

	// Coverage from the FULL session population, never from the join above — and
	// windowed by the SESSION's own time OR by any call it made, which is the
	// union of the two clocks and not either one alone. Both halves are needed
	// and for opposite reasons. Session time alone drops nothing that the caveat
	// is about but cannot see a session whose calls landed in this window while
	// its own `updated_at_ms` did not — and since the two queries above moved to
	// call time, that session's tool row is IN the ranking, so the page printed
	// "1 session" directly above "from 0 of 0 sessions in this window". Call time
	// alone is the failure the old comment named: a session that made no tool
	// call has no call to be windowed by and would vanish from the denominator
	// the caveat is built on. The union admits a session if EITHER clock puts it
	// here, so every ranked row is backed by a session it counts.
	//
	// The NUMERATOR carries the same window as the rankings, and for the reason
	// the denominator carries the union: unwindowed, a session admitted by its own
	// `updated_at_ms` counted as "with tools" on the strength of calls made weeks
	// earlier — calls that are in no ranked row on the page, because both queries
	// above window by call time. That is the same contradiction in the other
	// direction: "3 of 4 sessions" above a table whose rows account for one of
	// them. Windowed, the fraction says what the caveat claims it says — sessions
	// whose tool use is what the page is showing.
	const sessionFilter = scopeFilter(scopeToRepoIds(db, scope), "s.repo_id");
	const sessionRows = db
		.prepare(
			`SELECT s.source,
			        COUNT(*) AS total,
			        COALESCE(SUM(EXISTS (SELECT 1 FROM session_tool_use t
			                              WHERE t.session_event_id = s.event_id
			                                AND ${TOOL_CALL_TIME_SQL} >= ? AND ${TOOL_CALL_TIME_SQL} < ?)), 0) AS with_tools
			   FROM sessions s
			  WHERE ((s.updated_at_ms >= ? AND s.updated_at_ms < ?)
			         OR EXISTS (SELECT 1 FROM session_tool_use t
			                     WHERE t.session_event_id = s.event_id
			                       AND ${TOOL_CALL_TIME_SQL} >= ? AND ${TOOL_CALL_TIME_SQL} < ?))${sessionFilter.sql}
			  GROUP BY s.source`,
		)
		// Six bounds, not four: the SELECT list's `?`s bind ahead of the WHERE's,
		// and all three range tests are the same window.
		.all(
			window.startMs,
			window.endMs,
			window.startMs,
			window.endMs,
			window.startMs,
			window.endMs,
			...sessionFilter.params,
		) as ReadonlyArray<{
		source: string;
		total: number;
		with_tools: number;
	}>;

	return {
		skills,
		skillsTotal: skillTotals.totalCount,
		skillCallsTotal: skillTotals.callsTotal,
		mcpTools,
		mcpToolsTotal: mcpToolTotals.totalCount,
		recallCalls,
		servers,
		serversTotal: serverTotals.totalCount,
		serverCallsTotal: serverTotals.callsTotal,
		skillAgents: agentTotals("skill"),
		mcpAgents: agentTotals("mcp"),
		sessionsWithTools: sessionRows.reduce((sum, row) => sum + row.with_tools, 0),
		sessionsInWindow: sessionRows.reduce((sum, row) => sum + row.total, 0),
		// "No tool rows" and "cannot have tool rows" are different facts, and only
		// the second one belongs here — the UI states outright that these sources
		// record no tool calls in their transcripts. Whether a source can record
		// them is a property of its PARSER, not of the sessions that happen to be
		// in the window, so it is read from the parser contract: a Claude session
		// that genuinely called no tools used to put "claude" in this list and have
		// the page report that Claude transcripts cannot be read.
		uncoveredSources: sessionRows
			.filter((row) => row.with_tools === 0 && !TOOL_RECORDING_SOURCES.has(row.source))
			.map((row) => row.source),
	};
}

/**
 * When a `session_tool_use` bucket happened, for windowing — the call's own
 * time when the parser that read it could supply one, the session's otherwise.
 *
 * Both halves are load-bearing. `last_call_at_ms` is the honest answer and the
 * reason the column exists: a session's `updated_at_ms` moves every time the
 * conversation is touched again, so windowing by it filed a three-week-old
 * recall under today and a call made minutes ago under whenever its
 * long-running session happened to last update. The COALESCE is what keeps that
 * an improvement rather than a regression: rows written before the column
 * existed hold NULL and can never be backfilled (their transcripts are behind a
 * cursor, or gone), as do rows from sources whose parsers cannot stamp a time
 * (`TOOL_CALL_TIME_SOURCES`) — and a bare comparison against NULL is false, so
 * without the fallback every one of those rows would silently leave every
 * window rather than keep its old, coarser placement.
 *
 * Written as a fragment used in BOTH bounds of each range test, so a row cannot
 * be admitted by one clock and excluded by the other.
 *
 * The `NULLIF` is what makes the fallback total. 0 is the one stored value that
 * defeats a bare COALESCE — 0 is not NULL, so the row resolves to epoch 0 and
 * leaves every window instead of keeping its session's placement — and it is
 * indistinguishable from "no time known", which is precisely the case the
 * fallback exists for. Both writers already refuse to store one (their
 * `MAX(COALESCE(…,0), COALESCE(…,0))` is wrapped in `NULLIF` too), so this is
 * the belt to those braces; it lives HERE, and not in a migration, because a
 * migration runs once and a third writer added later would store its first 0
 * long after every database had passed that step. Neutralising it at the read
 * costs nothing, covers rows that already exist and rows not yet written, and
 * needs no schema version — which is a cross-surface event, since every surface
 * refuses a database stamped ahead of its own build.
 */
const TOOL_CALL_TIME_SQL = "COALESCE(NULLIF(t.last_call_at_ms, 0), s.updated_at_ms)";

/** Fallback for a `buildDashboardModel` call that never read the Memory Bank. */
const NO_KNOWLEDGE_MODEL: KnowledgeModel = { repos: [] };
const NO_GRAPH_MODEL: GraphModel = { repos: [] };

// ── Model assembly ──────────────────────────────────────────────────────────

/**
 * Why a row's checkout could not be found, or that it could — the filesystem
 * question a page render asks, and the reason `RepoOption.missing` /
 * `volumeUnavailable` exist.
 *
 * Three answers rather than a boolean, because "not on disk" is two states and the
 * page has to say which: a deleted folder, or a volume that is not mounted. See
 * `RepoOption.volumeUnavailable` for what that distinction buys the reader, and
 * `DashboardServer.handleForget` for the guard that no longer has to stand in for
 * it.
 *
 * **The registry outranks the row, and that is the whole point.** `worktree_root`
 * is projected from a registry entry's single `worktreeRoot` field
 * (`DbBackfill.projectRepoRegistryState`), while an entry is keyed by repo
 * IDENTITY and can list several clones. So a repo whose recorded root was deleted
 * with a sibling clone still on disk reads as missing from the row alone — and the
 * page then renders a forget ✕ over a working repository. `handleForget` already
 * refuses exactly that with a 409, asking the registry through
 * `classifyRegistryEntry`; this asks the same question at render time so the
 * control is not offered in the first place. Nothing else fixes it in passing: the
 * one pass that repoints a dead `worktreeRoot` at a live sibling,
 * `repairRegistryEntries`, runs only under `jolli doctor`.
 *
 * `registryRoots` is consulted FIRST rather than OR-ed with the row, for the
 * mirror image of `handleForget`'s reasoning: the registry is the writer and the
 * row is its projection, so the row can only be staler. That also settles the
 * placeholder case below in the right direction — an identity the registry lists
 * is registered, so "all of its recorded paths are gone" is a true `missing`.
 *
 * The fallback keeps the pre-registry rule: a row whose `worktree_root` IS its
 * identity is deliberately not "missing". That is the placeholder
 * `StatsWriter.ensureRepoRow` inserts when an event arrives before the repo is
 * registered, so it names no directory rather than naming one that vanished, and
 * marking it would put a remove control on a repo that is about to register
 * normally.
 */
type WorktreeAbsence = "present" | "missing" | "volume-unavailable";

function absenceOfWorktree(
	row: { readonly repo_identity: string; readonly worktree_root: string },
	registryRoots: ReadonlyMap<string, ReadonlyArray<string>> | undefined,
): WorktreeAbsence {
	const recorded = registryRoots?.get(row.repo_identity);
	const paths =
		recorded !== undefined && recorded.length > 0
			? recorded
			: row.worktree_root === row.repo_identity
				? []
				: [row.worktree_root];
	if (paths.length === 0 || paths.some((path) => worktreeExists(path))) return "present";
	// Same rule as `classifyRegistryEntry`: ONE recorded path on a live volume is
	// enough to call this a deletion, because that path really is gone from a disk
	// that is here. Only when no recorded path's volume can be reached at all is the
	// absence about the volume.
	return paths.some((path) => volumeReachable(path)) ? "missing" : "volume-unavailable";
}

/**
 * How long a checkout's existence is reused before asking the filesystem again.
 *
 * This is the ONE filesystem call a page render makes, and it is made per repo row
 * per request — so an uncached probe of a repo on a disconnected SMB/NFS mount
 * blocks the whole render until the mount times out, on every refresh, for every
 * OTHER repo's benefit too.
 *
 * Staleness is already part of this value's contract rather than a cost the memo
 * introduces: `missing` renders a remove control, and `DashboardServer.handleForget`
 * re-asks at action time precisely because "the control is rendered from a payload
 * that can be minutes old". Half a minute here is well inside that.
 */
const WORKTREE_EXISTENCE_TTL_MS = 30_000;

const worktreeExistence = new Map<string, boolean>();
let worktreeExistenceStartedAtMs = 0;

/**
 * `existsSync` with a short real-time memo.
 *
 * One generation for the whole memo rather than a TTL per key. That keeps it
 * BOUNDED without a capacity check: it is emptied wholesale every window, so a
 * long-lived server watching repo rows come and go cannot accumulate paths. The
 * cost is that a key added late in a window is dropped early, which is free —
 * every entry is one `existsSync` to recompute.
 *
 * Deliberately `Date.now()` rather than the caller's injected `nowMs`: that clock
 * is a DISPLAY seam (tests pin it to 0, and views are rendered "as of" a chosen
 * instant), so keying an I/O throttle on it would freeze this memo for the whole
 * process whenever a caller froze the display clock.
 */
function worktreeExists(path: string): boolean {
	const nowMs = Date.now();
	if (nowMs - worktreeExistenceStartedAtMs >= WORKTREE_EXISTENCE_TTL_MS) {
		worktreeExistence.clear();
		worktreeExistenceStartedAtMs = nowMs;
	}
	const hit = worktreeExistence.get(path);
	if (hit !== undefined) return hit;
	const exists = existsSync(path);
	worktreeExistence.set(path, exists);
	return exists;
}

/**
 * Drops the memo — for a caller that creates or deletes a checkout mid-run.
 *
 * `DashboardServer.handleEnable` is the one production caller: it has just been
 * told a directory exists, and a `false` cached for that path outlives the answer
 * by up to a whole window, so the reload after its 200 would render the repo the
 * user just enabled with a remove control on it.
 */
export function clearWorktreeExistenceCache(): void {
	worktreeExistence.clear();
	worktreeExistenceStartedAtMs = 0;
}

/** Builds the full page payload for one view + scope. */
export function buildDashboardModel(db: DashboardDbHandle, opts: QueryOptions): DashboardModel {
	const timeZone = opts.timeZone ?? machineTimeZone();
	const nowMs = opts.nowMs ?? Date.now();
	// Normalize the requested scope BEFORE anything reads it, so every builder and
	// the echoed-back `model.scope` agree on one identity (see `resolveScope`).
	const options: QueryOptions = { ...opts, scope: resolveScope(db, opts.scope) };

	// `sessionsThisWeek` is the repo picker's per-repo meta figure, computed here so
	// the shell needs no second round trip.
	//
	// PAUSED repos are listed too, not filtered out. Pausing is an UPDATE that
	// stamps `disabled_at`, never a delete, and they keep counting in the
	// aggregate figures, so a
	// `disabled_at IS NULL` filter here made an all-paused dashboard read as "No
	// repositories yet" while its numbers still had the paused repo's activity in
	// them. `disabled_at IS NOT NULL` sorts the paused ones to the bottom of the
	// picker; `disabled` is set on the option so the picker can mark them (and stays
	// absent on an active row, so its shape is unchanged).
	const weekStartMs = addLocalDays(nowMs, -6, timeZone);
	const repoRows = db
		.prepare(
			`SELECT r.repo_identity, r.repo_name, r.worktree_root, r.bootstrap_state,
			        r.disabled_at,
			        (SELECT COUNT(*) FROM sessions s
			          WHERE s.repo_id = r.id AND s.updated_at_ms >= ?) AS week_sessions
			   FROM repos r ORDER BY (r.disabled_at IS NOT NULL), r.repo_name`,
		)
		.all(weekStartMs) as ReadonlyArray<{
		repo_identity: string;
		repo_name: string;
		worktree_root: string;
		bootstrap_state: string;
		disabled_at: string | null;
		week_sessions: number;
	}>;
	const repos: RepoOption[] = repoRows.map((r) => {
		// `volumeUnavailable` IMPLIES `missing` (see `RepoOption`): the flag says why
		// nothing was found, never that something else was.
		const absence = absenceOfWorktree(r, opts.registryRoots);
		return {
			repoIdentity: r.repo_identity,
			repoName: r.repo_name,
			worktreeRoot: r.worktree_root,
			sessionsThisWeek: r.week_sessions,
			...(r.disabled_at != null ? { disabled: true as const } : {}),
			...(absence !== "present" ? { missing: true as const } : {}),
			...(absence === "volume-unavailable" ? { volumeUnavailable: true as const } : {}),
		};
	});

	// The footer carries ONE note now, and only when the database is empty.
	//
	// The caveat that used to sit under every stats and standup render — "older
	// activity is reconstructed from commits and stored summaries; recent sessions
	// are exact" — is gone from both. It was true, and it was permanent: printed
	// on every load regardless of whether the reader was anywhere near the window
	// boundary it describes, which is the shape a reader stops seeing. Nothing
	// about the reconstruction changed; only the decision to state it as page
	// furniture did. See `CoverageNote` before re-adding one.
	//
	// `no-data` is kept for the opposite reason: it appears only on a database
	// with no sessions at all, says what will fill it, and never comes back once
	// one lands. It is scoped to STATS because that is the view whose cards are
	// all session-derived and therefore all empty in that state. The standup board
	// is commits-only (JOLLI-2200 / 2201), so it is fully populated with zero
	// sessions, and the empty state each of its columns can really be in is
	// already stated inside the column ("Nothing recorded.").
	//
	// There is deliberately NO in-progress import note. It used to be the one note
	// that spanned every view, sitting at the foot of all four pages for the whole
	// bootstrap; `bootstrap_state` is still tracked and still drives resume, it just
	// no longer has a banner. Re-adding one is a product decision, not a fix — the
	// numbers filling in as the import runs is the behaviour, and it needs no
	// footnote on every page to be understood.
	const coverage: CoverageNote[] = [];
	if (options.view === "stats") {
		const sessionCount =
			(db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number } | undefined)?.n ?? 0;
		if (sessionCount === 0) {
			coverage.push({
				kind: "no-data",
				message: "No sessions recorded yet — data appears after your next AI session.",
			});
		}
	}

	const tier = detectTier(db);
	const window = () => resolveWindow(options.range, options.customFrom, options.customTo, nowMs, timeZone);
	// Exactly one view payload is built per request — the other two would be
	// wasted queries, and the page only ever reads its own.
	const payload = (): Pick<DashboardModel, "stats" | "standup" | "memories" | "knowledge" | "graph" | "settings"> => {
		switch (options.view) {
			case "stats":
				return {
					stats: buildStats(
						db,
						options.scope,
						timeZone,
						nowMs,
						tier,
						options.dimension ?? "model",
						window(),
						options.reachableCommits,
					),
				};
			case "standup":
				return { standup: buildStandup(db, options.scope, timeZone, nowMs, tier, options.authorIdentity) };
			case "knowledge":
				// Read off disk (Memory Bank `_wiki`), pre-built in the model builder
				// like settings — there is no DB query for it here.
				return { knowledge: options.knowledgeModel ?? NO_KNOWLEDGE_MODEL };
			case "graph":
				return { graph: options.graphModel ?? NO_GRAPH_MODEL };
			case "memories":
				// No tier gate, unlike Decisions: a memory is a per-commit capture,
				// not a recall receipt, so it exists as soon as a commit is
				// summarized — there is nothing here that only makes sense above a
				// tier.
				return {
					memories: buildMemories(
						db,
						options.scope,
						options.hash,
						options.reachableCommits,
						options.detailRepoIdentity,
						options.transcriptRepairState,
					),
				};
			case "settings":
				// Built entirely off config + a cheap folder-state peek in the model
				// builder (no DB read), so there is nothing to query here — just pass
				// the pre-built snapshot through. Absent only if the builder omitted it.
				return { settings: options.settingsModel };
		}
	};

	return {
		// 1 → 2 when Decisions was retired (its view token and payload shape
		// removed): an old tab left open across that upgrade would otherwise poll
		// `/api/model` and try to render a `decisions` view that no longer exists.
		// 2 → 3 when the scope became a repo LIST: `scope.repoIdentity` is gone,
		// so a pre-3 tab would read `undefined` off every reply and silently
		// repaint itself as all-repos while its URL still said otherwise.
		// 3 → 4 when the Recall card was retired and the Decisions card was
		// trimmed: `stats.recallUsage` is gone (a pre-4 tab's `recallCard` reads
		// `.usedCalls` straight off it and throws — and Stats is the one view with
		// a 30 s poll, so it throws again every tick on the payload it already
		// stored) and `DecisionRecord.text` became `title`.
		// `JD.refreshNow` compares this against the tab's own
		// `window.__JOLLI_DASHBOARD__.schemaVersion` and reloads on mismatch.
		schemaVersion: 4,
		view: options.view,
		tier,
		generatedAtMs: nowMs,
		timeZone,
		scope: options.scope,
		repos,
		coverage,
		// Default-off rather than default-on: see `QueryOptions.menus`. Always
		// present in the payload, so `shell.js` never has to guess what an absent
		// slice meant.
		menus: options.menus ?? { knowledge: false, graph: false },
		...payload(),
	};
}
