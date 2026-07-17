package ai.jolli.jollimemory.core

import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.time.Instant

class ActiveSessionAggregatorTest {

	@TempDir
	lateinit var tempDir: File

	/**
	 * Isolated home so source discoverers that scan the user's home directory
	 * (Codex's `~/.codex/sessions`, Gemini, OpenCode, …) see an empty tree
	 * instead of the real machine's sessions. Without this, a developer with a
	 * recent Codex session would have it leak into every aggregator assertion.
	 */
	@TempDir
	lateinit var homeDir: File

	private val cwd get() = tempDir.absolutePath

	private val HOUR = 3_600_000L
	private val DAY = 24 * HOUR

	/**
	 * Hermetic isolation. The aggregator fans out to the Codex / Cursor / OpenCode
	 * discoverers, which scan machine-global session dirs derived from the home dir
	 * (~/.codex/sessions, ~/Library/Application Support/Cursor, ~/.local/share/opencode).
	 * Injecting a HookEnv whose userHome is an empty temp dir (and whose getenv returns
	 * null for XDG_DATA_HOME) makes those sources find nothing, so assertions see only
	 * the SessionTracker sessions this test registers.
	 */
	private fun env(): HookEnv = fakeHookEnv(userHome = homeDir, userDir = tempDir)

	@BeforeEach
	fun setUp() {
		File(tempDir, ".jolli/jollimemory").mkdirs()
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

			val result = ActiveSessionAggregator.listActiveConversationsWithDiagnostics(cwd, 2 * DAY, env())
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

			val result = ActiveSessionAggregator.listActiveConversations(cwd, 2 * DAY, env())
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

			val result = ActiveSessionAggregator.listActiveConversations(cwd, 2 * DAY, env())
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

			val result = ActiveSessionAggregator.listActiveConversations(cwd, 2 * DAY, env())
			result.map { it.sessionId } shouldBe listOf("a", "b", "c")
		}
	}

	// ── Diagnostics ─────────────────────────────────────────────────────

	@Nested
	inner class Diagnostics {
		@Test
		fun `returns empty items and no failed sources when no sessions exist`() {
			val result = ActiveSessionAggregator.listActiveConversationsWithDiagnostics(cwd, 2 * DAY, env())
			result.items.shouldBeEmpty()
			result.failedSources.shouldBeEmpty()
		}
	}
}
