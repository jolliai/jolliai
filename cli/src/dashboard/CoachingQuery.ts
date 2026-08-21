/**
 * The coaching roster: one subject's numbers for the single-subject journeys
 * view, plus the featured smoothest/hardest pair and the hero trend that back
 * its inline expansion.
 *
 * Built on top of {@link buildJourneys} rather than re-reading `memories`
 * directly — a journey is already the grouped, availability-aware unit this
 * page renders, and re-deriving plan-first / cost from raw rows would be a
 * second place those rules could drift from the journeys feed they describe.
 */

import type { DashboardDbHandle } from "./DashboardDb.js";
import type {
	AdoptItem,
	CoachingModel,
	CoachingRoster,
	DashboardScope,
	LocalJourney,
	Pattern,
	PatternsModel,
	QueueItem,
	RosterAvailability,
	RosterCell,
	RosterSkillsCell,
} from "./DashboardModel.js";
import { isRecallMcpToolName } from "./DashboardModel.js";
import { type ResolvedScope, scopeFilter, scopeToRepoIds } from "./DashboardScopeUtil.js";
import { buildCoachingWindow, buildJourneys } from "./JourneysQuery.js";
import { localDayKey, localWeekKey } from "./LocalDays.js";
import type { ReachableCommits } from "./MemoriesQuery.js";

/**
 * Epoch ms of the earliest captured tool-use row, or `undefined` when none
 * exist. Tool-use capture was added part-way through this product's life, so a
 * window reaching before this boundary measures only part of its own span.
 */
function firstToolCaptureMs(db: DashboardDbHandle, resolved: ResolvedScope): number | undefined {
	const filter = scopeFilter(resolved, "s.repo_id");
	const row = db
		.prepare(
			`SELECT MIN(s.started_at_ms) AS first_ms
			   FROM session_tool_use t
			   JOIN sessions s ON s.event_id = t.session_event_id
			  WHERE 1 = 1${filter.sql}`,
		)
		.get(...filter.params) as { first_ms: number | null } | undefined;
	return row?.first_ms ?? undefined;
}

/** `measured` only when the whole window lies at or after capture began. */
function captureAvailability(
	db: DashboardDbHandle,
	resolved: ResolvedScope,
	fromMs: number,
	hasRows: boolean,
): RosterAvailability {
	const first = firstToolCaptureMs(db, resolved);
	if (first === undefined) return "unavailable";
	if (fromMs < first) return "partial";
	return hasRows ? "measured" : "unavailable";
}

function planFirstCell(journeys: ReadonlyArray<LocalJourney>, prior: ReadonlyArray<LocalJourney>): RosterCell {
	if (journeys.length === 0) return { availability: "unavailable" };
	const share = (set: ReadonlyArray<LocalJourney>) =>
		set.length === 0 ? undefined : Math.round((set.filter((j) => j.planFirst).length / set.length) * 100);
	const value = share(journeys) as number;
	const before = share(prior);
	// A share is already a percentage, so its trend is a difference in
	// percentage POINTS, not a percentage of a percentage.
	return {
		availability: "measured",
		value,
		...(before !== undefined ? { trendPct: value - before } : {}),
	};
}

/**
 * Cost over the window, trended against the SAME population that produced the
 * displayed number — the journeys this window grouped, not a re-sum of
 * `sessions.est_cost_usd`. Trending a different clock and a different
 * population than the number beside it is the shape that produced "$0.00" with
 * "+200%" next to it on the Spend card, and was removed there for that reason.
 */
function costCell(journeys: ReadonlyArray<LocalJourney>, prior: ReadonlyArray<LocalJourney>): RosterCell {
	const total = (set: ReadonlyArray<LocalJourney>) => set.reduce((sum, j) => sum + (j.costUsd ?? 0), 0);
	const measured = journeys.some((j) => j.costUsd != null);
	if (!measured) return { availability: "unavailable" };
	const value = total(journeys);
	const before = total(prior);
	return {
		availability: "measured",
		value,
		...(before > 0 ? { trendPct: Math.round(((value - before) / before) * 100) } : {}),
	};
}

