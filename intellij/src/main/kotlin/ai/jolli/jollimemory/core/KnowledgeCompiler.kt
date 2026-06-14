package ai.jolli.jollimemory.core

/**
 * KnowledgeCompiler — parse/format helpers for the topic-KB compile format.
 * Pure string/regex logic, reused by ReconciledPage and SourceContent.
 *
 * Kotlin port of `cli/src/core/KnowledgeCompiler.ts`. Regexes are ported
 * verbatim; the slug rules and field-marker boundaries must stay identical.
 */
object KnowledgeCompiler {

    private val log = JmLogger.create("KnowledgeCompiler")

    /**
     * Parses the LLM's delimited compile response into [CompiledTopic] objects.
     * Format: `===TOPIC===` blocks with `---FIELD---` delimiters.
     */
    fun parseCompileResponse(response: String): List<CompiledTopic> {
        if (response.isBlank() || response.trim() == "===NO_TOPICS===") return emptyList()

        val topicBlocks = response.split("===TOPIC===").filter { it.trim().isNotEmpty() }
        val topics = mutableListOf<CompiledTopic>()
        val seenSlugs = HashSet<String>()

        for (block in topicBlocks) {
            val title = extractField(block, "TITLE")
            val content = extractField(block, "CONTENT")
            if (title.isEmpty() || content.isEmpty()) continue

            // Three-tier STABLESLUG resolution.
            val rawSlug = extractField(block, "STABLESLUG")
            val stableSlug: String
            if (rawSlug.isNotEmpty()) {
                val normalized = normalizeSlug(rawSlug)
                if (normalized.isEmpty()) {
                    stableSlug = slugifyTitle(title)
                    log.warn("Topic %s STABLESLUG %s normalized to empty — falling back to title slug %s", title, rawSlug, stableSlug)
                } else {
                    stableSlug = normalized
                    if (normalized != rawSlug) log.debug("Topic %s STABLESLUG normalized: %s → %s", title, rawSlug, normalized)
                }
            } else {
                stableSlug = slugifyTitle(title)
                log.warn("Topic %s missing STABLESLUG — derived %s from title", title, stableSlug)
            }

            // First-write-wins dedup on stableSlug.
            if (!seenSlugs.add(stableSlug)) {
                log.warn("Topic %s duplicates stableSlug %s with an earlier topic — skipping", title, stableSlug)
                continue
            }

            val decisionsRaw = extractField(block, "KEYDECISIONS")
            val keyDecisions = if (decisionsRaw.isNotEmpty()) {
                decisionsRaw.split("\n").map { it.replace(Regex("^-\\s*"), "").trim() }.filter { it.isNotEmpty() }
            } else {
                null
            }

            val branchesRaw = extractField(block, "RELATEDBRANCHES")
            val relatedBranches = if (branchesRaw.isNotEmpty()) {
                branchesRaw.split(",").map { it.trim() }.filter { it.isNotEmpty() }
            } else {
                null
            }

            val commitsRaw = extractField(block, "SOURCECOMMITS")
            val sourceCommits = if (commitsRaw.isNotEmpty()) {
                commitsRaw.split(",").map { it.trim() }.filter { it.isNotEmpty() }
            } else {
                emptyList()
            }

            topics.add(
                CompiledTopic(
                    title = title,
                    stableSlug = stableSlug,
                    content = content,
                    relatedBranches = if (!relatedBranches.isNullOrEmpty()) relatedBranches else null,
                    keyDecisions = if (!keyDecisions.isNullOrEmpty()) keyDecisions else null,
                    sourceCommits = sourceCommits,
                ),
            )
        }
        return topics
    }

    /**
     * Normalizes a raw LLM-supplied slug to the kebab-case shape (lowercase,
     * `[a-z0-9-]`, 3-40 chars, no leading/trailing/repeat `-`). Empty when
     * unrecoverable — caller falls back to [slugifyTitle].
     */
    internal fun normalizeSlug(raw: String): String {
        var cleaned = raw.lowercase().trim()
            .replace(Regex("[^a-z0-9-]+"), "-")
            .replace(Regex("-{2,}"), "-")
            .replace(Regex("^-+|-+$"), "")
        if (cleaned.length > 40) cleaned = cleaned.substring(0, 40)
        cleaned = cleaned.replace(Regex("-+$"), "")
        return if (cleaned.length >= 3) cleaned else ""
    }

    /** Last-resort slug derived from the topic title. */
    internal fun slugifyTitle(title: String): String = normalizeSlug(title).ifEmpty { "untitled-topic" }

    /**
     * The closed set of field markers. The end boundary in [extractField] only
     * stops at one of THESE markers, so prose containing a triple-dash header
     * (e.g. `---NOTE---`) is not silently truncated.
     */
    private val KNOWN_FIELD_MARKERS = listOf(
        "TITLE", "STABLESLUG", "SUMMARY", "CONTENT", "KEYDECISIONS", "RELATEDBRANCHES", "SOURCECOMMITS",
    )

    private val FIELD_END_RE = Regex("\\n---(?:${KNOWN_FIELD_MARKERS.joinToString("|")})---[ \\t]*(?:\\r?\\n|$)")

    /**
     * Extracts the value of a `---FIELD---` field from a topic block. Markers are
     * on their own line, so both start and end boundaries are line-anchored; the
     * value runs until the next line-anchored *known* field marker (or end).
     */
    fun extractField(block: String, field: String): String {
        val startRe = Regex("(?:^|\\n)---$field---[ \\t]*(?:\\r?\\n|$)")
        val start = startRe.find(block) ?: return ""
        val contentStart = start.range.last + 1
        val rest = block.substring(contentStart)
        val end = FIELD_END_RE.find(rest)
        val raw = if (end != null) rest.substring(0, end.range.first) else rest
        return raw.trim()
    }

    /** Formats a [CommitSummary] into text for the LLM compile prompt. */
    fun formatSummaryForCompile(summary: CommitSummary): String {
        val topics = SummaryTree.collectAllTopics(summary)
        val lines = mutableListOf(
            "### Commit ${summary.commitHash.take(8)} -- ${summary.commitMessage} (${summary.commitDate})",
        )
        for (tw in topics) {
            val t = tw.topic
            lines.add("**${t.title}**")
            if (t.trigger.isNotEmpty()) lines.add("- Why: ${t.trigger}")
            if (t.decisions.isNotEmpty()) lines.add("- Decisions: ${t.decisions}")
            if (t.response.isNotEmpty()) lines.add("- What: ${t.response}")
            if (!t.filesAffected.isNullOrEmpty()) lines.add("- Files: ${t.filesAffected.joinToString(", ")}")
            lines.add("")
        }
        return lines.joinToString("\n")
    }
}
