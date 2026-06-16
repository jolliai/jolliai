import { isSummaryError } from "../../../cli/src/core/SummaryErrorMarker.js";
import type { CommitSummary } from "../../../cli/src/Types.js";

/** Options controlling banner text + button rendering. */
export interface SummaryErrorBannerOptions {
	/**
	 * True when the panel is showing a foreign-repo summary (cross-repo
	 * Memory Bank lookup) OR a stale-rewritten summary (the commit was
	 * rewritten by amend/squash/rebase). In both cases the Regenerate
	 * button is hidden by CSS — emitting a "Click Regenerate" CTA would
	 * be a dead instruction.
	 */
	readonly readOnly?: boolean;
	/**
	 * True when the panel was opened for a commit that has NO stored summary
	 * yet (the placeholder-open path). Renders the "Generate memory" variant
	 * instead of the failure variant — a never-generated commit is not a
	 * failed one, so the copy explains the empty state and offers to create a
	 * summary from scratch. Takes precedence over the failure check.
	 */
	readonly needsGeneration?: boolean;
}

/**
 * Top-of-page banner shown when the last summarize / consolidate LLM call
 * failed and the persisted summary either has empty topics (normal commit,
 * amend fresh-leaf) or was assembled via Copy-Hoist / mechanical merge
 * (amend short-circuit, amend step-2 fallback, squash fallback).
 *
 * Returns empty string for healthy summaries so callers can splice the
 * return value into `buildHtml` unconditionally.
 *
 * The button id `summaryErrorRegenerateBtn` is picked up by the click
 * delegate installed in SummaryScriptBuilder, which routes through the
 * shared `requestRegenerateSummary()` — same unsaved-edits + in-flight-LLM
 * guards as the existing `#regenerateSummaryBtn` in the Conversations card.
 *
 * In read-only modes (foreign / stale-rewritten) the CTA text and button
 * are omitted: the user can't act on Regenerate here (CSS hides the
 * button), so promising "Click Regenerate" would be a dead instruction.
 * The banner still renders so the user knows the summary is degraded.
 */
/**
 * True when the summary has content worth showing — a non-empty recap or at
 * least one topic, on this node or (for squash/amend containers) any child.
 * Used to decide whether a `summaryError` marker should still surface the hard
 * failure banner: a complete memory shouldn't read as broken just because a
 * later/secondary LLM attempt failed.
 */
function hasUsableContent(summary: CommitSummary): boolean {
	if ((summary.recap ?? "").trim().length > 0) return true;
	if ((summary.topics?.length ?? 0) > 0) return true;
	return (summary.children ?? []).some((child) => hasUsableContent(child));
}

export function buildSummaryErrorBanner(
	summary: CommitSummary,
	options: SummaryErrorBannerOptions = {},
): string {
	if (options.needsGeneration) {
		if (options.readOnly) {
			return `<div class="summary-error-banner" role="status">
  <span class="summary-error-banner-icon" aria-hidden="true">&#x2728;</span>
  <span class="summary-error-banner-text">No memory has been generated for this commit yet. Open its home repository to generate one.</span>
</div>`;
		}
		return `<div class="summary-error-banner" role="status">
  <span class="summary-error-banner-icon" aria-hidden="true">&#x2728;</span>
  <span class="summary-error-banner-text">No memory has been generated for this commit yet — this can happen if summarization was skipped or the AI service was unavailable. Generate one now.</span>
  <button class="summary-error-banner-action" id="generateMemoryBtn" title="Generate a memory from the diff and any saved AI conversations">&#x2728; Generate memory</button>
</div>`;
	}
	if (!isSummaryError(summary)) return "";
	// Soften: a transient/partial LLM failure (e.g. a 504 on a secondary call
	// after the main summarization already produced recap + topics) can leave
	// `summaryError` set on a summary that actually has usable content. Showing
	// a hard "generation failed / Regenerate" banner on a complete memory reads
	// as broken when it isn't. Suppress the banner when content is present —
	// Regenerate is still available from the panel's action row. The banner
	// remains for the genuinely-degraded case (summaryError + empty content,
	// which is the designed loud-failure state the queue worker writes).
	if (hasUsableContent(summary)) return "";
	if (options.readOnly) {
		return `<div class="summary-error-banner" role="status">
  <span class="summary-error-banner-icon" aria-hidden="true">&#x26A0;&#xFE0F;</span>
  <span class="summary-error-banner-text">Summary generation failed during the last attempt. Topics, recap and transcripts may be incomplete.</span>
</div>`;
	}
	return `<div class="summary-error-banner" role="status">
  <span class="summary-error-banner-icon" aria-hidden="true">&#x26A0;&#xFE0F;</span>
  <span class="summary-error-banner-text">Summary generation failed during the last attempt. Click Regenerate to try again — your transcripts, plans, and notes are preserved.</span>
  <button class="summary-error-banner-action" id="summaryErrorRegenerateBtn" title="Re-run the LLM end-to-end">&#x21BB; Regenerate</button>
</div>`;
}
