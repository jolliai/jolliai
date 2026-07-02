package ai.jolli.jollimemory.toolwindow.views

import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.E2eTestScenario
import ai.jolli.jollimemory.core.PlanReference
import ai.jolli.jollimemory.core.SummaryTree
import ai.jolli.jollimemory.core.TopicCategory
import ai.jolli.jollimemory.core.references.ReferenceCommitRef
import ai.jolli.jollimemory.core.references.SourceId
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils.ViewTopicWithDate
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils.categoryClass
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils.collectSortedTopics
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils.escAttr
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils.escHtml
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils.formatDate
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils.formatFullDate
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils.padIndex
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils.renderCalloutText
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils.timeAgo
import com.google.gson.Gson

/**
 * SummaryHtmlBuilder — Kotlin port of SummaryHtmlBuilder.ts
 *
 * Assembles the complete HTML document for the Commit Memory webview.
 * Combines CSS, header, topic cards, timeline, E2E test guide, source
 * commits, footer, and interactive script into a single HTML string.
 */
object SummaryHtmlBuilder {

    private val gson = Gson()

    // ── Main HTML builder ─────────────────────────────────────────────────

    /**
     * Builds the complete HTML document for the summary webview.
     * @param summary The commit summary to render
     * @param isDark Whether to use dark theme colours
     * @param transcriptHashSet Set of commit hashes that have transcript files
     * @param planTranslateSet Set of plan slugs that support translation
     */
    fun buildHtml(
        summary: CommitSummary,
        isDark: Boolean = true,
        transcriptHashSet: Set<String> = emptySet(),
        planTranslateSet: Set<String> = emptySet(),
        bridgeScript: String = "",
        readOnly: Boolean = false,
    ): String {
        val (allTopics, sourceNodes) = collectSortedTopics(summary)
        val stats = SummaryTree.aggregateStats(summary)
        val totalInsertions = stats.insertions
        val totalDeletions = stats.deletions
        val totalFiles = stats.filesChanged

        val topicsHtml = if (allTopics.isEmpty()) {
            """<p class="empty">No topics available for this commit.</p>"""
        } else {
            allTopics.mapIndexed { i, t -> renderTopic(t, i) }.joinToString("\n")
        }

        val topicsLabel = "${allTopics.size} topic${if (allTopics.size != 1) "s" else ""} extracted from this commit"
        val topicsTitle = if (allTopics.size == 1) "Topic" else "Topics"

        return """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Commit Memory</title>
<style>${SummaryCssBuilder.buildCss(isDark)}${if (readOnly) """
/* Read-only mode: hide all write-action buttons but keep Copy Markdown */
.topic-action-btn, .associate-plan-btn, .plan-actions,
#pushJolliBtn, #shareBtn, #generateE2eBtn, #editE2eBtn, #regenE2eBtn, #deleteE2eBtn,
#generateRecapBtn, #editRecapBtn, #regenerateRecapBtn,
#openTranscriptsBtn, #deleteTranscriptsBtn,
.pr-section, .topic-card .topic-actions { display: none !important; }
""" else ""}</style>
</head>
<body>
<div class="page">
${buildHeader(summary, totalFiles, totalInsertions, totalDeletions)}
${buildShipBar(summary)}
${buildMemoryPanel(summary, allTopics, topicsHtml, topicsTitle, topicsLabel)}
${buildE2ePanel(summary)}
${buildAttachmentsPanel(summary.plans, planTranslateSet, sourceNodes, summary.references)}
${buildPrivateDrawer(transcriptHashSet)}
${buildFooter(summary)}
${buildShareModal(summary)}
</div>
${if (bridgeScript.isNotEmpty()) "<script>$bridgeScript</script>" else ""}
<script>${SummaryScriptBuilder.buildScript()}</script>
</body>
</html>"""
    }

    // ── E2E Test Section (public for in-place update) ─────────────────────

    /** Renders just the E2E test section HTML (for in-place update). */
    fun buildE2eTestSection(summary: CommitSummary): String {
        val scenarios = summary.e2eTestGuide

        if (scenarios.isNullOrEmpty()) {
            // Not yet generated — show placeholder + Generate button
            return """
<div class="section" id="e2eTestSection">
  <div class="section-header">
    <div class="section-title">&#x1F9EA; E2E Test</div>
    <button class="action-btn" id="generateE2eBtn">&#x2728; Generate</button>
  </div>
  <p class="e2e-placeholder">Generate step-by-step testing instructions for PR reviewers.<br>
  The guide describes how to manually verify each change from a user's perspective.</p>
</div>"""
        }

        // Scenarios exist — render each as a toggle
        val scenariosHtml = scenarios.mapIndexed { i, s -> renderE2eScenario(s, i) }.joinToString("\n")

        return """
<div class="section" id="e2eTestSection">
  <div class="section-header">
    <div class="section-title">&#x1F9EA; E2E Test <span class="section-count">${scenarios.size}</span></div>
    <span class="topic-actions">
      <button class="topic-action-btn" id="editE2eBtn" title="Edit">&#x270E;</button>
      <button class="topic-action-btn" id="regenE2eBtn" title="Regenerate">&#x1F504;</button>
      <button class="topic-action-btn" id="deleteE2eBtn" title="Delete">&#x1F5D1;</button>
    </span>
  </div>
  $scenariosHtml
</div>"""
    }

