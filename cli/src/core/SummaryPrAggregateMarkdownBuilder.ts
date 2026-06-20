/**
 * Aggregates 2+ `CommitSummary` objects into one PR body markdown. The
 * single-summary path stays in `SummaryPrMarkdownBuilder.ts`; layout, dedupe
 * keys, and budgets follow `docs/feature-allow-multi-commit-pr.md`.
 */

import type { CommitSummary, E2eTestScenario, NoteReference, PlanReference, ReferenceCommitRef } from "../Types.js";
import { escHtml, escMdLinkText } from "./MarkdownEscape.js";
import { collectSortedTopics, padIndex, type TopicWithDate } from "./SummaryFormat.js";
import { pushFooter, pushPlansAndNotesSection } from "./SummaryMarkdownBuilder.js";
import {
	buildScenarioBodyLines,
	E2E_SOFT_LIMIT,
	escapeGithubWrapperTags,
	PR_BODY_LIMIT,
	pushBoundedSection,
	pushPrTopicBody,
	RECAP_SOFT_LIMIT,
	wrapInGithubDetails,
} from "./SummaryPrMarkdownBuilder.js";

interface AggregatedScenario extends E2eTestScenario {
	readonly sourceShortHash: string;
}

interface AggregatedTopic extends TopicWithDate {
	readonly sourceShortHash: string;
}

export function buildAggregatedPrMarkdown(summaries: ReadonlyArray<CommitSummary>, missingCount: number): string {
	if (summaries.length < 2) {
		throw new Error(`buildAggregatedPrMarkdown requires summaries.length >= 2; got ${summaries.length}`);
	}

	const lines: Array<string> = [];
	const currentLength = (): number => lines.join("\n").length;
	const totalCount = summaries.length + missingCount;

	pushCommitsDirectory(lines, summaries, totalCount, missingCount);
	pushMergedPlansAndNotes(lines, summaries);
	pushPerCommitRecap(lines, summaries, currentLength);
	pushAggregatedE2eSection(lines, summaries, currentLength);
	pushAggregatedTopicsSection(lines, summaries, currentLength);
	pushMissingFootnote(lines, missingCount);
	pushFooter(lines);

	return lines.join("\n");
}

// ─── Section builders (file-local) ─────────────────────────────────────────

