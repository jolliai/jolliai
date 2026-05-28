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

		return """You are extracting bullet points from a development session to help the user quickly recall what they did.
$existingSection
## Conversation Transcript
$transcriptText

## Purpose
These bullets are a personal memory aid. The user should be able to skim them weeks later and think "oh right, that's what I worked on" within about 30 seconds. They are NOT a record of everything noteworthy that came up — they are the handful of things the user themselves would most want to remember.

## Objective
1. Primary goal: remind the user what they did in this session. They should be able to skim the bullets and immediately recall the session.
2. Secondary goal: surface the most important information from the session — key decisions, blockers, or context worth remembering later.

## Perspective: what the user wanted and how the session felt

These bullets answer "what did I do in this session?" from the user's point of view. The most valuable bullets are high-level statements of the user's intent and the shape of the work — not specific decisions inside it. Think: "what would the user say if a friend asked what they worked on?"

Examples of well-framed bullets:
- "Designed an MVP for tagging conversations to git branches"
- "Debugged an OAuth flow that was rejecting valid tokens"
- "Reviewed and approved Claude's plan for the data-layer rewrite"
- "Explored whether to use Mem0 or build memory from scratch"
- "Wrote and iterated on a prompt for generating session summaries"

Match the verb to what the user was actually doing:
- If the user drove the session by articulating choices in their own words → "decided", "chose", "switched"
- If Claude proposed most things and the user mostly reviewed/accepted → "reviewed", "approved", "worked through"
- If the user was debugging or stuck → "debugged", "got stuck on"
- If the user was designing or planning → "designed", "planned", "specced"

Do NOT fabricate decisive language for a session where the user was mostly riding along — that misrepresents the experience. Saying "Decided to switch to Postgres" when the user only replied "sure" to Claude's proposal is wrong; "Approved Claude's plan to switch to Postgres" is right.

Almost always wrong for a substantive working session: zero bullets. If real work happened, capture it. (Zero is only correct when the session was truly inert, or when the existing bullets already cover everything that occurred.)

## How many bullets
For a typical multi-hour Claude Code session, aim for 3–4 bullets. Floor is 2, hard ceiling is 5. Fewer than 2 means you're under-capturing the session. More than 5 means you're enumerating micro-decisions instead of summarizing.

Shorter or lower-density sessions can go below the floor (down to 0 if nothing happened), but a multi-hour working session should essentially always produce at least 2.

## What to skip
- Things Claude explained or taught
- Individual debugging steps, syntax fixes, or troubleshooting moves (these belong inside a higher-level bullet like "Debugged X", not as their own bullets)
- Background context or framing discussion
- Anything already captured in the existing bullets, even if you'd phrase it differently

## Example: high-level vs laundry-list

For a session where the user designed a new feature with Claude:

Right (high-level, 3 bullets):
["Designed an MVP for tagging conversations to git branches with auto-generated summaries",
 "Worked through the feature spec — multi-branch tagging via right-click menu, three panel views, summaries generated at commit time",
 "Iterated on the LLM prompt for those summaries, anchoring it on user intent over micro-decisions"]

Wrong (laundry list of micro-decisions):
["Decided summaries would be generated at commit time",
 "Decided summaries would accumulate rather than regenerate",
 "Decided to use a separate LLM call",
 "Decided tags would use branch name strings",
 "Decided to warn when a branch is missing",
 "Decided the conversations panel would have three views"]

## Output format
Return ONLY a JSON array of strings. No markdown, no code fences, no commentary. If nothing new is worth adding, return [].

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
