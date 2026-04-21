/**
 * SummaryHtmlBuilder
 *
 * Assembles the complete HTML document for the Commit Memory webview.
 * Combines CSS, header, topic cards, timeline, E2E test guide, source
 * commits, footer, and interactive script into a single HTML string.
 */

import {
	aggregateStats,
	aggregateTurns,
	formatDurationLabel,
} from "../../../cli/src/core/SummaryTree.js";
import type {
	CommitSummary,
	E2eTestScenario,
	NoteReference,
	PlanReference,
	TopicCategory,
} from "../../../cli/src/Types.js";
import { buildPrSectionHtml } from "../services/PrCommentService.js";
import { buildCss } from "./SummaryCssBuilder.js";
import { buildPrMarkdown } from "./SummaryMarkdownBuilder.js";
import { buildScript } from "./SummaryScriptBuilder.js";
import {
	collectSortedTopics,
	escAttr,
	escHtml,
	formatDate,
	formatFullDate,
	groupTopicsByDate,
	padIndex,
	renderCalloutText,
	type TopicWithDate,
	timeAgo,
} from "./SummaryUtils.js";

// ─── Main HTML builder ────────────────────────────────────────────────────────

/** Options for building the summary HTML. */
export interface BuildHtmlOptions {
	readonly transcriptHashSet?: ReadonlySet<string>;
	readonly planTranslateSet?: ReadonlySet<string>;
	readonly noteTranslateSet?: ReadonlySet<string>;
	readonly nonce?: string;
	/** Controls the Push button label and data attribute. Defaults to "jolli". */
	readonly pushAction?: "jolli" | "both";
}

/**
 * Assembles the complete HTML document from modular building blocks.
 * @param summary - The commit summary to render
 * @param opts - Options controlling transcript hashes, translate sets, nonce, and push action
 */
