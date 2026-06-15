package ai.jolli.jollimemory.core.references

import com.google.gson.JsonElement

/**
 * CLI producer binding — resolves a shell command string to a reference source.
 *
 * Currently handles `gh issue view … --json` → GitHub issue reference.
 */
object CliBinding {

	data class Binding(
		val id: SourceId,
		val canonicalToolName: String,
		val normalize: (JsonElement?) -> JsonElement?,
	)

	private val COMMAND_BOUNDARIES = setOf("&&", "||", "|", ";", "&", "(", "{")
	private val ENV_ASSIGN = Regex("^[A-Za-z_][A-Za-z0-9_]*=")
	private val GH_EXECUTABLE = Regex("(^|[/\\\\])gh(\\.exe)?$", RegexOption.IGNORE_CASE)

	/** First CLI binding whose `matches(command)` is true, or null. */
	fun matchCommand(command: String): Binding? {
		if (matchesGhIssueView(command)) return ghIssueBinding
		return null
	}

	// --- gh issue view --json binding ---

	private val ghIssueBinding = Binding(
		id = SourceId.github,
		canonicalToolName = "mcp__github__issue_read",
		normalize = { business ->
			val reshaped = GitHubNormalize.reshape(business)
			lowercaseState(reshaped)
		},
	)

	/** Lowercase `state` only (gh "CLOSED" → "closed"). */
	private fun lowercaseState(reshaped: JsonElement?): JsonElement? {
		if (reshaped == null || !reshaped.isJsonObject) return reshaped
		val obj = reshaped.asJsonObject
		val state = obj.stringOrNull("state") ?: return reshaped
		val result = obj.deepCopy()
		result.addProperty("state", state.lowercase())
		return result
	}

	/** Match each newline-separated statement independently. */
	private fun matchesGhIssueView(command: String): Boolean =
		command.split(Regex("[\\r\\n]+")).any { lineHasGhIssueView(it) }

	private fun lineHasGhIssueView(line: String): Boolean {
		// Pad shell metacharacters so operators become their own tokens.
		val all = line.replace(Regex("([;|&(){}])"), " $1 ")
			.split(Regex("\\s+"))
			.filter { it.isNotEmpty() }
		// Drop trailing # comment
		val hash = all.indexOf("#")
		val tokens = if (hash == -1) all else all.subList(0, hash)
		for (i in tokens.indices) {
			if (!GH_EXECUTABLE.containsMatchIn(tokens[i]) || !atCommandPosition(tokens, i)) continue
			val rest = tokens.subList(i + 1, tokens.size)
			val hasIssueViewPair = rest.indices.any { k -> rest[k] == "issue" && k + 1 < rest.size && rest[k + 1] == "view" }
			if (!hasIssueViewPair) continue
			if (rest.any { isJsonFlag(it) }) return true
		}
		return false
	}

	private fun atCommandPosition(tokens: List<String>, i: Int): Boolean {
		var j = i - 1
		while (j >= 0 && ENV_ASSIGN.containsMatchIn(tokens[j])) j--
		return j < 0 || tokens[j] in COMMAND_BOUNDARIES
	}

	private fun isJsonFlag(token: String): Boolean =
		token == "--json" || token.startsWith("--json=")
}
