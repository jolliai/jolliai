/**
 * SummaryPrMarkdownBuilder
 *
 * Builds a GitHub PR-description-optimized Markdown string from a
 * `CommitSummary`. Output uses GitHub-flavored HTML (<details>/<summary>
 * for folding, <blockquote> for visual body containers) and is NOT portable
 * to other markdown renderers — do NOT reuse this output for clipboard
 * export or Jolli document paths.
 *
 * Clipboard / Jolli-doc output lives in `SummaryMarkdownBuilder.ts` via
 * `buildMarkdown`. The two builders share three helpers
 * (`pushPlansAndNotesSection`, `pushRecapSection`, `pushFooter`) imported
 * from that file so recap, plans, and footer rendering stays identical
 * between clipboard and PR output.
 *
 * The four file-local helpers `wrapInGithubDetails`, `escapeGithubWrapperTags`,
 * `pushPrE2eTestSection`, and `pushPrTopicBody` are exported so the
 * branch-aggregating builder (`SummaryPrAggregateMarkdownBuilder`) can reuse
 * the same fold/escape/render conventions across multi-commit PR bodies.
 */

import type { CommitSummary, E2eTestScenario } from "../Types.js";
import { escHtml } from "./MarkdownEscape.js";
import { collectSortedTopics, padIndex, type TopicWithDate } from "./SummaryFormat.js";
import { pushFooter, pushPlansAndNotesSection } from "./SummaryMarkdownBuilder.js";

// Cumulative soft limits shared by both PR builders (single-commit here and
// branch-aggregating in SummaryPrAggregateMarkdownBuilder), so neither a single
// fat commit nor an aggregated body can push the PR past GitHub's 65536 hard
// cap. Sections are emitted recap → e2e → topics; each ceiling leaves room for
// the next. `PR_BODY_LIMIT` budgets ~1000 chars below the hard cap for the
// footer, the missing-summary footnote, and the marker envelope (`wrapWithMarkers`
// in PrDescription) — all appended downstream, outside this cap. The shared
// `pushRecapSection` stays unbounded (correct for the clipboard / Jolli-doc
// path); the PR path uses the bounded variants below.
export const RECAP_SOFT_LIMIT = 50000;
export const E2E_SOFT_LIMIT = 60000;
export const PR_BODY_LIMIT = 64500;

/**
 * Builds a Markdown string optimized for GitHub PR descriptions.
 *
 * Sections emitted:
 * - Jolli Memory URL (if pushed)
 * - Associated Plans with URLs
 * - E2E Test Guide (each scenario folded in a `<details>` block)
 * - Summaries: each topic folded with Why / Decisions / What /
 *   Future Enhancements (if any) / Files (if any)
 * - Footer
 */
export function buildPrMarkdown(summary: CommitSummary): string {
	const { topics: allTopics } = collectSortedTopics(summary);
	const lines: Array<string> = [];

	// Jolli Memory URL
	const memoryDocUrl = summary.jolliDocUrl;
	if (memoryDocUrl) {
		lines.push("", `## Jolli Memory`, "", `${memoryDocUrl}`);
	}

	pushPlansAndNotesSection(lines, summary, { includeReferences: true });
	pushPrRecapSection(lines, summary);
	pushPrE2eTestSection(lines, summary.e2eTestGuide);
	pushPrTopicsSection(lines, allTopics);
	pushFooter(lines, summary);

	return lines.join("\n");
}

// ─── GitHub folding helpers (file-local) ───────────────────────────────────

/**
 * Wraps a block of lines with <details>/<summary> for GitHub PR folding.
 *
 * `summaryContent` is emitted inline inside `<summary>...</summary>` (no
 * blank lines around it) — markdown headings inside summary are avoided to
 * prevent GitHub's heading CSS (24px top + 16px bottom margin) from bloating
 * every collapsed row. Callers typically pass `<strong>NN · Title</strong>`
 * for a tight bold label.
 *
 * A `<br>` is inserted after `</summary>` so that when the block is expanded,
 * the inline summary label and the first body paragraph don't collide
 * visually — `<p>` has `margin-top: 0` under GitHub's CSS, which otherwise
 * makes the expanded content feel glued to the label.
 *
 * Body is wrapped in `<blockquote>...</blockquote>` so the expanded content
 * gets GitHub's blockquote styling (left border + indent + slightly dimmed
 * text). This gives each expanded topic a clear visual container that
 * distinguishes it from the summary label. GFM parses markdown inside the
 * blockquote when blank lines flank the HTML tags (type-6 HTML block rule).
 *
 * `bodyLines` is expected to begin with "" so that the blank line between
 * `<blockquote>` and the first body block is preserved (needed by GFM to
 * switch from HTML mode to markdown parsing inside the blockquote).
 */
