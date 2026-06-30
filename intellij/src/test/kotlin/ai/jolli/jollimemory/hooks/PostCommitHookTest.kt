package ai.jolli.jollimemory.hooks

import ai.jolli.jollimemory.core.DiffStats
import ai.jolli.jollimemory.core.NoteEntry
import ai.jolli.jollimemory.core.NoteFormat
import ai.jolli.jollimemory.core.PlansRegistry
import ai.jolli.jollimemory.core.SessionTracker
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
    private fun detectUncommittedNotes(branch: String, excluded: Set<String>): Map<String, NoteEntry> {
        val method = PostCommitHook::class.java.getDeclaredMethod(
            "detectUncommittedNotes", String::class.java, String::class.java, Set::class.java,
        )
        method.isAccessible = true
        return method.invoke(PostCommitHook, cwd, branch, excluded) as Map<String, NoteEntry>
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
        fun `includes only uncommitted, non-ignored, current-branch, non-excluded notes`() {
            SessionTracker.savePlansRegistry(
                PlansRegistry(
                    notes = mapOf(
                        "eligible" to note("eligible", branch = "feature/x", commitHash = null),
                        "blank-branch" to note("blank-branch", branch = "", commitHash = null),
                        "committed" to note("committed", branch = "feature/x", commitHash = "abc123"),
                        "ignored" to note("ignored", branch = "feature/x", commitHash = null, ignored = true),
                        "other-branch" to note("other-branch", branch = "feature/y", commitHash = null),
                        "excluded" to note("excluded", branch = "feature/x", commitHash = null),
                    ),
                ),
                cwd,
            )

            val result = detectUncommittedNotes(branch = "feature/x", excluded = setOf("excluded"))

            result.keys shouldContainExactlyInAnyOrder listOf("eligible", "blank-branch")
        }

        @Test
        fun `returns empty when there are no notes`() {
            SessionTracker.savePlansRegistry(PlansRegistry(), cwd)
            detectUncommittedNotes(branch = "main", excluded = emptySet()) shouldBe emptyMap()
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
