package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import com.google.gson.Gson
import com.google.gson.JsonObject

/** DTO/process adapter for the CLI-owned conversation overlay store. */
object ConversationOverlayStore {
	private val gson = Gson()

	data class EntryIdentity(
		val role: String,
		val content: String,
		val timestamp: String? = null,
	)

	data class OverlayEditRule(
		val role: String,
		val content: String,
		val timestamp: String? = null,
		val newContent: String,
	)

	data class ConversationOverlay(
		val version: Int,
		val source: String,
		val sessionId: String,
		val updatedAt: String,
		val deletes: List<EntryIdentity>,
		val edits: List<OverlayEditRule>,
	)

	data class OverlayKey(
		val projectDir: String,
		val source: TranscriptSource,
		val sessionId: String,
	)

	data class OverlayView(
		val overlay: ConversationOverlay?,
		val displayed: List<TranscriptEntry>,
		val rawWithDeletesOnly: List<TranscriptEntry>,
	)

	fun loadView(key: OverlayKey, entries: List<TranscriptEntry>): OverlayView {
		val request = baseRequest(key, "view").apply { add("entries", gson.toJsonTree(entries)) }
		val result = CliIntegrations.runIdeBridge(key.projectDir, "conversation-overlay", gson.toJson(request))
		return gson.fromJson(result, OverlayView::class.java)
	}

	fun mergeAndSave(
		key: OverlayKey,
		deletes: List<EntryIdentity>,
		edits: List<OverlayEditRule>,
	): ConversationOverlay {
		val request = baseRequest(key, "merge-save").apply {
			add("deletes", gson.toJsonTree(deletes))
			add("edits", gson.toJsonTree(edits))
		}
		val result = CliIntegrations.runIdeBridge(key.projectDir, "conversation-overlay", gson.toJson(request))
		return gson.fromJson(result, ConversationOverlay::class.java)
	}

	fun hideConversation(projectDir: String, source: TranscriptSource, sessionId: String) {
		val key = OverlayKey(projectDir, source, sessionId)
		CliIntegrations.runIdeBridge(projectDir, "conversation-overlay", gson.toJson(baseRequest(key, "hide")))
	}

	private fun baseRequest(key: OverlayKey, operation: String): JsonObject = JsonObject().apply {
		addProperty("operation", operation)
		addProperty("source", key.source.name)
		addProperty("sessionId", key.sessionId)
	}
}
