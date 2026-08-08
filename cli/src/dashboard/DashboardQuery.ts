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

import { accumulatedEntryTimes } from "../core/references/ReferenceStore.js";
import { collectDisplayTopics } from "../core/SummaryTree.js";
import { TOOL_RECORDING_SOURCES } from "../core/TranscriptParser.js";
import { createLogger, errMsg } from "../Logger.js";
import type { CommitSummary } from "../Types.js";
import type { DashboardDbHandle } from "./DashboardDb.js";
import type {
	AdoptionTier,
	CommitInsightKind,
	CoverageNote,
	DashboardModel,
	DashboardRange,
	DashboardScope,
	DashboardView,
	DaySeriesPoint,
	DecisionRecord,
	DecisionsCard,
	FunStats,
	HeatmapCell,
	HourBucket,
	KpiCard,
	McpServerRow,
	MemoryCard,
	RecallSurface,
	RecallUsage,
	RecentSession,
	RepoOption,
	RepositoriesModel,
	SeriesDimension,
	StandupCommit,
	StandupInsight,
	StandupModel,
	StandupWorkspace,
	StatsModel,
	TokenBreakdown,
	ToolUsage,
	ToolUsageRow,
} from "./DashboardModel.js";
import {
	commitCategoryLabels,
	placeholders,
	resolveScope,
	scopeFilter,
	scopeToRepoId,
	splitDecisionBullets,
} from "./DashboardScopeUtil.js";
import { buildMemories, isReachable, type ReachableCommits } from "./MemoriesQuery.js";
import { WORKTREE_STATUS_MAX_AGE_MS } from "./StatsWriter.js";

const log = createLogger("DashboardQuery");

import {
	isRecallMcpToolName,
	MEMORY_CARD_MAJOR_LINES,
	MEMORY_CARDS_LIMIT,
	RECALL_MCP_TOOL_NAME,
	RECALL_MCP_TOOL_SUFFIX,
	RECALL_REFERENCE_NATIVE_ID,
	RECALL_REFERENCE_SOURCE,
	RECALL_SKILL_NAMES,
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

/** KPI label suffix per range — "sessions today" vs "sessions · 30d". */
const RANGE_LABEL: Readonly<Record<PresetRange, string>> = {
	today: "today",
	week: "· 7d",
	"2w": "· 14d",
	month: "· 30d",
	"3m": "· 90d",
};

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

/** Shape of a local calendar day key, `YYYY-MM-DD`. */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A session updated within this window renders as "live". */
const LIVE_WINDOW_MS = 10 * 60 * 1000;
/** Local hour at or after which a session counts as night-owl work. */
const NIGHT_OWL_HOUR = 21;

// ── Time-zone engine ────────────────────────────────────────────────────────

/** The machine's IANA zone — the default for every query. */
export function machineTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

interface ZonedParts {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
	let formatter = partsFormatterCache.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		partsFormatterCache.set(timeZone, formatter);
	}
	return formatter;
}

