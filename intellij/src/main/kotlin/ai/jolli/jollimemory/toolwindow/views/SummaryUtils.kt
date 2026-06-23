package ai.jolli.jollimemory.toolwindow.views

import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.PlanReference
import ai.jolli.jollimemory.core.SummaryTree
import ai.jolli.jollimemory.core.SummaryTree.TopicWithDate

/**
 * SummaryUtils — Shared utility functions for the Summary webview builders.
 * Leaf node with zero dependencies on sibling view files.
 */
object SummaryUtils {

    // ── HTML escaping ──────────────────────────────────────────────────────

    fun escHtml(str: String): String = str
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")

    /** Escapes a string for safe use inside an HTML attribute value. */
    fun escAttr(str: String): String = str
        .replace("&", "&amp;")
        .replace("\"", "&quot;")
        .replace("'", "&#39;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")

    // ── Date formatting ────────────────────────────────────────────────────

    fun formatDate(iso: String): String = try {
        val instant = java.time.Instant.parse(iso)
        val zdt = instant.atZone(java.time.ZoneId.systemDefault())
        val formatter = java.time.format.DateTimeFormatter.ofPattern("MMM d, yyyy", java.util.Locale.US)
        zdt.format(formatter)
    } catch (_: Exception) {
        iso
    }

    fun formatFullDate(iso: String): String = try {
        val instant = java.time.Instant.parse(iso)
        val zdt = instant.atZone(java.time.ZoneId.systemDefault())
        val formatter = java.time.format.DateTimeFormatter.ofPattern("MMMM d, yyyy 'at' h:mm a", java.util.Locale.US)
        zdt.format(formatter)
    } catch (_: Exception) {
        iso
    }

    fun timeAgo(iso: String): String = try {
        val diffMs = System.currentTimeMillis() - java.time.Instant.parse(iso).toEpochMilli()
        val diffMin = (diffMs / 60_000).toInt()
        val diffHour = diffMin / 60
        val diffDay = diffHour / 24

        when {
            diffDay > 30 -> formatDate(iso)
            diffDay > 1 -> "$diffDay days ago"
            diffDay == 1 -> "Yesterday"
            diffHour > 1 -> "$diffHour hours ago"
            diffHour == 1 -> "1 hour ago"
            diffMin > 1 -> "$diffMin minutes ago"
            diffMin == 1 -> "1 minute ago"
            else -> "Just now"
        }
    } catch (_: Exception) {
        iso
    }

    /** Extracts the date portion (YYYY-MM-DD) from an ISO string. */
    fun dayOnly(iso: String): String = iso.take(10)

    /** Pads a number to 2 digits (e.g. 0 → "01", 11 → "12"). */
    fun padIndex(i: Int): String = (i + 1).toString().padStart(2, '0')

    // ── Text rendering ─────────────────────────────────────────────────────

    /** Converts Markdown **bold** to <strong> tags. Input must already be HTML-escaped. */
    private fun inlineBold(html: String): String =
        html.replace(Regex("\\*\\*(.+?)\\*\\*"), "<strong>$1</strong>")

    /**
     * Renders callout body text as HTML. Detects Markdown-style unordered list
     * lines (- item) and converts them to <ul><li> elements.
     */
    fun renderCalloutText(raw: String): String {
        val lines = raw.split("\n")
        val parts = mutableListOf<String>()
        val listItems = mutableListOf<String>()
        val listPattern = Regex("^[-*]\\s+(.*)")

        fun flushList() {
            if (listItems.isNotEmpty()) {
                parts.add("<ul>${listItems.joinToString("") { "<li>$it</li>" }}</ul>")
                listItems.clear()
            }
        }

        for (line in lines) {
            val match = listPattern.find(line)
            if (match != null) {
                listItems.add(inlineBold(escHtml(match.groupValues[1])))
            } else {
                flushList()
                val trimmed = line.trim()
                if (trimmed.isNotEmpty()) {
                    parts.add(inlineBold(escHtml(trimmed)))
                }
            }
        }
        flushList()
        return parts.joinToString("<br>")
    }

