package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.core.references.PromptRenderer
import java.io.File

/**
 * PlanPromptFormatter — renders active plan entries into a `<plans>` XML block for
 * the summary prompt. Kotlin port of the CLI `PlanPromptFormatter.ts`.
 *
 * Ordering: the caller's order is preserved verbatim (the relevance ranker sorts
 * most-relevant-first). Greedy selection within a total char budget so over-budget
 * truncation drops the LEAST relevant, not the oldest. An unranked caller gets
 * insertion order.
 */
object PlanPromptFormatter {

    private val log = JmLogger.create("PlanPromptFormatter")

    private const val DEFAULT_MAX_CHARS_PER_PLAN = 4000
    private const val DEFAULT_MAX_TOTAL_CHARS = 30000

    /** Reads the plan body from its sourcePath; empty string when missing/unreadable. */
    private fun readPlanBody(sourcePath: String): String {
        return try {
            val f = File(sourcePath)
            if (f.exists()) f.readText(Charsets.UTF_8) else ""
        } catch (_: Exception) {
            ""
        }
    }

    private fun truncate(s: String, max: Int): String {
        if (s.length <= max) return s
        return "${s.take(max)}\n…[truncated, ${s.length - max} more chars]"
    }

    /** Renders one plan as an `<plan>` element with its (truncated) body. */
    private fun renderOnePlan(entry: PlanEntry, body: String, maxPerPlan: Int): String {
        val lines = mutableListOf("<plan slug=\"${PromptRenderer.escapeForAttr(entry.slug)}\" title=\"${PromptRenderer.escapeForAttr(entry.title)}\">")
        val trimmed = body.trim()
        if (trimmed.isNotEmpty()) {
            lines.add(PromptRenderer.escapeForText(truncate(trimmed, maxPerPlan)))
        }
        lines.add("</plan>")
        return lines.joinToString("\n")
    }

    /**
     * Renders the `<plans>` block for [entries], in caller order, within budget.
     * Returns "" when there is nothing to render.
     */
    fun formatPlansBlock(
        entries: List<PlanEntry>,
        maxCharsPerPlan: Int = DEFAULT_MAX_CHARS_PER_PLAN,
        maxTotalChars: Int = DEFAULT_MAX_TOTAL_CHARS,
    ): String {
        if (entries.isEmpty()) return ""

        val selected = mutableListOf<Pair<PlanEntry, String>>()
        var totalLen = 0
        for (entry in entries) {
            val body = readPlanBody(entry.sourcePath)
            val rendered = renderOnePlan(entry, body, maxCharsPerPlan)
            if (totalLen + rendered.length > maxTotalChars) break
            selected.add(entry to body)
            totalLen += rendered.length
        }
        if (selected.isEmpty()) return ""

        val inner = selected.joinToString("\n") { (entry, body) -> renderOnePlan(entry, body, maxCharsPerPlan) }
        log.info("Formatted plans block: %d of %d plan(s), %d chars", selected.size, entries.size, inner.length)
        return "<plans>\n$inner\n</plans>"
    }
}
