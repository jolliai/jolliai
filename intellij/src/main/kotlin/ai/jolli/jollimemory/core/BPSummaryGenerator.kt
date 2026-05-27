package ai.jolli.jollimemory.core

import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import java.time.Instant

/**
 * BPSummaryGenerator — Generates bullet point summaries for conversation sessions.
 *
 * Makes a direct Anthropic API call (Haiku model) to extract new noteworthy
 * discussion points from a session transcript. Jolli proxy is not used.
 */
object BPSummaryGenerator {

	private val log = JmLogger.create("BPSummaryGenerator")
	private val gson = Gson()
	private const val MODEL = "claude-haiku-4-5-20251001"
	private const val MAX_TOKENS = 2048

	/**
	 * Generates new bullet points for a session transcript.
	 *
	 * @param transcript The session's transcript entries
	 * @param existingBullets Already-accumulated bullets (provided as context)
	 * @param commitHash The commit that triggered this generation
	 * @param apiKey Direct Anthropic API key (required; returns empty if null)
	 * @return New bullet points to append (may be empty if nothing noteworthy)
	 */
	fun generate(
		transcript: List<TranscriptEntry>,
		existingBullets: List<BulletPointItem>,
		commitHash: String,
		apiKey: String?,
	): List<BulletPointItem> {
		val resolvedKey = apiKey ?: System.getenv("ANTHROPIC_API_KEY")
		if (resolvedKey.isNullOrBlank()) {
			log.info("No Anthropic API key — skipping BP summary generation")
			return emptyList()
		}

		if (transcript.isEmpty()) return emptyList()

		val prompt = buildPrompt(transcript, existingBullets)
		val client = AnthropicClient(resolvedKey)

		return try {
			val response = client.createMessage(
				model = MODEL,
				maxTokens = MAX_TOKENS,
				temperature = 0.0,
				messages = listOf(AnthropicClient.Message("user", prompt)),
			)

			val text = response.content?.firstOrNull()?.text ?: return emptyList()
			parseBullets(text, commitHash)
		} catch (e: Exception) {
			log.warn("BP summary LLM call failed: %s", e.message)
			emptyList()
		}
	}

	private fun buildPrompt(transcript: List<TranscriptEntry>, existingBullets: List<BulletPointItem>): String {
		val transcriptText = transcript.joinToString("\n\n") { entry ->
			"[${entry.role}]: ${entry.content.take(4000)}"
		}

		val existingSection = if (existingBullets.isNotEmpty()) {
			val bulletList = existingBullets.joinToString("\n") { "- ${it.text}" }
			"""
## Existing Bullet Points
These have already been recorded — do NOT repeat them:
$bulletList
"""
		} else ""

		return """You are analyzing a development conversation to extract important discussion points.
$existingSection
## Conversation Transcript
$transcriptText

## Instructions
Identify any NEW important discussion topics from this conversation that are worth recording as bullet points. Each bullet should be a concise one-line summary capturing a key decision, insight, architectural choice, or action item.

Return ONLY a JSON array of strings. If nothing noteworthy or new, return an empty array [].

Example output:
["Decided to use WebSocket instead of SSE for real-time updates", "Found root cause of memory leak in connection pool"]

Return the JSON array now:"""
	}

	private fun parseBullets(text: String, commitHash: String): List<BulletPointItem> {
		return try {
			// Extract JSON array from response (may have surrounding text)
			val arrayStart = text.indexOf('[')
			val arrayEnd = text.lastIndexOf(']')
			if (arrayStart < 0 || arrayEnd < 0 || arrayEnd <= arrayStart) return emptyList()

			val jsonArray = text.substring(arrayStart, arrayEnd + 1)
			val strings: List<String> = gson.fromJson(jsonArray, object : TypeToken<List<String>>() {}.type)
			val now = Instant.now().toString()
			strings
				.filter { it.isNotBlank() }
				.map { BulletPointItem(text = it.trim(), addedAt = now, commitHash = commitHash) }
		} catch (e: Exception) {
			log.warn("Failed to parse BP summary response: %s", e.message)
			emptyList()
		}
	}
}