export function buildHtml(
	summary: CommitSummary,
	opts: BuildHtmlOptions = {},
): string {
	const {
		transcriptHashSet,
		planTranslateSet,
		noteTranslateSet,
		nonce,
		pushAction = "jolli",
	} = opts;
	const {
		topics: allTopics,
		sourceNodes,
		showRecordDates,
	} = collectSortedTopics(summary);
	const stats = aggregateStats(summary);
	const totalInsertions = stats.insertions;
	const totalDeletions = stats.deletions;
	const totalFiles = stats.filesChanged;

	let topicsHtml: string;
	if (allTopics.length === 0) {
		topicsHtml = '<p class="empty">No summaries available for this commit.</p>';
	} else if (showRecordDates) {
		topicsHtml = renderTimeline(groupTopicsByDate(allTopics));
	} else {
		topicsHtml = allTopics.map((t, i) => renderTopic(t, i)).join("\n");
	}

	const topicsLabel = `${allTopics.length} summar${allTopics.length !== 1 ? "ies" : "y"} extracted from this commit`;

	const csp = nonce
		? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:;" />`
		: "";
	const nonceAttr = nonce ? ` nonce="${nonce}"` : "";

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
${csp}
<title>Commit Memory</title>
<style${nonceAttr}>${buildCss()}</style>
</head>
<body>
<div class="page">
${buildAllConversationsSection(transcriptHashSet)}
${buildHeader(summary, totalFiles, totalInsertions, totalDeletions, pushAction)}
<hr class="separator" />
${buildPrSectionHtml(summary.commitMessage, buildPrMarkdown(summary))}
${buildPlansAndNotesSection(summary.plans, summary.notes, planTranslateSet, noteTranslateSet)}
${buildE2eTestSection(summary)}
${buildSourceCommits(sourceNodes)}
<div class="section">
  <div class="section-header">
    <div class="section-title" title="${topicsLabel}">&#x1F4DD; ${allTopics.length === 1 ? "Summary" : "Summaries"} <span class="section-count">${allTopics.length}</span></div>
    <button class="toggle-all-btn" id="toggleAllBtn" title="Expand / Collapse all summaries">Collapse All</button>
  </div>
  ${topicsHtml}
</div>
${buildFooter()}
</div>
<script${nonceAttr}>${buildScript()}</script>
</body>
</html>`;
}

// ─── Header helpers ───────────────────────────────────────────────────────────

/** Maps a topic category to a CSS class suffix for pill coloring (5 color groups). */
function categoryClass(cat: TopicCategory): string {
	switch (cat) {
		case "feature":
		case "ux":
			return "cat-feature";
		case "bugfix":
		case "security":
			return "cat-bugfix";
		case "refactor":
		case "performance":
			return "cat-refactor";
		case "tech-debt":
		case "devops":
			return "cat-infra";
		case "test":
		case "docs":
			return "cat-docs";
	}
}

/** Builds the optional "Conversations" property row. Returns empty string when turns is 0 or undefined. */
function buildConversationsRow(totalTurns: number): string {
	if (totalTurns <= 0) {
		return "";
	}
	return `
  <div class="prop-row">
    <div class="prop-label">Conversations</div>
    <div class="prop-value"><span class="stat-turns">\uD83D\uDCAC ${totalTurns} turn${totalTurns !== 1 ? "s" : ""}</span></div>
  </div>`;
}

/** Builds the "Duration" property row HTML. */
function buildDurationRow(summary: CommitSummary): string {
	return `
  <div class="prop-row">
    <div class="prop-label">Duration</div>
    <div class="prop-value">${escHtml(formatDurationLabel(summary))}</div>
  </div>`;
}

/** Builds the optional "Memory" property row with a clickable article link. */
function buildJolliRow(
	url?: string,
	commitMessage?: string,
	plans?: ReadonlyArray<PlanReference>,
	notes?: ReadonlyArray<NoteReference>,
): string {
	if (!url) {
		return "";
	}
	const memoryTooltip = commitMessage
		? escHtml(commitMessage)
		: "View on Jolli";
	const publishedPlans = (plans ?? []).filter((p) => p.jolliPlanDocUrl);
	const publishedNotes = (notes ?? []).filter((n) => n.jolliNoteDocUrl);
	const allItems = [
		...publishedPlans.map((p) => {
			const planUrl = p.jolliPlanDocUrl as string;
			return `<div class="jolli-plan-item"><a class="jolli-link" href="${escHtml(planUrl)}" title="${escHtml(p.title)}">${escHtml(planUrl)}</a></div>`;
		}),
		...publishedNotes.map((n) => {
			const noteUrl = n.jolliNoteDocUrl as string;
			return `<div class="jolli-plan-item"><a class="jolli-link" href="${escHtml(noteUrl)}" title="${escHtml(n.title)}">${escHtml(noteUrl)}</a></div>`;
		}),
	];
	const plansAndNotesHtml =
		allItems.length > 0
			? `<div class="jolli-plans-block"><span class="jolli-plans-label">Plans &amp; Notes</span>${allItems.join("")}</div>`
			: "";
	return `
  <div class="prop-row" id="jolliRow">
    <div class="prop-label">Jolli Memory</div>
    <div class="prop-value">
      <a class="jolli-link" href="${escHtml(url)}" title="${memoryTooltip}">${escHtml(url)}</a>
      ${plansAndNotesHtml}
    </div>
  </div>`;
}

// ─── Header ───────────────────────────────────────────────────────────────────

/** Returns the push button label (HTML-safe) based on whether the doc exists and the push action mode. */
function buildPushButtonLabel(
	isUpdate: boolean,
	pushAction: "jolli" | "both",
): string {
	if (isUpdate) {
		return pushAction === "both"
			? "Update on Jolli &amp; Local"
			: "Update on Jolli";
	}
	return pushAction === "both" ? "Push to Jolli &amp; Local" : "Push to Jolli";
}

/** Builds the page header: title + Notion-style properties table. */
function buildHeader(
	summary: CommitSummary,
	totalFiles: number,
	totalInsertions: number,
	totalDeletions: number,
	pushAction: "jolli" | "both",
): string {
	const changesHtml = `${totalFiles} file${totalFiles !== 1 ? "s" : ""} changed, <span class="stat-add">${totalInsertions} insertion${totalInsertions !== 1 ? "s" : ""}(+)</span>, <span class="stat-del">${totalDeletions} deletion${totalDeletions !== 1 ? "s" : ""}(-)</span>`;
	const totalTurns = aggregateTurns(summary);
	const pushLabel = buildPushButtonLabel(!!summary.jolliDocUrl, pushAction);

	return `
<h1 class="page-title">${escHtml(summary.commitMessage)}</h1>
<div class="header-actions">
  <div class="split-btn-group">
    <button class="action-btn" id="copyMdBtn">Copy Markdown</button>
    <button class="action-btn split-toggle" id="copyMdDropdown" title="More export options">&#x25BE;</button>
    <div class="split-menu" id="copyMdMenu">
      <button class="split-menu-item" id="downloadMdBtn">Save as Markdown File</button>
    </div>
  </div>
  <button class="action-btn primary" id="pushJolliBtn" data-push-action="${pushAction}">${pushLabel}</button>
</div>
<div class="properties">
  <div class="prop-row">
    <div class="prop-label">Commit</div>
    <div class="prop-value">
      <span class="hash">${escHtml(summary.commitHash.substring(0, 8))}</span>
      <button class="hash-copy" data-hash="${escHtml(summary.commitHash)}" title="Copy full hash">\u29C9</button>
    </div>
  </div>
  <div class="prop-row">
    <div class="prop-label">Branch</div>
    <div class="prop-value"><span class="pill">${escHtml(summary.branch)}</span></div>
  </div>
  <div class="prop-row">
    <div class="prop-label">Author</div>
    <div class="prop-value">${escHtml(summary.commitAuthor)}</div>
  </div>
  <div class="prop-row">
    <div class="prop-label">Date</div>
    <div class="prop-value">
      <span class="date-relative">${timeAgo(summary.commitDate)}</span>
      <span class="date-full">(${formatFullDate(summary.commitDate)})</span>
    </div>
  </div>
  ${buildDurationRow(summary)}
  <div class="prop-row">
    <div class="prop-label">Changes</div>
    <div class="prop-value">${changesHtml}</div>
  </div>
  ${buildConversationsRow(totalTurns)}
  ${buildJolliRow(summary.jolliDocUrl, summary.commitMessage, summary.plans, summary.notes)}
</div>`;
}

// ─── Plans & Notes Section ───────────────────────────────────────────────────

/** Builds the unified Plans & Notes section with Add dropdown and inline snippet form. */
function buildPlansAndNotesSection(
	plans: ReadonlyArray<PlanReference> | undefined,
	notes: ReadonlyArray<NoteReference> | undefined,
	planTranslateSet?: ReadonlySet<string>,
	noteTranslateSet?: ReadonlySet<string>,
): string {
	const planList = plans ?? [];
	const noteList = notes ?? [];
	const totalCount = planList.length + noteList.length;

	const planItems = planList
		.map((p) => {
			const key = p.slug;
			const showTranslate = planTranslateSet?.has(key) ?? false;
			const translateBtn = showTranslate
				? `<button class="topic-action-btn plan-translate-btn" title="Translate to English" data-plan-slug="${key}" data-action="translatePlan">&#x1F310;</button>`
				: "";
			return `
  <div class="plan-item" id="plan-${key}">
    <div class="plan-header">
      <a class="plan-title plan-title-link" href="#" title="Click to preview" data-action="previewPlan" data-plan-slug="${key}" data-plan-title="${escAttr(p.title)}">${escHtml(p.title)}</a>
      <span class="plan-header-actions">
        ${translateBtn}<button class="topic-action-btn plan-edit-btn" title="Edit Plan" data-plan-slug="${key}" data-action="loadPlanContent">&#x270E;</button>
        <button class="topic-action-btn plan-remove-btn" title="Remove Plan" data-plan-slug="${key}" data-plan-title="${escAttr(p.title)}" data-action="removePlan">&#x1F5D1;</button>
      </span>
    </div>
    <div class="plan-meta">${escHtml(key)}.md</div>
    <div class="plan-edit-area">
      <textarea class="plan-edit-textarea" data-plan-slug="${key}" rows="20"></textarea>
      <div class="plan-edit-actions">
        <button class="action-btn" data-action="cancelPlanEdit" data-plan-slug="${key}">Cancel</button>
        <button class="action-btn primary" data-action="savePlanEdit" data-plan-slug="${key}">Save</button>
      </div>
    </div>
  </div>`;
		})
		.join("\n");

	const noteItems = noteList
		.map((n) => {
			const showNoteTranslate = noteTranslateSet?.has(n.id) ?? false;
			const noteTranslateBtn = showNoteTranslate
				? `<button class="topic-action-btn note-translate-btn" title="Translate to English" data-note-id="${escAttr(n.id)}" data-action="translateNote">&#x1F310;</button>`
				: "";
			return `
  <div class="plan-item" id="note-${n.id}">
    <div class="plan-header">
      <a class="plan-title plan-title-link" href="#" title="Click to preview" data-action="previewNote" data-note-id="${escAttr(n.id)}" data-note-title="${escAttr(n.title)}">${escHtml(n.title)}</a>
      <span class="plan-header-actions">
        ${noteTranslateBtn}<button class="topic-action-btn plan-edit-btn" title="Edit Note" data-note-id="${escAttr(n.id)}" data-note-title="${escAttr(n.title)}" data-note-format="${n.format}" data-action="loadNoteContent">&#x270E;</button>
        <button class="topic-action-btn plan-remove-btn" title="Remove Note" data-note-id="${escAttr(n.id)}" data-note-title="${escAttr(n.title)}" data-action="removeNote">&#x1F5D1;</button>
      </span>
    </div>
    ${n.format === "snippet" && n.content ? `<div class="plan-meta" style="margin-top:2px;white-space:pre-wrap">${escHtml(n.content)}</div>` : `<div class="plan-meta">${escHtml(n.id)}.md</div>`}
    <div class="plan-edit-area">
      <textarea class="plan-edit-textarea" data-note-id="${escAttr(n.id)}" rows="20"></textarea>
      <div class="plan-edit-actions">
        <button class="action-btn" data-action="cancelNoteEdit" data-note-id="${escAttr(n.id)}">Cancel</button>
        <button class="action-btn primary" data-action="saveNoteEdit" data-note-id="${escAttr(n.id)}" data-note-format="${n.format}">Save</button>
      </div>
    </div>
  </div>`;
		})
		.join("\n");

	const allItems = planItems + noteItems;
	const countBadge =
		totalCount > 1 ? ` <span class="section-count">${totalCount}</span>` : "";

	return `
<div class="section" id="plansAndNotesSection">
  <div class="section-header">
    <div class="section-title">&#x1F4CB; Plans &amp; Notes${countBadge}</div>
  </div>
  ${totalCount > 0 ? allItems : '<p class="e2e-placeholder">No plans or notes associated with this commit yet.</p>'}
  <div class="add-dropdown" id="addDropdown">
    <button class="action-btn add-dropdown-toggle" data-action="toggleAddMenu">+ Add</button>
    <div class="add-dropdown-menu" id="addDropdownMenu">
      <div class="add-dropdown-item" data-action="addPlan">Add Plan</div>
      <div class="add-dropdown-item" data-action="addMarkdownNote">Add Markdown File</div>
      <div class="add-dropdown-item" data-action="addTextSnippet">Add Text Snippet</div>
    </div>
  </div>
  <div class="snippet-form" id="snippetForm" hidden>
    <div class="snippet-field">
      <label for="snippetTitle">Title</label>
      <input type="text" id="snippetTitle" placeholder="My Note" autocomplete="off" spellcheck="false" />
    </div>
    <div class="snippet-field">
      <label for="snippetContent">Content</label>
      <textarea id="snippetContent" rows="6" placeholder="Enter your snippet..."></textarea>
    </div>
    <div class="snippet-actions">
      <button class="action-btn" data-action="cancelSnippet">Cancel</button>
      <button class="action-btn primary" id="saveSnippetBtn" data-action="saveSnippet" disabled>Save</button>
    </div>
  </div>
</div>
<hr class="separator" />
`;
}

