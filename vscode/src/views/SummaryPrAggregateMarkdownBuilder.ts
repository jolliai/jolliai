/**
 * Aggregates 2+ `CommitSummary` objects into one PR body markdown. The
 * single-summary path stays in `SummaryPrMarkdownBuilder.ts`; layout, dedupe
 * keys, and budgets follow `docs/feature-allow-multi-commit-pr.md`.
 */

import type {
	CommitSummary,
	E2eTestScenario,
	NoteReference,
	PlanReference,
} from "../../../cli/src/Types.js";
import {
	pushFooter,
	pushPlansAndNotesSection,
} from "./SummaryMarkdownBuilder.js";
import {
	buildScenarioBodyLines,
	escapeGithubWrapperTags,
	pushPrTopicBody,
	wrapInGithubDetails,
} from "./SummaryPrMarkdownBuilder.js";
import {
	collectSortedTopics,
	escHtml,
	padIndex,
	type TopicWithDate,
} from "./SummaryUtils.js";

// GitHub caps PR body at 65536. Budgets ~1000 chars for footer, missing
// footnote, marker envelope (added by `wrapWithMarkers` in caller), and
// per-section omitted-footnotes — keeping wrapped output safely below cap.
const PR_BODY_LIMIT = 64500;
const RECAP_SOFT_LIMIT = 50000;
const E2E_SOFT_LIMIT = 60000;

interface AggregatedScenario extends E2eTestScenario {
	readonly sourceShortHash: string;
}

interface AggregatedTopic extends TopicWithDate {
	readonly sourceShortHash: string;
}

export function buildAggregatedPrMarkdown(
	summaries: ReadonlyArray<CommitSummary>,
	missingCount: number,
): string {
	if (summaries.length < 2) {
		throw new Error(
			`buildAggregatedPrMarkdown requires summaries.length >= 2; got ${summaries.length}`,
		);
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
		// Strip backticks: escHtml doesn't escape them, and they would
		// collide with the inline `${shortHash}` code-span on the same line.
		const safeMessage = escHtml(s.commitMessage).replace(/`/g, "");
		lines.push(`${i + 1}. ${safeMessage} (\`${shortHash}\`)${memoryLink}`);
	}
}

// Dedupe key: URL when published, else `slug:`/`id:` prefix so unpublished
// entries with the same slug/id still collapse to one row. Prefix avoids
// accidental collision with URL strings.
function pushMergedPlansAndNotes(
	lines: Array<string>,
	summaries: ReadonlyArray<CommitSummary>,
): void {
	const planSeen = new Set<string>();
	const noteSeen = new Set<string>();
	const mergedPlans: Array<PlanReference> = [];
	const mergedNotes: Array<NoteReference> = [];

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
	}

	if (mergedPlans.length === 0 && mergedNotes.length === 0) return;

	pushPlansAndNotesSection(lines, {
		plans: mergedPlans,
		notes: mergedNotes,
	} as unknown as CommitSummary);
}

function pushPerCommitRecap(
	lines: Array<string>,
	summaries: ReadonlyArray<CommitSummary>,
	currentLength: () => number,
): void {
	const withRecapCount = summaries.filter((s) => s.recap?.trim()).length;
	if (withRecapCount === 0) return;

	// Header matches the single-summary `## Quick recap` (in
	// `SummaryMarkdownBuilder.pushRecapSection`) plus the `(N)` count style
	// used by every other aggregate section (Commits / E2E / Topics).
	lines.push("", `## Quick recap (${withRecapCount})`);

	let truncated = false;
	let truncatedCount = 0;
	for (let i = 0; i < summaries.length; i++) {
		const s = summaries[i];
		const recap = s.recap?.trim();
		if (!recap) continue;
		if (truncated) {
			truncatedCount++;
			continue;
		}
		const shortHash = s.commitHash.substring(0, 7);
		const safeMessage = escHtml(s.commitMessage).replace(/`/g, "");
		const block = [
			"",
			`### Commit ${i + 1} of ${summaries.length}: ${safeMessage} (\`${shortHash}\`)`,
			"",
			escapeGithubWrapperTags(recap),
		];
		if (currentLength() + block.join("\n").length > RECAP_SOFT_LIMIT) {
			truncated = true;
			truncatedCount++;
			continue;
		}
		lines.push(...block);
	}
	if (truncatedCount > 0) {
		const possessive = truncatedCount === 1 ? "commit's" : "commits'";
		lines.push(
			"",
			`> ⚠️ ${truncatedCount} more ${possessive} recap omitted due to GitHub PR body size limit.`,
		);
	}
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

	lines.push("", `## E2E Test (${all.length})`);

	let included = 0;
	for (let i = 0; i < all.length; i++) {
		const sc = all[i];
		const summaryContent = `<strong>${i + 1}. [${sc.sourceShortHash}] ${escHtml(sc.title)}</strong>`;
		const wrapped = wrapInGithubDetails(
			summaryContent,
			buildScenarioBodyLines(sc),
		);
		if (currentLength() + wrapped.join("\n").length > E2E_SOFT_LIMIT) {
			break;
		}
		lines.push(...wrapped);
		included++;
	}
	const omitted = all.length - included;
	if (omitted > 0) {
		lines.push(
			"",
			`> ⚠️ ${omitted} more scenario${omitted !== 1 ? "s" : ""} omitted due to GitHub PR body size limit.`,
		);
	}
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

	lines.push("", `## ${all.length === 1 ? "Topic" : "Topics"} (${all.length})`);

	let included = 0;
	for (let i = 0; i < all.length; i++) {
		const t = all[i];
		const summaryContent = `<strong>${padIndex(i)} · [${t.sourceShortHash}] ${escHtml(t.title)}</strong>`;
		const body: Array<string> = [];
		pushPrTopicBody(body, t);
		const wrapped = wrapInGithubDetails(summaryContent, body);
		if (currentLength() + wrapped.join("\n").length > PR_BODY_LIMIT) {
			break;
		}
		lines.push(...wrapped);
		included++;
	}
	const omitted = all.length - included;
	if (omitted > 0) {
		lines.push(
			"",
			`> ⚠️ ${omitted} more topic${omitted !== 1 ? "s" : ""} omitted due to GitHub PR body size limit.`,
		);
	}
}

function pushMissingFootnote(lines: Array<string>, missingCount: number): void {
	if (missingCount <= 0) return;
	lines.push(
		"",
		`> Note: ${missingCount} commit(s) without summary were skipped.`,
	);
}
