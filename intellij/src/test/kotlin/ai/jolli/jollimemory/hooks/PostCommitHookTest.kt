package ai.jolli.jollimemory.hooks

import ai.jolli.jollimemory.core.CommitSelectionStore
import ai.jolli.jollimemory.core.DiffStats
import ai.jolli.jollimemory.core.NoteEntry
import ai.jolli.jollimemory.core.NoteFormat
import ai.jolli.jollimemory.core.PlanEntry
import ai.jolli.jollimemory.core.PlansRegistry
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.references.ReferenceEntry
import ai.jolli.jollimemory.core.references.SourceId
import io.kotest.matchers.collections.shouldContainExactlyInAnyOrder
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.lang.reflect.Method

class PostCommitHookTest {

    @TempDir
    lateinit var tempDir: File
    private val cwd get() = tempDir.absolutePath

    @BeforeEach
    fun setUp() {
        File(tempDir, ".jolli/jollimemory").mkdirs()
    }

    /** Access the private parseDiffStats method via reflection for testing. */
    private fun parseDiffStats(statOutput: String): DiffStats {
        val method: Method = PostCommitHook::class.java.getDeclaredMethod("parseDiffStats", String::class.java)
        method.isAccessible = true
        return method.invoke(PostCommitHook, statOutput) as DiffStats
    }

    private fun note(id: String, branch: String, commitHash: String?, ignored: Boolean? = null) = NoteEntry(
        id = id,
        title = "Note $id",
        format = NoteFormat.markdown,
        addedAt = "2026-01-01T00:00:00Z",
        updatedAt = "2026-01-01T00:00:00Z",
        branch = branch,
        commitHash = commitHash,
        ignored = ignored,
        sourcePath = "/notes/$id.md",
    )

    @Suppress("UNCHECKED_CAST")
    private fun detectUncommittedNotes(excluded: Set<String>): Map<String, NoteEntry> {
        val method = PostCommitHook::class.java.getDeclaredMethod(
            "detectUncommittedNotes", String::class.java, Set::class.java,
        )
        method.isAccessible = true
        return method.invoke(PostCommitHook, cwd, excluded) as Map<String, NoteEntry>
    }

    private fun ref(nativeId: String, branch: String?) = ReferenceEntry(
        source = SourceId.linear,
        nativeId = nativeId,
        title = "Ref $nativeId",
        url = "https://linear.app/x/issue/$nativeId",
        sourcePath = "/references/linear/$nativeId.md",
        addedAt = "2026-01-01T00:00:00Z",
        updatedAt = "2026-01-01T00:00:00Z",
        sourceToolName = "linear",
        branch = branch,
    )

    @Suppress("UNCHECKED_CAST")
    private fun detectUncommittedReferences(excluded: Set<String>): Map<String, ReferenceEntry> {
        val method = PostCommitHook::class.java.getDeclaredMethod(
            "detectUncommittedReferences", String::class.java, Set::class.java,
        )
        method.isAccessible = true
        return method.invoke(PostCommitHook, cwd, excluded) as Map<String, ReferenceEntry>
    }

    private fun plan(slug: String, commitHash: String?, contentHashAtCommit: String? = null, sourcePath: String) = PlanEntry(
        slug = slug,
        title = "Plan $slug",
        sourcePath = sourcePath,
        addedAt = "2026-01-01T00:00:00Z",
        updatedAt = "2026-01-01T00:00:00Z",
        commitHash = commitHash,
        contentHashAtCommit = contentHashAtCommit,
    )

    private fun discardExcludedWorkingItems(exclusions: CommitSelectionStore.CommitExclusions) {
        val method = PostCommitHook::class.java.getDeclaredMethod(
            "discardExcludedWorkingItems", CommitSelectionStore.CommitExclusions::class.java, String::class.java,
        )
        method.isAccessible = true
        method.invoke(PostCommitHook, exclusions, cwd)
    }

    private fun sha256Hex(s: String): String {
        val method = PostCommitHook::class.java.getDeclaredMethod("sha256Hex", String::class.java)
        method.isAccessible = true
        return method.invoke(PostCommitHook, s) as String
    }

    @Nested
    inner class ParseDiffStats {
        @Test
        fun `parses numstat output`() {
            val output = """
10	5	src/Auth.ts
20	3	src/Middleware.ts
            """.trimIndent()

            val stats = parseDiffStats(output)
            stats.filesChanged shouldBe 2
            stats.insertions shouldBe 30
            stats.deletions shouldBe 8
        }

        @Test
        fun `handles binary files with dash markers`() {
            val output = """
10	5	src/code.ts
-	-	assets/image.png
            """.trimIndent()

            val stats = parseDiffStats(output)
            stats.filesChanged shouldBe 2
            stats.insertions shouldBe 10
            stats.deletions shouldBe 5
        }

        @Test
        fun `returns zero stats for empty input`() {
            val stats = parseDiffStats("")
            stats.filesChanged shouldBe 0
            stats.insertions shouldBe 0
            stats.deletions shouldBe 0
        }

        @Test
        fun `ignores malformed lines`() {
            val output = """
10	5	src/code.ts
invalid line
3	2	src/other.ts
            """.trimIndent()

            val stats = parseDiffStats(output)
            stats.filesChanged shouldBe 2
            stats.insertions shouldBe 13
            stats.deletions shouldBe 7
        }
    }