function skillsCell(db: DashboardDbHandle, resolved: ResolvedScope, fromMs: number, toMs: number): RosterSkillsCell {
	const filter = scopeFilter(resolved, "s.repo_id");
	const rows = db
		.prepare(
			`SELECT t.tool_name, COALESCE(SUM(t.calls), 0) AS calls
			   FROM session_tool_use t
			   JOIN sessions s ON s.event_id = t.session_event_id
			  WHERE t.kind = 'skill' AND s.started_at_ms >= ? AND s.started_at_ms < ?${filter.sql}
			  GROUP BY t.tool_name
			  ORDER BY calls DESC, t.tool_name ASC`,
		)
		.all(fromMs, toMs, ...filter.params) as ReadonlyArray<{ tool_name: string; calls: number }>;
	const availability = captureAvailability(db, resolved, fromMs, rows.length > 0);
	if (availability !== "measured") return { availability };
	return {
		availability,
		value: rows.reduce((n, r) => n + r.calls, 0),
		topName: rows[0]?.tool_name,
		distinctCount: rows.length,
	};
}

/**
 * Recall calls over the window, summed across every spelling of the tool.
 * SQL narrows with a suffix `LIKE` and the JS predicate decides — a server whose
 * name merely ends in the same letters is rejected rather than counted.
 */
function recallCell(db: DashboardDbHandle, resolved: ResolvedScope, fromMs: number, toMs: number): RosterCell {
	const filter = scopeFilter(resolved, "s.repo_id");
	const rows = db
		.prepare(
			`SELECT t.tool_name, COALESCE(SUM(t.calls), 0) AS calls
			   FROM session_tool_use t
			   JOIN sessions s ON s.event_id = t.session_event_id
			  WHERE t.kind = 'mcp' AND t.tool_name LIKE '%jollimemory.recall'
			    AND s.started_at_ms >= ? AND s.started_at_ms < ?${filter.sql}
			  GROUP BY t.tool_name`,
		)
		.all(fromMs, toMs, ...filter.params) as ReadonlyArray<{ tool_name: string; calls: number }>;
	const matched = rows.filter((row) => isRecallMcpToolName(row.tool_name));
	const availability = captureAvailability(db, resolved, fromMs, matched.length > 0);
	if (availability !== "measured") return { availability };
	return { availability, value: matched.reduce((n, r) => n + r.calls, 0) };
}

/** Median activity minutes over the journeys whose duration was measured. */
function medianActivityMinutes(journeys: ReadonlyArray<LocalJourney>): number | undefined {
	const minutes = journeys
		.filter((journey) => journey.availability.duration === "measured" && journey.durationMinutes != null)
		.map((journey) => journey.durationMinutes as number)
		.sort((left, right) => left - right);
	if (minutes.length === 0) return undefined;
	const mid = Math.floor(minutes.length / 2);
	return minutes.length % 2 ? minutes[mid] : Math.round((minutes[mid - 1] + minutes[mid]) / 2);
}

/**
 * The roster's turnaround chip: median activity minutes per journey, trended
 * against the same measure over the preceding window. `unavailable` — never a
 * zero — when no journey in the window has measured duration: an unmeasured
 * turnaround is not an instant one.
 */
function turnaroundCell(journeys: ReadonlyArray<LocalJourney>, prior: ReadonlyArray<LocalJourney>): RosterCell {
	const value = medianActivityMinutes(journeys);
	if (value === undefined) return { availability: "unavailable" };
	const before = medianActivityMinutes(prior);
	return {
		availability: "measured",
		value,
		...(before !== undefined && before > 0 ? { trendPct: Math.round(((value - before) / before) * 100) } : {}),
	};
}

