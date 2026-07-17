package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.core.references.ReferenceEntry
import java.io.File

/**
 * ContextRelevance — Kotlin port of the CLI `ContextRelevance.ts` (PR #294).
 *
 * Assesses how relevant each CONTEXT item (plan / note / reference) is to a
 * specific code change, BEFORE a commit summary is generated. The result is used
 * to (a) rank items and take top-N under a char budget in relevance order, and
 * (b) conservatively soft-exclude clearly-unrelated items from the prompt.
 *
 * Design:
 *   - Pure LLM scoring (no BM25 / embeddings). One batch call per assessment.
 *   - Candidates are NOT sent whole when large: small items go verbatim, large
 *     ones are reduced to a mechanical, fence-aware skeleton. A total char cap
 *     bounds the prompt regardless of item count/size.
 *   - fail-open: any error (LLM failure, parse failure) yields a "keep everything"
 *     result so a ranking problem never drops context.
 *
 * IntelliJ divergence from the CLI: the CLI passes a per-call `timeoutMs` to the
 * ranker so a wedged call fails open fast. The IntelliJ [LlmClient] layer exposes
 * no per-call timeout (the hard cap lives in AnthropicClient's global 180s), and it
 * is not cheaply injectable here — so the timeout override is intentionally SKIPPED.
 * We rely instead on the try/catch fail-open wrapper (any exception ⇒ keepAll).
 */
object ContextRelevance {

    private val log = JmLogger.create("ContextRelevance")

    // -- Tunables -------------------------------------------------------------

    /** Total character budget for the rendered items block (~40K tokens). Items
     *  beyond the budget (after skeletonization) are dropped from the tail. */
    const val TOTAL_ITEMS_CHAR_BUDGET = 120_000

    /** A reference body at/under this is sent whole; aligned with the summarize
     *  per-reference cap so we never send more to the ranker than the summary uses. */
    const val REFERENCE_WHOLE_CHAR_CAP = 4_000

    /** A plan/note at/under this is sent whole; larger ones are skeletonized. */
    const val PLANNOTE_WHOLE_CHAR_CAP = 6_000

    /** Hard cap on a single item's skeleton (~1.5K tokens). */
    const val SKELETON_CHAR_CAP = 4_500

    /** Max output tokens for the ranking call — one short block per item. */
    private const val RANK_MAX_TOKENS = 4_096

    // -- Types ----------------------------------------------------------------

    enum class ContextKind { plan, note, reference }

    /** A candidate CONTEXT item to assess. `content` is the canonical full text. */
    data class ContextItem(
        val kind: ContextKind,
        /** slug (plan) / note id / mapKey (reference). Opaque; echoed back to caller. */
        val id: String,
        val title: String,
        val content: String,
    )

    /** The change being assessed against. Built by [buildChangeSignal]. */
    data class ChangeSignal(
        val commitMessage: String,
        val changedFiles: List<String>,
        val symbols: List<String>,
    )

    enum class RelevanceTier { high, mid, low }

    data class ContextRelevanceResult(
        val id: String,
        val kind: ContextKind,
        val relevant: Boolean,
        /** 0..1 confidence the item is relevant. */
        val score: Double,
        val tier: RelevanceTier,
        val reason: String,
        /** 1-based rank by score descending (1 = most relevant). */
        val rank: Int,
        /** true when the item should be soft-excluded (clearly unrelated). */
        val autoExclude: Boolean,
    )

    /** Registry entries for the three context kinds, pre-filtered of user hard-excludes. */
    data class RawContextEntries(
        val plans: List<PlanEntry>,
        val notes: List<NoteEntry>,
        val references: List<ReferenceEntry>,
    )

    /** Decision returned to the worker: kept entries (in relevance order) per kind,
     *  plus soft-excluded items for [CommitSummary.excludedContext]. */
    data class ContextRelevanceDecision(
        val plans: List<PlanEntry>,
        val notes: List<NoteEntry>,
        val references: List<ReferenceEntry>,
        val excludedContext: List<ExcludedContext>,
        val results: List<ContextRelevanceResult>,
    )

    // -- Frontmatter & skeleton extraction ------------------------------------

    private fun toForwardSlash(s: String): String = s.replace('\\', '/')

    private val FRONTMATTER_RE = Regex("^\\s*---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n?")

    /** Strips a leading YAML frontmatter block (`---\n...\n---`) if present. */
    fun stripFrontmatter(content: String): String {
        val m = FRONTMATTER_RE.find(content)
        return if (m != null && m.range.first == 0) content.substring(m.range.last + 1) else content
    }

