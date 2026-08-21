/**
 * Journeys, assembled at READ TIME from `memories` and its neighbours.
 *
 * There is deliberately no `journey_commit_index` table here. `memories` is
 * already the derived, rebuildable index — with `ticket_id`, `branch` and
 * `commit_date_ms` as generated columns and `ix_mem_ticket` / `ix_mem_branch`
 * built. A second projection would repeat the mistake `SotSchema.ts` records on
 * `commits`: the ticket_id and commit_insights projections were removed (A3b)
 * because a copy falls behind whenever a memory is regenerated. See the spec's
 * §7 before adding one.
 */

import { inflateSync } from "node:zlib";
import { archivedSessionKey, sliceStartTime } from "../core/ArchivedConversations.js";
import { createLogger, errMsg } from "../Logger.js";
import type { StoredSession, StoredTranscript, TranscriptEntry } from "../Types.js";
import { ACTIVITY_BUCKET_MS } from "./ActivityBuckets.js";
import type { DashboardDbHandle } from "./DashboardDb.js";
import type {
	DashboardScope,
	FieldAvailability,
	JourneyDecision,
	JourneysModel,
	JourneyTested,
	LocalJourney,
	LocalJourneyCommit,
	RosterCell,
	TurnAttribution,
	WaitPeriod,
} from "./DashboardModel.js";
import { scopeFilter, scopeToRepoIds, splitDecisionBullets } from "./DashboardScopeUtil.js";
import { assignJourneyKeys, commitMapKey, type JourneyCommitInput } from "./JourneyKey.js";
import { deriveJourneyShape, pickHardest, pickSmoothest } from "./JourneyMetrics.js";
import { isReachable, type ReachableCommits } from "./MemoriesQuery.js";

const log = createLogger("JourneysQuery");

/**
 * Decisions carried on a feed row. The full list rides the detail route, and
 * `decisionCount` always reports the true total — a cut this page cannot see is
 * a cut it would silently misreport.
 */
const FEED_DECISION_CAP = 8;

/** One journey's full record, for the trace modal behind `/api/journey`. */
export interface JourneyDetail {
	readonly journey: LocalJourney;
	readonly commits: ReadonlyArray<LocalJourneyCommit>;
	/** Every decision, uncapped — the feed's list is cut, this one is not. */
	readonly decisions: ReadonlyArray<JourneyDecision>;
	/** "Waiting on you" stretches derived from turn timestamps. Empty, never absent. */
	readonly waits: ReadonlyArray<WaitPeriod>;
	/** The journey's recorded turns, split by speaker. Never absent. */
	readonly attribution: TurnAttribution;
	/** Epoch-ms instants the context was compacted, sorted ascending. Empty, never absent. */
	readonly compactions: ReadonlyArray<number>;
}

interface MemoryRow {
	readonly repo_identity: string;
	readonly repo_name: string;
	readonly commit_hash: string;
	readonly branch: string | null;
	readonly commit_message: string | null;
	readonly ticket_id: string | null;
	readonly committed_at_ms: number;
	readonly turns: number | null;
	readonly est_cost_usd: number | null;
	readonly summary_json: string;
}

/**
 * One (commit, session) pairing. `key` is repo-qualified only implicitly — the
 * map that holds these is already looked up per commit, and a journey never
 * spans more than one repo (every `JourneyKey.key` is namespaced by
 * `repoIdentity`), so a bare `source\x00sessionId` cannot collide across
 * commits that belong to different journeys.
 */
interface SessionRef {
	readonly key: string;
	readonly activityKey: string;
}

/** Separates `source` from `session_id` in a {@link SessionRef.key}. Escaped,
 *  never a raw byte, for the same reason `JourneyKey.ts`'s `SEP` is. */
const SESSION_KEY_SEP = "\x00";

/** Separator for the composite session key. NUL cannot occur in any component. */
const ACTIVITY_KEY_SEP = "\x00";

/**
 * Repo-qualified identity for one session's activity buckets.
 *
 * `SessionRef.key` omits the repo because it is built inside a repo-scoped
 * join and consumed inside one journey, which is repo-scoped too. This key
 * indexes a map built across every repo at once, where `(source, sessionId)`
 * is not unique — `sessions` is unique on `(repo_id, source, session_id)`.
 */
export function sessionActivityKey(repoIdentity: string, source: string, sessionId: string): string {
	return `${repoIdentity}${ACTIVITY_KEY_SEP}${source}${ACTIVITY_KEY_SEP}${sessionId}`;
}

/**
 * Every session's fifteen-minute activity buckets, keyed by
 * {@link sessionActivityKey}.
 *
 * This is the ONLY duration source for a journey. `sessions.duration_ms` is a
 * raw first-to-last-message span and is not used: measured on the live
 * database it overstates activity by 7.6-26x (one session reported 4409
 * minutes across 42 messages against 210 minutes of buckets), because sessions
 * are routinely resumed after hours of doing something else. This repo already
 * reached that conclusion when it built these buckets for the concurrency
 * figure; the journeys view was simply left reading the older column.
 *
 * A session with no rows here is absent from the map, NOT present with an empty
 * set: "no evidence" and "measured zero activity" are different claims, and
 * the fold in `assemble()` distinguishes them — a journey whose sessions are
 * all absent here reports `null`, never 0.
 */
