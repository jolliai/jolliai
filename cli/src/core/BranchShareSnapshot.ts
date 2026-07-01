/**
 * BranchShareSnapshot
 *
 * Assembles the public-share snapshot from the summaries that are ALREADY
 * generated for the branch — the same `base..HEAD` set the Memories panel / PR
 * description use (via `loadBranchSummaries`). Branch membership and reachability
 * are NOT re-derived here: that is the shared reader's job, so a `git reset
 * --hard` / dropped commit / force-push / rename can't leak commits that are no
 * longer on the branch into a public share, and the share stays consistent with
 * what the user sees in the panel.
 *
 * Two share kinds, selected by `options.commitHash`:
 *  - **branch share** (no `commitHash`): every commit's summary on the branch,
 *    organized by commit (chronological, oldest-first).
 *  - **commit share** (`commitHash` set): just that one commit's summary, drawn
 *    from the same branch set (so the "still on the branch" guarantee holds).
 *
 * Scope is **summary + plan + note, never transcripts/conversations** —
 * `buildMarkdown` emits only a conversation-turn *count*, no conversation
 * content, and plans/notes are embedded unless the caller opts out. Conversations
 * are layered in on the recipient side from local data (see the share viewer), so
 * they must never reach this cloud snapshot.
 */

import type { CommitSummary } from "../Types.js";
import { getDefaultBranch } from "./GitOps.js";
import { escHtml } from "./MarkdownEscape.js";
import { loadBranchSummaries } from "./PrDescription.js";
import { buildMarkdown } from "./SummaryMarkdownBuilder.js";
import { readNoteFromBranch, readPlanFromBranch, resolveEffectiveTopics } from "./SummaryStore.js";

export interface BranchShareSnapshotOptions {
	/** Embed plans as expandable sections. Defaults to true. */
	readonly includePlans?: boolean;
	/** Embed notes as expandable sections. Defaults to true. */
	readonly includeNotes?: boolean;
	/**
	 * Restrict the snapshot to a single commit's summary (commit share). When
	 * omitted, every commit on the branch is included (branch share).
	 */
	readonly commitHash?: string;
}

export interface BranchShareSnapshot {
	/** Branch label (the share's key); sourcing is HEAD-based, so this is the current branch. */
	readonly branch: string;
	/** Newest included summary — the snapshot's identity; drives the staleness check. */
	readonly headCommitHash: string;
	/** Included commit hashes, chronological (oldest first). */
	readonly commitHashes: ReadonlyArray<string>;
	/** Sum of effective topics across the included summaries — the "N decisions" headline. */
	readonly decisionCount: number;
	/** A few distinct decision titles across the whole branch — teaser for share copy. */
	readonly titles: ReadonlyArray<string>;
	/**
	 * Rendered Markdown, chronological: per-commit summaries followed by a
	 * "Plans & Notes" section embedding each plan/note as a collapsible
	 * `<details>` block (title visible, content expandable). Never includes
	 * transcripts/conversations.
	 */
	readonly content: string;
}

/**
 * The branch's generated summaries (`base..HEAD`, chronological oldest-first) —
 * the single source of truth shared with the Memories panel / PR path. Empty
 * when nothing is summarized on the branch.
 *
 * When `commitHash` is given (commit share), the result is filtered to just that
 * commit — still drawn from the branch set, so a commit no longer on the branch
 * yields an empty result (nothing shareable) rather than a stale leak.
 */
async function loadShareSummaries(cwd?: string, commitHash?: string): Promise<ReadonlyArray<CommitSummary>> {
	const baseBranch = await getDefaultBranch(cwd);
	const { summaries } = await loadBranchSummaries(cwd ?? "", baseBranch);
	return commitHash ? summaries.filter((s) => s.commitHash === commitHash) : summaries;
}

/**
 * Builds the share snapshot for `branch`, or `null` when the branch has no
 * generated summaries (nothing shareable).
 */
