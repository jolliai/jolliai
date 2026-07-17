package ai.jolli.jollimemory.hooks

import ai.jolli.jollimemory.core.SessionInfo
import ai.jolli.jollimemory.core.TranscriptSource
import ai.jolli.jollimemory.core.fakeHookEnv
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class StopHookTest {

    @TempDir
    lateinit var tempDir: File

    /** Runs the hook with a fake env; returns the sessions handed to saveSession. */
    private fun runHook(readStdin: () -> String): List<SessionInfo> {
        val saved = mutableListOf<SessionInfo>()
        StopHook.run(
            env = fakeHookEnv(readStdin = readStdin, userHome = tempDir, userDir = tempDir),
            saveSession = { info, _ -> saved.add(info) },
        )
        return saved
    }

    @Test
    fun `saves session from valid stdin JSON`() {
        // Escape backslashes for JSON — tempDir.absolutePath on Windows contains \\ which
        // would otherwise produce illegal JSON escape sequences (\U, \A, \L, ...).
        val cwdJson = tempDir.absolutePath.replace("\\", "\\\\")
        // transcript_path points inside tempDir and does not exist, so the
        // post-save discovery scan exits early without touching shared state.
        val transcriptPath = File(tempDir, "no-such-transcript.jsonl").absolutePath
        val transcriptJson = transcriptPath.replace("\\", "\\\\")
        val json = """{"session_id":"sess-123","transcript_path":"$transcriptJson","cwd":"$cwdJson"}"""

        val saved = runHook { json }

        saved.single().sessionId shouldBe "sess-123"
        saved.single().transcriptPath shouldBe transcriptPath
        saved.single().source shouldBe TranscriptSource.claude
    }

    @Test
    fun `returns early on empty stdin`() {
        runHook { "" }.shouldBeEmpty()
    }

    @Test
    fun `returns early on invalid JSON`() {
        runHook { "not json" }.shouldBeEmpty()
    }

    @Test
    fun `returns early on stdin read failure`() {
        runHook { throw RuntimeException("pipe broken") }.shouldBeEmpty()
    }
}