export function readSessionBuckets(db: DashboardDbHandle): ReadonlyMap<string, ReadonlySet<number>> {
	const out = new Map<string, Set<number>>();
	const rows = db
		.prepare(
			`SELECT r.repo_identity AS repo_identity, s.source AS source,
			        s.session_id AS session_id, a.bucket_ms AS bucket_ms
			   FROM session_activity a
			   JOIN sessions s ON s.event_id = a.session_event_id
			   JOIN repos r ON r.id = s.repo_id`,
		)
		.all() as ReadonlyArray<{
		repo_identity: string;
		source: string;
		session_id: string;
		bucket_ms: number;
	}>;
	for (const row of rows) {
		const key = sessionActivityKey(row.repo_identity, row.source, row.session_id);
		const set = out.get(key);
		if (set) set.add(row.bucket_ms);
		else out.set(key, new Set([row.bucket_ms]));
	}
	return out;
}

/**
 * The SINGLE definition of a journey's duration, for every consumer.
 *
 * An upper bound by construction: one utterance inside a quarter-hour fills
 * the whole bucket. That is the price of a measure needing no idle-gap
 * threshold, and it is why every label built on this says "activity" and never
 * elapsed time.
 *
 * The bucket width comes from the writer's own `ACTIVITY_BUCKET_MS` — it must
 * not be restated here. A local copy would silently drift if the writer's
 * width ever changed, multiplying every journey's duration by the wrong
 * factor with nothing failing.
 */
export function journeyActivityMinutes(buckets: ReadonlySet<number>): number {
	return buckets.size * (ACTIVITY_BUCKET_MS / 60_000);
}

/** First line of the commit message, minus a leading ticket prefix. */
function commitTitle(message: string | null): string {
	const first = (message ?? "").split("\n")[0]?.trim() ?? "";
	return (
		first.replace(/^(closes|fixes|part of)?\s*[A-Z][A-Z0-9]+-\d+\s*[:\-—]\s*/i, "").trim() ||
		first ||
		"(no message)"
	);
}

/**
 * Per-commit session references — one entry per DISTINCT (commit, session)
 * pairing this commit touched, never pre-summed into a count or a total.
 *
 * Summing here would repeat the exact bug this function used to have: a
 * session that produced N commits in the same journey is the SAME session N
 * times, not N sessions. Deduplication across a journey's commits can only
 * happen once the caller is folding commits into one accumulator — a
 * per-commit aggregate has already thrown away which session is which by the
 * time it reaches that fold. So this returns identity (which session, per
 * commit), and `assemble()` is what collapses repeats into a `Set`.
 *
 * Duration does NOT come from here. `sessions.duration_ms` is a raw
 * first-to-last-message span that overstates activity by a measured 7.6-26x;
 * `readSessionBuckets` is the source. This function answers identity only —
 * which sessions produced which commit.
 */
function readSessionAggregates(db: DashboardDbHandle): ReadonlyMap<string, ReadonlyArray<SessionRef>> {
	const out = new Map<string, SessionRef[]>();
	const rows = db
		.prepare(
			// `memory_transcripts` is many-to-many by design (one transcript is
			// shared across an amend chain; one memory can reference several), so a
			// plain join from it to `transcript_sessions` yields one row per
			// (transcript, session) pair — the same fan-out `MemoriesQuery.ts`'s
			// `buildActivity` hit on these exact tables ("two amends turned a real
			// `Read ×22` into `Read ×66`"). The inner DISTINCT collapses that down
			// to one row per (commit, session) — so a session referenced by two
			// transcripts of the SAME commit (an amend chain) still yields exactly
			// one row here. It does NOT collapse a session across two DIFFERENT
			// commits — that dedup is a JOURNEY-level concern, and this function
			// only ever sees one commit at a time, so it is `assemble()`'s job.
			//
			// `sessions` is unique on (repo_id, source, session_id), not
			// (repo_id, session_id) — the join must carry `source` too, or a
			// session sharing its bare id with one from another source joins to
			// the wrong (or an extra) row. `ts.source IS NOT NULL` matches
			// `buildActivity`'s guard: legacy `transcript_sessions` rows with no
			// recorded source cannot resolve to any `sessions` row, which is a
			// NOT NULL column there.
			`SELECT o.repo_identity AS repo_identity, o.commit_hash AS commit_hash,
			        o.source AS source, o.session_id AS session_id
			   FROM (SELECT DISTINCT mt.repo_id AS repo_id, r.repo_identity AS repo_identity,
			                mt.commit_hash AS commit_hash, ts.source AS source, ts.session_id AS session_id
			           FROM memory_transcripts mt
			           JOIN repos r ON r.id = mt.repo_id
			           JOIN transcript_sessions ts
			             ON ts.repo_id = mt.repo_id AND ts.transcript_id = mt.transcript_id
			            AND ts.source IS NOT NULL) o`,
		)
		.all() as ReadonlyArray<{
		repo_identity: string;
		commit_hash: string;
		source: string;
		session_id: string;
	}>;
	for (const row of rows) {
		const mapKey = commitMapKey(row.repo_identity, row.commit_hash);
		const list = out.get(mapKey);
		const ref: SessionRef = {
			key: `${row.source}${SESSION_KEY_SEP}${row.session_id}`,
			activityKey: sessionActivityKey(row.repo_identity, row.source, row.session_id),
		};
		if (list) list.push(ref);
		else out.set(mapKey, [ref]);
	}
	return out;
}

