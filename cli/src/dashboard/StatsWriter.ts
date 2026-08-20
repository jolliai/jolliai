/**
 * StatsWriter — the one way anything writes the dashboard database.
 *
 * Every producer goes through `apply()`: the CLI's QueueWorker and StopHook, the
 * VS Code extension tick, and the bootstrap/gap-recovery paths. They differ only
 * in which window of data they feed in; the reader → projection → aggregation
 * code is shared, so a fact imported by bootstrap and the same fact written live
 * by a hook land on the identical row.
 *
 * Writes never go through the HTTP service. The database is a file and is always
 * writable, so "the dashboard server was down and we lost data" is not a failure
 * mode that exists here.
 *
 * ## The two-transaction protocol
 *
 * `apply()` deliberately uses TWO transactions, and merging them would
 * reintroduce the bug they exist to prevent:
 *
 *   Tx1  insert the batch into `events_raw` as 'pending', then COMMIT.
 *   Tx2  project the pending rows into the typed tables, mark them 'projected',
 *        then COMMIT.
 *
 * Only because Tx1 has committed does a crash between the two leave anything to
 * recover: {@link drainPending} re-projects the leftovers on the next writer's
 * turn, idempotently. In a single transaction the crash would roll the pending
 * rows back together with the half-done projection and the events would be gone.
 *
 * ## Why nothing is aggregated on the write path
 *
 * Projection is an idempotent UPSERT that coexists with out-of-order updates,
 * pruning and replay, so a stored `agg += event.value` would double-count on
 * any replay and never converge after a delete. This module used to answer
 * that with re-derivation — recompute each touched aggregate with a
 * `SELECT SUM` over the detail rows in the same transaction — which was
 * correct but bought nothing: the readers all aggregate at read time straight
 * off the detail tables, so the one stored aggregate was maintained on every
 * projection and read by nothing. It is gone, and the invariant is now
 * structural rather than maintained: the detail rows are the only totals, so
 * they cannot disagree with a copy of themselves. A future aggregate has to
 * clear the same bar — a measured read that is genuinely too slow — and if one
 * lands, re-derive it, never increment it.
 */

import { execGit } from "../core/GitOps.js";
import { PRICES_AS_OF } from "../core/Pricing.js";
import { classifyScanError } from "../core/SqliteHelpers.js";
import { skillOutcomeConfidence } from "../core/skills/SkillOutcomeConfidence.js";
// import type { KnowledgeGraph } from "../graph/GraphSchema.js"; // parked with recordRepoGraph
import { createLogger, errMsg } from "../Logger.js";
import type { DashboardDbHandle } from "./DashboardDb.js";
import { BUSY_TIMEOUT_BY_ROLE, DEFAULT_BUSY_TIMEOUT_MS, inTransaction, withDashboardDb } from "./DashboardDb.js";
import {
	type CommitCreatedEvent,
	type CommitSummaryEvent,
	type ProducerKind,
	type RecallObservedEvent,
	type RepoDisabledEvent,
	type RepoEnabledEvent,
	type SessionUpsertedEvent,
	STATS_EVENT_SCHEMA_VERSION,
	type StatsEvent,
	type StatsEventEnvelope,
	sessionEventId,
	statsEventId,
	type WorktreeStatusEvent,
} from "./DashboardModel.js";
import { buildRollupQuietly, forgetRollupDays } from "./StatsRollup.js";

const log = createLogger("StatsWriter");

/** Give up on an event after this many failed projection attempts (poison pill). */
const MAX_PROJECTION_ATTEMPTS = 5;

/** Retry budget when another process holds the write lock for a whole apply. */
const APPLY_MAX_ATTEMPTS = 3;
const APPLY_BASE_DELAY_MS = 120;

/** How many pending rows one drain pass claims. Bounded to keep write locks short. */
const DRAIN_BATCH_SIZE = 500;

export interface ApplyOptions {
	readonly producerKind: ProducerKind;
	readonly producerVersion?: string;
	/** Injected clock for deterministic `received_at`. */
	readonly now?: () => number;
	/**
	 * Skip the rollup settle at the end of the call. For a caller that makes MANY
	 * `applyToDb` calls in a row and settles once itself.
	 *
	 * The default (settle every call) is right for the normal writer, which
	 * handles one commit's events and then goes away. It is quadratic for a
	 * backfill: each batch's writes mark the days it just touched stale, so the
	 * next batch rebuilds the same days, and a pass of hundreds of batches pays
	 * that repeatedly for a result only the last one keeps. Skipping is always
	 * SAFE — the cache is derived, and a day nobody settles is simply computed
	 * live — so the risk of this flag is a slower page, never a wrong number.
	 */
	readonly skipRollup?: boolean;
}

export interface ApplyResult {
	/** Rows written to `events_raw`. */
	readonly accepted: number;
	/** Rows successfully projected in this call, including drained leftovers. */
	readonly projected: number;
	/** Rows left pending — parked unknown types, or failures below the attempt cap. */
	readonly pending: number;
}

/**
 * Writes a batch of events and projects them.
 *
 * `db` must be a writable handle. Callers that do not already hold one should
 * use {@link applyStatsEvents}, which opens (and migrates) one for the call.
 */
