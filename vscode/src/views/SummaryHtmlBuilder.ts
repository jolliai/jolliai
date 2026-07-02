/**
 * SummaryHtmlBuilder
 *
 * Assembles the complete HTML document for the Commit Memory webview.
 * Combines CSS, header, recap, PR section, topic cards, E2E test guide,
 * source commits, footer, and interactive script into a single HTML string.
 */

import { isSummaryError } from "../../../cli/src/core/SummaryErrorMarker.js";
import {
	aggregateTurns,
	formatDurationLabel,
	resolveDiffStats,
} from "../../../cli/src/core/SummaryTree.js";
import type {
	CommitSummary,
	E2eTestScenario,
	NoteReference,
	PlanReference,
	ReferenceCommitRef,
	SourceId,
	TopicCategory,
} from "../../../cli/src/Types.js";
import { buildPrSectionHtml } from "../services/PrCommentService.js";
import { annotatePlans } from "../util/PlanGrouping.js";
import { SOURCE_TITLES } from "./SourceLabels.js";
import { buildCss } from "./SummaryCssBuilder.js";
import { buildScript } from "./SummaryScriptBuilder.js";
import { buildSummaryErrorBanner } from "./SummaryErrorBanner.js";
import {
	collectSortedTopics,
	escAttr,
	escHtml,
	formatDate,
	formatFullDate,
	formatProviderLabel,
	getDisplayDate,
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
	/**
	 * Archived keys of references whose title/body contain CJK characters and
	 * should get a 🌐 translate button. Keyed on `ReferenceCommitRef.archivedKey`
	 * (which includes the `<source>:` prefix). Mirrors {@link planTranslateSet}.
	 */
	readonly referenceTranslateSet?: ReadonlySet<string>;
	readonly nonce?: string;
	/**
	 * When set, the summary belongs to a non-current repo (Memory Bank
	 * cross-repo lookup). The .page root receives a `foreign-readonly` hook
	 * class; SummaryCssBuilder hides every destructive control under that
	 * class so users only see read-only affordances (Copy / Download).
	 * The panel tab title (set in SummaryWebviewPanel.update) already names
	 * the source repo, so this layer does not render an additional banner.
	 */
	readonly foreignRepoName?: string | null;
	/**
	 * Full 40-char hash of the live root commit when the panel's commit has
	 * been rewritten by amend / squash / rebase. The `.page` root receives
	 * a `stale-readonly` hook class (parallel to `foreign-readonly`) so the
	 * same CSS rule that hides destructive buttons takes effect, and a
	 * persistent banner is rendered at the top explaining where to go.
	 *
	 * The banner displays an 8-char short form for readability while the
	 * action button's `data-target-hash` attribute carries the FULL hash.
	 * Navigation needs the full hash because `getSummary()` only resolves
	 * `commitAliases` for 40-char inputs and throws `AmbiguousHashError`
	 * on prefix collisions.
	 *
	 * The banner is needed (unlike foreign-readonly which relies on the
	 * tab-title prefix) because the rewrite happens during the panel's
	 * lifetime — the user already had it open and would otherwise just see
	 * buttons disappear without knowing why.
	 */
	readonly staleRewrittenInto?: string | null;
}

/**
 * Assembles the complete HTML document from modular building blocks.
 * @param summary - The commit summary to render
 * @param opts - Options controlling transcript hashes, translate sets, and nonce
 */