// ─── E2E Test ──────────────────────────────────────────────────────────

/** Builds the E2E Test section. Shows a generate button or existing scenarios. */
export function buildE2eTestSection(summary: CommitSummary): string {
	const scenarios = summary.e2eTestGuide;

	if (!scenarios || scenarios.length === 0) {
		// Not yet generated — show placeholder + Generate button
		return `
<div class="section" id="e2eTestSection">
  <div class="section-header">
    <div class="section-title">\uD83E\uDDEA E2E Test</div>
  </div>
  <p class="e2e-placeholder">Generate step-by-step testing instructions for PR reviewers.<br>
  The guide describes how to manually verify each change from a user's perspective.</p>
  <button class="action-btn" id="generateE2eBtn">&#x2728; Generate</button>
</div>
<hr class="separator" />`;
	}

	// Scenarios exist — render each as a toggle
	const scenariosHtml = scenarios
		.map((s, i) => renderE2eScenario(s, i))
		.join("\n");

	return `
<div class="section" id="e2eTestSection">
  <div class="section-header">
    <div class="section-title">\uD83E\uDDEA E2E Test <span class="section-count">${scenarios.length}</span></div>
    <span class="topic-actions">
      <button class="topic-action-btn" id="editE2eBtn" title="Edit">\u270E</button>
      <button class="topic-action-btn" id="regenE2eBtn" title="Regenerate">\uD83D\uDD04</button>
      <button class="topic-action-btn" id="deleteE2eBtn" title="Delete">\uD83D\uDDD1</button>
    </span>
  </div>
  ${scenariosHtml}
</div>
<hr class="separator" />`;
}