    @Nested
    inner class DetectUncommittedNotes {
        @Test
        fun `includes uncommitted non-ignored non-excluded notes regardless of branch`() {
            SessionTracker.savePlansRegistry(
                PlansRegistry(
                    notes = mapOf(
                        "eligible" to note("eligible", branch = "feature/x", commitHash = null),
                        "blank-branch" to note("blank-branch", branch = "", commitHash = null),
                        "committed" to note("committed", branch = "feature/x", commitHash = "abc123"),
                        "ignored" to note("ignored", branch = "feature/x", commitHash = null, ignored = true),
                        // Uncommitted items follow the user across branches — no branch filter.
                        "other-branch" to note("other-branch", branch = "feature/y", commitHash = null),
                        "excluded" to note("excluded", branch = "feature/x", commitHash = null),
                    ),
                ),
                cwd,
            )

            val result = detectUncommittedNotes(excluded = setOf("excluded"))

            result.keys shouldContainExactlyInAnyOrder listOf("eligible", "blank-branch", "other-branch")
        }

        @Test
        fun `returns empty when there are no notes`() {
            SessionTracker.savePlansRegistry(PlansRegistry(), cwd)
            detectUncommittedNotes(excluded = emptySet()) shouldBe emptyMap()
        }
    }

    @Nested
    inner class DetectUncommittedReferences {
        @Test
        fun `includes all uncommitted references regardless of branch, minus excluded`() {
            SessionTracker.savePlansRegistry(
                PlansRegistry(
                    references = mapOf(
                        "linear:ENG-1" to ref("ENG-1", branch = "feature/x"),
                        "linear:ENG-2" to ref("ENG-2", branch = null),
                        "linear:ENG-3" to ref("ENG-3", branch = ""),
                        // Other-branch reference is still included — no branch filter.
                        "linear:ENG-4" to ref("ENG-4", branch = "feature/y"),
                    ),
                ),
                cwd,
            )

            val result = detectUncommittedReferences(excluded = setOf("linear:ENG-4"))

            result.keys shouldContainExactlyInAnyOrder listOf("linear:ENG-1", "linear:ENG-2", "linear:ENG-3")
        }

        @Test
        fun `returns empty when there are no references`() {
            SessionTracker.savePlansRegistry(PlansRegistry(), cwd)
            detectUncommittedReferences(excluded = emptySet()) shouldBe emptyMap()
        }
    }

    @Nested
    inner class DiscardExcludedWorkingItems {
        @Test
        fun `removes excluded uncommitted rows and jolli files but keeps committed rows and external plan files`() {
            val jolliDir = File(tempDir, ".jolli/jollimemory")
            val notesDir = File(jolliDir, "notes").apply { mkdirs() }
            val refsDir = File(jolliDir, "references/linear").apply { mkdirs() }
            val extDir = File(tempDir, "ext-plans").apply { mkdirs() }

            val dropPlanFile = File(extDir, "drop.md").apply { writeText("# Drop") }
            val noteFile = File(notesDir, "n1.md").apply { writeText("note") }
            val refFile = File(refsDir, "L-1.md").apply { writeText("ref") }

            SessionTracker.savePlansRegistry(
                PlansRegistry(
                    plans = mapOf(
                        "drop-plan" to plan("drop-plan", commitHash = null, sourcePath = dropPlanFile.absolutePath),
                        // committed guard must survive even if its key is in the exclusion set.
                        "committed-plan" to plan("committed-plan", commitHash = "abc12345", contentHashAtCommit = "h", sourcePath = dropPlanFile.absolutePath),
                    ),
                    notes = mapOf(
                        "n1" to NoteEntry(
                            id = "n1", title = "Note", format = NoteFormat.snippet,
                            addedAt = "t", updatedAt = "t", branch = "", commitHash = null,
                            sourcePath = noteFile.absolutePath,
                        ),
                    ),
                    references = mapOf("linear:L-1" to ref("L-1", branch = null).copy(sourcePath = refFile.absolutePath)),
                ),
                cwd,
            )

            discardExcludedWorkingItems(
                CommitSelectionStore.CommitExclusions(
                    plans = setOf("drop-plan", "committed-plan"),
                    notes = setOf("n1"),
                    references = setOf("linear:L-1"),
                ),
            )

            val reg = SessionTracker.loadPlansRegistry(cwd)
            reg.plans.keys shouldContainExactlyInAnyOrder listOf("committed-plan")
            (reg.notes ?: emptyMap()) shouldBe emptyMap()
            (reg.references ?: emptyMap()) shouldBe emptyMap()
            // .jolli-owned files deleted; external plan file preserved.
            noteFile.exists() shouldBe false
            refFile.exists() shouldBe false
            dropPlanFile.exists() shouldBe true
        }

        @Test
        fun `is a no-op when nothing is excluded`() {
            SessionTracker.savePlansRegistry(
                PlansRegistry(plans = mapOf("p" to plan("p", commitHash = null, sourcePath = "/ext/p.md"))),
                cwd,
            )
            discardExcludedWorkingItems(CommitSelectionStore.CommitExclusions())
            SessionTracker.loadPlansRegistry(cwd).plans.keys shouldContainExactlyInAnyOrder listOf("p")
        }
    }

    @Nested
    inner class Sha256Hex {
        @Test
        fun `matches the known SHA-256 of a string`() {
            // echo -n "abc" | shasum -a 256
            sha256Hex("abc") shouldBe "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        }
    }
}
