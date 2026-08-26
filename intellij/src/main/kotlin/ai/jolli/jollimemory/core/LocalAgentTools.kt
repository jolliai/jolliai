package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations

/**
 * UI DTO adapter for the CLI-owned `LOCAL_AGENT_TOOLS` map
 * (`cli/src/core/localagent/ToolMeta.ts`).
 *
 * Two-tier, mirroring how VS Code stays reliable: the extension bundles
 * `LOCAL_AGENT_TOOLS` statically at build time and always renders every tool,
 * so its picker never collapses to a single entry. IntelliJ cannot import the TS
 * map, so it keeps a [DEFAULT_TOOLS] Kotlin copy as the always-available baseline
 * and treats the `jolli ide-bridge local-agent-tools` fetch ([load]) purely as an
 * *enhancement* — it overrides the baseline when it succeeds (picking up ordering
 * and any brand-new backend), but a bridge failure now degrades to the FULL list,
 * not to Claude-only. Before this, any bridge hiccup (daemon down, environment,
 * a slow cold spawn) left the picker showing just Claude Code.
 *
 * LOCKSTEP: [DEFAULT_TOOLS] is a hand-maintained mirror of `LOCAL_AGENT_TOOLS`.
 * Adding/removing/relabelling a local-agent tool in `ToolMeta.ts` MUST update this
 * list in the same change (pinned by `LocalAgentToolsTest`). This is the one place
 * the "no Kotlin port" note in that file no longer holds — the offline reliability
 * is worth the small, rarely-changing copy. When the bridge is reachable it stays
 * authoritative, so a momentary drift only affects fully-offline IntelliJ runs.
 *
 * All bridge calls prefer the long-lived daemon (~5-20 ms) — see
 * [CliIntegrations.runIdeBridge]. The one-shot spawn fallback (~500 ms-2 s) only
 * fires when the daemon is unbound, so callers should still fetch off the EDT and
 * update the picker via `invokeLater`.
 */
object LocalAgentTools {
	/**
	 * Complete static tool list — the mirror of `LOCAL_AGENT_TOOLS` in
	 * `cli/src/core/localagent/ToolMeta.ts`, in the same order. Used as the
	 * picker's initial model AND as the fallback when the bridge fetch fails, so
	 * the IntelliJ picker always offers every backend, exactly like VS Code.
	 */
	val DEFAULT_TOOLS: List<LocalAgentToolOption> =
		listOf(
			LocalAgentToolOption("claude-code", "Claude Code", "Run `claude` once and sign in to your subscription."),
			LocalAgentToolOption("codex", "Codex", "Run `codex login` to sign in with your ChatGPT plan."),
			LocalAgentToolOption("cursor-agent", "Cursor", "Run `cursor-agent login` to sign in to Cursor."),
			LocalAgentToolOption("opencode", "OpenCode", "Run `opencode auth login` to connect a provider."),
			LocalAgentToolOption("kimi", "Kimi Code", "Run `kimi login` to sign in to your Moonshot account."),
			// Hermes' model ids are provider/model pairs over a user-defined provider
			// set, so the hint points at its own setup rather than a subscription
			// login — mirrors `cli/src/core/localagent/ToolMeta.ts`.
			LocalAgentToolOption("hermes", "Hermes", "Run `hermes setup` (or `hermes model`) to configure a provider."),
		)

	/** The single default tool (Claude Code) — the first of [DEFAULT_TOOLS]. */
	val FALLBACK: LocalAgentToolOption = DEFAULT_TOOLS.first()

	/**
	 * Loads the current tool list from the CLI. On success the live list wins (so
	 * a newly added CLI backend appears without a plugin update). Any bridge
	 * failure — daemon down, older CLI without the `local-agent-tools` action,
	 * malformed JSON, a slow/failed spawn — degrades to the full [DEFAULT_TOOLS]
	 * baseline, so the picker always shows every tool rather than collapsing to
	 * Claude Code alone.
	 */
	fun load(projectDir: String): List<LocalAgentToolOption> {
		return try {
			val result = CliIntegrations.runIdeBridge(projectDir, "local-agent-tools", null).asJsonObject
			val tools = result.getAsJsonArray("tools") ?: return DEFAULT_TOOLS
			tools.mapNotNull { element ->
				val obj = element?.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
				val id = obj.get("id")?.takeUnless { it.isJsonNull }?.asString ?: return@mapNotNull null
				val label = obj.get("label")?.takeUnless { it.isJsonNull }?.asString ?: return@mapNotNull null
				val loginHint = obj.get("loginHint")?.takeUnless { it.isJsonNull }?.asString.orEmpty()
				LocalAgentToolOption(id = id, label = label, loginHint = loginHint)
			}.ifEmpty { DEFAULT_TOOLS }
		} catch (_: Exception) {
			// Expected failure modes: CliBridgeException (older CLI without this
			// action), JsonSyntaxException (malformed response), or any other
			// bridge/IO error. All degrade to the full static list so no bridge
			// error ever leaves the picker showing only Claude Code.
			DEFAULT_TOOLS
		}
	}
}

/** One row of the CLI `LOCAL_AGENT_TOOLS` map, projected for UI use. */
data class LocalAgentToolOption(
	val id: String,
	val label: String,
	val loginHint: String,
)
