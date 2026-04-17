package ai.jolli.jollimemory.hooks

import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.core.SessionTracker
import io.kotest.matchers.shouldBe
import io.mockk.every
import io.mockk.mockkConstructor
import io.mockk.mockkObject
import io.mockk.slot
import io.mockk.unmockkAll
import io.mockk.verify
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class PrepareMsgHookTest {

    @TempDir
    lateinit var tempDir: File

    @BeforeEach
    fun setUp() {
        System.setProperty("user.dir", tempDir.absolutePath)
        File(tempDir, ".jolli/jollimemory").mkdirs()
        File(tempDir, ".git").mkdirs()
        mockkObject(SessionTracker)
        mockkConstructor(GitOps::class)
        every { anyConstructed<GitOps>().getHeadHash() } returns "headhash123456789012345678901234567890"
        every { SessionTracker.saveSquashPending(any(), any(), any()) } returns Unit
        every { SessionTracker.saveAmendPending(any(), any()) } returns Unit
        every { SessionTracker.ensureDir(any()) } returns tempDir.resolve(".jolli/jollimemory").absolutePath
    }

    @AfterEach
    fun tearDown() {
        unmockkAll()
    }

    @Nested
    inner class SquashHandling {
        @Test
        fun `saves squash pending when SQUASH_MSG has commit hashes`() {
            val squashMsg = File(tempDir, ".git/SQUASH_MSG")
            squashMsg.writeText("""
Squashed commits:
commit abc1234567890123456789012345678901234567890
commit def4567890123456789012345678901234567890abc
            """.trimIndent())

            PrepareMsgHook.run(arrayOf("COMMIT_EDITMSG", "squash"))

            val hashesSlot = slot<List<String>>()
            verify { SessionTracker.saveSquashPending(capture(hashesSlot), any(), any()) }
            hashesSlot.captured.size shouldBe 2
        }

        @Test
        fun `does nothing when SQUASH_MSG is missing`() {
            PrepareMsgHook.run(arrayOf("COMMIT_EDITMSG", "squash"))
            verify(exactly = 0) { SessionTracker.saveSquashPending(any(), any(), any()) }
        }

        @Test
        fun `does nothing when SQUASH_MSG has no hashes`() {
            File(tempDir, ".git/SQUASH_MSG").writeText("Some text without commit hashes")
            PrepareMsgHook.run(arrayOf("COMMIT_EDITMSG", "squash"))
            verify(exactly = 0) { SessionTracker.saveSquashPending(any(), any(), any()) }
        }
    }

    @Nested
    inner class AmendHandling {
        @Test
        fun `saves amend pending when oldHash matches HEAD`() {
            val headHash = "headhash123456789012345678901234567890"
            every { anyConstructed<GitOps>().getHeadHash() } returns headHash

            PrepareMsgHook.run(arrayOf("COMMIT_EDITMSG", "commit", headHash))

            verify { SessionTracker.saveAmendPending(headHash, any()) }
        }

        @Test
        fun `does nothing when oldHash differs from HEAD`() {
            every { anyConstructed<GitOps>().getHeadHash() } returns "headhash1234"
            PrepareMsgHook.run(arrayOf("COMMIT_EDITMSG", "commit", "differenthash"))
            verify(exactly = 0) { SessionTracker.saveAmendPending(any(), any()) }
        }

        @Test
        fun `does nothing when oldHash is null`() {
            PrepareMsgHook.run(arrayOf("COMMIT_EDITMSG", "commit"))
            verify(exactly = 0) { SessionTracker.saveAmendPending(any(), any()) }
        }
    }

    @Test
    fun `does nothing for regular commit source`() {
        PrepareMsgHook.run(arrayOf("COMMIT_EDITMSG", "message"))
        verify(exactly = 0) { SessionTracker.saveSquashPending(any(), any(), any()) }
        verify(exactly = 0) { SessionTracker.saveAmendPending(any(), any()) }
    }

    @Test
    fun `does nothing when source is absent`() {
        PrepareMsgHook.run(arrayOf("COMMIT_EDITMSG"))
        verify(exactly = 0) { SessionTracker.saveSquashPending(any(), any(), any()) }
        verify(exactly = 0) { SessionTracker.saveAmendPending(any(), any()) }
    }

    @Nested
    inner class ResolveGitFile {
        @Test
        fun `resolves file from worktree gitdir`() {
            val worktreeGitDir = File(tempDir, "wt-gitdir").apply { mkdirs() }
            File(tempDir, ".git").delete() // remove directory
            File(tempDir, ".git").writeText("gitdir: ${worktreeGitDir.absolutePath}")
            File(worktreeGitDir, "SQUASH_MSG").writeText("commit abc1234567890123456789012345678901234567890")

            PrepareMsgHook.run(arrayOf("COMMIT_EDITMSG", "squash"))

            verify { SessionTracker.saveSquashPending(any(), any(), any()) }
        }
    }
}
