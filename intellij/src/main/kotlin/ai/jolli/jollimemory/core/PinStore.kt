package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.core.JmLogger.JOLLIMEMORY_DIR
import ai.jolli.jollimemory.core.JmLogger.JOLLI_DIR
import com.google.gson.Gson
import com.google.gson.JsonObject
import java.io.File
import java.time.Instant

/**
 * PinStore — persists the items the user has PINNED so they survive across
 * sessions and surface in the redesigned "Pinned" section.
 *
 * Each pin is a [PinnedEntry] capturing the item's `kind` (conversations / plans /
 * notes / references / memories), its `key` (the same key used by
 * [CommitSelectionStore] — e.g. `conversationKey(source, sessionId)`, a plan slug,
 * a note id, a reference mapKey, or a commit hash), and a display `title` snapshot
 * so the Pinned section can render a meaningful row without re-resolving the item.
 *
 * Stored under `<projectDir>/.jolli/jollimemory/pins.json`. The directory is
 * per-project and therefore worktree-scoped (mirrors [CommitSelectionStore]).
 */
object PinStore {

	private val log = JmLogger.create("PinStore")
	private const val PIN_FILE = "pins.json"
	private const val PIN_VERSION = 1
	private val gson = Gson()

	data class PinnedEntry(
		val kind: String,
		val key: String,
		val title: String,
		/** Short tag mirroring the source row's badge — a source name (conversations) or
		 *  a letter tag (P/N/S/L/GH/J/No for context). Drives the Pinned row's icon. */
		val badge: String,
		val pinnedAt: String,
	)

	private fun pinFile(projectDir: String): File {
		return File(projectDir, "$JOLLI_DIR/$JOLLIMEMORY_DIR/$PIN_FILE")
	}

	/** All pins, newest first. */
	fun readPins(projectDir: String): List<PinnedEntry> {
		val file = pinFile(projectDir)
		if (!file.exists()) return emptyList()

		return try {
			val json = gson.fromJson(file.readText(), JsonObject::class.java) ?: return emptyList()
			if (json.get("version")?.asInt != PIN_VERSION) {
				log.warn("readPins version mismatch — ignoring file")
				return emptyList()
			}
			val arr = json.getAsJsonArray("pins") ?: return emptyList()
			arr.mapNotNull { el ->
				val o = el as? JsonObject ?: return@mapNotNull null
				val kind = o.get("kind")?.asString ?: return@mapNotNull null
				val key = o.get("key")?.asString ?: return@mapNotNull null
				PinnedEntry(
					kind = kind,
					key = key,
					title = o.get("title")?.asString ?: key,
					badge = o.get("badge")?.asString ?: "",
					pinnedAt = o.get("pinnedAt")?.asString ?: "",
				)
			}.sortedByDescending { it.pinnedAt }
		} catch (ex: Exception) {
			log.warn("readPins failed: %s", ex.message)
			emptyList()
		}
	}

	fun isPinned(projectDir: String, kind: String, key: String): Boolean =
		readPins(projectDir).any { it.kind == kind && it.key == key }

	/** Pins an item (or refreshes its title/badge/timestamp if already pinned). */
	fun pin(projectDir: String, kind: String, key: String, title: String, badge: String) {
		val now = Instant.now().toString()
		val current = readPins(projectDir).filterNot { it.kind == kind && it.key == key }
		write(projectDir, current + PinnedEntry(kind, key, title, badge, now))
	}

	fun unpin(projectDir: String, kind: String, key: String) {
		val current = readPins(projectDir)
		val next = current.filterNot { it.kind == kind && it.key == key }
		if (next.size != current.size) write(projectDir, next)
	}

	private fun write(projectDir: String, pins: List<PinnedEntry>) {
		val file = pinFile(projectDir)
		file.parentFile?.mkdirs()

		val payload = mapOf(
			"version" to PIN_VERSION,
			"pins" to pins.map {
				mapOf(
					"kind" to it.kind, "key" to it.key, "title" to it.title,
					"badge" to it.badge, "pinnedAt" to it.pinnedAt,
				)
			},
		)

		val tmp = File(file.parentFile, "${file.name}.tmp-${ProcessHandle.current().pid()}-${System.currentTimeMillis()}")
		try {
			tmp.writeText(gson.toJson(payload))
			if (!tmp.renameTo(file)) {
				// renameTo can fail on Windows; fall back to overwrite
				file.writeText(tmp.readText())
				tmp.delete()
			}
		} catch (ex: Exception) {
			tmp.delete()
			throw ex
		}
	}
}