/** Renders a single E2E test scenario as a collapsible toggle. */
function renderE2eScenario(s: E2eTestScenario, index: number): string {
	const preconditionsHtml = s.preconditions
		? `<div class="callout preconditions">
      <div class="callout-body">
        <div class="callout-label">\uD83D\uDCCB Preconditions</div>
        <div class="callout-text">${escHtml(s.preconditions)}</div>
      </div>
    </div>`
		: "";

	const stepsHtml = s.steps
		.map((step) => `<li>${escHtml(step)}</li>`)
		.join("\n        ");

	const expectedHtml = s.expectedResults
		.map((r) => `<li>${escHtml(r)}</li>`)
		.join("\n        ");

	return `
<div class="toggle e2e-scenario" id="e2e-scenario-${index}">
  <div class="toggle-header">
    <span class="arrow">\u25BC</span>
    <span class="toggle-num">${padIndex(index)}</span>
    <span class="toggle-title">${escHtml(s.title)}</span>
  </div>
  <div class="toggle-content">
    ${preconditionsHtml}
    <div class="callout steps">
      <div class="callout-body">
        <div class="callout-label">\uD83D\uDC63 Steps</div>
        <div class="callout-text"><ol>${stepsHtml}</ol></div>
      </div>
    </div>
    <div class="callout expected">
      <div class="callout-body">
        <div class="callout-label">\u2705 Expected Results</div>
        <div class="callout-text"><ul>${expectedHtml}</ul></div>
      </div>
    </div>
  </div>
</div>`;
}