/** Bucket key -> accumulated cost/turns, in first-seen order. */
function heroPoints(
	journeys: ReadonlyArray<LocalJourney>,
	timeZone: string,
): ReadonlyArray<{ readonly date: string; readonly costUsd: number; readonly turns: number }> {
	const zone = timeZone;
	const byDate = new Map<string, { costUsd: number; turns: number }>();
	for (const journey of journeys) {
		const key = localDayKey(journey.endedAtMs, zone);
		const bucket = byDate.get(key) ?? { costUsd: 0, turns: 0 };
		bucket.costUsd += journey.costUsd ?? 0;
		bucket.turns += journey.turns ?? 0;
		byDate.set(key, bucket);
	}
	// `journeys` arrives sorted DESCENDING by `endedAtMs` (modelFromGroups), and
	// `localDayKey` is non-decreasing in its input, so `byDate`'s insertion order
	// — and so the pre-sort array here — is always non-increasing in `date`, with
	// `Map` key uniqueness ruling out a tie. Measured against V8's real sort: a
	// purely descending input's "detect the run is reversed" pass calls this
	// comparator with the SMALLER-index element first every time, so `left <
	// right` is always true and the `left > right` arm is never reached at all —
	// both are defensive completeness for a comparator contract, not reachable
	// through the one caller (`heroPoints`) that ever builds this array.
	/* v8 ignore start */
	return [...byDate.entries()]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([date, v]) => ({ date, ...v }));
	/* v8 ignore stop */
}

/** How many of the most-recent journeys the ADOPT NEXT share is measured over. */
const ADOPT_WINDOW = 5;

/** A wait this long is a real stall where the agent sat waiting on the human,
 *  not reading/typing latency. Local decision; no spec constant. */
const WAIT_STALL_MINUTES = 30;

/**
 * The ADOPT NEXT card's recommendations. Rule-driven over the window's journeys
 * (§3.5): the share is a fixed-template sentence over the last N journeys, never
 * an LLM pass. `journeys` arrives sorted by `endedAtMs` descending, so a slice
 * from the front is "the last N".
 */
function buildAdoptNext(journeys: ReadonlyArray<LocalJourney>): ReadonlyArray<AdoptItem> {
	if (journeys.length === 0) return [];
	const last = journeys.slice(0, ADOPT_WINDOW);
	const adopted = last.filter((journey) => journey.planFirst).length;
	return [
		{
			key: "plan-first",
			title: "Plan first",
			detail: `${adopted} of your last ${last.length} journeys planned first`,
			adopted,
			window: last.length,
		},
	];
}

/** The glyph's turn ceiling — a journey at or past it is one worth splitting. */
const SCOPE_TURNS = 40;

/**
 * Self-directed action items, each drawn from a specific journey (the evidence
 * link). Two rules, each emitted at most once; the evidence is the journey that
 * most clearly motivates the item, so clicking it opens that journey's trace.
 */
function buildQueue(journeys: ReadonlyArray<LocalJourney>): ReadonlyArray<QueueItem> {
	if (journeys.length === 0) return [];
	const items: QueueItem[] = [];
	const planFirstCount = journeys.filter((journey) => journey.planFirst).length;
	if (planFirstCount * 2 < journeys.length) {
		const straight = journeys.find((journey) => !journey.planFirst);
		// `planFirstCount * 2 < journeys.length` (the outer guard) means fewer than
		// half planned first, so a majority have `planFirst: false` — `straight` can
		// never come back undefined whenever this line runs.
		/* v8 ignore start */
		if (straight) {
			/* v8 ignore stop */
			items.push({
				key: "plan-first",
				title: "Write a plan before your next feature",
				detail: `${planFirstCount} of ${journeys.length} journeys in this window planned first`,
				journeyId: straight.id,
				journeyTitle: straight.title,
				journeyTicket: straight.ticket,
				repoIdentity: straight.repoIdentity,
			});
		}
	}
	const heavy = journeys.reduce<LocalJourney | null>((best, journey) => {
		if (journey.turns == null) return best;
		// `best` is only ever assigned a journey that passed the `turns == null`
		// guard above, so `best.turns` is never null/undefined once `best` is
		// non-null — this `?? 0` exists only to satisfy the type.
		/* v8 ignore start */
		return best == null || journey.turns > (best.turns ?? 0) ? journey : best;
		/* v8 ignore stop */
	}, null);
	// Same reasoning as above: `heavy` only ever comes from a journey with a real
	// `turns` number, so `heavy.turns ?? 0`'s fallback is unreachable.
	/* v8 ignore start */
	if (heavy && (heavy.turns ?? 0) >= SCOPE_TURNS) {
		/* v8 ignore stop */
		items.push({
			key: "scope",
			title: "Break large work into smaller journeys",
			detail: `${heavy.turns} turns in one journey — split it into a few smaller ones`,
			journeyId: heavy.id,
			journeyTitle: heavy.title,
			journeyTicket: heavy.ticket,
			repoIdentity: heavy.repoIdentity,
		});
	}
	return items;
}

