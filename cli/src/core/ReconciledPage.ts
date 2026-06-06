/**
 * ReconciledPage — parses the reconcile LLM's delimited output into the fields
 * of a TopicPage. Reuses parseCompileResponse for the six standard fields and
 * extractField for the one new field (---SUMMARY---). The slug/title are taken
 * from the authoritative caller, not the LLM echo (mismatch → WARN).
 */

import { createLogger } from "../Logger.js";
import { extractField, parseCompileResponse } from "./KnowledgeCompiler.js";

const log = createLogger("ReconciledPage");

export interface ReconciledPage {
	readonly stableSlug: string;
	readonly title: string;
	readonly summary: string;
	readonly content: string;
	readonly keyDecisions?: string[];
	readonly relatedBranches?: string[];
	readonly sourceCommits: string[];
}

/**
 * Parses one reconcile response into a page. Returns null when no `===TOPIC===`
 * block parsed (caller treats that as a failed reconcile and keeps the old page).
 */
export function parseReconciledPage(
	response: string,
	authoritativeSlug: string,
	authoritativeTitle: string,
): ReconciledPage | null {
	const topics = parseCompileResponse(response);
	const topic = topics[0];

	// The reconcile LLM occasionally omits ---TITLE---; parseCompileResponse drops
	// title-less blocks, which would fail the whole page reconcile and re-burn an
	// LLM call every drain. Recover from the raw first block using the authoritative
	// title (which we already know) — only a block with no CONTENT is a real failure.
	if (!topic) {
		const rawBlock = response.split("===TOPIC===").find((b) => b.trim().length > 0) ?? "";
		const content = extractField(rawBlock, "CONTENT");
		if (!content) return null;
		return {
			stableSlug: authoritativeSlug,
			title: authoritativeTitle,
			summary: extractField(rawBlock, "SUMMARY"),
			content,
			sourceCommits: [],
		};
	}

	if (topic.stableSlug && topic.stableSlug !== authoritativeSlug) {
		log.warn("reconcile echoed slug %s, keeping authoritative %s", topic.stableSlug, authoritativeSlug);
	}

	// SUMMARY is the one field parseCompileResponse does not read -- pull it from
	// the first ===TOPIC=== block directly.
	const firstBlock = response.split("===TOPIC===")[1] ?? "";
	const summary = extractField(firstBlock, "SUMMARY");

	return {
		stableSlug: authoritativeSlug,
		// parseCompileResponse skips title-less blocks, so `topic.title` is always
		// non-empty here; the `|| authoritativeTitle` fallback is unreachable defensive
		// code kept as a guard against a future change to that contract.
		/* v8 ignore next */
		title: topic.title || authoritativeTitle,
		summary,
		content: topic.content,
		...(topic.keyDecisions && topic.keyDecisions.length > 0 && { keyDecisions: [...topic.keyDecisions] }),
		...(topic.relatedBranches &&
			topic.relatedBranches.length > 0 && { relatedBranches: [...topic.relatedBranches] }),
		sourceCommits: [...topic.sourceCommits],
	};
}
