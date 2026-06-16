package ai.jolli.jollimemory.core.references

import ai.jolli.jollimemory.core.PlansRegistry
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.TranscriptSource
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.mockk.every
import io.mockk.mockkObject
import io.mockk.unmockkAll
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class TranscriptReferenceDiscoveryTest {

	@TempDir
	lateinit var tempDir: File

	private lateinit var cwd: String

	/** In-memory plans registry for tests (avoids real file I/O via SessionTracker). */
	private var plansRegistry = PlansRegistry()

	@BeforeEach
	fun setUp() {
		cwd = tempDir.absolutePath
		plansRegistry = PlansRegistry()

		mockkObject(SessionTracker)
		every { SessionTracker.acquireLock(any()) } returns true
		every { SessionTracker.releaseLock(any()) } returns Unit
		every { SessionTracker.loadPlansRegistry(any<String>()) } answers { plansRegistry }
		every { SessionTracker.savePlansRegistry(any(), any<String>()) } answers {
			plansRegistry = firstArg()
		}
	}

	@AfterEach
	fun tearDown() {
		unmockkAll()
	}

	// ── Helpers ──────────────────────────────────────────────────────────────

	private fun toolUseLine(
		toolUseId: String,
		name: String,
		input: String = "{}",
		timestamp: String = "2024-01-01T00:00:00Z",
	): String = """{"timestamp":"$timestamp","message":{"role":"assistant","content":[{"type":"tool_use","id":"$toolUseId","name":"$name","input":$input}]}}"""

	private fun toolResultLine(
		toolUseId: String,
		payloadJson: String,
		timestamp: String = "2024-01-01T00:00:01Z",
	): String {
		val escaped = payloadJson.replace("\"", "\\\"")
		return """{"timestamp":"$timestamp","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"$toolUseId","content":[{"type":"text","text":"$escaped"}]}]}}"""
	}

	private fun writeTranscript(vararg lines: String): String {
		val file = File(tempDir, "transcript.jsonl")
		file.writeText(lines.joinToString("\n") + "\n")
		return file.absolutePath
	}

	private val LINEAR_PAYLOAD = """{"id":"PROJ-42","title":"Test issue","url":"https://linear.app/x/issue/PROJ-42","status":"In Progress"}"""
	private val LINEAR_PAYLOAD_2 = """{"id":"PROJ-99","title":"Another issue","url":"https://linear.app/x/issue/PROJ-99","status":"Done"}"""

	// ── Tests ────────────────────────────────────────────────────────────────

	@Nested
	inner class ScanReferencesFrom {

		@Test
		fun `discovers a single Linear reference and persists to registry`() {
			val path = writeTranscript(
				toolUseLine("tu1", "mcp__linear__get_issue"),
				toolResultLine("tu1", LINEAR_PAYLOAD),
			)

			val lastLine = TranscriptReferenceDiscovery.scanReferencesFrom(path, 0, cwd, TranscriptSource.claude)
			lastLine shouldBe 2

			// Check that plans.json.references was updated
			plansRegistry.references shouldNotBe null
			plansRegistry.references!!.size shouldBe 1
			val entry = plansRegistry.references!!["linear:PROJ-42"]
			entry shouldNotBe null
			entry!!.nativeId shouldBe "PROJ-42"
			entry.title shouldBe "Test issue"
			entry.source shouldBe SourceId.linear
		}

		@Test
		fun `discovers multiple references`() {
			val path = writeTranscript(
				toolUseLine("tu1", "mcp__linear__get_issue"),
				toolResultLine("tu1", LINEAR_PAYLOAD),
				toolUseLine("tu2", "mcp__linear__get_issue"),
				toolResultLine("tu2", LINEAR_PAYLOAD_2),
			)

			TranscriptReferenceDiscovery.scanReferencesFrom(path, 0, cwd, TranscriptSource.claude)

			plansRegistry.references shouldNotBe null
			plansRegistry.references!!.size shouldBe 2
			plansRegistry.references!!.containsKey("linear:PROJ-42") shouldBe true
			plansRegistry.references!!.containsKey("linear:PROJ-99") shouldBe true
		}

		@Test
		fun `writes markdown file to disk`() {
			val path = writeTranscript(
				toolUseLine("tu1", "mcp__linear__get_issue"),
				toolResultLine("tu1", LINEAR_PAYLOAD),
			)

			TranscriptReferenceDiscovery.scanReferencesFrom(path, 0, cwd, TranscriptSource.claude)

			val entry = plansRegistry.references!!["linear:PROJ-42"]!!
			File(entry.sourcePath).exists() shouldBe true

			val parsed = ReferenceStore.readReferenceMarkdown(entry.sourcePath)
			parsed shouldNotBe null
			parsed!!.nativeId shouldBe "PROJ-42"
		}

		@Test
		fun `returns last line scanned when no references found`() {
			val path = writeTranscript(
				"""{"timestamp":"2024-01-01T00:00:00Z","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}""",
			)

			val lastLine = TranscriptReferenceDiscovery.scanReferencesFrom(path, 0, cwd, TranscriptSource.claude)
			lastLine shouldBe 1
			plansRegistry.references shouldBe null
		}

		@Test
		fun `incremental scan skips already-scanned lines`() {
			val path = writeTranscript(
				toolUseLine("tu1", "mcp__linear__get_issue"),
				toolResultLine("tu1", LINEAR_PAYLOAD),
				toolUseLine("tu2", "mcp__linear__get_issue"),
				toolResultLine("tu2", LINEAR_PAYLOAD_2),
			)

			// First scan: lines 0..4
			val firstLast = TranscriptReferenceDiscovery.scanReferencesFrom(path, 0, cwd, TranscriptSource.claude)
			plansRegistry.references!!.size shouldBe 2

			// Clear registry to prove second scan doesn't re-discover
			plansRegistry = PlansRegistry()

			// Second scan from where first left off: no new refs
			val secondLast = TranscriptReferenceDiscovery.scanReferencesFrom(path, firstLast, cwd, TranscriptSource.claude)
			secondLast shouldBe firstLast
			plansRegistry.references shouldBe null
		}

		@Test
		fun `updates existing registry entry on re-scan`() {
			val updatedPayload = """{"id":"PROJ-42","title":"Updated title","url":"https://linear.app/x/issue/PROJ-42","status":"Done"}"""
			val path1 = writeTranscript(
				toolUseLine("tu1", "mcp__linear__get_issue"),
				toolResultLine("tu1", LINEAR_PAYLOAD),
			)

			TranscriptReferenceDiscovery.scanReferencesFrom(path1, 0, cwd, TranscriptSource.claude)
			val firstUpdatedAt = plansRegistry.references!!["linear:PROJ-42"]!!.updatedAt

			// Write a new transcript with updated payload
			Thread.sleep(50) // ensure different timestamp
			val path2 = writeTranscript(
				toolUseLine("tu2", "mcp__linear__get_issue"),
				toolResultLine("tu2", updatedPayload),
			)

			TranscriptReferenceDiscovery.scanReferencesFrom(path2, 0, cwd, TranscriptSource.claude)

			val entry = plansRegistry.references!!["linear:PROJ-42"]!!
			entry.title shouldBe "Updated title"
			// updatedAt should have changed
			entry.updatedAt shouldNotBe firstUpdatedAt
		}
	}

	@Nested
	inner class GetCurrentBranchSafe {
		@Test
		fun `returns unknown for non-git directory`(@TempDir nonGitDir: File) {
			TranscriptReferenceDiscovery.getCurrentBranchSafe(nonGitDir.absolutePath) shouldBe "unknown"
		}

		@Test
		fun `returns unknown for nonexistent directory`() {
			TranscriptReferenceDiscovery.getCurrentBranchSafe("/nonexistent/path/that/does/not/exist") shouldBe "unknown"
		}
	}
}
