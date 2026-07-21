import type { CommitSummary, SummaryErrorKind } from "../Types.js";

/**
 * Single source of truth for the summary-error marker constant. Importing
 * this rather than the literal "llm-failed" keeps grep-ability across
 * QueueWorker / Regenerator / Webview consumers.
 */
export const LLM_FAILED: SummaryErrorKind = "llm-failed";

/**
 * Marker for the auth-expired subcase of an LLM failure — the local-agent
 * `claude` login expired or is not signed in. Same grep-ability rationale as
 * {@link LLM_FAILED}.
 */
export const LOCAL_AGENT_AUTH: SummaryErrorKind = "local-agent-auth";

/**
 * Maps a thrown LLM error to a summary-error marker kind: a LocalAgentAuthError
 * (the local `claude` login expired / not signed in) becomes
 * {@link LOCAL_AGENT_AUTH} so surfaces can show sign-in guidance; every other
 * failure is the generic {@link LLM_FAILED}.
 *
 * Matched by `name`, not `instanceof`: esbuild inlines `cli/src/**` into the VS
 * Code bundle, which can yield two copies of the error class where `instanceof`
 * silently returns false. The `name` string is stable across those copies.
 */
export function classifyLlmFailure(err: unknown): SummaryErrorKind {
	return (err as { name?: unknown } | null | undefined)?.name === "LocalAgentAuthError"
		? LOCAL_AGENT_AUTH
		: LLM_FAILED;
}

/** Whether a summary's error marker is the auth-expired subcase. */
export function isLocalAgentAuthError(summary: Pick<CommitSummary, "summaryError">): boolean {
	return summary.summaryError === LOCAL_AGENT_AUTH;
}

/**
 * Whether the given summary should surface the "regenerate me" affordance.
 * Reads two fields:
 *   - `summaryError` (new field, set explicitly by all failure paths)
 *   - `llm?.stopReason === "error"` (legacy fallback for summaries written
 *     before `summaryError` existed; the normal-commit path has been
 *     setting this since at least 0.98.x)
 *
 * Only `stopReason === "error"` triggers the legacy fallback. Other
 * non-"end_turn" reasons like "max_tokens" indicate truncation, NOT
 * failure — the summary may be partial but is still authoritative for its
 * topics. Don't conflate.
 */
export function isSummaryError(summary: CommitSummary): boolean {
	if (summary.summaryError !== undefined) return true;
	if (summary.llm?.stopReason === "error") return true;
	return false;
}

/** Returns a shallow clone of `summary` with the LLM_FAILED marker attached. */
export function withSummaryError(summary: CommitSummary): CommitSummary {
	return { ...summary, summaryError: LLM_FAILED };
}