// ─── All Conversations ───────────────────────────────────────────────────────

/** Builds the All Conversations section with an Open button and the transcript Modal skeleton. */
function buildAllConversationsSection(
	transcriptHashSet?: ReadonlySet<string>,
): string {
	const count = transcriptHashSet?.size ?? 0;
	if (count === 0) {
		return `
<div class="private-zone">
  <div class="private-zone-watermark">PRIVATE</div>
  <div class="section-header">
    <div class="section-title">&#x1F4AC; All Conversations</div>
  </div>
  <p class="empty">No conversation transcripts saved for this commit.</p>
</div>`;
	}

	return `
<div class="private-zone">
  <div class="private-zone-watermark">PRIVATE</div>
  <div class="section-header">
    <div class="section-title">&#x1F4AC; All Conversations</div>
    <button class="action-btn" id="openTranscriptsBtn">Manage</button>
  </div>
  <p class="conversations-description">Raw AI conversation transcripts captured during development.</p>
  <p class="conversations-stats" id="conversationsStats">
    <span class="stats-loading">Loading stats...</span>
  </p>
  <p class="conversations-privacy">&#x1F512; Your private data — stored on your machine only. Nothing is uploaded unless you choose to.</p>
</div>
${buildTranscriptModal()}`;
}

/** Builds the transcript Modal overlay (hidden by default, shown via JS). */
function buildTranscriptModal(): string {
	return `
<div class="modal-overlay" id="transcriptModal">
  <div class="modal-container">
    <div class="modal-header">
      <div class="modal-title">
        <span>&#x1F4AC; All Conversations</span>
        <span class="modal-subtitle" id="modalSubtitle"></span>
      </div>
      <button class="modal-close-btn" id="modalCloseBtn" title="Close">&times;</button>
    </div>
    <div class="modal-tabs" id="modalTabs"></div>
    <div class="modal-body" id="modalBody">
      <div class="modal-loading" id="modalLoading">Loading transcripts...</div>
    </div>
    <div class="modal-footer">
      <button class="action-btn danger" id="deleteTranscriptsBtn">Mark All as Deleted</button>
      <div class="modal-footer-right">
        <button class="action-btn" id="modalCancelBtn">Cancel</button>
        <button class="action-btn primary" id="modalSaveBtn" disabled>Save All</button>
      </div>
    </div>
  </div>
</div>`;
}