export function wrapInGithubDetails(summaryContent: string, bodyLines: Array<string>): Array<string> {
	return [
		"<details>",
		`<summary>${summaryContent}</summary>`,
		"<br>",
		"<blockquote>",
		...bodyLines,
		"",
		"</blockquote>",
		"</details>",
	];
}

/**
 * Escapes the block-level HTML tags used by `wrapInGithubDetails` so that
 * Claude-generated body content cannot prematurely close our outer wrappers.
 *
 * Two wrapper boundaries need protection:
 * - `<details>` / `</details>` — the outer collapsible block
 * - `<blockquote>` / `</blockquote>` — the inner visual container for body
 *
 * Both opening (including attribute variants like `<details open>`) and
 * closing tags are escaped to `&lt;...&gt;`. Other HTML tags (`<summary>`,
 * `<code>`, `<br>`, `<img>`, etc.) and markdown formatting are preserved.
 *
 * NOTE: Only applied to generated content inside buildPrMarkdown. User-edited
 * textarea content is NOT re-sanitized on submit (by design).
 */
export function escapeGithubWrapperTags(text: string): string {
	return text
		.replace(/<details\b[^>]*>/gi, (m) => `&lt;${m.slice(1, -1)}&gt;`)
		.replace(/<\/details\s*>/gi, "&lt;/details&gt;")
		.replace(/<blockquote\b[^>]*>/gi, (m) => `&lt;${m.slice(1, -1)}&gt;`)
		.replace(/<\/blockquote\s*>/gi, "&lt;/blockquote&gt;");
}

// ─── PR body section builders (file-local) ─────────────────────────────────

/**
 * Builds the inner body lines (preconditions / steps / expected results) of
 * a PR e2e scenario. Shared between single-summary and branch-aggregated
 * renderers — keep both call sites' output byte-identical.
 */
export function buildScenarioBodyLines(s: E2eTestScenario): Array<string> {
	const out: Array<string> = [];
	if (s.preconditions) {
		out.push("", `**Preconditions:** ${escapeGithubWrapperTags(s.preconditions)}`);
	}
	out.push("", "**Steps:**");
	for (let j = 0; j < s.steps.length; j++) {
		out.push(`${j + 1}. ${escapeGithubWrapperTags(s.steps[j])}`);
	}
	out.push("", "**Expected Results:**");
	for (const r of s.expectedResults) {
		out.push(`- ${escapeGithubWrapperTags(r)}`);
	}
	return out;
}

/**
 * PR recap with a size ceiling. The shared `pushRecapSection` is intentionally
 * unbounded (correct for clipboard / Jolli-doc output), but the PR path must
 * stay under GitHub's body cap. Mirroring the aggregate path's whole-unit drop,
 * an over-budget recap is omitted with a standalone notice rather than emitting
 * an orphaned header — keeping the downstream e2e/topics sections within budget.
 */
function pushPrRecapSection(lines: Array<string>, summary: CommitSummary): void {
	const recap = summary.recap?.trim();
	if (!recap) {
		return;
	}
	const block = ["", "## Quick recap", "", recap, "", "---"];
	if (lines.join("\n").length + block.join("\n").length > RECAP_SOFT_LIMIT) {
		lines.push("", "> ⚠️ Quick recap omitted due to GitHub PR body size limit.");
		return;
	}
	lines.push(...block);
}

export function pushPrE2eTestSection(
	lines: Array<string>,
	e2eTestGuide: ReadonlyArray<E2eTestScenario> | undefined,
): void {
	if (!e2eTestGuide || e2eTestGuide.length === 0) {
		return;
	}
	const header = `## E2E Test (${e2eTestGuide.length})`;
	const currentLength = () => lines.join("\n").length;
	const buffered: Array<string> = [];
	let included = 0;
	for (let i = 0; i < e2eTestGuide.length; i++) {
		const s = e2eTestGuide[i];
		const summaryContent = `<strong>${i + 1}. ${escHtml(s.title)}</strong>`;
		const wrapped = wrapInGithubDetails(summaryContent, buildScenarioBodyLines(s));
		// Account for the not-yet-pushed header so the first scenario is budgeted correctly.
		if (currentLength() + ["", header, ...buffered, ...wrapped].join("\n").length > E2E_SOFT_LIMIT) {
			break;
		}
		buffered.push(...wrapped);
		included++;
	}
	const omitted = e2eTestGuide.length - included;
	const noun = (n: number) => `scenario${n !== 1 ? "s" : ""}`;
	if (included > 0) {
		lines.push("", header, ...buffered);
		if (omitted > 0) {
			lines.push("", `> ⚠️ ${omitted} more ${noun(omitted)} omitted due to GitHub PR body size limit.`);
		}
		lines.push("", "---");
	} else {
		lines.push(
			"",
			`> ⚠️ All ${e2eTestGuide.length} ${noun(e2eTestGuide.length)} omitted due to GitHub PR body size limit.`,
		);
	}
}

