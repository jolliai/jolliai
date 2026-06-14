package ai.jolli.jollimemory.core

/**
 * ReconciledPage — parses the reconcile LLM's delimited output into the fields
 * of a TopicPage. Reuses [KnowledgeCompiler.parseCompileResponse] for the
 * standard fields and [KnowledgeCompiler.extractField] for `---SUMMARY---`. The
 * slug/title are taken from the authoritative caller, not the LLM echo.
 *
 * Kotlin port of `cli/src/core/ReconciledPage.ts`.
 */
data class ReconciledPage(
    val stableSlug: String,
    val title: String,
    val summary: String,
    val content: String,
    val keyDecisions: List<String>? = null,
    val relatedBranches: List<String>? = null,
    val sourceCommits: List<String> = emptyList(),
)

object ReconciledPageParser {

    private val log = JmLogger.create("ReconciledPage")

    /**
     * Parses one reconcile response into a page. Returns null when no
     * `===TOPIC===` block parsed (caller keeps the old page, holds the sources).
     */
    fun parseReconciledPage(response: String, authoritativeSlug: String, authoritativeTitle: String): ReconciledPage? {
        val topics = KnowledgeCompiler.parseCompileResponse(response)
        val topic = topics.firstOrNull()

        // The reconcile LLM occasionally omits ---TITLE---; parseCompileResponse drops
        // title-less blocks. Recover from the raw first block using the authoritative
        // title — only a block with no CONTENT is a real failure.
        if (topic == null) {
            val rawBlock = response.split("===TOPIC===").firstOrNull { it.trim().isNotEmpty() } ?: ""
            val content = KnowledgeCompiler.extractField(rawBlock, "CONTENT")
            if (content.isEmpty()) return null
            return ReconciledPage(
                stableSlug = authoritativeSlug,
                title = authoritativeTitle,
                summary = KnowledgeCompiler.extractField(rawBlock, "SUMMARY"),
                content = content,
                sourceCommits = emptyList(),
            )
        }

        if (topic.stableSlug.isNotEmpty() && topic.stableSlug != authoritativeSlug) {
            log.warn("reconcile echoed slug %s, keeping authoritative %s", topic.stableSlug, authoritativeSlug)
        }

        // SUMMARY is the one field parseCompileResponse does not read.
        val firstBlock = response.split("===TOPIC===").getOrNull(1) ?: ""
        val summary = KnowledgeCompiler.extractField(firstBlock, "SUMMARY")

        return ReconciledPage(
            stableSlug = authoritativeSlug,
            title = topic.title.ifEmpty { authoritativeTitle },
            summary = summary,
            content = topic.content,
            keyDecisions = topic.keyDecisions?.takeIf { it.isNotEmpty() },
            relatedBranches = topic.relatedBranches?.takeIf { it.isNotEmpty() },
            sourceCommits = topic.sourceCommits,
        )
    }
}