export async function assembleBranchShareSnapshot(
	branch: string,
	cwd?: string,
	options?: BranchShareSnapshotOptions,
): Promise<BranchShareSnapshot | null> {
	const chronological = await loadShareSummaries(cwd, options?.commitHash);
	if (chronological.length === 0) return null;

	const topicsByCommit = chronological.map((s) => resolveEffectiveTopics(s));
	const decisionCount = topicsByCommit.reduce((total, topics) => total + topics.length, 0);
	// A few distinct decision titles across the whole branch (not just one commit),
	// so share copy teases the branch's headline decisions.
	const titles = [
		...new Set(topicsByCommit.flatMap((topics) => topics.map((t) => t.title.trim())).filter((t) => t.length > 0)),
	].slice(0, 5);

	const includePlans = options?.includePlans ?? true;
	const includeNotes = options?.includeNotes ?? true;

	// Per-commit summaries with the inline plan/note title list stripped — each
	// plan/note renders once below as an expandable section (title + content),
	// so the recipient page can expand it in place without duplication.
	const perCommit = chronological.map((s) => buildMarkdown(stripAttachments(s)));
	const attachments = await buildAttachmentsSection(chronological, includePlans, includeNotes, cwd);
	const content = [perCommit.join("\n\n---\n\n"), attachments].filter((part) => part.length > 0).join("\n\n---\n\n");

	// Head = newest included summary (chronological is oldest-first). The staleness
	// check compares this to the same value recomputed on reopen, so a new commit
	// advances it (and fires stale) exactly once its summary is generated.
	const headCommitHash = chronological[chronological.length - 1].commitHash;
	const commitHashes = chronological.map((s) => s.commitHash);

	return { branch, headCommitHash, commitHashes, decisionCount, titles, content };
}

/**
 * The head used for the staleness check, WITHOUT building content. Same source as
 * the snapshot, so create-time and reopen-time heads agree by construction.
 * `undefined` when the branch (or specified commit) has no shareable summary.
 *
 * For a commit share (`commitHash` set) the head is that commit, so the share is
 * frozen and never reads as stale — only branch shares advance with new commits.
 */
export async function resolveShareHead(
	_branch: string,
	cwd?: string,
	commitHash?: string,
): Promise<string | undefined> {
	const chronological = await loadShareSummaries(cwd, commitHash);
	return chronological.length > 0 ? chronological[chronological.length - 1].commitHash : undefined;
}

/** Returns a shallow copy of `summary` with plan + note references removed. */
function stripAttachments(summary: CommitSummary): CommitSummary {
	const hasPlans = summary.plans && summary.plans.length > 0;
	const hasNotes = summary.notes && summary.notes.length > 0;
	if (!hasPlans && !hasNotes) return summary;
	const { plans: _plans, notes: _notes, ...rest } = summary;
	return rest;
}

/**
 * Builds the "Plans & Notes" section: each unique plan/note as a collapsible
 * `<details>` block (title = visible summary, full content = expandable body).
 * Deduped by **title** (case-insensitive, trimmed) so same-named plans/notes
 * collapse to a single block — the latest `updatedAt` wins. Returns "" when
 * there is nothing to embed.
 */
async function buildAttachmentsSection(
	summaries: ReadonlyArray<CommitSummary>,
	includePlans: boolean,
	includeNotes: boolean,
	cwd?: string,
): Promise<string> {
	const blocks: string[] = [];

	if (includePlans) {
		for (const plan of latestByKey(
			summaries.flatMap((s) => s.plans ?? []),
			(p) => p.title.trim().toLowerCase(),
		)) {
			const body = (await readPlanFromBranch(plan.slug, cwd))?.trim();
			blocks.push(detailsBlock(`\u{1F4C4} Plan — ${escHtml(plan.title)}`, body));
		}
	}

	if (includeNotes) {
		for (const note of latestByKey(
			summaries.flatMap((s) => s.notes ?? []),
			(n) => n.title.trim().toLowerCase(),
		)) {
			const body = ((await readNoteFromBranch(note.id, cwd)) ?? note.content)?.trim();
			blocks.push(detailsBlock(`\u{1F4DD} Note — ${escHtml(note.title)}`, body));
		}
	}

	if (blocks.length === 0) return "";
	return ["## Plans & Notes", "", ...blocks].join("\n");
}

/** Dedups by key, keeping the latest `updatedAt`. Preserves first-seen order. */
function latestByKey<T extends { readonly updatedAt: string }>(items: ReadonlyArray<T>, key: (t: T) => string): T[] {
	const byKey = new Map<string, T>();
	for (const item of items) {
		const k = key(item);
		const prev = byKey.get(k);
		if (!prev || Date.parse(item.updatedAt) >= Date.parse(prev.updatedAt)) byKey.set(k, item);
	}
	return [...byKey.values()];
}

/**
 * A collapsible block: always-visible title + expandable body.
 *
 * SECURITY: `title` is HTML-escaped by the caller (it sits inside the `<summary>`
 * tag we emit). `body` is the plan/note **Markdown**, embedded verbatim so the
 * public renderer can format it — which means the renderer is the trust boundary:
 * it MUST sanitize the rendered HTML with an allowlist (keep `details`/`summary`;
 * strip `script`, `iframe`, `on*` handlers, `javascript:` URLs, etc.). Without
 * that, user-authored plan/note content is a stored-XSS vector on the public page.
 */
function detailsBlock(title: string, body: string | undefined): string {
	const content = body && body.length > 0 ? body : "_(no content captured)_";
	return `<details>\n<summary>${title}</summary>\n\n${content}\n\n</details>\n`;
}
