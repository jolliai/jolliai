/**
 * Shared squash consolidation pipeline: merges N source commit summaries into
 * one consolidated `{ topics, recap, ticketId, status }` result, via the LLM
 * (`generateSquashConsolidation`) with a mechanical fallback
 * (`mechanicalConsolidate`).
 *
 * Extracted out of `QueueWorker.runSquashPipeline` so `jolli repair-memory`
 * can share it -- the two callers need different failure policies:
 *
 *   - QueueWorker runs at commit time, fire-and-forget, with no retry.
 *     Losing the memory is unacceptable, so a failed LLM call must degrade
 *     to a mechanical merge (`onFailure: "mechanical"`).
 *   - repair-memory is interactive and re-runnable. Per the design spec it
 *     must throw and point the user at `--no-llm`, because a silent
 *     downgrade produces content that looks fine and is quietly worse
 *     (`onFailure: "throw"`).
 *
 * `useLlm: false` skips the LLM call entirely and returns the mechanical
 * result -- that is what `--no-llm` selects, and it is not a failure path.
 */
import { createLogger, errMsg } from "../Logger.js";
import type { CommitSummary } from "../Types.js";
import { loadConfig } from "./SessionTracker.js";
import {
	extractTicketIdFromMessage,
	generateSquashConsolidation,
	mechanicalConsolidate,
	type SquashConsolidationSource,
} from "./Summarizer.js";
import { isSummaryError, LLM_FAILED } from "./SummaryErrorMarker.js";
import { type ConsolidatedTopics, expandSourcesForConsolidation } from "./SummaryStore.js";

const log = createLogger("SquashConsolidation");

export type ConsolidationFailurePolicy = "mechanical" | "throw";

/**
 * Mechanical-fallback wrapper: `mechanicalConsolidate` itself returns no
 * `status` field (it is a pure data helper shared with other callers), so
 * this attaches `status: "mechanical"` and the source-state-inheritance
 * `summaryError` marker.
 */
/**
 * Source-input tallies returned alongside the consolidation so a caller that
 * only wants them for a log line (`runSquashPipeline`) does not re-run the
 * `expandSourcesForConsolidation` walk the consolidation already did. Describes
 * the INPUTS, not the merged result.
 */
export interface ConsolidationSourceStats {
	readonly sourceCount: number;
	readonly sourceTopicCount: number;
}

function sourceStats(sources: ReadonlyArray<SquashConsolidationSource>): ConsolidationSourceStats {
	return { sourceCount: sources.length, sourceTopicCount: sources.reduce((n, s) => n + s.topics.length, 0) };
}

function mechanical(
	sources: ReadonlyArray<SquashConsolidationSource>,
	outerTicketId: string | undefined,
	anySourceFailed: boolean,
): ConsolidatedTopics & { readonly status: "mechanical" } & ConsolidationSourceStats {
	return {
		...mechanicalConsolidate(sources, outerTicketId),
		status: "mechanical",
		...sourceStats(sources),
		...(anySourceFailed && { summaryError: LLM_FAILED }),
	};
}

/**
 * Consolidates `oldSummaries` (the stranded/squashed source commits) into one
 * `ConsolidatedTopics` result, tagged with how it was produced (`"llm"` or
 * `"mechanical"`).
 *
 * Source-state inheritance: if any source summary is already in a degraded
 * state (`isSummaryError`), the result is "merged from compromised inputs" --
 * `expandSourcesForConsolidation` drops `summaryError` from the source
 * contract (only carries topics/recap/ticketId/commitMessage), so the LLM
 * never sees the failure history and it must be OR'd in here, at the caller
 * level, exactly as `runSquashPipeline` did before the extraction.
 */
export async function consolidateSquashSources(
	oldSummaries: ReadonlyArray<CommitSummary>,
	commitMessage: string,
	opts: { readonly onFailure: ConsolidationFailurePolicy; readonly useLlm: boolean },
): Promise<ConsolidatedTopics & { readonly status: "llm" | "mechanical" } & ConsolidationSourceStats> {
	// Expand each source via expandSourcesForConsolidation: preserves per-commit
	// grouping for nested squash roots (so the LLM can apply rule 4 evidence).
	const sources: ReadonlyArray<SquashConsolidationSource> = oldSummaries.flatMap(expandSourcesForConsolidation);

	// Outer ticketId: the squash commit message often carries the explicit ticket
	// ("PROJ-123: ..."), which beats per-source ticketIds. extractTicketIdFromMessage
	// returns undefined when none is present, leaving the inner resolution chain
	// (earliest source -> LLM-extracted) to fill in.
	const outerTicketId = extractTicketIdFromMessage(commitMessage);

	const anySourceFailed = oldSummaries.some(isSummaryError);

	if (!opts.useLlm) {
		return mechanical(sources, outerTicketId, anySourceFailed);
	}

	// The whole outcome/policy branch below lives INSIDE this try, matching
	// runSquashPipeline's original boundary exactly: a bare property access
	// on a malformed `outcome` (e.g. an incomplete test double) must land in
	// the same catch as a genuine `loadConfig`/`generateSquashConsolidation`
	// throw, so both are governed by the same `opts.onFailure` policy rather
	// than one bypassing it.
	try {
		const config = await loadConfig();
		const outcome = await generateSquashConsolidation({
			squashCommitMessage: commitMessage,
			/* v8 ignore next */
			...(outerTicketId !== undefined && { ticketId: outerTicketId }),
			sources,
			config,
		});

		if (outcome.status === "ok") {
			return {
				topics: outcome.topics,
				...(outcome.recap !== undefined && { recap: outcome.recap }),
				...(outcome.ticketId !== undefined && { ticketId: outcome.ticketId }),
				llm: outcome.llm,
				status: "llm",
				...sourceStats(sources),
				...(anySourceFailed && { summaryError: LLM_FAILED }),
			};
		}

		// "llm-error" (both call attempts, including the strict retry, threw) is
		// the only non-"ok" status that is a real failure -- under the "throw"
		// policy it must surface, per the design spec ("squash LLM call fails"),
		// so it never reaches the unconditional-marker return below.
		if (outcome.status === "llm-error") {
			if (opts.onFailure === "throw") {
				throw new Error(
					"squash consolidation failed (llm-error) — re-run with --no-llm to merge mechanically instead",
				);
			}
			// Mechanical fallback preserves source content; unconditionally marks
			// the merged root (regardless of anySourceFailed) so the webview
			// banner fires -- this is a real failure, not inherited state.
			return mechanical(sources, outerTicketId, true);
		}

		// "no-content": no sources / all-empty sources / LLM self-reported
		// nothing to merge. Healthy case, NOT a failure -- must not throw even
		// under the "throw" policy (a repair whose stranded sources carry no
		// content has nothing an LLM retry or a --no-llm rerun could fix).
		// Marker only inherited when a source was already degraded.
		return mechanical(sources, outerTicketId, anySourceFailed);
	} catch (err) {
		if (opts.onFailure === "throw") {
			// Re-throws both our own deliberate policy throw above and any
			// genuine runtime error (e.g. loadConfig failing) -- repair-memory
			// must surface either as a failure, never silently degrade.
			throw err;
		}
		// Defensive: unexpected runtime error outside generateSquashConsolidation
		// (e.g. loadConfig throws). Treat as llm-error so the user sees a banner.
		log.warn("Squash consolidation failed (runtime), using mechanical merge: %s", errMsg(err));
		return mechanical(sources, outerTicketId, true);
	}
}
