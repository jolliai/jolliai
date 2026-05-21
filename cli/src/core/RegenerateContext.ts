import type { CommitSummary } from "../Types.js";
import { readTranscript } from "./SummaryStore.js";
import { transcriptSourceLabel } from "./TranscriptSourceLabel.js";

/**
 * Counts and source list shown to the user in the regenerate-summary confirm
 * dialog. Computed from the persisted transcript on the orphan branch plus
 * the summary's own attached-artifact references.
 *
 * Returns zero-valued counts (NOT null) when no transcript was persisted for
 * the commit — the regenerate path still runs in that case, just with an
 * empty conversation. The confirm dialog adjusts copy on entryCount === 0.
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
	const stored = await readTranscript(summary.commitHash, cwd);

	let entryCount = 0;
	let humanTurns = 0;
	const sourceSet = new Set<string>();
	const sessions = stored?.sessions ?? [];
	for (const session of sessions) {
		entryCount += session.entries.length;
		for (const entry of session.entries) {
			if (entry.role === "human") humanTurns++;
		}
		sourceSet.add(transcriptSourceLabel(session.source));
	}

	return {
		entryCount,
		sessionCount: sessions.length,
		sources: Array.from(sourceSet),
		humanTurns,
		plansCount: summary.plans?.length ?? 0,
		notesCount: summary.notes?.length ?? 0,
		linearCount: summary.linearIssues?.length ?? 0,
	};
}
