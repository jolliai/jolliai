package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import com.google.gson.Gson

/** Thin JVM adapter for the CLI-owned active-session aggregation pipeline. */
object ActiveSessionAggregator {

	private val gson = Gson()

	private const val DEFAULT_WINDOW_MS = 2L * 24 * 60 * 60 * 1000

	/**
	 * Hand-mirror of `isSourceEnabled` in cli/src/core/SessionTracker.ts (the
	 * canonical definition; `cli/src/core/ActiveSessionAggregator.ts` re-exports
	 * it for pre-existing importers). Kept in sync manually — TranscriptSource /
	 * JolliMemoryConfig field names already lockstep via the AGENTS.md contract,
	 * so this is one more line in that same contract. `xxxEnabled == false` is
	 * off; anything else (including null) is on. Shared source groupings:
	 * cursor+cursor-cli, copilot+copilot-chat, cline+cline-cli.
	 */
	fun isSourceEnabled(source: TranscriptSource?, config: JolliMemoryConfig): Boolean {
		return when (source ?: TranscriptSource.claude) {
			TranscriptSource.claude -> config.claudeEnabled != false
			TranscriptSource.codex -> config.codexEnabled != false
			TranscriptSource.gemini -> config.geminiEnabled != false
			TranscriptSource.opencode -> config.openCodeEnabled != false
			TranscriptSource.cursor,
			TranscriptSource.`cursor-cli` -> config.cursorEnabled != false
			TranscriptSource.copilot,
			TranscriptSource.`copilot-chat` -> config.copilotEnabled != false
			TranscriptSource.cline,
			TranscriptSource.`cline-cli` -> config.clineEnabled != false
			TranscriptSource.devin -> config.devinEnabled != false
			TranscriptSource.antigravity -> config.antigravityEnabled != false
		}
	}

	fun listActiveConversations(
		cwd: String,
		windowMs: Long = DEFAULT_WINDOW_MS,
	): List<ActiveConversationItem> =
		listActiveConversationsWithDiagnostics(cwd, windowMs).items

	fun listActiveConversationsWithDiagnostics(
		cwd: String,
		windowMs: Long = DEFAULT_WINDOW_MS,
	): ActiveConversationsResult {
		val result = CliIntegrations.runIdeBridge(
			projectDir = cwd,
			action = "active-conversations",
			requestJson = gson.toJson(mapOf("windowMs" to windowMs)),
		)
		val raw = gson.fromJson(result, ActiveConversationsResult::class.java)
		// Belt-and-suspenders: CLI aggregator already filters by config, this
		// pass catches any config drift between the CLI process and the JVM
		// (config.json edited after the bridge call started, etc). `failedSources`
		// gets the SAME gate so a source the user just disabled cannot spike the
		// "N sources unavailable" banner mid-render — VS Code parity with
		// `ActiveSessionsProvider.listWithDiagnostics`.
		val config = SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir())
		val items = raw.items.filter { isSourceEnabled(it.source, config) }
		val failedSources = raw.failedSources.filter { isSourceEnabled(it, config) }
		return ActiveConversationsResult(items = items, failedSources = failedSources)
	}
}
