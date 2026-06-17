package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.core.JmLogger.JOLLIMEMORY_DIR
import ai.jolli.jollimemory.core.JmLogger.JOLLI_DIR
import com.google.gson.Gson
import com.google.gson.JsonObject
import java.io.File

/**
 * CommitSelectionStore — persists the set of sidebar items the user wants
 * EXCLUDED from the next summary pipeline run.
 *
 * Four kinds (conversations / plans / notes / references) live in a single
 * JSON file under `<projectDir>/.jolli/jollimemory/commit-selection.json`.
 *
 * Sticky semantics: an entry stays in this file until the user explicitly
 * un-excludes the item (re-checks the row). No git operation or pipeline
 * outcome modifies the file — the PostCommitHook only ever READS it.
 */
object CommitSelectionStore {

	private val log = JmLogger.create("CommitSelection")
	private const val SELECTION_FILE = "commit-selection.json"
	private const val SELECTION_VERSION = 2
	private val gson = Gson()

	data class CommitExclusions(
		val conversations: Set<String> = emptySet(),
		val plans: Set<String> = emptySet(),
		val notes: Set<String> = emptySet(),
		val references: Set<String> = emptySet(),
	)

	private fun selectionFile(projectDir: String): File {
		return File(projectDir, "$JOLLI_DIR/$JOLLIMEMORY_DIR/$SELECTION_FILE")
	}

	fun readExclusions(projectDir: String): CommitExclusions {
		val file = selectionFile(projectDir)
		if (!file.exists()) return CommitExclusions()

		return try {
			val json = gson.fromJson(file.readText(), JsonObject::class.java) ?: return CommitExclusions()
			val version = json.get("version")?.asInt
			if (version != SELECTION_VERSION && version != 1) {
				log.warn("readExclusions version mismatch (got %s) — ignoring file", version)
				return CommitExclusions()
			}
			CommitExclusions(
				conversations = asStringSet(json, "conversations"),
				plans = asStringSet(json, "plans"),
				notes = asStringSet(json, "notes"),
				references = asStringSet(json, "references"),
			)
		} catch (ex: Exception) {
			log.warn("readExclusions failed: %s", ex.message)
			CommitExclusions()
		}
	}

	fun setExcluded(projectDir: String, kind: String, key: String, excluded: Boolean) {
		val current = readExclusions(projectDir)
		val next = mutableMapOf(
			"conversations" to current.conversations.toMutableSet(),
			"plans" to current.plans.toMutableSet(),
			"notes" to current.notes.toMutableSet(),
			"references" to current.references.toMutableSet(),
		)
		val set = next[kind] ?: return
		if (excluded) set.add(key) else set.remove(key)

		writeExclusions(projectDir, next)
	}

	fun setAllExcluded(projectDir: String, kind: String, keys: List<String>, excluded: Boolean) {
		val current = readExclusions(projectDir)
		val next = mutableMapOf(
			"conversations" to current.conversations.toMutableSet(),
			"plans" to current.plans.toMutableSet(),
			"notes" to current.notes.toMutableSet(),
			"references" to current.references.toMutableSet(),
		)
		val set = next[kind] ?: return
		if (excluded) {
			for (k in keys) set.add(k)
		} else {
			for (k in keys) set.remove(k)
		}

		writeExclusions(projectDir, next)
	}

	fun conversationKey(source: TranscriptSource, sessionId: String): String {
		return "${source.name}:$sessionId"
	}

	private fun writeExclusions(projectDir: String, data: Map<String, Set<String>>) {
		val file = selectionFile(projectDir)
		file.parentFile?.mkdirs()

		val payload = mapOf(
			"version" to SELECTION_VERSION,
			"conversations" to (data["conversations"] ?: emptySet()).toList(),
			"plans" to (data["plans"] ?: emptySet()).toList(),
			"notes" to (data["notes"] ?: emptySet()).toList(),
			"references" to (data["references"] ?: emptySet()).toList(),
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

	private fun asStringSet(json: JsonObject, key: String): Set<String> {
		val arr = json.getAsJsonArray(key) ?: return emptySet()
		return arr.mapNotNull { el ->
			try { el.asString } catch (_: Exception) { null }
		}.toSet()
	}
}
