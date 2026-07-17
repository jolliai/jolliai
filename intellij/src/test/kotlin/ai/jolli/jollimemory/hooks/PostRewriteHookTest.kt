package ai.jolli.jollimemory.hooks

import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.HookEnv
import ai.jolli.jollimemory.core.SummaryStore
import ai.jolli.jollimemory.core.fakeHookEnv
import io.mockk.every
import io.mockk.mockkConstructor
import io.mockk.unmockkAll
import io.mockk.verify
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import org.junit.jupiter.api.parallel.Isolated
import org.junit.jupiter.api.parallel.Execution
import org.junit.jupiter.api.parallel.ExecutionMode

// Temporary guard: mockkConstructor(GitOps/SummaryStore) is still a JVM-global
// bytecode swap. Remove when those collaborators become injectable.
@Isolated
// MockK's recorder is JVM-global; @Nested classes are scheduled as independent
// parallel units, so intra-class concurrency corrupts stubbing too. SAME_THREAD
// is inherited by all nested classes and serializes this whole file.
@Execution(ExecutionMode.SAME_THREAD)
class PostRewriteHookTest {

    @TempDir
    lateinit var tempDir: File

    @BeforeEach
    fun setUp() {
        File(tempDir, ".jolli/jollimemory").mkdirs()
        mockkConstructor(GitOps::class)
        mockkConstructor(SummaryStore::class)
    }

    @AfterEach
    fun tearDown() {
        unmockkAll()
    }

    /** Env whose cwd is the test's temp dir and whose stdin yields [stdin]. */
    private fun env(stdin: String): HookEnv =
        fakeHookEnv(stdinContent = stdin, userDir = tempDir, userHome = tempDir)

    private fun makeSummary(hash: String) = CommitSummary(
        commitHash = hash, commitMessage = "msg", commitAuthor = "Alice",
        commitDate = "2026-01-15T10:00:00Z", branch = "main", generatedAt = "2026-01-15T10:00:00Z",
    )

    @Test
    fun `migrates summary for hash mapping`() {
        every { anyConstructed<SummaryStore>().getSummary("oldhash123") } returns makeSummary("oldhash123")
        every { anyConstructed<SummaryStore>().findRootHash(any()) } returns null
        every { anyConstructed<GitOps>().exec("log", "-1", "--pretty=format:%H%x00%s%x00%an%x00%aI", "newhash456") } returns "newhash456\u0000New msg\u0000Bob\u00002026-01-16T00:00:00Z"
        every { anyConstructed<SummaryStore>().migrateOneToOne(any(), any()) } returns Unit

        PostRewriteHook.run(arrayOf("rebase"), env("oldhash123 newhash456\n"))

        verify { anyConstructed<SummaryStore>().migrateOneToOne(any(), any()) }
    }

    @Test
    fun `skips when no summary for old hash`() {
        every { anyConstructed<SummaryStore>().getSummary("oldhash") } returns null
        every { anyConstructed<SummaryStore>().findRootHash("oldhash") } returns null

        PostRewriteHook.run(arrayOf("amend"), env("oldhash newhash\n"))

        verify(exactly = 0) { anyConstructed<SummaryStore>().migrateOneToOne(any(), any()) }
    }

    @Test
    fun `handles blank stdin`() {
        PostRewriteHook.run(arrayOf("rebase"), env(""))
        verify(exactly = 0) { anyConstructed<SummaryStore>().getSummary(any()) }
    }

    @Test
    fun `handles stdin read failure`() {
        val throwingEnv = fakeHookEnv(
            readStdin = { throw RuntimeException("broken pipe") },
            userDir = tempDir,
            userHome = tempDir,
        )
        PostRewriteHook.run(arrayOf("rebase"), throwingEnv)
        verify(exactly = 0) { anyConstructed<SummaryStore>().getSummary(any()) }
    }

    @Test
    fun `processes multiple hash mappings`() {
        every { anyConstructed<SummaryStore>().getSummary("old1") } returns makeSummary("old1")
        every { anyConstructed<SummaryStore>().getSummary("old2") } returns null
        every { anyConstructed<SummaryStore>().findRootHash("old1") } returns null
        every { anyConstructed<SummaryStore>().findRootHash("old2") } returns null
        every { anyConstructed<GitOps>().exec("log", "-1", "--pretty=format:%H%x00%s%x00%an%x00%aI", "new1") } returns "new1\u0000Msg\u0000A\u00002026-01-15T00:00:00Z"
        every { anyConstructed<SummaryStore>().migrateOneToOne(any(), any()) } returns Unit

        PostRewriteHook.run(arrayOf("rebase"), env("old1 new1\nold2 new2\n"))

        // Only old1 has a summary, so only 1 migration
        verify(exactly = 1) { anyConstructed<SummaryStore>().migrateOneToOne(any(), any()) }
    }

    @Test
    fun `skips mapping when new hash commit info is null`() {
        every { anyConstructed<SummaryStore>().getSummary("old1") } returns makeSummary("old1")
        every { anyConstructed<SummaryStore>().findRootHash(any()) } returns null
        every { anyConstructed<GitOps>().exec("log", "-1", "--pretty=format:%H%x00%s%x00%an%x00%aI", "new1") } returns null

        PostRewriteHook.run(arrayOf("rebase"), env("old1 new1\n"))

        verify(exactly = 0) { anyConstructed<SummaryStore>().migrateOneToOne(any(), any()) }
    }

    @Test
    fun `falls back to root hash when direct summary not found`() {
        every { anyConstructed<SummaryStore>().getSummary("child1") } returns null
        every { anyConstructed<SummaryStore>().findRootHash("child1") } returns "root1"
        every { anyConstructed<SummaryStore>().getSummary("root1") } returns makeSummary("root1")
        every { anyConstructed<GitOps>().exec("log", "-1", "--pretty=format:%H%x00%s%x00%an%x00%aI", "new1") } returns "new1\u0000Msg\u0000A\u00002026-01-15T00:00:00Z"
        every { anyConstructed<SummaryStore>().migrateOneToOne(any(), any()) } returns Unit

        PostRewriteHook.run(arrayOf("rebase"), env("child1 new1\n"))

        verify { anyConstructed<SummaryStore>().migrateOneToOne(any(), any()) }
    }
}
