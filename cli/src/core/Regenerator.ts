import { createLogger } from "../Logger.js";
import type { CommitSummary, LlmConfig, Reference, ReferenceCommitRef, SourceId } from "../Types.js";
import { getDiffContent } from "./GitOps.js";
import { escapeForAttr, escapeForText } from "./PromptXmlEscape.js";
import { truncate } from "./references/ReferenceExtractor.js";
import { readReferenceMarkdownFromString } from "./references/ReferenceStore.js";
import { ALL_ADAPTERS } from "./references/sources/index.js";
import type { StorageProvider } from "./StorageProvider.js";
import { generateSummary, type SummaryResult } from "./Summarizer.js";
import {
	normalizeToV4,
	readNoteFromBranch,
	readPlanFromBranch,
	readReferenceFromBranch,
	readTranscriptsForCommits,
} from "./SummaryStore.js";
import { getTranscriptIds } from "./SummaryTree.js";
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
 * Fields preserved:       ticketId, e2eTestGuide, plans, notes, references,
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
	storage?: StorageProvider,
): Promise<RegenerateResult> {
	log.info("Regenerating summary for %s", summary.commitHash.substring(0, 8));

	// One-shot v3 → v4 normalization; the rest of this function reads from
	// `normalized` and assumes the v4 invariant. No-op for v4 input.
	const normalized = normalizeToV4(summary);

	// Aggregate transcripts across the entire tree (see "Transcript aggregation"
	// in the doc comment above). `storage` is threaded so folder-only Memory
	// Bank users read from FolderStorage instead of the OrphanBranchStorage
	// fallback in resolveStorage — without it the LLM would see an empty
	// conversation on every regenerate in folder-only mode.
	//
	// v5 schema: `getTranscriptIds` returns `summary.transcripts` (the v5
	// authoritative ID array) when present, else falls back to walking
	// children for v3/v4 data — both forms read correctly.
	const transcriptIds = getTranscriptIds(normalized);
	const transcriptMap = await readTranscriptsForCommits(transcriptIds, cwd, storage);
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

	const [referenceBlocks, plans, notes] = await Promise.all([
		rebuildReferenceBlocks(normalized, cwd, storage),
		rebuildPlansBlock(normalized, cwd, storage),
		rebuildNotesBlock(normalized, cwd, storage),
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
		referenceBlocks,
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
		...(normalized.conversationTokens !== undefined ? { conversationTokens: normalized.conversationTokens } : {}),
		diffStats: result.stats,
		generatedAt: new Date().toISOString(),
		// Successful regenerate clears any stale failure marker so the
		// webview banner disappears on the next render. Explicit undefined
		// instead of leaving the spread-in value alone: JSON.stringify
		// drops undefined keys, so storeSummary persists a healthy summary.
		summaryError: undefined,
	};

	return { updated, result };
}

// ─── Prompt-block reconstruction from orphan-branch archives ────────────────
//
// These helpers intentionally build a SIMPLIFIED XML block rather than reusing
// the existing prompt formatters. The formatters read content via
// `entry.sourcePath` (disk file paths), but on regenerate we want the orphan-
// branch archive as the system of record — sourcePath may be stale or missing.
// The simplified block preserves the source-agnostic tag shape so the
// SUMMARIZE prompt template's placeholders collapse the same way.
//
// All helpers receive a NORMALIZED summary, so root.{plans, notes, references}
// are already the authoritative tree-wide union.

// Budgets — must stay aligned with the first-run formatters byte-for-byte.
// See PlanPromptFormatter.ts:18-19, NotePromptFormatter.ts:18-19, and
// ReferenceExtractor.ts:57-58 for the source-of-truth defaults. Without
// these caps a single pathologically large plan / note / linear issue could
// blow out the SUMMARIZE prompt's token budget and inflate cost. Drifting
// from first-run also makes summary-quality A/B comparison apples-to-oranges
// because the LLM sees different input shapes on the two paths.
const PLAN_MAX_CHARS = 20000;
const PLAN_TOTAL_CHARS = 60000;
const NOTE_MAX_CHARS = 4000;
const NOTE_TOTAL_CHARS = 12000;

/**
 * Multi-source reference-block reconstruction for regenerate.
 *
 * Reads each `ReferenceCommitRef` archived for this commit straight from the
 * orphan branch, parses the markdown frontmatter back to a `Reference`,
 * then groups by source and delegates rendering to the same `SourceAdapter`s
 * the first-run path uses. The resulting blocks are concatenated in stable
 * adapter-registration order (`ALL_ADAPTERS`), so the LLM sees byte-identical
 * output to the first-run path for single-source commits.
 *
 * Missing orphan-branch markdown for a single reference is silently skipped
 * (with a warn log) so a half-migrated archive doesn't fail the whole
 * regenerate.
 */
async function rebuildReferenceBlocks(
	summary: CommitSummary,
	cwd: string,
	storage: StorageProvider | undefined,
): Promise<string> {
	const refs: ReadonlyArray<ReferenceCommitRef> = summary.references ?? [];
	if (refs.length === 0) return "";

	const bySource = new Map<SourceId, Reference[]>();
	for (const ref of refs) {
		const md = await readReferenceFromBranch(ref.source, ref.archivedKey, cwd, storage);
		if (md === null) {
			log.warn(
				"rebuildReferenceBlocks: orphan-branch markdown missing for %s (%s) — skipping",
				ref.archivedKey,
				ref.source,
			);
			continue;
		}
		const parsed = readReferenceMarkdownFromString(md);
		// Defensive `?? ""` against legacy fixtures missing the field —
		// adapters call .replace() / .localeCompare() on these values and
		// would crash on undefined. Behavior matches the pre-refactor
		// rebuildLinearBlock which used the same `?? ""` defaults.
		const safeTitle = ref.title ?? "";
		const safeUrl = ref.url ?? "";
		const safeReferencedAt = ref.referencedAt ?? "";
		const safeToolName = ref.sourceToolName ?? "";
		let reference: Reference;
		if (parsed !== null) {
			// Pass the parsed description through untruncated: the adapter's
			// renderPromptBlock applies the single per-reference truncation, so
			// regenerate output stays byte-identical to the first-run path (which
			// also truncates exactly once, inside the adapter). Pre-truncating
			// here would double-cut an oversized body and emit a wrong
			// "…[truncated, N more chars]" count.
			reference = {
				...parsed,
				// Override identity / metadata from the commit-time ref so
				// title / url changes since archival don't leak into the
				// prompt, mirroring the first-run path which uses the
				// extractor's snapshot.
				title: safeTitle,
				url: safeUrl,
				referencedAt: safeReferencedAt,
				toolName: safeToolName,
				...(ref.fields !== undefined && ref.fields.length > 0 ? { fields: ref.fields } : {}),
			};
		} else {
			// Markdown frontmatter unparseable (corrupted or older shape):
			// synthesise a minimal Reference from the commit-time metadata
			// and embed the raw body as description so the LLM still sees
			// something. Mirrors the legacy rebuildLinearBlock fallback that
			// wrapped raw markdown in `<archived-markdown>`.
			reference = {
				mapKey: ref.archivedKey,
				source: ref.source,
				nativeId: ref.nativeId,
				title: safeTitle,
				url: safeUrl,
				referencedAt: safeReferencedAt,
				toolName: safeToolName,
				// Raw body passed through untruncated — the adapter applies the
				// single per-reference truncation, same as the parsed path, so the
				// "…[truncated, N more chars]" count is correct here too.
				description: md,
				...(ref.fields !== undefined && ref.fields.length > 0 ? { fields: ref.fields } : {}),
			};
		}
		const bucket = bySource.get(ref.source);
		if (bucket) bucket.push(reference);
		else bySource.set(ref.source, [reference]);
	}

	const blocks: string[] = [];
	for (const adapter of ALL_ADAPTERS) {
		const sourceRefs = bySource.get(adapter.id);
		if (!sourceRefs || sourceRefs.length === 0) continue;
		const block = adapter.renderPromptBlock(sourceRefs);
		/* v8 ignore start -- adapter.renderPromptBlock returns "" only when refs is empty (we skip that above) or when every ref exceeds the total budget; defensive append-guard for a corner case that never fires in practice. */
		if (block.length > 0) blocks.push(block);
		/* v8 ignore stop */
	}
	return blocks.join("\n");
}

async function rebuildPlansBlock(
	summary: CommitSummary,
	cwd: string,
	storage: StorageProvider | undefined,
): Promise<string> {
	const refs = summary.plans ?? [];
	if (refs.length === 0) return "";
	const sorted = [...refs].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

	const rendered: string[] = [];
	let totalLen = 0;
	for (const ref of sorted) {
		const md = await readPlanFromBranch(ref.slug, cwd, storage);
		if (md === null) continue;
		const body = truncate(md, PLAN_MAX_CHARS);
		const block = [
			`<plan slug="${escapeForAttr(ref.slug)}" title="${escapeForAttr(ref.title)}">`,
			escapeForText(body),
			"</plan>",
		].join("\n");
		if (totalLen + block.length > PLAN_TOTAL_CHARS) break;
		rendered.push(block);
		totalLen += block.length;
	}
	if (rendered.length === 0) return "";
	return `<plans>\n${rendered.join("\n")}\n</plans>`;
}

async function rebuildNotesBlock(
	summary: CommitSummary,
	cwd: string,
	storage: StorageProvider | undefined,
): Promise<string> {
	const refs = summary.notes ?? [];
	if (refs.length === 0) return "";
	const sorted = [...refs].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

	const rendered: string[] = [];
	let totalLen = 0;
	for (const ref of sorted) {
		const md = await readNoteFromBranch(ref.id, cwd, storage);
		if (md === null) continue;
		const body = truncate(md, NOTE_MAX_CHARS);
		const block = [
			`<note id="${escapeForAttr(ref.id)}" title="${escapeForAttr(ref.title)}">`,
			escapeForText(body),
			"</note>",
		].join("\n");
		if (totalLen + block.length > NOTE_TOTAL_CHARS) break;
		rendered.push(block);
		totalLen += block.length;
	}
	if (rendered.length === 0) return "";
	return `<notes>\n${rendered.join("\n")}\n</notes>`;
}
