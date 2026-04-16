package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.core.JmLogger
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.time.Instant

class SessionTrackerTest {

    @TempDir
    lateinit var tempDir: File

    @BeforeEach
    fun setUp() {
        // Create the .jolli/jollimemory directory
        File(tempDir, ".jolli/jollimemory").mkdirs()
    }

    private val cwd get() = tempDir.absolutePath

    // ── Sessions ────────────────────────────────────────────────────────

    @Nested
    inner class Sessions {
        @Test
        fun `saveSession and loadAllSessions round-trip`() {
            val session = SessionInfo(
                sessionId = "test-session-1",
                transcriptPath = "/path/to/transcript.jsonl",
                updatedAt = Instant.now().toString(),
            )

            SessionTracker.saveSession(session, cwd)
            val sessions = SessionTracker.loadAllSessions(cwd)

            sessions shouldHaveSize 1
            sessions[0].sessionId shouldBe "test-session-1"
        }

        @Test
        fun `loadAllSessions returns empty when no sessions exist`() {
            SessionTracker.loadAllSessions(cwd).shouldBeEmpty()
        }

        @Test
        fun `loadMostRecentSession returns the latest session`() {
            // Use recent timestamps (within 48h) to avoid stale pruning
            val now = Instant.now()
            val older = SessionInfo("s1", "/path/1", now.minusSeconds(3600).toString())
            val newer = SessionInfo("s2", "/path/2", now.toString())

            SessionTracker.saveSession(older, cwd)
            SessionTracker.saveSession(newer, cwd)

            val recent = SessionTracker.loadMostRecentSession(cwd)
            recent?.sessionId shouldBe "s2"
        }

        @Test
        fun `loadMostRecentSession returns null when no sessions exist`() {
            SessionTracker.loadMostRecentSession(cwd) shouldBe null
        }
    }

    // ── Cursors ─────────────────────────────────────────────────────────

    @Nested
    inner class Cursors {
        @Test
        fun `saveCursor and loadCursorForTranscript round-trip`() {
            val cursor = TranscriptCursor("/path/transcript.jsonl", 42, Instant.now().toString())
            SessionTracker.saveCursor(cursor, cwd)

            val loaded = SessionTracker.loadCursorForTranscript("/path/transcript.jsonl", cwd)
            loaded shouldNotBe null
            loaded!!.lineNumber shouldBe 42
        }

        @Test
        fun `loadCursorForTranscript returns null for unknown path`() {
            SessionTracker.loadCursorForTranscript("/unknown/path", cwd) shouldBe null
        }
    }

    // ── Config ──────────────────────────────────────────────────────────

    @Nested
    inner class Config {
        @Test
        fun `loadConfigFromDir returns defaults when no config exists`() {
            val config = SessionTracker.loadConfigFromDir(JmLogger.getJolliMemoryDir(cwd))
            config.apiKey shouldBe null
            config.model shouldBe null
        }

        @Test
        fun `saveConfig merges with existing config`() {
            // Save initial config
            SessionTracker.saveConfig(JolliMemoryConfig(apiKey = "key1", model = "sonnet"), cwd)

            // Save update with only model
            SessionTracker.saveConfig(JolliMemoryConfig(model = "opus"), cwd)

            val config = SessionTracker.loadConfigFromDir(JmLogger.getJolliMemoryDir(cwd))
            config.apiKey shouldBe "key1" // preserved
            config.model shouldBe "opus" // updated
        }
    }

    // ── Lock ────────────────────────────────────────────────────────────

    @Nested
    inner class Lock {
        @Test
        fun `acquireLock succeeds on first call`() {
            SessionTracker.acquireLock(cwd) shouldBe true
        }

        @Test
        fun `acquireLock fails when lock already held`() {
            SessionTracker.acquireLock(cwd) shouldBe true
            SessionTracker.acquireLock(cwd) shouldBe false
        }

        @Test
        fun `releaseLock allows re-acquire`() {
            SessionTracker.acquireLock(cwd)
            SessionTracker.releaseLock(cwd)
            SessionTracker.acquireLock(cwd) shouldBe true
        }
    }

    // ── Squash Pending ──────────────────────────────────────────────────

