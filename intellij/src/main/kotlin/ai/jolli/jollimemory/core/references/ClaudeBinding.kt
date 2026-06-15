package ai.jolli.jollimemory.core.references

import com.google.gson.JsonElement

/**
 * Claude producer binding — resolves a Claude Code MCP tool name to its source.
 *
 * Recognition carries two concerns:
 *   1. Source recognition (which MCP prefix → which source)
 *   2. Tool-level business scope (Notion only accepts `notion-fetch`)
 */
object ClaudeBinding {

	/** Tool whose `input.command` carries a shell command line. */
	val SHELL_TOOL_NAMES: Set<String> = setOf("Bash")

	data class Resolved(
		val sourceId: SourceId,
		/** "cli" results require command success (the is_error gate); "mcp" keeps prior behaviour. */
		val kind: Kind,
		/** Persisted as `sourceToolName`: the real MCP tool name, or the CLI canonical name. */
		val toolName: String,
		val normalize: (JsonElement?) -> JsonElement?,
	)

	enum class Kind { mcp, cli }

	private data class Rule(
		val prefix: String,
		val sourceId: SourceId,
		val accept: ((String) -> Boolean)? = null,
	)

	private val RULES = listOf(
		Rule("mcp__github__", SourceId.github),
		Rule("mcp__claude_ai_Atlassian__", SourceId.jira),
		Rule("mcp__linear__", SourceId.linear),
		Rule("mcp__claude_ai_Notion__", SourceId.notion, accept = { it.endsWith("notion-fetch") }),
	)

	/** Tool-name prefixes for the envelope's cheap per-line substring pre-filter. */
	val TOOL_PREFIXES: List<String> = RULES.map { it.prefix }

	private val identity: (JsonElement?) -> JsonElement? = { it }

	/** Resolve a Claude MCP tool name to its binding, or null. */
	fun bindingForToolName(name: String): Pair<SourceId, (JsonElement?) -> JsonElement?>? {
		for (rule in RULES) {
			if (!name.startsWith(rule.prefix)) continue
			if (rule.accept != null && !rule.accept.invoke(name)) return null
			return rule.sourceId to identity
		}
		return null
	}

	/**
	 * Resolve a Claude tool_use to its reference source: MCP tool by name prefix,
	 * OR a shell CLI by the command in its `input`. Returns null if neither matches.
	 */
	fun resolve(name: String, input: com.google.gson.JsonObject?): Resolved? {
		val mcp = bindingForToolName(name)
		if (mcp != null) return Resolved(mcp.first, Kind.mcp, name, mcp.second)
		if (name in SHELL_TOOL_NAMES) {
			val command = input?.stringOrNull("command")
			if (command != null) {
				val cli = CliBinding.matchCommand(command)
				if (cli != null) {
					return Resolved(cli.id, Kind.cli, cli.canonicalToolName, cli.normalize)
				}
			}
		}
		return null
	}
}