/** §3.4 evidence bar: outside Emerging needs ≥4 journeys over ≥3 distinct weeks. */
const EVIDENCE_MIN_COUNT = 4;
const EVIDENCE_MIN_WEEKS = 3;

/**
 * Behaviour patterns over the window's journeys. Each pattern reports how many
 * journeys it matched and how many distinct ISO weeks they span; the §3.4
 * evidence bar is the `emerging` flag — a pattern below either threshold lives
 * only in the Emerging bucket, never presented as an established claim.
 */
function buildPatterns(journeys: ReadonlyArray<LocalJourney>, timeZone: string): PatternsModel {
	const zone = timeZone;
	const defs: ReadonlyArray<{
		readonly key: string;
		readonly label: string;
		readonly match: (j: LocalJourney) => boolean;
	}> = [
		{ key: "plan-first", label: "Plan first", match: (journey) => journey.planFirst },
		{ key: "straight-to-execute", label: "Straight to execute", match: (journey) => !journey.planFirst },
		{ key: "single-commit", label: "Single-commit journeys", match: (journey) => journey.commitCount === 1 },
		// Positive evidence only: `tested?.testFirst === true` means a pre-commit
		// run was SEEN. A `partial` journey with no pre-commit run is "no positive
		// evidence", never "definitely not test-first", so it does not count.
		{ key: "test-first", label: "Test first", match: (journey) => journey.tested?.testFirst === true },
	];
	// `defs`' four keys are all distinct strings, so a tie on `.key` (the
	// trailing `: 0`) can never happen — kept for the same reason a comparator's
	// contract always spells out all three outcomes.
	/* v8 ignore start */
	const byDisplay = (left: Pattern, right: Pattern) =>
		right.count - left.count || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
	/* v8 ignore stop */
	const patterns = defs
		.map((def) => {
			const matches = journeys.filter(def.match);
			const weeks = new Set(matches.map((journey) => localWeekKey(journey.endedAtMs, zone))).size;
			const count = matches.length;
			return {
				key: def.key,
				label: def.label,
				count,
				weeks,
				emerging: count < EVIDENCE_MIN_COUNT || weeks < EVIDENCE_MIN_WEEKS,
			};
		})
		// A zero-count pattern is not a pattern — it is the ABSENCE of a behaviour,
		// and rendering "0 of your journeys were X" as an emerging claim is the
		// same lie the roster's em dash exists to avoid.
		.filter((pattern) => pattern.count > 0);
	return {
		established: patterns.filter((pattern) => !pattern.emerging).sort(byDisplay),
		emerging: patterns.filter((pattern) => pattern.emerging).sort(byDisplay),
	};
}

/**
 * The single-subject roster and its expansion payload for the coaching page.
 *
 * Calls {@link buildJourneys} twice — once for the requested window, once for
 * the immediately preceding window of equal length — so every trended cell
 * compares against the same population shape rather than a different clock.
 *
 * `timeZone` is the zone the window was resolved under (the model builder's
 * injected `QueryOptions.timeZone`), threaded into the hero and pattern
 * bucketing: every date bucket in the payload must use the same zone the
 * window's bounds were computed in, or a payload can describe a window in one
 * zone and label its days in another.
 */