/** Accumulator for one journey while its commits are folded in. */
interface Accumulator {
	readonly id: string;
	readonly groupedBy: LocalJourney["groupedBy"];
	readonly ticket: string | null;
	readonly branch: string | null;
	readonly repoIdentity: string;
	readonly repoName: string;
	startedAtMs: number;
	endedAtMs: number;
	title: string;
	/**
	 * `commitTitle()` applied to every commit in the journey, including the one
	 * `title` was taken from. `title` alone is the NEWEST commit's title, and
	 * reading it as a claim about a whole multi-commit journey mislabels one —
	 * see `deriveJourneyShape`'s use of this array.
	 */
	readonly commitTitles: string[];
	commitCount: number;
	/**
	 * Every DISTINCT session key (`source\x00sessionId`) seen across this
	 * journey's commits so far — never a running count. A session that produced
	 * several commits in the same journey is one entry here regardless of how
	 * many of the journey's commits it touched; `sessionCount` in `toJourney()`
	 * is this set's SIZE, read once at the end. Accumulating a count instead (as
	 * this used to) double-, triple- or N-counted a session for every extra
	 * commit it produced — measured on a real database at up to 63x for one
	 * session, and 78% of sessions touch more than one commit, so this was not
	 * an edge case.
	 */
	readonly sessionKeys: Set<string>;
	turns: number | null;
	/**
	 * Every distinct fifteen-minute activity bucket seen across this journey's
	 * sessions so far — a UNION, never a sum. `journeyActivityMinutes` reads
	 * this set's size; see that function's doc comment for why an upper bound
	 * built this way needs no idle-gap threshold.
	 */
	readonly activityBuckets: Set<number>;
	costUsd: number | null;
	earliestPlanMs: number | null;
	decisions: JourneyDecision[];
	decisionCount: number;
	commits: LocalJourneyCommit[];
	allDecisions: JourneyDecision[];
}

/** What one window's worth of memories folds into — shared by the feed and the detail route. */
interface Assembled {
	readonly groups: ReadonlyMap<string, Accumulator>;
	/** Memories that fell in the window, before grouping — the feed's denominator. */
	readonly indexedCommits: number;
}

/**
 * Reads and groups every memory in `[fromMs, toMs)` into per-journey
 * accumulators. Shared by `buildJourneys` (the feed, which drops the two heavy
 * arrays below) and `buildJourneyDetail` (the trace modal, which needs them) —
 * a second copy of this walk would be a second place to keep the grouping rule
 * and the reachability filter in step.
 *
 * @param fromMs inclusive lower bound, epoch-ms
 * @param toMs   EXCLUSIVE upper bound, epoch-ms — matches `ResolvedWindow`
 */
