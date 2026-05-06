package ai.jolli.jollimemory.toolwindow.views

import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.E2eTestScenario
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils.ViewTopicWithDate
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils.collectSortedTopics
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils.escHtml
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils.padIndex

/**
 * SummaryPrMarkdownBuilder
 *
 * Builds a GitHub PR-description-optimized Markdown string from a
 * CommitSummary. Output uses GitHub-flavored HTML (`<details>`/`<summary>`
 * for folding, `<blockquote>` for visual body containers) and is NOT portable
 * to other markdown renderers — do NOT reuse this output for clipboard
 * export or Jolli document paths.
 *
 * Clipboard / Jolli-doc output lives in [SummaryMarkdownBuilder.buildMarkdown].
 * The two builders share [SummaryMarkdownBuilder.pushPlansAndNotesSection] and
 * [SummaryMarkdownBuilder.pushFooter].
 */
object SummaryPrMarkdownBuilder {

    /**
     * Builds a Markdown string optimized for GitHub PR descriptions.
     *
     * Sections emitted:
     * - Jolli Memory URL (if pushed)
     * - Associated Plans & Notes with URLs
     * - E2E Test Guide (each scenario folded in a `<details>` block)
     * - Topics: each topic folded with Why / Decisions / What /
     *   Future Enhancements (if any) / Files (if any)
     * - Footer
     */
    fun buildPrMarkdown(summary: CommitSummary): String {
        val (allTopics, _, _) = collectSortedTopics(summary)
        val lines = mutableListOf<String>()

        // Jolli Memory URL
        val memoryDocUrl = summary.jolliDocUrl
        if (memoryDocUrl != null) {
            lines.addAll(listOf("", "## Jolli Memory", "", memoryDocUrl))
        }

        SummaryMarkdownBuilder.pushPlansAndNotesSection(lines, summary)
        pushPrRecapSection(lines, summary)
        pushPrE2eTestSection(lines, summary.e2eTestGuide)
        pushPrTopicsSection(lines, allTopics)
        SummaryMarkdownBuilder.pushFooter(lines)

        return lines.joinToString("\n")
    }

    /** Appends the Quick Recap section for PR markdown if present. */
    private fun pushPrRecapSection(lines: MutableList<String>, summary: CommitSummary) {
        val recap = summary.recap?.trim()
        if (recap.isNullOrEmpty()) return
        lines.addAll(listOf("", "## Quick recap", "", recap, "", "---"))
    }

    // ── GitHub folding helpers ──────────────────────────────────────────────

    /**
     * Wraps a block of lines with `<details>`/`<summary>` for GitHub PR folding.
     *
     * A `<br>` is inserted after `</summary>` so that when expanded, the summary
     * label and body don't collide visually. Body is wrapped in `<blockquote>` for
     * GitHub's left-border + indent styling. `bodyLines` is expected to begin with
     * "" so that GFM switches from HTML mode to markdown parsing inside the blockquote.
     */
    internal fun wrapInGithubDetails(
        summaryContent: String,
        bodyLines: List<String>,
    ): List<String> {
        return listOf(
            "<details>",
            "<summary>$summaryContent</summary>",
            "<br>",
            "<blockquote>",
        ) + bodyLines + listOf(
            "",
            "</blockquote>",
            "</details>",
        )
    }

    /**
     * Escapes the block-level HTML tags used by [wrapInGithubDetails] so that
     * LLM-generated body content cannot prematurely close our outer wrappers.
     *
     * Escapes `<details>`, `</details>`, `<blockquote>`, `</blockquote>` (including
     * attribute variants like `<details open>`). Other HTML tags are preserved.
     */
    internal fun escapeGithubWrapperTags(text: String): String {
        return text
            .replace(Regex("<details\\b[^>]*>", RegexOption.IGNORE_CASE)) { m ->
                "&lt;${m.value.substring(1, m.value.length - 1)}&gt;"
            }
            .replace(Regex("</details\\s*>", RegexOption.IGNORE_CASE), "&lt;/details&gt;")
            .replace(Regex("<blockquote\\b[^>]*>", RegexOption.IGNORE_CASE)) { m ->
                "&lt;${m.value.substring(1, m.value.length - 1)}&gt;"
            }
            .replace(Regex("</blockquote\\s*>", RegexOption.IGNORE_CASE), "&lt;/blockquote&gt;")
    }