// ─── Source Commits ───────────────────────────────────────────────────────────

/** Builds the Source Commits section. Returns empty string for single-source summaries. */
function buildSourceCommits(sourceNodes: ReadonlyArray<CommitSummary>): string {
	if (sourceNodes.length <= 1) {
		return "";
	}

	const rows = sourceNodes.map((n) => renderCommitRow(n)).join("\n");

	return `
<div class="section">
  <div class="section-title" title="${sourceNodes.length} commits squashed into this summary">&#x1F4E6; Source Commits <span class="section-count">${sourceNodes.length}</span></div>
  <div class="commit-list">
    ${rows}
  </div>
</div>
<hr class="separator" />`;
}

/** Renders a single source commit as a compact row. */
function renderCommitRow(node: CommitSummary): string {
	const turns = node.conversationTurns;
	const turnsSuffix = turns
		? ` &middot; <span class="stat-turns">${turns} turn${turns !== 1 ? "s" : ""}</span>`
		: "";
	const ins = node.stats?.insertions ?? 0;
	const del = node.stats?.deletions ?? 0;
	return `<div class="commit-row">
  <span class="hash">${escHtml(node.commitHash.substring(0, 8))}</span>
  <span class="commit-msg">${escHtml(node.commitMessage)}</span>
  <span class="commit-meta"><span class="stat-add">+${ins}</span> <span class="stat-del">\u2212${del}</span>${turnsSuffix} &middot; ${formatDate(node.commitDate)}</span>
</div>`;
}

// ─── Memories ─────────────────────────────────────────────────────────────────