    // ── Quick Recap Section (public for in-place update) ───────────────────

    /** Renders the Quick Recap section HTML (for in-place update). */
    fun buildRecapSection(summary: CommitSummary): String {
        val trimmed = summary.recap?.trim()

        if (trimmed.isNullOrEmpty()) {
            return """
<div class="section recap-section" id="recapSection">
  <div class="section-header">
    <div class="section-title">&#x1F4D6; Quick recap</div>
    <button class="action-btn" id="generateRecapBtn">&#x2728; Generate</button>
  </div>
  <p class="recap-placeholder">Generate a recap that highlights the major work in this commit.</p>
</div>"""
        }

        val bodyHtml = trimmed.split(Regex("\n\n+"))
            .joinToString("") { "<p>${escHtml(it.trim())}</p>" }

        return """
<div class="section recap-section" id="recapSection" data-raw="${escAttr(trimmed)}">
  <div class="section-header">
    <div class="section-title">&#x1F4D6; Quick recap</div>
    <span class="topic-actions">
      <button class="topic-action-btn" id="editRecapBtn" title="Edit recap">&#x270E;</button>
      <button class="topic-action-btn" id="regenerateRecapBtn" title="Regenerate">&#x21BB;</button>
    </span>
  </div>
  <div class="recap-body">$bodyHtml</div>
</div>"""
    }

    // ── Single Topic (public for in-place update after edit) ──────────────

    /** Renders a single topic as HTML (for in-place update after edit). */
    fun renderTopic(topic: ViewTopicWithDate, displayIndex: Int): String {
        val t = topic.topic
        val topicData = t.topic
        // Use treeIndex for edit/delete operations; fall back to displayIndex
        val opIndex = t.treeIndex ?: displayIndex
        val catPill = if (topicData.category != null) {
            """ <span class="cat-pill ${categoryClass(topicData.category.name)}">${escHtml(topicData.category.name)}</span>"""
        } else {
            ""
        }
        val minorClass = if (topicData.importance?.name == "minor") " minor" else ""

        // Embed raw topic data as JSON in a data attribute for edit mode
        val topicJson = gson.toJson(
            mapOf(
                "title" to topicData.title,
                "trigger" to topicData.trigger,
                "response" to topicData.response,
                "decisions" to topicData.decisions,
                "todo" to (topicData.todo ?: ""),
                "filesAffected" to (topicData.filesAffected?.joinToString("\n") ?: ""),
            ),
        )

        val todoHidden = if (topicData.todo.isNullOrEmpty()) " hidden" else ""
        val todoText = if (!topicData.todo.isNullOrEmpty()) renderCalloutText(topicData.todo) else ""
        val filesHidden = if (topicData.filesAffected.isNullOrEmpty()) " hidden" else ""
        val filesText = if (!topicData.filesAffected.isNullOrEmpty()) {
            topicData.filesAffected.joinToString("\n        ") { f ->
                """<div class="files-affected-item">${escHtml(f)}</div>"""
            }
        } else {
            ""
        }

        return """
<div class="toggle" id="topic-$opIndex" data-topic='${escAttr(topicJson)}'>
  <div class="toggle-header$minorClass">
    <span class="arrow">&#x25BC;</span>
    <span class="toggle-num">${padIndex(displayIndex)}</span>
    <span class="toggle-title">${escHtml(topicData.title)}</span>$catPill
    <span class="topic-actions">
      <button class="topic-action-btn topic-edit-btn" data-topic-index="$opIndex" title="Edit memory">&#x270E;</button>
      <button class="topic-action-btn topic-delete-btn" data-topic-index="$opIndex" title="Delete memory">&#x1F5D1;</button>
    </span>
  </div>
  <div class="toggle-content">
    <div class="callout trigger" data-field="trigger">
      <div class="callout-body">
        <div class="callout-label">&#x26A1; Why this change</div>
        <div class="callout-text">${renderCalloutText(topicData.trigger)}</div>
      </div>
    </div>
    <div class="callout decisions" data-field="decisions">
      <div class="callout-body">
        <div class="callout-label">&#x1F4A1; Decisions behind the code</div>
        <div class="callout-text">${renderCalloutText(topicData.decisions)}</div>
      </div>
    </div>
    <div class="callout response collapsible callout-collapsed" data-field="response">
      <div class="callout-body">
        <div class="callout-label">&#x2705; What was implemented</div>
        <div class="callout-text">${renderCalloutText(topicData.response)}</div>
      </div>
    </div>
    <div class="callout todo collapsible callout-collapsed$todoHidden" data-field="todo">
      <div class="callout-body">
        <div class="callout-label">&#x1F4CB; Future enhancements</div>
        <div class="callout-text">$todoText</div>
      </div>
    </div>
    <div class="callout files collapsible callout-collapsed$filesHidden" data-field="filesAffected">
      <div class="callout-body">
        <div class="callout-label">&#x1F4C1; Files</div>
        <div class="callout-text">$filesText</div>
      </div>
    </div>
  </div>
</div>"""
    }

    // ── All Conversations Section ─────────────────────────────────────────

