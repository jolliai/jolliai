package ai.jolli.jollimemory.core

import com.google.gson.JsonParser
import java.io.File
import java.sql.DriverManager
import java.time.Instant

/**
 * OpenCode Support — session discovery and transcript reading.
 *
 * OpenCode stores all data in a global SQLite database at
 * ~/.local/share/opencode/opencode.db. Sessions are scoped to a project
 * via the `directory` column in the `session` table.
 *
 * Cursor design: all sessions share one DB file. To give each session its own
 * cursor key, we use a synthetic transcriptPath: "<globalDbPath>#<sessionId>".
 */
object OpenCodeSupport {

	private val log = JmLogger.create("OpenCodeSupport")

	/** Sessions older than 48 hours are considered stale (matches other sources). */
	private const val SESSION_STALE_MS = 48 * 60 * 60 * 1000L

	/** Returns the path to the global OpenCode database file. */
	fun getDbPath(): String {
		val xdgDataHome = System.getenv("XDG_DATA_HOME")
			?: (System.getProperty("user.home") + File.separator + ".local" + File.separator + "share")
		return xdgDataHome + File.separator + "opencode" + File.separator + "opencode.db"
	}

	/** Checks whether the OpenCode database exists. */
	fun isOpenCodeInstalled(): Boolean {
		return File(getDbPath()).isFile
	}

	/**
	 * Discovers OpenCode sessions relevant to the given project directory.
	 * Queries the global DB for recent sessions (within 48h) matching projectDir.
	 */
	fun discoverSessions(projectDir: String): List<SessionInfo> {
		val dbPath = getDbPath()
		val dbFile = File(dbPath)
		if (!dbFile.isFile) return emptyList()

		val cutoffMs = System.currentTimeMillis() - SESSION_STALE_MS
		val isWindows = System.getProperty("os.name").lowercase().contains("win")
		val isMac = System.getProperty("os.name").lowercase().contains("mac")
		val caseInsensitive = isWindows || isMac

		return try {
			withReadOnlyDb(dbPath) { conn ->
				val sql = buildString {
					append("SELECT id, title, time_created, time_updated FROM session WHERE ")
					if (caseInsensitive) {
						append("LOWER(directory) = LOWER(?)")
					} else {
						append("directory = ?")
					}
					append(" AND time_updated > ? ORDER BY time_updated DESC")
				}

				val sessions = mutableListOf<SessionInfo>()
				conn.prepareStatement(sql).use { stmt ->
					stmt.setString(1, projectDir)
					stmt.setLong(2, cutoffMs)
					val rs = stmt.executeQuery()
					while (rs.next()) {
						val id = rs.getString("id")
						val timeUpdated = rs.getLong("time_updated")
						sessions.add(SessionInfo(
							sessionId = id,
							transcriptPath = "$dbPath#$id",
							updatedAt = Instant.ofEpochMilli(timeUpdated).toString(),
							source = TranscriptSource.opencode,
						))
					}
				}
				log.info("Discovered %d OpenCode session(s) for %s", sessions.size, projectDir)
				sessions
			}
		} catch (e: Exception) {
			log.error("OpenCode scan failed: %s", e.message)
			emptyList()
		}
	}

