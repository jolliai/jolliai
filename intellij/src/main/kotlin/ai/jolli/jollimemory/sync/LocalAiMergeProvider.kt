package ai.jolli.jollimemory.sync

import ai.jolli.jollimemory.core.AnthropicClient
import ai.jolli.jollimemory.core.JmLogger
import java.security.SecureRandom

/**
 * Tier 2 AI merge using the user's locally-configured Anthropic API key.
 *
 * Tier 2 NEVER routes through a backend proxy — the user either has an
 * API key set (this provider is used) or has nothing and the
 * [ConflictResolver] falls straight to Tier 3 with `ai = null`.
 *
 * Port of `cli/src/sync/LocalAiMergeProvider.ts`.
 */
class LocalAiMergeProvider(
	private val apiKey: String,
	private val model: String = DEFAULT_MODEL,
	private val maxTokens: Int = DEFAULT_MAX_TOKENS,
	private val clientFactory: (String) -> AnthropicClient = ::AnthropicClient,
	private val tokenFactory: () -> String = ::defaultToken,
) : AiMergeProvider {

	private val log = JmLogger.create("Sync:LocalAiMerge")
	private val client = clientFactory(apiKey)

	override fun merge(req: AiMergeRequest): AiMergeResponse {
		val token = tokenFactory()
		val prompt = buildPrompt(req, token)
		val response = client.createMessage(
			model = model,
			maxTokens = maxTokens,
			temperature = 0.0,
			messages = listOf(AnthropicClient.Message("user", prompt)),
		)
		val textBlock = response.content.firstOrNull { it.type == "text" }
			?: throw RuntimeException("LocalAiMergeProvider: no text content in LLM response")
		val text = textBlock.text
			?: throw RuntimeException("LocalAiMergeProvider: text block has null text")
		val parsed = parseModelOutput(text, token)
		log.debug(
			"Tier 2 merge for %s — confidence=%.2f len=%d model=%s",
			req.path, parsed.confidence, parsed.merged.length, response.model,
		)
		return AiMergeResponse(
			merged = parsed.merged,
			confidence = parsed.confidence,
			model = response.model,
		)
	}

	companion object {
		private const val DEFAULT_MODEL = "claude-sonnet-4-20250514"
		private const val DEFAULT_MAX_TOKENS = 8192

		private fun defaultToken(): String {
			val bytes = ByteArray(8)
			SecureRandom().nextBytes(bytes)
			return bytes.joinToString("") { "%02x".format(it) }
		}
	}
}

/**
 * Builds the merge prompt with per-call random markers.
 *
 * The `BEGIN_MERGED_<token>` / `END_MERGED_<token>` markers use a random
 * hex token so peer-pushed content can't pre-craft colliding lines.
 */
fun buildPrompt(req: AiMergeRequest, token: String): String {
	val fileKindHint = if (req.fileKind == "json")
		"The file is JSON. Preserve key order from `ours` where possible and ensure the result parses as valid JSON."
	else
		"The file is Markdown. Preserve heading structure from `ours` where possible."

	val fence = "```"
	val beginMarker = "BEGIN_MERGED_$token"
	val endMarker = "END_MERGED_$token"
	val baseLines = if (req.base == null)
		listOf("BASE: <no common ancestor — the file did not exist on the merge base>")
	else
		listOf("BASE:", fence, req.base, fence)

	return (listOf(
		"You are merging two divergent versions of a single file into one coherent result.",
		fileKindHint,
		"",
		"OUTPUT FORMAT — required, no exceptions:",
		"  Line 1: CONFIDENCE=<0.00-1.00>",
		"  Line 2: $beginMarker",
		"  Lines 3..N-1: the merged file body, exactly as it should be written to disk",
		"  Final line: $endMarker",
		"The marker tokens ($beginMarker, $endMarker) are randomised per request — emit them VERBATIM, do not invent your own.",
		"Do not include conflict markers (<<<<<<<, =======, >>>>>>>) anywhere.",
		"Do not include commentary, explanations, or apologies. Body only.",
		"",
		"PATH: ${req.path}",
		"",
	) + baseLines + listOf(
		"",
		"OURS:",
		fence,
		req.ours,
		fence,
		"",
		"THEIRS:",
		fence,
		req.theirs,
		fence,
	)).joinToString("\n")
}

data class ParsedOutput(
	val merged: String,
	val confidence: Double,
)

/**
 * Parses the structured LLM response. Scopes marker matches to the
 * caller-supplied per-call token. Throws when the format is broken.
 */
fun parseModelOutput(text: String, token: String): ParsedOutput {
	val lines = text.split(Regex("\\r?\\n"))
	if (lines.size < 3) {
		throw RuntimeException("LocalAiMergeProvider: response too short to parse")
	}

	val confidenceMatch = Regex("^CONFIDENCE=(-?[0-9]*\\.?[0-9]+)$").find(lines[0].trim())
		?: throw RuntimeException("LocalAiMergeProvider: missing CONFIDENCE header")
	val rawConfidence = confidenceMatch.groupValues[1].toDouble()
	val confidence = rawConfidence.coerceIn(0.0, 1.0)

	val beginMarker = "BEGIN_MERGED_$token"
	val endMarker = "END_MERGED_$token"
	val beginIdx = lines.indexOfFirst { it.trim() == beginMarker }
	var endIdx = -1
	if (beginIdx != -1) {
		for (i in (beginIdx + 1) until lines.size) {
			if (lines[i].trim() == endMarker) {
				endIdx = i
				break
			}
		}
	}
	if (beginIdx == -1 || endIdx == -1) {
		throw RuntimeException("LocalAiMergeProvider: missing BEGIN_MERGED / END_MERGED bracket")
	}
	val body = lines.subList(beginIdx + 1, endIdx).joinToString("\n")
	return ParsedOutput(merged = body, confidence = confidence)
}