    /** Builds the All Conversations section with an Open button and the transcript Modal skeleton. */
    private fun buildAllConversationsSection(transcriptHashSet: Set<String>): String {
        val count = transcriptHashSet.size
        if (count == 0) {
            return """
<div class="private-zone">
  <div class="private-zone-watermark">PRIVATE</div>
  <div class="section-header">
    <div class="section-title">&#x1F4AC; All Conversations</div>
  </div>
  <p class="empty">No conversation transcripts saved for this commit.</p>
</div>"""
        }

        return """
<div class="private-zone" id="conversationsSection">
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
${buildTranscriptModal()}"""
    }

    /** Builds the transcript Modal overlay (hidden by default, shown via JS). */
    private fun buildTranscriptModal(): String {
        return """
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
</div>"""
    }

    // ── Share Modal ───────────────────────────────────────────────────────

    /** Builds the Share Modal overlay (hidden by default, shown via JS). */
    private fun buildShareModal(summary: CommitSummary): String {
        val topicCount = (summary.topics?.size ?: 0)
        val previewText = "${escHtml(summary.commitMessage.lineSequence().first().take(60))} · $topicCount decision${if (topicCount != 1) "s" else ""}"
        return """
<div class="sp-overlay" id="shareModal">
  <div class="sp-popover" id="sharePopover">
    <div class="sp-h">$SHARE_ICON<span>Share this memory</span></div>
    <div class="sp-form">
      <div class="sp-pv" id="spPreview">$previewText</div>
      <div class="sp-search">
        <input class="sp-search-input" id="spInvite" placeholder="Search teammates by name or email\u2026" autocomplete="off">
        <div class="sp-suggest" id="spSuggest">
          <div class="sp-suggest-h">From your Jolli account</div>
          <div class="sp-suggest-empty">No teammates found. Share the link below instead.</div>
        </div>
      </div>
      <div class="sp-sec">Collaborators</div>
      <div class="sp-collab" id="spCollab">
        <div class="sp-person">
          <span class="sp-av">You</span>
          <div class="sp-person-main">
            <div class="sp-name">You (owner)</div>
          </div>
          <span class="sp-role-own">Owner</span>
        </div>
      </div>
      <div class="sp-sec">General access</div>
      <div class="sp-gen">
        <div class="sp-row">
          $EYE_ICON
          <div class="sp-access-dropdown" id="spAccessDropdown">
            <button class="sp-access-toggle" id="spAccessToggle" type="button">
              <span id="spAccessLabel">Anyone with the link</span>
              <span class="sp-access-arrow">&#x25BE;</span>
            </button>
            <div class="sp-access-menu" id="spAccessMenu">
              <button class="sp-access-item" data-value="org">Anyone at your org</button>
              <button class="sp-access-item selected" data-value="link">Anyone with the link</button>
              <button class="sp-access-item" data-value="restricted">Only people you add</button>
            </div>
          </div>
        </div>
        <div class="sp-gen-desc" id="spGenDesc">Anyone with the link can open this.</div>
      </div>
      <div class="sp-egress">$SWAP_ICON<span>Summaries + decisions + linked refs travel. <b>Conversation transcripts stay on your machine.</b></span></div>
      <label class="sp-opt"><input type="checkbox" id="spTranscripts"><span>Include conversation transcripts</span><span class="sp-chip">opt-in</span></label>
      <div class="sp-foot">
        <button class="action-btn sp-copy" id="spCopyLink">$COPY_ICON Copy link</button>
      </div>
    </div>
  </div>
</div>"""
    }

    // ── Header ────────────────────────────────────────────────────────────

    /**
     * Builds the page header: title, compact meta strip, collapsible Details
     * property table, and a secondary-action row (Copy Markdown).
     * The Jolli "Share/Update" button moves to the ship bar (buildShipBar).
     */
    private fun buildHeader(
        summary: CommitSummary,
        totalFiles: Int,
        totalInsertions: Int,
        totalDeletions: Int,
    ): String {
        val filesPlural = if (totalFiles != 1) "s" else ""
        val insPlural = if (totalInsertions != 1) "s" else ""
        val delPlural = if (totalDeletions != 1) "s" else ""
        val changesHtml =
            """$totalFiles file$filesPlural changed, <span class="stat-add">$totalInsertions insertion$insPlural(+)</span>, <span class="stat-del">$totalDeletions deletion$delPlural(-)</span>"""
        val totalTurns = SummaryTree.aggregateTurns(summary)
        val shortHash = escHtml(summary.commitHash.take(8))
        val turnsMeta = if (totalTurns > 0)
            """<span class="meta-sep">&middot;</span><span class="stat-turns">&#x1F4AC; $totalTurns</span>"""
        else ""

        return """
<h1 class="page-title">${escHtml(summary.commitMessage)}</h1>
<div class="meta-strip">
  <span class="meta-hash">$shortHash</span>
  <span class="meta-sep">&middot;</span>
  <span class="meta-branch" title="${escAttr(summary.branch)}">${escHtml(summary.branch)}</span>
  <span class="meta-sep">&middot;</span>
  <span class="meta-author">${escHtml(summary.commitAuthor)}</span>
  <span class="meta-sep">&middot;</span>
  <span class="meta-date">${timeAgo(summary.commitDate)}</span>
  <span class="meta-sep">&middot;</span>
  <span class="meta-changes"><span class="stat-add">+$totalInsertions</span>/<span class="stat-del">&#x2212;$totalDeletions</span></span>
  $turnsMeta
  <button class="details-toggle" id="detailsToggle" aria-expanded="false">Details &#x25BE;</button>
  <button class="action-btn meta-share" id="shareBtn">$SHARE_ICON Share</button>
</div>
<div class="properties collapsed" id="propertiesSection">
  <div class="prop-row">
    <div class="prop-label">Commit</div>
    <div class="prop-value">
      <span class="hash">$shortHash</span>
      <button class="hash-copy" data-hash="${escHtml(summary.commitHash)}" title="Copy full hash">&#x29C9;</button>
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
    <div class="prop-value">$changesHtml</div>
  </div>
  ${buildConversationsRow(totalTurns)}
</div>
"""
    }

