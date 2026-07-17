package ai.jolli.jollimemory.core

import com.google.gson.JsonParser
import java.io.File
import java.time.Instant

/**
 * Cursor Support — session discovery and transcript reading for Cursor's
 * Composer AI agent.
 *
 * Cursor stores all Composer conversations in a *global* SQLite database at:
 *   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb  (macOS)
 *   ~/.config/Cursor/User/globalStorage/state.vscdb                      (Linux)
 *   %APPDATA%/Cursor/User/globalStorage/state.vscdb                      (Windows)
 *
 * Rows in the `cursorDiskKV` table are JSON BLOBs keyed by:
 *   composerData:<composerId>        — full composer metadata + bubble headers
 *   bubbleId:<composerId>:<bubbleId> — individual message blobs
 *
 * There is NO authoritative "this composer belongs to this workspace" pointer in
 * the global DB. Per-workspace `state.vscdb` files (under
 * User/workspaceStorage/<wsHash>/) DO contain a `composer.composerData` row in
 * their `ItemTable` with `lastFocusedComposerIds` and `selectedComposerIds`.
 *
 * Attribution algorithm (anchor-only with staleness cutoff):
 *   1. Workspace lookup — scan each <wsHash>/workspace.json for a `folder` URI
 *      that resolves to projectDir. Stop at the first match.
 *   2. Anchor extraction — read the per-workspace state.vscdb and union the two
 *      pointer arrays (`lastFocusedComposerIds` + `selectedComposerIds`).
 *   3. Filter — include only anchored composers whose `lastUpdatedAt` is within
 *      the last 48 h. Non-anchored composers are never included, preventing
 *      cross-project transcript contamination on multi-repo machines.
 *
 * Synthetic transcript path: "<globalDbPath>#<composerId>" (matches OpenCode).
 *
 * Kotlin port of `cli/src/core/{CursorDetector,CursorSessionDiscoverer,CursorTranscriptReader,VscodeWorkspaceLocator}.ts`.
 */
object CursorSupport {

	private val log = JmLogger.create("CursorSupport")

	/** Sessions older than 48 hours are considered stale (matches other sources). */
	private const val SESSION_STALE_MS = 48 * 60 * 60 * 1000L

	/** Cursor bubble.type → transcript role. Other values (system messages, tool calls) are skipped. */
	private val BUBBLE_TYPE_TO_ROLE = mapOf(1 to "human", 2 to "assistant")

	/** Returns the path to Cursor's global SQLite database. */
	fun getGlobalDbPath(env: HookEnv = HookEnv()): String =
		getVscodeUserDataDir(VscodeFlavor.Cursor, env) + File.separator + "User" +
			File.separator + "globalStorage" + File.separator + "state.vscdb"

	/** Checks whether Cursor's global database file exists. */
	fun isCursorInstalled(env: HookEnv = HookEnv()): Boolean {
		val dbPath = getGlobalDbPath(env)
		val exists = File(dbPath).isFile
		return exists
	}

	/**
	 * Lightweight DB health check — opens the database and runs a trivial query
	 * to detect locked/corrupt/permission errors without scanning all rows.
	 */
	fun checkDbHealth(env: HookEnv = HookEnv()): SqliteScanError? {
		val dbPath = getGlobalDbPath(env)
		if (!File(dbPath).isFile) return null
		return try {
			withReadOnlyDb(dbPath) { conn ->
				conn.prepareStatement("SELECT 1 FROM cursorDiskKV LIMIT 1").use { it.executeQuery() }
			}
			null
		} catch (e: Exception) {
			classifyScanError(e)
		}
	}

