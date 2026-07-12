/**
 * SummaryHtmlBuilder
 *
 * Assembles the complete HTML document for the Commit Memory webview.
 * Combines CSS, header, recap, ship bar, topic cards, E2E test guide,
 * a flat Context panel (plans/notes/references), a Files panel (per-file
 * git status + diff), footer, and interactive script into a single HTML
 * string. The Create PR flow lives in its own pane (CreatePrHtmlBuilder), so
 * this document does not host a PR section.
 */

import { labelLeadsWithNativeId, referenceDisplayTitle } from "../../../cli/src/core/references/ReferenceDisplay.js";
import { getRegistry } from "../../../cli/src/core/references/SourceDefinitionRegistry.js";
import { isSummaryError } from "../../../cli/src/core/SummaryErrorMarker.js";
import {
	aggregateConversationTokenBreakdown,
	aggregateConversationTokens,
	resolveDiffStats,
} from "../../../cli/src/core/SummaryTree.js";
import type {
	CommitSummary,
	ContextRelevanceRef,
	ConversationTokenBreakdown,
	E2eTestScenario,
	ExcludedContextItem,
	NoteReference,
	PlanReference,
	ReferenceCommitRef,
	SourceId,
	TopicCategory,
} from "../../../cli/src/Types.js";
import { annotatePlans } from "../util/PlanGrouping.js";
import { getSourceMeta } from "./SourceLabels.js";
import { buildCss } from "./SummaryCssBuilder.js";
import { buildScript } from "./SummaryScriptBuilder.js";
import { buildSummaryErrorBanner } from "./SummaryErrorBanner.js";
import {
	collectSortedTopics,
	escAttr,
	escHtml,
	estimateConversationCostUsd,
	formatFullDate,
	formatProviderLabel,
	formatSonnetCostEstimate,
	formatTokensCompact,
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
	 * Default kind of the header Share button — follows the panel's share
	 * ENTRY (see SummaryScriptOptions.defaultShareKind). Persisted for the
	 * panel's lifetime by SummaryWebviewPanel so re-renders keep the button
	 * consistent with how the user opened the panel.
	 */
	readonly shareDefaultKind?: "branch" | "commit";
	/**
	 * One-shot: open the share modal (at `shareDefaultKind`) as soon as the
	 * webview script loads. Set by the sidebar share entries via
	 * `SummaryWebviewPanel.showWithShareModal` — the modal UI lives in this
	 * webview, so the open call is baked into the script (see buildScript).
	 * Ignored on readonly panels (they render no share modal at all).
	 */
	readonly autoOpenShare?: boolean;
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
	/**
	 * Webview URI (via `webview.asWebviewUri`) for `assets/codicons/codicon.css`,
	 * computed by `SummaryWebviewPanel` the same way `SidebarWebviewProvider`
	 * does for the sidebar. When set, `buildHtml` emits a `<link>` tag loading
	 * the codicon stylesheet — required for the `codicon-*` classes used by
	 * the ship card (`codicon-arrow-swap`) and conversation detach
	 * (`codicon-trash`), which otherwise render as empty boxes. Omitted in
	 * tests that don't care about icon fonts.
	 */
	readonly codiconCssUri?: string;
	/**
	 * `webview.cspSource` — the origin the CSP must allow for the codicon
	 * stylesheet (`style-src`) and the `.ttf` font it loads (`font-src`).
	 * Only meaningful together with {@link codiconCssUri}; without it the CSP
	 * stays nonce-only (inline `<style>`/`<script>`), matching pre-codicon
	 * behavior.
	 */
	readonly cspSource?: string;
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
	const totalFiles = resolveDiffStats(summary).filesChanged;

	// The codicon stylesheet is an external resource (webview URI, not
	// inline), so its origin must be added to style-src alongside the nonce;
	// the .ttf font it @font-face-loads needs the same origin under font-src.
	// Mirrors SidebarHtmlBuilder's CSP shape. Both style-src and font-src are
	// omitted entirely when no codiconCssUri is supplied, so panels that
	// don't pass one (most unit tests) keep the pre-codicon nonce-only CSP.
	const styleSrc = opts.codiconCssUri && opts.cspSource ? `'nonce-${nonce}' ${opts.cspSource}` : `'nonce-${nonce}'`;
	const fontSrcDirective = opts.codiconCssUri && opts.cspSource ? ` font-src ${opts.cspSource};` : "";
	const csp = nonce
		? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${styleSrc}; script-src 'nonce-${nonce}';${fontSrcDirective} img-src data:;" />`
		: "";
	const nonceAttr = nonce ? ` nonce="${nonce}"` : "";
	const codiconLinkTag = opts.codiconCssUri
		? `<link rel="stylesheet" href="${opts.codiconCssUri}" />`
		: "";

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
${codiconLinkTag}
</head>
<body>
<div class="${pageClass}">
${buildSummaryErrorBanner(summary, { readOnly })}
${staleBannerHtml}
${buildPageTitleAndMetaStrip(summary)}
${buildTokenMeter(summary)}
${buildPropTable(summary, totalFiles, transcriptHashSet)}
${buildShipBar(summary)}
${buildMemoryPanel(summary, { readOnly }, !!opts.foreignRepoName)}
${buildE2ePanel(summary)}
${buildConversationsSection(transcriptHashSet, !!opts.foreignRepoName)}
${buildContextPanel(summary, planTranslateSet, noteTranslateSet, referenceTranslateSet)}
${buildFilesPanelShell()}
${buildFooter(summary, transcriptHashSet?.size ?? 0)}
</div>
${buildShareModal()}
<script${nonceAttr}>${buildScript({
		defaultShareKind: opts.shareDefaultKind ?? "commit",
		autoOpenShare: opts.autoOpenShare ?? false,
	})}</script>
</body>
</html>`;
}

/**
 * Inline share glyph — a tray with an up arrow, the same iconography as the
 * sidebar's share entries. Inline SVG (not an icon font): this webview's CSP
 * carries no `font-src`, so codicons can't load here; `currentColor` keeps the
 * stroke matching the surrounding button/label text color.
 */
const SHARE_ICON_SVG = `<svg class="share-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 10V2.2M5.3 4.6 8 1.9l2.7 2.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.2 7H4.2c-.7 0-1.2.5-1.2 1.2v4.4c0 .7.5 1.2 1.2 1.2h7.6c.7 0 1.2-.5 1.2-1.2V8.2c0-.7-.5-1.2-1.2-1.2h-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

/**
 * Builds the hidden "Share this memory / branch" popover — a live, Space-backed share
 * with a SINGLE link created lazily on first use. The main pane has a "General access"
 * select (public bearer / anyone-at-site / only invited people) that sets the one
 * link's tier — Copy mints it on first use and changing the select flips the same
 * link in place — plus the invited-people list and the "what travels" banner. A
 * separate Send-invite pane stages people (grouped
 * suggestions: jolli account members / git collaborators) with an optional note; the
 * server grants access AND emails in one step. The card is anchored under the Share
 * button by the client script (`getBoundingClientRect`); the overlay is a transparent
 * full-screen click-catcher (no dimming). The client toggles panes per share state
 * (see SummaryScriptBuilder).
 */
export function buildShareModal(): string {
	return `
<div class="share-overlay" id="shareOverlay" hidden>
  <div class="share-modal share-popover" role="dialog" aria-modal="true" aria-labelledby="shareModalTitle">
    <div class="share-modal-head">
      <span class="share-modal-title">${SHARE_ICON_SVG}<span id="shareModalTitle">Share this memory</span></span>
      <span class="share-head-right">
        <span class="share-sync-badge" id="shareSyncBadge" hidden></span>
        <button type="button" class="share-modal-close" id="shareModalClose" title="Close" aria-label="Close">&#x2715;</button>
      </span>
    </div>
    <p class="share-modal-sub" id="shareModalSub"></p>

    <div class="share-pane" id="sharePaneMain" hidden>
      <div class="share-search-wrap">
        <input type="text" class="share-search" id="shareTeammateSearch" placeholder="Search teammates by name or email&hellip;" aria-label="Search teammates or add an email" autocomplete="off" />
        <div class="share-suggest" id="shareSuggest" hidden></div>
      </div>

      <div class="share-section-label">COLLABORATORS</div>
      <div class="share-collab-list" id="shareInvitedList" aria-label="Collaborators"></div>

      <div class="share-section-label">GENERAL ACCESS</div>
      <div class="share-access-row">
        <span class="share-access-icon" aria-hidden="true">&#x1F441;</span>
        <select class="share-select" id="shareAccessSelect" aria-label="Who can open this link">
          <option value="org" id="shareOrgOption">Anyone within your Jolli Account</option>
          <option value="public">Anyone with the link</option>
          <option value="people">Only people you add</option>
        </select>
      </div>
      <p class="share-access-sub" id="shareAccessDesc"></p>

      <div class="share-travel-banner">
        <span class="share-travel-icon" aria-hidden="true">&#x21C4;</span>
        <span>Summaries + decisions + linked refs travel.<br /><strong>Conversation transcripts stay on your machine.</strong></span>
      </div>

      <div class="share-modal-actions share-actions-main">
        <button class="action-btn primary" id="shareCopyBtn" title="Copy the link for the selected access level (created on first copy)">&#x1F4CB; Copy link</button>
      </div>
    </div>

    <div class="share-pane" id="sharePaneInvite" hidden>
      <div class="share-invite-head">
        <button type="button" class="share-invite-back" id="shareInviteBack" title="Back" aria-label="Back">&#x2039;</button>
        <span class="share-invite-title">Send invite</span>
      </div>
      <div class="share-section-label">TO</div>
      <div class="share-chips" id="shareInviteTo"></div>
      <div class="share-search-wrap">
        <input type="text" class="share-search" id="shareInviteSearch" placeholder="Add another &mdash; name or email&hellip;" aria-label="Add a person by name or email" autocomplete="off" />
        <div class="share-suggest" id="shareInviteSuggest" hidden></div>
      </div>
      <div class="share-section-label">MESSAGE <span class="share-label-soft">optional</span></div>
      <textarea class="share-invite-message" id="shareInviteMessage" rows="3" placeholder="Add a note &mdash; it appears at the top of their email&hellip;"></textarea>
      <p class="share-invite-foot">They'll get an email with a link to open this in Jolli.</p>
      <div class="share-modal-actions">
        <button class="action-btn" id="shareInviteCancel">Cancel</button>
        <button class="action-btn primary" id="shareInviteSend" disabled>Send invite <span id="shareInviteSendCount"></span> &rarr;</button>
      </div>
    </div>

    <div class="share-pane" id="sharePaneLoading" hidden>
      <p class="share-loading"><span class="share-spinner" aria-hidden="true"></span><span id="shareLoadingLabel">Syncing to Jolli…</span></p>
    </div>

    <div class="share-pane" id="sharePaneNoKey" hidden>
      <p class="share-nokey">Set your Jolli API Key first (STATUS panel → …) to share.</p>
    </div>

    <div class="share-pane" id="sharePaneError" hidden>
      <p class="share-error-msg" id="shareErrorMsg"></p>
      <div class="share-modal-actions"><button class="action-btn primary" id="shareRetryBtn">Try again</button></div>
    </div>
  </div>
</div>`;
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
			? `<div class="jolli-plans-block"><span class="jolli-plans-label">Context</span>${allItems.join("")}</div>`
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

/** Formats a token count with thousands separators (e.g. `2100` -> `2,100`). */
function formatTokenCount(n: number): string {
	return n.toLocaleString("en-US");
}

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
	return `<span class="meta-backfill" title="${escAttr(tip)}">Back-filled</span><span class="meta-sep">&middot;</span>`;
}

/**
 * Builds the page header: title, a compact meta strip (hash · branch · time ·
 * Details toggle · Share · Export), and the collapsible `.mem-details` table.
 * The Jolli "Share/Update" button and the `#jolliRow` link live in the ship
 * bar (see buildShipBar); `.meta-share` here is a lightweight jump-to-ship-card
 * affordance. Regenerate (`#regenerateSummaryBtn`) lives inside the Export
 * menu alongside Copy Markdown / Save as Markdown File so every export-ish
 * action lives behind one disclosure.
 *
 * Author / full date / summary-generation metadata / linked-item counts move
 * OUT of the always-visible meta strip and into the collapsible details table
 * (`#propTable`, class `.mem-details`) as four rows: Commit, Author, Summary
 * by, Linked. The old Branch/Date/Duration/Changes rows are dropped — Branch
 * and relative time already live in the strip, Duration wasn't part of the
 * mockup, and raw insertion/deletion counts give way to the Linked row's
 * file count.
 *
 * The foreign/stale readonly handling lives in `buildMemoryPanel` (where the
 * Regenerate button now sits), so this function needs no foreign flag.
 *
 * Builds the `<h1 class="page-title">` + `.meta-strip` portion of the header.
 * Split out from `#propTable` so `buildHtml` can insert `.tmeter` (the token
 * meter) between the meta strip and the prop table per the mockup order
 * (page-title → meta-strip → tmeter → propTable).
 */
export function buildPageTitleAndMetaStrip(summary: CommitSummary): string {
	const shortHash = escHtml(summary.commitHash.substring(0, 8));
	return `
<h1 class="page-title">${escHtml(summary.commitMessage)}</h1>
<div class="meta-strip">
  <span class="meta-hash">${shortHash}</span>
  <span class="meta-sep">&middot;</span>
  <span class="meta-branch" title="${escAttr(summary.branch)}">${escHtml(summary.branch)}</span>
  <span class="meta-sep">&middot;</span>
  <span class="meta-date">${timeAgo(getDisplayDate(summary))}</span>
  <span class="meta-sep">&middot;</span>
  ${buildBackfillBadge(summary)}
  <button class="details-toggle" id="detailsToggle" data-foreign-safe aria-expanded="false">Details &#x25BE;</button>
  <button class="action-btn meta-share" id="metaShareBtn" title="Share to Jolli"><svg class="sico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 14.5V4m0 0L8.3 7.7M12 4l3.7 3.7M5 12.5v6A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-6"/></svg> Share</button>
  <div class="export-menu-group">
    <button class="action-btn meta-export" id="exportMenuToggle" title="Export options" data-foreign-safe><span class="codicon codicon-book"></span> Export <span class="codicon codicon-chevron-down"></span></button>
    <div class="split-menu" id="exportMenu">
      <button class="split-menu-item" id="copyMdBtn" data-foreign-safe>Copy Markdown</button>
      <button class="split-menu-item" id="downloadMdBtn" data-foreign-safe>Save as Markdown File</button>
    </div>
  </div>
</div>`;
}

/**
 * Builds the collapsed `#propTable` details table (Commit / Author / Summary
 * by / Linked). Split out from {@link buildPageTitleAndMetaStrip} — see that
 * function's docstring for why.
 */
export function buildPropTable(
	summary: CommitSummary,
	totalFiles: number,
	transcriptHashSet?: ReadonlySet<string>,
): string {
	const shortHash = escHtml(summary.commitHash.substring(0, 8));

	const convCount = transcriptHashSet?.size ?? 0;
	const ctxCount = contextChipCount(summary);
	// CommitSummary has no commit-level aggregated `filesAffected` (only
	// per-topic TopicSummary.filesAffected exists — see Search.ts) — the
	// diff-derived totalFiles (buildHtml's resolveDiffStats().filesChanged)
	// is the correct file count for the whole commit.
	const fileCount = totalFiles;

	const summaryByModel = summary.llm?.model ?? "—";
	// A legacy/partial `llm` object (the orphan branch is append-only, so an old
	// record can carry an `llm` block predating these fields) would make the sum
	// NaN and render "NaN tokens" — guard each field the way the conversation
	// token aggregation already does.
	const tokenSpan = summary.llm
		? ` <span class="tok-bd">&middot; ${formatTokenCount((summary.llm.inputTokens ?? 0) + (summary.llm.outputTokens ?? 0))} tokens to write this summary</span>`
		: "";

	return `
<div class="mem-details collapsed" id="propTable">
  <div class="md-row">
    <div class="md-k">Commit</div>
    <div class="md-v">
      <span class="hash">${shortHash}</span>
      <button class="hash-copy" data-hash="${escHtml(summary.commitHash)}" title="Copy full hash" data-foreign-safe>⧉</button>
      <span class="md-branch">&middot; ${escHtml(summary.branch)}</span>
    </div>
  </div>
  <div class="md-row">
    <div class="md-k">Author</div>
    <div class="md-v">${escHtml(summary.commitAuthor)} &middot; ${formatFullDate(getDisplayDate(summary))}</div>
  </div>
  <div class="md-row">
    <div class="md-k">Summary by</div>
    <div class="md-v">${escHtml(summaryByModel)}${tokenSpan}</div>
  </div>
  <div class="md-row">
    <div class="md-k">Linked</div>
    <div class="md-v">${convCount} conversation${convCount !== 1 ? "s" : ""} &middot; ${ctxCount} context &middot; ${fileCount} file${fileCount !== 1 ? "s" : ""}</div>
  </div>
</div>`;
}

// \u2500\u2500\u2500 Token meter \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Rough cache-aware $ estimate at Sonnet pricing. `cached` (= cache_creation) is
 * priced at the cache-write rate; input/output at their standard rates. See spec \u00a74.2.
 * Uses the same per-token constants and "\u2248$"/"<$0.01" formatting the sidebar's
 * token bar uses (`SummaryUtils.ts`), so the two surfaces never disagree on
 * the same underlying token counts.
 */
function estimateCost(b: ConversationTokenBreakdown | undefined, total: number): string {
	return formatSonnetCostEstimate(estimateConversationCostUsd(b, total));
}

/**
 * Builds the per-memory token usage meter (`.tmeter`), shown between the page
 * header and the ship bar. Three states:
 *   1. `conversationTokenBreakdown` present \u2192 total + 3-segment bar (input /
 *      output / cached) + a legend spelling out each segment's count.
 *   2. Breakdown absent but `conversationTokens > 0` \u2192 total + a single
 *      `.seg-in` segment spanning the full bar (a total-only degrade \u2014 we
 *      never fabricate a split we don't have).
 *   3. `conversationTokens` absent or 0 \u2192 the `.tmeter.na` empty state, no
 *      bar at all ("Task usage not reported").
 *
 * Segment widths are carried as `data-pct` attributes rather than inline
 * `style="width"` \u2014 the webview's CSP has no `unsafe-inline` for styles, so
 * SummaryScriptBuilder sets `el.style.width` from `data-pct` after load (a
 * JS property write, not an inline attribute, so CSP allows it).
 */
export function buildTokenMeter(summary: CommitSummary): string {
	// Aggregate across the WHOLE consolidation tree — NOT the root's own scalar.
	// A squash/amend/rebase memory carries its conversation tokens on the folded
	// child commits, so reading only `summary.conversationTokens` (the root's own
	// value) shows "Task usage not reported" for a memory the sidebar row reports
	// as e.g. 12.4M. The sidebar sums via aggregateConversationTokens per root
	// (see Extension.getBranchTokenStats), so this meter must walk the same tree
	// or the two surfaces disagree on the same underlying counts.
	const total = aggregateConversationTokens(summary);
	if (total <= 0) {
		return `
<div class="tmeter na">
  <div class="tmeter-head"><span class="tmeter-total">Task usage not reported</span>
    <span class="tok-help-wrap"><button class="tok-help" type="button" data-foreign-safe>?</button>
      <span class="tok-pop">No session on this memory reports token usage, so there's nothing to total.</span></span>
  </div>
</div>`;
	}
	// aggregateConversationTokenBreakdown always returns an object (zeros when no
	// segment data exists anywhere in the tree). Only render the 3-segment split
	// when the tree actually carries breakdown data; otherwise degrade to a
	// single full-width segment (a total we can't split, not a fabricated one).
	const agg = aggregateConversationTokenBreakdown(summary);
	const b = agg.input > 0 || agg.output > 0 || agg.cached > 0 ? agg : undefined;
	// The bar's three segments are widths that must fill it exactly (100%), so
	// their denominator is the breakdown's OWN total — NOT `total` (the tree-wide
	// aggregateConversationTokens headline), which can exceed the breakdown sum
	// when some folded sessions report only a scalar count with no usageBreakdown.
	// Dividing by `total` there would underfill the bar. The last segment absorbs
	// the rounding remainder so the three widths always sum to 100.
	let bar: string;
	if (b) {
		const segTotal = b.input + b.output + b.cached; // > 0 since b is defined only when a segment is > 0
		const wIn = Math.round((b.input / segTotal) * 100);
		const wOut = Math.round((b.output / segTotal) * 100);
		const wCache = Math.max(0, 100 - wIn - wOut);
		bar = `<div class="tmeter-bar">
    <span class="seg-in" data-pct="${wIn}"></span>
    <span class="seg-out" data-pct="${wOut}"></span>
    <span class="seg-cache" data-pct="${wCache}"></span>
  </div>
  <div class="tmeter-legend">
    <span><i class="lg-dot seg-in"></i>${formatTokensCompact(b.input)} input</span>
    <span><i class="lg-dot seg-out"></i>${formatTokensCompact(b.output)} output</span>
    <span><i class="lg-dot seg-cache"></i>${formatTokensCompact(b.cached)} cached</span>
  </div>`;
	} else {
		bar = `<div class="tmeter-bar"><span class="seg-in" data-pct="100"></span></div>`;
	}
	return `
<div class="tmeter">
  <div class="tmeter-head"><span class="tmeter-total">${formatTokensCompact(total)}</span> tokens &middot; <span class="tmeter-cost">${estimateCost(b, total)}</span> &middot; this task
    <span class="tok-help-wrap"><button class="tok-help" type="button" data-foreign-safe>?</button>
      <span class="tok-pop">Counts input + output + cache-creation across sessions (cache reads are excluded \u2014 they double-count). The \u2248$ cost is a cache-aware estimate at Sonnet pricing; actual cost varies by model.</span></span>
  </div>
  ${bar}
</div>`;
}

// \u2500\u2500\u2500 Ship bar + content panels (presentation wrappers) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Builds the hero "ship bar": a single Jolli card (the relocated
 * #pushJolliBtn + reshaped #jolliRow + a server-derived SYNCED/LOCAL status
 * chip). The Create PR flow lives in its own pane (`CreatePrHtmlBuilder`), so
 * the detail panel no longer hosts a PR card here. #pushJolliBtn keeps its id;
 * it always posts `push` — when already synced this re-uploads the memory in
 * place ("Update on Jolli"), otherwise it creates the doc ("Push to Jolli").
 * The existing article stays reachable via the links in #jolliRow.
 */
