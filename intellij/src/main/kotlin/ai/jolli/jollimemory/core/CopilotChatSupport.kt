package ai.jolli.jollimemory.core

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File
import java.time.Instant

/**
 * Copilot Chat Support — session discovery and transcript reading for VS Code's
 * Copilot Chat panel (separate from the standalone CLI terminal, which lives in
 * [CopilotSupport]).
 *
 * Two on-disk shapes are covered by this single source because they're both
 * "New Chat" sessions in the VS Code chat panel — the difference is which model
 * the user picked:
 *
 *   Scan A — chat panel with copilotcli-backend models:
 *     ~/.copilot/session-state/<sid>/events.jsonl
 *     Gated by `vscode.metadata.json.workspaceFolder.folderPath` == projectDir.
 *
 *   Scan B — chat panel with non-copilotcli-backend (other-vendor) models:
 *     <userDataDir>/User/workspaceStorage/<wsHash>/chatSessions/<sid>.jsonl
 *     wsHash resolved via VscodeWorkspaceLocator from projectDir.
 *
 * Sessions older than 48 h are excluded (matches every other discovery-based
 * source). The deprecated `.json` snapshot variant of Scan B is explicitly NOT
 * read — see the spec.
 *
 * Kotlin port of `cli/src/core/{CopilotChatDetector,CopilotChatSessionDiscoverer,CopilotChatTranscriptReader}.ts`.
 */
object CopilotChatSupport {

	private val log = JmLogger.create("CopilotChatSupport")
	private const val SESSION_STALE_MS = 48 * 60 * 60 * 1000L

	/** Returns vscode's `globalStorage/github.copilot-chat` directory path. */
	fun getCopilotChatStorageDir(env: HookEnv = HookEnv()): String =
		getVscodeUserDataDir(VscodeFlavor.Code, env) + File.separator + "User" +
			File.separator + "globalStorage" + File.separator + "github.copilot-chat"

	/** Returns `~/.copilot/session-state` directory path (Copilot CLI agent backend). */
	fun getCopilotCliSessionStateDir(env: HookEnv = HookEnv()): String =
		env.userHome.path + File.separator + ".copilot" + File.separator + "session-state"

	/**
	 * Returns true when either of the two known Copilot Chat data roots exists
	 * as a directory.
	 */
	fun isCopilotChatInstalled(env: HookEnv = HookEnv()): Boolean =
		File(getCopilotChatStorageDir(env)).isDirectory || File(getCopilotCliSessionStateDir(env)).isDirectory

	/**
	 * Runs Scan A then Scan B; concatenates sessions; returns the first error
	 * encountered (subsequent are debug-logged).
	 */
	fun discoverSessions(projectDir: String, env: HookEnv = HookEnv()): CopilotChatScanResult {
		val a = scanSessionState(projectDir, env)
		val b = scanChatSessions(projectDir, env)
		val sessions = a.sessions + b.sessions
		val error = a.error ?: b.error
		if (a.error != null && b.error != null) {
			log.debug("Both Copilot Chat scans errored; reporting Scan A, dropped Scan B: %s", b.error.message)
		}
		if (sessions.isNotEmpty()) {
			log.info("Discovered %d Copilot Chat session(s) for %s", sessions.size, projectDir)
		}
		return CopilotChatScanResult(sessions, error)
	}

	/**
	 * Front door for Copilot Chat transcript reading. Dispatches to one of two
	 * sub-readers based on the trailing path segments of [transcriptPath]:
	 *
	 *   ".../session-state/<sid>/events.jsonl"  → [readEventsJsonl]
	 *   ".../chatSessions/<sid>.jsonl"          → [readPatchLog]
	 *
	 * Throws on an unrecognized path — the discoverer should never emit anything
	 * else, so this is a defense-in-depth invariant.
	 */
	fun readTranscript(
		transcriptPath: String,
		cursor: TranscriptCursor?,
		beforeTimestamp: String? = null,
	): TranscriptReadResult {
		val norm = transcriptPath.replace('\\', '/')
		return when {
			Regex("/\\.copilot/session-state/[^/]+/events\\.jsonl$").containsMatchIn(norm) ->
				readEventsJsonl(transcriptPath, cursor, beforeTimestamp)
			Regex("/chatSessions/[^/]+\\.jsonl$").containsMatchIn(norm) ->
				readPatchLog(transcriptPath, cursor, beforeTimestamp)
			else -> throw IllegalArgumentException(
				"Copilot Chat reader: unrecognized transcriptPath pattern: $transcriptPath"
			)
		}
	}

	// ── Scan A: ~/.copilot/session-state/<sid>/events.jsonl ────────────────