    /** Builds the optional "Conversations" property row. Returns empty string when turns is 0. */
    private fun buildConversationsRow(totalTurns: Int): String {
        if (totalTurns <= 0) return ""
        val plural = if (totalTurns != 1) "s" else ""
        return """
  <div class="prop-row">
    <div class="prop-label">Conversations</div>
    <div class="prop-value"><span class="stat-turns">&#x1F4AC; $totalTurns turn$plural</span></div>
  </div>"""
    }

    /** Builds the "Duration" property row HTML. */
    private fun buildDurationRow(summary: CommitSummary): String {
        return """
  <div class="prop-row">
    <div class="prop-label">Duration</div>
    <div class="prop-value">${escHtml(SummaryTree.formatDurationLabel(summary))}</div>
  </div>"""
    }

    /**
     * Builds the Jolli Memory link block. Now lives inside the Jolli ship card
     * (not in the properties table). Returns empty string when not shared.
     */
    private fun buildJolliRow(
        url: String?,
        commitMessage: String?,
        plans: List<PlanReference>?,
    ): String {
        if (url == null) return ""
        val memoryTooltip = if (commitMessage != null) escHtml(commitMessage) else "View on Jolli"
        val publishedPlans = (plans ?: emptyList()).filter { it.jolliPlanDocUrl != null }
        val plansHtml = if (publishedPlans.isNotEmpty()) {
            val planItems = publishedPlans.joinToString("") { p ->
                val planUrl = p.jolliPlanDocUrl!!
                """<div class="jolli-plan-item"><a class="jolli-link" href="${escHtml(planUrl)}" title="${escHtml(p.title)}">${escHtml(planUrl)}</a></div>"""
            }
            """<div class="jolli-plans-block"><span class="jolli-plans-label">Plans</span>$planItems</div>"""
        } else {
            ""
        }
        return """
  <div id="jolliRow" class="jolli-status">
    <a class="jolli-link" href="${escHtml(url)}" title="$memoryTooltip">${escHtml(url)}</a>
    $plansHtml
  </div>"""
    }

    // ── Share icons ────────────────────────────────────────────────────────

    /** Upload/share SVG icon (16x16). */
    private const val SHARE_ICON = """<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-2px;"><path d="M8 1L12 5H9V10H7V5H4L8 1ZM2 9V13C2 13.55 2.45 14 3 14H13C13.55 14 14 13.55 14 13V9H12V12H4V9H2Z"/></svg>"""

    /** Markdown mark SVG icon (16x10). */
    private const val MARKDOWN_ICON = """<svg width="16" height="10" viewBox="0 0 208 128" fill="currentColor" style="vertical-align:-1px;"><rect width="198" height="118" x="5" y="5" ry="10" stroke="currentColor" stroke-width="10" fill="none"/><path d="M30 98V30h20l20 25 20-25h20v68H90V59L70 84 50 59v39zm125 0l-30-33h20V30h20v35h20z"/></svg>"""

    /** PDF document SVG icon (14x14). */
    private const val PDF_ICON = """<svg width="14" height="14" viewBox="0 0 550.801 550.801" fill="currentColor" style="vertical-align:-2px;"><path d="M160.381,282.225c0-14.832-10.299-23.684-28.474-23.684c-7.414,0-12.437,0.715-15.071,1.432V307.6c3.114,0.707,6.942,0.949,12.192,0.949C148.419,308.549,160.381,298.74,160.381,282.225z"/><path d="M272.875,259.019c-8.145,0-13.397,0.717-16.519,1.435v105.523c3.116,0.729,8.142,0.729,12.69,0.729c33.017,0.231,54.554-17.946,54.554-56.474C323.842,276.719,304.215,259.019,272.875,259.019z"/><path d="M488.426,197.019H475.2v-63.816c0-0.398-0.063-0.799-0.116-1.202c-0.021-2.534-0.827-5.023-2.562-6.995L366.325,3.694c-0.032-0.031-0.063-0.042-0.085-0.076c-0.633-0.707-1.371-1.295-2.151-1.804c-0.231-0.155-0.464-0.285-0.706-0.419c-0.676-0.369-1.393-0.675-2.131-0.896c-0.2-0.056-0.38-0.138-0.58-0.19C359.87,0.119,359.037,0,358.193,0H97.2c-11.918,0-21.6,9.693-21.6,21.601v175.413H62.377c-17.049,0-30.873,13.818-30.873,30.873v160.545c0,17.043,13.824,30.87,30.873,30.87h13.224V529.2c0,11.907,9.682,21.601,21.6,21.601h356.4c11.907,0,21.6-9.693,21.6-21.601V419.302h13.226c17.044,0,30.871-13.827,30.871-30.87v-160.54C519.297,210.838,505.47,197.019,488.426,197.019z M97.2,21.605h250.193v110.513c0,5.967,4.841,10.8,10.8,10.8h95.407v54.108H97.2V21.605z M362.359,309.023c0,30.876-11.243,52.165-26.82,65.333c-16.971,14.117-42.82,20.814-74.396,20.814c-18.9,0-32.297-1.197-41.401-2.389V234.365c13.399-2.149,30.878-3.346,49.304-3.346c30.612,0,50.478,5.508,66.039,17.226C351.828,260.69,362.359,280.547,362.359,309.023z M80.7,393.499V234.365c11.241-1.904,27.042-3.346,49.296-3.346c22.491,0,38.527,4.308,49.291,12.928c10.292,8.131,17.215,21.534,17.215,37.328c0,15.799-5.25,29.198-14.829,38.285c-12.442,11.728-30.865,16.996-52.407,16.996c-4.778,0-9.1-0.243-12.435-0.723v57.67H80.7V393.499z M453.601,523.353H97.2V419.302h356.4V523.353z M484.898,262.127h-61.989v36.851h57.913v29.674h-57.913v64.848h-36.593V232.216h98.582V262.127z"/></svg>"""

