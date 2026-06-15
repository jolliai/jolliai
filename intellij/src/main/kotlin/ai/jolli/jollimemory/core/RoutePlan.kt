package ai.jolli.jollimemory.core

import com.google.gson.JsonElement
import com.google.gson.JsonParser

/**
 * RoutePlan — parses the route LLM's JSON-in-text output into a per-topic
 * assignment map, mapping source ordinals back to [SourceRef]s. Fail-loud on
 * truncation / malformed JSON / out-of-range index (caller holds the batch).
 *
 * Kotlin port of `cli/src/core/RoutePlan.ts`.
 */
data class TopicAssignment(
    val title: String?, // present for new topics
    val isNew: Boolean,
    val refs: List<SourceRef>,
)

data class RoutePlan(
    /** stableSlug → assignment. Empty when an error occurred. */
    val assignments: Map<String, TopicAssignment>,
    /** Set when parsing failed (truncation / malformed) — caller marks nothing processed. */
    val error: String? = null,
)

object RoutePlanParser {

    private val log = JmLogger.create("RoutePlan")

    private val FENCE_RE = Regex("^```(?:json)?\\s*\\n([\\s\\S]*?)\\n```$")

    /** Strips an optional ```json … ``` fence the LLM may wrap the object in. */
    private fun stripFence(text: String): String {
        val trimmed = text.trim()
        val fence = FENCE_RE.find(trimmed)
        return fence?.groupValues?.get(1)?.trim() ?: trimmed
    }

    fun parseRoutePlan(text: String, stopReason: String?, batch: List<SourceRef>): RoutePlan {
        if (stopReason == "max_tokens") {
            return RoutePlan(emptyMap(), "route output truncated at max_tokens")
        }
        val root = try {
            JsonParser.parseString(stripFence(text))
        } catch (_: Exception) {
            return RoutePlan(emptyMap(), "route output is not valid JSON")
        }
        if (!root.isJsonObject) return RoutePlan(emptyMap(), "route output is not valid JSON")
        val obj = root.asJsonObject

        val assignments = LinkedHashMap<String, TopicAssignment>()
        var malformedIndex = false

        fun add(entry: JsonElement, isNew: Boolean) {
            if (!entry.isJsonObject) return
            val e = entry.asJsonObject
            val slugEl = e.get("stableSlug")
            val slug = if (slugEl != null && slugEl.isJsonPrimitive && slugEl.asJsonPrimitive.isString) slugEl.asString else ""
            if (slug.isEmpty()) return

            val indexesEl = e.get("sourceIndexes")
            val refs = mutableListOf<SourceRef>()
            if (indexesEl != null && indexesEl.isJsonArray) {
                for (idxEl in indexesEl.asJsonArray) {
                    val isNumber = idxEl.isJsonPrimitive && idxEl.asJsonPrimitive.isNumber
                    val asDouble = if (isNumber) idxEl.asDouble else Double.NaN
                    val idx = asDouble.toInt()
                    // Reject non-numbers, non-integers (e.g. 1.5 — asInt would silently
                    // truncate to a valid-looking ordinal), and out-of-range: a miscounted
                    // index means the ordinal→source mapping can't be trusted, so fail loud.
                    if (!isNumber || asDouble != idx.toDouble() || idx < 0 || idx >= batch.size) {
                        log.warn("route: invalid source index %s for topic %s — failing route", idxEl.toString(), slug)
                        malformedIndex = true
                        continue
                    }
                    refs.add(batch[idx])
                }
            }
            if (refs.isEmpty()) return

            val titleEl = e.get("title")
            val candidateTitle = if (isNew && titleEl != null && titleEl.isJsonPrimitive && titleEl.asJsonPrimitive.isString) titleEl.asString else null

            val existing = assignments[slug]
            if (existing != null) {
                // Union-merge: keep the "new topic" flag + title across both arrays.
                val merged = existing.refs + refs.filter { it !in existing.refs }
                assignments[slug] = TopicAssignment(
                    title = existing.title ?: candidateTitle,
                    isNew = existing.isNew || isNew,
                    refs = merged,
                )
                return
            }
            assignments[slug] = TopicAssignment(title = candidateTitle, isNew = isNew, refs = refs)
        }

        (obj.get("updates")?.takeIf { it.isJsonArray }?.asJsonArray ?: emptyList<JsonElement>()).forEach { add(it, false) }
        (obj.get("newTopics")?.takeIf { it.isJsonArray }?.asJsonArray ?: emptyList<JsonElement>()).forEach { add(it, true) }

        if (malformedIndex) {
            return RoutePlan(emptyMap(), "route referenced an out-of-range source index")
        }
        return RoutePlan(assignments)
    }
}