	/**
	 * Discovers Cursor Composer sessions relevant to the given project directory.
	 * Uses the anchor-only algorithm with staleness cutoff; see class kdoc for details.
	 */
	fun discoverSessions(projectDir: String, env: HookEnv = HookEnv()): ScanResult {
		val globalDbPath = getGlobalDbPath(env)
		val globalDbFile = File(globalDbPath)
		if (!globalDbFile.isFile) return ScanResult(emptyList())

		// Step 1: Workspace lookup
		val wsHash = findVscodeWorkspaceHash(VscodeFlavor.Cursor, projectDir, env)
		if (wsHash == null) {
			log.debug("No Cursor workspace found matching %s", projectDir)
			return ScanResult(emptyList())
		}

		// Step 2: Anchor extraction (never throws — workspace-level failure degrades gracefully)
		val anchorIds = readAnchorComposerIds(wsHash, env)
		val anchorSet = anchorIds.toHashSet()

		// Step 3 + 4: Time-window scan + union/dedupe on the global DB
		val cutoffMs = System.currentTimeMillis() - SESSION_STALE_MS

		return try {
			withReadOnlyDb(globalDbPath) { conn ->
				val sessions = mutableListOf<SessionInfo>()
				val seenIds = HashSet<String>()

				conn.prepareStatement("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").use { stmt ->
					val rs = stmt.executeQuery()
					while (rs.next()) {
						val key = rs.getString("key")
						val value = rs.getString("value") ?: continue

						val parsed = try {
							JsonParser.parseString(value).asJsonObject
						} catch (_: Exception) {
							log.warn("Skipping Cursor composer row %s: invalid JSON", key)
							continue
						}

						val composerId = parsed.get("composerId")?.takeIf { it.isJsonPrimitive }?.asString
						if (composerId == null) {
							log.warn("Skipping Cursor composer row %s: missing composerId", key)
							continue
						}

						val lastUpdatedAtElem = parsed.get("lastUpdatedAt")
						val lastUpdatedAt = if (lastUpdatedAtElem?.isJsonPrimitive == true &&
							lastUpdatedAtElem.asJsonPrimitive.isNumber
						) {
							lastUpdatedAtElem.asDouble.let { if (it.isFinite()) it.toLong() else null }
						} else null

						if (lastUpdatedAt == null) {
							if (anchorSet.contains(composerId)) {
								log.warn("Skipping Cursor composer %s: non-finite lastUpdatedAt", composerId)
							}
							continue
						}

						if (!anchorSet.contains(composerId)) continue
						if (lastUpdatedAt < cutoffMs) continue

						if (!seenIds.add(composerId)) continue

						sessions.add(SessionInfo(
							sessionId = composerId,
							transcriptPath = "$globalDbPath#$composerId",
							updatedAt = Instant.ofEpochMilli(lastUpdatedAt).toString(),
							source = TranscriptSource.cursor,
						))
					}
				}

				log.info("Discovered %d Cursor session(s) for %s", sessions.size, projectDir)
				ScanResult(sessions)
			}
		} catch (e: Exception) {
			val scanError = classifyScanError(e)
			log.error("Cursor scan failed (%s): %s", scanError.kind, scanError.message)
			ScanResult(emptyList(), scanError)
		}
	}