function assemble(
	db: DashboardDbHandle,
	scope: DashboardScope,
	fromMs: number,
	toMs: number,
	reachable: ReachableCommits | undefined,
): Assembled {
	const resolved = scopeToRepoIds(db, scope);
	const filter = scopeFilter(resolved, "m.repo_id");
	const rows = db
		.prepare(
			`SELECT r.repo_identity, r.repo_name, m.commit_hash, m.branch, m.commit_message, m.ticket_id,
			        COALESCE(cm.committed_at_ms, m.commit_date_ms) AS committed_at_ms,
			        m.turns, m.est_cost_usd, m.summary_json
			   FROM memories m
			   JOIN repos r ON r.id = m.repo_id
			   LEFT JOIN commits cm ON cm.repo_id = m.repo_id AND cm.hash = m.commit_hash
			  -- parent_hash IS NULL: memories is a TREE (amend/squash/rebase file the
			  -- follow-up as a new root and re-parent the superseded version as a
			  -- child — see SotSchema.ts). Without this a plain row scan counts every
			  -- superseded revision as its own journey; RepositoriesQuery.ts measured
			  -- the same bug at ~2.5x inflation.
			  --
			  -- The window filter and ORDER BY both use the same COALESCE clock the
			  -- SELECT list computes: m.commit_date_ms is the AUTHOR date while
			  -- commits.committed_at_ms is the COMMITTER date (see MemoriesQuery.ts /
			  -- DashboardQuery.ts). Filtering on the raw author date while sorting and
			  -- grouping on the committer date let a rebased or cherry-picked commit
			  -- fall outside the window it was then reported as belonging to.
			  WHERE m.parent_hash IS NULL
			    AND COALESCE(cm.committed_at_ms, m.commit_date_ms) >= ?
			    AND COALESCE(cm.committed_at_ms, m.commit_date_ms) < ?${filter.sql}
			  ORDER BY committed_at_ms ASC`,
		)
		.all(fromMs, toMs, ...filter.params) as ReadonlyArray<MemoryRow>;

	// Reachability is checked in JS, not SQL — it comes from git. A rewritten
	// history leaves rows behind forever, and a journey assembled over them
	// reports work that no branch carries.
	const live = rows.filter((row) => isReachable(reachable, row.repo_identity, row.commit_hash));

	const inputs: JourneyCommitInput[] = live.map((row) => ({
		repoIdentity: row.repo_identity,
		commitHash: row.commit_hash,
		ticketId: row.ticket_id,
		commitMessage: row.commit_message,
		branch: row.branch,
	}));
	const keys = assignJourneyKeys(inputs);

	// Keyed by (repoIdentity, commitHash), so one unscoped read serves every
	// scope. Narrowing it would add a filter to a map lookup that already
	// misses for any commit outside `live`. An EMPTY window reads neither
	// table: the fold below never consults them, so paying two full-table
	// scans for a window that matched nothing (a hostile or stale explicit
	// window, e.g. entirely in the future) would be pure waste.
	const sessions = live.length === 0 ? new Map<string, SessionRef[]>() : readSessionAggregates(db);
	// Every session's activity buckets, unscoped for the same reason. This is
	// the ONLY duration source — see `readSessionBuckets`'s doc comment.
	const sessionBuckets = live.length === 0 ? new Map<string, Set<number>>() : readSessionBuckets(db);

	const groups = new Map<string, Accumulator>();
	for (const row of live) {
		const mapKey = commitMapKey(row.repo_identity, row.commit_hash);
		const key = keys.get(mapKey);
		if (!key) continue;
		const summary = parseSummary(row.summary_json);
		const sessionRefs = sessions.get(mapKey) ?? [];
		const existing = groups.get(key.key);
		const accumulator: Accumulator = existing ?? {
			id: key.key,
			groupedBy: key.groupedBy,
			ticket: key.ticket,
			branch: key.branch,
			repoIdentity: row.repo_identity,
			repoName: row.repo_name,
			startedAtMs: row.committed_at_ms,
			endedAtMs: row.committed_at_ms,
			title: commitTitle(row.commit_message),
			commitTitles: [],
			commitCount: 0,
			sessionKeys: new Set<string>(),
			turns: null,
			activityBuckets: new Set<number>(),
			costUsd: null,
			earliestPlanMs: null,
			decisions: [],
			decisionCount: 0,
			commits: [],
			allDecisions: [],
		};
		accumulator.commitCount += 1;
		accumulator.commitTitles.push(commitTitle(row.commit_message));
		accumulator.startedAtMs = Math.min(accumulator.startedAtMs, row.committed_at_ms);
		if (row.committed_at_ms >= accumulator.endedAtMs) {
			accumulator.endedAtMs = row.committed_at_ms;
			// The newest commit names the journey: it is the most recent
			// statement of what the work turned out to be.
			accumulator.title = commitTitle(row.commit_message);
		}
		// A session that produced several of this journey's commits is the SAME
		// session every time it recurs — count and sum it once, at first sight,
		// never again for a later commit that names it a second time.
		for (const ref of sessionRefs) {
			if (accumulator.sessionKeys.has(ref.key)) continue;
			accumulator.sessionKeys.add(ref.key);
			// Union, never sum: two sessions active in the same quarter-hour spent
			// one quarter-hour, and `Set.add` is what makes that true regardless of
			// how many sessions or commits reach this bucket.
			for (const bucket of sessionBuckets.get(ref.activityKey) ?? []) accumulator.activityBuckets.add(bucket);
		}
		if (row.turns !== null) accumulator.turns = (accumulator.turns ?? 0) + row.turns;
		if (row.est_cost_usd !== null) accumulator.costUsd = (accumulator.costUsd ?? 0) + row.est_cost_usd;
		accumulator.commits.push({
			commitHash: row.commit_hash,
			message: row.commit_message ?? "",
			committedAtMs: row.committed_at_ms,
			repoIdentity: row.repo_identity,
			repoName: row.repo_name,
		});
		const planMs = earliestPlanMs(summary);
		if (planMs !== null) {
			accumulator.earliestPlanMs =
				accumulator.earliestPlanMs === null ? planMs : Math.min(accumulator.earliestPlanMs, planMs);
		}
		for (const text of collectDecisions(summary)) {
			accumulator.decisionCount += 1;
			const decision: JourneyDecision = { text, commitHash: row.commit_hash };
			accumulator.allDecisions.push(decision);
			if (accumulator.decisions.length < FEED_DECISION_CAP) {
				accumulator.decisions.push(decision);
			}
		}
		groups.set(key.key, accumulator);
	}

	return { groups, indexedCommits: live.length };
}

/**
 * @param fromMs inclusive lower bound, epoch-ms
 * @param toMs   EXCLUSIVE upper bound, epoch-ms — matches `ResolvedWindow`
 */
/**
 * Below this many journeys with `availability.turns === "measured"`, the
 * featured section is withheld entirely rather than headlining a pick made
 * over one or zero real candidates.
 *
 * `frictionIndex` treats an unmeasured turns/duration pair as contributing
 * nothing, so on a window where almost nothing is measured every unmeasured
 * journey ties at friction 0 and `pickSmoothest`/`pickHardest`'s `reduce`
 * resolves that tie by array order — the FIRST (or only) journey wins, not
 * the smoothest or hardest one. A heading reading "Smoothest" / "Hardest"
 * over that pick states a verdict nothing was measured to support.
 */
const MIN_FEATURED_MEASURED_TURNS = 2;

export function buildJourneys(
	db: DashboardDbHandle,
	scope: DashboardScope,
	fromMs: number,
	toMs: number,
	reachable?: ReachableCommits,
	options?: { readonly withFriction?: boolean; readonly withTests?: boolean; readonly withWaits?: boolean },
): JourneysModel {
	const { groups, indexedCommits } = assemble(db, scope, fromMs, toMs, reachable);
	/* Per-journey turn signals are opt-in: only a caller that renders them pays
	   the transcript walk. Computed once per accumulator while `groups` is in
	   scope — and each journey's sessions are read ONCE even when both signals
	   are wanted — then spread onto each journey, since `LocalJourney` is
	   all-`readonly` and the field cannot be attached by mutation. The single
	   walk is shared with the roster's window-wide friction cell via
	   `buildCoachingWindow`, so a transcript referenced by two journeys
	   decompresses once per window, not once per journey. */
	const wantFriction = options?.withFriction ?? false;
	const wantTests = options?.withTests ?? false;
	const wantWaits = options?.withWaits ?? false;
	const signals =
		wantFriction || wantTests || wantWaits
			? collectWindowSignals(db, groups, wantFriction, wantTests, wantWaits)
			: undefined;
	return modelFromGroups(
		groups,
		indexedCommits,
		fromMs,
		toMs,
		signals?.frictionById,
		signals?.testedById,
		signals?.waitById,
	);
}