/** Renders a memory as a Notion-style toggle with callout blocks inside. */
export function renderTopic(t: TopicWithDate, displayIndex: number): string {
	// Use treeIndex for edit/delete operations (matches collectAllTopics traversal order);
	// fall back to displayIndex for unsorted single-commit summaries where they are identical.
	const opIndex = t.treeIndex ?? displayIndex;
	const catPill = t.category
		? `<span class="cat-pill ${categoryClass(t.category)}">${escHtml(t.category)}</span>`
		: "";
	const minorClass = t.importance === "minor" ? " minor" : "";

	// Embed raw topic data for edit mode (JSON in data attribute)
	const topicData = JSON.stringify({
		title: t.title,
		trigger: t.trigger,
		response: t.response,
		decisions: t.decisions,
		todo: t.todo ?? "",
		filesAffected: t.filesAffected ? t.filesAffected.join("\n") : "",
	});

	return `
<div class="toggle" id="topic-${opIndex}" data-topic='${escAttr(topicData)}'>
  <div class="toggle-header${minorClass}">
    <span class="arrow">\u25BC</span>
    <span class="toggle-num">${padIndex(displayIndex)}</span>
    <span class="toggle-title">${escHtml(t.title)}</span>${catPill}
    <span class="topic-actions">
      <button class="topic-action-btn topic-edit-btn" data-topic-index="${opIndex}" title="Edit memory">\u270E</button>
      <button class="topic-action-btn topic-delete-btn" data-topic-index="${opIndex}" title="Delete memory">\uD83D\uDDD1</button>
    </span>
  </div>
  <div class="toggle-content">
    <div class="callout trigger" data-field="trigger">
      <div class="callout-body">
        <div class="callout-label">\u26A1 Why this change</div>
        <div class="callout-text">${renderCalloutText(t.trigger)}</div>
      </div>
    </div>
    <div class="callout decisions" data-field="decisions">
      <div class="callout-body">
        <div class="callout-label">\uD83D\uDCA1 Decisions behind the code</div>
        <div class="callout-text">${renderCalloutText(t.decisions)}</div>
      </div>
    </div>
    <div class="callout response collapsible callout-collapsed" data-field="response">
      <div class="callout-body">
        <div class="callout-label">\u2705 What was implemented</div>
        <div class="callout-text">${renderCalloutText(t.response)}</div>
      </div>
    </div>
    <div class="callout todo collapsible callout-collapsed${!t.todo ? " hidden" : ""}" data-field="todo">
      <div class="callout-body">
        <div class="callout-label">\uD83D\uDCCB Future enhancements</div>
        <div class="callout-text">${t.todo ? renderCalloutText(t.todo) : ""}</div>
      </div>
    </div>
    <div class="callout files collapsible callout-collapsed${!t.filesAffected || t.filesAffected.length === 0 ? " hidden" : ""}" data-field="filesAffected">
      <div class="callout-body">
        <div class="callout-label">\uD83D\uDCC1 Files</div>
        <div class="callout-text">${t.filesAffected && t.filesAffected.length > 0 ? t.filesAffected.map((f) => `<div class="files-affected-item">${escHtml(f)}</div>`).join("\n        ") : ""}</div>
      </div>
    </div>
  </div>
</div>`;
}

/** Renders memories grouped by date as a timeline. Global numbering is continuous across groups. */
function renderTimeline(groups: Map<string, Array<TopicWithDate>>): string {
	let displayIndex = 0;
	const groupsHtml: Array<string> = [];
	for (const [dayKey, topics] of groups) {
		const dateStr = formatDate(topics[0].recordDate ?? dayKey);
		const count = topics.length;
		const topicsHtml = topics
			.map((t) => renderTopic(t, displayIndex++))
			.join("\n");
		groupsHtml.push(`
<div class="timeline-group" id="day-${dayKey}">
  <div class="timeline-header">
    <span class="timeline-dot"></span>
    <span class="timeline-arrow">\u25BC</span>
    <span class="timeline-date">${escHtml(dateStr)}</span>
    <span class="timeline-count">${count} memor${count !== 1 ? "ies" : "y"}</span>
  </div>
  <div class="timeline-content">
    ${topicsHtml}
  </div>
</div>`);
	}
	return `<div class="timeline">${groupsHtml.join("\n")}</div>`;
}

// ─── Footer ───────────────────────────────────────────────────────────────────

/** Builds the page footer with a "Generated by Jolli Memory" attribution and timestamp. */
function buildFooter(): string {
	const now = formatFullDate(new Date().toISOString());
	return `
<div class="page-footer">
  <span class="footer-generated">Generated by Jolli Memory &middot; ${escHtml(now)}</span>
</div>`;
}
