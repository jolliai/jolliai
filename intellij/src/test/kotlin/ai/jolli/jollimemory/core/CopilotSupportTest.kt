package ai.jolli.jollimemory.core

import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.sql.Connection
import java.sql.DriverManager
import java.time.Instant

class CopilotSupportTest {

	/** Env pinned to macOS so platform-dependent branches are deterministic on any host. */
	private fun macEnv(home: File): HookEnv = fakeHookEnv(userHome = home, osName = "Mac OS X")

	/** Creates the ~/.copilot/session-store.db with Copilot's schema and seeded rows. */
	private fun createCopilotDb(home: File): File {
		val dbFile = File(home, ".copilot/session-store.db")
		dbFile.parentFile.mkdirs()
		DriverManager.getConnection("jdbc:sqlite:${dbFile.absolutePath}").use { conn ->
			conn.createStatement().use { st ->
				st.execute("""
					CREATE TABLE sessions (
						id TEXT PRIMARY KEY,
						cwd TEXT NOT NULL,
						repository TEXT,
						branch TEXT,
						host_type TEXT,
						summary TEXT,
						created_at TEXT,
						updated_at TEXT
					)
				""".trimIndent())
				st.execute("""
					CREATE TABLE turns (
						session_id TEXT NOT NULL,
						turn_index INTEGER NOT NULL,
						user_message TEXT,
						assistant_response TEXT,
						timestamp TEXT,
						PRIMARY KEY (session_id, turn_index)
					)
				""".trimIndent())
			}
		}
		return dbFile
	}

	private fun insertSession(
		dbFile: File,
		id: String,
		cwd: String,
		updatedAt: String,
		summary: String? = null,
	) {
		DriverManager.getConnection("jdbc:sqlite:${dbFile.absolutePath}").use { conn ->
			conn.prepareStatement(
				"INSERT INTO sessions(id, cwd, updated_at, summary) VALUES (?, ?, ?, ?)"
			).use { ps ->
				ps.setString(1, id)
				ps.setString(2, cwd)
				ps.setString(3, updatedAt)
				ps.setString(4, summary)
				ps.executeUpdate()
			}
		}
	}

	private fun insertTurn(
		dbFile: File,
		sessionId: String,
		turnIndex: Int,
		userMessage: String?,
		assistantResponse: String?,
		timestamp: String? = null,
	) {
		DriverManager.getConnection("jdbc:sqlite:${dbFile.absolutePath}").use { conn ->
			conn.prepareStatement(
				"INSERT INTO turns(session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?, ?, ?, ?, ?)"
			).use { ps ->
				ps.setString(1, sessionId)
				ps.setInt(2, turnIndex)
				ps.setString(3, userMessage)
				ps.setString(4, assistantResponse)
				ps.setString(5, timestamp)
				ps.executeUpdate()
			}
		}
	}

	@Nested
	inner class Detection {

		@Test
		fun `isCopilotInstalled false when DB missing`(@TempDir home: File) {
			CopilotSupport.isCopilotInstalled(macEnv(home)) shouldBe false
		}

		@Test
		fun `isCopilotInstalled true when DB present`(@TempDir home: File) {
			createCopilotDb(home)
			CopilotSupport.isCopilotInstalled(macEnv(home)) shouldBe true
		}
	}

	@Nested
	inner class DiscoverSessions {

		@Test
		fun `returns empty when DB missing`(@TempDir home: File, @TempDir projectDir: File) {
			val result = CopilotSupport.discoverSessions(projectDir.absolutePath, macEnv(home))
			result.sessions.shouldBeEmpty()
			result.error shouldBe null
		}

		@Test
		fun `finds session matching cwd`(@TempDir home: File, @TempDir projectDir: File) {
			val db = createCopilotDb(home)
			val recent = Instant.now().toString()
			insertSession(db, "s-1", projectDir.absolutePath, recent)

			val result = CopilotSupport.discoverSessions(projectDir.absolutePath, macEnv(home))
			result.sessions.shouldHaveSize(1)
			result.sessions[0].sessionId shouldBe "s-1"
			result.sessions[0].source shouldBe TranscriptSource.copilot
			result.sessions[0].transcriptPath shouldBe "${db.absolutePath}#s-1"
		}

		@Test
		fun `excludes sessions older than 48 hours`(@TempDir home: File, @TempDir projectDir: File) {
			val db = createCopilotDb(home)
			val old = Instant.now().minusSeconds(49 * 60 * 60).toString()
			insertSession(db, "stale", projectDir.absolutePath, old)
			CopilotSupport.discoverSessions(projectDir.absolutePath, macEnv(home)).sessions.shouldBeEmpty()
		}

		@Test
		fun `case-insensitive cwd match on darwin and win32`(@TempDir home: File, @TempDir projectDir: File) {
			val db = createCopilotDb(home)
			val recent = Instant.now().toString()
			// macEnv pins osName to macOS, so the case-insensitive SQL branch is
			// always taken: a stored cwd differing only by case must still match.
			insertSession(db, "s-1", projectDir.absolutePath.uppercase(), recent)

			val sessions = CopilotSupport.discoverSessions(projectDir.absolutePath, macEnv(home)).sessions
			sessions.shouldHaveSize(1)
		}

		@Test
		fun `skips sessions with unparseable updated_at`(@TempDir home: File, @TempDir projectDir: File) {
			val db = createCopilotDb(home)
			insertSession(db, "bad", projectDir.absolutePath, "not-a-date")
			CopilotSupport.discoverSessions(projectDir.absolutePath, macEnv(home)).sessions.shouldBeEmpty()
		}
	}