/**
 * One transcript walk over a window's groups, shared by every consumer that
 * pays the walk — the feed's per-journey friction/tests cells and the roster's
 * window-wide friction cell. The single {@link TranscriptCache} makes a
 * transcript decompress once per window no matter how many journeys reference
 * it; each derivation reads its own slice of the returned data.
 */
function collectWindowSignals(
	db: DashboardDbHandle,
	groups: ReadonlyMap<string, Accumulator>,
	wantFriction: boolean,
	wantTests: boolean,
	wantWaits: boolean,
): {
	readonly frictionById: ReadonlyMap<string, RosterCell>;
	readonly testedById: ReadonlyMap<string, JourneyTested>;
	readonly waitById: ReadonlyMap<string, number>;
	/** Every DISTINCT transcript of the window, parsed once. */
	readonly cache: TranscriptCache;
} {
	const frictionById = new Map<string, RosterCell>();
	const testedById = new Map<string, JourneyTested>();
	const waitById = new Map<string, number>();
	const cache: TranscriptCache = new Map();
	for (const [id, accumulator] of groups) {
		const sessions = readJourneySessions(db, accumulator, cache);
		if (wantFriction) frictionById.set(id, turnAbortsCell(deriveTurnAborts(sessions)));
		if (wantTests) testedById.set(id, deriveTested(sessions, accumulator.startedAtMs));
		if (wantWaits) {
			const waits = deriveWaits(sessions);
			waitById.set(
				id,
				waits.reduce((max, w) => Math.max(max, w.durationMinutes), 0),
			);
		}
	}
	return { frictionById, testedById, waitById, cache };
}

/** The shared model-assembly tail: journeys from already-grouped accumulators,
 *  with the optional per-journey turn signals spread on (a signal-bearing
 *  journey is a superset object, since `LocalJourney` is all-`readonly`). */
function modelFromGroups(
	groups: ReadonlyMap<string, Accumulator>,
	indexedCommits: number,
	fromMs: number,
	toMs: number,
	frictionById?: ReadonlyMap<string, RosterCell>,
	testedById?: ReadonlyMap<string, JourneyTested>,
	waitById?: ReadonlyMap<string, number>,
): JourneysModel {
	const journeys = Array.from(groups.values())
		.map((accumulator) => {
			const journey = toJourney(accumulator);
			const friction = frictionById?.get(accumulator.id);
			const tested = testedById?.get(accumulator.id);
			const longestWaitMinutes = waitById?.get(accumulator.id);
			if (friction === undefined && tested === undefined && longestWaitMinutes === undefined) return journey;
			return {
				...journey,
				...(friction !== undefined && { friction }),
				...(tested !== undefined && { tested }),
				...(longestWaitMinutes !== undefined && { longestWaitMinutes }),
			};
		})
		.sort((left, right) => right.endedAtMs - left.endedAtMs);
	const measuredTurnsCount = journeys.filter((journey) => journey.availability.turns === "measured").length;
	const canFeature = measuredTurnsCount >= MIN_FEATURED_MEASURED_TURNS;
	return {
		journeys,
		indexedCommits,
		smoothestId: canFeature ? (pickSmoothest(journeys)?.id ?? null) : null,
		hardestId: canFeature ? (pickHardest(journeys)?.id ?? null) : null,
		// Echoed back verbatim so a caller re-opening one of these journeys can
		// send the SAME bounds rather than re-resolving a window — see
		// `JourneysModel.windowStartMs`'s doc comment for why a second resolve
		// is the bug, not just a redundant one.
		windowStartMs: fromMs,
		windowEndMs: toMs,
	};
}

/**
 * One journey's full record — every commit and every decision, uncapped. The
 * feed (`buildJourneys`) caps `decisions` at {@link FEED_DECISION_CAP} and
 * carries no per-commit rows; this is what the trace modal reads instead of
 * shipping that weight on every page load.
 *
 * `window` is a plain `{startMs, endMs}` rather than `ResolvedWindow` on
 * purpose: the caller (the `/api/journey` route) resolves the SAME window the
 * feed used via `resolveWindow`, and this function only needs the two bounds
 * — taking the richer type would tempt a caller into recomputing labels it
 * has no use for.
 */
/** A shorter gap is reading/typing, not waiting. Local decision — no spec constant. */
const WAIT_THRESHOLD_MS = 5 * 60_000;

function parseEntryMs(entry: TranscriptEntry): number | undefined {
	if (!entry.timestamp) return undefined;
	const ms = Date.parse(entry.timestamp);
	return Number.isNaN(ms) ? undefined : ms;
}

