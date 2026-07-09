package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.core.references.PromptRenderer
import java.io.File

/**
 * NotePromptFormatter — renders active note entries into a `<notes>` XML block for
 * the summary prompt. Kotlin port of the CLI `NotePromptFormatter.ts`.
 *
 * Ordering: the caller's order is preserved verbatim (relevance-ranked, most
 * relevant first) so over-budget truncation drops the least relevant, not the
 * oldest. An unranked caller gets insertion order.
 */
object NotePromptFormatter {

    private val log = JmLogger.create("NotePromptFormatter")

    private const val DEFAULT_MAX_CHARS_PER_NOTE = 4000
    private const val DEFAULT_MAX_TOTAL_CHARS = 30000

    /** Reads the note body from its sourcePath; empty string when missing/unreadable. */
    private fun readNoteBody(entry: NoteEntry): String {
        val path = entry.sourcePath ?: return ""
        return try {
            val f = File(path)
            if (f.exists()) f.readText(Charsets.UTF_8) else ""
        } catch (_: Exception) {
            ""
        }
    }

    private fun truncate(s: String, max: Int): String {
        if (s.length <= max) return s
        return "${s.take(max)}\n…[truncated, ${s.length - max} more chars]"
    }

    /** Renders one note as a `<note>` element with its (truncated) body. */
    private fun renderOneNote(entry: NoteEntry, body: String, maxPerNote: Int): String {
        val lines = mutableListOf("<note id=\"${PromptRenderer.escapeForAttr(entry.id)}\" title=\"${PromptRenderer.escapeForAttr(entry.title)}\">")
        val trimmed = body.trim()
        if (trimmed.isNotEmpty()) {
            lines.add(PromptRenderer.escapeForText(truncate(trimmed, maxPerNote)))
        }
        lines.add("</note>")
        return lines.joinToString("\n")
    }

    /**
     * Renders the `<notes>` block for [entries], in caller order, within budget.
     * Returns "" when there is nothing to render.
     */
    fun formatNotesBlock(
        entries: List<NoteEntry>,
        maxCharsPerNote: Int = DEFAULT_MAX_CHARS_PER_NOTE,
        maxTotalChars: Int = DEFAULT_MAX_TOTAL_CHARS,
    ): String {
        if (entries.isEmpty()) return ""

        val selected = mutableListOf<Pair<NoteEntry, String>>()
        var totalLen = 0
        for (entry in entries) {
            val body = readNoteBody(entry)
            val rendered = renderOneNote(entry, body, maxCharsPerNote)
            if (totalLen + rendered.length > maxTotalChars) break
            selected.add(entry to body)
            totalLen += rendered.length
        }
        if (selected.isEmpty()) return ""

        val inner = selected.joinToString("\n") { (entry, body) -> renderOneNote(entry, body, maxCharsPerNote) }
        log.info("Formatted notes block: %d of %d note(s), %d chars", selected.size, entries.size, inner.length)
        return "<notes>\n$inner\n</notes>"
    }
}
