import type { CommitSummary, SummaryErrorKind } from "../Types.js";

/**
 * Single source of truth for the summary-error marker constant. Importing
 * this rather than the literal "llm-failed" keeps grep-ability across
 * QueueWorker / Regenerator / Webview consumers.
 */
export const LLM_FAILED: SummaryErrorKind = "llm-failed";

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
