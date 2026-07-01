package ai.jolli.jollimemory.core.plans

import ai.jolli.jollimemory.core.NoteEntry
import ai.jolli.jollimemory.core.NoteFormat
import ai.jolli.jollimemory.core.PlanEntry
import ai.jolli.jollimemory.core.PlansRegistry
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.TranscriptSource
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldEndWith
import io.kotest.matchers.string.shouldStartWith
import io.mockk.every
import io.mockk.mockkObject
import io.mockk.unmockkAll
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.security.MessageDigest

class TranscriptPlanDiscoveryTest {

    @TempDir
    lateinit var tempDir: File

    private lateinit var cwd: String
    private var plansRegistry = PlansRegistry()

    @BeforeEach
    fun setUp() {
        cwd = tempDir.absolutePath
        plansRegistry = PlansRegistry()

        mockkObject(SessionTracker)
        every { SessionTracker.acquireLock(any()) } returns true
        every { SessionTracker.releaseLock(any()) } returns Unit
        every { SessionTracker.loadPlansRegistry(any<String>()) } answers { plansRegistry }
        every { SessionTracker.savePlansRegistry(any(), any<String>()) } answers { plansRegistry = firstArg() }
    }

    @AfterEach
    fun tearDown() = unmockkAll()

    // ── Helpers ──────────────────────────────────────────────────────────────

    /** A Write/Edit tool_use line that targets an absolute .md `file_path`. */
    private fun writeMdLine(path: String, name: String = "Write"): String {
        val esc = path.replace("\\", "\\\\")
        return """{"message":{"role":"assistant","content":[{"type":"tool_use","id":"tu","name":"$name","input":{"file_path":"$esc","content":"x"}}]}}"""
    }

    /** A plan-mode line carrying a "slug" field. */
    private fun slugLine(slug: String): String =
        """{"message":{"role":"assistant","content":[{"type":"text","text":"planning"}]},"slug":"$slug"}"""

    private fun writeTranscript(vararg lines: String): String {
        val file = File(tempDir, "transcript.jsonl")
        file.writeText(lines.joinToString("\n") + "\n")
        return file.absolutePath
    }

    private fun mdFile(dir: File, name: String, content: String = "# My Plan\n\nbody"): File {
        dir.mkdirs()
        val f = File(dir, name)
        f.writeText(content)
        return f
    }