function pushCommitsDirectory(
	lines: Array<string>,
	summaries: ReadonlyArray<CommitSummary>,
	totalCount: number,
	missingCount: number,
): void {
	const header =
		missingCount > 0
			? `## Commits in this PR (${summaries.length} of ${totalCount})`
			: `## Commits in this PR (${summaries.length})`;
	lines.push(header, "");
	for (let i = 0; i < summaries.length; i++) {
		const s = summaries[i];
		const shortHash = s.commitHash.substring(0, 7);
		const memoryLink = s.jolliDocUrl ? ` — [Memory](${s.jolliDocUrl})` : "";
		// Strip backticks: escHtml doesn't escape them, and they would collide with
		// the inline `${shortHash}` code-span on the same line. escMdLinkText also
		// escapes `[`/`]` so a message like `Fix [x](url)` can't render as a live link.
		const safeMessage = escMdLinkText(escHtml(s.commitMessage)).replace(/`/g, "");
		lines.push(`${i + 1}. ${safeMessage} (\`${shortHash}\`)${memoryLink}`);
	}
}

// Dedupe key: URL when published, else `slug:`/`id:` prefix so unpublished
// entries with the same slug/id still collapse to one row. Prefix avoids
// accidental collision with URL strings.
function pushMergedPlansAndNotes(lines: Array<string>, summaries: ReadonlyArray<CommitSummary>): void {
	const planSeen = new Set<string>();
	const noteSeen = new Set<string>();
	const referenceSeen = new Set<string>();
	const mergedPlans: Array<PlanReference> = [];
	const mergedNotes: Array<NoteReference> = [];
	const mergedReferences: Array<ReferenceCommitRef> = [];

	for (const s of summaries) {
		for (const p of s.plans ?? []) {
			const key = p.jolliPlanDocUrl ?? `slug:${p.slug}`;
			if (!planSeen.has(key)) {
				planSeen.add(key);
				mergedPlans.push(p);
			}
		}
		for (const n of s.notes ?? []) {
			const key = n.jolliNoteDocUrl ?? `id:${n.id}`;
			if (!noteSeen.has(key)) {
				noteSeen.add(key);
				mergedNotes.push(n);
			}
		}
		// Dedupe references by `<source>:<nativeId>` — the archivedKey varies
		// across commits (each archive appends a different shortHash), so
		// using the source+nativeId pair means the same external reference
		// (Linear ticket / Jira issue / GitHub issue / Notion page)
		// referenced across multiple commits in the PR collapses to a
		// single bullet. `s.references` is canonical post-Phase-B.
		const own = s.references ?? [];
		for (const e of own) {
			const key = `${e.source}:${e.nativeId}`;
			if (!referenceSeen.has(key)) {
				referenceSeen.add(key);
				mergedReferences.push(e);
			}
		}
	}

	if (mergedPlans.length === 0 && mergedNotes.length === 0 && mergedReferences.length === 0) {
		return;
	}

	pushPlansAndNotesSection(
		lines,
		{
			plans: mergedPlans,
			notes: mergedNotes,
			references: mergedReferences,
		} as unknown as CommitSummary,
		{ includeReferences: true },
	);
}

function pushPerCommitRecap(
	lines: Array<string>,
	summaries: ReadonlyArray<CommitSummary>,
	currentLength: () => number,
): void {
	const withRecap = summaries.map((s, i) => ({ s, i })).filter(({ s }) => s.recap?.trim());
	if (withRecap.length === 0) return;

	// Header matches the single-summary `## Quick recap` (in
	// `SummaryMarkdownBuilder.pushRecapSection`) plus the `(N)` count style
	// used by every other aggregate section (Commits / E2E / Topics).
	const header = `## Quick recap (${withRecap.length})`;
	const buffered: Array<string> = [];
	let included = 0;
	for (const { s, i } of withRecap) {
		const recap = s.recap?.trim();
		if (!recap) continue;
		const shortHash = s.commitHash.substring(0, 7);
		const safeMessage = escMdLinkText(escHtml(s.commitMessage)).replace(/`/g, "");
		const block = [
			"",
			`### Commit ${i + 1} of ${summaries.length}: ${safeMessage} (\`${shortHash}\`)`,
			"",
			escapeGithubWrapperTags(recap),
		];
		// Account for the not-yet-pushed header so the first recap is budgeted correctly.
		if (currentLength() + ["", header, ...buffered, ...block].join("\n").length > RECAP_SOFT_LIMIT) {
			break;
		}
		buffered.push(...block);
		included++;
	}
	const omitted = withRecap.length - included;
	const possessive = (n: number) => (n === 1 ? "commit's" : "commits'");
	pushBoundedSection(
		lines,
		header,
		buffered,
		included,
		omitted > 0
			? `> ⚠️ ${omitted} more ${possessive(omitted)} recap omitted due to GitHub PR body size limit.`
			: null,
		`> ⚠️ All ${withRecap.length} ${possessive(withRecap.length)} recap omitted due to GitHub PR body size limit.`,
	);
}

function pushAggregatedE2eSection(
	lines: Array<string>,
	summaries: ReadonlyArray<CommitSummary>,
	currentLength: () => number,
): void {
	const all: Array<AggregatedScenario> = [];
	for (const s of summaries) {
		const shortHash = s.commitHash.substring(0, 7);
		for (const sc of s.e2eTestGuide ?? []) {
			all.push({ ...sc, sourceShortHash: shortHash });
		}
	}
	if (all.length === 0) return;

	const header = `## E2E Test (${all.length})`;
	const buffered: Array<string> = [];
	let included = 0;
	for (let i = 0; i < all.length; i++) {
		const sc = all[i];
		const summaryContent = `<strong>${i + 1}. [${sc.sourceShortHash}] ${escHtml(sc.title)}</strong>`;
		const wrapped = wrapInGithubDetails(summaryContent, buildScenarioBodyLines(sc));
		// Account for the not-yet-pushed header so the first scenario is budgeted correctly.
		if (currentLength() + ["", header, ...buffered, ...wrapped].join("\n").length > E2E_SOFT_LIMIT) {
			break;
		}
		buffered.push(...wrapped);
		included++;
	}
	const omitted = all.length - included;
	const noun = (n: number) => `scenario${n !== 1 ? "s" : ""}`;
	pushBoundedSection(
		lines,
		header,
		buffered,
		included,
		omitted > 0 ? `> ⚠️ ${omitted} more ${noun(omitted)} omitted due to GitHub PR body size limit.` : null,
		`> ⚠️ All ${all.length} ${noun(all.length)} omitted due to GitHub PR body size limit.`,
	);
}

function pushAggregatedTopicsSection(
	lines: Array<string>,
	summaries: ReadonlyArray<CommitSummary>,
	currentLength: () => number,
): void {
	const all: Array<AggregatedTopic> = [];
	for (const s of summaries) {
		const shortHash = s.commitHash.substring(0, 7);
		const { topics } = collectSortedTopics(s);
		for (const t of topics) {
			all.push({ ...t, sourceShortHash: shortHash });
		}
	}
	if (all.length === 0) return;

	const header = `## ${all.length === 1 ? "Topic" : "Topics"} (${all.length})`;
	const buffered: Array<string> = [];
	let included = 0;
	for (let i = 0; i < all.length; i++) {
		const t = all[i];
		const summaryContent = `<strong>${padIndex(i)} · [${t.sourceShortHash}] ${escHtml(t.title)}</strong>`;
		const body: Array<string> = [];
		pushPrTopicBody(body, t);
		const wrapped = wrapInGithubDetails(summaryContent, body);
		// Account for the not-yet-pushed header so the first topic is budgeted correctly.
		if (currentLength() + ["", header, ...buffered, ...wrapped].join("\n").length > PR_BODY_LIMIT) {
			break;
		}
		buffered.push(...wrapped);
		included++;
	}
	const omitted = all.length - included;
	const noun = (n: number) => `topic${n !== 1 ? "s" : ""}`;
	pushBoundedSection(
		lines,
		header,
		buffered,
		included,
		omitted > 0 ? `> ⚠️ ${omitted} more ${noun(omitted)} omitted due to GitHub PR body size limit.` : null,
		`> ⚠️ All ${all.length} ${noun(all.length)} omitted due to GitHub PR body size limit.`,
	);
}

function pushMissingFootnote(lines: Array<string>, missingCount: number): void {
	if (missingCount <= 0) return;
	lines.push("", `> Note: ${missingCount} commit(s) without summary were skipped.`);
}
