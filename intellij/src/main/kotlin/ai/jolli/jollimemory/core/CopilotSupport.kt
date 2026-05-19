package ai.jolli.jollimemory.core

import java.io.File
import java.time.Instant

/**
 * Copilot Support — session discovery and transcript reading for the GitHub
 * Copilot CLI (the standalone terminal binary, separate from the VS Code
 * Copilot Chat panel — that lives in [CopilotChatSupport]).
 *
 * Copilot CLI stores every session in a single SQLite database at:
 *   ~/.copilot/session-store.db
 *
 * Each `sessions` row carries its own `cwd`, so workspace attribution is exact —
 * no workspace-locator dance is needed here. The `turns` table holds one row
 * per conversation turn, with `user_message` and `assistant_response` as
 * separate columns; each row expands into two TranscriptEntry items.
 *
 * Synthetic transcript path: "<dbPath>#<sessionId>" (matches OpenCode / Cursor).
 *
 * Kotlin port of `cli/src/core/{CopilotDetector,CopilotSessionDiscoverer,CopilotTranscriptReader}.ts`.
 */
object CopilotSupport {

	private val log = JmLogger.create("CopilotSupport")

	/** Sessions older than 48 hours are considered stale (matches other sources). */
	private const val SESSION_STALE_MS = 48 * 60 * 60 * 1000L

	/** Returns the absolute path to Copilot CLI's session-store database. */
	fun getDbPath(): String =
		System.getProperty("user.home") + File.separator + ".copilot" + File.separator + "session-store.db"

	/** Returns true when the Copilot CLI session DB is present on disk. */
	fun isCopilotInstalled(): Boolean = File(getDbPath()).isFile

	/**
	 * Lightweight DB health check — opens the database and runs a trivial query
	 * to detect locked/corrupt/permission errors without scanning all rows.
	 */
	fun checkDbHealth(): SqliteScanError? {
		val dbPath = getDbPath()
		if (!File(dbPath).isFile) return null
		return try {
			withReadOnlyDb(dbPath) { conn ->
				conn.prepareStatement("SELECT 1 FROM sessions LIMIT 1").use { it.executeQuery() }
			}
			null
		} catch (e: Exception) {
			classifyScanError(e)
		}
	}

	/**
	 * Discovers Copilot CLI sessions relevant to the given project directory.
	 * Queries `sessions` by `cwd` (case-insensitive on darwin/win32) and applies
	 * the 48 h staleness cutoff in Kotlin (not SQL) because `updated_at` is TEXT —
	 * SQL `>` would be lexicographic and only correct if every row used canonical
	 * UTC ISO-8601. [Instant.parse] tolerates any format Java date parsing accepts.
	 */
	fun discoverSessions(projectDir: String): ScanResult {
		val dbPath = getDbPath()
		if (!File(dbPath).isFile) return ScanResult(emptyList())

		val cutoffMs = System.currentTimeMillis() - SESSION_STALE_MS
		val osName = System.getProperty("os.name").lowercase()
		val caseInsensitive = osName.contains("mac") || osName.contains("win")

		return try {
			withReadOnlyDb(dbPath) { conn ->
				val sql = buildString {
					append("SELECT id, summary, updated_at FROM sessions WHERE ")
					append(if (caseInsensitive) "LOWER(cwd) = LOWER(?)" else "cwd = ?")
					append(" ORDER BY updated_at DESC")
				}

				val sessions = mutableListOf<SessionInfo>()
				conn.prepareStatement(sql).use { stmt ->
					stmt.setString(1, projectDir)
					val rs = stmt.executeQuery()
					while (rs.next()) {
						val id = rs.getString("id")
						val updatedAtRaw = rs.getString("updated_at")
						val updatedAtMs = try {
							Instant.parse(updatedAtRaw).toEpochMilli()
						} catch (_: Exception) {
							log.warn("Skipping Copilot session %s: unparseable updated_at %s", id, updatedAtRaw)
							continue
						}
						if (updatedAtMs < cutoffMs) continue
						val title = rs.getString("summary")?.takeIf { it.isNotBlank() }
						sessions.add(SessionInfo(
							sessionId = id,
							transcriptPath = "$dbPath#$id",
							updatedAt = Instant.ofEpochMilli(updatedAtMs).toString(),
							source = TranscriptSource.copilot,
						))
						if (title != null) log.debug("Copilot session %s title: %s", id.take(8), title)
					}
				}
				log.info("Discovered %d Copilot session(s) for %s", sessions.size, projectDir)
				ScanResult(sessions)
			}
		} catch (e: Exception) {
			val scanError = classifyScanError(e)
			log.error("Copilot scan failed (%s): %s", scanError.kind, scanError.message)
			ScanResult(emptyList(), scanError)
		}
	}