    /** Matches a repo-relative-ish file path with a known code/doc extension. */
    private val FILE_PATH_RE = Regex("[\\w][\\w./-]*\\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|kt|kts|css|ya?ml|py|go|rs)\\b")

    private val FENCE_RE = Regex("^(```+|~~~+)")
    private val HEADING_RE = Regex("^#{1,6}\\s+(.+)$")
    private val LIST_MARKER_RE = Regex("^[-*+]\\s+")
    private val SENTENCE_END_RE = Regex("[.。!?！？]\\s|[.。!?！？]$")

    /**
     * Builds a mechanical, fence-aware skeleton of a large markdown document:
     * metadata line + title + first paragraph + section headings + referenced file
     * paths + each section's first sentence, truncated to [cap].
     */
    fun buildSkeleton(kind: ContextKind, title: String, body: String, cap: Int): String {
        val lines = body.split(Regex("\\r?\\n"))
        val totalChars = body.length
        val headings = mutableListOf<String>()
        val files = LinkedHashSet<String>()
        val sectionFirstSentences = mutableListOf<String>()
        var firstParagraph = ""

        var fenceChar: Char? = null
        var sawFirstHeading = false
        var pendingSectionSentence = false
        var collectingIntro = true

        for (rawLine in lines) {
            val line = rawLine.trim()
            val fenceMatch = FENCE_RE.find(line)
            if (fenceMatch != null) {
                val ch = fenceMatch.groupValues[1][0]
                if (fenceChar == null) fenceChar = ch
                else if (ch == fenceChar) fenceChar = null
                continue
            }
            if (fenceChar != null) continue

            for (match in FILE_PATH_RE.findAll(rawLine)) {
                files.add(toForwardSlash(match.value))
            }

            val headingMatch = HEADING_RE.find(line)
            if (headingMatch != null) {
                headings.add(headingMatch.groupValues[1].trim())
                sawFirstHeading = true
                pendingSectionSentence = true
                collectingIntro = false
                continue
            }

            if (line.isEmpty()) continue

            if (!sawFirstHeading && collectingIntro && firstParagraph.length < 240) {
                firstParagraph = if (firstParagraph.isNotEmpty()) "$firstParagraph $line" else line
                continue
            }

            if (pendingSectionSentence) {
                sectionFirstSentences.add(firstSentence(line))
                pendingSectionSentence = false
            }
        }

        val metaLine = "[$kind · original $totalChars chars / ${lines.size} lines · mechanical skeleton, not full text]"
        val parts = mutableListOf(metaLine)
        if (title.isNotEmpty()) parts.add("Title: $title")
        if (firstParagraph.isNotEmpty()) parts.add("Overview: $firstParagraph")
        if (headings.isNotEmpty()) parts.add("Sections: ${headings.joinToString(" / ")}")
        if (files.isNotEmpty()) parts.add("Files: ${files.take(40).joinToString(", ")}")

        var out = parts.joinToString("\n")
        for (sentence in sectionFirstSentences) {
            if (sentence.isEmpty()) continue
            val next = "$out\n- $sentence"
            if (next.length > cap) break
            out = next
        }
        return if (out.length > cap) "${out.take(cap)}\n[…truncated]" else out
    }

    /** Returns the first sentence-ish fragment of a line (up to ~160 chars). */
    private fun firstSentence(line: String): String {
        val trimmed = line.replace(LIST_MARKER_RE, "").trim()
        val m = SENTENCE_END_RE.find(trimmed)
        val frag = if (m != null) trimmed.substring(0, m.range.first + 1) else trimmed
        return if (frag.length > 160) "${frag.take(160)}…" else frag
    }

    /**
     * Produces the representation of one candidate to feed the ranker: whole text
     * when small, a skeleton when large. References have their frontmatter stripped.
     */
    fun extractCandidateRepr(item: ContextItem): String {
        val isReference = item.kind == ContextKind.reference
        val body = if (isReference) stripFrontmatter(item.content) else item.content
        val wholeCap = if (isReference) REFERENCE_WHOLE_CHAR_CAP else PLANNOTE_WHOLE_CHAR_CAP
        val trimmed = body.trim()
        if (trimmed.length <= wholeCap) return trimmed
        return buildSkeleton(item.kind, item.title, trimmed, minOf(SKELETON_CHAR_CAP, wholeCap))
    }

    // -- Prompt assembly ------------------------------------------------------

    data class ItemsBlock(
        val block: String,
        val indexToId: Map<Int, String>,
        val dropped: Int,
    )