    @Nested
    inner class SquashPending {
        @Test
        fun `save and load squash pending round-trip`() {
            SessionTracker.saveSquashPending(listOf("hash1", "hash2"), "parent123", cwd)

            val state = SessionTracker.loadSquashPending(cwd)
            state shouldNotBe null
            state!!.sourceHashes shouldBe listOf("hash1", "hash2")
            state.expectedParentHash shouldBe "parent123"
        }

        @Test
        fun `loadSquashPending returns null when none exists`() {
            SessionTracker.loadSquashPending(cwd) shouldBe null
        }

        @Test
        fun `deleteSquashPending removes file`() {
            SessionTracker.saveSquashPending(listOf("h1"), "p1", cwd)
            SessionTracker.deleteSquashPending(cwd)
            SessionTracker.loadSquashPending(cwd) shouldBe null
        }
    }

    // ── Amend Pending ───────────────────────────────────────────────────

    @Nested
    inner class AmendPending {
        @Test
        fun `save and load amend pending round-trip`() {
            SessionTracker.saveAmendPending("oldhash", cwd)

            val state = SessionTracker.loadAmendPending(cwd)
            state shouldNotBe null
            state!!.oldHash shouldBe "oldhash"
        }

        @Test
        fun `loadAmendPending returns null when none exists`() {
            SessionTracker.loadAmendPending(cwd) shouldBe null
        }

        @Test
        fun `deleteAmendPending removes file`() {
            SessionTracker.saveAmendPending("h1", cwd)
            SessionTracker.deleteAmendPending(cwd)
            SessionTracker.loadAmendPending(cwd) shouldBe null
        }
    }

    // ── Plugin Source ───────────────────────────────────────────────────

    @Nested
    inner class PluginSource {
        @Test
        fun `save and load plugin source`() {
            SessionTracker.savePluginSource(cwd)
            SessionTracker.loadPluginSource(cwd) shouldBe true
        }

        @Test
        fun `loadPluginSource returns false when not saved`() {
            SessionTracker.loadPluginSource(cwd) shouldBe false
        }

        @Test
        fun `deletePluginSource removes file`() {
            SessionTracker.savePluginSource(cwd)
            SessionTracker.deletePluginSource(cwd)
            SessionTracker.loadPluginSource(cwd) shouldBe false
        }
    }

    // ── Plans Registry ──────────────────────────────────────────────────

    @Nested
    inner class PlansRegistry {
        @Test
        fun `loadPlansRegistry returns empty registry when none exists`() {
            val registry = SessionTracker.loadPlansRegistry(cwd)
            registry.plans shouldBe emptyMap()
        }

        @Test
        fun `save and load plans registry round-trip`() {
            val entry = PlanEntry(
                slug = "test-plan",
                title = "Test Plan",
                sourcePath = "/path/test-plan.md",
                addedAt = "2026-01-01T00:00:00Z",
                updatedAt = "2026-01-01T00:00:00Z",
                branch = "main",
                commitHash = null,
                editCount = 1,
            )
            val registry = ai.jolli.jollimemory.core.PlansRegistry(plans = mapOf("test-plan" to entry))
            SessionTracker.savePlansRegistry(registry, cwd)

            val loaded = SessionTracker.loadPlansRegistry(cwd)
            loaded.plans.size shouldBe 1
            loaded.plans["test-plan"]!!.title shouldBe "Test Plan"
        }

        @Test
        fun `associatePlanWithCommit updates plan entry`() {
            val entry = PlanEntry(
                slug = "plan1",
                title = "Plan 1",
                sourcePath = "/path/plan1.md",
                addedAt = "2026-01-01T00:00:00Z",
                updatedAt = "2026-01-01T00:00:00Z",
                branch = "main",
                commitHash = null,
                editCount = 0,
            )
            SessionTracker.savePlansRegistry(
                ai.jolli.jollimemory.core.PlansRegistry(plans = mapOf("plan1" to entry)), cwd,
            )

            SessionTracker.associatePlanWithCommit("plan1", "commitabc123", cwd)

            val loaded = SessionTracker.loadPlansRegistry(cwd)
            loaded.plans["plan1"]!!.commitHash shouldBe "commitabc123"
        }

        @Test
        fun `loadPlanEntry returns null for unknown slug`() {
            SessionTracker.loadPlanEntry("nonexistent", cwd) shouldBe null
        }
    }
}