/**
 * Emits a size-bounded section. The header is pushed ONLY when at least one
 * item was included, so an over-budget first item never produces an orphaned
 * "## Section (N)" header followed only by an omitted-notice. When every item
 * is omitted, a standalone notice is emitted instead — the omission is
 * signalled, never silent. Notice strings are passed pre-built (with the
 * `> ⚠️ ` prefix) so each section keeps its own singular/plural/possessive
 * wording.
 */
export function pushBoundedSection(
	lines: Array<string>,
	header: string,
	buffered: ReadonlyArray<string>,
	included: number,
	partialNotice: string | null,
	allOmittedNotice: string,
): void {
	if (included > 0) {
		lines.push("", header, ...buffered);
		if (partialNotice) {
			lines.push("", partialNotice);
		}
	} else {
		lines.push("", allOmittedNotice);
	}
}

/**
 * Appends the PR topic body (trigger, decisions, response, todo, files).
 *
 * Same field set as the clipboard `pushTopicBody` — every topic is now
 * folded by default, so showing all detail fields no longer bloats the
 * default PR view. Free-text fields are sanitized against wrapper-tag
 * injection. File paths are wrapped in backticks (code span) where HTML
 * is not parsed, so `filesAffected` entries need no escape.
 */
export function pushPrTopicBody(out: Array<string>, t: TopicWithDate): void {
	out.push("", `**⚡ Why This Change**`, "", escapeGithubWrapperTags(t.trigger));
	out.push("", `**💡 Decisions Behind the Code**`, "", escapeGithubWrapperTags(t.decisions));
	out.push("", `**✅ What Was Implemented**`, "", escapeGithubWrapperTags(t.response));
	if (t.todo) {
		out.push("", `**📋 Future Enhancements**`, "", escapeGithubWrapperTags(t.todo));
	}
	if (t.filesAffected && t.filesAffected.length > 0) {
		out.push("", `**📁 FILES**`);
		for (const f of t.filesAffected) {
			out.push(`- \`${f}\``);
		}
	}
}

/**
 * Appends the PR summaries section with GitHub body-size truncation.
 * Each topic is folded in a `<details>` block; truncation stops adding
 * topics once the PR body would exceed the GitHub character limit.
 */
function pushPrTopicsSection(lines: Array<string>, allTopics: Array<TopicWithDate>): void {
	if (allTopics.length === 0) {
		return;
	}

	const header = `## ${allTopics.length === 1 ? "Topic" : "Topics"} (${allTopics.length})`;
	const currentLength = () => lines.join("\n").length;
	const buffered: Array<string> = [];
	let included = 0;

	for (let i = 0; i < allTopics.length; i++) {
		const summaryContent = `<strong>${padIndex(i)} · ${escHtml(allTopics[i].title)}</strong>`;
		const bodyOnly: Array<string> = [];
		pushPrTopicBody(bodyOnly, allTopics[i]);
		const topicLines = wrapInGithubDetails(summaryContent, bodyOnly);
		// Account for the not-yet-pushed header so the first topic is budgeted correctly.
		if (currentLength() + ["", header, ...buffered, ...topicLines].join("\n").length > PR_BODY_LIMIT) {
			break;
		}
		buffered.push(...topicLines);
		included++;
	}

	const omitted = allTopics.length - included;
	const noun = (n: number) => `topic${n !== 1 ? "s" : ""}`;
	pushBoundedSection(
		lines,
		header,
		buffered,
		included,
		omitted > 0 ? `> ⚠️ ${omitted} more ${noun(omitted)} omitted due to GitHub PR body size limit.` : null,
		`> ⚠️ All ${allTopics.length} ${noun(allTopics.length)} omitted due to GitHub PR body size limit.`,
	);
}