    // ── Title builders ─────────────────────────────────────────────────────

    /** Regex fallback: extracts ticket from commit message or branch. */
    private fun extractTicketFallback(commitMessage: String, branch: String): String? {
        val pattern = Regex("[A-Z][A-Z0-9]+-\\d+")
        pattern.find(commitMessage)?.let { return it.value }
        val branchPattern = Regex("[A-Za-z][A-Za-z0-9]+-\\d+", RegexOption.IGNORE_CASE)
        branchPattern.find(branch)?.let { return it.value.uppercase() }
        return null
    }

    /** Builds panel title: date · ticket · hash · author */
    fun buildPanelTitle(summary: CommitSummary): String {
        val ticket = summary.ticketId ?: extractTicketFallback(summary.commitMessage, summary.branch)
        val date = summary.commitDate.take(10)
        val author = summary.commitAuthor
        val hash = summary.commitHash.take(7)
        return listOfNotNull(date, ticket, hash, author).joinToString(" · ")
    }

    /** Builds the memory document title for pushing to Jolli Space. */
    fun buildPushTitle(summary: CommitSummary): String {
        return summary.commitMessage
    }

    /** Builds the plan document title for pushing to Jolli Space. */
    fun buildPlanPushTitle(@Suppress("UNUSED_PARAMETER") summary: CommitSummary, planTitle: String): String {
        return planTitle
    }

    // ── Topic sorting / grouping ───────────────────────────────────────────

    /** Extended TopicWithDate wrapper for display. */
    data class ViewTopicWithDate(
        val topic: TopicWithDate,
    )

    /** Sorts topics: major before minor. */
    fun sortTopics(topics: List<ViewTopicWithDate>): List<ViewTopicWithDate> {
        return topics.sortedBy {
            if (it.topic.topic.importance?.name == "minor") 1 else 0
        }
    }

    /**
     * Collects all topics from a summary tree and returns them sorted.
     *
     * Under v4+ unified hoist all topics on a squash or amend root share the
     * root's date, so the previous "timeline grouping by day" feature
     * degenerated into a single useless group. Topics now render as one flat list.
     */
    fun collectSortedTopics(summary: CommitSummary): CollectedTopics {
        val sourceNodes = SummaryTree.collectSourceNodes(summary)
        val collected = SummaryTree.collectDisplayTopics(summary)
        val topics = sortTopics(collected.mapIndexed { i, tw ->
            ViewTopicWithDate(
                topic = tw.copy(treeIndex = i),
            )
        })
        return CollectedTopics(topics, sourceNodes)
    }

    data class CollectedTopics(
        val topics: List<ViewTopicWithDate>,
        val sourceNodes: List<CommitSummary>,
    )

    /**
     * Recursively collects all plan references from a summary tree, deduplicating by slug.
     */
    fun collectAllPlans(summary: CommitSummary): List<PlanReference> {
        val planMap = mutableMapOf<String, PlanReference>()

        fun walk(node: CommitSummary) {
            node.plans?.forEach { plan ->
                val existing = planMap[plan.slug]
                if (existing == null || plan.updatedAt > existing.updatedAt) {
                    planMap[plan.slug] = plan
                }
            }
            node.children?.forEach { walk(it) }
        }

        walk(summary)
        return planMap.values.toList()
    }

    /**
     * Maps a topic category to a CSS class group.
     */
    fun categoryClass(category: String?): String = when (category) {
        "feature" -> "cat-feature"
        "bugfix" -> "cat-bugfix"
        "refactor", "tech-debt", "performance" -> "cat-refactor"
        "devops", "security" -> "cat-infra"
        "test", "docs", "ux" -> "cat-docs"
        else -> ""
    }
}