    private fun sha256(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

    // ── ClaudePlanScanner (signal detection) ───────────────────────────────────

    @Nested
    inner class Scanner {

        @Test
        fun `extracts plan-mode slug`() {
            val path = writeTranscript(slugLine("wandering-otter"))
            val result = ClaudePlanScanner.scan(path, 0)
            result.slugs shouldBe setOf("wandering-otter")
            result.externalPlans.isEmpty() shouldBe true
            result.totalLines shouldBe 1
        }

        @Test
        fun `extracts slug from a Write to ~ slash claude slash plans`() {
            val path = writeTranscript(writeMdLine("/Users/x/.claude/plans/brave-fox.md"))
            val result = ClaudePlanScanner.scan(path, 0)
            result.slugs shouldBe setOf("brave-fox")
            result.externalPlans.isEmpty() shouldBe true
        }

        @Test
        fun `collects external md path from Write and Edit`() {
            val path = writeTranscript(
                writeMdLine("/repo/docs/design.md", "Write"),
                writeMdLine("/repo/docs/notes.md", "Edit"),
            )
            val result = ClaudePlanScanner.scan(path, 0)
            result.slugs.isEmpty() shouldBe true
            result.externalPlans shouldBe setOf("/repo/docs/design.md", "/repo/docs/notes.md")
        }

        @Test
        fun `ignores non Write or Edit tool_use`() {
            val path = writeTranscript(writeMdLine("/repo/docs/design.md", "Read"))
            val result = ClaudePlanScanner.scan(path, 0)
            result.externalPlans.isEmpty() shouldBe true
        }

        @Test
        fun `respects fromLine and skips already-scanned lines`() {
            val path = writeTranscript(
                writeMdLine("/repo/a.md"),
                writeMdLine("/repo/b.md"),
            )
            val result = ClaudePlanScanner.scan(path, 1)
            result.externalPlans shouldBe setOf("/repo/b.md")
            result.totalLines shouldBe 2
        }

        @Test
        fun `decodes JSON-escaped unicode paths`() {
            // file_path with a é escape → decoded to é
            val path = writeTranscript(
                """{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/repo/café.md"}}]}}""",
            )
            val result = ClaudePlanScanner.scan(path, 0)
            result.externalPlans shouldBe setOf("/repo/café.md")
        }
    }

    // ── scanPlansFrom (persist + policy) ───────────────────────────────────────

    @Nested
    inner class ScanPlansFrom {

        @Test
        fun `registers a new external plan into plans json`() {
            val plan = mdFile(File(tempDir, "docs"), "feature.md", "# Feature Plan\n")
            val path = writeTranscript(writeMdLine(plan.absolutePath))

            val last = TranscriptPlanDiscovery.scanPlansFrom(path, 0, cwd, TranscriptSource.claude)
            last shouldBe 1

            plansRegistry.plans.size shouldBe 1
            val entry = plansRegistry.plans["feature"]
            entry shouldNotBe null
            entry!!.sourcePath shouldBe plan.absolutePath
            entry.title shouldBe "Feature Plan"
            entry.commitHash shouldBe null
            // temp dir is not a git repo → branch omitted (visible everywhere)
            entry.branch shouldBe null
        }

        @Test
        fun `returns totalLines and writes nothing when no plan signals`() {
            val path = writeTranscript("""{"message":{"content":[{"type":"text","text":"hi"}]}}""")
            val last = TranscriptPlanDiscovery.scanPlansFrom(path, 0, cwd, TranscriptSource.claude)
            last shouldBe 1
            plansRegistry.plans.isEmpty() shouldBe true
        }

        @Test
        fun `excludes README and node_modules and dot-claude and dot-github paths`() {
            val readme = mdFile(File(tempDir, "docs"), "README.md")
            val nodeMod = mdFile(File(tempDir, "node_modules/pkg"), "plan.md")
            val gh = mdFile(File(tempDir, ".github"), "plan.md")
            val path = writeTranscript(
                writeMdLine(readme.absolutePath),
                writeMdLine(nodeMod.absolutePath),
                writeMdLine(gh.absolutePath),
            )

            TranscriptPlanDiscovery.scanPlansFrom(path, 0, cwd, TranscriptSource.claude)
            plansRegistry.plans.isEmpty() shouldBe true
        }

        @Test
        fun `skips a canonical slug whose plan file does not exist`() {
            // slug points at ~/.claude/plans/<slug>.md which won't exist for this random slug
            val path = writeTranscript(slugLine("nonexistent-slug-xyz-12345"))
            val last = TranscriptPlanDiscovery.scanPlansFrom(path, 0, cwd, TranscriptSource.claude)
            last shouldBe 1
            plansRegistry.plans.isEmpty() shouldBe true
        }

        @Test
        fun `suppresses plan registration when path already a note`() {
            val plan = mdFile(File(tempDir, "docs"), "shared.md")
            plansRegistry = PlansRegistry(
                notes = mapOf(
                    "n1" to NoteEntry(
                        id = "n1", title = "Shared", format = NoteFormat.markdown,
                        addedAt = "t", updatedAt = "t", branch = "", commitHash = null,
                        sourcePath = plan.absolutePath,
                    ),
                ),
            )
            val path = writeTranscript(writeMdLine(plan.absolutePath))

            TranscriptPlanDiscovery.scanPlansFrom(path, 0, cwd, TranscriptSource.claude)
            plansRegistry.plans.isEmpty() shouldBe true
        }

        @Test
        fun `bumps updatedAt for an existing uncommitted entry`() {
            val plan = mdFile(File(tempDir, "docs"), "feature.md")
            plansRegistry = PlansRegistry(
                plans = mapOf(
                    "feature" to PlanEntry(
                        slug = "feature", title = "Old", sourcePath = plan.absolutePath,
                        addedAt = "2020-01-01T00:00:00Z", updatedAt = "2020-01-01T00:00:00Z",
                        commitHash = null,
                    ),
                ),
            )
            val path = writeTranscript(writeMdLine(plan.absolutePath))

            TranscriptPlanDiscovery.scanPlansFrom(path, 0, cwd, TranscriptSource.claude)
            val entry = plansRegistry.plans["feature"]!!
            entry.updatedAt shouldNotBe "2020-01-01T00:00:00Z"
        }

        @Test
        fun `leaves a committed entry untouched`() {
            val plan = mdFile(File(tempDir, "docs"), "feature.md")
            val committed = PlanEntry(
                slug = "feature", title = "Committed", sourcePath = plan.absolutePath,
                addedAt = "2020-01-01T00:00:00Z", updatedAt = "2020-01-01T00:00:00Z",
                commitHash = "abc12345", // committed, no contentHashAtCommit
            )
            plansRegistry = PlansRegistry(plans = mapOf("feature" to committed))
            val path = writeTranscript(writeMdLine(plan.absolutePath))

            TranscriptPlanDiscovery.scanPlansFrom(path, 0, cwd, TranscriptSource.claude)
            plansRegistry.plans["feature"] shouldBe committed
        }

        @Test
        fun `revives an archived guard entry when the file changed`() {
            val plan = mdFile(File(tempDir, "docs"), "feature.md", "# New content\n")
            val guard = PlanEntry(
                slug = "feature", title = "Archived", sourcePath = plan.absolutePath,
                addedAt = "2020-01-01T00:00:00Z", updatedAt = "2020-01-01T00:00:00Z",
                commitHash = "abc12345", contentHashAtCommit = sha256("# Old content\n"),
            )
            plansRegistry = PlansRegistry(plans = mapOf("feature" to guard))
            val path = writeTranscript(writeMdLine(plan.absolutePath))

            TranscriptPlanDiscovery.scanPlansFrom(path, 0, cwd, TranscriptSource.claude)
            val entry = plansRegistry.plans["feature"]!!
            entry.commitHash shouldBe null
            entry.contentHashAtCommit shouldBe null
        }

        @Test
        fun `hash-suffixes a slug when the base name is taken by a different file`() {
            val first = mdFile(File(tempDir, "a"), "plan.md")
            plansRegistry = PlansRegistry(
                plans = mapOf(
                    "plan" to PlanEntry(
                        slug = "plan", title = "First", sourcePath = first.absolutePath,
                        addedAt = "t", updatedAt = "t", commitHash = null,
                    ),
                ),
            )
            val second = mdFile(File(tempDir, "b"), "plan.md")
            val path = writeTranscript(writeMdLine(second.absolutePath))

            TranscriptPlanDiscovery.scanPlansFrom(path, 0, cwd, TranscriptSource.claude)
            plansRegistry.plans.size shouldBe 2
            val suffixed = plansRegistry.plans.keys.first { it != "plan" }
            suffixed shouldStartWith "plan-"
            suffixed.length shouldBe "plan-".length + 8
        }

        @Test
        fun `incremental scan finds nothing new from the last line`() {
            val plan = mdFile(File(tempDir, "docs"), "feature.md")
            val path = writeTranscript(writeMdLine(plan.absolutePath))

            val last = TranscriptPlanDiscovery.scanPlansFrom(path, 0, cwd, TranscriptSource.claude)
            plansRegistry.plans.size shouldBe 1

            plansRegistry = PlansRegistry() // prove no re-discovery
            val second = TranscriptPlanDiscovery.scanPlansFrom(path, last, cwd, TranscriptSource.claude)
            second shouldBe last
            plansRegistry.plans.isEmpty() shouldBe true
        }

        @Test
        fun `derives a slug basename ending in md`() {
            val plan = mdFile(File(tempDir, "docs"), "my-cool-plan.md")
            val path = writeTranscript(writeMdLine(plan.absolutePath))
            TranscriptPlanDiscovery.scanPlansFrom(path, 0, cwd, TranscriptSource.claude)
            plansRegistry.plans.keys.first() shouldBe "my-cool-plan"
            plansRegistry.plans.values.first().sourcePath shouldEndWith "my-cool-plan.md"
        }
    }
}