    /** Clipboard/copy SVG icon (14x14). */
    private const val COPY_ICON = """<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4h1V2h7v7h-2v1h3V1H4v3zm-1 1h7v9H3V5z"/></svg>"""

    // ── Share modal icons ─────────────────────────────────────────────────

    /** Eye icon for general access row. */
    private const val EYE_ICON = """<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0;"><path d="M8 3C4.5 3 1.7 5.1.5 8c1.2 2.9 4 5 7.5 5s6.3-2.1 7.5-5c-1.2-2.9-4-5-7.5-5zm0 8.3A3.3 3.3 0 1 1 8 4.7a3.3 3.3 0 0 1 0 6.6zm0-5.3a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>"""

    /** Swap/arrows icon for egress notice. */
    private const val SWAP_ICON = """<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0;margin-top:1px;"><path d="M5 3L2 6h2v5h2V6h2L5 3zm6 10l3-3h-2V5h-2v5H8l3 3z"/></svg>"""

    // ── PR Section ─────────────────────────────────────────────────────────

    /** GitHub Pull Request SVG icon (16x16). */
    private const val PR_ICON = """<svg class="pr-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z"/></svg>"""

    /**
     * Builds the PR section matching VS Code's PrCommentService.buildPrSectionHtml.
     * Shows a loading status initially, then dynamically switches between:
     * - "Create PR" button (when no PR exists for the branch)
     * - PR link + "Edit PR" button (when PR already exists)
     * - Error messages (multiple commits, gh not available)
     * - Create/Edit form (when user clicks the action buttons)
     */
    private fun buildPrSection(summary: CommitSummary): String {
        val prMarkdown = SummaryPrMarkdownBuilder.buildPrMarkdown(summary)
        val escapedTitle = escAttr(summary.commitMessage)
        val escapedBody = escAttr(ai.jolli.jollimemory.services.PrService.wrapWithMarkers(prMarkdown))

        val hasRecap = !summary.recap.isNullOrBlank()
        val hasE2e = !summary.e2eTestGuide.isNullOrEmpty()

        data class PrContentItem(val icon: String, val label: String, val included: Boolean)
        val notIncluded = listOf(
            PrContentItem("&#x1F4D6;", "Quick Recap", hasRecap),
            PrContentItem("&#x1F9EA;", "E2E Test", hasE2e),
        ).filter { !it.included }

        val notIncludedHtml = if (notIncluded.isNotEmpty()) {
            val listItems = notIncluded.joinToString("\n") {
                """    <li>&#x274C; ${it.icon} ${it.label}</li>"""
            }
            """
  <div class="pr-content-status">
    <div class="pr-content-label">Will not be included (add below):</div>
    <ul class="pr-content-list">
$listItems
    </ul>
  </div>"""
        } else ""

        return """
<div class="section" id="prSection">
  <div class="section-header">
    <div class="section-title">$PR_ICON Pull Request</div>
    <span class="ship-status is-loading" id="prStatusChip"><span class="led"></span>Checking&hellip;</span>
  </div>
  <p class="pr-status-text" id="prStatusText">Checking PR status...</p>
  <div class="pr-link-row pr-hidden" id="prLinkRow"></div>$notIncludedHtml
  <div class="pr-actions pr-hidden" id="prActions"></div>
  <div class="pr-history pr-hidden" id="prHistory"></div>
  <div class="pr-form pr-hidden" id="prForm" data-title="$escapedTitle" data-body="$escapedBody">
    <label class="pr-form-label">Title</label>
    <input type="text" class="pr-form-input" id="prTitleInput" />
    <label class="pr-form-label">Body</label>
    <textarea class="pr-form-textarea" id="prBodyInput" rows="12"></textarea>
    <div class="pr-form-actions">
      <button class="action-btn" id="prFormCancel">Cancel</button>
      <button class="action-btn primary" id="prFormSubmit">Submit PR</button>
    </div>
  </div>
</div>"""
    }

    // ── Ship bar + content panels (presentation wrappers) ─────────────────

