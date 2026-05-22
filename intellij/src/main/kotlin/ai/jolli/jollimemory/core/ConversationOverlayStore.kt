package ai.jolli.jollimemory.core

import com.google.gson.GsonBuilder
import com.google.gson.JsonParser
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * ConversationOverlayStore — Kotlin port of ConversationOverlayStore.ts
 *
 * Persists user-authored edits and deletions to active AI conversations as
 * a sidecar JSON file under `<projectDir>/.jolli/jollimemory/conversation-edits/`.
 *
 * Why an overlay (vs. rewriting the source app's transcript): the source apps
 * own their transcript storage and may append to it while the panel is open.
 * Touching their files risks losing in-flight messages and is impossible for
 * sqlite-backed sources whose schema we don't own.
 *
 * Identity-based matching: rules match parsed entries by
 * `(role, content[, timestamp])` rather than by index. This is necessary
 * because the panel sees the full parsed transcript while the post-commit
 * QueueWorker reads slices (cursor -> beforeTimestamp).
 */
object ConversationOverlayStore {

	private val log = JmLogger.create("ConversationOverlay")
	private val gson = GsonBuilder().setPrettyPrinting().create()

	private const val OVERLAY_SUBDIR = "conversation-edits"
	private const val OVERLAY_VERSION = 2

	// ── Data types ──────────────────────────────────────────────────────────

	/** Identity of an entry in the source transcript. */
	data class EntryIdentity(
		val role: String, // "human" or "assistant"
		val content: String,
		val timestamp: String? = null,
	)

	/** A content-replacement rule — keeps the entry but swaps its content. */
	data class OverlayEditRule(
		val role: String,
		val content: String,
		val timestamp: String? = null,
		val newContent: String,
	) {
		fun toIdentity() = EntryIdentity(role, content, timestamp)
	}

	data class ConversationOverlay(
		val version: Int = OVERLAY_VERSION,
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

	/** Minimal shape an overlay can be applied to. */
	interface OverlayableSession {
		val sessionId: String
		val source: TranscriptSource?
		val entries: List<TranscriptEntry>
	}

	// ── Path resolution ─────────────────────────────────────────────────────

	fun overlayPath(key: OverlayKey): String {
		val safeSource = sanitizeForFilename(key.source.name)
		val safeSessionId = sanitizeForFilename(key.sessionId)
		val filename = "$safeSource--$safeSessionId.json"
		return File(JmLogger.getJolliMemoryDir(key.projectDir), "$OVERLAY_SUBDIR/$filename").absolutePath
	}

	// ── Load / Save ─────────────────────────────────────────────────────────

	/**
	 * Reads the overlay file for a session. Returns null if it doesn't exist
	 * or is unreadable / malformed.
	 */
	fun loadOverlay(key: OverlayKey): ConversationOverlay? {
		val file = File(overlayPath(key))
		if (!file.exists()) return null
		val raw = try {
			file.readText(Charsets.UTF_8)
		} catch (e: Exception) {
			log.warn("loadOverlay read failed for %s/%s: %s", key.source, key.sessionId, e.message)
			return null
		}
		val parsed = parseOverlay(raw)
		if (parsed == null) {
			log.warn("loadOverlay parse rejected for %s/%s — overlay file ignored", key.source, key.sessionId)
			return null
		}
		if (parsed.source != key.source.name || parsed.sessionId != key.sessionId) {
			log.warn(
				"loadOverlay key mismatch: file at %s/%s carries %s/%s",
				key.source, key.sessionId, parsed.source, parsed.sessionId,
			)
			return null
		}
		return parsed
	}

	/**
	 * Atomically writes the overlay for a session: write to `<path>.tmp`, then
	 * rename over the destination.
	 */
	fun saveOverlay(
		key: OverlayKey,
		deletes: List<EntryIdentity>,
		edits: List<OverlayEditRule>,
	): ConversationOverlay {
		val dir = File(JmLogger.getJolliMemoryDir(key.projectDir), OVERLAY_SUBDIR)
		dir.mkdirs()
		val finalPath = File(overlayPath(key))
		val tmpPath = File("${finalPath.absolutePath}.tmp")
		val payload = ConversationOverlay(
			version = OVERLAY_VERSION,
			source = key.source.name,
			sessionId = key.sessionId,
			updatedAt = java.time.Instant.now().toString(),
			deletes = dedupeIdentities(deletes),
			edits = dedupeEdits(edits),
		)
		tmpPath.writeText(gson.toJson(payload), Charsets.UTF_8)
		try {
			Files.move(tmpPath.toPath(), finalPath.toPath(), StandardCopyOption.REPLACE_EXISTING)
		} catch (e: Exception) {
			tmpPath.delete()
			throw e
		}
		return payload
	}

	// ── Apply ───────────────────────────────────────────────────────────────

	/**
	 * Projects the raw source entries through an overlay. Deletions are skipped,
	 * edits replace content. Order is preserved. Delete wins over edit.
	 */
	fun applyOverlay(
		entries: List<TranscriptEntry>,
		overlay: ConversationOverlay?,
	): List<TranscriptEntry> {
		if (overlay == null) return entries
		val result = mutableListOf<TranscriptEntry>()
		for (entry in entries) {
			if (matchesAnyIdentity(entry, overlay.deletes)) continue
			val edit = findMatchingEdit(entry, overlay.edits)
			if (edit != null) {
				result.add(entry.copy(content = edit.newContent))
			} else {
				result.add(entry)
			}
		}
		return result
	}

	/**
	 * Applies only the delete rules from an overlay, leaving edited entries with
	 * their raw content untouched. Used for identity anchoring in chained edits.
	 */
	fun applyDeletes(
		entries: List<TranscriptEntry>,
		overlay: ConversationOverlay?,
	): List<TranscriptEntry> {
		if (overlay == null) return entries
		return entries.filter { !matchesAnyIdentity(it, overlay.deletes) }
	}

	/**
	 * Merges new delete/edit rules into an existing overlay.
	 * - New deletes supersede any existing edit for the same identity.
	 * - New edits replace any existing edit for the same identity.
	 * - Identities already deleted stay deleted (idempotent).
	 */
	fun mergeOverlay(
		existing: ConversationOverlay?,
		newDeletes: List<EntryIdentity>,
		newEdits: List<OverlayEditRule>,
	): Pair<List<EntryIdentity>, List<OverlayEditRule>> {
		val allDeletes = (existing?.deletes ?: emptyList()).toMutableList()
		for (d in newDeletes) {
			if (!matchesAnyIdentity(d, allDeletes)) allDeletes.add(d)
		}

		val allEdits = mutableListOf<OverlayEditRule>()
		for (e in existing?.edits ?: emptyList()) {
			if (matchesAnyIdentity(e.toIdentity(), allDeletes)) continue
			if (newEdits.any { sameIdentity(it.toIdentity(), e.toIdentity()) }) continue
			allEdits.add(e)
		}
		for (e in newEdits) {
			if (matchesAnyIdentity(e.toIdentity(), allDeletes)) continue
			allEdits.add(e)
		}

		return allDeletes to allEdits
	}

	/**
	 * Loads the per-session overlay for each session and applies it.
	 * Sessions with no overlay file pass through unchanged.
	 */
	fun <T : OverlayableSession> applyOverlaysToSessions(
		sessions: List<T>,
		projectDir: String,
		copyWithEntries: (T, List<TranscriptEntry>) -> T,
	): List<T> {
		return sessions.map { s ->
			val overlay = loadOverlay(
				OverlayKey(
					projectDir = projectDir,
					source = s.source ?: TranscriptSource.claude,
					sessionId = s.sessionId,
				),
			)
			copyWithEntries(s, applyOverlay(s.entries, overlay))
		}
	}

	// ── Identity matching ───────────────────────────────────────────────────

	private fun entryToIdentity(entry: TranscriptEntry) =
		EntryIdentity(entry.role, entry.content, entry.timestamp)

	private fun matchesAnyIdentity(entry: TranscriptEntry, rules: List<EntryIdentity>): Boolean =
		rules.any { sameIdentity(entryToIdentity(entry), it) }

	private fun matchesAnyIdentity(identity: EntryIdentity, rules: List<EntryIdentity>): Boolean =
		rules.any { sameIdentity(identity, it) }

	private fun findMatchingEdit(entry: TranscriptEntry, rules: List<OverlayEditRule>): OverlayEditRule? {
		val entryId = entryToIdentity(entry)
		var first: OverlayEditRule? = null
		var collisions = 0
		for (r in rules) {
			if (!sameIdentity(entryId, r.toIdentity())) continue
			if (first == null) {
				first = r
			} else {
				collisions++
			}
		}
		if (collisions > 0 && first != null) {
			log.warn(
				"Edit identity collision (%s/%s) — %d additional matching rule(s) ignored",
				first.role, first.timestamp ?: "no-ts", collisions,
			)
		}
		return first
	}

	private fun sameIdentity(a: EntryIdentity, b: EntryIdentity): Boolean {
		if (a.role != b.role) return false
		if (a.content != b.content) return false
		if (a.timestamp != null && b.timestamp != null) return a.timestamp == b.timestamp
		// Both null or one null — lenient match
		return true
	}

	private fun dedupeIdentities(rules: List<EntryIdentity>): List<EntryIdentity> {
		val out = mutableListOf<EntryIdentity>()
		for (r in rules) {
			if (!matchesAnyIdentity(r, out)) out.add(r)
		}
		return out
	}

	private fun dedupeEdits(rules: List<OverlayEditRule>): List<OverlayEditRule> {
		val out = mutableListOf<OverlayEditRule>()
		for (r in rules) {
			val idx = out.indexOfFirst { sameIdentity(r.toIdentity(), it.toIdentity()) }
			if (idx >= 0) {
				out[idx] = r // later edit wins
			} else {
				out.add(r)
			}
		}
		return out
	}

	// ── Parsing ─────────────────────────────────────────────────────────────

	private fun parseOverlay(raw: String): ConversationOverlay? {
		return try {
			val obj = JsonParser.parseString(raw).asJsonObject
			val version = obj.get("version")?.asInt ?: return null
			if (version != OVERLAY_VERSION) return null
			val source = obj.get("source")?.asString ?: return null
			// Validate source is a known enum value
			try {
				TranscriptSource.valueOf(source)
			} catch (_: IllegalArgumentException) {
				return null
			}
			val sessionId = obj.get("sessionId")?.asString ?: return null
			val updatedAt = obj.get("updatedAt")?.asString ?: return null
			val deletesArr = obj.getAsJsonArray("deletes") ?: return null
			val editsArr = obj.getAsJsonArray("edits") ?: return null

			val deletes = deletesArr.mapNotNull { parseIdentity(it) }
			val edits = editsArr.mapNotNull { elem ->
				val id = parseIdentity(elem) ?: return@mapNotNull null
				val newContent = elem.asJsonObject.get("newContent")?.asString ?: return@mapNotNull null
				OverlayEditRule(id.role, id.content, id.timestamp, newContent)
			}

			ConversationOverlay(version, source, sessionId, updatedAt, deletes, edits)
		} catch (e: Exception) {
			null
		}
	}

	private fun parseIdentity(elem: com.google.gson.JsonElement): EntryIdentity? {
		if (!elem.isJsonObject) return null
		val obj = elem.asJsonObject
		val role = obj.get("role")?.asString ?: return null
		if (role != "human" && role != "assistant") return null
		val content = obj.get("content")?.asString ?: return null
		val timestamp = obj.get("timestamp")?.asString
		return EntryIdentity(role, content, timestamp)
	}

	private fun sanitizeForFilename(input: String): String {
		val sanitized = input.replace(Regex("[^A-Za-z0-9._-]"), "_")
		return sanitized.ifEmpty { "_" }
	}
}
