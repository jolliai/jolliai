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
 */

import type { CommitSummary, E2eTestScenario } from "../../../cli/src/Types.js";
import {
	pushFooter,
	pushPlansAndNotesSection,
	pushRecapSection,
} from "./SummaryMarkdownBuilder.js";
import {
	collectSortedTopics,
	escHtml,
	padIndex,
	type TopicWithDate,
} from "./SummaryUtils.js";

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

	pushPlansAndNotesSection(lines, summary);
	pushRecapSection(lines, summary);
	pushPrE2eTestSection(lines, summary.e2eTestGuide);
	pushPrTopicsSection(lines, allTopics);
	pushFooter(lines);

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
function wrapInGithubDetails(
	summaryContent: string,
	bodyLines: Array<string>,
): Array<string> {
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
function escapeGithubWrapperTags(text: string): string {
	return text
		.replace(/<details\b[^>]*>/gi, (m) => `&lt;${m.slice(1, -1)}&gt;`)
		.replace(/<\/details\s*>/gi, "&lt;/details&gt;")
		.replace(/<blockquote\b[^>]*>/gi, (m) => `&lt;${m.slice(1, -1)}&gt;`)
		.replace(/<\/blockquote\s*>/gi, "&lt;/blockquote&gt;");
}

// ─── PR body section builders (file-local) ─────────────────────────────────

/**
 * Appends the E2E test guide section for PR markdown. Each scenario is
 * wrapped in a `<details>` block with its title in `<summary>`, and all
 * user-provided fields are sanitized against wrapper-tag injection.
 */
function pushPrE2eTestSection(
	lines: Array<string>,
	e2eTestGuide: ReadonlyArray<E2eTestScenario> | undefined,
): void {
	if (!e2eTestGuide || e2eTestGuide.length === 0) {
		return;
	}
	lines.push("", `## E2E Test (${e2eTestGuide.length})`);
	for (let i = 0; i < e2eTestGuide.length; i++) {
		const s = e2eTestGuide[i];
		const summaryContent = `<strong>${i + 1}. ${escHtml(s.title)}</strong>`;
		const bodyOnly: Array<string> = [];
		if (s.preconditions) {
			bodyOnly.push(
				"",
				`**Preconditions:** ${escapeGithubWrapperTags(s.preconditions)}`,
			);
		}
		bodyOnly.push("", "**Steps:**");
		for (let j = 0; j < s.steps.length; j++) {
			bodyOnly.push(`${j + 1}. ${escapeGithubWrapperTags(s.steps[j])}`);
		}
		bodyOnly.push("", "**Expected Results:**");
		for (const r of s.expectedResults) {
			bodyOnly.push(`- ${escapeGithubWrapperTags(r)}`);
		}
		lines.push(...wrapInGithubDetails(summaryContent, bodyOnly));
	}
	lines.push("", "---");
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
function pushPrTopicBody(out: Array<string>, t: TopicWithDate): void {
	out.push(
		"",
		`**⚡ Why This Change**`,
		"",
		escapeGithubWrapperTags(t.trigger),
	);
	out.push(
		"",
		`**💡 Decisions Behind the Code**`,
		"",
		escapeGithubWrapperTags(t.decisions),
	);
	out.push(
		"",
		`**✅ What Was Implemented**`,
		"",
		escapeGithubWrapperTags(t.response),
	);
	if (t.todo) {
		out.push(
			"",
			`**📋 Future Enhancements**`,
			"",
			escapeGithubWrapperTags(t.todo),
		);
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
function pushPrTopicsSection(
	lines: Array<string>,
	allTopics: Array<TopicWithDate>,
): void {
	if (allTopics.length === 0) {
		return;
	}

	// GitHub PR body limit is 65536 chars. Reserve space for footer + markers (~200 chars).
	const PR_BODY_LIMIT = 65000;

	lines.push(
		"",
		`## ${allTopics.length === 1 ? "Topic" : "Topics"} (${allTopics.length})`,
	);
	let includedCount = 0;
	const currentLength = () => lines.join("\n").length;

	for (let i = 0; i < allTopics.length; i++) {
		const summaryContent = `<strong>${padIndex(i)} · ${escHtml(allTopics[i].title)}</strong>`;
		const bodyOnly: Array<string> = [];
		pushPrTopicBody(bodyOnly, allTopics[i]);
		const topicLines = wrapInGithubDetails(summaryContent, bodyOnly);
		if (currentLength() + topicLines.join("\n").length > PR_BODY_LIMIT) {
			break;
		}
		lines.push(...topicLines);
		includedCount++;
	}

	const omitted = allTopics.length - includedCount;
	if (omitted > 0) {
		lines.push(
			"",
			`> ⚠️ ${omitted} more topic${omitted !== 1 ? "s" : ""} omitted due to GitHub PR body size limit.`,
		);
	}
}