	/**
	 * Reads messages from a Cursor Composer session and returns parsed transcript entries.
	 * Supports cursor-based resumption: `cursor.lineNumber` tracks the count of bubbles
	 * already processed.
	 *
	 * @param transcriptPath synthetic path: "<dbPath>#<composerId>"
	 * @param cursor optional cursor indicating how many bubbles were already processed
	 * @param beforeTimestamp optional ISO 8601 cutoff for commit attribution
	 */
	fun readTranscript(
		transcriptPath: String,
		cursor: TranscriptCursor?,
		beforeTimestamp: String? = null,
	): TranscriptReadResult {
		val (dbPath, composerId) = parseSyntheticPath(transcriptPath)
		val startIndex = cursor?.lineNumber ?: 0
		val cutoffTime = beforeTimestamp?.let { Instant.parse(it).toEpochMilli() }

		try {
			return withReadOnlyDb(dbPath) { conn ->
				// Load the composer index — fullConversationHeadersOnly is an ordered list of bubbles
				val composerJson = conn.prepareStatement(
					"SELECT value FROM cursorDiskKV WHERE key = ? LIMIT 1"
				).use { stmt ->
					stmt.setString(1, "composerData:$composerId")
					val rs = stmt.executeQuery()
					if (rs.next()) rs.getString("value") else null
				} ?: throw RuntimeException("Composer $composerId not found in database")

				val composer = try {
					JsonParser.parseString(composerJson).asJsonObject
				} catch (_: Exception) {
					throw RuntimeException("Failed to parse composerData JSON for $composerId")
				}

				val headers = composer.getAsJsonArray("fullConversationHeadersOnly") ?: com.google.gson.JsonArray()
				val totalBubbles = headers.size()

				val rawEntries = mutableListOf<TranscriptEntry>()
				var lastConsumedIndex = startIndex
				var stoppedAtCutoff = false

				val bubbleStmt = conn.prepareStatement("SELECT value FROM cursorDiskKV WHERE key = ? LIMIT 1")
				bubbleStmt.use { stmt ->
					for (i in startIndex until totalBubbles) {
						if (stoppedAtCutoff) break
						val headerElem = headers.get(i)
						if (headerElem == null || !headerElem.isJsonObject) {
							lastConsumedIndex = i + 1
							continue
						}
						val header = headerElem.asJsonObject
						val bubbleId = header.get("bubbleId")?.takeIf { it.isJsonPrimitive }?.asString
						val headerType = header.get("type")?.takeIf {
							it.isJsonPrimitive && it.asJsonPrimitive.isNumber
						}?.asInt

						if (bubbleId == null) {
							lastConsumedIndex = i + 1
							continue
						}

						stmt.clearParameters()
						stmt.setString(1, "bubbleId:$composerId:$bubbleId")
						val rs = stmt.executeQuery()
						val bubbleJson = if (rs.next()) rs.getString("value") else null
						if (bubbleJson == null) {
							// Bubble missing — advance index but produce no entry
							lastConsumedIndex = i + 1
							continue
						}

						val bubble = try {
							JsonParser.parseString(bubbleJson).asJsonObject
						} catch (_: Exception) {
							log.debug("Failed to parse bubble JSON for %s:%s", composerId, bubbleId)
							lastConsumedIndex = i + 1
							continue
						}

						val timestamp = bubble.get("createdAt")?.takeIf { it.isJsonPrimitive }?.asString

						if (cutoffTime != null && timestamp != null) {
							val bubbleTime = try { Instant.parse(timestamp).toEpochMilli() } catch (_: Exception) { null }
							if (bubbleTime != null && bubbleTime > cutoffTime) {
								stoppedAtCutoff = true
								continue
							}
						}

						val bubbleType = bubble.get("type")?.takeIf {
							it.isJsonPrimitive && it.asJsonPrimitive.isNumber
						}?.asInt ?: headerType
						val role = bubbleType?.let { BUBBLE_TYPE_TO_ROLE[it] }
						val text = bubble.get("text")?.takeIf { it.isJsonPrimitive }?.asString?.trim() ?: ""

						if (role != null && text.isNotEmpty()) {
							rawEntries.add(TranscriptEntry(role, text, timestamp))
						}

						lastConsumedIndex = i + 1
					}
				}

				val entries = TranscriptReader.mergeConsecutiveEntries(rawEntries)

				// When beforeTimestamp is set, advance cursor only to the last consumed bubble.
				// Without beforeTimestamp, advance to end for backward compatibility.
				val newCursor = TranscriptCursor(
					transcriptPath = transcriptPath,
					lineNumber = if (beforeTimestamp != null) lastConsumedIndex else totalBubbles,
					updatedAt = Instant.now().toString(),
				)

				val totalLinesRead = lastConsumedIndex - startIndex
				log.info(
					"Read Cursor session %s: %d new bubbles, %d entries extracted (index %d→%d)",
					composerId.take(8), totalLinesRead, entries.size, startIndex, newCursor.lineNumber,
				)

				TranscriptReadResult(entries, newCursor, totalLinesRead)
			}
		} catch (e: Exception) {
			log.error("Failed to read Cursor session %s: %s", composerId.take(8), e.message)
			throw RuntimeException("Cannot read Cursor session: $composerId")
		}
	}

	// ── Internal helpers ─────────────────────────────────────────────────────

	/**
	 * Reads the per-workspace state.vscdb and extracts anchor composer IDs from the
	 * `composer.composerData` row in ItemTable. Returns an empty list on any failure —
	 * workspace-level errors do NOT abort the broader scan.
	 */
	private fun readAnchorComposerIds(wsHash: String, env: HookEnv): List<String> {
		val wsDbPath = getVscodeWorkspaceStorageDir(VscodeFlavor.Cursor, env) +
			File.separator + wsHash + File.separator + "state.vscdb"
		if (!File(wsDbPath).isFile) {
			log.debug("Cursor workspace DB not found at %s — skipping anchor extraction", wsDbPath)
			return emptyList()
		}

		return try {
			withReadOnlyDb(wsDbPath) { conn ->
				val value = conn.prepareStatement(
					"SELECT value FROM ItemTable WHERE key = 'composer.composerData' LIMIT 1"
				).use { stmt ->
					val rs = stmt.executeQuery()
					if (rs.next()) rs.getString("value") else null
				} ?: return@withReadOnlyDb emptyList()

				val parsed = try {
					JsonParser.parseString(value).asJsonObject
				} catch (_: Exception) {
					log.warn("Cursor workspace %s composer.composerData is not valid JSON", wsHash)
					return@withReadOnlyDb emptyList()
				}

				val lastFocused = parsed.getAsJsonArray("lastFocusedComposerIds")?.mapNotNull {
					it.takeIf(com.google.gson.JsonElement::isJsonPrimitive)?.asString
				}.orEmpty()
				val selected = parsed.getAsJsonArray("selectedComposerIds")?.mapNotNull {
					it.takeIf(com.google.gson.JsonElement::isJsonPrimitive)?.asString
				}.orEmpty()

				(lastFocused + selected).distinct()
			}
		} catch (e: Exception) {
			log.warn("Failed to read Cursor workspace anchor IDs from %s: %s", wsDbPath, e.message)
			emptyList()
		}
	}

}
