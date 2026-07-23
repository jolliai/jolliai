package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import com.google.gson.Gson

/** Thin JVM adapter for the CLI-owned active-session aggregation pipeline. */
object ActiveSessionAggregator {

	private val gson = Gson()

	private const val DEFAULT_WINDOW_MS = 2L * 24 * 60 * 60 * 1000

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
		return gson.fromJson(result, ActiveConversationsResult::class.java)
	}
}