	/**
	 * Reads messages from an OpenCode SQLite session and returns parsed transcript entries.
	 * Supports cursor-based resumption by tracking the count of messages already processed.
	 *
	 * @param transcriptPath Synthetic path: "<dbPath>#<sessionId>"
	 * @param cursor Optional cursor indicating how many messages were already processed
	 * @param beforeTimestamp Optional ISO 8601 cutoff for commit attribution
	 */
	fun readTranscript(
		transcriptPath: String,
		cursor: TranscriptCursor?,
		beforeTimestamp: String? = null,
	): TranscriptReadResult {
		val (dbPath, sessionId) = parseSyntheticPath(transcriptPath)
		val startIndex = cursor?.lineNumber ?: 0
		val cutoffTime = beforeTimestamp?.let { Instant.parse(it).toEpochMilli() }

		try {
			return withReadOnlyDb(dbPath) { conn ->
				// Query messages with their parts via JOIN
				val sql = """
					SELECT m.id as msg_id, m.data as msg_data, m.time_created,
					       p.data as part_data
					FROM message m
					LEFT JOIN part p ON p.message_id = m.id
					WHERE m.session_id = ?
					ORDER BY m.time_created ASC, p.time_created ASC
				""".trimIndent()

				// Group rows by message ID (preserving order)
				val messageOrder = mutableListOf<String>()
				val messageMap = mutableMapOf<String, MessageData>()

				conn.prepareStatement(sql).use { stmt ->
					stmt.setString(1, sessionId)
					val rs = stmt.executeQuery()
					while (rs.next()) {
						val msgId = rs.getString("msg_id")
						val msgData = rs.getString("msg_data")
						val timeCreated = rs.getLong("time_created")
						val partData = rs.getString("part_data")

						if (msgId !in messageMap) {
							messageMap[msgId] = MessageData(msgData, timeCreated, mutableListOf())
							messageOrder.add(msgId)
						}
						if (partData != null) {
							(messageMap[msgId]!!.parts as MutableList).add(partData)
						}
					}
				}

				// Skip already-processed messages (cursor-based incremental read)
				val newMessageIds = if (startIndex < messageOrder.size) {
					messageOrder.subList(startIndex, messageOrder.size)
				} else {
					emptyList()
				}

				val rawEntries = mutableListOf<TranscriptEntry>()
				var lastConsumedIndex = startIndex

				for (i in newMessageIds.indices) {
					val msg = messageMap[newMessageIds[i]]!!

					// Stop consuming when we hit messages after the cutoff
					if (cutoffTime != null && msg.timeCreated > cutoffTime) {
						break
					}

					val entry = parseOpenCodeMessage(msg.msgData, msg.parts, msg.timeCreated)
					if (entry != null) {
						rawEntries.add(entry)
					}
					lastConsumedIndex = startIndex + i + 1
				}

				val entries = TranscriptReader.mergeConsecutiveEntries(rawEntries)

				val newCursor = TranscriptCursor(
					transcriptPath = transcriptPath,
					lineNumber = if (beforeTimestamp != null) lastConsumedIndex else messageOrder.size,
					updatedAt = Instant.now().toString(),
				)

				val totalLinesRead = lastConsumedIndex - startIndex
				log.info(
					"Read OpenCode session %s: %d new messages, %d entries extracted (index %d→%d)",
					sessionId.take(8), totalLinesRead, entries.size, startIndex, newCursor.lineNumber,
				)

				TranscriptReadResult(entries, newCursor, totalLinesRead)
			}
		} catch (e: Exception) {
			log.error("Failed to read OpenCode session %s: %s", sessionId.take(8), e.message)
			throw RuntimeException("Cannot read OpenCode session: $sessionId")
		}
	}

	// ── Internal helpers ─────────────────────────────────────────────────────

	private data class MessageData(
		val msgData: String,
		val timeCreated: Long,
		val parts: List<String>,
	)

	/**
	 * Opens a read-only JDBC connection to the SQLite database, runs the callback,
	 * and closes the connection.
	 */
	private fun <T> withReadOnlyDb(dbPath: String, block: (java.sql.Connection) -> T): T {
		val url = "jdbc:sqlite:file:$dbPath?mode=ro"
		val conn = DriverManager.getConnection(url)
		return try {
			block(conn)
		} finally {
			conn.close()
		}
	}

	/**
	 * Parses a synthetic transcript path into its DB path and session ID components.
	 * Format: "<dbPath>#<sessionId>"
	 */
	private fun parseSyntheticPath(transcriptPath: String): Pair<String, String> {
		val hashIndex = transcriptPath.lastIndexOf('#')
		if (hashIndex == -1 || hashIndex == 0 || hashIndex == transcriptPath.length - 1) {
			throw IllegalArgumentException("Invalid OpenCode transcript path: $transcriptPath")
		}
		return Pair(transcriptPath.substring(0, hashIndex), transcriptPath.substring(hashIndex + 1))
	}

	/**
	 * Parses a single OpenCode message into a TranscriptEntry.
	 * Extracts role from message.data JSON, text from part.data JSONs.
	 */
	private fun parseOpenCodeMessage(msgDataJson: String, partDataJsons: List<String>, createdAtMs: Long): TranscriptEntry? {
		val msgData = try {
			JsonParser.parseString(msgDataJson).asJsonObject
		} catch (_: Exception) {
			return null
		}

		val role = msgData.get("role")?.asString ?: return null
		val mappedRole = when (role) {
			"user" -> "human"
			"assistant" -> "assistant"
			else -> return null
		}

		val text = extractTextFromParts(partDataJsons) ?: return null
		val timestamp = Instant.ofEpochMilli(createdAtMs).toString()
		return TranscriptEntry(mappedRole, text, timestamp)
	}

	/**
	 * Extracts text content from OpenCode part data JSON strings.
	 * Only "text" type parts are extracted; tool, patch, reasoning, finish, etc. are skipped.
	 */
	private fun extractTextFromParts(partDataJsons: List<String>): String? {
		val textParts = mutableListOf<String>()

		for (json in partDataJsons) {
			val partData = try {
				JsonParser.parseString(json).asJsonObject
			} catch (_: Exception) {
				continue
			}

			if (partData.get("type")?.asString == "text") {
				val text = partData.get("text")?.asString?.trim()
				if (!text.isNullOrEmpty()) {
					textParts.add(text)
				}
			}
		}

		return if (textParts.isNotEmpty()) textParts.joinToString("\n") else null
	}
}