    /** Renders the items block and the index→id map, enforcing a total char budget
     *  by dropping items from the tail of the initial order (logged). */
    fun buildItemsBlock(items: List<ContextItem>, totalBudget: Int = TOTAL_ITEMS_CHAR_BUDGET): ItemsBlock {
        val indexToId = LinkedHashMap<Int, String>()
        val blocks = mutableListOf<String>()
        var used = 0
        var dropped = 0
        var index = 0

        for (item in items) {
            val repr = extractCandidateRepr(item)
            val rendered = "[${index + 1}] (${item.kind}) ${item.title}\n$repr"
            if (used + rendered.length > totalBudget && blocks.isNotEmpty()) {
                dropped = items.size - index
                log.warn("buildItemsBlock: total budget %d reached, dropping %d tail item(s)", totalBudget, dropped)
                break
            }
            index += 1
            indexToId[index] = item.id
            blocks.add(rendered)
            used += rendered.length
        }

        return ItemsBlock(blocks.joinToString("\n\n"), indexToId, dropped)
    }

    /** Renders the change block from a [ChangeSignal]. */
    fun buildChangeBlock(change: ChangeSignal): String {
        val lines = mutableListOf("Commit message: ${change.commitMessage.ifBlank { "(none)" }}")
        if (change.changedFiles.isNotEmpty()) {
            lines.add("Changed files:\n${change.changedFiles.joinToString("\n") { "  $it" }}")
        }
        if (change.symbols.isNotEmpty()) {
            lines.add("Key symbols: ${change.symbols.joinToString(", ")}")
        }
        return lines.joinToString("\n")
    }

    // -- Response parsing -----------------------------------------------------

    private val ITEM_DELIMITER_RE = Regex("^\\s*===ITEM===\\s*$", RegexOption.MULTILINE)
    private val NOT_RELEVANT_RE = Regex("^\\s*(no?|nope|none|not\\b|false)", RegexOption.IGNORE_CASE)
    private val LEADING_INT_RE = Regex("^[+-]?\\d+")
    private val LEADING_FLOAT_RE = Regex("^[+-]?\\d*\\.?\\d+")

    data class ParsedItem(
        val index: Int,
        val relevant: Boolean,
        val score: Double,
        val reason: String,
    )

    /**
     * Parses the rank-context response (===ITEM=== blocks) into per-index records.
     * Tolerant of missing/garbled fields: an item with an unparseable index is
     * skipped; missing relevant/score/reason default to conservative "keep".
     */
    fun parseRankContextResponse(text: String): List<ParsedItem> {
        val segments = text.split(ITEM_DELIMITER_RE).drop(1).filter { it.trim().isNotEmpty() }
        val out = mutableListOf<ParsedItem>()
        for (seg in segments) {
            val index = intField(seg, "index") ?: continue
            val relevantRaw = strField(seg, "relevant")
            val scoreRaw = strField(seg, "score")
            val reason = strField(seg, "reason") ?: ""
            val relevant = if (relevantRaw != null) !NOT_RELEVANT_RE.containsMatchIn(relevantRaw.trim()) else true
            val scoreNum = scoreRaw?.let { parseLeadingFloat(it) }
            val score = if (scoreNum != null && scoreNum.isFinite()) clamp01(scoreNum) else if (relevant) 0.7 else 0.2
            out.add(ParsedItem(index, relevant, score, reason.trim()))
        }
        return out
    }

