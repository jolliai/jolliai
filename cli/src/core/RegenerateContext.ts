import type { CommitSummary } from "../Types.js";
import { normalizeToV4, readTranscriptsForCommits } from "./SummaryStore.js";
import { collectAllTranscriptHashes } from "./SummaryTree.js";
import { transcriptSourceLabel } from "./TranscriptSourceLabel.js";

/**
 * Counts and source list shown to the user in the regenerate-summary confirm
 * dialog. Aggregated across the ENTIRE summary tree (root + all descendants)
 * so squash / amend / rebase commits report the same number of transcripts
 * the user sees in the webview's All Conversations card.
 *
 * Sessions are deduped by `${source}:${sessionId}`: the same AI session may
 * persist into multiple commit transcripts (e.g. squash slices a single
 * Claude session across N commits), and the webview already collapses those
 * via the same key (see `SummaryWebviewPanel` conversations-stats logic).
 * Entries are NOT deduped — each commit transcript holds a different slice
 * of the session, and the union equals the full conversation.
 *
 * Attachment counts (plans / notes / linearIssues) read the NORMALIZED root
 * after `normalizeToV4`, so v3 legacy summaries whose attachments lived on
 * a child still report the correct numbers.
 *
 * Returns zero-valued counts (NOT null) when no transcript was persisted for
 * any commit in the tree — the regenerate path still runs in that case, just
 * with an empty conversation. The confirm dialog adjusts copy on
 * entryCount === 0.
 */
export interface RegenerateContext {
	readonly entryCount: number;
	readonly sessionCount: number;
	readonly sources: ReadonlyArray<string>;
	readonly humanTurns: number;
	readonly plansCount: number;
	readonly notesCount: number;
	readonly linearCount: number;
}

export async function loadRegenerateContext(summary: CommitSummary, cwd: string): Promise<RegenerateContext> {
	const normalized = normalizeToV4(summary);
	const treeHashes = collectAllTranscriptHashes(normalized);
	const transcriptMap = await readTranscriptsForCommits(treeHashes, cwd);

	let entryCount = 0;
	let humanTurns = 0;
	const seenSessions = new Set<string>();
	const sourceSet = new Set<string>();
	for (const stored of transcriptMap.values()) {
		for (const session of stored.sessions) {
			entryCount += session.entries.length;
			for (const entry of session.entries) {
				if (entry.role === "human") humanTurns++;
			}
			const sourceKey = session.source ?? "claude";
			seenSessions.add(`${sourceKey}:${session.sessionId}`);
			sourceSet.add(transcriptSourceLabel(session.source));
		}
	}

	return {
		entryCount,
		sessionCount: seenSessions.size,
		sources: Array.from(sourceSet),
		humanTurns,
		plansCount: normalized.plans?.length ?? 0,
		notesCount: normalized.notes?.length ?? 0,
		linearCount: normalized.linearIssues?.length ?? 0,
	};
}