	/**
	 * Reads turns from a Copilot CLI session and returns parsed transcript entries.
	 *
	 * Cursor's `lineNumber` tracks the count of fully-consumed turns (zero-based
	 * index into the ORDER BY turn_index result set). This is equivalent to
	 * `turn_index` while Copilot's UNIQUE(session_id, turn_index) constraint
	 * prevents gaps; if turns are ever deleted leaving holes, a value-based resume
	 * query would be needed instead.
	 *
	 * @param transcriptPath synthetic path: "<dbPath>#<sessionId>"
	 * @param cursor         optional cursor; lineNumber = turns already consumed
	 * @param beforeTimestamp optional ISO-8601 cutoff for commit attribution
	 */
	fun readTranscript(
		transcriptPath: String,
		cursor: TranscriptCursor?,
		beforeTimestamp: String? = null,
	): TranscriptReadResult {
		val (dbPath, sessionId) = parseSyntheticPath(transcriptPath)
		val startIndex = cursor?.lineNumber ?: 0
		val cutoffMs = beforeTimestamp?.let { Instant.parse(it).toEpochMilli() }

		try {
			return withReadOnlyDb(dbPath) { conn ->
				val rows = mutableListOf<TurnRow>()
				conn.prepareStatement(
					"SELECT turn_index, user_message, assistant_response, timestamp " +
						"FROM turns WHERE session_id = ? ORDER BY turn_index ASC"
				).use { stmt ->
					stmt.setString(1, sessionId)
					val rs = stmt.executeQuery()
					while (rs.next()) {
						rows.add(TurnRow(
							turnIndex = rs.getInt("turn_index"),
							userMessage = rs.getString("user_message"),
							assistantResponse = rs.getString("assistant_response"),
							timestamp = rs.getString("timestamp"),
						))
					}
				}

				val totalTurns = rows.size
				val newRows = if (startIndex < rows.size) rows.subList(startIndex, rows.size) else emptyList()

				val rawEntries = mutableListOf<TranscriptEntry>()
				var lastConsumedIndex = startIndex
				for (i in newRows.indices) {
					val r = newRows[i]
					if (cutoffMs != null && r.timestamp != null) {
						val ts = try { Instant.parse(r.timestamp).toEpochMilli() } catch (_: Exception) { null }
						if (ts != null && ts > cutoffMs) break
					}
					val tsIso = r.timestamp?.let {
						try { Instant.parse(it); it } catch (_: Exception) { null }
					}
					if (!r.userMessage.isNullOrBlank()) {
						rawEntries.add(TranscriptEntry("human", r.userMessage, tsIso))
					}
					if (!r.assistantResponse.isNullOrBlank()) {
						rawEntries.add(TranscriptEntry("assistant", r.assistantResponse, tsIso))
					}
					lastConsumedIndex = startIndex + i + 1
				}

				val entries = TranscriptReader.mergeConsecutiveEntries(rawEntries)
				val newCursor = TranscriptCursor(
					transcriptPath = transcriptPath,
					lineNumber = if (beforeTimestamp != null) lastConsumedIndex else totalTurns,
					updatedAt = Instant.now().toString(),
				)
				val totalLinesRead = lastConsumedIndex - startIndex
				log.info(
					"Read Copilot session %s: %d new turns, %d entries (index %d→%d)",
					sessionId.take(8), totalLinesRead, entries.size, startIndex, newCursor.lineNumber,
				)
				TranscriptReadResult(entries, newCursor, totalLinesRead)
			}
		} catch (e: Exception) {
			log.error("Failed to read Copilot session %s: %s", sessionId.take(8), e.message)
			throw RuntimeException("Cannot read Copilot session: $sessionId")
		}
	}

	private data class TurnRow(
		val turnIndex: Int,
		val userMessage: String?,
		val assistantResponse: String?,
		val timestamp: String?,
	)
}
