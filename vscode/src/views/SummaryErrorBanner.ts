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
export function buildSummaryErrorBanner(
	summary: CommitSummary,
	options: SummaryErrorBannerOptions = {},
): string {
	if (!isSummaryError(summary)) return "";
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