    /**
     * Builds the hero "ship bar": the PR card (wraps #prSection) and the Jolli
     * card (relocated #pushJolliBtn + synced/not-shared status chip).
     */
    private fun buildShipBar(summary: CommitSummary): String {
        val synced = summary.jolliDocUrl != null
        val pushLabel = if (synced) "Update on Jolli" else "Share in Jolli"
        val jolliChip = if (synced)
            """<span class="ship-status is-ok"><span class="led"></span>Synced</span>"""
        else
            """<span class="ship-status is-warn"><span class="led"></span>Not shared</span>"""
        val jolliSub = if (!synced)
            """<div class="ship-sub">Lives only on your machine. Share to publish this memory to your team's Jolli space.</div>"""
        else ""
        return """
<div class="ship-bar">
  <div class="ship-card" id="prCard">
    ${buildPrSection(summary)}
  </div>
  <div class="ship-card" id="jolliCard">
    <div class="ship-head">
      <span class="ship-icon">&#x25C6;</span>
      <span class="ship-name">Jolli Memory</span>
      $jolliChip
    </div>
    $jolliSub
    ${buildJolliRow(summary.jolliDocUrl, summary.commitMessage, summary.plans)}
    <div class="ship-actions">
      <button class="action-btn primary" id="pushJolliBtn">$pushLabel</button>
    </div>
  </div>
</div>"""
    }

    /** Wraps recap + topics in a single "The Memory" panel. */
    private fun buildMemoryPanel(
        summary: CommitSummary,
        allTopics: List<ViewTopicWithDate>,
        topicsHtml: String,
        topicsTitle: String,
        topicsLabel: String,
    ): String {
        return """
<div class="panel" id="memoryPanel">
  <div class="panel-header"><span class="panel-title">The memory</span></div>
  ${buildRecapSection(summary)}
  <div class="section" id="topicsSection">
    <div class="section-header">
      <div class="section-title" title="${escAttr(topicsLabel)}">&#x1F4DD; $topicsTitle <span class="section-count">${allTopics.size}</span></div>
      <button class="toggle-all-btn" id="toggleAllBtn" title="Expand / Collapse all topics">Collapse All</button>
    </div>
    $topicsHtml
  </div>
</div>"""
    }

    /** Wraps the E2E section in its own panel. */
    private fun buildE2ePanel(summary: CommitSummary): String {
        return """
<div class="panel" id="e2ePanel">
  ${buildE2eTestSection(summary)}
</div>"""
    }

    /** Builds the "Attachments & context" panel with collapsible cards. */
    private fun buildAttachmentsPanel(
        plans: List<PlanReference>?,
        planTranslateSet: Set<String>,
        sourceNodes: List<CommitSummary>,
        references: List<ReferenceCommitRef>? = null,
    ): String {
        val plansBody = buildPlansSection(plans, planTranslateSet, references)
        val sourceBody = buildSourceCommits(sourceNodes)
        val sourceCard = if (sourceBody.isNotEmpty()) """
  <div class="attach-card" id="sourceCard">
    <div class="attach-card-head" data-collapse="sourceCard" role="button" tabindex="0" aria-expanded="true">&#x1F4E6; Source Commits <span class="attach-arrow">&#x25BC;</span></div>
    <div class="attach-card-body">$sourceBody</div>
  </div>"""
        else ""

        return """
<div class="panel" id="attachmentsPanel">
  <div class="panel-header"><span class="panel-title">Attachments &amp; context</span></div>
  <div class="attach-card" id="plansCard">
    <div class="attach-card-head" data-collapse="plansCard" role="button" tabindex="0" aria-expanded="true">&#x1F4CB; Plans &amp; Notes <span class="attach-arrow">&#x25BC;</span></div>
    <div class="attach-card-body">$plansBody</div>
  </div>
  $sourceCard
</div>"""
    }

    /** Demotes conversations to a collapsible private drawer at the bottom. */
    private fun buildPrivateDrawer(transcriptHashSet: Set<String>): String {
        val count = transcriptHashSet.size
        val countLabel = if (count > 0)
            """<span class="private-count">$count session${if (count != 1) "s" else ""}</span>"""
        else ""
        return """
<div class="private-drawer" id="privateDrawer">
  <div class="private-head" data-collapse="privateDrawer" role="button" tabindex="0" aria-expanded="true">
    <span class="private-lock">&#x1F512;</span>
    <span class="private-title">All Conversations</span>
    <span class="private-badge">PRIVATE</span>
    $countLabel
    <span class="attach-arrow">&#x25BC;</span>
  </div>
  <div class="private-body">${buildAllConversationsSection(transcriptHashSet)}</div>
</div>"""
    }

    // ── Plans Section ─────────────────────────────────────────────────────

    // ── Reference helpers ──────────────────────────────────────────────────

    private val SOURCE_TITLES = mapOf(
        SourceId.linear to "Linear",
        SourceId.jira to "Jira",
        SourceId.github to "GitHub",
        SourceId.notion to "Notion",
    )

    private val SOURCE_ORDER = listOf(SourceId.linear, SourceId.jira, SourceId.github, SourceId.notion)

    /** Strips the `<source>:` prefix from archivedKey for DOM id use. */
    private fun stripSourcePrefix(archivedKey: String, source: SourceId): String {
        val prefix = "${source.name}:"
        return if (archivedKey.startsWith(prefix)) archivedKey.removePrefix(prefix) else archivedKey
    }

