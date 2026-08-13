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
	statsEventId,
	type WorktreeStatusEvent,
} from "./DashboardModel.js";

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
		  WHERE projection_status = 'failed' AND failed_kind = 'unknown-type'
		    AND type IN (${revivable})`,
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
				projectEvent(db, event);
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

/** Dispatches one event to its projection. Must run inside a transaction. */
function projectEvent(db: DashboardDbHandle, event: StatsEvent): void {
	switch (event.type) {
		case "repo.enabled":
			projectRepoEnabled(db, event);
			return;
		case "repo.disabled":
			projectRepoDisabled(db, event);
			return;
		case "session.upserted":
			projectSession(db, event);
			return;
		case "commit.created":
			projectCommit(db, event);
			return;
		case "commit.summary":
			projectCommitSummary(db, event);
			return;
		case "worktree.status":
			projectWorktree(db, event);
			return;
		case "recall.observed":
			projectRecallObserved(db, event);
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

function projectSession(db: DashboardDbHandle, event: SessionUpsertedEvent): void {
	const repoId = ensureRepoRow(db, event.repoIdentity);
	const eventId = statsEventId(event);
	const models = event.models ?? [];
	// An event that carries NO usage information at all (no model split, no
	// scalar token fields) means "tokens unobserved this time", not "zero" —
	// e.g. a live producer whose transcript read failed. Writing zeros would
	// clobber a previously enriched row, so carry the existing values forward.
	const hasUsage =
		models.length > 0 || event.inputTokens != null || event.outputTokens != null || event.cachedTokens != null;
	const existing = hasUsage
		? undefined
		: (db
				.prepare(
					"SELECT input_tokens, output_tokens, cached_tokens, est_cost_usd, token_coverage FROM sessions WHERE event_id = ?",
				)
				.get(eventId) as
				| {
						input_tokens: number;
						output_tokens: number;
						cached_tokens: number;
						est_cost_usd: number | null;
						token_coverage: string;
				  }
				| undefined);
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
		    input_tokens, output_tokens, cached_tokens, est_cost_usd, token_coverage, prices_as_of)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(event_id) DO UPDATE SET
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
	);

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
		const insertModel = db.prepare(
			`INSERT INTO session_model_usage
			   (session_event_id, model, input_tokens, output_tokens, cached_tokens, est_cost_usd)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);
		for (const m of models) {
			insertModel.run(eventId, m.model, m.inputTokens, m.outputTokens, m.cachedTokens, m.estCostUsd ?? null);
		}
	}

	// Same replace-when-observed contract as the model split. A source whose
	// transcripts carry no tool records sends `undefined`, never `[]`, so
	// re-upserting such a session cannot delete what a Claude read collected.
	if (event.tools !== undefined) {
		db.prepare("DELETE FROM session_tool_use WHERE session_event_id = ?").run(eventId);
		const insertTool = db.prepare(
			`INSERT INTO session_tool_use (session_event_id, tool_name, kind, server, calls, last_call_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(session_event_id, tool_name, kind) DO UPDATE SET calls = excluded.calls,
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
			                                  COALESCE(session_tool_use.last_call_at_ms, 0)), 0)`,
		);
		for (const tool of event.tools) {
			insertTool.run(eventId, tool.name, tool.kind, tool.server ?? null, tool.calls, tool.lastCallAtMs ?? null);
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
function projectRecallObserved(db: DashboardDbHandle, event: RecallObservedEvent): void {
	const repoId = ensureRepoRow(db, event.repoIdentity);
	const outcome = event.outcome;
	db.prepare(
		`INSERT INTO recall_receipts
		   (receipt_id, repo_id, at_ms, surface, session_id, hit, commit_count, commits_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(receipt_id) DO UPDATE SET
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

function projectCommit(db: DashboardDbHandle, event: CommitCreatedEvent): void {
	const repoId = ensureRepoRow(db, event.repoIdentity);
	const eventId = statsEventId(event);
	db.prepare(
		`INSERT INTO commits
		   (event_id, repo_id, hash, branch, message, author_name, author_email,
		    committed_at_ms, files_changed, insertions, deletions)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(event_id) DO UPDATE SET
		   branch        = COALESCE(excluded.branch, commits.branch),
		   message       = COALESCE(excluded.message, commits.message),
		   author_name   = COALESCE(excluded.author_name, commits.author_name),
		   author_email  = COALESCE(excluded.author_email, commits.author_email),
		   committed_at_ms = excluded.committed_at_ms,
		   files_changed = COALESCE(excluded.files_changed, commits.files_changed),
		   insertions    = COALESCE(excluded.insertions, commits.insertions),
		   deletions     = COALESCE(excluded.deletions, commits.deletions)`,
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
function projectCommitSummary(db: DashboardDbHandle, event: CommitSummaryEvent): void {
	const repoId = ensureRepoRow(db, event.repoIdentity);
	// Same event_id namespace as commit.created — the enrichment lands on the
	// SAME commits row, only the events_raw provenance ids differ.
	const commitEventId = `commit:${event.repoIdentity}:${event.hash}`;
	db.prepare(
		`INSERT INTO commits
		   (event_id, repo_id, hash, branch, message, committed_at_ms)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(event_id) DO UPDATE SET
		   branch        = COALESCE(excluded.branch, commits.branch),
		   message       = COALESCE(excluded.message, commits.message)`,
	).run(commitEventId, repoId, event.hash, event.branch ?? null, event.message ?? null, event.committedAtMs);

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
		const seedSession = db.prepare(
			`INSERT INTO sessions
			   (event_id, repo_id, source, session_id, updated_at_ms, message_count,
			    input_tokens, output_tokens, cached_tokens, est_cost_usd, token_coverage, prices_as_of)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(event_id) DO UPDATE SET
			   input_tokens   = excluded.input_tokens,
			   output_tokens  = excluded.output_tokens,
			   cached_tokens  = excluded.cached_tokens,
			   est_cost_usd   = excluded.est_cost_usd,
			   token_coverage = excluded.token_coverage,
			   prices_as_of   = excluded.prices_as_of
			 WHERE sessions.token_coverage = 'sessions-only' AND excluded.token_coverage = 'full'`,
		);
		const deleteModels = db.prepare("DELETE FROM session_model_usage WHERE session_event_id = ?");
		const insertModel = db.prepare(
			`INSERT INTO session_model_usage
			   (session_event_id, model, input_tokens, output_tokens, cached_tokens, est_cost_usd)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);
		const deleteTools = db.prepare("DELETE FROM session_tool_use WHERE session_event_id = ?");
		const insertTool = db.prepare(
			`INSERT INTO session_tool_use (session_event_id, tool_name, kind, server, calls, last_call_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(session_event_id, tool_name, kind) DO UPDATE SET calls = excluded.calls,
			     -- NULLIF for the same reason as the live path above: both-NULL must stay
			     -- NULL, or the row claims epoch 0 as a real last-call instant.
			     last_call_at_ms = NULLIF(MAX(COALESCE(excluded.last_call_at_ms, 0),
			                                  COALESCE(session_tool_use.last_call_at_ms, 0)), 0)`,
		);
		for (const link of event.sessionLinks) {
			const sessionEventId = `session:${event.repoIdentity}:${link.source}:${link.sessionId}`;
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
				sessionEventId,
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
			) as { changes?: number | bigint };
			if (Number(result?.changes ?? 0) > 0) {
				deleteModels.run(sessionEventId);
				for (const m of models) {
					insertModel.run(
						sessionEventId,
						m.model,
						m.inputTokens,
						m.outputTokens,
						m.cachedTokens,
						m.estCostUsd ?? null,
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
					deleteTools.run(sessionEventId);
					for (const t of link.tools) {
						insertTool.run(
							sessionEventId,
							t.name,
							t.kind,
							t.server ?? null,
							t.calls,
							t.lastCallAtMs ?? null,
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
 */
export function pruneProjectedEvents(db: DashboardDbHandle, now: () => number = Date.now): number {
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
		if (deleted > 0) log.info("pruned %d projected events older than %s", deleted, cutoff.slice(0, 10));
		return deleted;
	} catch (err) {
		// Housekeeping must never fail a write that already succeeded.
		log.debug("event pruning skipped: %s", errMsg(err));
		return 0;
	}
}