    private fun strField(segment: String, name: String): String? {
        val re = Regex("^\\s*$name\\s*:\\s*(.+)$", setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE))
        val m = re.find(segment) ?: return null
        return m.groupValues[1].trim()
    }

    private fun intField(segment: String, name: String): Int? {
        val raw = strField(segment, name) ?: return null
        return LEADING_INT_RE.find(raw.trim())?.value?.toIntOrNull()
    }

    private fun parseLeadingFloat(raw: String): Double? {
        return LEADING_FLOAT_RE.find(raw.trim())?.value?.toDoubleOrNull()
    }

    private fun clamp01(n: Double): Double = if (n < 0) 0.0 else if (n > 1) 1.0 else n

    /** Maps a 1-based rank (within [total] items) to a tier by POSITION, not by the
     *  model's uncalibrated absolute score. Top third → high, middle → mid, bottom → low. */
    fun tierForRank(rank: Int, total: Int): RelevanceTier {
        if (total <= 1) return RelevanceTier.high
        val frac = (rank - 1).toDouble() / (total - 1)
        return when {
            frac <= 1.0 / 3 -> RelevanceTier.high
            frac <= 2.0 / 3 -> RelevanceTier.mid
            else -> RelevanceTier.low
        }
    }

    /** True when a rank sits in the bottom third — the only band eligible for auto-exclude. */
    fun isBottomRank(rank: Int, total: Int): Boolean {
        if (total <= 1) return false
        return (rank - 1).toDouble() / (total - 1) > 2.0 / 3
    }

    // -- Orchestrator ---------------------------------------------------------

    /** Builds a "keep everything" fail-open result (used on any error). */
    fun keepAll(items: List<ContextItem>): List<ContextRelevanceResult> {
        return items.mapIndexed { i, item ->
            ContextRelevanceResult(
                id = item.id,
                kind = item.kind,
                relevant = true,
                score = 0.7,
                tier = RelevanceTier.high,
                reason = "",
                rank = i + 1,
                autoExclude = false,
            )
        }
    }

    /**
     * Merges parsed per-index records back onto [items] (by [indexToId]), ranks by
     * score descending (stable on ties by original order), and assigns tier +
     * autoExclude by RANK position. Pure — the LLM boundary lives in [rankContextRelevance].
     */
    fun mergeAndRank(
        items: List<ContextItem>,
        indexToId: Map<Int, String>,
        parsed: List<ParsedItem>,
    ): List<ContextRelevanceResult> {
        val byIndex = parsed.associateBy { it.index }

        data class Merged(val item: ContextItem, val relevant: Boolean, val score: Double, val reason: String, val origin: Int)

        val merged = items.mapIndexed { i, item ->
            val blockIndex = findIndexForId(indexToId, item.id) ?: (i + 1)
            val p = byIndex[blockIndex]
            Merged(item, p?.relevant ?: true, p?.score ?: 0.5, p?.reason ?: "", i)
        }

        val ranked = merged.sortedWith(compareByDescending<Merged> { it.score }.thenBy { it.origin })
        val total = ranked.size
        return ranked.mapIndexed { i, m ->
            val rank = i + 1
            ContextRelevanceResult(
                id = m.item.id,
                kind = m.item.kind,
                relevant = m.relevant,
                score = m.score,
                tier = tierForRank(rank, total),
                reason = m.reason,
                rank = rank,
                autoExclude = !m.relevant && isBottomRank(rank, total),
            )
        }
    }

    private fun findIndexForId(indexToId: Map<Int, String>, id: String): Int? {
        for ((idx, mappedId) in indexToId) if (mappedId == id) return idx
        return null
    }

    /**
     * Assesses relevance of every item against the change with one LLM call.
     * Never throws: on any failure returns [keepAll] (fail-open). Returns [] for an
     * empty item list.
     */
    fun rankContextRelevance(
        change: ChangeSignal,
        items: List<ContextItem>,
        config: JolliMemoryConfig,
        totalBudget: Int = TOTAL_ITEMS_CHAR_BUDGET,
        llmCall: ((prompt: String) -> LlmClient.LlmCallResult)? = null,
    ): List<ContextRelevanceResult> {
        if (items.isEmpty()) return emptyList()

        return try {
            val itemsBlock = buildItemsBlock(items, totalBudget)
            val changeBlock = buildChangeBlock(change)
            val prompt = Summarizer.buildRankContextPrompt(changeBlock, itemsBlock.block)
            val llmResult = if (llmCall != null) {
                llmCall(prompt)
            } else {
                LlmClient.callLlm(
                    action = "rank-context",
                    params = mapOf("changeSignal" to changeBlock, "items" to itemsBlock.block),
                    apiKey = config.apiKey,
                    jolliApiKey = config.jolliApiKey,
                    model = Summarizer.resolveModelId(config.model),
                    maxTokens = RANK_MAX_TOKENS,
                    prompt = prompt,
                    aiProvider = config.aiProvider,
                )
            }
            val parsed = parseRankContextResponse(llmResult.text ?: "")
            mergeAndRank(items, itemsBlock.indexToId, parsed)
        } catch (err: Exception) {
            log.warn("rankContextRelevance failed (%s) — keeping all items", err.message ?: err.toString())
            keepAll(items)
        }
    }

    // -- Change signal --------------------------------------------------------

    private val SYMBOL_DECL_RE = Regex("\\b(?:function|class|interface|type|enum|const|let|var|object|fun|val)\\s+([A-Za-z_$][\\w$]*)")

    /** Extracts declared symbol names from added diff lines (bounded, deduped). */
    fun extractSymbols(diff: String, max: Int = 40): List<String> {
        val out = LinkedHashSet<String>()
        for (line in diff.split(Regex("\\r?\\n"))) {
            if (line.startsWith("+++") || line.startsWith("---")) continue
            if (!line.startsWith("+")) continue
            for (m in SYMBOL_DECL_RE.findAll(line)) {
                out.add(m.groupValues[1])
                if (out.size >= max) return out.toList()
            }
        }
        return out.toList()
    }

    /** Builds a [ChangeSignal] from a commit message, changed-file list, and diff body. */
    fun buildChangeSignal(commitMessage: String, changedFiles: List<String>, diff: String): ChangeSignal {
        val files = changedFiles.map { toForwardSlash(it.trim()) }.filter { it.isNotEmpty() }
        return ChangeSignal(commitMessage, files, extractSymbols(diff))
    }

    // -- Pipeline integration -------------------------------------------------

    /** Reference key `<source>:<nativeId>` — matches the plans.json.references map key. */
    private fun referenceKey(e: ReferenceEntry): String = "${e.source.name}:${e.nativeId}"

    /** Display label for a reference: `<nativeId> — <title>`. */
    private fun referenceLabel(e: ReferenceEntry): String = "${e.nativeId} — ${e.title}"

    /** Reads an entry's canonical content from disk, falling back to [fallback] when
     *  the source file is missing/empty. Best-effort: never throws. */
    private fun readEntryContent(sourcePath: String?, fallback: String): String {
        if (sourcePath == null) return fallback
        return try {
            val f = File(sourcePath)
            if (!f.exists()) return fallback
            val c = f.readText(Charsets.UTF_8)
            if (c.trim().isNotEmpty()) c else fallback
        } catch (_: Exception) {
            fallback
        }
    }

    /**
     * End-to-end relevance assessment for the post-commit worker. Builds candidates
     * from registry entries (already filtered of user hard-excludes), ranks them, and
     * returns kept entries in relevance order plus the soft-excluded items for the
     * summary's `excludedContext`. Never throws — [rankContextRelevance] fails open.
     *
     * [ranker] is injectable for testing; the default calls the real LLM ranker.
     */
    fun assessContextRelevance(
        raw: RawContextEntries,
        change: ChangeSignal,
        config: JolliMemoryConfig,
        ranker: (ChangeSignal, List<ContextItem>) -> List<ContextRelevanceResult> =
            { c, i -> rankContextRelevance(c, i, config) },
    ): ContextRelevanceDecision {
        val items = mutableListOf<ContextItem>()
        for (p in raw.plans) {
            items.add(ContextItem(ContextKind.plan, p.slug, p.title, readEntryContent(p.sourcePath, p.title)))
        }
        for (n in raw.notes) {
            items.add(ContextItem(ContextKind.note, n.id, n.title, readEntryContent(n.sourcePath, n.title)))
        }
        for (r in raw.references) {
            items.add(ContextItem(ContextKind.reference, referenceKey(r), r.title, readEntryContent(r.sourcePath, r.title)))
        }

        if (items.isEmpty()) {
            return ContextRelevanceDecision(raw.plans, raw.notes, raw.references, emptyList(), emptyList())
        }

        val results = ranker(change, items)

        val planById = raw.plans.associateBy { it.slug }
        val noteById = raw.notes.associateBy { it.id }
        val refByKey = raw.references.associateBy { referenceKey(it) }

        val keptPlans = mutableListOf<PlanEntry>()
        val keptNotes = mutableListOf<NoteEntry>()
        val keptRefs = mutableListOf<ReferenceEntry>()
        val excludedContext = mutableListOf<ExcludedContext>()

        for (res in results) {
            if (res.autoExclude) {
                val title = when (res.kind) {
                    ContextKind.plan -> planById[res.id]?.title
                    ContextKind.note -> noteById[res.id]?.title
                    ContextKind.reference -> refByKey[res.id]?.let { referenceLabel(it) }
                }
                excludedContext.add(
                    ExcludedContext(kind = res.kind.name, key = res.id, title = title ?: res.id, reason = res.reason),
                )
                continue
            }
            when (res.kind) {
                ContextKind.plan -> planById[res.id]?.let { keptPlans.add(it) }
                ContextKind.note -> noteById[res.id]?.let { keptNotes.add(it) }
                ContextKind.reference -> refByKey[res.id]?.let { keptRefs.add(it) }
            }
        }

        return ContextRelevanceDecision(keptPlans, keptNotes, keptRefs, excludedContext, results)
    }
}