    /** Orders references by source (linear -> jira -> github -> notion), preserving within-source order. */
    private fun referencesBySourceOrder(references: List<ReferenceCommitRef>): List<ReferenceCommitRef> {
        val bySource = mutableMapOf<SourceId, MutableList<ReferenceCommitRef>>()
        for (r in references) bySource.getOrPut(r.source) { mutableListOf() }.add(r)
        return SOURCE_ORDER.flatMap { bySource[it] ?: emptyList() }
    }

    /** Renders a single reference row matching VS Code's buildReferenceRow. */
    private fun buildReferenceRow(e: ReferenceCommitRef): String {
        val sourceLabel = SOURCE_TITLES[e.source] ?: e.source.name
        val domKey = stripSourcePrefix(e.archivedKey, e.source)
        return """
  <div class="plan-item" id="reference-${escAttr(e.source.name)}-${escAttr(domKey)}">
    <div class="plan-header">
      <a class="plan-title plan-title-link" href="#" title="Click to preview" data-action="previewReference" data-reference-key="${escAttr(e.archivedKey)}" data-reference-source="${escAttr(e.source.name)}" data-reference-native-id="${escAttr(e.nativeId)}" data-reference-title="${escAttr(e.title)}">${escHtml(e.nativeId)} &mdash; ${escHtml(e.title)}</a>
      <span class="plan-header-actions">
        <button class="topic-action-btn" title="Open in $sourceLabel" data-reference-key="${escAttr(e.archivedKey)}" data-reference-source="${escAttr(e.source.name)}" data-reference-url="${escAttr(e.url)}" data-action="openReferenceExternal">&#x1F30D;</button>
        <button class="topic-action-btn plan-edit-btn" title="Edit $sourceLabel snapshot" data-reference-key="${escAttr(e.archivedKey)}" data-reference-source="${escAttr(e.source.name)}" data-action="loadReferenceContent">&#x270E;</button>
        <button class="topic-action-btn plan-remove-btn" title="Remove $sourceLabel Reference" data-reference-key="${escAttr(e.archivedKey)}" data-reference-source="${escAttr(e.source.name)}" data-reference-native-id="${escAttr(e.nativeId)}" data-reference-title="${escAttr(e.title)}" data-action="removeReference">&#x1F5D1;</button>
      </span>
    </div>
    <div class="plan-meta">${escHtml(e.nativeId)} ($sourceLabel)</div>
    <div class="plan-edit-area">
      <textarea class="plan-edit-textarea" data-reference-key="${escAttr(e.archivedKey)}" rows="20"></textarea>
      <div class="plan-edit-actions">
        <button class="action-btn" data-action="cancelReferenceEdit" data-reference-key="${escAttr(e.archivedKey)}" data-reference-source="${escAttr(e.source.name)}">Cancel</button>
        <button class="action-btn primary" data-action="saveReferenceEdit" data-reference-key="${escAttr(e.archivedKey)}" data-reference-source="${escAttr(e.source.name)}">Save</button>
      </div>
    </div>
  </div>"""
    }

    // ── Plans & References Section ───────────────────────────────────────

    /** Builds the Plans section showing associated plan files and references. Always shown so users can associate plans. */
    private fun buildPlansSection(
        plans: List<PlanReference>?,
        planTranslateSet: Set<String>,
        references: List<ReferenceCommitRef>? = null,
    ): String {
        val planList = plans ?: emptyList()
        val refList = references ?: emptyList()

        val planItems = planList.joinToString("\n") { p ->
            val key = p.slug
            val showTranslate = planTranslateSet.contains(key)
            val translateBtn = if (showTranslate) {
                """<button class="topic-action-btn plan-translate-btn" title="Translate to English" data-plan-slug="$key" data-action="translatePlan">&#x1F310;</button>"""
            } else {
                ""
            }
            """
  <div class="plan-item" id="plan-$key">
    <div class="plan-header">
      <a class="plan-title plan-title-link" href="#" title="Click to preview" data-action="previewPlan" data-plan-slug="$key" data-plan-title="${escAttr(p.title)}">${escHtml(p.title)}</a>
      <span class="plan-header-actions">
        $translateBtn<button class="topic-action-btn plan-edit-btn" title="Edit Plan" data-plan-slug="$key" data-action="loadPlanContent">&#x270E;</button>
        <button class="topic-action-btn plan-remove-btn" title="Remove Plan" data-plan-slug="$key" data-plan-title="${escAttr(p.title)}" data-action="removePlan">&#x1F5D1;</button>
      </span>
    </div>
    <div class="plan-meta">${escHtml(key)}.md &middot; edited ${p.editCount} time${if (p.editCount != 1) "s" else ""}</div>
    <div class="plan-edit-area">
      <textarea class="plan-edit-textarea" data-plan-slug="$key" rows="20"></textarea>
      <div class="plan-edit-actions">
        <button class="action-btn" data-action="cancelPlanEdit" data-plan-slug="$key">Cancel</button>
        <button class="action-btn primary" data-action="savePlanEdit" data-plan-slug="$key">Save</button>
      </div>
    </div>
  </div>"""
        }

        val referenceItems = referencesBySourceOrder(refList).joinToString("\n") { buildReferenceRow(it) }
        val allItems = planItems + referenceItems
        val totalCount = planList.size + refList.size

        val sectionCount = if (totalCount > 1) """ <span class="section-count">$totalCount</span>""" else ""
        val body = if (allItems.isNotEmpty()) allItems
        else """<p class="e2e-placeholder">No plans associated with this commit yet.</p>"""

        return """
<div class="section" id="plansSection">
  <div class="section-header">
    <div class="section-title">&#x1F4CB; Plans$sectionCount</div>
    <button class="action-btn associate-plan-btn" data-action="associatePlan">+ Associate Plan</button>
  </div>
  $body
</div>
"""
    }