/**
 * One window's parsed transcripts, keyed by `repoIdentity\x00transcriptId`.
 *
 * The repo prefix is load-bearing: a transcript id is unique only within its
 * repo (`transcripts` PK is `(repo_id, transcript_id)`), so in the default
 * multi-repo window two repos each holding a transcript "t1" would otherwise
 * alias — the second journey walked would read the first repo's parsed
 * sessions and inherit its friction/tests/wait signals. The key is built by
 * {@link transcriptCacheKey}.
 *
 * Decompression (inflate + JSON parse of the largest blobs the dashboard
 * stores) happens ONCE per transcript per window: every journey whose commits
 * reference the same transcript reads the SAME parsed sessions from the cache.
 * That is what lets the feed's per-journey cells and the roster's window-wide
 * friction cell share one walk without paying the inflate twice — while a
 * transcript genuinely shared by two journeys still counts as evidence for
 * BOTH (per-journey cells are derived from per-journey session lists, never
 * from a window-wide dedup).
 */
type TranscriptCache = Map<string, ReadonlyArray<StoredSession>>;

/** Cache/dedup key scoping a transcript id to its repo — see {@link TranscriptCache}. */
function transcriptCacheKey(repoIdentity: string, transcriptId: string): string {
	return `${repoIdentity}\x00${transcriptId}`;
}

/**
 * The journey's sessions, read on demand for the trace only — the feed never
 * pays this transcript walk. One transcript shared by several commits of an
 * amend chain contributes once (a per-journey `counted` set, never a
 * window-wide one — a session referenced by a DIFFERENT journey's commit is
 * evidence for that journey too), and a malformed blob is one unusable
 * transcript, never a failed trace. Shared by the waiting and attribution
 * derivations so the decompression happens exactly once per detail read.
 */
function readJourneySessions(db: DashboardDbHandle, accumulator: Accumulator, cache: TranscriptCache): StoredSession[] {
	const sessions: StoredSession[] = [];
	const counted = new Set<string>();
	for (const commit of accumulator.commits) {
		const blobs = db
			.prepare(
				`SELECT mt.transcript_id, t.sessions_blob
				   FROM memory_transcripts mt
				   JOIN repos r ON r.id = mt.repo_id
				   JOIN transcripts t ON t.repo_id = mt.repo_id AND t.transcript_id = mt.transcript_id
				  WHERE r.repo_identity = ? AND mt.commit_hash = ?`,
			)
			.all(accumulator.repoIdentity, commit.commitHash) as ReadonlyArray<{
			transcript_id: string;
			sessions_blob: Uint8Array;
		}>;
		for (const blob of blobs) {
			const key = transcriptCacheKey(accumulator.repoIdentity, blob.transcript_id);
			if (counted.has(key)) continue;
			counted.add(key);
			let parsed = cache.get(key);
			if (parsed === undefined) {
				parsed = [];
				try {
					const stored = JSON.parse(
						inflateSync(Buffer.from(blob.sessions_blob)).toString("utf8"),
					) as StoredTranscript;
					parsed = stored.sessions ?? [];
				} catch (err) {
					// A broken blob is parsed once per window, not once per reader.
					log.warn("transcript %s unreadable for the trace: %s", blob.transcript_id, errMsg(err));
				}
				cache.set(key, parsed);
			}
			sessions.push(...parsed);
		}
	}
	return sessions;
}

/**
 * Regroups a window's sessions into whole conversations before an adjacency
 * scan runs over them.
 *
 * A single `source:sessionId` is filed as one slice per commit of an amend
 * chain, so a gap that straddles a slice boundary — an assistant turn ending
 * one slice, the human reply opening the next — is invisible to a per-slice
 * walk. Mirrors `groupArchivedSessions`' rule (slices sorted by first known
 * timestamp, then flattened; a session's slices occupy disjoint time ranges),
 * but keeps only the merged entry stream, which is all a wait derivation needs.
 */
function mergeSessionSlices(sessions: ReadonlyArray<StoredSession>): ReadonlyArray<ReadonlyArray<TranscriptEntry>> {
	const byKey = new Map<string, TranscriptEntry[][]>();
	const order: string[] = [];
	for (const session of sessions) {
		const key = archivedSessionKey(session);
		let parts = byKey.get(key);
		if (parts === undefined) {
			parts = [];
			byKey.set(key, parts);
			order.push(key);
		}
		parts.push([...(session.entries ?? [])]);
	}
	return order.map((key) =>
		[...(byKey.get(key) as TranscriptEntry[][])]
			.sort((a, b) => {
				const ta = sliceStartTime(a);
				const tb = sliceStartTime(b);
				if (ta === undefined || tb === undefined) return 0;
				return ta - tb;
			})
			.flat(),
	);
}

/**
 * "Waiting on you" stretches: an assistant turn followed by a human turn whose
 * timestamps are far enough apart that the agent sat idle (§3.2 — the agent's
 * idleness is measured, the human's activity is not). Runs over
 * {@link mergeSessionSlices} so a wait spanning an amend chain's slice boundary
 * is not lost.
 */
function deriveWaits(sessions: ReadonlyArray<StoredSession>): ReadonlyArray<WaitPeriod> {
	const byKey = new Map<string, WaitPeriod>();
	for (const entries of mergeSessionSlices(sessions)) {
		for (let i = 0; i + 1 < entries.length; i++) {
			const left = entries[i];
			const right = entries[i + 1];
			if (left.role !== "assistant" || right.role !== "human") continue;
			const start = parseEntryMs(left);
			const end = parseEntryMs(right);
			if (start === undefined || end === undefined || end - start < WAIT_THRESHOLD_MS) continue;
			const wait: WaitPeriod = {
				startedAtMs: start,
				endedAtMs: end,
				durationMinutes: Math.round((end - start) / 60_000),
			};
			byKey.set(`${start}:${end}`, wait);
		}
	}
	return [...byKey.values()].sort((left, right) => left.startedAtMs - right.startedAtMs);
}