export function buildCoaching(
	db: DashboardDbHandle,
	scope: DashboardScope,
	fromMs: number,
	toMs: number,
	timeZone: string,
	reachable?: ReachableCommits,
): CoachingModel {
	// Only the WINDOW build pays the transcript walk for test-first (patterns)
	// and the roster's friction cell — `buildCoachingWindow` assembles the
	// window ONCE and walks its transcripts ONCE for both, instead of the old
	// three assembles / two decompressions per render. The prior build feeds
	// trends, which need no turn signal.
	const { model, friction } = buildCoachingWindow(db, scope, fromMs, toMs, reachable);
	const priorFrom = fromMs - (toMs - fromMs);
	const prior = buildJourneys(db, scope, priorFrom, fromMs, reachable);
	const byId = new Map(model.journeys.map((j) => [j.id, j]));
	// The skill/recall cells read `session_tool_use` directly (not via a
	// journey), so they must apply the page's repo scope themselves or they
	// would mix machine-wide totals into an otherwise repo-scoped roster row.
	const resolved = scopeToRepoIds(db, scope);
	const roster: CoachingRoster = {
		label: "You",
		planFirst: planFirstCell(model.journeys, prior.journeys),
		skills: skillsCell(db, resolved, fromMs, toMs),
		cost: costCell(model.journeys, prior.journeys),
		recall: recallCell(db, resolved, fromMs, toMs),
		turnaround: turnaroundCell(model.journeys, prior.journeys),
		friction,
	};
	// `flaggedCount`'s denominator is journeys whose friction is MEASURABLE
	// (measured or partial, never unavailable) — a window with none is not "0
	// flagged", it is "flagging was never measured here".
	const flaggable = model.journeys.filter((j) => j.friction && j.friction.availability !== "unavailable");
	// `j.friction?.value` is defined whenever `j.friction.availability` is
	// "measured"/"partial" — `turnAbortsCell` always sets `value` alongside
	// either of those (see JourneysQuery.ts) — so `?? 0` never falls back for a
	// journey this filter actually reaches.
	/* v8 ignore start */
	const flaggedCount =
		flaggable.length === 0 ? undefined : model.journeys.filter((j) => (j.friction?.value ?? 0) > 0).length;
	/* v8 ignore stop */
	// `awaitingCount` similarly stays absent unless at least one journey's wait
	// was actually measured, never a false "0 stalled".
	const waitMeasured = model.journeys.some((j) => j.longestWaitMinutes !== undefined);
	// `buildCoachingWindow` always runs `collectWindowSignals` with `wantWaits`
	// true, which sets EVERY journey's `longestWaitMinutes` (0 when no wait
	// qualified) — so by the time `waitMeasured` is true, every journey already
	// has a defined value and this `?? 0` fallback never fires.
	/* v8 ignore start */
	const awaitingCount = waitMeasured
		? model.journeys.filter((j) => (j.longestWaitMinutes ?? 0) >= WAIT_STALL_MINUTES).length
		: undefined;
	/* v8 ignore stop */
	return {
		roster,
		adoptNext: buildAdoptNext(model.journeys),
		queue: buildQueue(model.journeys),
		patterns: buildPatterns(model.journeys, timeZone),
		hero: heroPoints(model.journeys, timeZone),
		// `byId` is built from `model.journeys`, the exact array `model.smoothestId`
		// / `model.hardestId` were derived from (see JourneysQuery.ts's
		// `modelFromGroups`), so a truthy id always resolves — the `?? null`
		// fallbacks exist only to satisfy the nullable field type.
		/* v8 ignore start */
		featured: {
			smoothest: model.smoothestId ? (byId.get(model.smoothestId) ?? null) : null,
			hardest: model.hardestId ? (byId.get(model.hardestId) ?? null) : null,
		},
		/* v8 ignore stop */
		journeyCount: model.journeys.length,
		...(flaggedCount !== undefined && { flaggedCount }),
		...(awaitingCount !== undefined && { awaitingCount }),
		indexedCommits: model.indexedCommits,
		windowStartMs: model.windowStartMs,
		windowEndMs: model.windowEndMs,
	};
}