	private fun scanSessionState(projectDir: String, env: HookEnv): CopilotChatScanResult {
		val root = File(getCopilotCliSessionStateDir(env))
		if (!root.isDirectory) return CopilotChatScanResult(emptyList())

		val cutoffMs = System.currentTimeMillis() - SESSION_STALE_MS
		val target = normalizePathForMatch(projectDir, env)
		val sessions = mutableListOf<SessionInfo>()

		val entries = root.listFiles() ?: return CopilotChatScanResult(
			emptyList(),
			CopilotChatScanError("fs", "readdir returned null for ${root.path}"),
		)

		for (sessionDir in entries) {
			if (!sessionDir.isDirectory) continue
			val sid = sessionDir.name
			val metaFile = File(sessionDir, "vscode.metadata.json")
			val eventsFile = File(sessionDir, "events.jsonl")

			val folderPath = try {
				JsonParser.parseString(metaFile.readText()).asJsonObject
					.getAsJsonObject("workspaceFolder")
					?.get("folderPath")?.takeIf { it.isJsonPrimitive }?.asString
			} catch (_: Exception) {
				log.debug("Skipping %s: vscode.metadata.json read/parse failed", sid)
				continue
			}
			if (folderPath.isNullOrEmpty()) continue
			if (normalizePathForMatch(folderPath, env) != target) continue

			if (!eventsFile.isFile) continue
			val mtimeMs = eventsFile.lastModified()
			if (mtimeMs < cutoffMs) continue

			sessions.add(SessionInfo(
				sessionId = sid,
				transcriptPath = eventsFile.absolutePath,
				updatedAt = Instant.ofEpochMilli(mtimeMs).toString(),
				source = TranscriptSource.`copilot-chat`,
			))
		}
		return CopilotChatScanResult(sessions)
	}

	// ── Scan B: <wsHash>/chatSessions/<sid>.jsonl ──────────────────────────

	private fun scanChatSessions(projectDir: String, env: HookEnv): CopilotChatScanResult {
		val wsHash = findVscodeWorkspaceHash(VscodeFlavor.Code, projectDir, env) ?: run {
			log.debug("No vscode workspace matched %s", projectDir)
			return CopilotChatScanResult(emptyList())
		}
		val dir = File(
			getVscodeWorkspaceStorageDir(VscodeFlavor.Code, env) + File.separator + wsHash + File.separator + "chatSessions"
		)
		if (!dir.isDirectory) return CopilotChatScanResult(emptyList())

		val cutoffMs = System.currentTimeMillis() - SESSION_STALE_MS
		val entries = dir.listFiles() ?: return CopilotChatScanResult(
			emptyList(),
			CopilotChatScanError("fs", "readdir returned null for ${dir.path}"),
		)

		val sessions = mutableListOf<SessionInfo>()
		for (file in entries) {
			val name = file.name
			if (!name.endsWith(".jsonl")) continue // skip .json snapshots and other suffixes
			val mtimeMs = file.lastModified()
			if (mtimeMs < cutoffMs) continue
			sessions.add(SessionInfo(
				sessionId = name.removeSuffix(".jsonl"),
				transcriptPath = file.absolutePath,
				updatedAt = Instant.ofEpochMilli(mtimeMs).toString(),
				source = TranscriptSource.`copilot-chat`,
			))
		}
		return CopilotChatScanResult(sessions)
	}

	// ── Reader: events.jsonl (line-streamed) ───────────────────────────────

	private fun readEventsJsonl(
		transcriptPath: String,
		cursor: TranscriptCursor?,
		beforeTimestamp: String?,
	): TranscriptReadResult {
		val startLine = cursor?.lineNumber ?: 0
		val entries = mutableListOf<TranscriptEntry>()
		var currentLine = 0

		// Collect to a list so the loop runs outside the inline `useLines` lambda —
		// non-local break/continue inside an inline-lambda nested loop requires
		// Kotlin 2.2+. Event logs are bounded in size, so the memory cost is fine.
		val allLines = File(transcriptPath).bufferedReader(Charsets.UTF_8).useLines { it.toList() }
		for (rawLine in allLines) {
			currentLine++
			if (currentLine <= startLine) continue

			val evt = try {
				JsonParser.parseString(rawLine).asJsonObject
			} catch (_: Exception) {
				// skip malformed line, cursor still advances
				continue
			}

			val timestamp = evt.get("timestamp")?.takeIf { it.isJsonPrimitive }?.asString
			// beforeTimestamp gate: ISO 8601 timestamps are lex-sortable, so string
			// comparison is sufficient here. Stop without consuming this line so the
			// next read picks it up within a wider cutoff window.
			if (beforeTimestamp != null && timestamp != null && timestamp > beforeTimestamp) {
				currentLine-- // do not consume this line
				break
			}

			val type = evt.get("type")?.takeIf { it.isJsonPrimitive }?.asString ?: continue
			val content = evt.getAsJsonObject("data")
				?.get("content")?.takeIf { it.isJsonPrimitive }?.asString
			if (content.isNullOrEmpty()) continue

			when (type) {
				"user.message" -> entries.add(TranscriptEntry("human", content, timestamp))
				"assistant.message" -> entries.add(TranscriptEntry("assistant", content, timestamp))
			}
		}

		val mtimeMs = File(transcriptPath).lastModified()
		val updatedAt = Instant.ofEpochMilli(mtimeMs).toString()
		return TranscriptReadResult(
			entries = entries,
			newCursor = TranscriptCursor(transcriptPath, currentLine, updatedAt),
			totalLinesRead = (currentLine - startLine).coerceAtLeast(0),
		)
	}

