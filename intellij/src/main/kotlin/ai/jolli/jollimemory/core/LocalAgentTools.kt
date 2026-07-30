package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations

/**
 * Thin UI DTO adapter for the CLI-owned `LOCAL_AGENT_TOOLS` map
 * (`cli/src/core/localagent/ToolMeta.ts`).
 *
 * Rendering the local-agent picker from the CLI (over `jolli ide-bridge
 * local-agent-tools`) instead of a hand-maintained Kotlin copy keeps the
 * IntelliJ plugin picker in sync with every new backend added to the CLI —
 * no static coupling, no lockstep rule.
 *
 * All bridge calls prefer the long-lived daemon (~5-20 ms) — see
 * [CliIntegrations.runIdeBridge]. The one-shot spawn fallback (~500 ms-2 s)
 * only fires when the daemon is unbound, so callers should still fetch off the
 * EDT and update the picker via `invokeLater`.
 */
object LocalAgentTools {
	/** Default entry used when the bridge call fails; matches the historical
	 *  hard-coded picker so a broken daemon never leaves the picker empty. */
	val FALLBACK: LocalAgentToolOption =
		LocalAgentToolOption(
			id = "claude-code",
			label = "Claude Code",
			loginHint = "Run `claude` once and sign in to your subscription.",
		)

	/**
	 * Loads the current tool list from the CLI. Any bridge failure — daemon
	 * down, older CLI without the `local-agent-tools` action, malformed JSON —
	 * returns the [FALLBACK] singleton so the picker stays usable.
	 */
	fun load(projectDir: String): List<LocalAgentToolOption> {
		return try {
			val result = CliIntegrations.runIdeBridge(projectDir, "local-agent-tools", null).asJsonObject
			val tools = result.getAsJsonArray("tools") ?: return listOf(FALLBACK)
			tools.mapNotNull { element ->
				val obj = element?.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
				val id = obj.get("id")?.takeUnless { it.isJsonNull }?.asString ?: return@mapNotNull null
				val label = obj.get("label")?.takeUnless { it.isJsonNull }?.asString ?: return@mapNotNull null
				val loginHint = obj.get("loginHint")?.takeUnless { it.isJsonNull }?.asString.orEmpty()
				LocalAgentToolOption(id = id, label = label, loginHint = loginHint)
			}.ifEmpty { listOf(FALLBACK) }
		} catch (_: Exception) {
			// Expected failure modes: CliBridgeException (older CLI without this
			// action), JsonSyntaxException (malformed response), or any other
			// bridge/IO error. All degrade identically to FALLBACK so no bridge
			// error ever propagates to the EDT caller or leaves the picker empty.
			listOf(FALLBACK)
		}
	}
}

/** One row of the CLI `LOCAL_AGENT_TOOLS` map, projected for UI use. */
data class LocalAgentToolOption(
	val id: String,
	val label: String,
	val loginHint: String,
)
