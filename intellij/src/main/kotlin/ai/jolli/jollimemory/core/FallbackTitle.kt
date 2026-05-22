package ai.jolli.jollimemory.core

import java.io.File

/**
 * FallbackTitle — Kotlin port of FallbackTitle.ts
 *
 * Computes fallback session titles from the first user message in a
 * transcript when the source has no native title.
 */
object FallbackTitle {

	private val log = JmLogger.create("FallbackTitle")

	const val UNTITLED_SESSION = "(untitled session)"
	const val TITLE_MAX_CODE_POINTS = 60

	/**
	 * Truncate a string to at most [maxCodePoints] Unicode code points.
	 * Preserves surrogate pairs. Collapses internal whitespace and trims.
	 */
	fun truncateToCodePoints(input: String, maxCodePoints: Int): String {
		val normalized = input.replace(Regex("\\s+"), " ").trim()
		val codePointCount = normalized.codePointCount(0, normalized.length)
		if (codePointCount <= maxCodePoints) return normalized
		val endIndex = normalized.offsetByCodePoints(0, maxCodePoints)
		return normalized.substring(0, endIndex)
	}

	/**
	 * Stream the transcript line-by-line, returning the first user message body
	 * truncated to [TITLE_MAX_CODE_POINTS]. Returns [UNTITLED_SESSION] on any
	 * failure or absence.
	 *
	 * @param transcriptPath path to the JSONL transcript file
	 * @param parseLine per-source line parser; returns user message body or null
	 */
	fun readFirstUserMessageTitle(
		transcriptPath: String,
		parseLine: (String) -> String?,
	): String {
		val file = File(transcriptPath)
		if (!file.exists()) return UNTITLED_SESSION
		return try {
			file.bufferedReader(Charsets.UTF_8).useLines { lines ->
				for (line in lines) {
					if (line.isBlank()) continue
					val body = try {
						parseLine(line)
					} catch (_: Exception) {
						continue
					}
					if (body != null && body.trim().isNotEmpty()) {
						return@useLines truncateToCodePoints(body, TITLE_MAX_CODE_POINTS)
					}
				}
				UNTITLED_SESSION
			}
		} catch (e: Exception) {
			log.debug("readFirstUserMessageTitle failed for %s: %s", transcriptPath, e.message)
			UNTITLED_SESSION
		}
	}
}