	// ── Reader: chatSessions/<sid>.jsonl (patch log) ───────────────────────

	private fun readPatchLog(
		transcriptPath: String,
		cursor: TranscriptCursor?,
		beforeTimestamp: String?,
	): TranscriptReadResult {
		val fromIdx = cursor?.lineNumber ?: 0
		val file = File(transcriptPath)
		val raw = try {
			file.readText(Charsets.UTF_8)
		} catch (e: Exception) {
			throw RuntimeException("Copilot Chat patch log read failed: ${e.message}", e)
		}

		val lines = raw.split('\n').filter { it.isNotEmpty() }
		val updatedAt = Instant.ofEpochMilli(file.lastModified()).toString()
		if (lines.isEmpty()) {
			return TranscriptReadResult(
				entries = emptyList(),
				newCursor = TranscriptCursor(transcriptPath, 0, updatedAt),
				totalLinesRead = 0,
			)
		}

		val doc = try {
			replayPatches(lines)
		} catch (e: Exception) {
			throw RuntimeException("Copilot Chat patch replay failed (parse): ${e.message}", e)
		}

		val requests = (doc as? JsonObject)?.getAsJsonArray("requests")
			?: throw RuntimeException("Copilot Chat patch replay failed (schema): requests is not an array")

		// Patch-log timestamps are numeric ms since epoch; compare in ms. A request
		// without a numeric timestamp is treated as before-cutoff.
		val cutoffMs = beforeTimestamp?.let { Instant.parse(it).toEpochMilli() } ?: Long.MAX_VALUE
		val entries = mutableListOf<TranscriptEntry>()
		var lastEmittedIdx = fromIdx

		for (i in fromIdx until requests.size()) {
			val req = requests[i] as? JsonObject
			if (req == null) {
				lastEmittedIdx = i + 1
				continue
			}
			val tsMs = req.get("timestamp")?.takeIf {
				it.isJsonPrimitive && it.asJsonPrimitive.isNumber
			}?.asLong
			if (tsMs != null && tsMs > cutoffMs) break

			// Convert numeric ms timestamp to ISO so emitted entries carry a stable
			// identity dimension — without this, two distinct turns whose user text
			// happens to match collapse under ConversationOverlayStore.sameIdentity.
			val tsIso = tsMs?.let { Instant.ofEpochMilli(it).toString() }

			val userText = req.getAsJsonObject("message")
				?.get("text")?.takeIf { it.isJsonPrimitive }?.asString
			if (!userText.isNullOrEmpty()) {
				entries.add(TranscriptEntry("human", userText, tsIso))
			}

			val responseArr = req.get("response") as? JsonArray
			val assistantText = if (responseArr != null) {
				val parts = mutableListOf<String>()
				for (chunk in responseArr) {
					val v = (chunk as? JsonObject)
						?.get("value")?.takeIf { it.isJsonPrimitive }?.asString
					if (!v.isNullOrEmpty()) parts.add(v)
				}
				parts.joinToString("")
			} else ""
			if (assistantText.isNotEmpty()) {
				entries.add(TranscriptEntry("assistant", assistantText, tsIso))
			}
			lastEmittedIdx = i + 1
		}

		return TranscriptReadResult(
			entries = entries,
			newCursor = TranscriptCursor(transcriptPath, lastEmittedIdx, updatedAt),
			totalLinesRead = lines.size,
		)
	}

	// ── Patch replay primitives ────────────────────────────────────────────