/**
 * The journey's recorded turns split by speaker — the honest, tractable half of
 * §5 step 4. Counts turns, never verdicts: it does not say who "drove" the work,
 * only how many recorded user and assistant messages there were.
 */
function deriveAttribution(sessions: ReadonlyArray<StoredSession>): TurnAttribution {
	let humanTurns = 0;
	let agentTurns = 0;
	for (const session of sessions) {
		for (const entry of session.entries ?? []) {
			if (entry.role === "human") humanTurns += 1;
			else if (entry.role === "assistant") agentTurns += 1;
		}
	}
	return { humanTurns, agentTurns };
}

/**
 * The journey's context-compaction instants, from `StoredSession.compactions`.
 *
 * Absent (`undefined`, a source whose transcript cannot record compactions) and
 * empty (`[]`, measured none) both contribute nothing, so the result is empty
 * rather than a false "0 compactions" — the same contract `waits` already has.
 * De-duplicated and sorted so two sessions sharing one instant (an amend chain
 * re-read) place one marker, not a pile of them.
 */
function deriveCompactions(sessions: ReadonlyArray<StoredSession>): ReadonlyArray<number> {
	const seen = new Set<number>();
	for (const session of sessions) {
		for (const atMs of session.compactions ?? []) seen.add(atMs);
	}
	return [...seen].sort((left, right) => left - right);
}

/**
 * Turn-abort friction across a set of sessions, presence-gated.
 *
 * `turnAborts` is Codex-only and forward-only, so absence is ambiguous: a
 * Claude session never has it (not a friction source), but a Codex session
 * written before the capture field existed also lacks it (a friction source we
 * could not measure). `StoredSession.source` is what tells them apart — a
 * Codex session without the field sets `sawUnmeasuredSource`, which pushes a
 * window straddling the capture boundary to `partial` rather than claiming a
 * complete (and possibly zero) count.
 */
function deriveTurnAborts(sessions: ReadonlyArray<StoredSession>): {
	readonly measured: boolean;
	readonly sawUnmeasuredSource: boolean;
	readonly count: number;
} {
	let measured = false;
	let sawUnmeasuredSource = false;
	// Distinct instants, not a sum of lengths: the same session can appear under
	// two transcripts of an amend chain, and its aborts are one event set, not
	// two — the same de-dup `deriveCompactions` applies for the same reason.
	const instants = new Set<number>();
	for (const session of sessions) {
		if (session.turnAborts !== undefined) {
			measured = true;
			for (const atMs of session.turnAborts) instants.add(atMs);
		} else if (session.source === "codex") {
			sawUnmeasuredSource = true;
		}
	}
	return { measured, sawUnmeasuredSource, count: instants.size };
}

/**
 * The journey's test-first verdict: whether any test run predates its first
 * commit, availability-gated the way friction is. `testRuns` is forward-only
 * and source-gated, so a journey with no reporting session is `unavailable`
 * (no verdict), and a Codex/Claude session without the field marks `partial`.
 * `testFirst: true` is positive evidence — a pre-commit run was SEEN — while
 * `false` means only "no positive evidence", which is why the pattern counts
 * only the true case.
 */
function deriveTested(sessions: ReadonlyArray<StoredSession>, startedAtMs: number): JourneyTested {
	let measured = false;
	let sawUnmeasuredSource = false;
	let earliest: number | undefined;
	for (const session of sessions) {
		if (session.testRuns !== undefined) {
			measured = true;
			for (const atMs of session.testRuns) {
				if (earliest === undefined || atMs < earliest) earliest = atMs;
			}
		} else if (session.source === "codex" || session.source === "claude") {
			sawUnmeasuredSource = true;
		}
	}
	if (!measured) return { availability: "unavailable" };
	return {
		availability: sawUnmeasuredSource ? "partial" : "measured",
		testFirst: earliest !== undefined && earliest < startedAtMs,
	};
}

/**
 * The SINGLE mapping from a turn-abort derivation to a friction cell, shared by
 * the roster's window aggregate and the feed's per-journey cell so the two can
 * never disagree about what `partial` means. `measured` only when at least one
 * session reported `turnAborts`; `partial` when that is true but an unmeasured
 * Codex session (predating the field) is also present.
 */
function turnAbortsCell(derived: {
	readonly measured: boolean;
	readonly sawUnmeasuredSource: boolean;
	readonly count: number;
}): RosterCell {
	if (derived.measured) {
		// `value` rides even the `partial` cell: the roster renders it as "—"
		// anyway, but the feed's `flagged` chip needs the positive-evidence count
		// to flag a journey whose measured subset showed an abort.
		return {
			availability: derived.sawUnmeasuredSource ? "partial" : "measured",
			value: derived.count,
		};
	}
	return { availability: "unavailable" };
}

/**
 * The coaching page's window build: the journeys model WITH its test-first,
 * per-journey friction and per-journey wait signals, plus the roster's
 * window-wide turn-abort friction cell, from ONE assemble and ONE transcript
 * walk.
 *
 * `buildCoaching` used to assemble the window three times — once for the model,
 * once for friction — and decompress the window's transcripts twice. The
 * {@link TranscriptCache} inside `collectWindowSignals` is what makes the
 * single walk serve both consumers: each transcript decompresses once, the
 * per-journey `friction`/`tested`/`longestWaitMinutes` cells read the
 * per-journey session lists, and the window-wide friction cell reads every
 * DISTINCT transcript once (flattening the cache is exactly
 * `readWindowSessions`'s window-scope dedup, without a second walk).
 */
