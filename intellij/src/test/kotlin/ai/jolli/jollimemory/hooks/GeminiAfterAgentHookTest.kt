package ai.jolli.jollimemory.hooks

import ai.jolli.jollimemory.core.SessionInfo
import ai.jolli.jollimemory.core.TranscriptSource
import ai.jolli.jollimemory.core.fakeHookEnv
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.PrintStream

class GeminiAfterAgentHookTest {

    @TempDir
    lateinit var tempDir: File

    private class HookRun(val saved: List<SessionInfo>, val stdout: String)

    /** Runs the hook with a fake env; captures saved sessions and stdout. */
    private fun runHook(readStdin: () -> String): HookRun {
        val out = ByteArrayOutputStream()
        val saved = mutableListOf<SessionInfo>()
        GeminiAfterAgentHook.run(
            env = fakeHookEnv(readStdin = readStdin, stdout = PrintStream(out), userHome = tempDir, userDir = tempDir),
            saveSession = { info, _ -> saved.add(info) },
        )
        return HookRun(saved, out.toString())
    }

    @Test
    fun `saves gemini session from valid stdin`() {
        // Escape backslashes for JSON — tempDir.absolutePath on Windows contains \\ which
        // would otherwise produce illegal JSON escape sequences (\U, \A, \L, ...).
        val cwdJson = tempDir.absolutePath.replace("\\", "\\\\")
        val json = """{"session_id":"gem-456","transcript_path":"/tmp/gemini.json","cwd":"$cwdJson"}"""

        val run = runHook { json }

        run.saved.single().sessionId shouldBe "gem-456"
        run.saved.single().source shouldBe TranscriptSource.gemini
    }

    @Test
    fun `always writes empty JSON to stdout`() {
        val run = runHook { "" }
        run.stdout.trim() shouldBe "{}"
    }

    @Test
    fun `writes empty JSON even on stdin failure`() {
        val run = runHook { throw RuntimeException("broken") }
        run.stdout.trim() shouldBe "{}"
        run.saved.shouldBeEmpty()
    }

    @Test
    fun `does not save session on invalid JSON`() {
        val run = runHook { "not json" }
        run.saved.shouldBeEmpty()
        run.stdout.trim() shouldBe "{}"
    }
}
