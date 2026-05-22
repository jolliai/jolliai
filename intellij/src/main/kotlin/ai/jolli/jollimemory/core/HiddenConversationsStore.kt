package ai.jolli.jollimemory.core

import com.google.gson.GsonBuilder
import com.google.gson.JsonParser
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.time.Instant

/**
 * HiddenConversationsStore — Kotlin port of HiddenConversationsStore.ts
 *
 * Persists the set of AI conversations the user wants hidden from the
 * sidebar CONVERSATIONS list. Implemented as a single JSON file under
 * `<projectDir>/.jolli/jollimemory/hidden-conversations.json`.
 *
 * Auto-unhide: sessions whose updatedAt has advanced past hiddenAt
 * re-surface automatically, so "Mark All as Deleted" is a per-snapshot
 * dismiss rather than a permanent block.
 */
object HiddenConversationsStore {

	private val log = JmLogger.create("HiddenConversations")
	private val gson = GsonBuilder().setPrettyPrinting().create()

	private const val HIDDEN_FILE = "hidden-conversations.json"
	private const val HIDDEN_VERSION = 1

	private const val HIDDEN_LOCK_WAIT_MS = 2000L
	private const val HIDDEN_LOCK_STALE_MS = 10_000L
	private const val HIDDEN_LOCK_POLL_MS = 25L

	// ── Data types ──────────────────────────────────────────────────────────

	data class HiddenEntry(val hiddenAt: String)

	data class HiddenConversationsState(
		val version: Int = HIDDEN_VERSION,
		val entries: Map<String, HiddenEntry> = emptyMap(),
	)

	// ── Key ─────────────────────────────────────────────────────────────────

	fun hiddenKey(source: TranscriptSource, sessionId: String): String = "${source.name}:$sessionId"

	// ── Load ────────────────────────────────────────────────────────────────

	fun loadHiddenConversations(projectDir: String): HiddenConversationsState {
		val file = File(JmLogger.getJolliMemoryDir(projectDir), HIDDEN_FILE)
		if (!file.exists()) return HiddenConversationsState()
		return try {
			val raw = file.readText(Charsets.UTF_8)
			val obj = JsonParser.parseString(raw).asJsonObject
			val version = obj.get("version")?.asInt
			if (version != HIDDEN_VERSION) {
				log.warn("loadHiddenConversations version mismatch (got %s) — ignoring file", version)
				return HiddenConversationsState()
			}
			val entriesObj = obj.getAsJsonObject("entries")
			if (entriesObj == null) {
				log.warn("loadHiddenConversations malformed entries — ignoring file")
				return HiddenConversationsState()
			}
			val cleaned = mutableMapOf<String, HiddenEntry>()
			for ((k, v) in entriesObj.entrySet()) {
				if (v.isJsonObject) {
					val hiddenAt = v.asJsonObject.get("hiddenAt")?.asString
					if (hiddenAt != null) {
						cleaned[k] = HiddenEntry(hiddenAt)
					}
				}
			}
			HiddenConversationsState(HIDDEN_VERSION, cleaned)
		} catch (e: Exception) {
			log.warn("loadHiddenConversations failed: %s", e.message)
			HiddenConversationsState()
		}
	}

	// ── Query ───────────────────────────────────────────────────────────────

	fun isHidden(state: HiddenConversationsState, source: TranscriptSource, sessionId: String): Boolean =
		hiddenKey(source, sessionId) in state.entries

	/**
	 * Returns true only when the session is hidden AND no new turns have arrived
	 * since the user hid it. The aggregator uses this (not `isHidden`) so that
	 * sessions with new activity re-surface automatically.
	 */
	fun isStillHidden(
		state: HiddenConversationsState,
		source: TranscriptSource,
		sessionId: String,
		sessionUpdatedAt: String,
	): Boolean {
		val key = hiddenKey(source, sessionId)
		val entry = state.entries[key] ?: return false
		val hiddenAtMs = try {
			Instant.parse(entry.hiddenAt).toEpochMilli()
		} catch (_: Exception) {
			return true
		}
		val updatedAtMs = try {
			Instant.parse(sessionUpdatedAt).toEpochMilli()
		} catch (_: Exception) {
			return true
		}
		return updatedAtMs <= hiddenAtMs
	}

	// ── Write ───────────────────────────────────────────────────────────────

	/**
	 * Marks a session as hidden. Idempotent: re-hiding refreshes the timestamp.
	 * Serialized by an advisory `.lock` file with stale-lock recovery.
	 */
	fun hideConversation(
		projectDir: String,
		source: TranscriptSource,
		sessionId: String,
	): HiddenConversationsState {
		val dir = File(JmLogger.getJolliMemoryDir(projectDir))
		dir.mkdirs()
		val finalFile = File(dir, HIDDEN_FILE)
		val lockFile = File("${finalFile.absolutePath}.lock")
		acquireHiddenLock(lockFile)
		try {
			val current = loadHiddenConversations(projectDir)
			val key = hiddenKey(source, sessionId)
			val nextEntries = current.entries.toMutableMap()
			nextEntries[key] = HiddenEntry(Instant.now().toString())
			val next = HiddenConversationsState(HIDDEN_VERSION, nextEntries)
			val tmpFile = File("${finalFile.absolutePath}.tmp")
			tmpFile.writeText(gson.toJson(next), Charsets.UTF_8)
			Files.move(tmpFile.toPath(), finalFile.toPath(), StandardCopyOption.REPLACE_EXISTING)
			return next
		} finally {
			try {
				lockFile.delete()
			} catch (e: Exception) {
				log.debug("HiddenConversations lock release failed: %s", e.message)
			}
		}
	}

	// ── Locking ─────────────────────────────────────────────────────────────

	private fun acquireHiddenLock(lockFile: File) {
		val start = System.currentTimeMillis()
		while (true) {
			try {
				Files.write(
					lockFile.toPath(),
					ProcessHandle.current().pid().toString().toByteArray(),
					StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE,
				)
				return
			} catch (_: java.nio.file.FileAlreadyExistsException) {
				// Lock held by someone else
			}

			// Stale-lock recovery: if the lock is older than the threshold,
			// assume the previous holder crashed and reclaim it.
			try {
				if (lockFile.exists() && System.currentTimeMillis() - lockFile.lastModified() > HIDDEN_LOCK_STALE_MS) {
					lockFile.delete()
					continue
				}
			} catch (_: Exception) {
				continue
			}

			if (System.currentTimeMillis() - start > HIDDEN_LOCK_WAIT_MS) {
				throw RuntimeException(
					"hideConversation: lock contention timeout (${HIDDEN_LOCK_WAIT_MS}ms) at ${lockFile.absolutePath}",
				)
			}
			Thread.sleep(HIDDEN_LOCK_POLL_MS)
		}
	}
}