	/**
	 * Replays a JSONL patch log into a final document.
	 *
	 *   kind 0 → replace entire document with `v`
	 *   kind 1 → set `v` at path `k`
	 *   kind 2 → delete value at path `k`
	 *
	 * Unknown `kind` is logged and skipped (forward compatibility). JSON parse
	 * errors are propagated so the caller can distinguish "mid-write" from
	 * "structurally broken file".
	 *
	 * Exposed as `internal` so unit tests can drive the replay directly.
	 */
	internal fun replayPatches(lines: List<String>): JsonElement {
		var doc: JsonElement = JsonObject()
		for (rawLine in lines) {
			val evt = JsonParser.parseString(rawLine).asJsonObject
			when (val kind = evt.get("kind")?.takeIf { it.isJsonPrimitive }?.asInt) {
				0 -> doc = evt.get("v") ?: JsonObject()
				1 -> {
					val path = evt.getAsJsonArray("k") ?: continue
					val value = evt.get("v") ?: continue
					setAtPath(doc, path, value)
				}
				2 -> {
					val path = evt.getAsJsonArray("k") ?: continue
					deleteAtPath(doc, path)
				}
				else -> log.warn("Unknown patch kind %s — skipping", kind)
			}
		}
		return doc
	}

	/**
	 * Mutates [doc] in place by setting [value] at [path]. Creates intermediate
	 * objects/arrays as needed; the *next* segment's type decides the container
	 * shape (numeric segment → array, string segment → object).
	 */
	internal fun setAtPath(doc: JsonElement, path: JsonArray, value: JsonElement) {
		if (path.size() == 0) return // root replacement is replayPatches's job (kind 0)
		var cur: JsonElement = doc
		for (i in 0 until path.size() - 1) {
			val seg = path[i]
			val next = path[i + 1]
			cur = stepInto(cur, seg, createIfMissing = true, nextSeg = next) ?: return
		}
		assignAt(cur, path[path.size() - 1], value)
	}

	/**
	 * Mutates [doc] in place by removing the value at [path]. No-op if the path
	 * doesn't exist or is empty. For array elements, uses `remove(int)` so the
	 * array shifts (matching vscode's emitted semantics for pendingRequests cleanup).
	 */
	internal fun deleteAtPath(doc: JsonElement, path: JsonArray) {
		if (path.size() == 0) return
		var cur: JsonElement = doc
		for (i in 0 until path.size() - 1) {
			cur = stepInto(cur, path[i], createIfMissing = false, nextSeg = null) ?: return
		}
		val last = path[path.size() - 1]
		when (cur) {
			is JsonObject -> if (last.isJsonPrimitive) cur.remove(last.asString)
			is JsonArray -> if (last.isJsonPrimitive && last.asJsonPrimitive.isNumber) {
				val idx = last.asInt
				if (idx in 0 until cur.size()) cur.remove(idx)
			}
			else -> { /* unreachable for well-formed paths */ }
		}
	}

	/**
	 * Returns the child at [seg] inside [parent]; creates it on demand when
	 * [createIfMissing] is true (using [nextSeg]'s type to decide array vs object).
	 * Returns null when [createIfMissing] is false and the path doesn't exist —
	 * caller short-circuits via `?: return`.
	 */
	private fun stepInto(
		parent: JsonElement,
		seg: JsonElement,
		createIfMissing: Boolean,
		nextSeg: JsonElement?,
	): JsonElement? {
		return when (parent) {
			is JsonObject -> {
				val key = seg.asString
				val existing = parent.get(key)
				if (existing != null && !existing.isJsonNull) return existing
				if (!createIfMissing) return null
				val fresh: JsonElement = if (nextSeg?.isJsonPrimitive == true && nextSeg.asJsonPrimitive.isNumber) {
					JsonArray()
				} else JsonObject()
				parent.add(key, fresh)
				fresh
			}
			is JsonArray -> {
				val idx = seg.asInt
				val existing = if (idx in 0 until parent.size()) parent[idx] else null
				if (existing != null && !existing.isJsonNull) return existing
				if (!createIfMissing) return null
				val fresh: JsonElement = if (nextSeg?.isJsonPrimitive == true && nextSeg.asJsonPrimitive.isNumber) {
					JsonArray()
				} else JsonObject()
				while (parent.size() <= idx) parent.add(JsonObject())
				parent[idx] = fresh
				fresh
			}
			else -> null // path runs into a primitive; nothing we can step into
		}
	}

	/** Assigns [value] at the last segment of a path. */
	private fun assignAt(parent: JsonElement, seg: JsonElement, value: JsonElement) {
		when (parent) {
			is JsonObject -> parent.add(seg.asString, value)
			is JsonArray -> {
				val idx = seg.asInt
				while (parent.size() <= idx) parent.add(JsonObject())
				parent[idx] = value
			}
			else -> { /* cannot assign into a primitive; ignore */ }
		}
	}
}

// ── Public scan-error types ────────────────────────────────────────────────

/** Severity classification for Copilot Chat scan failures. */
data class CopilotChatScanError(
	/** "parse" | "fs" | "schema" | "unknown" — see CLI spec. */
	val kind: String,
	val message: String,
)

/** Result of a Copilot Chat session-discovery scan. */
data class CopilotChatScanResult(
	val sessions: List<SessionInfo>,
	val error: CopilotChatScanError? = null,
)
