/**
 * SummaryProjection — Projects a stored {@link CommitSummary} down to the
 * outward-facing {@link SearchHit} shape consumed by both jolli-search Phase 2
 * and jolli-recall.
 *
 * Two reasons this lives in its own module rather than inside
 * `LocalSearchProvider`:
 *   1. Recall is not a "search provider" — putting the projection under the
 *      Search-namespaced provider would force recall to import from a
 *      misleadingly named source. `SummaryProjection` reads cleanly as
 *      "convert a summary into the public hit shape" and makes no claim about
 *      where the summary came from or how it was selected.
 *   2. The projection is the precise contract surface between stored data
 *      (CommitSummary, with full topic + plan + note tree) and exposed data
 *      (SearchHit + stub refs). Sharing a single implementation prevents
 *      search and recall from drifting on what gets shipped vs stripped.
 *
 * Plan/note stubs use the **base slug** (archive-suffix stripped) so the same
 * logical plan cited from a pre-archive commit and a post-archive commit
 * resolves to one canonical entry in {@link RecallPayload.plans}.
 */

import type { CommitSummary } from "../Types.js";
import { extractBaseSlug } from "./PlanSlug.js";
import type { SearchHit, SearchHitTopic } from "./Search.js";
import { collectAllNotesWithHosts, collectAllPlansWithHosts } from "./SummaryFormat.js";
import { collectDisplayTopics } from "./SummaryTree.js";

/**
 * Builds a {@link SearchHit} from a stored {@link CommitSummary}.
 *
 * Walks the summary tree via {@link collectDisplayTopics} so legacy v3 data
 * with topics in nested children comes out flattened. Strips internal /
 * pushed-doc metadata (commitSource, transcriptEntries, llm, treeHash,
 * jolliDocId/Url, …) and large unrelated payloads (e2eTestGuide); see the
 * SearchHit doc for the full omit rationale.
 */
export function buildHit(summary: CommitSummary): SearchHit {
	const topics: SearchHitTopic[] = collectDisplayTopics(summary).map(
		(t) =>
			({
				title: t.title,
				...(t.trigger !== undefined && { trigger: t.trigger }),
				...(t.response !== undefined && { response: t.response }),
				decisions: t.decisions,
				...(t.todo !== undefined && { todo: t.todo }),
				...(t.filesAffected && t.filesAffected.length > 0 && { filesAffected: t.filesAffected }),
				...(t.category !== undefined && { category: t.category }),
				...(t.importance !== undefined && { importance: t.importance }),
			}) satisfies SearchHitTopic,
	);

	const planStubs = dedupeBySlug(
		collectAllPlansWithHosts(summary).map(({ planRef, hostCommitHash }) => ({
			slug: extractBaseSlug(planRef.slug, hostCommitHash),
			title: planRef.title,
		})),
	);

	// Note: no dedup pass needed here. `collectAllNotesWithHosts` already dedups
	// by note id at the Map level, and notes have no archive-suffix mechanism
	// like plans, so the (id, title) tuples here are guaranteed unique.
	const noteStubs = collectAllNotesWithHosts(summary).map(({ noteRef }) => ({
		id: noteRef.id,
		title: noteRef.title,
	}));

	return {
		hash: summary.commitHash.substring(0, 8),
		fullHash: summary.commitHash,
		commitMessage: summary.commitMessage,
		commitAuthor: summary.commitAuthor,
		commitDate: summary.commitDate,
		branch: summary.branch,
		...(summary.commitType !== undefined && { commitType: summary.commitType }),
		...(summary.ticketId && { ticketId: summary.ticketId }),
		...(summary.diffStats !== undefined && { diffStats: summary.diffStats }),
		...(summary.recap && { recap: summary.recap }),
		topics,
		...(planStubs.length > 0 && { plans: planStubs }),
		...(noteStubs.length > 0 && { notes: noteStubs }),
	};
}

function dedupeBySlug<T extends { slug: string }>(items: ReadonlyArray<T>): ReadonlyArray<T> {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of items) {
		if (seen.has(item.slug)) continue;
		seen.add(item.slug);
		out.push(item);
	}
	return out;
}