    // ── E2E Test Scenario ─────────────────────────────────────────────────

    /** Renders a single E2E test scenario as a collapsible toggle. */
    private fun renderE2eScenario(s: E2eTestScenario, index: Int): String {
        val preconditionsHtml = if (!s.preconditions.isNullOrEmpty()) {
            """
    <div class="callout preconditions">
      <div class="callout-body">
        <div class="callout-label">&#x1F4CB; Preconditions</div>
        <div class="callout-text">${escHtml(s.preconditions)}</div>
      </div>
    </div>"""
        } else {
            ""
        }

        val stepsHtml = s.steps.joinToString("\n        ") { step -> "<li>${escHtml(step)}</li>" }
        val expectedHtml = s.expectedResults.joinToString("\n        ") { r -> "<li>${escHtml(r)}</li>" }

        return """
<div class="toggle e2e-scenario collapsed" id="e2e-scenario-$index">
  <div class="toggle-header">
    <span class="arrow">&#x25BC;</span>
    <span class="toggle-num">${padIndex(index)}</span>
    <span class="toggle-title">${escHtml(s.title)}</span>
  </div>
  <div class="toggle-content">
    $preconditionsHtml
    <div class="callout steps">
      <div class="callout-body">
        <div class="callout-label">&#x1F463; Steps</div>
        <div class="callout-text"><ol>$stepsHtml</ol></div>
      </div>
    </div>
    <div class="callout expected">
      <div class="callout-body">
        <div class="callout-label">&#x2705; Expected Results</div>
        <div class="callout-text"><ul>$expectedHtml</ul></div>
      </div>
    </div>
  </div>
</div>"""
    }

    // ── Source Commits ────────────────────────────────────────────────────

    /** Builds the Source Commits section. Returns empty string for single-source summaries. */
    private fun buildSourceCommits(sourceNodes: List<CommitSummary>): String {
        if (sourceNodes.size <= 1) return ""

        val rows = sourceNodes.joinToString("\n") { n -> renderCommitRow(n) }

        return """
<div class="section">
  <div class="section-title" title="${sourceNodes.size} commits squashed into this summary">&#x1F4E6; Source Commits <span class="section-count">${sourceNodes.size}</span></div>
  <div class="commit-list">
    $rows
  </div>
</div>"""
    }

    /** Renders a single source commit as a compact row. */
    private fun renderCommitRow(node: CommitSummary): String {
        val turns = node.conversationTurns
        val turnsSuffix = if (turns != null && turns > 0) {
            val plural = if (turns != 1) "s" else ""
            """ &middot; <span class="stat-turns">$turns turn$plural</span>"""
        } else {
            ""
        }
        val ins = node.stats?.insertions ?: 0
        val del = node.stats?.deletions ?: 0
        return """<div class="commit-row">
  <span class="hash">${escHtml(node.commitHash.take(8))}</span>
  <span class="commit-msg">${escHtml(node.commitMessage)}</span>
  <span class="commit-meta"><span class="stat-add">+$ins</span> <span class="stat-del">&#x2212;$del</span>$turnsSuffix &middot; ${formatDate(node.commitDate)}</span>
</div>"""
    }

    // ── Footer ────────────────────────────────────────────────────────────

    /** Builds the page footer with a "Generated by JolliMemory" attribution, timestamp, and provider. */
    private fun buildFooter(summary: CommitSummary): String {
        val now = formatFullDate(java.time.Instant.now().toString())
        val providerSuffix = formatProviderLabel(summary)?.let { " &middot; via ${escHtml(it)}" } ?: ""
        return """
<div class="page-footer">
  <span class="footer-generated">Generated by JolliMemory &middot; ${escHtml(now)}$providerSuffix</span>
</div>"""
    }

    /** Maps LLM credential source values to human-readable labels. */
    private val PROVIDER_LABELS = mapOf(
        "anthropic-config" to "Anthropic",
        "anthropic-env" to "Anthropic (env)",
        "jolli-proxy" to "Jolli proxy",
    )

    /** Walks the summary tree collecting distinct LLM source values, then formats a provider label. */
    internal fun formatProviderLabel(summary: CommitSummary): String? {
        val sources = mutableListOf<String>()
        fun visit(node: CommitSummary) {
            node.llm?.source?.let { if (it !in sources) sources.add(it) }
            node.children?.forEach { visit(it) }
        }
        visit(summary)
        if (sources.isEmpty()) return null
        if (sources.size == 1) return PROVIDER_LABELS[sources[0]] ?: sources[0]
        return "mixed: ${sources.joinToString(", ") { PROVIDER_LABELS[it] ?: it }}"
    }
}
