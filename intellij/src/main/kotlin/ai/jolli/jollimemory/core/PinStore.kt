package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import com.google.gson.Gson
import com.google.gson.JsonObject

/** Thin UI DTO adapter for CLI `PinStore.ts`. */
object PinStore {
	private val gson = Gson()

	data class PinnedEntry(val kind: String, val key: String, val title: String, val badge: String, val pinnedAt: Long)
	private data class CliPin(
		val kind: String,
		val id: String,
		val title: String,
		val badge: String? = null,
		val source: String? = null,
		val pinnedAt: Long = 0,
	)

	fun readPins(projectDir: String): List<PinnedEntry> {
		val result = run(projectDir, request("pins-read")).asJsonObject.getAsJsonArray("pins") ?: return emptyList()
		return result.map { gson.fromJson(it, CliPin::class.java) }
			.map { PinnedEntry(plural(it.kind), it.id, it.title, it.badge ?: it.source.orEmpty(), it.pinnedAt) }
			.sortedByDescending { it.pinnedAt }
	}

	fun isPinned(projectDir: String, kind: String, key: String): Boolean =
		readPins(projectDir).any { it.kind == kind && it.key == key }

	fun pin(projectDir: String, kind: String, key: String, title: String, badge: String) {
		run(projectDir, request("pins-add").apply {
			addProperty("kind", kind)
			addProperty("key", key)
			addProperty("title", title)
			addProperty("badge", badge)
		})
	}

	fun unpin(projectDir: String, kind: String, key: String) {
		run(projectDir, request("pins-remove").apply {
			addProperty("kind", kind)
			addProperty("key", key)
		})
	}

	private fun plural(kind: String): String = when (kind) {
		"conversation" -> "conversations"
		"plan" -> "plans"
		"note" -> "notes"
		"memory" -> "memories"
		"reference" -> "references"
		else -> kind
	}

	private fun request(operation: String): JsonObject = JsonObject().apply { addProperty("operation", operation) }
	private fun run(cwd: String, request: JsonObject) = CliIntegrations.runIdeBridge(cwd, "shared-store", gson.toJson(request))
}