	@Nested
	inner class ReadTranscript {

		@Test
		fun `expands turn rows into human-assistant pairs`(@TempDir home: File, @TempDir projectDir: File) {
			val db = createCopilotDb(home)
			val recent = Instant.now().toString()
			insertSession(db, "s-1", projectDir.absolutePath, recent)
			insertTurn(db, "s-1", 0, "hello", "hi there", recent)
			insertTurn(db, "s-1", 1, "another q", "another a", recent)

			val result = CopilotSupport.readTranscript("${db.absolutePath}#s-1", null)
			result.entries.shouldHaveSize(4)
			result.entries[0].role shouldBe "human"
			result.entries[0].content shouldBe "hello"
			result.entries[1].role shouldBe "assistant"
			result.entries[2].role shouldBe "human"
			result.entries[3].role shouldBe "assistant"
		}

		@Test
		fun `skips empty messages`(@TempDir home: File, @TempDir projectDir: File) {
			val db = createCopilotDb(home)
			val recent = Instant.now().toString()
			insertSession(db, "s-1", projectDir.absolutePath, recent)
			insertTurn(db, "s-1", 0, "user only", null, recent)
			insertTurn(db, "s-1", 1, null, "assistant only", recent)
			insertTurn(db, "s-1", 2, "", "  ", recent)

			val result = CopilotSupport.readTranscript("${db.absolutePath}#s-1", null)
			result.entries.shouldHaveSize(2)
			result.entries[0].role shouldBe "human"
			result.entries[0].content shouldBe "user only"
			result.entries[1].role shouldBe "assistant"
			result.entries[1].content shouldBe "assistant only"
		}

		@Test
		fun `cursor resumption skips already-consumed turns`(@TempDir home: File, @TempDir projectDir: File) {
			val db = createCopilotDb(home)
			val recent = Instant.now().toString()
			insertSession(db, "s-1", projectDir.absolutePath, recent)
			insertTurn(db, "s-1", 0, "first", "ok", recent)
			insertTurn(db, "s-1", 1, "second", "yep", recent)

			val transcriptPath = "${db.absolutePath}#s-1"
			val cursor = TranscriptCursor(transcriptPath, 1, recent) // first turn already consumed
			val result = CopilotSupport.readTranscript(transcriptPath, cursor)
			result.entries.shouldHaveSize(2) // second turn → 2 entries
			result.entries[0].content shouldBe "second"
		}

		@Test
		fun `beforeTimestamp stops at first turn past cutoff`(@TempDir home: File, @TempDir projectDir: File) {
			val db = createCopilotDb(home)
			val base = Instant.parse("2026-01-01T00:00:00Z")
			insertSession(db, "s-1", projectDir.absolutePath, Instant.now().toString())
			insertTurn(db, "s-1", 0, "before", "ok", base.toString())
			insertTurn(db, "s-1", 1, "after", "no", base.plusSeconds(3600).toString())

			val result = CopilotSupport.readTranscript(
				"${db.absolutePath}#s-1",
				null,
				beforeTimestamp = base.plusSeconds(1800).toString(),
			)
			result.entries.shouldHaveSize(2) // only the "before" turn
			result.entries[0].content shouldBe "before"
		}

		@Test
		fun `throws on missing synthetic separator`(@TempDir home: File) {
			createCopilotDb(home)
			val ex = try {
				CopilotSupport.readTranscript("no-hash-here", null)
				null
			} catch (e: Exception) {
				e
			}
			ex.shouldNotBeNull()
		}
	}
}
