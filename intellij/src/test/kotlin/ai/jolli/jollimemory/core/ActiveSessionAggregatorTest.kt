package ai.jolli.jollimemory.core

import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.time.Instant

class ActiveSessionAggregatorTest {

	@TempDir
	lateinit var tempDir: File

	private val cwd get() = tempDir.absolutePath

	private val HOUR = 3_600_000L
	private val DAY = 24 * HOUR

	private var originalHome: String? = null

	@BeforeEach
	fun setUp() {
		File(tempDir, ".jolli/jollimemory").mkdirs()
		// Hermetic isolation. The aggregator fans out to the Codex / Cursor / OpenCode
		// discoverers, which scan machine-global session dirs derived from `user.home`
		// (~/.codex/sessions, ~/Library/Application Support/Cursor, ~/.local/share/opencode)
		// — they ignore the `cwd` temp dir. Without this, real sessions on the developer's
		// machine pollute the assertions (and opening the real SQLite DBs leaks JDBC
		// threads onto the next test class). Point user.home at an empty temp dir so those
		// sources find nothing; the assertions then see only the SessionTracker sessions
		// this test registers. Mirrors CursorSupportTest / VscodeWorkspaceLocatorTest.
		// (OpenCode also honors XDG_DATA_HOME; this assumes it is unset, as on CI.)
		originalHome = System.getProperty("user.home")
		System.setProperty("user.home", File(tempDir, "home").apply { mkdirs() }.absolutePath)
	}

	@AfterEach
	fun tearDown() {
		originalHome?.let { System.setProperty("user.home", it) } ?: System.clearProperty("user.home")
	}

	private fun iso(offsetMs: Long): String =
		Instant.ofEpochMilli(System.currentTimeMillis() + offsetMs).toString()

	private fun writeTranscript(name: String): String {
		val file = File(tempDir, name)
		file.writeText(
			"""{"type":"user","message":{"role":"user","content":"hi"}}""" + "\n" +
			"""{"type":"assistant","message":{"role":"assistant","content":"hello"}}""" + "\n",
		)
		return file.absolutePath
	}

	private fun registerSession(
		sessionId: String,
		transcriptPath: String,
		updatedAt: String,
		source: TranscriptSource? = null,
	) {
		SessionTracker.saveSession(
			SessionInfo(sessionId, transcriptPath, updatedAt, source),
			cwd,
		)
	}

	// ── Recency filter ──────────────────────────────────────────────────

	@Nested
	inner class RecencyFilter {
		@Test
		fun `filters sessions older than window`() {
			val path = writeTranscript("t1.jsonl")
			registerSession("fresh", path, iso(-HOUR))
			registerSession("old", path, iso(-3 * DAY))

			val result = ActiveSessionAggregator.listActiveConversationsWithDiagnostics(cwd, 2 * DAY)
			result.items.map { it.sessionId } shouldBe listOf("fresh")
		}
	}

	// ── Deduplication ───────────────────────────────────────────────────

	@Nested
	inner class Deduplication {
		@Test
		fun `deduplicates by source and sessionId, keeping most recent`() {
			val path = writeTranscript("t1.jsonl")
			// Save same sessionId twice with different timestamps
			registerSession("s1", path, iso(-2 * HOUR))
			registerSession("s1", path, iso(-HOUR))

			val result = ActiveSessionAggregator.listActiveConversations(cwd, 2 * DAY)
			result shouldHaveSize 1
		}
	}

	// ── Hidden sessions ─────────────────────────────────────────────────

	@Nested
	inner class HiddenSessions {
		@Test
		fun `hidden sessions are filtered out`() {
			val path = writeTranscript("t1.jsonl")
			val updatedAt = iso(-HOUR)
			registerSession("s1", path, updatedAt)

			// Hide it before its last update
			HiddenConversationsStore.hideConversation(cwd, TranscriptSource.claude, "s1")

			val result = ActiveSessionAggregator.listActiveConversations(cwd, 2 * DAY)
			result.shouldBeEmpty()
		}
	}

	// ── Sort order ──────────────────────────────────────────────────────

	@Nested
	inner class SortOrder {
		@Test
		fun `sorts by updatedAt descending, sessionId ascending for ties`() {
			val path = writeTranscript("t1.jsonl")
			val sameTime = iso(-HOUR)
			registerSession("b", path, sameTime)
			registerSession("a", path, sameTime)
			registerSession("c", path, iso(-2 * HOUR))

			val result = ActiveSessionAggregator.listActiveConversations(cwd, 2 * DAY)
			result.map { it.sessionId } shouldBe listOf("a", "b", "c")
		}
	}

	// ── Diagnostics ─────────────────────────────────────────────────────

	@Nested
	inner class Diagnostics {
		@Test
		fun `returns empty items and no failed sources when no sessions exist`() {
			val result = ActiveSessionAggregator.listActiveConversationsWithDiagnostics(cwd, 2 * DAY)
			result.items.shouldBeEmpty()
			result.failedSources.shouldBeEmpty()
		}
	}
}
