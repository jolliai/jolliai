package ai.jolli.jollimemory.core.references

import ai.jolli.jollimemory.core.JmLogger
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import java.io.File

/**
 * Multi-source transcript reference extractor — shared driver.
 *
 * Source-agnostic pipeline: read the JSONL, hand the lines to the per-source
 * envelope parser, then walk each normalised payload through the matched
 * [SourceAdapter.extractRef] and dedupe.
 *
 * Dedupe: same `mapKey` → keep the entry with the latest `referencedAt`.
 * On timestamp tie, the later-seen entry wins (preserves get→list resolution
 * order from the transcript).
 */
object ReferenceExtractor {

	private val log = JmLogger.create("ReferenceExtractor")

	data class Result(
		val references: List<Reference>,
		/** 1-based index of the last line consumed; suitable for persisting as the next cursor. */
		val lastLineNumberScanned: Int,
	)

	/**
	 * Walks one transcript and returns extracted [Reference]s for every adapter.
	 * Reads raw JSONL at [transcriptPath]. The per-source envelope parser is
	 * chosen by [ExtractOptions.source] (default claude).
	 */
	fun extractFromTranscript(
		transcriptPath: String,
		adapters: List<SourceAdapter>,
		opts: ExtractOptions = ExtractOptions(),
	): Result {
		val content = try {
			File(transcriptPath).readText(Charsets.UTF_8)
		} catch (e: Exception) {
			log.debug("Cannot read transcript %s: %s", transcriptPath, e.message)
			return Result(emptyList(), 0)
		}

		val lines = content.split("\n").toMutableList()
		// Drop trailing empty element from final newline
		if (lines.isNotEmpty() && lines.last().isEmpty()) lines.removeAt(lines.lastIndex)

		val parser = getEnvelopeParser(opts.source ?: ai.jolli.jollimemory.core.TranscriptSource.claude)
		val (results, lastLineNumberScanned) = parser.parse(lines, opts, adapters)

		val collected = mutableListOf<Reference>()
		for (r in results) {
			try {
				walkPayload(r.payload, r.adapter, r.toolName, r.referencedAt, collected)
			} catch (e: Exception) {
				log.warn("Dropping tool_result on line %d (%s): payload walk failed: %s", r.lineNumber, r.toolName, e.message)
			}
		}

		val deduped = dedupeKeepLatest(collected)
		log.debug(
			"Extracted %d reference(s) from %s (lines %d-%d)",
			deduped.size, transcriptPath, opts.fromLineNumber ?: 0, lastLineNumberScanned,
		)
		return Result(deduped, lastLineNumberScanned)
	}

	// --- Payload traversal ---

	private fun walkPayload(
		value: Any?,
		adapter: SourceAdapter,
		toolName: String,
		referencedAt: String,
		out: MutableList<Reference>,
	) {
		if (value == null) return

		if (value is com.google.gson.JsonArray) {
			for (item in value) walkPayload(item, adapter, toolName, referencedAt, out)
			return
		}

		if (value !is JsonObject) {
			// Could be a JsonElement wrapping an object
			if (value is JsonElement && value.isJsonObject) {
				walkPayload(value.asJsonObject, adapter, toolName, referencedAt, out)
			} else if (value is JsonElement && value.isJsonArray) {
				for (item in value.asJsonArray) walkPayload(item, adapter, toolName, referencedAt, out)
			}
			return
		}

		val ref = adapter.extractRef(value, toolName, referencedAt)
		if (ref != null) {
			out.add(ref)
			return // identified as a reference — stop descending
		}

		// Try common wrapper fields
		for (key in adapter.wrapperKeys) {
			val inner = value.get(key) ?: continue
			if (inner.isJsonArray) {
				for (item in inner.asJsonArray) walkPayload(item, adapter, toolName, referencedAt, out)
			} else if (inner.isJsonObject) {
				walkPayload(inner.asJsonObject, adapter, toolName, referencedAt, out)
			}
		}
	}

	private fun dedupeKeepLatest(refs: List<Reference>): List<Reference> {
		val byMapKey = linkedMapOf<String, Reference>()
		for (ref in refs) {
			val existing = byMapKey[ref.mapKey]
			if (existing == null || ref.referencedAt >= existing.referencedAt) {
				byMapKey[ref.mapKey] = ref
			}
		}
		return byMapKey.values.toList()
	}
}
