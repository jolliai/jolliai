import { createLogger } from "../Logger.js";
import type { CommitSummary, LlmConfig, SummaryResult } from "../Types.js";
import { getDiffContent } from "./GitOps.js";
import { generateSummary } from "./Summarizer.js";
import {
	normalizeToV4,
	readLinearIssueFromBranch,
	readNoteFromBranch,
	readPlanFromBranch,
	readTranscriptsForCommits,
} from "./SummaryStore.js";
import { collectAllTranscriptHashes } from "./SummaryTree.js";
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
 *                         commitType, commitSource, jolliDocUrl, jolliDocId,
 *                         orphanedDocIds, everything else on root.
 *
 * The function opens by calling `normalizeToV4(summary)` — a pure helper
 * that collapses every v3-special-case into the v4 unified-Hoist invariant
 * the rest of the regenerate path depends on:
 *   - root holds the authoritative Copy-Hoist fields (unioned across the
 *     whole tree, so child-only attachments and pending-cleanup doc IDs are
 *     surfaced to root)
 *   - every descendant is stripped of own-hoist fields
 *   - version is 4
 *
 * Downstream code (transcript aggregation, prompt-block rebuild, LLM
 * generation, updated-summary assembly) then assumes v4 without further
 * special-casing.
 *
 * Transcript aggregation:
 *   - Reads transcripts for EVERY commit hash in the (normalized) summary
 *     tree via `collectAllTranscriptHashes` + `readTranscriptsForCommits`.
 *     Squash / amend / rebase summaries persist AI conversations under each
 *     source commit's hash; reading only `summary.commitHash` would feed an
 *     empty conversation to the LLM. Mirrors the webview's All Conversations
 *     card (`SummaryWebviewPanel.refreshTranscriptHashes`).
 *
 * Preservation of ticketId and e2eTestGuide is deliberate (see plan §1.2):
 *   - ticketId is a stable identifier; the LLM may not see the original
 *     ticket ID in this re-run and would otherwise drop or change it.
 *   - e2eTestGuide is a user-initiated secondary artifact; the user can
 *     regenerate it independently. Note that `normalizeToV4` may surface a
 *     child-only e2e to root — that's the deferred-migration completing,
 *     not a behavior change.
 */
export async function regenerateSummary(
	summary: CommitSummary,
	cwd: string,
	config: LlmConfig,
): Promise<RegenerateResult> {
	log.info("Regenerating summary for %s", summary.commitHash.substring(0, 8));

	// One-shot v3 → v4 normalization; the rest of this function reads from
	// `normalized` and assumes the v4 invariant. No-op for v4 input.
	const normalized = normalizeToV4(summary);

	// Aggregate transcripts across the entire tree (see "Transcript aggregation"
	// in the doc comment above).
	const treeHashes = collectAllTranscriptHashes(normalized);
	const transcriptMap = await readTranscriptsForCommits(treeHashes, cwd);
	const sessions: SessionTranscript[] = [];
	for (const stored of transcriptMap.values()) {
		for (const s of stored.sessions) {
			sessions.push({
				sessionId: s.sessionId,
				transcriptPath: s.transcriptPath ?? "(stored)",
				...(s.source !== undefined ? { source: s.source } : {}),
				entries: s.entries,
			});
		}
	}
	const conversation = buildMultiSessionContext(sessions);
	const diff = await getDiffContent(`${normalized.commitHash}~1`, normalized.commitHash, cwd);

	const [linearIssues, plans, notes] = await Promise.all([
		rebuildLinearBlock(normalized, cwd),
		rebuildPlansBlock(normalized, cwd),
		rebuildNotesBlock(normalized, cwd),
	]);

	const totalEntries = sessions.reduce((sum, s) => sum + s.entries.length, 0);
	const humanTurns = sessions.reduce((sum, s) => sum + s.entries.filter((e) => e.role === "human").length, 0);

	const result = await generateSummary({
		conversation,
		diff,
		commitInfo: {
			hash: normalized.commitHash,
			message: normalized.commitMessage,
			author: normalized.commitAuthor,
			date: normalized.commitDate,
		},
		// Fallback chain: v4 stores `diffStats`; v3 legacy stored `stats`
		// (resolveDiffStats elsewhere does the same fallback for display).
		// normalizeToV4 doesn't touch either field, so a freshly-normalized
		// v3 still has only `stats` populated until the LLM call below
		// returns a fresh diffStats we overwrite with.
		diffStats: normalized.diffStats ?? normalized.stats ?? { filesChanged: 0, insertions: 0, deletions: 0 },
		transcriptEntries: totalEntries,
		conversationTurns: humanTurns,
		linearIssues,
		plans,
		notes,
		config,
	});

	const updated: CommitSummary = {
		...normalized,
		topics: result.topics,
		// Always overwrite recap — confirm dialog promises Recap is OVERWRITTEN.
		// Empty string communicates "no recap this time" when the LLM omits one,
		// instead of silently preserving the prior recap.
		recap: result.recap ?? "",
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
//
// All three helpers receive a NORMALIZED summary, so root.{plans,notes,
// linearIssues} are already the authoritative tree-wide union.

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