export function buildShipBar(summary: CommitSummary): string {
	const synced = !!summary.jolliDocUrl;
	const chip = synced
		? `<span class="ship-status is-ok"><span class="led"></span>SYNCED</span>`
		: `<span class="ship-status local-chip"><span class="led"></span>LOCAL</span>`;
	const sub = synced
		? `<div class="ship-sub">Synced to your Jolli Space</div>`
		: `<div class="ship-sub">Not synced yet.</div>`;
	// The button always pushes: when synced the push updates the doc in place,
	// otherwise it creates it. The label reflects which of the two applies.
	const action = synced
		? `<button class="action-btn" id="pushJolliBtn">Update on Jolli</button>`
		: `<button class="action-btn" id="pushJolliBtn">Push to Jolli</button>`;
	return `
<div class="ship-bar">
  <div class="ship-card" id="jolliCard">
    <div class="ship-head">
      <span class="ship-icon codicon codicon-arrow-swap"></span>
      <span class="ship-name">Jolli</span>
      ${chip}
    </div>
    ${sub}
    ${buildJolliRow(summary.jolliDocUrl, summary.commitMessage, summary.plans, summary.notes)}
    <div class="ship-actions">${action}</div>
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
	isForeign = false,
): string {
	// Regenerate now lives in the Memory panel header (right-aligned), not the
	// Export menu — it re-runs the LLM that produces the recap + topics rendered
	// inside this panel, so it belongs here. Same DOM-omission rule as before:
	// dropped entirely in foreign mode (regenerating would write the wrong
	// repo's orphan branch); in stale mode it stays and the readonly CSS rule
	// hides it (it is intentionally NOT data-foreign-safe). The #regenerateSummaryBtn
	// id is preserved so the delegated click handler (bound on .page) keeps working.
	const regenerateBtn = isForeign
		? ""
		: `<button class="action-btn panel-regenerate" id="regenerateSummaryBtn" title="Re-run the LLM end-to-end">&#x21BB; Regenerate</button>`;
	return `
<div class="panel" id="memoryPanel">
  <div class="panel-header"><span class="panel-title">Memory</span>${regenerateBtn}</div>
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
 * The "CONTEXT N" chip count: plans + notes + references on the summary.
 * Single source of truth for both the initial render (buildContextPanel) and
 * the in-place `plansAndNotesUpdated` refresh (SummaryWebviewPanel.refreshPlansAndNotes),
 * which must agree — the chip lives in #contextPanel's header, outside the
 * #plansAndNotesSection HTML that the refresh replaces.
 */
export function contextChipCount(summary: CommitSummary): number {
	return (summary.plans?.length ?? 0) + (summary.notes?.length ?? 0) + (summary.references?.length ?? 0);
}

/**
 * Builds the flat "Context" panel (plans + notes + references), replacing
 * the former collapsible-card "Attachments & context" panel. Per the mockup,
 * Context is a single flat `.panel` \u2014 no `.attach-card` wrappers \u2014 with a
 * header count chip and a `+ Add` affordance, and Source Commits is dropped
 * entirely (the mockup has no Source Commits section; see buildHtml, which
 * no longer reads `sourceNodes` for this panel).
 *
 * The inner `#plansAndNotesSection` (built by buildPlansAndNotesSection) is
 * re-parented here unchanged so the `plansAndNotesUpdated` in-place refresh
 * (SummaryWebviewPanel.refreshPlansAndNotes) keeps finding it by id \u2014 only
 * the outer wrapper changed, not the refresh contract. That inner section's
 * own header is hidden by CSS in favor of this panel's header.
 *
 * The Add dropdown + inline snippet form (`#addDropdown` / `#snippetForm`)
 * are rendered here, in the panel header, rather than inside
 * `#plansAndNotesSection` \u2014 they carry no plan/note/reference data, so they
 * don't need to be torn down and rebuilt on every plansAndNotesUpdated
 * refresh. The `.panel-add` class is layered onto the existing
 * `.add-dropdown-toggle` button so it reads as the mockup's "+ Add" header
 * affordance while dispatching through the same `data-action="toggleAddMenu"`
 * delegated handler (SummaryScriptBuilder) \u2014 no new script wiring needed.
 */
/** Per-item AI relevance data threaded into buildPlansAndNotesSection: kept
 *  items' tier+reason (`refs`) plus the soft-excluded items rendered as inline
 *  read-only rows (`excluded`). Both optional — legacy summaries render plain
 *  title rows. */
export interface ContextRelevanceDisplay {
	readonly refs?: ReadonlyArray<ContextRelevanceRef>;
	readonly excluded?: ReadonlyArray<ExcludedContextItem>;
}

/** Archive suffix on committed plan slugs / note ids (`slug-<hash8>`). Relevance
 *  keys are working-area identities (pre-archive), so lookups try the exact key
 *  first, then this stripped form. Mirrors QueueWorker's REF_HASH_SUFFIX. */
const ARCHIVE_HASH_SUFFIX = /-[0-9a-f]{8}$/;

const TIER_LABEL = { high: "High", mid: "Med", low: "Low" } as const;
const TIER_TIP = {
	high: "High relevance to this change",
	mid: "Medium relevance to this change",
	low: "Low relevance to this change",
} as const;

function buildRelevanceLookup(refs: ReadonlyArray<ContextRelevanceRef> | undefined): Map<string, ContextRelevanceRef> {
	const map = new Map<string, ContextRelevanceRef>();
	for (const r of refs ?? []) map.set(`${r.kind}:${r.key}`, r);
	return map;
}

function lookupRelevance(
	map: ReadonlyMap<string, ContextRelevanceRef>,
	kind: "plan" | "note" | "reference",
	key: string,
): ContextRelevanceRef | undefined {
	return map.get(`${kind}:${key}`) ?? map.get(`${kind}:${key.replace(ARCHIVE_HASH_SUFFIX, "")}`);
}

/** Second meta line under a kept row's title: tier chip + the AI's one-line
 *  reason. Empty string when the item has no persisted verdict — or when the
 *  verdict carries an empty reason (a fabricated fail-open entry that slipped
 *  into an artifact), which would otherwise render a chip + dangling ✨. */
function buildRelevanceLine(rel: ContextRelevanceRef | undefined): string {
	if (!rel || rel.reason === "") return "";
	return `
      <div class="ctx-rel"><span class="ctx-tier ctx-tier--${rel.tier}" title="${escAttr(TIER_TIP[rel.tier])}">${TIER_LABEL[rel.tier]}</span><span class="ai-say">&#x2728; ${escHtml(rel.reason)}</span></div>`;
}

/**
 * One inline READ-ONLY row for an AI soft-excluded context item: badge +
 * struck-through title + `Excluded` chip + reason. Deliberately no preview /
 * edit / remove actions and no title link — a soft-excluded item was never
 * archived into this commit, so there is no snapshot to open. Rendered after
 * the kept rows (replaces the old collapsed "AI excluded N" details block).
 */
function buildExcludedRow(e: ExcludedContextItem): string {
	let tag = `<span class="kb-tag t-plan">P</span>`;
	if (e.kind === "note") tag = `<span class="kb-tag t-note">N</span>`;
	else if (e.kind === "reference") {
		const source = e.key.includes(":") ? e.key.slice(0, e.key.indexOf(":")) : e.key;
		tag = `<span class="kb-tag t-ref">${escHtml(getSourceMeta(source).letter)}</span>`;
	}
	const reason = e.reason
		? `
      <div class="ctx-rel"><span class="ctx-tier ctx-tier--ex" title="AI marked unrelated &mdash; excluded from the summary">Excluded</span><span class="ai-say">&#x2728; ${escHtml(e.reason)}</span></div>`
		: "";
	return `
  <div class="row plan-item ai-ex-row">
    ${tag}
    <div class="r-main">
      <span class="r-title ai-ex-title">${escHtml(e.title)}</span>${reason}
    </div>
  </div>`;
}

export function buildContextPanel(
	summary: CommitSummary,
	planTranslateSet?: ReadonlySet<string>,
	noteTranslateSet?: ReadonlySet<string>,
	referenceTranslateSet?: ReadonlySet<string>,
): string {
	const plansAndNotesBody = buildPlansAndNotesSection(
		summary.plans,
		summary.notes,
		summary.references ?? [],
		planTranslateSet,
		noteTranslateSet,
		referenceTranslateSet,
		{ refs: summary.contextRelevance, excluded: summary.excludedContext },
	);
	const contextCount = contextChipCount(summary);
	return `
<div class="panel" id="contextPanel">
  <div class="panel-header">
    <span class="panel-title">Context</span>
    <span class="sec-count">${contextCount}</span>
    <div class="add-dropdown" id="addDropdown">
      <button class="action-btn panel-add add-dropdown-toggle" data-action="toggleAddMenu" title="Add plan, file, note, or snippet"><span class="codicon codicon-add"></span></button>
      <div class="add-dropdown-menu" id="addDropdownMenu">
        <div class="add-dropdown-item" data-action="addPlan">Add Plan</div>
        <div class="add-dropdown-item" data-action="addMarkdownNote">Add Markdown File</div>
        <div class="add-dropdown-item" data-action="addTextSnippet">Add Text Snippet</div>
      </div>
    </div>
  </div>
  ${plansAndNotesBody}
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
</div>`;
}

/**
 * Renders the Conversations panel (mockup-aligned inline rows).
 *
 * The former modal-based "Manage" flow (`.private-zone` + `#transcriptModal`
 * overlay + Manage/Save All/Mark-Deleted buttons) is gone. This now emits a
 * `.panel` with a header ("Conversations" + a `.sec-count` chip) and a body
 * container (`#conversationsBody`) that shows a build-time "Loading…"
 * placeholder. The actual inline `.row`s are rendered CLIENT-SIDE from the
 * host's `conversationsData` message (see SummaryScriptBuilder.ts), because
 * the per-conversation metadata (title via resolveSessionTitle, message count)
 * is only available at runtime — not at build time, where only the transcript
 * hash count is known.
 *
 * `isForeign` is accepted for call-site compatibility; the panel chrome is
 * identical either way (the row-level detach control is gated in the client
 * + host, not here).
 */
export function buildConversationsSection(
	transcriptHashSet?: ReadonlySet<string>,
	_isForeign: boolean = false,
): string {
	const count = transcriptHashSet?.size ?? 0;
	return `
<div id="allConversationsSection">
<div class="panel conversations-panel">
  <div class="panel-header">
    <span class="panel-title">Conversations</span>
    <span class="sec-count">${count}</span>
  </div>
  <div id="conversationsBody" class="conversations-body">
    <p class="conv-loading">Loading conversations…</p>
  </div>
</div>
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
 * Builds the Plans & Notes section (`#plansAndNotesSection`).
 *
 * `references` is the multi-source list of external references. Callers pass
 * `summary.references ?? []` directly. References are grouped by source (linear
 * → jira → github → notion) and rendered with the same row layout — every
 * source goes through the source-agnostic `previewReference` /
 * `openReferenceExternal` / `loadReferenceContent` / `saveReferenceEdit` /
 * `cancelReferenceEdit` / `removeReference` / `translateReference` data-action
 * attributes. The row markup mirrors the plan row's shared CSS classes
 * (`row plan-item`, `plan-header-actions`, `plan-edit-area`, …).
 *
 * The Add dropdown + inline snippet form are NOT rendered by this function —
 * they're static (no plan/note/reference data dependency) and live in the
 * panel header instead; see buildContextPanel.
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
	relevance?: ContextRelevanceDisplay,
): string {
	const planList = plans ?? [];
	const noteList = notes ?? [];
	// `references` is always defined when this function is called: buildHtml
	// passes `summary.references ?? []`. The `?? []` here is kept for
	// type-safety symmetry with plans/notes; its truthy arm cannot fire in
	// practice.
	/* v8 ignore next -- references is always defined by the buildHtml caller (see L139). */
	const referenceList = references ?? [];
	const relevanceMap = buildRelevanceLookup(relevance?.refs);
	const excludedList = relevance?.excluded ?? [];
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
			const itemClass = isSuperseded ? "row plan-item plan-older" : "row plan-item";
			return `
  <div class="${itemClass}" id="plan-${key}">
    <span class="kb-tag t-plan">P</span>
    <div class="r-main">
      <a class="r-title plan-title plan-title-link" href="#" title="Click to preview" data-action="previewPlan" data-plan-slug="${key}" data-plan-title="${escAttr(p.title)}">${escHtml(p.title)}</a>${latestBadge}
      <div class="plan-meta">${escHtml(key)}.md${jolliLink}</div>${buildRelevanceLine(lookupRelevance(relevanceMap, "plan", key))}
    </div>
    <span class="r-actions plan-header-actions">
      ${dateBadge}${translateBtn}<button class="icon-btn topic-action-btn plan-edit-btn" title="Edit Plan" data-plan-slug="${key}" data-action="loadPlanContent">&#x270E;</button>
      <button class="icon-btn topic-action-btn plan-remove-btn" title="Remove Plan" data-plan-slug="${key}" data-plan-title="${escAttr(p.title)}" data-action="removePlan">&#x1F5D1;</button>
    </span>
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
			const noteMeta =
				n.format === "snippet" && n.content
					? `<div class="plan-meta plan-meta-snippet">${escHtml(n.content)}</div>`
					: `<div class="plan-meta">${escHtml(n.id)}.md</div>`;
			return `
  <div class="row plan-item" id="note-${n.id}">
    <span class="kb-tag t-note">N</span>
    <div class="r-main">
      <a class="r-title plan-title plan-title-link" href="#" title="Click to preview" data-action="previewNote" data-note-id="${escAttr(n.id)}" data-note-title="${escAttr(n.title)}">${escHtml(n.title)}</a>
      ${noteMeta}${buildRelevanceLine(lookupRelevance(relevanceMap, "note", n.id))}
    </div>
    <span class="r-actions plan-header-actions">
      ${noteTranslateBtn}<button class="icon-btn topic-action-btn plan-edit-btn" title="Edit Note" data-note-id="${escAttr(n.id)}" data-note-title="${escAttr(n.title)}" data-note-format="${n.format}" data-action="loadNoteContent">&#x270E;</button>
      <button class="icon-btn topic-action-btn plan-remove-btn" title="Remove Note" data-note-id="${escAttr(n.id)}" data-note-title="${escAttr(n.title)}" data-action="removeNote">&#x1F5D1;</button>
    </span>
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
		.map((e) =>
			buildReferenceRow(e, referenceTranslateSet, lookupRelevance(relevanceMap, "reference", `${e.source}:${e.nativeId}`)),
		)
		.join("\n");

	// AI soft-excluded items, inlined read-only after the kept rows (the old
	// collapsed "AI excluded N" details block is gone — one unified list).
	const excludedItems = excludedList.map((e) => buildExcludedRow(e)).join("\n");

	const allItems = planItems + noteItems + referenceItems + excludedItems;
	const hasAnyRow = totalCount > 0 || excludedList.length > 0;
	const countBadge =
		totalCount > 1 ? ` <span class="section-count">${totalCount}</span>` : "";

	// The Add dropdown + inline snippet form are static (no dependency on
	// plans/notes/references data) and are rendered by buildContextPanel in the
	// flat panel's header instead of here — see buildContextPanel. Their ids
	// (#addDropdown, #addDropdownMenu, #snippetForm, #snippetTitle,
	// #snippetContent, #saveSnippetBtn) are unchanged, so bindPlansAndNotesSection
	// and the delegated data-action dispatcher (both keyed on getElementById /
	// event delegation, not on being inside #plansAndNotesSection) keep working
	// across `plansAndNotesUpdated` in-place refreshes without re-render.
	return `
<div class="section" id="plansAndNotesSection">
  <div class="section-header">
    <div class="section-title">&#x1F4CB; CONTEXT${countBadge}</div>
  </div>
  ${hasAnyRow ? allItems : '<p class="e2e-placeholder">No plans or notes associated with this commit yet.</p>'}
</div>
<hr class="separator" />
`;
}

// ─── Files panel ──────────────────────────────────────────────────────────────

/**
 * One changed-file row for the Files panel: git status + path split into
 * dir/basename, plus the pre-rename path when the row is a rename. Rows are
 * rendered client-side by `renderFiles` in SummaryScriptBuilder.ts — this
 * type is the wire shape of the `files:rows` postMessage payload, not a
 * server-side rendering contract (there is no server-side row renderer;
 * `buildFilesPanelShell` below only emits the loading shell).
 */
export interface FileRow {
	readonly path: string;
	readonly dir: string;
	readonly status: string;
	/** Pre-rename path, only set when `status` is `"R"`. */
	readonly oldPath?: string;
}

/**
 * Build-time shell for the Files panel: a `.panel` with a `#filesBody`
 * container showing a "Loading…" placeholder. Per-file status requires a
 * `git diff-tree` call (SummaryWebviewPanel.handleLoadFiles), which is async
 * and not available at synchronous `buildHtml` render time — the actual rows
 * are rendered CLIENT-SIDE from the host's `files:rows` message (mirrors
 * buildConversationsSection / conversationsData). The stable `#filesPanel`
 * wrapper id lets a future in-place refresh target just this block, matching
 * the Conversations/Context panel convention.
 */
export function buildFilesPanelShell(): string {
	return `
<div class="panel" id="filesPanel">
  <div class="panel-header"><span class="panel-title">Files</span><span class="sec-count" id="filesCount">0</span></div>
  <div id="filesBody" class="files-body">
    <p class="files-loading">Loading files…</p>
  </div>
</div>`;
}

/**
 * Orders references by source for the webview, using the built-in
 * `SourceDefinition` registry as the render allowlist: only sources that ship
 * as a built-in definition are rendered, in registry order (linear → jira →
 * github → notion → slack → zoom-meeting → zoom-doc → asana → …), preserving
 * within-source order.
 *
 * Deriving the allowlist from `getRegistry()` — rather than a hand-maintained
 * subset — keeps every registered source visible (a new source appears here the
 * moment it joins `BUILTIN_DEFINITIONS`, no second edit) while preserving the
 * security property the previous hardcoded list provided: a `source` that is
 * NOT a registered built-in (e.g. a crafted string from a tampered orphan
 * branch / shared Memory Bank) is dropped, never rendered into the webview DOM.
 * Unlike `SummaryMarkdownBuilder.referencesBySourceOrder` (LLM-prompt path,
 * which appends unknown sources), this webview path deliberately does not append
 * leftovers.
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
	for (const def of getRegistry().all()) {
		const arr = bySource.get(def.id);
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
 * Renders one reference row. Mirrors the Plan/Note row shape (same shared CSS
 * classes: `row plan-item`, `plan-header-actions`, `plan-meta`, `plan-edit-area`,
 * `plan-edit-textarea`, `plan-edit-actions`) so the inline edit affordances
 * reuse all existing CSS — the row is just "a plan whose source is external",
 * tagged with a `.kb-tag.t-ref` source-letter badge instead of `.t-plan`/`.t-note`.
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
	relevance?: ContextRelevanceRef,
): string {
	const sourceMeta = getSourceMeta(e.source);
	const sourceLabel = sourceMeta.label;
	const sourceLetter = sourceMeta.letter;
	// DOM id: strip `<source>:` prefix uniformly across sources so the id
	// is `reference-<source>-<bareKey>` regardless of source.
	const domKey = stripSourcePrefix(e.archivedKey, e.source);
	// DOM/data attributes are the source-agnostic `data-reference-*` set (read
	// by the dispatcher). The earlier Linear-only `data-linear-*` attributes
	// were removed alongside the openLinearIssue* / removeLinearIssue
	// data-actions in favour of the `*Reference` names.
	// The `<nativeId> (Source)` sub-line only carries meaning for the issue
	// trackers (whose key the user recognizes); for machine-id sources (Notion /
	// Slack / phase-2) it is a meaningless blob already dropped from the title,
	// and the source is conveyed by the left badge + "Open in <Source>" button —
	// so the whole metaline is omitted rather than rendered as noise.
	const subLine = labelLeadsWithNativeId(e.source)
		? `\n      <div class="r-sub plan-meta">${escHtml(e.nativeId)} (${escHtml(sourceLabel)})</div>`
		: "";
	const showTranslate = referenceTranslateSet?.has(e.archivedKey) ?? false;
	const translateBtn = showTranslate
		? `<button class="topic-action-btn reference-translate-btn" title="Translate to English" data-reference-key="${escAttr(e.archivedKey)}" data-reference-source="${escAttr(e.source)}" data-action="translateReference">&#x1F310;</button>`
		: "";
	return `
  <div class="row plan-item" id="reference-${escAttr(e.source)}-${escAttr(domKey)}">
    <span class="kb-tag t-ref">${escHtml(sourceLetter)}</span>
    <div class="r-main">
      <a class="r-title plan-title plan-title-link" href="#" title="Click to preview" data-action="previewReference" data-reference-key="${escAttr(e.archivedKey)}" data-reference-source="${escAttr(e.source)}" data-reference-native-id="${escAttr(e.nativeId)}" data-reference-title="${escAttr(e.title)}">${escHtml(referenceDisplayTitle(e))}</a>${subLine}${buildRelevanceLine(relevance)}
    </div>
    <span class="r-actions plan-header-actions">
      <button class="icon-btn topic-action-btn" title="Open in ${escAttr(sourceLabel)}" data-reference-key="${escAttr(e.archivedKey)}" data-reference-source="${escAttr(e.source)}" data-reference-url="${escAttr(e.url ?? "")}" data-action="openReferenceExternal">&#x1F30D;</button>
      ${translateBtn}<button class="icon-btn topic-action-btn plan-edit-btn" title="Edit ${escAttr(sourceLabel)} snapshot" data-reference-key="${escAttr(e.archivedKey)}" data-reference-source="${escAttr(e.source)}" data-action="loadReferenceContent">&#x270E;</button>
      <button class="icon-btn topic-action-btn plan-remove-btn" title="Remove ${escAttr(sourceLabel)} Reference" data-reference-key="${escAttr(e.archivedKey)}" data-reference-source="${escAttr(e.source)}" data-reference-native-id="${escAttr(e.nativeId)}" data-reference-title="${escAttr(e.title)}" data-action="removeReference">&#x1F5D1;</button>
    </span>
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
 * Builds the page footer: a transcript-privacy note above the retained
 * "Generated by Jolli Memory" attribution and timestamp. When the summary
 * carries provider attribution (`llm.source`, present on summaries generated
 * after this field shipped) the provider name is appended as `· via
 * <provider>` — same shape as the Markdown footer so clipboard export and
 * webview display read consistently. The label is rendered into its own
 * `.footer-provider` span so panel CSS can style it independently from the
 * timestamp.
 * @param linkedConversationCount - Count of linked conversation transcripts
 * (`transcriptHashSet?.size ?? 0`), surfaced in the privacy note so users see
 * how many transcripts stay local before any shared export.
 */
function buildFooter(summary: CommitSummary, linkedConversationCount: number): string {
	const now = formatFullDate(new Date().toISOString());
	const provider = formatProviderLabel(summary);
	const providerSpan = provider
		? ` <span class="footer-provider">&middot; via ${escHtml(provider)}</span>`
		: "";
	return `
<p class="muted transcript-privacy"><span aria-hidden="true">&#x1F512;</span> Full conversation transcripts (${linkedConversationCount}) stay in your repo — never included in shared exports.</p>
<div class="page-footer">
  <span class="footer-generated">Generated by Jolli Memory &middot; ${escHtml(now)}</span>${providerSpan}
</div>`;
}