export function buildCoachingWindow(
	db: DashboardDbHandle,
	scope: DashboardScope,
	fromMs: number,
	toMs: number,
	reachable?: ReachableCommits,
): { readonly model: JourneysModel; readonly friction: RosterCell } {
	const { groups, indexedCommits } = assemble(db, scope, fromMs, toMs, reachable);
	const { frictionById, testedById, waitById, cache } = collectWindowSignals(db, groups, true, true, true);
	const windowSessions: StoredSession[] = [];
	for (const parsed of cache.values()) windowSessions.push(...parsed);
	return {
		model: modelFromGroups(groups, indexedCommits, fromMs, toMs, frictionById, testedById, waitById),
		friction: turnAbortsCell(deriveTurnAborts(windowSessions)),
	};
}

export function buildJourneyDetail(
	db: DashboardDbHandle,
	scope: DashboardScope,
	window: { readonly startMs: number; readonly endMs: number },
	journeyId: string,
	reachable?: ReachableCommits,
): JourneyDetail | undefined {
	const { groups } = assemble(db, scope, window.startMs, window.endMs, reachable);
	const accumulator = groups.get(journeyId);
	if (!accumulator) return undefined;
	const sessions = readJourneySessions(db, accumulator, new Map());
	return {
		journey: toJourney(accumulator),
		commits: [...accumulator.commits].sort((left, right) => left.committedAtMs - right.committedAtMs),
		decisions: accumulator.allDecisions,
		waits: deriveWaits(sessions),
		attribution: deriveAttribution(sessions),
		compactions: deriveCompactions(sessions),
	};
}

/** A malformed body is one unusable memory, never a failed page. */
function parseSummary(json: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(json);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function collectDecisions(summary: Record<string, unknown>): ReadonlyArray<string> {
	const topics = summary.topics;
	if (!Array.isArray(topics)) return [];
	const out: string[] = [];
	for (const topic of topics) {
		if (typeof topic !== "object" || topic === null) continue;
		// The canonical splitter — same one the memory detail pane's Decisions
		// callout uses — so the two surfaces can never disagree about what one
		// commit's decisions were (it also strips `**` emphasis, which a private
		// copy here would not).
		const decisions = (topic as Record<string, unknown>).decisions;
		out.push(...splitDecisionBullets(typeof decisions === "string" ? decisions : undefined));
	}
	return out;
}

/** The earliest `addedAt` across this commit's plans, or null when it has none. */
function earliestPlanMs(summary: Record<string, unknown>): number | null {
	const plans = summary.plans;
	if (!Array.isArray(plans)) return null;
	let earliest: number | null = null;
	for (const plan of plans) {
		if (typeof plan !== "object" || plan === null) continue;
		const addedAt = (plan as Record<string, unknown>).addedAt;
		if (typeof addedAt !== "string") continue;
		const ms = Date.parse(addedAt);
		if (Number.isNaN(ms)) continue;
		earliest = earliest === null ? ms : Math.min(earliest, ms);
	}
	return earliest;
}

const availability = (value: number | null): FieldAvailability => (value === null ? "unavailable" : "measured");

function toJourney(accumulator: Accumulator): LocalJourney {
	// An empty bucket set means no session on this journey reported ANY
	// activity — no evidence, not measured-zero. Reporting 0 would claim an
	// instant journey, which is the exact failure the availability model exists
	// to prevent.
	const durationMinutes =
		accumulator.activityBuckets.size === 0 ? null : journeyActivityMinutes(accumulator.activityBuckets);
	// Plan-FIRST, literally: a plan that only appeared mid-journey is a plan,
	// but it is not what this label claims.
	const planFirst = accumulator.earliestPlanMs !== null && accumulator.earliestPlanMs < accumulator.startedAtMs;
	const shape = deriveJourneyShape({
		planFirst,
		durationMinutes,
		ticket: accumulator.ticket,
		title: accumulator.title,
		commitTitles: accumulator.commitTitles,
	});
	return {
		id: accumulator.id,
		groupedBy: accumulator.groupedBy,
		ticket: accumulator.ticket,
		branch: accumulator.branch,
		title: accumulator.title,
		repoIdentity: accumulator.repoIdentity,
		repoName: accumulator.repoName,
		startedAtMs: accumulator.startedAtMs,
		endedAtMs: accumulator.endedAtMs,
		commitCount: accumulator.commitCount,
		sessionCount: accumulator.sessionKeys.size,
		turns: accumulator.turns,
		durationMinutes,
		costUsd: accumulator.costUsd,
		planFirst,
		shape,
		decisions: accumulator.decisions,
		decisionCount: accumulator.decisionCount,
		availability: {
			duration: availability(durationMinutes),
			turns: availability(accumulator.turns),
			cost: availability(accumulator.costUsd),
			// Pinned. No turn-level signal, no wait signal and no PR number
			// reaches the local SoT — see the spec's §3.3. Kept as fields so a
			// future source is a population, not a redesign.
			frictionSignals: "unavailable",
			waitTiming: "unavailable",
			reviewTiming: "unavailable",
		},
	};
}