/** Wall-clock components of `ms` in `timeZone`. */
function zonedParts(ms: number, timeZone: string): ZonedParts {
	const parts = partsFormatter(timeZone).formatToParts(ms);
	const get = (type: string) => Number.parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
	return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** Local calendar day of `ms` as `YYYY-MM-DD`. */
export function localDayKey(ms: number, timeZone: string): string {
	const p = zonedParts(ms, timeZone);
	return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Local hour (0–23) of `ms`. */
export function localHour(ms: number, timeZone: string): number {
	return zonedParts(ms, timeZone).hour;
}

/**
 * Epoch-ms of local midnight at the start of the day containing `ms`.
 *
 * `Intl` can only map epoch → wall clock; this inverts it by guessing the UTC
 * value of the wall-clock midnight and correcting by the observed error. Two
 * iterations settle every real zone including DST transitions: the first
 * correction lands within the zone's offset step, the second removes any
 * residue from a transition between guess and target. (On a "spring forward"
 * day where 00:00 does not exist, this lands on the earliest existing instant
 * of the day — exactly what a day boundary should be.)
 */
function localMidnight(year: number, month: number, day: number, timeZone: string): number {
	let guess = Date.UTC(year, month - 1, day);
	for (let i = 0; i < 3; i++) {
		const seen = zonedParts(guess, timeZone);
		const error =
			Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - Date.UTC(year, month - 1, day);
		if (error === 0) break;
		guess -= error;
	}
	return guess;
}

export function startOfLocalDay(ms: number, timeZone: string): number {
	const target = zonedParts(ms, timeZone);
	return localMidnight(target.year, target.month, target.day, timeZone);
}

/**
 * Epoch-ms of local midnight starting the day `key` (`YYYY-MM-DD`) names, or
 * `undefined` when `key` is not a real local day.
 *
 * The round-trip check is the validation: `Date.UTC` happily normalises
 * 2026-02-31 into March 3rd, so a request for a day that does not exist would
 * otherwise silently return data for a different one. Comparing the resolved
 * instant's own day key against the input rejects exactly that case — and
 * costs nothing on the overwhelmingly common valid input.
 */
function dayKeyToMidnight(key: string, timeZone: string): number | undefined {
	if (!DAY_KEY_RE.test(key)) return undefined;
	const ms = localMidnight(
		Number.parseInt(key.slice(0, 4), 10),
		Number.parseInt(key.slice(5, 7), 10),
		Number.parseInt(key.slice(8, 10), 10),
		timeZone,
	);
	return localDayKey(ms, timeZone) === key ? ms : undefined;
}

/**
 * Start of the local day `n` days after the day containing `ms`. Steps through
 * midday rather than adding exact 24 h multiples, so 23- and 25-hour DST days
 * cannot skip or repeat a day.
 */
export function addLocalDays(ms: number, days: number, timeZone: string): number {
	let cursor = startOfLocalDay(ms, timeZone);
	const step = days >= 0 ? 1 : -1;
	for (let i = 0; i !== days; i += step) {
		// ±24 h from midnight, then +12 h INTO the target day: lands mid-day in
		// the neighbouring day whether it is 23, 24 or 25 hours long, and
		// startOfLocalDay snaps back to its midnight. (A ±36 h jump would
		// overshoot a whole day when stepping backwards.)
		cursor = startOfLocalDay(cursor + step * 86_400_000 + 43_200_000, timeZone);
	}
	return cursor;
}

// ── Range resolution ────────────────────────────────────────────────────────

/** A range request resolved into concrete bounds, labels and day keys. */
interface ResolvedWindow {
	/** What the page ended up showing — `custom` only if the request survived. */
	readonly range: DashboardRange;
	/** Inclusive lower bound, epoch-ms. */
	readonly startMs: number;
	/** EXCLUSIVE upper bound, epoch-ms — one past the last day's local midnight. */
	readonly endMs: number;
	readonly from: string;
	readonly to: string;
	/** KPI label suffix ("today", "· 14d", "· 07-01→07-15"). */
	readonly label: string;
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
		// Year is dropped: the picker beside it always shows the full dates, and
		// "· 2026-07-01→2026-07-15" does not fit a KPI label.
		label: `· ${from.slice(5)}→${to.slice(5)}`,
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
		label: RANGE_LABEL[preset],
	};
}

// ── Query plumbing ──────────────────────────────────────────────────────────

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
	 * The async-read per-repo git reachability sets, keyed by `repo_identity`.
	 * Absent (or a repo missing from the map) renders every row unfiltered —
	 * see {@link ReachableCommits}. Read by the memories tree, and by the
	 * stats/standup commit and memory-card queries: a squashed-away commit is
	 * gone from git but not from `commits`/`memories`, so without this the
	 * Memory Activity feed renders one card per pre-squash predecessor and the
	 * "N of M captured" line counts commits that no longer exist.
	 */
	readonly reachableCommits?: ReachableCommits;
	/** Repositories view: the async-read registry + job state. Absent renders an empty list. */
	readonly repositoriesModel?: RepositoriesModel;
	readonly timeZone?: string;
	readonly nowMs?: number;
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
	const filter = scopeFilter(scopeToRepoId(db, scope), "s.repo_id");
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

function commitsInRange(db: DashboardDbHandle, scope: DashboardScope, fromMs: number, toMs: number): CommitRow[] {
	const filter = scopeFilter(scopeToRepoId(db, scope), "c.repo_id");
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
			  WHERE c.committed_at_ms >= ? AND c.committed_at_ms < ?${filter.sql}
			  ORDER BY c.committed_at_ms DESC`,
		)
		.all(fromMs, toMs, ...filter.params) as CommitRow[];
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
 */
const TOPIC_INSIGHTS_CTE = `WITH topic_insights AS (
	SELECT m.repo_id, m.commit_hash, 'decision' AS kind,
	       TRIM(json_extract(t.value, '$.decisions')) AS text,
	       NULL AS addressed_to, t.key * 2 AS ord
	  FROM memories m, json_each(m.summary_json, '$.topics') t
	 WHERE TRIM(COALESCE(json_extract(t.value, '$.decisions'), '')) <> ''
	UNION ALL
	SELECT m.repo_id, m.commit_hash, 'todo' AS kind,
	       TRIM(json_extract(t.value, '$.todo')) AS text,
	       NULL AS addressed_to, t.key * 2 + 1 AS ord
	  FROM memories m, json_each(m.summary_json, '$.topics') t
	 WHERE TRIM(COALESCE(json_extract(t.value, '$.todo'), '')) <> ''
)`;

const totalTokens = (row: SessionRow): number => row.input_tokens + row.output_tokens + row.cached_tokens;

// ── Stats page ──────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

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
 * The 14-day series along one dimension. `model`/`agent` read session usage;
 * `branch`/`ticket` read the memory-enriched commit columns (and silently fall
 * back to `model` below the memory tier, so a stale URL cannot render an empty
 * chart pretending to be data).
 */
function buildSeries(
	db: DashboardDbHandle,
	scope: DashboardScope,
	dimension: SeriesDimension,
	tier: AdoptionTier,
	fromMs: number,
	toMs: number,
	timeZone: string,
): SeriesResult {
	// Memory-only axes fall back to `model` below the memory tier, so a stale URL
	// renders real data instead of an empty chart pretending to be one.
	const memoryOnly = dimension === "branch" || dimension === "ticket" || dimension === "category";
	const effective: SeriesDimension = memoryOnly && tier === "installed" ? "model" : dimension;

	interface UsageRow {
		readonly at_ms: number;
		readonly key: string;
		readonly tokens: number;
		readonly cost: number;
	}
	let rows: ReadonlyArray<UsageRow>;
	if (effective === "model") {
		const filter = scopeFilter(scopeToRepoId(db, scope), "s.repo_id");
		rows = db
			.prepare(
				`SELECT s.updated_at_ms AS at_ms, u.model AS key,
				        u.input_tokens + u.output_tokens + u.cached_tokens AS tokens,
				        COALESCE(u.est_cost_usd, 0) AS cost
				   FROM session_model_usage u JOIN sessions s ON s.event_id = u.session_event_id
				  WHERE s.updated_at_ms >= ? AND s.updated_at_ms < ?${filter.sql}`,
			)
			.all(fromMs, toMs, ...filter.params) as UsageRow[];
	} else if (effective === "agent") {
		const filter = scopeFilter(scopeToRepoId(db, scope), "repo_id");
		rows = db
			.prepare(
				`SELECT updated_at_ms AS at_ms, source AS key,
				        input_tokens + output_tokens + cached_tokens AS tokens,
				        COALESCE(est_cost_usd, 0) AS cost
				   FROM sessions WHERE updated_at_ms >= ? AND updated_at_ms < ?${filter.sql}`,
			)
			.all(fromMs, toMs, ...filter.params) as UsageRow[];
	} else if (effective === "project") {
		const filter = scopeFilter(scopeToRepoId(db, scope), "s.repo_id");
		rows = db
			.prepare(
				`SELECT s.updated_at_ms AS at_ms, r.repo_name AS key,
				        s.input_tokens + s.output_tokens + s.cached_tokens AS tokens,
				        COALESCE(s.est_cost_usd, 0) AS cost
				   FROM sessions s JOIN repos r ON r.id = s.repo_id
				  WHERE s.updated_at_ms >= ? AND s.updated_at_ms < ?${filter.sql}`,
			)
			.all(fromMs, toMs, ...filter.params) as UsageRow[];
	} else if (effective === "category") {
		const filter = scopeFilter(scopeToRepoId(db, scope), "m.repo_id");
		// One row per TOPIC, with the commit's tokens shared across its topics —
		// category belongs to a topic, and the old per-commit mode erased every
		// category that never won a commit's vote (security and docs vanished
		// entirely on this repo's data). Sharing keeps the axis summing to the
		// real total, the property the mode existed to protect; the cost
		// figures are apportioned by design, not exact per-topic spend.
		// The LEFT JOIN keeps memories with no topics on the axis: their window
		// COUNT(*) is 1 and their whole spend lands in '(uncategorised)'.
		rows = db
			.prepare(
				`SELECT m.commit_date_ms AS at_ms, COALESCE(t.category, '(uncategorised)') AS key,
				        COALESCE(m.tokens, 0) * 1.0
				          / COUNT(*) OVER (PARTITION BY m.repo_id, m.commit_hash) AS tokens,
				        COALESCE(m.est_cost_usd, 0) * 1.0
				          / COUNT(*) OVER (PARTITION BY m.repo_id, m.commit_hash) AS cost
				   FROM memories m
				   LEFT JOIN memory_topics t ON t.repo_id = m.repo_id AND t.commit_hash = m.commit_hash
				  WHERE m.tokens IS NOT NULL AND m.commit_date_ms >= ? AND m.commit_date_ms < ?${filter.sql}`,
			)
			.all(fromMs, toMs, ...filter.params) as UsageRow[];
	} else if (effective === "branch") {
		const filter = scopeFilter(scopeToRepoId(db, scope), "c.repo_id");
		// A commit reachable from several branches contributes to each — the axis
		// answers "where did the spend land", not "sum to the exact total".
		rows = db
			.prepare(
				`SELECT c.committed_at_ms AS at_ms, br.name AS key,
				        COALESCE(m.tokens, 0) AS tokens, COALESCE(m.est_cost_usd, 0) AS cost
				   FROM commits c JOIN commit_branches b ON b.commit_id = c.id
			                        JOIN branches br ON br.id = b.branch_id
			                        JOIN memories m ON m.repo_id = c.repo_id AND m.commit_hash = c.hash
				  WHERE m.tokens IS NOT NULL AND c.committed_at_ms >= ? AND c.committed_at_ms < ?${filter.sql}`,
			)
			.all(fromMs, toMs, ...filter.params) as UsageRow[];
	} else {
		const filter = scopeFilter(scopeToRepoId(db, scope), "c.repo_id");
		rows = db
			.prepare(
				`SELECT c.committed_at_ms AS at_ms, COALESCE(m.ticket_id, '(no ticket)') AS key,
				        COALESCE(m.tokens, 0) AS tokens, COALESCE(m.est_cost_usd, 0) AS cost
				   FROM commits c JOIN memories m ON m.repo_id = c.repo_id AND m.commit_hash = c.hash
				  WHERE m.tokens IS NOT NULL AND c.committed_at_ms >= ? AND c.committed_at_ms < ?${filter.sql}`,
			)
			.all(fromMs, toMs, ...filter.params) as UsageRow[];
	}

	const seriesByDay = new Map<string, { tokens: number; cost: number; bySeries: Map<string, number> }>();
	for (let dayStart = fromMs; dayStart < toMs; dayStart = addLocalDays(dayStart, 1, timeZone)) {
		seriesByDay.set(localDayKey(dayStart, timeZone), { tokens: 0, cost: 0, bySeries: new Map() });
	}
	const seriesKeys = new Set<string>();
	for (const row of rows) {
		const bucket = seriesByDay.get(localDayKey(row.at_ms, timeZone));
		if (!bucket) continue;
		bucket.tokens += row.tokens;
		bucket.cost += row.cost;
		bucket.bySeries.set(row.key, (bucket.bySeries.get(row.key) ?? 0) + row.tokens);
		seriesKeys.add(row.key);
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
			bySeries: Object.fromEntries([...b.bySeries.entries()].map(([k, v]) => [k, Math.round(v)])),
		})),
		seriesKeys: [...seriesKeys].sort(),
		seriesDimension: effective,
	};
}

/** Price-table date behind the cost figures, from the newest priced session. */
function readPricesAsOf(db: DashboardDbHandle, scope: DashboardScope): string | undefined {
	const filter = scopeFilter(scopeToRepoId(db, scope), "repo_id");
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
 * Decisions mined from commit memories in the window — the standalone
 * Decisions card. Reuses {@link TOPIC_INSIGHTS_CTE}'s `decision` rows (the same
 * source the Standup page's insight list reads) rather than re-deriving the
 * `json_each` walk a second time.
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
	const filter = scopeFilter(scopeToRepoId(db, scope), "c.repo_id");
	const rows = db
		.prepare(
			`${TOPIC_INSIGHTS_CTE}
			 SELECT i.text, c.hash, c.committed_at_ms, r.repo_name
			   FROM commits c
			   JOIN repos r ON r.id = c.repo_id
			   LEFT JOIN commit_aliases al ON al.repo_id = c.repo_id AND al.old_hash = c.hash
			   -- See commitsInRange: a rewritten commit's decisions are still filed
			   -- under the pre-rewrite hash, reachable only through the alias.
			   JOIN topic_insights i ON i.repo_id = c.repo_id AND (i.commit_hash = c.hash OR i.commit_hash = al.target_hash)
			  WHERE i.kind = 'decision' AND c.committed_at_ms >= ? AND c.committed_at_ms < ?${filter.sql}
			  ORDER BY c.committed_at_ms DESC`,
		)
		.all(fromMs, toMs, ...filter.params) as ReadonlyArray<{
		text: string;
		hash: string;
		committed_at_ms: number;
		repo_name: string;
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
		? { text: first.text, commitHash: first.hash, repoName: first.repo_name, committedAtMs: first.committed_at_ms }
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

	// KPI row, scoped to the range. Labels carry the window so "6 sessions" can
	// never be misread as today's when the user is looking at a month.
	const rangeTokens = rangeSessions.reduce((sum, s) => sum + totalTokens(s), 0);
	const rangeCost = rangeSessions.reduce((sum, s) => sum + (s.est_cost_usd ?? 0), 0);
	const rangeCached = rangeSessions.reduce((sum, s) => sum + s.cached_tokens, 0);
	const rangeInput = rangeSessions.reduce((sum, s) => sum + s.input_tokens + s.cached_tokens, 0);

	// "Where your tokens went" — input/output/cache over the range, day-bucketed
	// for the card's chart. Reuses `rangeSessions`, already swept above for the
	// KPI row, rather than a second query.
	const perDayTokens = new Map<string, { input: number; output: number; cached: number }>();
	for (let dayStart = window.startMs; dayStart < window.endMs; dayStart = addLocalDays(dayStart, 1, timeZone)) {
		perDayTokens.set(localDayKey(dayStart, timeZone), { input: 0, output: 0, cached: 0 });
	}
	for (const s of rangeSessions) {
		const cell = perDayTokens.get(localDayKey(s.updated_at_ms, timeZone));
		if (cell) {
			cell.input += s.input_tokens;
			cell.output += s.output_tokens;
			cell.cached += s.cached_tokens;
		}
	}
	const tokenBreakdown: TokenBreakdown = {
		input: rangeSessions.reduce((sum, s) => sum + s.input_tokens, 0),
		output: rangeSessions.reduce((sum, s) => sum + s.output_tokens, 0),
		cached: rangeCached,
		perDay: [...perDayTokens.entries()].map(([date, v]) => ({ date, ...v })),
	};

	// Cost vs the immediately preceding window of equal length — the Spend
	// card's own self-trend.
	const priorRangeFrom = window.startMs - (window.endMs - window.startMs);
	const priorRangeCost = (
		priorRangeFrom >= heatmapStart
			? windowSessions.filter((s) => s.updated_at_ms >= priorRangeFrom && s.updated_at_ms < window.startMs)
			: sessionsInRange(db, scope, priorRangeFrom, window.startMs)
	).reduce((sum, s) => sum + (s.est_cost_usd ?? 0), 0);
	const costTrendPct =
		priorRangeCost > 0 ? Math.round(((rangeCost - priorRangeCost) / priorRangeCost) * 100) : undefined;

	const streakDays = computeStreak(
		[...windowSessions.map((s) => s.updated_at_ms), ...windowCommits.map((c) => c.committed_at_ms)],
		timeZone,
		nowMs,
	);
	const suffix = window.label;
	const kpis: KpiCard[] = [
		{ key: "sessions", label: `sessions ${suffix}`, value: String(rangeSessions.length) },
		{ key: "tokens", label: `tokens ${suffix}`, value: formatTokens(rangeTokens) },
		{ key: "cost", label: `est. cost ${suffix}`, value: `$${rangeCost.toFixed(2)}` },
		{
			key: "cached",
			label: "% cached",
			value: rangeInput > 0 ? `${Math.round((rangeCached / rangeInput) * 100)}%` : "—",
		},
		{ key: "streak", label: "streak", value: `${streakDays}d 🔥` },
	];

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

	// Cost/token series along the requested dimension, over the same window.
	const seriesResult = buildSeries(db, scope, dimension, tier, window.startMs, window.endMs, timeZone);

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
	const memoryCards = buildMemoryCards(db, scope, window, reachable);

	return {
		kpis,
		...seriesResult,
		heatmap,
		hours,
		tokenBreakdown,
		...(costTrendPct !== undefined ? { costTrendPct } : {}),
		fun,
		recentSessions,
		memoryCards,
		totalCommits: rangeCommits.length,
		range: window.range,
		rangeFrom: window.from,
		rangeTo: window.to,
		toolUsage: buildToolUsage(db, scope, window),
		recallUsage: buildRecallUsage(db, scope, window, timeZone, nowMs),
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

/**
 * Consecutive active local days ending today (or yesterday — a streak is not
 * broken by a morning where you have not started yet).
 */
export function computeStreak(activityMs: ReadonlyArray<number>, timeZone: string, nowMs: number): number {
	const activeDays = new Set(activityMs.map((ms) => localDayKey(ms, timeZone)));
	let cursor = startOfLocalDay(nowMs, timeZone);
	if (!activeDays.has(localDayKey(cursor, timeZone))) {
		cursor = addLocalDays(cursor, -1, timeZone);
		if (!activeDays.has(localDayKey(cursor, timeZone))) return 0;
	}
	let streak = 0;
	while (activeDays.has(localDayKey(cursor, timeZone))) {
		streak += 1;
		cursor = addLocalDays(cursor, -1, timeZone);
	}
	return streak;
}

// ── Standup page ────────────────────────────────────────────────────────────

/** Render order for standup insights: risks first, notes last. */
const INSIGHT_ORDER: ReadonlyArray<CommitInsightKind> = ["blocker", "question", "gotcha", "todo", "decision"];

/** Insights mined from the standup window's commit memories. */
function buildStandupInsights(
	db: DashboardDbHandle,
	scope: DashboardScope,
	fromMs: number,
	toMs: number,
): StandupInsight[] {
	const filter = scopeFilter(scopeToRepoId(db, scope), "c.repo_id");
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
			  WHERE c.committed_at_ms >= ? AND c.committed_at_ms < ?${filter.sql}
			  ORDER BY c.committed_at_ms DESC, i.ord`,
		)
		.all(fromMs, toMs, ...filter.params) as ReadonlyArray<{
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
): StandupModel {
	const todayStart = startOfLocalDay(nowMs, timeZone);
	const tomorrowStart = addLocalDays(nowMs, 1, timeZone);
	const yesterdayStart = addLocalDays(nowMs, -1, timeZone);

	const categoryLabels = commitCategoryLabels(db, scope);
	const toStandupCommit = (c: CommitRow): StandupCommit => {
		const workCategory = categoryLabels.get(`${c.repo_name}\0${c.hash}`);
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

	const filter = scopeFilter(scopeToRepoId(db, scope), "w.repo_id");
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
		yesterdaySessions: sessionsInRange(db, scope, yesterdayStart, todayStart).map((s) => toRecentSession(s, nowMs)),
		yesterdayCommits: commitsInRange(db, scope, yesterdayStart, todayStart).map(toStandupCommit),
		todaySessions: sessionsInRange(db, scope, todayStart, tomorrowStart).map((s) => toRecentSession(s, nowMs)),
		todayCommits: commitsInRange(db, scope, todayStart, tomorrowStart).map(toStandupCommit),
		workspaces,
		...(tier !== "installed" ? { insights: buildStandupInsights(db, scope, yesterdayStart, tomorrowStart) } : {}),
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
	readonly commit_date_ms: number;
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
): MemoryCard[] {
	// `repo_id` belongs to the memory row (`c`), not the joined repo lookup
	// (`r`).  Using `r.repo_id` only breaks the scoped form of the query; the
	// catch below then intentionally degrades to an empty feed, which used to
	// make every `?repo=...` dashboard look like it had no Memory Activity.
	const filter = scopeFilter(scopeToRepoId(db, scope), "c.repo_id");
	let rows: ReadonlyArray<MemoryCardRow>;
	try {
		// Two steps, because the reachability filter can only run in JS (git, not
		// the DB — see `ReachableCommits`) and a rewritten-away commit keeps its
		// `memories` row forever: filtering a LIMIT-ed page would leave the feed
		// showing the two survivors of the twenty most recent rows instead of the
		// twenty most recent surviving memories. Step one is deliberately narrow —
		// the payload blob is only read for the page that is actually rendered.
		const keys = db
			.prepare(
				`SELECT c.commit_hash, r.repo_identity
				   FROM memories c
				   JOIN repos r ON r.id = c.repo_id
				  WHERE c.parent_hash IS NULL
				    AND c.commit_date_ms >= ? AND c.commit_date_ms < ?${filter.sql}
				  ORDER BY c.commit_date_ms DESC`,
			)
			.all(window.startMs, window.endMs, ...filter.params) as ReadonlyArray<{
			commit_hash: string;
			repo_identity: string;
		}>;
		const page = keys
			.filter((k) => isReachable(reachable, k.repo_identity, k.commit_hash))
			.slice(0, MEMORY_CARDS_LIMIT);
		if (page.length === 0) return [];
		const holes = page.map(() => "?").join(",");
		rows = db
			.prepare(
				`SELECT c.commit_hash, c.commit_message, c.commit_date_ms, c.recap, c.turns, c.est_cost_usd,
				        c.branch, c.insertions, c.deletions, c.summary_json, r.repo_identity, r.repo_name
				   FROM memories c
				   JOIN repos r ON r.id = c.repo_id
				  WHERE c.parent_hash IS NULL AND c.commit_hash IN (${holes})${filter.sql}
				  ORDER BY c.commit_date_ms DESC`,
			)
			.all(...page.map((k) => k.commit_hash), ...filter.params) as ReadonlyArray<MemoryCardRow>;
		// `IN (hashes)` is keyed on the hash alone, so an unscoped dashboard whose
		// repos share a commit (a fork, a vendored tree) can match a row the page
		// did not select. Re-narrowing to the selected (repo, hash) pairs keeps the
		// card count at the limit and the rows the ones that survived the filter.
		const selected = new Set(page.map((k) => `${k.repo_identity}\0${k.commit_hash}`));
		rows = rows.filter((row) => selected.has(`${row.repo_identity}\0${row.commit_hash}`));
	} catch (err) {
		// The feed is one card on one page; a query failure degrades it to the
		// tier-0 session list rather than taking the whole dashboard down.
		log.warn("memory cards unavailable: %s", errMsg(err));
		return [];
	}

	return rows.map((row) => {
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
		const changed = (row.insertions ?? 0) + (row.deletions ?? 0);
		return {
			repoIdentity: row.repo_identity,
			commitHash: row.commit_hash,
			title: row.commit_message ?? "",
			...(category ? { category } : {}),
			severity: changed >= MEMORY_CARD_MAJOR_LINES ? ("major" as const) : ("minor" as const),
			committedAtMs: row.commit_date_ms,
			...(decision ? { decision } : {}),
			...(row.est_cost_usd != null ? { estCostUsd: row.est_cost_usd } : {}),
			...(row.turns != null ? { turns: row.turns } : {}),
			...(row.insertions != null ? { insertions: row.insertions } : {}),
			...(row.deletions != null ? { deletions: row.deletions } : {}),
			...(row.branch ? { branch: row.branch } : {}),
			...withModel(summary),
			repoName: row.repo_name,
		};
	});
}

/** Spreads the working model in only when one is recorded. */
function withModel(summary: CommitSummary): { model?: string } {
	const model = dominantWorkingModel(summary);
	return model ? { model } : {};
}

// ── Tool / skill / MCP usage ────────────────────────────────────────────────

/**
 * Skills, MCP servers and the tool mix over the window.
 *
 * Every figure here is Claude-only by construction, so the coverage numbers are
 * computed from `sessions` — the full population — and never from the join.
 * `uncoveredSources` names the agents that contributed sessions but no tool
 * records, because "linear: 3 sessions" is a very different statement depending
 * on whether the other 40 sessions could have been counted and were not.
 *
 * Adoption (`sessions`) leads the ranking over volume (`calls`) deliberately: a
 * single session that hammered one tool 200 times is not evidence that the tool
 * matters, whereas a tool reached for across many separate sessions is.
 */
function buildToolUsage(db: DashboardDbHandle, scope: DashboardScope, window: ResolvedWindow): ToolUsage {
	const filter = scopeFilter(scopeToRepoId(db, scope), "s.repo_id");
	const rows = db
		.prepare(
			`SELECT t.tool_name, t.kind, t.server,
			        COUNT(DISTINCT t.session_event_id) AS session_count,
			        COALESCE(SUM(t.calls), 0) AS call_count
			   FROM session_tool_use t
			   JOIN sessions s ON s.event_id = t.session_event_id
			  WHERE s.updated_at_ms >= ? AND s.updated_at_ms < ?${filter.sql}
			  GROUP BY t.kind, t.tool_name, t.server`,
		)
		.all(window.startMs, window.endMs, ...filter.params) as ReadonlyArray<{
		tool_name: string;
		kind: string;
		server: string | null;
		session_count: number;
		call_count: number;
	}>;

	const skills: ToolUsageRow[] = rows
		.filter((row) => row.kind === "skill")
		.map((row) => ({
			name: row.tool_name,
			kind: "skill" as const,
			sessions: row.session_count,
			calls: row.call_count,
		}));

	// The same rows already carry a per-tool breakdown for MCP calls (tool_name
	// is `server.tool`, see TranscriptParser) — this is the "by tool" split of
	// `servers` below, not a second query.
	const mcpTools: ToolUsageRow[] = rows
		.filter((row) => row.kind === "mcp")
		.map((row) => ({
			name: row.tool_name,
			kind: "mcp" as const,
			sessions: row.session_count,
			calls: row.call_count,
		}));

	// Pulled from the untruncated `rows`, not from `mcpTools` below — recall can
	// rank outside the top TOOL_ROWS_LIMIT tools by adoption even with real
	// volume, and filtering the truncated array would silently drop it.
	//
	// Matched against EVERY spelling of the tool (see RECALL_MCP_TOOL_NAMES): a
	// plugin-registered server namespaces the row, and an equality test on the
	// bare name reported "no recall calls" forever on those installs. Reported
	// under the canonical name — the row is about the recall feature, not about
	// which manifest registered the server.
	const recallRows = rows.filter((row) => row.kind === "mcp" && isRecallMcpToolName(row.tool_name));
	const recallCalls: ToolUsageRow | undefined = recallRows.length
		? {
				name: RECALL_MCP_TOOL_NAME,
				kind: "mcp",
				// Summed across spellings. A session that used two of them counts twice,
				// which needs the same server registered under two namespaces at once —
				// pathological, and not worth a second query to be exact about.
				sessions: recallRows.reduce((n, row) => n + row.session_count, 0),
				calls: recallRows.reduce((n, row) => n + row.call_count, 0),
			}
		: undefined;

	// Servers get their OWN grouping rather than a roll-up of the per-tool rows
	// above. Session counts there are per tool, so neither combining rule is
	// right: summing double-counts a session that called two of a server's tools,
	// and the max — what this used to do — undercounts two sessions that each
	// called a different one. `COUNT(DISTINCT session_event_id)` grouped by server
	// is the figure the UI already presents this as.
	const serverRows = db
		.prepare(
			`SELECT t.server,
			        COUNT(DISTINCT t.session_event_id) AS session_count,
			        COALESCE(SUM(t.calls), 0) AS call_count,
			        COUNT(DISTINCT t.tool_name) AS tool_count
			   FROM session_tool_use t
			   JOIN sessions s ON s.event_id = t.session_event_id
			  WHERE s.updated_at_ms >= ? AND s.updated_at_ms < ?${filter.sql}
			    AND t.kind = 'mcp' AND t.server IS NOT NULL
			  GROUP BY t.server`,
		)
		.all(window.startMs, window.endMs, ...filter.params) as ReadonlyArray<{
		server: string;
		session_count: number;
		call_count: number;
		tool_count: number;
	}>;

	const byAdoption = <T extends { sessions: number; calls: number }>(a: T, b: T) =>
		b.sessions - a.sessions || b.calls - a.calls;

	// Coverage from the FULL session population, never from the join above.
	const sessionFilter = scopeFilter(scopeToRepoId(db, scope), "s.repo_id");
	const sessionRows = db
		.prepare(
			`SELECT s.source,
			        COUNT(*) AS total,
			        COALESCE(SUM(EXISTS (SELECT 1 FROM session_tool_use t WHERE t.session_event_id = s.event_id)), 0) AS with_tools
			   FROM sessions s
			  WHERE s.updated_at_ms >= ? AND s.updated_at_ms < ?${sessionFilter.sql}
			  GROUP BY s.source`,
		)
		.all(window.startMs, window.endMs, ...sessionFilter.params) as ReadonlyArray<{
		source: string;
		total: number;
		with_tools: number;
	}>;

	return {
		skills: skills.sort(byAdoption).slice(0, TOOL_ROWS_LIMIT),
		mcpTools: mcpTools.sort(byAdoption).slice(0, TOOL_ROWS_LIMIT),
		recallCalls,
		servers: serverRows
			.map(
				(row): McpServerRow => ({
					server: row.server,
					sessions: row.session_count,
					calls: row.call_count,
					tools: row.tool_count,
				}),
			)
			.sort(byAdoption)
			.slice(0, TOOL_ROWS_LIMIT),
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

/** A used memory older than this counts toward `staleMemoriesUsed`. */
const RECALL_STALE_MS = 30 * 86_400_000;

/**
 * The Recall card: how often recall actually served usable commit context.
 *
 * Reads `recall_receipts` — one row per call, written by whoever served it
 * (see that table's DDL). It used to read recall outcomes parsed back out of
 * Claude transcripts, which is why this card carried a Claude-only coverage
 * caveat and an `uncoveredSources` list; both are gone, because a receipt does
 * not care which agent (or none) made the call.
 *
 * The window is applied on each receipt's own `at_ms`, so a call made days
 * before the session that hosted it last moved still lands in the right day.
 *
 * One figure does NOT come from receipts: `callsWithoutReceipt` counts the MCP
 * recall calls the transcripts recorded and no receipt covers — the history
 * from before receipts were written. It is a call count and nothing more; every
 * outcome-derived figure on this card stays receipt-only.
 */
function buildRecallUsage(
	db: DashboardDbHandle,
	scope: DashboardScope,
	window: ResolvedWindow,
	timeZone: string,
	nowMs: number,
): RecallUsage {
	const repoId = scopeToRepoId(db, scope);
	const filter = scopeFilter(repoId, "r.repo_id");
	const rows = db
		.prepare(
			`SELECT r.at_ms, r.surface, r.session_id, r.hit, r.commits_json
			   FROM recall_receipts r
			  WHERE r.at_ms >= ? AND r.at_ms < ?${filter.sql}`,
		)
		.all(window.startMs, window.endMs, ...filter.params) as ReadonlyArray<{
		at_ms: number;
		surface: string;
		session_id: string | null;
		hit: number;
		commits_json: string | null;
	}>;

	const daily = new Map<string, { used: number; setAside: number }>();
	for (let dayStart = window.startMs; dayStart < window.endMs; dayStart = addLocalDays(dayStart, 1, timeZone)) {
		daily.set(localDayKey(dayStart, timeZone), { used: 0, setAside: 0 });
	}

	let usedCalls = 0;
	let setAsideCalls = 0;
	const sessionsWithContext = new Set<string>();
	const callsBySurface = new Map<string, number>();
	// hash → date, first occurrence wins — the same commit served twice always
	// carries the same date, so "first" is just "any".
	const memoriesUsed = new Map<string, string>();
	for (const row of rows) {
		callsBySurface.set(row.surface, (callsBySurface.get(row.surface) ?? 0) + 1);
		const bucket = daily.get(localDayKey(row.at_ms, timeZone));
		if (!row.hit) {
			setAsideCalls++;
			if (bucket) bucket.setAside++;
			continue;
		}
		usedCalls++;
		if (row.session_id) sessionsWithContext.add(row.session_id);
		if (bucket) bucket.used++;
		let commits: unknown;
		try {
			commits = row.commits_json ? JSON.parse(row.commits_json) : [];
		} catch {
			commits = [];
		}
		for (const c of Array.isArray(commits) ? commits : []) {
			const co = c as { hash?: unknown; date?: unknown };
			if (typeof co.hash === "string" && typeof co.date === "string" && !memoriesUsed.has(co.hash)) {
				memoriesUsed.set(co.hash, co.date);
			}
		}
	}

	const staleMemoriesUsed = [...memoriesUsed.values()].filter((date) => {
		const ms = Date.parse(date);
		return Number.isFinite(ms) && nowMs - ms > RECALL_STALE_MS;
	}).length;

	const totalCalls = usedCalls + setAsideCalls;

	// Coverage denominator: sessions in the window, PLUS any session a receipt in
	// the window points at. The second arm is what keeps `sessionsWithContext`
	// (counted off the receipts above) from ever exceeding it — a session last
	// touched before the window can still have made an in-window recall call.
	const sessionFilter = scopeFilter(repoId, "s.repo_id");
	const sessionRows = db
		.prepare(
			`SELECT COUNT(*) AS total
			   FROM sessions s
			  WHERE (
			          (s.updated_at_ms >= ? AND s.updated_at_ms < ?)
			          OR EXISTS (
			               SELECT 1 FROM recall_receipts r
			                WHERE r.repo_id = s.repo_id AND r.session_id = s.session_id
			                  AND r.at_ms >= ? AND r.at_ms < ?
			             )
			        )${sessionFilter.sql}`,
		)
		.get(window.startMs, window.endMs, window.startMs, window.endMs, ...sessionFilter.params) as { total: number };

	// Skill invocations: the `jolli-recall` skill being run, which is NOT a
	// recall call (see RecallUsage.skillInvocations for why it stays out of the
	// hit rate). Windowed by the session, the only time a tool row has.
	const skillFilter = scopeFilter(repoId, "s.repo_id");
	const skillRow = db
		.prepare(
			`SELECT COALESCE(SUM(t.calls), 0) AS calls
			   FROM session_tool_use t
			   JOIN sessions s ON s.event_id = t.session_event_id
			  WHERE t.kind = 'skill' AND t.tool_name IN (${placeholders(RECALL_SKILL_NAMES.length)})
			    AND s.updated_at_ms >= ? AND s.updated_at_ms < ?${skillFilter.sql}`,
		)
		.get(...RECALL_SKILL_NAMES, window.startMs, window.endMs, ...skillFilter.params) as { calls: number };

	// Backfilled recall calls: the MCP tool as the transcripts recorded it, minus
	// the ones a receipt already accounts for (see RecallUsage.callsWithoutReceipt
	// for the subtraction's edge case and why references are not a second source).
	// Windowed by the session, like the skill count above and for the same reason.
	const toolFilter = scopeFilter(repoId, "s.repo_id");
	const toolRow = db
		.prepare(
			`SELECT COALESCE(SUM(t.calls), 0) AS calls
			   FROM session_tool_use t
			   JOIN sessions s ON s.event_id = t.session_event_id
			  WHERE t.kind = 'mcp'
			    AND (t.tool_name = ? OR t.tool_name LIKE ? ESCAPE '\\')
			    AND s.updated_at_ms >= ? AND s.updated_at_ms < ?${toolFilter.sql}`,
		)
		// `\_` escapes SQLite's single-character wildcard, so the underscore in the
		// suffix is a literal — `isRecallMcpToolName`'s test, expressed in SQL.
		.get(
			RECALL_MCP_TOOL_NAME,
			`%\\${RECALL_MCP_TOOL_SUFFIX}`,
			window.startMs,
			window.endMs,
			...toolFilter.params,
		) as {
		calls: number;
	};
	// Second, independent record of the same calls: the `jollimemory` reference
	// source, which bookmarks every recall the reference extractor saw and stamps
	// EACH one with its own time — so unlike the tool rows above these land in the
	// window exactly. It is the only channel with data on a machine whose
	// tool-call recording started late, and the only one that sees a source whose
	// transcripts carry no tool calls at all.
	const refFilter = scopeFilter(repoId, "repo_id");
	const refBodies = db
		.prepare(
			`SELECT body_md FROM context
			  WHERE kind = 'reference' AND source = ? AND native_id = ?${refFilter.sql}`,
		)
		.all(RECALL_REFERENCE_SOURCE, RECALL_REFERENCE_NATIVE_ID, ...refFilter.params) as ReadonlyArray<{
		body_md: string | null;
	}>;
	let referenceCalls = 0;
	for (const row of refBodies) {
		for (const at of accumulatedEntryTimes(row.body_md ?? undefined)) {
			const ms = Date.parse(at);
			if (Number.isFinite(ms) && ms >= window.startMs && ms < window.endMs) referenceCalls++;
		}
	}

	// Both channels under-report — a tool row cannot see a source that records no
	// tool calls, a reference body dedupes a repeated query and caps at 20 — and
	// neither can be joined to the other (a reference has no session, a tool row
	// has no time). So take the larger: the max of two lower bounds is still a
	// lower bound, while a sum would count the common case twice.
	const callsWithoutReceipt = Math.max(0, Math.max(toolRow.calls, referenceCalls) - (callsBySurface.get("mcp") ?? 0));

	return {
		usedCalls,
		setAsideCalls,
		contextServedPct: totalCalls > 0 ? Math.round((usedCalls / totalCalls) * 100) : 0,
		distinctMemoriesUsed: memoriesUsed.size,
		staleMemoriesUsed,
		sessionsWithContext: sessionsWithContext.size,
		sessionsInWindow: sessionRows.total,
		bySurface: [...callsBySurface.entries()]
			.map(([surface, calls]) => ({ surface: surface as RecallSurface, calls }))
			.sort((a, b) => b.calls - a.calls),
		skillInvocations: skillRow.calls,
		callsWithoutReceipt,
		daily: [...daily.entries()].map(([date, b]) => ({ date, used: b.used, setAside: b.setAside })),
	};
}

/** Fallback for a `buildDashboardModel` call that never read the repo registry. */
const NO_REPOSITORIES_MODEL: RepositoriesModel = { repos: [], hooksManifest: [] };

// ── Model assembly ──────────────────────────────────────────────────────────

/** Builds the full page payload for one view + scope. */
export function buildDashboardModel(db: DashboardDbHandle, opts: QueryOptions): DashboardModel {
	const timeZone = opts.timeZone ?? machineTimeZone();
	const nowMs = opts.nowMs ?? Date.now();
	// Normalize the requested scope BEFORE anything reads it, so every builder and
	// the echoed-back `model.scope` agree on one identity (see `resolveScope`).
	const options: QueryOptions = { ...opts, scope: resolveScope(db, opts.scope) };

	// `sessionsThisWeek` is the sidebar's per-repo meta figure, computed here so
	// the shell needs no second round trip.
	const weekStartMs = addLocalDays(nowMs, -6, timeZone);
	const repoRows = db
		.prepare(
			`SELECT r.repo_identity, r.repo_name, r.worktree_root, r.bootstrap_state,
			        (SELECT COUNT(*) FROM sessions s
			          WHERE s.repo_id = r.id AND s.updated_at_ms >= ?) AS week_sessions
			   FROM repos r WHERE r.disabled_at IS NULL ORDER BY r.repo_name`,
		)
		.all(weekStartMs) as ReadonlyArray<{
		repo_identity: string;
		repo_name: string;
		worktree_root: string;
		bootstrap_state: string;
		week_sessions: number;
	}>;
	const repos: RepoOption[] = repoRows.map((r) => ({
		repoIdentity: r.repo_identity,
		repoName: r.repo_name,
		worktreeRoot: r.worktree_root,
		sessionsThisWeek: r.week_sessions,
	}));

	// Coverage notes are per VIEW, not global. A caveat is only honest next to
	// the data it qualifies: "older activity is reconstructed from commits and
	// stored summaries" describes the session/commit activity timeline, and on the
	// graph page — which renders a distilled artifact and no activity at all —
	// it is a statement about something the reader is not looking at.
	//
	// There is deliberately NO in-progress import note. It used to be the one note
	// that spanned every view, sitting at the foot of all four pages for the whole
	// bootstrap; `bootstrap_state` is still tracked and still drives resume, it just
	// no longer has a banner. Re-adding one is a product decision, not a fix — the
	// numbers filling in as the import runs is the behaviour, and it needs no
	// footnote on every page to be understood.
	const coverage: CoverageNote[] = [];
	const showsActivity = options.view === "stats" || options.view === "standup";
	if (showsActivity) {
		const sessionCount =
			(db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number } | undefined)?.n ?? 0;
		coverage.push(
			sessionCount === 0
				? { kind: "no-data", message: "No sessions recorded yet — data appears after your next AI session." }
				: {
						kind: "sessions-window",
						message:
							"Older activity is reconstructed from commits and stored summaries; recent sessions are exact.",
					},
		);
	}

	const tier = detectTier(db);
	const window = () => resolveWindow(options.range, options.customFrom, options.customTo, nowMs, timeZone);
	// Exactly one view payload is built per request — the other two would be
	// wasted queries, and the page only ever reads its own.
	const payload = (): Pick<DashboardModel, "stats" | "standup" | "repositories" | "memories"> => {
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
				return { standup: buildStandup(db, options.scope, timeZone, nowMs, tier) };
			case "repositories":
				return { repositories: options.repositoriesModel ?? NO_REPOSITORIES_MODEL };
			case "memories":
				// No tier gate, unlike Decisions: a memory is a per-commit capture,
				// not a recall receipt, so it exists as soon as a commit is
				// summarized — there is nothing here that only makes sense above a
				// tier.
				return { memories: buildMemories(db, options.scope, options.hash, options.reachableCommits) };
		}
	};

	return {
		// Bumped from 1 → 2 when Decisions was retired (its view token and
		// payload shape removed): an old tab left open across this upgrade would
		// otherwise poll `/api/model` and try to render a `decisions` view that
		// no longer exists. `JD.refreshNow` compares this against the tab's own
		// `window.__JOLLI_DASHBOARD__.schemaVersion` and reloads on mismatch.
		schemaVersion: 2,
		view: options.view,
		tier,
		generatedAtMs: nowMs,
		timeZone,
		scope: options.scope,
		repos,
		coverage,
		...payload(),
	};
}