export function buildHtml(
	summary: CommitSummary,
	opts: BuildHtmlOptions = {},
): string {
	const {
		transcriptHashSet,
		planTranslateSet,
		noteTranslateSet,
		referenceTranslateSet,
		nonce,
	} = opts;
	// Both readonly modes share the same CSS rule that hides destructive
	// buttons (see SummaryCssBuilder). A panel can in principle be both
	// foreign AND stale (cross-repo summary whose commit was rewritten in
	// the source repo) — emit both hook classes so the rule still matches.
	const pageClasses = ["page"];
	if (opts.foreignRepoName) pageClasses.push("foreign-readonly");
	if (opts.staleRewrittenInto) pageClasses.push("stale-readonly");
	const pageClass = pageClasses.join(" ");
	// Either readonly mode hides the per-section Regenerate buttons. Thread
	// `readOnly` into the failure-banner + topics-section builders so their
	// CTA text adapts (no "Click Regenerate" promise when the button is
	// hidden by CSS).
	const readOnly = !!opts.foreignRepoName || !!opts.staleRewrittenInto;
	const { sourceNodes } = collectSortedTopics(summary);
	const stats = resolveDiffStats(summary);
	const totalInsertions = stats.insertions;
	const totalDeletions = stats.deletions;
	const totalFiles = stats.filesChanged;

	const csp = nonce
		? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:;" />`
		: "";
	const nonceAttr = nonce ? ` nonce="${nonce}"` : "";

	// Display short-form (8 chars) for readability; the action button keeps
	// the full hash in data-target-hash so navigation goes through
	// getSummary()'s 40-char alias-resolution path rather than the
	// prefix-scan path that throws on collisions.
	const staleFullHash = opts.staleRewrittenInto ?? "";
	const staleShortHash = staleFullHash.substring(0, 8);
	const staleBannerHtml = opts.staleRewrittenInto
		? `<div class="stale-banner" role="status">
  <span class="stale-banner-icon" aria-hidden="true">&#x26A0;&#xFE0F;</span>
  <span class="stale-banner-text">This commit was rewritten into <code class="stale-banner-hash">${escHtml(staleShortHash)}</code>. This view is read-only; open the new commit's summary to make changes.</span>
  <button class="stale-banner-action" id="staleOpenNewBtn" data-foreign-safe data-target-hash="${escHtml(staleFullHash)}">Open new commit's summary</button>
</div>`
		: "";

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
<div class="${pageClass}">
${buildSummaryErrorBanner(summary, { readOnly })}
${staleBannerHtml}
${buildHeader(summary, totalFiles, totalInsertions, totalDeletions, !!opts.foreignRepoName)}
${buildShipBar(summary)}
${buildMemoryPanel(summary, { readOnly })}
${buildE2ePanel(summary)}
${buildConversationsSection(transcriptHashSet, !!opts.foreignRepoName)}
${buildAttachmentsPanel(summary, sourceNodes, planTranslateSet, noteTranslateSet, referenceTranslateSet)}
${buildFooter(summary)}
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

/**
 * Builds the optional "Memory" property row with a clickable article link.
 *
 * Exported so the webview panel can re-render just the `#jolliRow` (which
 * embeds the published Plans & Notes link list) after a plan/note add/remove,
 * without a full-page rebuild. See SummaryWebviewPanel.refreshPlansAndNotes.
 */
export function buildJolliRow(
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
	// Same-named plan snapshots collapse to one Jolli doc, so several can carry
	// the same URL — dedupe by URL so the ship card lists each doc once.
	const seenUrls = new Set<string>();
	const allItems: string[] = [];
	for (const p of publishedPlans) {
		const planUrl = p.jolliPlanDocUrl as string;
		if (seenUrls.has(planUrl)) {
			continue;
		}
		seenUrls.add(planUrl);
		allItems.push(
			`<div class="jolli-plan-item"><a class="jolli-link" href="${escHtml(planUrl)}" title="${escHtml(p.title)}">${escHtml(planUrl)}</a></div>`,
		);
	}
	for (const n of publishedNotes) {
		const noteUrl = n.jolliNoteDocUrl as string;
		if (seenUrls.has(noteUrl)) {
			continue;
		}
		seenUrls.add(noteUrl);
		allItems.push(
			`<div class="jolli-plan-item"><a class="jolli-link" href="${escHtml(noteUrl)}" title="${escHtml(n.title)}">${escHtml(noteUrl)}</a></div>`,
		);
	}
	const plansAndNotesHtml =
		allItems.length > 0
			? `<div class="jolli-plans-block"><span class="jolli-plans-label">Plans &amp; Notes</span>${allItems.join("")}</div>`
			: "";
	// Standalone block (not a `.prop-row`): lives inside the Jolli ship card.
	// `jolliRowUpdated` (SummaryScriptBuilder) replaces this element wholesale
	// by id, so the refresh stays consistent with this shape. Returns "" when
	// the memory has not been shared yet (no url).
	return `
  <div id="jolliRow" class="jolli-status">
    <a class="jolli-link" href="${escHtml(url)}" title="${memoryTooltip}">${escHtml(url)}</a>
    ${plansAndNotesHtml}
  </div>`;
}

// ─── Header ───────────────────────────────────────────────────────────────────

/**
 * Builds the page header: title, a compact meta strip, the collapsible
 * Details property table, and a secondary-action row (Copy Markdown +
 * Regenerate). The Jolli "Share/Update" button and the `#jolliRow` link move
 * to the ship bar (see buildShipBar); Regenerate (`#regenerateSummaryBtn`)
 * moves here from the All Conversations section so the top-level action lives
 * near the export controls.
 *
 * In `isForeign` (cross-repo Memory Bank) mode the Regenerate button is
 * OMITTED from the DOM entirely — regenerating would write the orphan branch
 * of the wrong repo, so we drop the affordance rather than rely on CSS to hide
 * it (matching the old All-Conversations behavior). In stale / regenerating
 * modes it stays in the DOM and is hidden by the readonly CSS rule (it is
 * intentionally not `data-foreign-safe`).
 */
/**
 * Renders the "Back-filled" badge shown in the meta strip for summaries produced
 * by the historical back-fill flow (absent on live post-commit summaries). The
 * badge text is deliberately plain ("Back-filled"); the *how* lives in the
 * hover tooltip, phrased for end users rather than as a confidence tier.
 */
function buildBackfillBadge(summary: CommitSummary): string {
	if (!summary.backfilled) return "";
	let tip: string;
	switch (summary.backfillMethod) {
		case "diff-only":
			tip =
				"Back-filled for an earlier commit. No matching AI conversation was found, so this summary was written from the code changes alone.";
			break;
		case "time-window":
			tip =
				"Back-filled for an earlier commit. The AI conversation was matched by timing alone, so it may not be the exact one.";
			break;
		case "branch-match":
			tip =
				"Back-filled for an earlier commit. The AI conversation was matched by the branch you were working on, so it may not be the exact one.";
			break;
		default:
			tip = "Back-filled for an earlier commit, reconstructed from the AI conversation that edited these files.";
	}
	return `<span class="meta-sep">&middot;</span><span class="meta-backfill" title="${escAttr(tip)}">Back-filled</span>`;
}

function buildHeader(
	summary: CommitSummary,
	totalFiles: number,
	totalInsertions: number,
	totalDeletions: number,
	isForeign: boolean = false,
): string {
	const changesHtml = `${totalFiles} file${totalFiles !== 1 ? "s" : ""} changed, <span class="stat-add">${totalInsertions} insertion${totalInsertions !== 1 ? "s" : ""}(+)</span>, <span class="stat-del">${totalDeletions} deletion${totalDeletions !== 1 ? "s" : ""}(-)</span>`;
	const totalTurns = aggregateTurns(summary);
	const shortHash = escHtml(summary.commitHash.substring(0, 8));
	const turnsMeta =
		totalTurns > 0
			? `<span class="meta-sep">&middot;</span><span class="stat-turns">\uD83D\uDCAC ${totalTurns}</span>`
			: "";

	return `
<h1 class="page-title">${escHtml(summary.commitMessage)}</h1>
<div class="meta-strip">
  <span class="meta-hash">${shortHash}</span>
  <span class="meta-sep">&middot;</span>
  <span class="meta-branch" title="${escAttr(summary.branch)}">${escHtml(summary.branch)}</span>
  <span class="meta-sep">&middot;</span>
  <span class="meta-author">${escHtml(summary.commitAuthor)}</span>
  <span class="meta-sep">&middot;</span>
  <span class="meta-date">${timeAgo(getDisplayDate(summary))}</span>
  <span class="meta-sep">&middot;</span>
  <span class="meta-changes"><span class="stat-add">+${totalInsertions}</span>/<span class="stat-del">\u2212${totalDeletions}</span></span>
  ${turnsMeta}
  ${buildBackfillBadge(summary)}
  <button class="details-toggle" id="detailsToggle" data-foreign-safe aria-expanded="false">Details &#x25BE;</button>
</div>
<div class="properties collapsed" id="propTable">
  <div class="prop-row">
    <div class="prop-label">Commit</div>
    <div class="prop-value">
      <span class="hash">${shortHash}</span>
      <button class="hash-copy" data-hash="${escHtml(summary.commitHash)}" title="Copy full hash" data-foreign-safe>\u29C9</button>
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
      <span class="date-relative">${timeAgo(getDisplayDate(summary))}</span>
      <span class="date-full">(${formatFullDate(getDisplayDate(summary))})</span>
    </div>
  </div>
  ${buildDurationRow(summary)}
  <div class="prop-row">
    <div class="prop-label">Changes</div>
    <div class="prop-value">${changesHtml}</div>
  </div>
  ${buildConversationsRow(totalTurns)}
</div>
<div class="header-actions">
  <div class="split-btn-group">
    <button class="action-btn" id="copyMdBtn" data-foreign-safe>Copy Markdown</button>
    <button class="action-btn split-toggle" id="copyMdDropdown" title="More export options" data-foreign-safe>&#x25BE;</button>
    <div class="split-menu" id="copyMdMenu">
      <button class="split-menu-item" id="downloadMdBtn" data-foreign-safe>Save as Markdown File</button>
    </div>
  </div>
  ${isForeign ? "" : `<button class="action-btn" id="regenerateSummaryBtn" title="Re-run the LLM end-to-end">&#x21BB; Regenerate</button>`}
</div>`;
}

// \u2500\u2500\u2500 Ship bar + content panels (presentation wrappers) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Builds the hero "ship bar": the PR card (wraps the existing #prSection) and
 * the Jolli card (the relocated #pushJolliBtn + reshaped #jolliRow + a
 * server-derived synced/not-shared status chip). Both outbound actions sit
 * side-by-side (responsive: stacks to one column on narrow widths via CSS
 * auto-fit). No behavior change \u2014 #prSection and #pushJolliBtn keep their ids
 * and handlers; only their placement and framing change.
 */
function buildShipBar(summary: CommitSummary): string {
	const synced = !!summary.jolliDocUrl;
	const pushLabel = synced ? "Update on Jolli" : "Share in Jolli";
	const jolliChip = synced
		? `<span class="ship-status is-ok"><span class="led"></span>Synced</span>`
		: `<span class="ship-status is-warn"><span class="led"></span>Not shared</span>`;
	const jolliSub = synced
		? ""
		: `<div class="ship-sub">Lives only on your machine. Share to publish this memory to your team's Jolli space.</div>`;
	return `
<div class="ship-bar">
  <div class="ship-card" id="prCard">
    ${buildPrSectionHtml()}
  </div>
  <div class="ship-card" id="jolliCard">
    <div class="ship-head">
      <span class="ship-icon">&#x25C6;</span>
      <span class="ship-name">Jolli Memory</span>
      ${jolliChip}
    </div>
    ${jolliSub}
    ${buildJolliRow(summary.jolliDocUrl, summary.commitMessage, summary.plans, summary.notes)}
    <div class="ship-actions">
      <button class="action-btn primary" id="pushJolliBtn">${pushLabel}</button>
    </div>
  </div>
</div>`;
}

/**
 * Wraps the recap + topics sections in a single bounded "Memory" panel so the
 * primary content reads as one grouped surface. Both inner sections keep their
 * ids (#recapSection, #topicsSection) and trailing <hr> (hidden by CSS inside
 * the panel) so replaceSection refreshes are unaffected.
 */
function buildMemoryPanel(
	summary: CommitSummary,
	options: BuildTopicsSectionOptions = {},
): string {
	return `
<div class="panel" id="memoryPanel">
  <div class="panel-header"><span class="panel-title">The memory</span></div>
  ${buildRecapSection(summary.recap)}
  ${buildTopicsSection(summary, options)}
</div>`;
}

/**
 * Wraps the E2E section in its own panel (above attachments). The inner
 * #e2eTestSection keeps its section-header (title + Generate/Regenerate/Delete
 * actions) and id, so generate/regenerate/delete behavior is unchanged.
 */
function buildE2ePanel(summary: CommitSummary): string {
	return `
<div class="panel" id="e2ePanel">
  ${buildE2eTestSection(summary)}
</div>`;
}

/**
 * Builds the "Attachments & context" panel containing collapsible cards.
 *
 * Each card wrapper (head + chevron) lives OUTSIDE the refreshed section so
 * collapse state survives `plansAndNotesUpdated` rebuilds for free \u2014 the
 * refresh only replaces the inner #plansAndNotesSection, never the card
 * wrapper. As a consequence card boundaries match refresh boundaries:
 * references render inside the "Plans & Notes" card (they share
 * #plansAndNotesSection), and source commits get their own card. Inner
 * section titles are hidden by CSS in favor of the card head.
 */
function buildAttachmentsPanel(
	summary: CommitSummary,
	sourceNodes: ReadonlyArray<CommitSummary>,
	planTranslateSet?: ReadonlySet<string>,
	noteTranslateSet?: ReadonlySet<string>,
	referenceTranslateSet?: ReadonlySet<string>,
): string {
	const plansBody = buildPlansAndNotesSection(
		summary.plans,
		summary.notes,
		summary.references ?? [],
		planTranslateSet,
		noteTranslateSet,
		referenceTranslateSet,
	);
	const sourceBody = buildSourceCommits(sourceNodes);
	const sourceCard = sourceBody
		? `
  <div class="attach-card" id="sourceCard">
    <div class="attach-card-head" data-collapse="sourceCard" role="button" tabindex="0" aria-expanded="true" data-foreign-safe>&#x1F4E6; Source Commits <span class="attach-arrow">&#x25BC;</span></div>
    <div class="attach-card-body">${sourceBody}</div>
  </div>`
		: "";
	return `
<div class="panel" id="attachmentsPanel">
  <div class="panel-header"><span class="panel-title">Attachments &amp; context</span></div>
  <div class="attach-card" id="plansCard">
    <div class="attach-card-head" data-collapse="plansCard" role="button" tabindex="0" aria-expanded="true" data-foreign-safe>&#x1F4CB; Plans &amp; Notes <span class="attach-arrow">&#x25BC;</span></div>
    <div class="attach-card-body">${plansBody}</div>
  </div>
  ${sourceCard}
</div>`;
}

/**
 * Renders the Conversations section as a normal top-level section.
 *
 * Replaces the former private-drawer wrapper — the PRIVATE badge / lock chrome
 * and bottom placement are gone. The inner allConversationsSection content
 * (rows, Open/View transcript action, modal) is preserved unchanged.
 */
function buildConversationsSection(
	transcriptHashSet?: ReadonlySet<string>,
	isForeign: boolean = false,
): string {
	return `
<div class="section conversations-section">
  <div class="section-header">
    <div class="section-title">&#x1F4AC; Conversations</div>
  </div>
  ${buildAllConversationsSection(transcriptHashSet, isForeign)}
</div>`;
}

// ─── Quick recap section ────────────────────────────────────────────────────

/**
 * Builds the Quick recap section.
 *
 * Two states:
 *   1. No recap: render a placeholder + Generate button so the user can
 *      trigger a one-shot recap LLM call without re-running the full summarize.
 *   2. With recap: render the recap body (split on blank lines into paragraphs)
 *      plus Edit and Regenerate buttons.
 *
 * The raw recap text is stashed in `data-raw` so the inline editor restores
 * the unescaped source rather than the HTML-escaped display version.
 *
 * Paragraph splitting on `\n\n` is defensive: the LLM may emit one or several
 * paragraphs depending on how many topics it weaves in, and HTML collapses
 * whitespace by default so a textual blank line would otherwise disappear.
 *
 * CONTRACT (do not break): the returned HTML is shaped
 *   `<div class="section recap-section" id="recapSection">…</div><hr class="separator"/>`
 * — two top-level sibling elements. The webview's `replaceSection('recapSection', …)`
 * in SummaryScriptBuilder.ts depends on this shape to strip the trailing <hr>
 * before splicing in the regenerated recap (otherwise stacked or missing
 * separators result). If you change the wrapping to a single self-contained
 * <div> (or any other shape), update replaceSection in the same change.
 */
export function buildRecapSection(recap: string | undefined): string {
	const trimmed = recap?.trim();

	if (!trimmed) {
		// State 1: no recap yet. Always show the Generate button. If the commit
		// has no `importance: major` topics, the handler short-circuits and
		// surfaces a toast instead of producing an empty recap; storage stays
		// untouched in that case so existing recaps are never destroyed.
		return `
<div class="section recap-section" id="recapSection">
  <div class="section-header">
    <div class="section-title">&#x1F4D6; Quick recap</div>
  </div>
  <p class="recap-placeholder">Generate a recap that highlights the major work in this commit.</p>
  <button class="action-btn" id="generateRecapBtn">&#x2728; Generate</button>
</div>
<hr class="separator" />`;
	}

	// State 2: recap exists. Render body + Edit/Regenerate buttons.
	const bodyHtml = trimmed
		.split(/\n\n+/)
		.map((p) => `<p>${escHtml(p.trim())}</p>`)
		.join("");
	return `<div class="section recap-section" id="recapSection" data-raw="${escAttr(trimmed)}">
  <div class="section-header">
    <div class="section-title">&#x1F4D6; Quick recap</div>
    <span class="topic-actions">
      <button class="topic-action-btn" id="editRecapBtn" title="Edit recap">✎</button>
      <button class="topic-action-btn" id="regenerateRecapBtn" title="Regenerate">&#x21BB;</button>
    </span>
  </div>
  <div class="recap-body">${bodyHtml}</div>
</div>
<hr class="separator" />`;
}

// ─── Topics Section ──────────────────────────────────────────────────────────

/** Options for buildTopicsSection. */
export interface BuildTopicsSectionOptions {
	/**
	 * True when the panel is showing a foreign-repo or stale-rewritten
	 * summary. CSS hides the Regenerate button in both cases, so the
	 * empty-state CTA text drops the "Click Regenerate above" instruction
	 * to avoid pointing at a hidden affordance.
	 */
	readonly readOnly?: boolean;
}

/**
 * Renders the topic grid as a self-contained section.
 *
 * Exported so the regenerate-summary handler can rebuild this region in
 * isolation after a successful re-run (the webview's replaceSection picks the
 * node up by `id="topicsSection"`). The output is byte-equal to the topics
 * region inside `buildHtml`, so embedding `${buildTopicsSection(summary)}`
 * there is the canonical way to keep the two render paths in sync.
 */
export function buildTopicsSection(
	summary: CommitSummary,
	options: BuildTopicsSectionOptions = {},
): string {
	const { topics: allTopics } = collectSortedTopics(summary);
	// Failure path: empty topics + isSummaryError → point the user at the
	// banner above. The banner carries the Regenerate button; the empty-
	// state itself stays text-only to avoid two competing affordances.
	// In read-only modes the Regenerate button is hidden, so we drop the
	// "Click Regenerate above" instruction — the banner already explains
	// the degraded state without promising an unreachable action.
	const failureEmpty = options.readOnly
		? '<p class="empty empty-error">Summary generation failed during the last attempt.</p>'
		: '<p class="empty empty-error">Summary generation failed during the last attempt. Click Regenerate above to try again.</p>';
	const emptyHtml = isSummaryError(summary) ? failureEmpty : '<p class="empty">No topics available for this commit.</p>';
	const topicsHtml = allTopics.length === 0 ? emptyHtml : allTopics.map((t, i) => renderTopic(t, i)).join("\n");
	const topicsLabel = `${allTopics.length} topic${allTopics.length !== 1 ? "s" : ""} extracted from this commit`;
	return `<div class="section" id="topicsSection">
  <div class="section-header">
    <div class="section-title" title="${topicsLabel}">&#x1F4DD; ${allTopics.length === 1 ? "Topic" : "Topics"} <span class="section-count">${allTopics.length}</span></div>
    <button class="toggle-all-btn" id="toggleAllBtn" title="Expand / Collapse all topics" data-foreign-safe>Collapse All</button>
  </div>
  ${topicsHtml}
</div>`;
}

// ─── Plans & Notes Section ───────────────────────────────────────────────────

/**
 * Builds the unified Plans & Notes section with Add dropdown and inline
 * snippet form.
 *
 * `references` is the multi-source list of external references. Callers pass
 * `summary.references ?? []` directly. References are grouped by source (linear
 * → jira → github → notion) and rendered with the same row layout — every
 * source goes through the source-agnostic `previewReference` /
 * `openReferenceExternal` / `loadReference-
 * Content` / `saveReferenceEdit` / `cancelReferenceEdit` / `removeReference` /
 * `translateReference` data-action attributes. The five-button-plus-inline-edit
 * markup mirrors `buildPlanRow` exactly so the CSS classes (`plan-item`,
 * `plan-header`, `plan-edit-area`, …) are shared.
 */
/**
 * Builds the Plans & Notes section (`#plansAndNotesSection`).
 *
 * Exported so the webview panel can re-render just this section after a
 * plan/note/reference add/remove/save/translate, without a full-page rebuild.
 * Mutations are also paired with a `#jolliRow` refresh (see
 * SummaryWebviewPanel.refreshPlansAndNotes). Emits a trailing
 * `<hr class="separator" />` sibling — the webview's `replaceSection` strips
 * the stale one to avoid stacked separators.
 */
export function buildPlansAndNotesSection(
	plans: ReadonlyArray<PlanReference> | undefined,
	notes: ReadonlyArray<NoteReference> | undefined,
	references: ReadonlyArray<ReferenceCommitRef> | undefined,
	planTranslateSet?: ReadonlySet<string>,
	noteTranslateSet?: ReadonlySet<string>,
	referenceTranslateSet?: ReadonlySet<string>,
): string {
	const planList = plans ?? [];
	const noteList = notes ?? [];
	// `references` is always defined when this function is called: buildHtml
	// passes `summary.references ?? []`. The `?? []` here is kept for
	// type-safety symmetry with plans/notes; its truthy arm cannot fire in
	// practice.
	/* v8 ignore next -- references is always defined by the buildHtml caller (see L139). */
	const referenceList = references ?? [];
	const totalCount = planList.length + noteList.length + referenceList.length;

	const planItems = annotatePlans(planList)
		.map(({ plan: p, isLatest, isSuperseded }) => {
			const key = p.slug;
			const showTranslate = planTranslateSet?.has(key) ?? false;
			const translateBtn = showTranslate
				? `<button class="topic-action-btn plan-translate-btn" title="Translate to English" data-plan-slug="${key}" data-action="translatePlan">&#x1F310;</button>`
				: "";
			const latestBadge = isLatest ? `<span class="plan-latest-badge">Latest</span>` : "";
			const dateBadge = `<span class="plan-date">${escHtml(timeAgo(p.updatedAt))}</span>`;
			// Same-named snapshots collapse to one Jolli doc, so only the latest
			// links out — a superseded older version would point to the same doc
			// (now holding the latest content), which reads as confusing.
			const jolliLink =
				p.jolliPlanDocUrl && !isSuperseded
					? ` &middot; <a class="jolli-link plan-jolli-link" href="${escHtml(p.jolliPlanDocUrl)}" title="View plan on Jolli">&#x1F517; View on Jolli</a>`
					: "";
			const itemClass = isSuperseded ? "plan-item plan-older" : "plan-item";
			return `
  <div class="${itemClass}" id="plan-${key}">
    <div class="plan-header">
      <a class="plan-title plan-title-link" href="#" title="Click to preview" data-action="previewPlan" data-plan-slug="${key}" data-plan-title="${escAttr(p.title)}">${escHtml(p.title)}</a>${latestBadge}
      <span class="plan-header-actions">
        ${dateBadge}${translateBtn}<button class="topic-action-btn plan-edit-btn" title="Edit Plan" data-plan-slug="${key}" data-action="loadPlanContent">&#x270E;</button>
        <button class="topic-action-btn plan-remove-btn" title="Remove Plan" data-plan-slug="${key}" data-plan-title="${escAttr(p.title)}" data-action="removePlan">&#x1F5D1;</button>
      </span>
    </div>
    <div class="plan-meta">${escHtml(key)}.md${jolliLink}</div>
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

	// External references (Linear / Jira / GitHub / Notion): mirror the
	// Plan/Note row layout *and* action set — preview the archived markdown,
	// open the upstream URL in a browser, translate the archived body (if
	// CJK), inline-edit the archived snapshot, or dissociate from this
	// commit. All sources share the same `*Reference` data-action names; the
	// host dispatches by `data-reference-source`.
	const referenceItems = referencesBySourceOrder(referenceList)
		.map((e) => buildReferenceRow(e, referenceTranslateSet))
		.join("\n");

	const allItems = planItems + noteItems + referenceItems;
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
  <div class="snippet-form hidden" id="snippetForm">
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

const HTML_REFERENCE_SOURCE_ORDER: ReadonlyArray<SourceId> = ["linear", "jira", "github", "notion"];

/**
 * Returns references ordered by source (linear → jira → github → notion),
 * preserving within-source order. Mirrors `referencesBySourceOrder` in
 * SummaryMarkdownBuilder so the HTML and Markdown views agree on item order.
 */
function referencesBySourceOrder(
	references: ReadonlyArray<ReferenceCommitRef>,
): ReadonlyArray<ReferenceCommitRef> {
	const bySource = new Map<SourceId, Array<ReferenceCommitRef>>();
	for (const e of references) {
		const arr = bySource.get(e.source) ?? [];
		arr.push(e);
		bySource.set(e.source, arr);
	}
	const out: Array<ReferenceCommitRef> = [];
	for (const source of HTML_REFERENCE_SOURCE_ORDER) {
		const arr = bySource.get(source);
		if (arr) out.push(...arr);
	}
	return out;
}

/**
 * Strips the `<source>:` prefix from `archivedKey` to produce a CSS-friendly
 * DOM id segment. Applied uniformly across all sources so `reference-<source>-<bare>`
 * id naming is symmetric — no source-specific carve-out.
 */
function stripSourcePrefix(archivedKey: string, source: SourceId): string {
	const prefix = `${source}:`;
	return archivedKey.startsWith(prefix) ? archivedKey.slice(prefix.length) : archivedKey;
}

/**
 * Renders one reference row. Mirrors the Plan/Note row markup byte-for-byte
 * (same CSS classes: `plan-item`, `plan-header`, `plan-header-actions`,
 * `plan-edit-area`, `plan-edit-textarea`, `plan-edit-actions`) so the inline
 * edit affordances reuse all existing CSS — the row is just "a plan whose
 * source is external".
 *
 * Five buttons on every row (Linear / Jira / GitHub / Notion):
 *   - Title click → `previewReference` (read-only webview of archived markdown)
 *   - 🌍 → `openReferenceExternal` (open upstream URL in browser)
 *   - 🌐 → `translateReference` (conditional; appears only when referenceTranslateSet
 *     contains the archivedKey)
 *   - ✎ → `loadReferenceContent` (opens the inline textarea pre-filled with
 *     the archived markdown body)
 *   - 🗑 → `removeReference` (splices the reference out of `summary.references[]`)
 *
 * `archivedKey` carries the `<source>:` prefix verbatim so the host
 * dispatches by source without re-parsing. The DOM id is
 * `reference-<source>-<bareKey>` for every source — the `<source>:` prefix is
 * stripped uniformly via {@link stripSourcePrefix} so the naming rule is
 * symmetric and the id stays CSS-selector friendly (no `:` to escape).
 */
function buildReferenceRow(
	e: ReferenceCommitRef,
	referenceTranslateSet?: ReadonlySet<string>,
): string {
	const sourceLabel = SOURCE_TITLES[e.source];
	// DOM id: strip `<source>:` prefix uniformly across sources so the id
	// is `reference-<source>-<bareKey>` regardless of source.
	const domKey = stripSourcePrefix(e.archivedKey, e.source);
	// DOM/data attributes are the source-agnostic `data-reference-*` set (read
	// by the dispatcher). The earlier Linear-only `data-linear-*` attributes
	// were removed alongside the openLinearIssue* / removeLinearIssue
	// data-actions in favour of the `*Reference` names.
	const showTranslate = referenceTranslateSet?.has(e.archivedKey) ?? false;
	const translateBtn = showTranslate
		? `<button class="topic-action-btn reference-translate-btn" title="Translate to English" data-reference-key="${escAttr(e.archivedKey)}" data-reference-source="${escAttr(e.source)}" data-action="translateReference">&#x1F310;</button>`
		: "";
	return `
  <div class="plan-item" id="reference-${escAttr(e.source)}-${escAttr(domKey)}">
    <div class="plan-header">
      <a class="plan-title plan-title-link" href="#" title="Click to preview" data-action="previewReference" data-reference-key="${escAttr(e.archivedKey)}" data-reference-source="${escAttr(e.source)}" data-reference-native-id="${escAttr(e.nativeId)}" data-reference-title="${escAttr(e.title)}">${escHtml(e.nativeId)} &mdash; ${escHtml(e.title)}</a>
      <span class="plan-header-actions">
        <button class="topic-action-btn" title="Open in ${sourceLabel}" data-reference-key="${escAttr(e.archivedKey)}" data-reference-source="${escAttr(e.source)}" data-reference-url="${escAttr(e.url)}" data-action="openReferenceExternal">&#x1F30D;</button>
        ${translateBtn}<button class="topic-action-btn plan-edit-btn" title="Edit ${sourceLabel} snapshot" data-reference-key="${escAttr(e.archivedKey)}" data-reference-source="${escAttr(e.source)}" data-action="loadReferenceContent">&#x270E;</button>
        <button class="topic-action-btn plan-remove-btn" title="Remove ${sourceLabel} Reference" data-reference-key="${escAttr(e.archivedKey)}" data-reference-source="${escAttr(e.source)}" data-reference-native-id="${escAttr(e.nativeId)}" data-reference-title="${escAttr(e.title)}" data-action="removeReference">&#x1F5D1;</button>
      </span>
    </div>
    <div class="plan-meta">${escHtml(e.nativeId)} (${sourceLabel})</div>
    <div class="plan-edit-area">
      <textarea class="plan-edit-textarea" data-reference-key="${escAttr(e.archivedKey)}" rows="20"></textarea>
      <div class="plan-edit-actions">
        <button class="action-btn" data-action="cancelReferenceEdit" data-reference-key="${escAttr(e.archivedKey)}" data-reference-source="${escAttr(e.source)}">Cancel</button>
        <button class="action-btn primary" data-action="saveReferenceEdit" data-reference-key="${escAttr(e.archivedKey)}" data-reference-source="${escAttr(e.source)}">Save</button>
      </div>
    </div>
  </div>`;
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
      <button class="toggle-all-btn" id="toggleAllE2eBtn" title="Expand / Collapse all scenarios" data-foreign-safe>Collapse All</button>
      <button class="topic-action-btn" id="regenE2eBtn" title="Regenerate">&#x21BB;</button>
      <button class="topic-action-btn" id="deleteE2eBtn" title="Delete">\uD83D\uDDD1</button>
    </span>
  </div>
  ${scenariosHtml}
</div>
<hr class="separator" />`;
}

/**
 * Renders a single E2E test scenario as a collapsible toggle.
 *
 * Exported so the webview-panel handler can re-render just one scenario
 * row after a per-scenario edit (mirrors the topic pattern of `renderTopic`).
 */
export function renderE2eScenario(s: E2eTestScenario, index: number): string {
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

	// Embed raw scenario data for inline edit mode (mirrors topic pattern).
	// Arrays joined by newlines so edit textareas can use one-item-per-line.
	const scenarioData = JSON.stringify({
		title: s.title,
		preconditions: s.preconditions ?? "",
		steps: s.steps.join("\n"),
		expectedResults: s.expectedResults.join("\n"),
	});

	return `
<div class="toggle e2e-scenario" id="e2e-scenario-${index}" data-scenario='${escAttr(scenarioData)}'>
  <div class="toggle-header">
    <span class="arrow">\u25BC</span>
    <span class="toggle-num">${padIndex(index)}</span>
    <span class="toggle-title">${escHtml(s.title)}</span>
    <span class="topic-actions">
      <button class="topic-action-btn e2e-edit-btn" data-scenario-index="${index}" title="Edit scenario">\u270E</button>
      <button class="topic-action-btn e2e-delete-btn" data-scenario-index="${index}" title="Delete scenario">\uD83D\uDDD1</button>
    </span>
  </div>
  <div class="toggle-content">
    ${preconditionsHtml}
    <div class="callout steps">
      <div class="callout-body">
        <div class="callout-label">\uD83D\uDC63 Steps</div>
        <div class="callout-text"><ol>${stepsHtml}</ol></div>
      </div>
    </div>
    <div class="callout expectedResults">
      <div class="callout-body">
        <div class="callout-label">\u2705 Expected Results</div>
        <div class="callout-text"><ul>${expectedHtml}</ul></div>
      </div>
    </div>
  </div>
</div>`;
}

// ─── All Conversations ───────────────────────────────────────────────────────

/**
 * Builds the All Conversations section with an Open button and the transcript
 * Modal skeleton.
 *
 * `isForeign` swaps the action chip from the workspace-side "Manage" (opens
 * the editable transcript modal) to a read-only "View" affordance:
 *  - The Regenerate button is dropped entirely (the foreign-readonly CSS
 *    rule already hides it, but emitting the markup would leave a
 *    misleading affordance in the DOM tree the user can spot via DevTools).
 *  - The Manage→View button stays under the same `openTranscriptsBtn` id —
 *    the modal-open click handler is unchanged. It receives the
 *    `data-foreign-safe` attribute so the .foreign-readonly CSS rule
 *    keeps it visible (the rule hides every button without that marker).
 *  - The modal's close-button is also marked foreign-safe so users can
 *    actually exit the modal after browsing transcripts; the modal's
 *    Save/Delete/Cancel buttons stay hidden by the same CSS rule so
 *    nothing destructive is reachable.
 */
export function buildAllConversationsSection(
	transcriptHashSet?: ReadonlySet<string>,
	isForeign: boolean = false,
): string {
	const count = transcriptHashSet?.size ?? 0;
	let inner: string;
	if (count === 0) {
		// Regenerate moved to the page header (buildHeader); the conversations
		// zone no longer renders its own button to avoid a duplicate id.
		inner = `
<div class="private-zone">
  <div class="section-header">
    <div class="section-title">&#x1F4AC; All Conversations</div>
  </div>
  <p class="empty">No conversation transcripts saved for this commit.</p>
</div>`;
	} else {
		const headerActions = isForeign
			? `      <button class="action-btn" id="openTranscriptsBtn" data-foreign-safe title="Browse transcripts (read-only)">View</button>`
			: `      <button class="action-btn" id="openTranscriptsBtn">Manage</button>`;

		inner = `
<div class="private-zone">
  <div class="section-header">
    <div class="section-title">&#x1F4AC; All Conversations</div>
    <span class="conversations-actions">
${headerActions}
    </span>
  </div>
  <p class="conversations-description">Raw AI conversation transcripts captured during development.</p>
  <p class="conversations-stats" id="conversationsStats">
    <span class="stats-loading">Loading stats...</span>
  </p>
  <p class="conversations-privacy">&#x1F512; Your private data — stored on your machine only. Nothing is uploaded unless you choose to.</p>
</div>
${buildTranscriptModal(isForeign)}`;
	}
	// Wrap private-zone + modal in a stable #allConversationsSection container so
	// the webview can replace just this block on transcript save/delete via
	// replaceSection (no full-page rebuild). See SummaryWebviewPanel.refreshConversations.
	return `
<div id="allConversationsSection">${inner}
</div>`;
}

/**
 * Builds the transcript Modal overlay (hidden by default, shown via JS).
 *
 * In foreign-readonly mode the close-button is marked `data-foreign-safe`
 * so the `.page.foreign-readonly button:not([data-foreign-safe])` rule
 * keeps it visible; without this the user would enter the modal and have
 * no clickable exit (ESC and overlay-click still work but are not
 * discoverable). The footer's Save/Delete/Cancel stay un-tagged so the
 * same rule hides them — the modal is browse-only.
 */
function buildTranscriptModal(isForeign: boolean = false): string {
	const closeForeignSafe = isForeign ? " data-foreign-safe" : "";
	return `
<div class="modal-overlay" id="transcriptModal">
  <div class="modal-container">
    <div class="modal-header">
      <div class="modal-title">
        <span>&#x1F4AC; All Conversations</span>
        <span class="modal-subtitle" id="modalSubtitle"></span>
      </div>
      <button class="modal-close-btn" id="modalCloseBtn" title="Close"${closeForeignSafe}>&times;</button>
    </div>
    <div class="modal-tabs" id="modalTabs"></div>
    <div class="modal-body" id="modalBody">
      <div class="modal-loading" id="modalLoading">Loading transcripts...</div>
    </div>
    <!--
      Hidden by default. Shown when the backend posts
      transcriptsSaveFailed / transcriptsDeleteFailed so the user has a
      visible recovery hint without leaving the modal. See message handlers
      in SummaryScriptBuilder.ts.
    -->
    <div class="modal-error-banner" id="modalErrorBanner" style="display: none;"></div>
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
	const nodeStats = resolveDiffStats(node);
	return `<div class="commit-row">
  <span class="hash">${escHtml(node.commitHash.substring(0, 8))}</span>
  <span class="commit-msg">${escHtml(node.commitMessage)}</span>
  <span class="commit-meta"><span class="stat-add">+${nodeStats.insertions}</span> <span class="stat-del">\u2212${nodeStats.deletions}</span>${turnsSuffix} &middot; ${formatDate(getDisplayDate(node))}</span>
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

// ─── Footer ───────────────────────────────────────────────────────────────────

/**
 * Builds the page footer with a "Generated by Jolli Memory" attribution and
 * timestamp. When the summary carries provider attribution (`llm.source`,
 * present on summaries generated after this field shipped) the provider name
 * is appended as `· via <provider>` — same shape as the Markdown footer so
 * clipboard export and webview display read consistently. The label is
 * rendered into its own `.footer-provider` span so panel CSS can style it
 * independently from the timestamp.
 */
function buildFooter(summary: CommitSummary): string {
	const now = formatFullDate(new Date().toISOString());
	const provider = formatProviderLabel(summary);
	const providerSpan = provider
		? ` <span class="footer-provider">&middot; via ${escHtml(provider)}</span>`
		: "";
	return `
<div class="page-footer">
  <span class="footer-generated">Generated by Jolli Memory &middot; ${escHtml(now)}</span>${providerSpan}
</div>`;
}