    // ── PR body section builders ────────────────────────────────────────────

    /**
     * Appends the E2E test guide section for PR markdown. Each scenario is
     * wrapped in a `<details>` block with its title in `<summary>`, and all
     * user-provided fields are sanitized against wrapper-tag injection.
     */
    private fun pushPrE2eTestSection(lines: MutableList<String>, e2eTestGuide: List<E2eTestScenario>?) {
        if (e2eTestGuide.isNullOrEmpty()) return

        lines.addAll(listOf("", "## E2E Test (${e2eTestGuide.size})"))

        for ((i, s) in e2eTestGuide.withIndex()) {
            val summaryContent = "<strong>${i + 1}. ${escHtml(s.title)}</strong>"
            val bodyOnly = mutableListOf<String>()
            if (s.preconditions != null) {
                bodyOnly.addAll(listOf("", "**Preconditions:** ${escapeGithubWrapperTags(s.preconditions)}"))
            }
            bodyOnly.addAll(listOf("", "**Steps:**"))
            for ((j, step) in s.steps.withIndex()) {
                bodyOnly.add("${j + 1}. ${escapeGithubWrapperTags(step)}")
            }
            bodyOnly.addAll(listOf("", "**Expected Results:**"))
            for (r in s.expectedResults) {
                bodyOnly.add("- ${escapeGithubWrapperTags(r)}")
            }
            lines.addAll(wrapInGithubDetails(summaryContent, bodyOnly))
        }

        lines.addAll(listOf("", "---"))
    }

    /**
     * Appends the PR topic body (trigger, decisions, response, todo, files).
     *
     * Same field set as the clipboard pushTopicBody — every topic is now folded
     * by default, so showing all detail fields no longer bloats the default PR view.
     * Free-text fields are sanitized against wrapper-tag injection.
     */
    private fun pushPrTopicBody(out: MutableList<String>, t: ViewTopicWithDate) {
        val topic = t.topic.topic
        out.addAll(listOf("", "**\u26A1 Why This Change**", "", escapeGithubWrapperTags(topic.trigger)))
        out.addAll(listOf("", "**\uD83D\uDCA1 Decisions Behind the Code**", "", escapeGithubWrapperTags(topic.decisions)))
        out.addAll(listOf("", "**\u2705 What Was Implemented**", "", escapeGithubWrapperTags(topic.response)))
        if (topic.todo != null) {
            out.addAll(listOf("", "**\uD83D\uDCCB Future Enhancements**", "", escapeGithubWrapperTags(topic.todo)))
        }
        if (!topic.filesAffected.isNullOrEmpty()) {
            out.addAll(listOf("", "**\uD83D\uDCC1 FILES**"))
            for (f in topic.filesAffected) {
                out.add("- `$f`")
            }
        }
    }

    /**
     * Appends the PR topics section with GitHub body-size truncation.
     * Each topic is folded in a `<details>` block; truncation stops adding
     * topics once the PR body would exceed the GitHub character limit.
     */
    private fun pushPrTopicsSection(
        lines: MutableList<String>,
        allTopics: List<ViewTopicWithDate>,
    ) {
        if (allTopics.isEmpty()) return

        val prBodyLimit = 65_000

        val heading = if (allTopics.size == 1) "Topic" else "Topics"
        lines.addAll(listOf("", "## $heading (${allTopics.size})"))

        var includedCount = 0
        val currentLength = { lines.joinToString("\n").length }

        for ((i, t) in allTopics.withIndex()) {
            val summaryContent = "<strong>${padIndex(i)} \u00b7 ${escHtml(t.topic.topic.title)}</strong>"
            val bodyOnly = mutableListOf<String>()
            pushPrTopicBody(bodyOnly, t)
            val topicLines = wrapInGithubDetails(summaryContent, bodyOnly)
            if (currentLength() + topicLines.joinToString("\n").length > prBodyLimit) break
            lines.addAll(topicLines)
            includedCount++
        }

        val omitted = allTopics.size - includedCount
        if (omitted > 0) {
            val noun = if (omitted != 1) "s" else ""
            lines.addAll(listOf("", "> \u26A0\uFE0F $omitted more topic$noun omitted due to GitHub PR body size limit."))
        }
    }
}