export function applyToDb(
	db: DashboardDbHandle,
	envelopes: ReadonlyArray<StatsEventEnvelope>,
	opts: ApplyOptions,
): ApplyResult {
	const now = opts.now ?? Date.now;
	// Tx1 — durable write-ahead log. Must commit on its own.
	if (envelopes.length > 0) {
		inTransaction(db, () => {
			const insert = db.prepare(
				`INSERT INTO events_raw
				   (event_id, repo_identity, type, schema_version, producer_kind, producer_version,
				    occurred_at, received_at, data_json, projection_status)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
			);
			const receivedAt = new Date(now()).toISOString();
			for (const envelope of envelopes) {
				const event = envelope.event;
				insert.run(
					statsEventId(event),
					event.repoIdentity,
					event.type,
					STATS_EVENT_SCHEMA_VERSION,
					envelope.producerKind ?? opts.producerKind,
					envelope.producerVersion ?? opts.producerVersion ?? null,
					envelope.occurredAtMs ? new Date(envelope.occurredAtMs).toISOString() : null,
					receivedAt,
					JSON.stringify(event),
				);
			}
		});
	}

	// Tx2 — claim and project. Always runs, including for an empty batch: that is
	// how any writer picks up rows a crashed predecessor committed but never
	// projected. The batch just inserted is itself pending, so this is also what
	// projects it.
	// The repos this call speaks for, so `drainPending`'s pending tally answers
	// "is MY backlog clear?" rather than the machine's — see the note there.
	const pendingScope = [...new Set(envelopes.map((e) => e.event.repoIdentity))].filter(
		(id): id is string => typeof id === "string" && id.length > 0,
	);
	const drained = drainPending(db, { now, pendingScope });

	// Tx3+ — settle whatever days the projections just invalidated. After the
	// drain, not before: the rows this call wrote are exactly what makes a day
	// stale, and building first would cache the state we are about to leave.
	// Quietly, and on a budget: this is derived data on the writer's lock, and
	// the callers holding it (an editor's periodic scan among them) wait
	// milliseconds for it. Falling behind costs a slower page; holding the lock
	// costs someone else's write.
	//
	// A caller running many batches back to back opts out and settles once at the
	// end — see `skipRollup`.
	if (opts.skipRollup !== true) buildRollupQuietly(db, { now });

	return { accepted: envelopes.length, projected: drained.projected, pending: drained.pending };
}

/** Opens a writable handle for one batch and applies it. */
export async function applyStatsEvents(
	envelopes: ReadonlyArray<StatsEventEnvelope>,
	opts: ApplyOptions & { readonly dbPath?: string },
): Promise<ApplyResult> {
	const busyTimeoutMs = BUSY_TIMEOUT_BY_ROLE[opts.producerKind] ?? DEFAULT_BUSY_TIMEOUT_MS;

	// Retry the whole unit of work, not the transaction: here we can `await`, so
	// waiting costs no thread, whereas a retry inside the (synchronous) transaction
	// could only spin. Safe to repeat because every projection is an idempotent
	// UPSERT — a redo converges on the same rows rather than duplicating them.
	for (let attempt = 1; ; attempt++) {
		try {
			return await withDashboardDb(
				(db) => {
					const result = applyToDb(db, envelopes, opts);
					pruneProjectedEvents(db, opts.now ?? Date.now);
					return result;
				},
				{ ...(opts.dbPath ? { dbPath: opts.dbPath } : {}), busyTimeoutMs },
			);
		} catch (err) {
			if (classifyScanError(err)?.kind !== "locked" || attempt >= APPLY_MAX_ATTEMPTS) throw err;
			// Jittered so several surfaces that lost the same race do not wake up
			// together and collide again.
			const backoff = APPLY_BASE_DELAY_MS * 2 ** (attempt - 1);
			await new Promise((resolve) => setTimeout(resolve, backoff + Math.random() * backoff));
			log.debug("write lock busy, retrying apply (attempt %d)", attempt + 1);
		}
	}
}

interface PendingRow {
	readonly seq: number;
	readonly type: string;
	readonly schema_version: number;
	readonly data_json: string;
	readonly attempts: number;
}

/**
 * The parked rows a later build un-parks by itself, as a SQL predicate.
 *
 * ONE fragment shared by the two statements that must agree about it: {@link drainPending}
 * revives exactly these, and {@link countStuckEvents} must therefore not count them. A
 * second spelling of the predicate is how those two silently disagree — and the direction
 * they disagreed in was user-facing, since the count feeds a message that asserts data
 * loss. `type IN (…)` is filled from {@link KNOWN_EVENT_TYPES} by the caller.
 *
 * `COALESCE` rather than a bare `failed_kind = …`, and that is not defensive noise: the
 * column arrived in a MIGRATION, so every row parked by a build older than it reads NULL,
 * and `NULL = 'unknown-type'` is NULL rather than false. Inside {@link countStuckEvents}'s
 * `NOT (…)` that NULL propagates and `WHERE` discards the row — so exactly the rows
 * `drainPending` can never revive (NULL is not a reason it knows) were also the ones the
 * count could not see. Permanently stuck AND permanently invisible, which is the opposite
 * of what narrowing the count was for. Measured on four parked rows: 4 before the
 * narrowing, 2 after it, 3 correct.
 */
const REVIVABLE_PREDICATE = "projection_status = 'failed' AND COALESCE(failed_kind, '') = 'unknown-type'";

/**
 * Parked events this build cannot recover on its own — the number worth telling a user.
 *
 * NOT every `failed` row. `drainPending` un-parks `unknown-type` rows whose type this build
 * now understands on every writable open, so those are a version-skew artefact that heals
 * itself: an older CLI parked an event a newer VS Code build wrote, and upgrading the CLI
 * is the whole repair. Counting them made both readers assert something false — `jolli
 * doctor` printed "N event(s) parked unprojected — some conversations may be missing from
 * the dashboard", with no fixer to offer, for rows the next commit silently revives.
 *
 * Both readers go through a READ-ONLY handle, which is why the count has to do this
 * narrowing itself rather than draining first: a diagnostic must not write, and the daemon's
 * phase 1 is deliberately read-only. Counting through a writable handle so the drain runs
 * would make asking the question change the answer.
 *
 * Lives here rather than beside the schema helpers because the predicate it must agree with
 * lives here. Cheap for both callers: `ix_events_pending` leads with `projection_status`, so
 * this is an index scan.
 *
 * ## Why a missing column degrades instead of throwing
 *
 * `failed_kind` is added by a MIGRATION, and both callers hold a READ-ONLY handle, which by
 * contract never migrates — so on a database still at a pre-migration schema this statement
 * raises `no such column`. That is reachable on an ordinary upgrade: the daemon's re-scan
 * runs on a 30-second timer and can easily tick before the first commit gives the database
 * its first writable open. Left to throw it took the whole pass down (reported as
 * `database-unusable`, and the early return meant the writable phase that would have
 * migrated never ran), for a number that is one health metric among several.
 *
 * The fallback is not a guess. Before that migration nothing could be parked as
 * `unknown-type` — there was no column to record a reason in — so on such a schema every
 * `failed` row IS stuck, and the un-narrowed count is the exact answer rather than an
 * approximation of it. Narrowed to that one SQLite message so a genuine fault (corruption,
 * permissions) still surfaces rather than being counted around.
 */
export function countStuckEvents(db: DashboardDbHandle): number {
	const revivable = KNOWN_EVENT_TYPES.map(() => "?").join(", ");
	try {
		const row = db
			.prepare(
				`SELECT COUNT(*) AS n FROM events_raw
				  WHERE projection_status = 'failed'
				    AND NOT (${REVIVABLE_PREDICATE} AND type IN (${revivable}))`,
			)
			.get(...KNOWN_EVENT_TYPES) as { n: number };
		return row.n;
	} catch (err) {
		if (!/no such column: failed_kind/i.test(errMsg(err))) throw err;
		log.debug("failed_kind absent — counting every parked event on this pre-migration schema");
		const row = db.prepare("SELECT COUNT(*) AS n FROM events_raw WHERE projection_status = 'failed'").get() as {
			n: number;
		};
		return row.n;
	}
}

/**
 * Projects up to {@link DRAIN_BATCH_SIZE} pending rows.
 *
 * Each row is projected in its OWN transaction. That costs a few more commits
 * than one batch transaction, but it means a single malformed event cannot roll
 * back the hundreds of good rows beside it — which is precisely the scenario the
 * write-ahead log exists to survive.
 */
export function drainPending(
	db: DashboardDbHandle,
	opts: { readonly now?: () => number; readonly pendingScope?: ReadonlyArray<string> } = {},
): { projected: number; pending: number } {
	const now = opts.now ?? Date.now;
	// Future-schema rows are excluded from the CLAIM, not just skipped in the
	// loop below. Skipping alone makes them head-of-line blockers: the claim is
	// `ORDER BY seq LIMIT n`, so once n of them accumulate at the head (a newer
	// VS Code build writing beside an older CLI — supported version skew) an old
	// build can never reach its own newer pending rows, and its projections
	// stall silently until a new-build writer happens to drain. They still stay
	// `pending` and are still counted, so nothing is lost or guessed at.
	// Un-park what THIS build can now project. A row reaches `failed_kind =
	// 'unknown-type'` only via `projectEvent`'s default throw — an older build
	// draining a newer producer's event — and that comment promises the event
	// survives for a build that understands it. It did not: the claim below
	// selects `pending`, and nothing reset `failed`, so upgrading never
	// recovered it. Scoped to types this build knows and to that one reason, so
	// a genuinely defective event stays parked instead of burning its attempt
	// budget again on every drain.
	const revivable = KNOWN_EVENT_TYPES.map(() => "?").join(", ");
	db.prepare(
		`UPDATE events_raw SET projection_status = 'pending', attempts = 0, failed_kind = NULL
		  WHERE ${REVIVABLE_PREDICATE} AND type IN (${revivable})`,
	).run(...KNOWN_EVENT_TYPES);

	const rows = db
		.prepare(
			`SELECT seq, type, schema_version, data_json, attempts
			   FROM events_raw
			  WHERE projection_status = 'pending' AND attempts < ? AND schema_version <= ?
			  ORDER BY seq
			  LIMIT ?`,
		)
		.all(MAX_PROJECTION_ATTEMPTS, STATS_EVENT_SCHEMA_VERSION, DRAIN_BATCH_SIZE) as ReadonlyArray<PendingRow>;

	let projected = 0;
	for (const row of rows) {
		try {
			inTransaction(db, () => {
				const event = JSON.parse(row.data_json) as StatsEvent;
				db.prepare("UPDATE events_raw SET claimed_at_ms = ?, attempts = attempts + 1 WHERE seq = ?").run(
					now(),
					row.seq,
				);
				projectEvent(db, event, now());
				db.prepare("UPDATE events_raw SET projection_status = 'projected' WHERE seq = ?").run(row.seq);
			});
			projected++;
		} catch (err) {
			// A lock contention is NOT a defective event, and must not spend the
			// attempt budget: `BEGIN IMMEDIATE` raises `database is locked` once
			// `busy_timeout` runs out, and the tightest timeout of any producer is the
			// editor host's (deliberately, so the UI thread never stalls). Five lost
			// races — a bootstrap sweep, a rebase draining the queue — used to park a
			// perfectly good event at `failed` FOREVER: nothing in the codebase ever
			// resets that status, so its sessions, commits and usage samples were
			// gone from every KPI until the database was rebuilt.
			//
			// Left untouched rather than re-marked: the transaction rolled the claim
			// back, so the row is still `pending` with its original count, and the
			// next drain (this worker's chain-spawn, the editor's next tick) simply
			// tries again. A database that stays locked means nothing is progressing
			// anyway, so there is no queue to starve.
			if (classifyScanError(err)?.kind === "locked") {
				log.warn("event seq=%d (%s) deferred — database busy: %s", row.seq, row.type, errMsg(err));
				continue;
			}
			// The attempt counter was rolled back with the transaction, so bump it
			// outside one. Without this a permanently-failing row would be retried
			// forever and starve the rest of the queue.
			const attempts = row.attempts + 1;
			const status = attempts >= MAX_PROJECTION_ATTEMPTS ? "failed" : "pending";
			// The reason is recorded, not just the verdict: only an unknown TYPE is
			// recoverable by a later build (see the revival above).
			const kind = isUnknownTypeError(err) ? "unknown-type" : "error";
			db.prepare("UPDATE events_raw SET attempts = ?, projection_status = ?, failed_kind = ? WHERE seq = ?").run(
				attempts,
				status,
				status === "failed" ? kind : null,
				row.seq,
			);
			if (status === "failed") {
				log.error("event seq=%d (%s) failed %d times — parked: %s", row.seq, row.type, attempts, errMsg(err));
			} else {
				log.warn("event seq=%d (%s) projection failed, will retry: %s", row.seq, row.type, errMsg(err));
			}
		}
	}
	// Counted from the table, never accumulated. `pending` is what
	// `DbBackfill.applyBatches` consults before advancing the summaries cursor, so
	// it has to mean "events still unprojected" — the tally it replaces counted
	// only future-schema rows plus this pass's own failures, and said 0 while
	// everything the `LIMIT` did not reach was still waiting. One first tick on a
	// machine with more sessions than DRAIN_BATCH_SIZE was enough to report a
	// clean drain over hundreds of unprojected events.
	//
	// The two filters below are what keep "unprojected" from meaning
	// "unprojectABLE", and the caller's gate is `pending === 0` — so a row this
	// runtime can never claim is not a delay, it is a permanent cursor stall.
	//
	//  - `schema_version <= ?` mirrors the claim query above EXACTLY. A row
	//    written by a newer CLI is never selected for projection, so `attempts`
	//    stays 0 and it can never age out: without this the summaries cursor
	//    stops advancing forever (for every repo), and each pass re-collects the
	//    whole index from scratch. Any change to the claim predicate has to be
	//    made here too, or the gate silently stops matching what drains.
	//  - `repo_identity IN (…)` scopes the answer to the repos the caller is
	//    actually reporting on (`pendingScope`). `events_raw` is machine-global,
	//    so another repo's in-flight rows would otherwise hold back THIS repo's
	//    cursor. That kind is self-healing (the other repo drains, the next pass
	//    advances), which is why it is scoped rather than counted as an error.
	//    An empty scope means the caller has no repo to attribute this to, and
	//    the global count is then the honest answer.
	const scoped = (opts.pendingScope ?? []).filter((id) => id.length > 0);
	const remaining = (
		scoped.length > 0
			? db
					.prepare(
						`SELECT COUNT(*) AS n FROM events_raw
						  WHERE projection_status = 'pending' AND attempts < ? AND schema_version <= ?
						    AND repo_identity IN (${scoped.map(() => "?").join(",")})`,
					)
					.get(MAX_PROJECTION_ATTEMPTS, STATS_EVENT_SCHEMA_VERSION, ...scoped)
			: db
					.prepare(
						`SELECT COUNT(*) AS n FROM events_raw
						  WHERE projection_status = 'pending' AND attempts < ? AND schema_version <= ?`,
					)
					.get(MAX_PROJECTION_ATTEMPTS, STATS_EVENT_SCHEMA_VERSION)
	) as { n: number };
	return { projected, pending: remaining.n };
}

/**
 * Every event type {@link projectEvent} can dispatch — the revival's allowlist.
 *
 * `as const satisfies` rather than a plain `ReadonlyArray<StatsEvent["type"]>`
 * annotation, so {@link KnownEventTypesAreExhaustive} below can see the literals.
 * The annotation widened every element to the full union, which made that check
 * vacuously true.
 */
const KNOWN_EVENT_TYPES = [
	"repo.enabled",
	"repo.disabled",
	"session.upserted",
	"commit.created",
	"commit.summary",
	"worktree.status",
	"recall.observed",
] as const satisfies ReadonlyArray<StatsEvent["type"]>;

/**
 * Compile error the day a member of `StatsEvent["type"]` is missing from
 * {@link KNOWN_EVENT_TYPES} — the mirror of the `never` assignment in
 * {@link projectEvent}'s `default` arm.
 *
 * The two together are what keep the list and the switch in lockstep: the switch
 * cannot fall behind `StatsEvent` (that arm), and the list cannot fall behind it
 * either (this one), so neither can drift from the other. Only the switch was
 * guarded before, and the asymmetry was silent by construction — a type missing
 * from the list is not an error anywhere, it just means `reviveStuckEvents` never
 * offers that type a second attempt, so a transient failure becomes permanent for
 * that one kind of event and nothing says so.
 *
 * On a mismatch the error names the missing member rather than reading
 * `true is not assignable to never`.
 */
type MissingEventType = Exclude<StatsEvent["type"], (typeof KNOWN_EVENT_TYPES)[number]>;
const KnownEventTypesAreExhaustive: [MissingEventType] extends [never]
	? true
	: ["KNOWN_EVENT_TYPES is missing", MissingEventType] = true;
void KnownEventTypesAreExhaustive;

const UNKNOWN_TYPE_MARKER = "StatsWriter: no projection for event type";

function isUnknownTypeError(err: unknown): boolean {
	return err instanceof Error && err.message.startsWith(UNKNOWN_TYPE_MARKER);
}

/**
 * Dispatches one event to its projection. Must run inside a transaction.
 *
 * `nowMs` is the wall clock for the per-row sync stamps (see `SYNC_STAMP_DDL`)
 * and for the one projection that stamps a row with wall-clock
 * (`session_activity.recorded_at_ms`). It is read once per drained row and
 * threaded rather than read from `Date.now` inside each projection, so tests can
 * pin it, and so it is visibly NOT one of the event's own business timestamps —
 * writing `event.updatedAtMs` into a stamp would quietly turn it into a second
 * business clock and defeat the column's only purpose.
 */
function projectEvent(db: DashboardDbHandle, event: StatsEvent, nowMs: number): void {
	switch (event.type) {
		case "repo.enabled":
			projectRepoEnabled(db, event);
			return;
		case "repo.disabled":
			projectRepoDisabled(db, event);
			return;
		case "session.upserted":
			projectSession(db, event, nowMs);
			return;
		case "commit.created":
			projectCommit(db, event, nowMs);
			return;
		case "commit.summary":
			projectCommitSummary(db, event, nowMs);
			return;
		case "worktree.status":
			projectWorktree(db, event);
			return;
		case "recall.observed":
			projectRecallObserved(db, event, nowMs);
			return;
		default: {
			// Two guarantees, both needed.
			//
			// The `never` assignment is a COMPILE error the day a member is added to
			// `StatsEvent` without a projection here — the silent fall-through this
			// replaces marked such an event `projected` and `pruneProjectedEvents`
			// deleted it 14 days later, which is precisely the version-skew loss the
			// WAL + deferred-claim design exists to prevent (`schema_version` gates
			// payload CHANGES; it cannot gate a new type).
			//
			// The throw is the RUNTIME backstop for the case the compiler cannot see:
			// an older build draining a newer producer's event. Throwing routes the row
			// through the attempt counter to `failed`, which is retained forever and
			// logged loudly — the event survives for a build that understands it.
			const unknown: never = event;
			throw new Error(`${UNKNOWN_TYPE_MARKER} ${(unknown as StatsEvent).type}`);
		}
	}
}

function projectRepoEnabled(db: DashboardDbHandle, event: RepoEnabledEvent): void {
	db.prepare(
		`INSERT INTO repos (repo_identity, repo_name, worktree_root, remote_url, enabled_at, disabled_at)
		 VALUES (?, ?, ?, ?, ?, NULL)
		 ON CONFLICT(repo_identity) DO UPDATE SET
		   repo_name     = excluded.repo_name,
		   worktree_root = excluded.worktree_root,
		   remote_url    = excluded.remote_url,
		   disabled_at   = NULL`,
	).run(event.repoIdentity, event.repoName, event.worktreeRoot, event.remoteUrl ?? null, event.enabledAt);
}

function projectRepoDisabled(db: DashboardDbHandle, event: RepoDisabledEvent): void {
	db.prepare("UPDATE repos SET disabled_at = ? WHERE repo_identity = ?").run(event.disabledAt, event.repoIdentity);
}

/**
 * Ensures a `repos` row exists before a child row references it.
 *
 * Foreign keys are ON, so a session or commit for an unregistered repo would
 * otherwise fail the whole projection. That happens legitimately: a hook can
 * write before `jolli enable` has projected the registry, and event order across
 * independent producers is not guaranteed. A placeholder row keeps the data and
 * lets the registry projection fill in the real name and path later.
 */
function ensureRepoRow(db: DashboardDbHandle, repoIdentity: string): number {
	db.prepare(
		`INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at)
		 VALUES (?, ?, '', ?)
		 ON CONFLICT(repo_identity) DO NOTHING`,
	).run(repoIdentity, repoIdentity, new Date(0).toISOString());
	// The insert above guarantees the row, so this cannot miss.
	return resolveRepoId(db, repoIdentity) as number;
}

/**
 * Resolves a repo identity to its surrogate key.
 *
 * Deliberately not cached: this is a lookup on a UNIQUE index, and a process-wide
 * cache keyed on identity alone would hand one database's id to another — which
 * is a real case here, not a hypothetical, because every test opens its own file.
 * The caching the plan calls for is for `repo_identity` itself, whose derivation
 * costs a git subprocess.
 */
function resolveCommitId(db: DashboardDbHandle, eventId: string): number {
	const row = db.prepare("SELECT id FROM commits WHERE event_id = ?").get(eventId) as { id: number } | undefined;
	if (!row) throw new Error(`no commits row for ${eventId}`);
	return row.id;
}

/**
 * Interns a branch name for a repo and returns its id.
 *
 * The dictionary is what took commit_branches from 30.19 MiB to 2.04 MiB on real
 * data: 87 distinct names were being repeated across 102,767 rows.
 */
function resolveBranchId(db: DashboardDbHandle, repoId: number, name: string): number {
	db.prepare("INSERT INTO branches (repo_id, name) VALUES (?, ?) ON CONFLICT(repo_id, name) DO NOTHING").run(
		repoId,
		name,
	);
	return (db.prepare("SELECT id FROM branches WHERE repo_id = ? AND name = ?").get(repoId, name) as { id: number })
		.id;
}

function resolveRepoId(db: DashboardDbHandle, repoIdentity: string): number | null {
	const row = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(repoIdentity) as
		| { id: number }
		| undefined;
	// Null rather than throwing: an absent repo must not turn into a failed
	// projection, which the projection loop would treat as a poisoned event and
	// retry to the attempt cap.
	return row?.id ?? null;
}

/**
 * The per-model split's insert, shared by the two paths that write one.
 *
 * ## Why the conflict clause is not optional
 *
 * Both callers DELETE this session's split before inserting, so the only way to reach
 * `ON CONFLICT` is two entries naming the SAME model inside ONE event — two segments
 * of one model, which sum. Without the clause that is an unhandled UNIQUE violation
 * on `(session_event_id, model)`, and the consequences are out of all proportion to
 * the typo that causes it: the projection throws, the event burns its five attempts
 * and parks as `failed`, and because the collision is derived from the transcript's
 * own content it reproduces identically on every re-read. A parked `session.upserted`
 * is invisible in every direction — no `sessions` row, no reader, and (until
 * {@link countStuckEvents}) no count anywhere.
 *
 * The sibling insert into `session_tool_use` has carried a conflict clause all along;
 * this one was the odd one out, in both places.
 *
 * NULL means "unpriced", not zero, which is why the cost arm is a CASE rather than a
 * pair of COALESCEs: summing two unpriced segments as `0 + 0` would store a priced
 * 0.00, and every downstream reader treats that as a real answer rather than a
 * missing one.
 *
 * A MIXED pair — one segment priced, the other not — is NULL for the same reason, and
 * that is a deliberate loss of the known half. `COALESCE(…, 0) + COALESCE(…, 0)` would
 * store a confident total covering tokens that were never priced, and this schema has no
 * way to say "at least this much" (the lower-bound signal exists only on the TS side, as
 * the unpriced-model set). Between an understated definite number and an honest unknown,
 * the column's own contract picks the unknown.
 *
 * The mixed case is not reachable today: both rows always come from ONE event's `models`
 * array (each caller DELETEs the split first), and pricing is resolved per model id from
 * one `Pricing.ts` table, so two segments of the same model are priced the same way or not
 * at all. Written explicitly anyway — the arm that used to cover it silently summed.
 */
const MODEL_USAGE_UPSERT = `INSERT INTO session_model_usage
   (session_event_id, model, input_tokens, output_tokens, cached_tokens, est_cost_usd,
    updated_at_ms)
 VALUES (?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(session_event_id, model) DO UPDATE SET
   -- The stamp must be in THIS branch too: a conflict is still a write, and a sync
   -- keyed on it would otherwise never see the summed segment.
   updated_at_ms = excluded.updated_at_ms,
   input_tokens  = session_model_usage.input_tokens  + excluded.input_tokens,
   output_tokens = session_model_usage.output_tokens + excluded.output_tokens,
   cached_tokens = session_model_usage.cached_tokens + excluded.cached_tokens,
   est_cost_usd  = CASE
     WHEN session_model_usage.est_cost_usd IS NULL OR excluded.est_cost_usd IS NULL THEN NULL
     ELSE session_model_usage.est_cost_usd + excluded.est_cost_usd
   END`;

function projectSession(db: DashboardDbHandle, event: SessionUpsertedEvent, nowMs: number): void {
	const eventId = statsEventId(event);

	// Monotonic guard, and it runs before `ensureRepoRow` because it is the cheapest
	// thing here and a skipped event has no business creating a repos row.
	//
	// `updated_at_ms` below is ASSIGNED, not MAX'd, so an event describing an OLDER
	// version of this session moves the row BACKWARDS — and takes the model split and
	// the tool set with it, since both are replace-wholesale.
	//
	// That is reachable because insertion order is not observation order. Four
	// independent processes emit for the same session (the Stop hook, the VS Code 60 s
	// tick, `jolli dashboard`, the global daemon's re-scan), each reads, then collects,
	// then writes, and their collect phases differ in length — so a producer that
	// observed an older version can still write later, and the drain claims by `seq`.
	// It self-heals on the next pass (the file's mtime exceeds the rolled-back value,
	// so the session is re-read), which is exactly why it has never been noticed: the
	// row just serves stale tokens and a stale tool set until then, silently.
	//
	// STRICTLY greater, never `>=`. An equal instant is a re-read of the SAME version,
	// and a re-read at an unchanged mtime is precisely how a fixed parser or a bumped
	// `SESSION_READ_GENERATION` heals a row that was projected from less — dropping it
	// would turn both of those mechanisms into no-ops for every file that has not moved
	// since. Re-projecting costs one idempotent UPSERT and cannot lose anything.
	//
	// ## And it compares only against a row THIS function produced
	//
	// `updated_at_ms` does not mean the same thing in every row, so the guard is only
	// meaningful between two rows of the same provenance. `projectCommitSummary` seeds a
	// `sessions` row for a session the memory pipeline is the only record of, and stamps
	// it with the COMMIT's instant — which its own comment notes is "later than the
	// conversation's last turn". That value is therefore routinely AHEAD of any instant a
	// transcript read will ever report: measured on one real machine, 42 of 56 stored
	// `commit.summary` session links carry `committedAtMs` greater than the session's own
	// `updated_at_ms`.
	//
	// Comparing against such a row inverts this guard into the data loss it exists to
	// prevent, and permanently. `dbBackfillRepo` applies its summaries tier BEFORE its
	// sessions tier inside one handle, so on a fresh import the seed always lands first;
	// the session's real event then arrives with the older transcript instant and is
	// dropped whole — no title, no `started_at_ms`, no `duration_ms`, no message count,
	// no model split, no tool rows — while `applyToDb` records it as successfully
	// projected. Nothing recovers it either: `readKnownSessions` counts only
	// `started_at_ms`/`duration_ms` as a read receipt, so the stub never becomes one, and
	// every later pass re-reads the transcript and drops it again.
	//
	// The provenance test is `started_at_ms` / `duration_ms` — `readKnownSessions`' pair,
	// deliberately the SAME predicate, because it turns out to be the same question.
	//
	// The question is not "who wrote this row" but "is `prior.updated_at_ms` a
	// TRANSCRIPT-DERIVED high-water mark, so that a lower instant is describing an older
	// version of the same content". Only a SUCCESSFUL read produces one, and two kinds of
	// row fail that:
	//
	//   1. `projectCommitSummary`'s seed — the case above.
	//   2. A FAILED read, which is this same function. `sessionEventFromInfo` resolves the
	//      title BEFORE it opens the transcript and still returns a base event when the
	//      read throws, so a row can carry `{title, updated_at_ms}` and nothing else — and
	//      that instant came from `sessions.json` (the last turn plus the hook's delay),
	//      not from any transcript. It therefore sits AHEAD of what a later disk scan
	//      reports, in exactly the way the commit seed's instant does.
	//
	// `title` used to be on this list, reasoning that the seed cannot write one so its
	// presence proves this function did. Both halves are true and neither is the question:
	// (2) is this function writing a row whose instant is not comparable. Claude's Stop
	// hook is `async: true` and races the agent's own append, so a locked or half-written
	// transcript is an ordinary event, not an exotic one; 48 h later `pruneStale` drops the
	// registry row and the 7-day back-fill sees only the disk copy, whose mtime is EARLIER.
	// `readKnownSessions` correctly refuses the stub as a receipt, so the transcript really
	// is re-read — and the whole payload (message count, duration, model split, tool rows,
	// skills) was then dropped here while `applyToDb` recorded the event as projected, and
	// dropped again on every later pass, since the stub never becomes a receipt either.
	// That also silently voided `SESSION_READ_GENERATION`: a bump correctly forces the
	// un-skipped re-read, which landed here and was discarded.
	//
	// What narrowing gives up is protection for a title-only row, whose `updated_at_ms` an
	// older event can now rewind. That is the right way round — such a row holds no
	// transcript-derived fact to lose — and it is the same call already made for the other
	// unguarded residue: a read that SUCCEEDED on a transcript with no entries and no
	// first user message, so neither column is set.
	// ── DELIBERATE — NOT A REVIEW FINDING ──────────────────────────────────────────
	// **The provenance test below cannot tell a REGISTRY-derived instant from a
	// TRANSCRIPT-derived one, so for one class of row this guard drops the very re-read a
	// `SESSION_READ_GENERATION` bump deliberately forced.** That is real, it is measured,
	// and it is DEFERRED to its own change — do not re-raise it as a defect.
	//
	// ## Why the test misses it
	//
	// The question the test wants answered is "is `prior.updated_at_ms` a
	// transcript-derived high-water mark". `started_at_ms`/`duration_ms` stand in for it,
	// on the reasoning that only a successful read produces them. Claude's Stop hook
	// produces them too — it reads the transcript in full — while its `updatedAtMs` comes
	// from `sessions.json`, which `StopHook` stamps with `new Date()` BEFORE it reads. So a
	// hook-written row carries transcript-derived columns and a WALL-CLOCK instant, and
	// that instant is necessarily `last turn + δ` with δ > 0, because the Stop hook fires
	// after the agent has stopped. Any later disk read of the same unchanged file reports
	// the last turn itself, so `prior > event` holds for EVERY hook-written Claude/Gemini
	// row on every forced re-read, permanently. δ need not be seconds: the comparison is
	// strictly greater, so any δ at all is enough.
	//
	// The `>` rather than `>=` below was chosen precisely to let a same-version re-read
	// through. For these rows the two numbers are never equal, so that channel has never
	// once opened.
	//
	// ## What it costs — and why it is NOT "data loss on every run"
	//
	// Nothing at all on the overwhelming majority of passes. The upstream read gate
	// (`alreadyCurrentFrom`: stored >= discovered) skips these sessions outright, so the
	// only thing that ever reaches this guard for one of them is a generation bump — and a
	// bump has something to add only when an EXTRACTOR improved. What is broken is the
	// repair CHANNEL, not the steady state.
	//
	// Measured against the bump that shipped alongside this comment (3 → 4): the extractor
	// that changed is `CodexSkillScanner`, and Codex has NO hook — its stored instant and
	// its re-read are both the file's mtime, so an unchanged file compares EQUAL and passes.
	// The rows that needed healing were healed. `scanClaudeSkillLines` did not change, so
	// no Claude row needed healing. This release loses nothing. The next release that
	// improves extraction for a hook-backed source will, and silently.
	//
	// One case needs no upgrade at all: `extractSessionSignals` catches each extractor
	// independently — by design, because they read other applications' live files — so a
	// hook run whose skill scan threw while its tool scan succeeded writes a row that LOOKS
	// like a complete read (both columns set) and can never be repaired here. Low
	// frequency, one warn line at the time, no repair path afterwards.
	//
	// ## The fix, and why it is not folded in here
	//
	// The two instants have to stop sharing one column: record the transcript's own
	// FINAL-ENTRY timestamp ("which version of the content is this event describing")
	// beside `updated_at_ms` ("when was this session last active"), and compare only that.
	// Both producers read the same file, so they agree on it exactly — a hook row and a
	// disk re-read of an unchanged file then land on EQUAL and pass, while a genuinely
	// older read still lands below and is still dropped.
	//
	// That is a permanent schema commitment (`MIGRATIONS` names are forever, DDL freezes on
	// release) for a LATENT defect. It is also the same class of problem, and the same
	// trade, that `TranscriptSkillDiscovery`'s own DELIBERATE block documents and declines
	// on the skills-registry side: a mark that records a POSITION and not the logic that
	// read it. Treat it as a scoped migration with a measured re-scan budget, not as a bug
	// fix folded into unrelated work.
	//
	// ## Two shortcuts that look like the fix and are worse than the defect
	//
	// Do NOT narrow `>` to `>=`, and do NOT simply delete the early return. This guard also
	// stops an out-of-order producer's OLDER payload from overwriting the model split and
	// the tool set, both of which are replace-wholesale. Letting one through while
	// `updated_at_ms` keeps the newer value (an obvious-looking `max()`) leaves the row
	// asserting it is current while holding stale content — and the read gate believes that
	// assertion, so nothing re-reads it and it never heals. Today's drop keeps the row's
	// instant and its content consistent with each other, which is what makes the
	// pre-guard behaviour's self-healing property recoverable at all.
	// ───────────────────────────────────────────────────────────────────────────────
	//
	// ONE read of the row, serving both this guard and the token carry-forward below.
	// They asked the same primary key twice, which on the 30-second re-scan path is two
	// lookups per session per tick for one row. The cost of merging is that the
	// carry-forward's five columns are now fetched even when `hasUsage` makes them
	// unnecessary — cheaper than a second `get()`, since both are index lookups of the
	// same page and only the column decode differs.
	const prior = db
		.prepare(
			`SELECT updated_at_ms, started_at_ms, duration_ms,
			        input_tokens, output_tokens, cached_tokens, est_cost_usd, token_coverage
			   FROM sessions WHERE event_id = ?`,
		)
		.get(eventId) as
		| {
				updated_at_ms: number;
				started_at_ms: number | null;
				duration_ms: number | null;
				input_tokens: number;
				output_tokens: number;
				cached_tokens: number;
				est_cost_usd: number | null;
				token_coverage: string;
		  }
		| undefined;
	if (prior !== undefined && (prior.started_at_ms !== null || prior.duration_ms !== null)) {
		if (prior.updated_at_ms > event.updatedAtMs) return;
	}

	// A session's OWN bucketing instant on the session-level axes is
	// `updated_at_ms`, so when it moves to a new day the session's contribution
	// moves with it — and the staleness scan only ever notices the DESTINATION
	// day (the day the row now sits on, carrying the fresh write stamp). Left
	// alone, the SOURCE day stays cached and overstated for good, because an old
	// day gets no further writes to rebuild it. Forget the source day before the
	// move. This is the session-level counterpart to the per-response day-forget
	// below (which is Claude-only); every source is placed on the session axes by
	// this instant, so this must not be gated on `usageEvents`.
	if (prior !== undefined && prior.updated_at_ms !== event.updatedAtMs) {
		forgetRollupDays(db, [prior.updated_at_ms]);
	}

	const repoId = ensureRepoRow(db, event.repoIdentity);
	const models = event.models ?? [];
	// An event that carries NO usage information at all (no model split, no
	// scalar token fields) means "tokens unobserved this time", not "zero" —
	// e.g. a live producer whose transcript read failed. Writing zeros would
	// clobber a previously enriched row, so carry the existing values forward.
	const hasUsage =
		models.length > 0 || event.inputTokens != null || event.outputTokens != null || event.cachedTokens != null;
	// Still gated on `hasUsage`, so the fallbacks below read `undefined` exactly when they
	// did before — the merge changed where the row is read, never when it is consulted.
	const existing = hasUsage ? undefined : prior;
	// Token totals come from the per-model split when it is present, so the
	// scalar columns can never disagree with `session_model_usage`. Only when a
	// source exposes no per-model breakdown do the event's own scalars apply.
	const input =
		models.length > 0 ? sum(models, (m) => m.inputTokens) : (event.inputTokens ?? existing?.input_tokens ?? 0);
	const output =
		models.length > 0 ? sum(models, (m) => m.outputTokens) : (event.outputTokens ?? existing?.output_tokens ?? 0);
	const cached =
		models.length > 0 ? sum(models, (m) => m.cachedTokens) : (event.cachedTokens ?? existing?.cached_tokens ?? 0);
	const cost = models.some((m) => m.estCostUsd != null)
		? sum(models, (m) => m.estCostUsd ?? 0)
		: (event.estCostUsd ?? existing?.est_cost_usd ?? null);
	// Display model = the one that burned the most tokens. `session_model_usage`
	// stays authoritative; this is only so a row can be labelled without a join.
	const primaryModel = [...models].sort(
		(a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
	)[0]?.model;

	db.prepare(
		`INSERT INTO sessions
		   (event_id, repo_id, source, session_id, title, started_at_ms,
		    updated_at_ms, message_count, duration_ms, model,
		    input_tokens, output_tokens, cached_tokens, est_cost_usd, token_coverage, prices_as_of,
		    written_at_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(event_id) DO UPDATE SET
		   -- Unconditional, and NOT a COALESCE: the stamp means "we wrote this row",
		   -- so anything that preserves an older value defeats it.
		   written_at_ms  = excluded.written_at_ms,
		   title          = COALESCE(excluded.title, sessions.title),
		   started_at_ms  = COALESCE(excluded.started_at_ms, sessions.started_at_ms),
		   updated_at_ms  = excluded.updated_at_ms,
		   message_count  = COALESCE(excluded.message_count, sessions.message_count),
		   duration_ms    = COALESCE(excluded.duration_ms, sessions.duration_ms),
		   model          = COALESCE(excluded.model, sessions.model),
		   input_tokens   = excluded.input_tokens,
		   output_tokens  = excluded.output_tokens,
		   cached_tokens  = excluded.cached_tokens,
		   est_cost_usd   = COALESCE(excluded.est_cost_usd, sessions.est_cost_usd),
		   token_coverage = excluded.token_coverage,
		   prices_as_of   = COALESCE(excluded.prices_as_of, sessions.prices_as_of)`,
	).run(
		eventId,
		repoId,
		event.source,
		event.sessionId,
		event.title ?? null,
		event.startedAtMs ?? null,
		event.updatedAtMs,
		event.messageCount ?? null,
		event.durationMs ?? null,
		primaryModel ?? null,
		input,
		output,
		cached,
		cost,
		event.tokenCoverage ?? existing?.token_coverage ?? "sessions-only",
		event.pricesAsOf ?? null,
		nowMs,
	);

	// Per-response rows, replaced wholesale on the same terms as the model split
	// below. The producer re-reads the WHOLE transcript, so what arrives is the
	// complete set — and a complete set can shrink: agents compact and rewrite
	// their transcripts, so responses recorded earlier can stop existing. Upsert
	// alone would keep those forever, with nothing to notice them.
	//
	// Only when the producer actually SAW per-response usage —
	// `undefined` means "this source cannot report it" (today, everything but
	// Claude) and must leave what a capable read collected alone.
	//
	// This is the only table that can place a conversation's spend on the days it
	// actually spanned; `sessions` and `session_model_usage` are totals derived
	// from the same numbers, kept because a KPI should not pay for a GROUP BY.
	if (event.usageEvents !== undefined) {
		// A response that stops existing takes its day's cached total with it, and
		// leaves no write stamp for the rollup to notice — the replacement rows
		// only expire the days that still have responses. Read the old days before
		// emptying the set, and forget them; a day that kept its rows is rebuilt
		// anyway, so over-forgetting here costs one recomputation and never a
		// wrong number.
		const previousDays = db
			.prepare("SELECT DISTINCT responded_at_ms FROM session_usage_events WHERE session_event_id = ?")
			.all(eventId) as ReadonlyArray<{ responded_at_ms: number }>;
		forgetRollupDays(
			db,
			previousDays.map((row) => row.responded_at_ms),
		);
		db.prepare("DELETE FROM session_usage_events WHERE session_event_id = ?").run(eventId);
		// Plain INSERT, no ON CONFLICT: the DELETE above just emptied this session's
		// rows, and the producer cannot hand us the same key twice — the reader
		// dedupes on the response id, and the fallback key below is an index. A
		// conflict here would mean one of those two invariants broke, and throwing
		// says so instead of quietly merging.
		const insertUsage = db.prepare(
			`INSERT INTO session_usage_events
			   (session_event_id, dedup_key, responded_at_ms, model, input_tokens, output_tokens, cached_tokens,
			    est_cost_usd, updated_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const [i, usage] of event.usageEvents.entries()) {
			insertUsage.run(
				eventId,
				// A source that cannot name the response is keyed by its position
				// among the counted responses — unique within the batch, which is all
				// the key has to be once the set is replaced wholesale.
				usage.dedupKey ?? `line:${i}`,
				usage.respondedAtMs,
				usage.model,
				usage.input,
				usage.output,
				usage.cached,
				usage.estCostUsd ?? null,
				nowMs,
			);
		}
	}

	// Replace the model split wholesale — a partial update would leave a stale
	// row behind whenever a re-read attributes tokens to fewer models than
	// before. Only when the event actually OBSERVED usage, though: a usage-less
	// event carried the tokens forward above, and deleting the split here would
	// leave the scalars orphaned from an empty split.
	//
	// The condition is `hasUsage`, the SAME predicate the carry-forward used.
	// Testing `event.models !== undefined` instead let one shape fall between
	// them: `models: []` with no scalar token fields is "unobserved" to the
	// carry-forward (which keeps the stored 175 tokens) and "provided" to this
	// delete (which empties the split), leaving a session whose KPI reports
	// tokens while the model-dimension series reports none. `models: []` is an
	// accepted producer shape, so the gap was one producer away from shipping.
	if (hasUsage && event.models !== undefined) {
		db.prepare("DELETE FROM session_model_usage WHERE session_event_id = ?").run(eventId);
		const insertModel = db.prepare(MODEL_USAGE_UPSERT);
		for (const m of models) {
			insertModel.run(
				eventId,
				m.model,
				m.inputTokens,
				m.outputTokens,
				m.cachedTokens,
				m.estCostUsd ?? null,
				nowMs,
			);
		}
	}

	// Same replace-when-observed contract as the model split. A source whose
	// transcripts carry no tool records sends `undefined`, never `[]`, so
	// re-upserting such a session cannot delete what a Claude read collected.
	if (event.tools !== undefined) {
		// The set is still replaced wholesale, but the enrichment on a surviving key
		// is not always reproducible: a later slice can count the call without carrying
		// its original timestamp, token attribution or plugin namespace. Snapshot those
		// fields before the delete so the replacement can preserve them. The SQL upsert
		// below cannot do that by itself — after this DELETE there is no old row left to
		// conflict with.
		type PreviousTool = {
			tool_name: string;
			kind: string;
			last_call_at_ms: number | null;
			input_tokens: number | null;
			output_tokens: number | null;
			cached_tokens: number | null;
			usage_confidence: string | null;
			plugin: string | null;
		};
		const previousTools = new Map<string, PreviousTool>();
		for (const row of db
			.prepare(
				`SELECT tool_name, kind, last_call_at_ms, input_tokens, output_tokens,
				        cached_tokens, usage_confidence, plugin
				   FROM session_tool_use WHERE session_event_id = ?`,
			)
			.all(eventId) as ReadonlyArray<PreviousTool>) {
			previousTools.set(`${row.kind}\u0000${row.tool_name}`, row);
		}
		db.prepare("DELETE FROM session_tool_use WHERE session_event_id = ?").run(eventId);
		const insertTool = db.prepare(
			`INSERT INTO session_tool_use
			   (session_event_id, tool_name, kind, server, calls, last_call_at_ms,
			    input_tokens, output_tokens, cached_tokens, usage_confidence, plugin, updated_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(session_event_id, tool_name, kind) DO UPDATE SET
			     calls = excluded.calls,
			     -- The stamp must be in THIS branch too: a conflict is still a write,
			     -- and a sync keyed on it would otherwise never see a recount.
			     updated_at_ms = excluded.updated_at_ms,
			     -- MAX, not the excluded value: a re-read of the same session by a parser
			     -- that cannot stamp a time (or an older build) would otherwise erase an
			     -- instant a better read already recorded, and NULL is the one value this
			     -- column cannot recover from: the transcript slice it came from is
			     -- behind a cursor by then.
			     --
			     -- NULLIF around the MAX keeps "neither side has a time" as NULL: the
			     -- COALESCEs turn both-NULL into 0, and a stored 0 reads back as a real
			     -- epoch-0 instant, so the display's fallback to the session's own
			     -- timestamp would never fire.
			     last_call_at_ms = NULLIF(MAX(COALESCE(excluded.last_call_at_ms, 0),
			                                  COALESCE(session_tool_use.last_call_at_ms, 0)), 0),
			     -- COALESCE keeps the stored figure when the incoming read has none, for
			     -- the same reason the MAX above does: attribution needs the whole session
			     -- from line 0, so a pass that read a later slice — or any build whose
			     -- scanner cannot attribute — must not blank a number an earlier read
			     -- established. The four move together (see SKILL_TOKEN_USAGE_DDL), so
			     -- \`usage_confidence\` is keyed off the same side its tokens came from
			     -- rather than coalesced independently, which could otherwise label one
			     -- read's tokens with another read's confidence.
			     input_tokens     = COALESCE(excluded.input_tokens,  session_tool_use.input_tokens),
			     output_tokens    = COALESCE(excluded.output_tokens, session_tool_use.output_tokens),
			     cached_tokens    = COALESCE(excluded.cached_tokens, session_tool_use.cached_tokens),
			     usage_confidence = CASE WHEN excluded.input_tokens IS NOT NULL THEN excluded.usage_confidence
			                             ELSE session_tool_use.usage_confidence END,
			     -- COALESCE for the same reason as the token columns: a namespace is only
			     -- recoverable while the transcript that named it is readable, and a pass that
			     -- could not resolve one (a contested name, or a scanner that reports none)
			     -- must not blank a label an earlier read established.
			     plugin           = COALESCE(excluded.plugin, session_tool_use.plugin)`,
		);
		// Per-invocation rows, and deliberately NOT preceded by a DELETE — unlike the
		// aggregate above. Once an agent prunes a conversation its entries can never be
		// re-derived, so a rebuild would discard them at the first scan that can no longer
		// see them. Converging on the (session, skill, instant) key is what makes the
		// repeated whole-conversation re-reads idempotent instead of duplicating rows.
		const insertInvocation = db.prepare(
			`INSERT INTO skill_invocations (session_event_id, skill_name, at_ms, ok, ok_confidence,
			                               detection, entry_path, args, body_chars)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(session_event_id, skill_name, at_ms) DO UPDATE SET
			     -- Outcome evidence upgrades in one direction. A completed re-read must
			     -- replace an optimistic fragment, while a later partial read must not erase
			     -- an outcome already observed for this same invocation.
			     ok = CASE WHEN skill_invocations.ok_confidence = 'observed'
			                         AND excluded.ok_confidence <> 'observed'
			                    THEN skill_invocations.ok ELSE excluded.ok END,
			     ok_confidence = CASE WHEN skill_invocations.ok_confidence = 'observed'
			                                   OR excluded.ok_confidence = 'observed'
			                          THEN 'observed' ELSE excluded.ok_confidence END,
			     -- Also the latest reading: an observed entry supersedes an inferred one for
			     -- the same name (see \`scanCodexSkillLines\`), so a later pass that found the
			     -- injected block must be able to clear the heuristic mark.
			     detection     = excluded.detection,
			     entry_path    = excluded.entry_path,
			     -- These two ARE coalesced: they describe one fixed past event, so a pass that
			     -- read no argument string or no body length has nothing better to offer than
			     -- what is already stored.
			     args          = COALESCE(excluded.args, skill_invocations.args),
			     body_chars    = COALESCE(excluded.body_chars, skill_invocations.body_chars)`,
		);
		for (const tool of event.tools) {
			// All four are written together or not at all — a partially-filled row would
			// let a reader take three tokens with no confidence to qualify them.
			const previous = previousTools.get(`${tool.kind}\u0000${tool.name}`);
			const incomingLastCallAtMs = tool.lastCallAtMs ?? null;
			const previousLastCallAtMs = previous?.last_call_at_ms ?? null;
			const lastCallAtMs =
				incomingLastCallAtMs === null
					? previousLastCallAtMs
					: previousLastCallAtMs === null
						? incomingLastCallAtMs
						: Math.max(incomingLastCallAtMs, previousLastCallAtMs);
			const inputTokens = tool.usage?.input ?? previous?.input_tokens ?? null;
			const outputTokens = tool.usage?.output ?? previous?.output_tokens ?? null;
			const cachedTokens = tool.usage?.cached ?? previous?.cached_tokens ?? null;
			const usageConfidence = tool.usage ? tool.usage.confidence : (previous?.usage_confidence ?? null);
			insertTool.run(
				eventId,
				tool.name,
				tool.kind,
				tool.server ?? null,
				tool.calls,
				lastCallAtMs,
				inputTokens,
				outputTokens,
				cachedTokens,
				usageConfidence,
				tool.plugin ?? previous?.plugin ?? null,
				nowMs,
			);
			// Gated on the KIND, not merely on the field being present: the table holds skill
			// entries, and a builtin bucket that somehow carried invocations would otherwise
			// land in it silently. `ToolCallCount.invocations` documents the same restriction.
			if (tool.kind !== "skill") continue;
			for (const inv of tool.invocations ?? []) {
				const atMs = Date.parse(inv.at);
				// The instant IS the row's identity, so one that cannot be parsed is not a row —
				// the same rule `parseInvocationLine` applies to the markdown mirror. Reachable
				// rather than defensive: Kimi's converter yields "" for a malformed wire
				// timestamp, and NaN in a primary key would be rejected by the STRICT table.
				if (!Number.isFinite(atMs)) continue;
				insertInvocation.run(
					eventId,
					tool.name,
					atMs,
					inv.ok ? 1 : 0,
					// The source's own tag, never a guess from the bucket: whether an outcome could
					// be read depends on the mechanism as well as the host.
					skillOutcomeConfidence(event.source, inv.entryPath, inv.outcomeObserved),
					// Skill-level, copied onto each row. Lossless — one scan pass emits a single
					// nature per skill (see `ToolCallCount.detection`).
					tool.detection ?? null,
					inv.entryPath ?? null,
					inv.args ?? null,
					inv.bodyChars ?? null,
				);
			}
		}
	}

	// NOT the replace-when-observed contract the two blocks above use, and the
	// asymmetry is the point: a bucket is a monotone historical fact, not a
	// restatement of a current total, so no read may remove one. See
	// SESSION_ACTIVITY_DDL for why (a truncating host and Devin's regenerated
	// main chain both make a re-read return a non-superset, and deleting there
	// destroys presence the transcript can no longer prove).
	//
	// The `!== undefined` guard therefore no longer decides whether to DELETE —
	// it now only skips the loop for a source that measures no timestamps. It
	// stays because `[]` and absent still MEAN different things everywhere else,
	// and collapsing them here would invite collapsing them upstream.
	//
	// `OR IGNORE` keeps a re-observed bucket's ORIGINAL `recorded_at_ms`, which
	// is what stops a 60 s tick re-presenting a whole session as new to a sync
	// cursor reading that column.
	if (event.activityBuckets !== undefined) {
		const recordedAtMs = nowMs;
		const insertBucket = db.prepare(
			"INSERT OR IGNORE INTO session_activity (session_event_id, bucket_ms, recorded_at_ms) VALUES (?, ?, ?)",
		);
		for (const bucket of event.activityBuckets) {
			insertBucket.run(eventId, bucket, recordedAtMs);
		}
	}
}

/**
 * Records one recall call.
 *
 * Keyed on the event's own id so a re-drained event converges on the row it
 * already wrote instead of appending a second call — the same idempotency
 * every other projection here has, expressed as an UPSERT because there is no
 * natural business key for "a call" beyond when it happened.
 */
function projectRecallObserved(db: DashboardDbHandle, event: RecallObservedEvent, nowMs: number): void {
	const repoId = ensureRepoRow(db, event.repoIdentity);
	const outcome = event.outcome;
	db.prepare(
		`INSERT INTO recall_receipts
		   (receipt_id, repo_id, at_ms, surface, session_id, hit, commit_count, commits_json,
		    updated_at_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(receipt_id) DO UPDATE SET
		   updated_at_ms = excluded.updated_at_ms,
		   hit          = excluded.hit,
		   commit_count = excluded.commit_count,
		   commits_json = excluded.commits_json`,
	).run(
		statsEventId(event),
		repoId,
		event.atMs,
		event.surface,
		event.sessionId ?? null,
		outcome.hit ? 1 : 0,
		outcome.commitCount,
		outcome.commits.length > 0 ? JSON.stringify(outcome.commits) : null,
		nowMs,
	);
}

// PARKED with the `repo_graphs` table (see SotSchema): the graph page was
// removed, so nothing reads the artifact. Uncomment this, the table DDL and
// DbBackfill's call site together if the page returns.
// /**
//  * Records a repo's knowledge-graph artifact.
//  *
//  * A direct write, not a `StatsEvent`: this is a whole-artifact snapshot, not an
//  * observation to replay. Routing a few hundred KB of JSON through `events_raw` would park a
//  * copy of every import in the write-ahead log forever, for a row that is already
//  * idempotent on the artifact's own build stamp.
//  *
//  * Returns false when the stored row is already at or ahead of this artifact's
//  * `generatedAt`, so a caller can tell a real import from a no-op.
//  */
// export function recordRepoGraph(db: DashboardDbHandle, repoIdentity: string, graph: KnowledgeGraph): boolean {
// 	const repoId = ensureRepoRow(db, repoIdentity);
// 	const stored = db.prepare("SELECT generated_at FROM repo_graphs WHERE repo_id = ?").get(repoId) as
// 		| { generated_at?: string }
// 		| undefined;
// 	if (stored?.generated_at && stored.generated_at >= graph.generatedAt) return false;
//
// 	db.prepare(
// 		`INSERT INTO repo_graphs
// 		   (repo_id, generated_at, schema_version, categories, topics, units, edges, graph_json)
// 		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
// 		 ON CONFLICT(repo_id) DO UPDATE SET
// 		   generated_at   = excluded.generated_at,
// 		   schema_version = excluded.schema_version,
// 		   categories     = excluded.categories,
// 		   topics         = excluded.topics,
// 		   units          = excluded.units,
// 		   edges          = excluded.edges,
// 		   graph_json     = excluded.graph_json`,
// 	).run(
// 		repoId,
// 		graph.generatedAt,
// 		graph.schemaVersion,
// 		graph.categories.length,
// 		graph.topics.length,
// 		graph.units.length,
// 		graph.edges.length,
// 		JSON.stringify(graph),
// 	);
// 	return true;
// }

function projectCommit(db: DashboardDbHandle, event: CommitCreatedEvent, nowMs: number): void {
	const repoId = ensureRepoRow(db, event.repoIdentity);
	const eventId = statsEventId(event);
	db.prepare(
		`INSERT INTO commits
		   (event_id, repo_id, hash, branch, message, author_name, author_email,
		    committed_at_ms, files_changed, insertions, deletions, written_at_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(event_id) DO UPDATE SET
		   branch        = COALESCE(excluded.branch, commits.branch),
		   message       = COALESCE(excluded.message, commits.message),
		   author_name   = COALESCE(excluded.author_name, commits.author_name),
		   author_email  = COALESCE(excluded.author_email, commits.author_email),
		   committed_at_ms = excluded.committed_at_ms,
		   files_changed = COALESCE(excluded.files_changed, commits.files_changed),
		   insertions    = COALESCE(excluded.insertions, commits.insertions),
		   deletions     = COALESCE(excluded.deletions, commits.deletions),
		   -- Unconditional, like every other sync/build stamp: this row just
		   -- changed, and the rollup decides a cached day is stale by comparing
		   -- against this. A COALESCE here would hide the change from it.
		   written_at_ms = excluded.written_at_ms`,
	).run(
		eventId,
		repoId,
		event.hash,
		event.branch ?? null,
		event.message ?? null,
		event.authorName ?? null,
		event.authorEmail ?? null,
		event.committedAtMs,
		event.filesChanged ?? null,
		event.insertions ?? null,
		event.deletions ?? null,
		nowMs,
	);

	// `branches` is authoritative when present — replacing the set is what drops an
	// attribution the commit no longer carries. `undefined` means "could not tell"
	// (the collector loaded no summary index) and leaves the existing rows alone.
	//
	// The guard MUST stay a plain truthiness test on the array itself: `[]` is
	// truthy, and that is exactly what lets an empty list reach the DELETE and clear
	// the rows. Rewriting it as `event.branches?.length` or `.length > 0` looks
	// equivalent and silently inverts the meaning of `[]` into `undefined`'s —
	// which, on a database still holding the old N-row reachability sets, leaves
	// those commits carrying stale attribution forever. See `CommitCreatedEvent.branches`.
	const commitId = resolveCommitId(db, eventId);
	if (event.branches) {
		db.prepare("DELETE FROM commit_branches WHERE commit_id = ?").run(commitId);
		const insertBranch = db.prepare(
			`INSERT INTO commit_branches (commit_id, branch_id) VALUES (?, ?)
			 ON CONFLICT(commit_id, branch_id) DO NOTHING`,
		);
		// The repo boundary comes from branches.repo_id, which is why this table has
		// no repo column of its own.
		for (const branch of event.branches) insertBranch.run(commitId, resolveBranchId(db, repoId, branch));
	}

	// Same replace-when-present contract as `branches`: an amended commit can
	// drop a file, and only replacing the set removes it. Deleting first (rather
	// than upserting each row) is what makes that removal happen.
	if (event.files) {
		db.prepare("DELETE FROM commit_files WHERE commit_id = ?").run(commitId);
		const insertFile = db.prepare(
			`INSERT INTO commit_files (commit_id, path, insertions, deletions) VALUES (?, ?, ?, ?)
			 ON CONFLICT(commit_id, path) DO NOTHING`,
		);
		for (const file of event.files) {
			insertFile.run(commitId, file.path, file.insertions ?? null, file.deletions ?? null);
		}
	}
}

/**
 * Projects a `commit.summary` — the memory pipeline's enrichment of a commit.
 *
 * The commits row is created if the summary arrives before its `commit.created`
 * (independent producers guarantee no ordering). The enrichment COLUMNS and
 * child tables (insights / references / links) are gone (A3b): the dashboard
 * reads them from the memory tables, which the same worker pass refreshes via
 * applyMemoryWrites — writing copies here again would just recreate the
 * falls-behind-on-regeneration problem the move solved. What this projection
 * still owns is the commits row itself and the session seeding below: a
 * session older than the agents' retention exists nowhere but in the memory
 * pipeline's links, and the sessions table is activity data, not memory data.
 */
function projectCommitSummary(db: DashboardDbHandle, event: CommitSummaryEvent, nowMs: number): void {
	const repoId = ensureRepoRow(db, event.repoIdentity);
	// Same event_id namespace as commit.created — the enrichment lands on the
	// SAME commits row, only the events_raw provenance ids differ.
	const commitEventId = `commit:${event.repoIdentity}:${event.hash}`;
	db.prepare(
		`INSERT INTO commits
		   (event_id, repo_id, hash, branch, message, committed_at_ms, written_at_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(event_id) DO UPDATE SET
		   branch        = COALESCE(excluded.branch, commits.branch),
		   message       = COALESCE(excluded.message, commits.message),
		   written_at_ms = excluded.written_at_ms`,
	).run(commitEventId, repoId, event.hash, event.branch ?? null, event.message ?? null, event.committedAtMs, nowMs);

	// `commit_branches` too, and NOT just the `commits.branch` column above.
	//
	// Attribution is the branch the commit was COMMITTED ON, and its source is
	// this very summary — so this event carries the whole fact and must project it
	// into the table the branch axis actually reads (`buildSeries` joins
	// `commit_branches`; nothing reads `commits.branch` for that axis).
	//
	// Writing only the column left a gap no later pass closes on its own. The
	// commit tier is gated on `checkoutFingerprint`, which hashes HEAD plus
	// `refs/heads` MINUS Jolli's own refs — so the orphan branch moving under a
	// late-arriving memory does not move that cursor, `collectCommitEvents` is
	// skipped, and the commit keeps whatever attribution it had when it was last
	// swept: `[]` for one whose summary did not exist yet, since an index that
	// loads WITHOUT the entry is the "no recorded branch" answer. The rows then
	// stay wrong until some unrelated ref happens to move.
	// `recordCommitsFromWorker` hides this for the ordinary local commit — it
	// writes the current branch at drain time — which is exactly why the hole only
	// shows for the paths that skip it: a live write that failed (and was
	// swallowed, by contract), a regeneration outside the queue, and a database
	// whose sweep ran between the commit and its summary.
	//
	// Same replace-when-present contract as `commit.created`'s `branches`, and the
	// absent side is load-bearing in the same way: `branch` is present-gated by
	// `summaryEventFromCommitSummary`, so a summary recording none leaves the
	// stored rows ALONE rather than clearing them. Only `commit.created` may say
	// "no branch reaches this commit", because only it can tell an unreadable
	// index from one that simply does not list the hash.
	if (event.branch) {
		const commitId = resolveCommitId(db, commitEventId);
		db.prepare("DELETE FROM commit_branches WHERE commit_id = ?").run(commitId);
		db.prepare(
			`INSERT INTO commit_branches (commit_id, branch_id) VALUES (?, ?)
			 ON CONFLICT(commit_id, branch_id) DO NOTHING`,
		).run(commitId, resolveBranchId(db, repoId, event.branch));
	}

	if (event.sessionLinks) {
		// This statement's COLUMN LIST is load-bearing, and not only for what it writes.
		// `started_at_ms` and `duration_ms` are absent because a commit summary cannot know
		// them, and their absence is exactly what reads as "no transcript was ever read for
		// this row" — to the back-fill's per-session skip (`readKnownSessions` in
		// DbBackfill) and to `projectSession`'s monotonic guard, which share that predicate
		// deliberately. This seed's instant is the COMMIT's time, later than the
		// conversation's last turn, so a row it created must never look like a read
		// receipt: adding either column here would make the sweep skip that session's
		// transcript on every pass from then on, permanently and silently.
		//
		// `title` is absent for the weaker reason that a summary has no session title to
		// offer. It is NOT part of either predicate, and must not be added to one: a FAILED
		// transcript read writes a title too, so it cannot distinguish a read that happened
		// from one that was attempted.
		//
		// Token columns are safe — the summary genuinely observed those.
		const seedSession = db.prepare(
			`INSERT INTO sessions
			   (event_id, repo_id, source, session_id, updated_at_ms, message_count,
			    input_tokens, output_tokens, cached_tokens, est_cost_usd, token_coverage, prices_as_of,
			    written_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(event_id) DO UPDATE SET
			   input_tokens   = excluded.input_tokens,
			   output_tokens  = excluded.output_tokens,
			   cached_tokens  = excluded.cached_tokens,
			   est_cost_usd   = excluded.est_cost_usd,
			   token_coverage = excluded.token_coverage,
			   prices_as_of   = excluded.prices_as_of,
			   -- The whole reason this column exists. This UPDATE deliberately leaves
			   -- updated_at_ms alone (the commit's clock is not the session's), so a
			   -- sync keyed on that column would never learn the token split just
			   -- improved here. The stamp is what makes the enrichment visible.
			   written_at_ms  = excluded.written_at_ms
			 WHERE sessions.token_coverage = 'sessions-only' AND excluded.token_coverage = 'full'`,
		);
		const deleteModels = db.prepare("DELETE FROM session_model_usage WHERE session_event_id = ?");
		const insertModel = db.prepare(MODEL_USAGE_UPSERT);
		const deleteTools = db.prepare("DELETE FROM session_tool_use WHERE session_event_id = ?");
		const insertTool = db.prepare(
			`INSERT INTO session_tool_use
			   (session_event_id, tool_name, kind, server, calls, last_call_at_ms, updated_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(session_event_id, tool_name, kind) DO UPDATE SET
			     calls = excluded.calls,
			     -- The stamp must be in THIS branch too: a conflict is still a write,
			     -- and a sync keyed on it would otherwise never see a recount.
			     updated_at_ms = excluded.updated_at_ms,
			     -- NULLIF for the same reason as the live path above: both-NULL must stay
			     -- NULL, or the row claims epoch 0 as a real last-call instant.
			     last_call_at_ms = NULLIF(MAX(COALESCE(excluded.last_call_at_ms, 0),
			                                  COALESCE(session_tool_use.last_call_at_ms, 0)), 0)`,
		);
		for (const link of event.sessionLinks) {
			// Through the helper, not a fourth hand-written template: this key is also
			// what `readEmittedFromLog` looks a row up by, and a spelling that drifts
			// from `statsEventId`'s stops matching in silence.
			const linkEventId = sessionEventId(event.repoIdentity, link.source, link.sessionId);
			const models = link.models ?? [];
			const cost = models.some((m) => m.estCostUsd != null) ? sum(models, (m) => m.estCostUsd ?? 0) : null;
			// Seed a minimal session row when the memory pipeline is the only
			// remaining record of this session (older than the agents' retention), or
			// backfill token data onto a `sessions-only` row seeded before this summary
			// carried `usageByModel`. The WHERE clause keeps a live-discovered `full`
			// row authoritative: the UPDATE is a no-op whenever the existing row is
			// already `full`, or this link still has no models to offer. `changes`
			// tells us whether the row was freshly inserted or genuinely upgraded,
			// which is also why the model split below only runs in those two cases.
			const result = seedSession.run(
				linkEventId,
				repoId,
				link.source,
				link.sessionId,
				event.committedAtMs,
				link.messageCount ?? null,
				sum(models, (m) => m.inputTokens),
				sum(models, (m) => m.outputTokens),
				sum(models, (m) => m.cachedTokens),
				cost,
				models.length > 0 ? "full" : "sessions-only",
				models.length > 0 ? PRICES_AS_OF : null,
				nowMs,
			) as { changes?: number | bigint };
			if (Number(result?.changes ?? 0) > 0) {
				deleteModels.run(linkEventId);
				for (const m of models) {
					insertModel.run(
						linkEventId,
						m.model,
						m.inputTokens,
						m.outputTokens,
						m.cachedTokens,
						m.estCostUsd ?? null,
						nowMs,
					);
				}
				// Tool calls ride the SAME gate as the model split, which is what keeps
				// this honest in both directions. A live `session.upserted` read parses
				// the whole transcript and is therefore the more complete record, so it
				// must win: `changes > 0` means the row was either just seeded (no live
				// read exists — the retention case this backfill is for) or upgraded off
				// `sessions-only` (a row that never had tool data either).
				//
				// Known and deliberate understatement: a memory owns only the slices of
				// a session that ITS commit consumed, while this table is keyed per
				// session with no commit dimension. So a session split across several
				// commits contributes whichever slice seeds the row, and later commits
				// find `changes = 0` and add nothing. Summing them instead would inflate
				// on every replay — the same event must project to the same rows — and
				// telling "another commit's slice" apart from "this commit again" needs
				// a commit column this table does not have. Undercounting a split
				// session beats a number that grows every time the queue redrains.
				if (link.tools !== undefined) {
					deleteTools.run(linkEventId);
					for (const t of link.tools) {
						insertTool.run(
							linkEventId,
							t.name,
							t.kind,
							t.server ?? null,
							t.calls,
							t.lastCallAtMs ?? null,
							nowMs,
						);
					}
				}
			}
		}
	}
}

/**
 * How long a `worktree.status` observation stays believable.
 *
 * "There is uncommitted work on branch X" is a LIVE claim, and this table is
 * keyed `(repo_id, branch_key)` with latest-wins — so a row is only corrected by
 * another observation of the SAME branch. Commit the work, switch away, delete
 * the branch, drop the clone: nothing observes that key again, and the row sat
 * there forever telling Standup about changes that no longer exist.
 *
 * Nothing polls for this either. Observations ride commits and the editor's 60 s
 * tick, so a repo whose IDE is closed and which is not being committed to simply
 * stops reporting — which is why the answer is an age gate on both ends (readers
 * ignore stale rows, writers drop them) rather than a background sweep.
 *
 * 24 h because Standup's own window is yesterday+today: a claim older than that
 * cannot be part of the answer it is asked for.
 */
export const WORKTREE_STATUS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function projectWorktree(db: DashboardDbHandle, event: WorktreeStatusEvent): void {
	const repoId = ensureRepoRow(db, event.repoIdentity);
	// Housekeeping before the upsert, against the OBSERVATION's own clock (this
	// projection must stay a pure function of the event, so a replay converges).
	// Readers ignore these rows already; keeping them is unbounded debt in a table
	// nothing else ever deletes from. A branch that is still dirty gets its row
	// back on the very next observation.
	db.prepare("DELETE FROM worktree_status WHERE repo_id = ? AND observed_at_ms < ?").run(
		repoId,
		event.observedAtMs - WORKTREE_STATUS_MAX_AGE_MS,
	);
	db.prepare(
		`INSERT INTO worktree_status
		   (repo_id, branch_key, branch, files_changed, insertions, deletions, observed_at_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(repo_id, branch_key) DO UPDATE SET
		   branch         = excluded.branch,
		   files_changed  = excluded.files_changed,
		   insertions     = excluded.insertions,
		   deletions      = excluded.deletions,
		   observed_at_ms = excluded.observed_at_ms`,
	).run(
		repoId,
		event.branch ?? "",
		event.branch ?? null,
		event.filesChanged,
		event.insertions,
		event.deletions,
		event.observedAtMs,
	);
}

function sum<T>(items: ReadonlyArray<T>, pick: (item: T) => number): number {
	return items.reduce((total, item) => total + pick(item), 0);
}

/**
 * Observes the working tree and returns a `worktree.status` event.
 *
 * Lives here rather than in the collector because it is the one piece of live
 * state with no historical source — nothing can reconstruct "what was
 * uncommitted at 9am", so it is always a fresh read and always latest-wins.
 *
 * Deliberately NOT `getWorkingTreeDiffStats`: that helper takes an explicit path
 * list and short-circuits to all-zero on an empty one, so passing `[]` for
 * "everything" would silently report a clean tree. The whole-tree question needs
 * a bare `git diff --shortstat HEAD`.
 *
 * Returns null when git is unavailable — an unreadable worktree is not worth
 * failing a write batch over, and the next observation overwrites the row anyway.
 */
export async function observeWorktree(
	repoIdentity: string,
	cwd: string,
	branch: string | undefined,
	now: () => number = Date.now,
): Promise<WorktreeStatusEvent | null> {
	const result = await execGit(["diff", "--shortstat", "HEAD"], cwd);
	if (result.exitCode !== 0) {
		// Expected in a repo with no commits yet (no HEAD to diff against).
		log.debug("worktree status unavailable for %s: %s", cwd, result.stderr.trim());
		return null;
	}
	const line = result.stdout.trim();
	const files = /(\d+)\s+files?\s+changed/.exec(line);
	const insertions = /(\d+)\s+insertions?/.exec(line);
	const deletions = /(\d+)\s+deletions?/.exec(line);
	return {
		type: "worktree.status",
		repoIdentity,
		...(branch ? { branch } : {}),
		filesChanged: files ? Number.parseInt(files[1], 10) : 0,
		insertions: insertions ? Number.parseInt(insertions[1], 10) : 0,
		deletions: deletions ? Number.parseInt(deletions[1], 10) : 0,
		observedAtMs: now(),
	};
}

/**
 * Days a projected event is kept in `events_raw` before pruning.
 *
 * The log has two jobs (see the module header): a durable write-ahead record, and
 * a short audit/replay window. Only the first is load-bearing, and it ends the
 * moment a row is marked `projected` — so retention only needs to be long enough
 * to investigate something that happened "recently".
 */
const PROJECTED_RETENTION_DAYS = 14;

/** Rows deleted per pass, so a first prune on a long-neglected log cannot hold the write lock. */
const PRUNE_BATCH_SIZE = 2_000;

/**
 * Deletes `projected` rows older than {@link PROJECTED_RETENTION_DAYS}.
 *
 * `pending` and `failed` are NEVER pruned regardless of age: pending rows are the
 * crash-recovery record a later writer drains, and failed rows are the poison-pill
 * evidence for something that needs looking at. Age is not a reason to discard
 * either — only successful projection is.
 *
 * Bounded per pass and called from the writer path that already holds the lock, so
 * it costs no extra acquisition and cannot stall other writers on a first run
 * against a log that has grown for months.
 *
 * `tag` prefixes BOTH lines this can emit, and exists because the callers do not share a
 * reader. Two are user-triggered writes whose output is read in context; the third is the
 * daemon's 30-second re-scan, whose whole diagnostic story is "one `grep AgentScan` returns
 * all of it" — a promise every line that pass can emit keeps, and that an unprefixed line
 * from a shared helper quietly broke. Empty by default, so the two existing callers' output
 * is byte-identical.
 *
 * Both lines, not just the successful one. Tagging only the INFO line left the pair's one
 * report of a REAL fault as the single thing the grep drops — and DEBUG is precisely the
 * level someone raises before running that grep, so the line would be present, relevant,
 * and filtered out.
 */
export function pruneProjectedEvents(db: DashboardDbHandle, now: () => number = Date.now, tag = ""): number {
	try {
		const cutoff = new Date(now() - PROJECTED_RETENTION_DAYS * 86_400_000).toISOString();
		const result = db
			.prepare(
				`DELETE FROM events_raw
				  WHERE seq IN (
				    SELECT seq FROM events_raw
				     WHERE projection_status = 'projected' AND received_at < ?
				     ORDER BY seq LIMIT ?)`,
			)
			.run(cutoff, PRUNE_BATCH_SIZE) as { changes?: number | bigint };
		const deleted = Number(result?.changes ?? 0);
		if (deleted > 0) log.info("%spruned %d projected events older than %s", tag, deleted, cutoff.slice(0, 10));
		return deleted;
	} catch (err) {
		// Housekeeping must never fail a write that already succeeded.
		log.debug("%sevent pruning skipped: %s", tag, errMsg(err));
		return 0;
	}
}

/**
 * Returns every STUCK event to the queue with a fresh attempt budget, and reports
 * how many were revived.
 *
 * "Stuck" is exactly {@link countStuckEvents}' set — both statements share
 * {@link REVIVABLE_PREDICATE} so the number doctor COUNTS and the number `--fix`
 * can REACH cannot disagree. That excludes the `unknown-type` rows a drain revives
 * on its own (touching them would reset an attempt budget the build still cannot
 * spend) and INCLUDES the rows nothing revives automatically: `failed_kind =
 * 'error'`, the pre-migration `NULL` rows, and an `unknown-type` whose event type
 * this build still does not recognise. An earlier revision narrowed this to
 * `failed_kind = 'error'` alone, which left both NULL and unrecognised-type rows
 * counted-but-unfixable — reported to the user with no way to act on them.
 *
 * **Deliberately manual.** The automatic revivals are each keyed to evidence the
 * blocker is gone — a lock contention never spends the budget, `unknown-type` is
 * scoped to types this build now understands. A stuck row carries no such
 * evidence, so the only honest trigger is an operator who has just fixed something
 * (upgraded the CLI, restored a migration). Calling this on every drain would
 * spend attempts forever on a genuinely defective event.
 *
 * The caller supplies the writable handle: this runs inside whatever transaction
 * or lock the caller already holds, and the caller is the one that knows whether
 * a drain should follow.
 *
 * Degrades on a pre-migration schema exactly as {@link countStuckEvents} does —
 * there is no `failed_kind` column to null out or to narrow by, and every `failed`
 * row is stuck there, so the whole set is un-parked.
 */
export function unparkStuckEvents(db: DashboardDbHandle): number {
	const revivable = KNOWN_EVENT_TYPES.map(() => "?").join(", ");
	try {
		const result = db
			.prepare(
				`UPDATE events_raw SET projection_status = 'pending', attempts = 0, failed_kind = NULL
				  WHERE projection_status = 'failed'
				    AND NOT (${REVIVABLE_PREDICATE} AND type IN (${revivable}))`,
			)
			.run(...KNOWN_EVENT_TYPES) as { changes?: number | bigint };
		const revived = Number(result?.changes ?? 0);
		if (revived > 0) log.info("un-parked %d stuck event(s) for reprojection", revived);
		return revived;
	} catch (err) {
		if (!/no such column: failed_kind/i.test(errMsg(err))) throw err;
		const result = db
			.prepare(
				"UPDATE events_raw SET projection_status = 'pending', attempts = 0 WHERE projection_status = 'failed'",
			)
			.run() as { changes?: number | bigint };
		const revived = Number(result?.changes ?? 0);
		if (revived > 0) log.info("un-parked %d stuck event(s) for reprojection (pre-migration schema)", revived);
		return revived;
	}
}
