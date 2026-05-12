package ai.jolli.jollimemory.core

import org.sqlite.SQLiteException
import java.nio.file.AccessDeniedException
import java.sql.Connection
import java.sql.DriverManager

/**
 * SQLite Helpers — shared utilities for SQLite-backed transcript sources
 * (OpenCode, Cursor). Extracted from per-agent modules so additional agents
 * don't end up importing from a file named for an unrelated one.
 *
 * Kotlin port of `cli/src/core/SqliteHelpers.ts`.
 */

/**
 * Opens a read-only JDBC connection to the SQLite database, runs the callback,
 * and closes the connection. Connection is always closed even if the block throws.
 */
fun <T> withReadOnlyDb(dbPath: String, block: (Connection) -> T): T {
	// Explicitly load the SQLite JDBC driver — IntelliJ's plugin classloader
	// doesn't pick up META-INF/services/java.sql.Driver auto-registration.
	Class.forName("org.sqlite.JDBC")
	val url = "jdbc:sqlite:file:$dbPath?mode=ro"
	val conn = DriverManager.getConnection(url)
	return try {
		block(conn)
	} finally {
		conn.close()
	}
}

/**
 * Parses a synthetic transcript path "<dbPath>#<sessionId>" into its components.
 * Used by SQLite-backed sources where all sessions share one DB file; the
 * sessionId suffix gives each session its own cursor-registry key without
 * changing the cursors.json schema.
 *
 * Assumes session IDs never contain '#' (true for Cursor UUIDs and OpenCode ULIDs).
 */
fun parseSyntheticPath(transcriptPath: String): Pair<String, String> {
	val hashIndex = transcriptPath.lastIndexOf('#')
	if (hashIndex == -1 || hashIndex == 0 || hashIndex == transcriptPath.length - 1) {
		throw IllegalArgumentException("Invalid synthetic transcript path: $transcriptPath")
	}
	return Pair(transcriptPath.substring(0, hashIndex), transcriptPath.substring(hashIndex + 1))
}

/**
 * Severity classification for SQLite scan failures, surfaced to the Status panel
 * so users can distinguish a real failure from "zero sessions today".
 *
 * - `corrupt`    — SQLITE_CORRUPT / SQLITE_NOTADB. DB file unreadable.
 * - `locked`     — SQLITE_BUSY / SQLITE_LOCKED. Another process holds the lock
 *                  (Cursor itself is the usual culprit while it's running).
 * - `permission` — SQLITE_PERM / SQLITE_AUTH / SQLITE_CANTOPEN / file ACL denial.
 * - `schema`     — expected table or column missing. Likely upstream schema drift.
 * - `unknown`    — everything else; surface as a generic scan-failed warning.
 */
enum class SqliteScanErrorKind { corrupt, locked, permission, schema, unknown }

data class SqliteScanError(val kind: SqliteScanErrorKind, val message: String)

/**
 * Result of a session-discovery scan. [sessions] is empty when [error] is non-null
 * (real failure) and also when the scan succeeded but found nothing (legitimate
 * empty). UI inspects [error] to distinguish the two.
 */
data class ScanResult(val sessions: List<SessionInfo>, val error: SqliteScanError? = null)

/**
 * Maps a thrown error from a SQLite scan to a [SqliteScanError]. Prefers the
 * structured `resultCode` from xerial sqlite-jdbc; falls back to message
 * pattern-matching for wrapped or non-SQLiteException failures.
 */
fun classifyScanError(error: Throwable): SqliteScanError {
	val message = error.message ?: error::class.java.simpleName

	if (error is AccessDeniedException) {
		return SqliteScanError(SqliteScanErrorKind.permission, message)
	}
	if (error is SQLiteException) {
		val code = error.resultCode?.name ?: ""
		when {
			code.startsWith("SQLITE_CORRUPT") || code.startsWith("SQLITE_NOTADB") ->
				return SqliteScanError(SqliteScanErrorKind.corrupt, message)
			code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED") ->
				return SqliteScanError(SqliteScanErrorKind.locked, message)
			code.startsWith("SQLITE_PERM") || code.startsWith("SQLITE_AUTH") || code.startsWith("SQLITE_CANTOPEN") ->
				return SqliteScanError(SqliteScanErrorKind.permission, message)
		}
		if (message.contains("no such table", ignoreCase = true) ||
			message.contains("no such column", ignoreCase = true)
		) {
			return SqliteScanError(SqliteScanErrorKind.schema, message)
		}
	}

	return when {
		Regex("SQLITE_CORRUPT|SQLITE_NOTADB|file is not a database", RegexOption.IGNORE_CASE).containsMatchIn(message) ->
			SqliteScanError(SqliteScanErrorKind.corrupt, message)
		Regex("SQLITE_BUSY|SQLITE_LOCKED|database is locked", RegexOption.IGNORE_CASE).containsMatchIn(message) ->
			SqliteScanError(SqliteScanErrorKind.locked, message)
		Regex("no such table|no such column", RegexOption.IGNORE_CASE).containsMatchIn(message) ->
			SqliteScanError(SqliteScanErrorKind.schema, message)
		Regex("SQLITE_CANTOPEN|SQLITE_PERM|SQLITE_AUTH|unable to open|permission denied|access is denied", RegexOption.IGNORE_CASE).containsMatchIn(message) ->
			SqliteScanError(SqliteScanErrorKind.permission, message)
		else -> SqliteScanError(SqliteScanErrorKind.unknown, message)
	}
}
