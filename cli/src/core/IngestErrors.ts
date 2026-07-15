/**
 * IngestErrors — stable, structured outcome codes for the topic-KB ingest
 * pipeline. The local-CLI counterpart of the backend's WORKFLOW_ERROR_CODES:
 * one code per real failure point, surfaced in run telemetry (IngestRunStore)
 * and the `jolli compile` summary. Codes are append-only — never renumber.
 */
export const INGEST_CODES = {
	OK: "OK",
	NO_PENDING: "NO_PENDING",
	CREDENTIAL_MISSING: "CREDENTIAL_MISSING",
	ROUTE_FAILED: "ROUTE_FAILED",
	RECONCILE_TRUNCATED: "RECONCILE_TRUNCATED",
	RECONCILE_PARSE_FAILED: "RECONCILE_PARSE_FAILED",
	// The reconcile LLM call itself threw (network/abort/transport/unexpected),
	// as opposed to RECONCILE_PARSE_FAILED where the call returned but its text
	// didn't parse. Kept distinct so telemetry doesn't mislabel a transient
	// transport failure as a deterministic content problem.
	RECONCILE_CALL_FAILED: "RECONCILE_CALL_FAILED",
	NO_SOURCE_CONTENT: "NO_SOURCE_CONTENT",
	ITERATION_GUARD: "ITERATION_GUARD",
	// The topic page changed under us between the lock-free reconcile read and the
	// guarded write (a sync pull or concurrent drain rewrote `topics/<slug>.json`),
	// OR the guarded write could not acquire the write lock in budget (a
	// `VaultWriteBusyError`). Either way the reconciled body was built from stale
	// input — or the lock was simply busy — so the sources are held for a retry on
	// the next drain rather than clobbering the newer content. This is a BENIGN,
	// self-resolving condition.
	PAGE_WRITE_CONFLICT: "PAGE_WRITE_CONFLICT",
	// The guarded page+index write itself FAILED for a reason other than lock
	// contention or a concurrent rewrite — a real I/O error (disk full, permission,
	// JSON serialisation, git plumbing). Distinct from PAGE_WRITE_CONFLICT so a
	// genuine fault is not silently mislabeled as benign contention and retried
	// forever: it surfaces in telemetry and the `jolli compile` summary as an error,
	// not a conflict. The source is still held (the batch continues), but the
	// failure is visible.
	PAGE_WRITE_ERROR: "PAGE_WRITE_ERROR",
} as const;

export type IngestCode = (typeof INGEST_CODES)[keyof typeof INGEST_CODES];

/**
 * Ingest outcomes that are NOT pipeline errors and therefore must NOT raise an
 * `error_occurred` telemetry event (JOLLI-1962). `ingest_completed` still records
 * the outcome for all of them; they just aren't double-counted as errors.
 *
 *   - `OK` / `NO_PENDING` — success / nothing pending.
 *   - `CREDENTIAL_MISSING` — the user isn't signed in, so the drain can't run yet.
 *     An expected "can't run" state, not a failure — it dominated (~87%) the old
 *     apparent ingest error rate.
 *   - `NO_SOURCE_CONTENT` — the batch's sources vanished / were empty; nothing to
 *     fold in.
 *   - `PAGE_WRITE_CONFLICT` — a benign, self-resolving concurrent-write hold (see
 *     its code doc above); sources are just retried on the next drain.
 *
 * Genuine failures (`ROUTE_FAILED`, `RECONCILE_TRUNCATED`, `RECONCILE_PARSE_FAILED`,
 * `RECONCILE_CALL_FAILED`, `ITERATION_GUARD`, `PAGE_WRITE_ERROR`) are absent here,
 * so they still surface as `error_occurred`.
 */
export const INGEST_NON_ERROR_OUTCOMES: ReadonlySet<string> = new Set([
	INGEST_CODES.OK,
	INGEST_CODES.NO_PENDING,
	INGEST_CODES.CREDENTIAL_MISSING,
	INGEST_CODES.NO_SOURCE_CONTENT,
	INGEST_CODES.PAGE_WRITE_CONFLICT,
]);
