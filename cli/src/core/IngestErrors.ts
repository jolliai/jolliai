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
} as const;

export type IngestCode = (typeof INGEST_CODES)[keyof typeof INGEST_CODES];
