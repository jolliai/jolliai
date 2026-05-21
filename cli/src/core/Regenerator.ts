import { createLogger } from "../Logger.js";
import type { CommitSummary, LlmConfig, SummaryResult } from "../Types.js";
import { getDiffContent } from "./GitOps.js";
import { generateSummary } from "./Summarizer.js";
import { readLinearIssueFromBranch, readNoteFromBranch, readPlanFromBranch, readTranscript } from "./SummaryStore.js";
import { buildMultiSessionContext, type SessionTranscript } from "./TranscriptReader.js";

const log = createLogger("Regenerator");

export interface RegenerateResult {
	readonly updated: CommitSummary;
	readonly result: SummaryResult;
}

/**
 * End-to-end re-run of the summary LLM for an already-summarized commit.
 *
 * Reads inputs straight from the orphan branch (transcripts, archived plans /
 * notes / linear issues) and rebuilds the commit diff via `git show`. No
 * disk-side registries are consulted, no archives are re-written, and no
 * cursors / locks / queue entries are touched — see the plan's §1.6 isolation
 * matrix. The single side effect this returns is the updated CommitSummary
 * that callers pass to `storeSummary(_, _, true)` (force=true).
 *
 * Fields replaced:        topics, recap, diffStats, transcriptEntries,
 *                         conversationTurns, llm, generatedAt
 * Fields preserved:       ticketId, e2eTestGuide, plans, notes, linearIssues,
 *                         children, commitType, commitSource, jolliDocUrl,
 *                         jolliDocId, orphanedDocIds, everything else.
 *
 * Preservation of ticketId and e2eTestGuide is deliberate (see plan §1.2):
 *   - ticketId is a stable identifier; the LLM may not see the original ticket
 *     ID in this re-run and would otherwise drop or change it.
 *   - e2eTestGuide is a user-initiated secondary artifact; the user can
 *     regenerate it independently if they want.
 */
export async function regenerateSummary(
	summary: CommitSummary,
	cwd: string,
	config: LlmConfig,
): Promise<RegenerateResult> {
	log.info("Regenerating summary for %s", summary.commitHash.substring(0, 8));

	const stored = await readTranscript(summary.commitHash, cwd);

	const sessions: SessionTranscript[] = (stored?.sessions ?? []).map((s) => ({
		sessionId: s.sessionId,
		transcriptPath: s.transcriptPath ?? "(stored)",
		...(s.source !== undefined ? { source: s.source } : {}),
		entries: s.entries,
	}));
	const conversation = buildMultiSessionContext(sessions);
	const diff = await getDiffContent(`${summary.commitHash}~1`, summary.commitHash, cwd);

	const [linearIssues, plans, notes] = await Promise.all([
		rebuildLinearBlock(summary, cwd),
		rebuildPlansBlock(summary, cwd),
		rebuildNotesBlock(summary, cwd),
	]);

	const totalEntries = sessions.reduce((sum, s) => sum + s.entries.length, 0);
	const humanTurns = sessions.reduce((sum, s) => sum + s.entries.filter((e) => e.role === "human").length, 0);

	const result = await generateSummary({
		conversation,
		diff,
		commitInfo: {
			hash: summary.commitHash,
			message: summary.commitMessage,
			author: summary.commitAuthor,
			date: summary.commitDate,
		},
		diffStats: summary.diffStats ?? summary.stats ?? { filesChanged: 0, insertions: 0, deletions: 0 },
		transcriptEntries: totalEntries,
		conversationTurns: humanTurns,
		linearIssues,
		plans,
		notes,
		config,
	});

	const updated: CommitSummary = {
		...summary,
		topics: result.topics,
		...(result.recap !== undefined ? { recap: result.recap } : {}),
		llm: result.llm,
		transcriptEntries: result.transcriptEntries,
		...(result.conversationTurns !== undefined ? { conversationTurns: result.conversationTurns } : {}),
		diffStats: result.stats,
		generatedAt: new Date().toISOString(),
	};

	return { updated, result };
}

// ─── Prompt-block reconstruction from orphan-branch archives ────────────────
//
// These helpers intentionally build a SIMPLIFIED XML block rather than reusing
// `formatPlansBlock` / `formatNotesBlock` / `formatLinearIssuesBlock`. The
// existing formatters read content via `entry.sourcePath` (disk file paths),
// but on regenerate we want the orphan-branch archive as the system of record
// — sourcePath may be stale or missing. The simplified block preserves the
// tag shape (`<plans>`, `<notes>`, `<linear-issues>`) so the SUMMARIZE prompt
// template's placeholders collapse the same way.

async function rebuildLinearBlock(summary: CommitSummary, cwd: string): Promise<string> {
	const refs = summary.linearIssues ?? [];
	if (refs.length === 0) return "";
	const rendered: string[] = [];
	for (const ref of refs) {
		const md = await readLinearIssueFromBranch(ref.archivedKey, cwd);
		if (md === null) continue;
		rendered.push(
			[
				`<issue id="${escapeAttr(ref.ticketId)}">`,
				`  <title>${escapeText(ref.title)}</title>`,
				`  <url>${escapeText(ref.url)}</url>`,
				"  <archived-markdown>",
				escapeText(md),
				"  </archived-markdown>",
				"</issue>",
			].join("\n"),
		);
	}
	if (rendered.length === 0) return "";
	return `<linear-issues>\n${rendered.join("\n")}\n</linear-issues>`;
}

async function rebuildPlansBlock(summary: CommitSummary, cwd: string): Promise<string> {
	const refs = summary.plans ?? [];
	if (refs.length === 0) return "";
	const rendered: string[] = [];
	for (const ref of refs) {
		const md = await readPlanFromBranch(ref.slug, cwd);
		if (md === null) continue;
		rendered.push(
			[`<plan slug="${escapeAttr(ref.slug)}" title="${escapeAttr(ref.title)}">`, escapeText(md), "</plan>"].join(
				"\n",
			),
		);
	}
	if (rendered.length === 0) return "";
	return `<plans>\n${rendered.join("\n")}\n</plans>`;
}

async function rebuildNotesBlock(summary: CommitSummary, cwd: string): Promise<string> {
	const refs = summary.notes ?? [];
	if (refs.length === 0) return "";
	const rendered: string[] = [];
	for (const ref of refs) {
		const md = await readNoteFromBranch(ref.id, cwd);
		if (md === null) continue;
		rendered.push(
			[`<note id="${escapeAttr(ref.id)}" title="${escapeAttr(ref.title)}">`, escapeText(md), "</note>"].join(
				"\n",
			),
		);
	}
	if (rendered.length === 0) return "";
	return `<notes>\n${rendered.join("\n")}\n</notes>`;
}

function escapeAttr(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function escapeText(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
