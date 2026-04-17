package ai.jolli.jollimemory.hooks

import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.TranscriptSource
import io.kotest.matchers.shouldBe
import io.mockk.every
import io.mockk.mockkObject
import io.mockk.mockkStatic
import io.mockk.slot
import io.mockk.unmockkAll
import io.mockk.verify
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.PrintStream

class GeminiAfterAgentHookTest {

    @TempDir
    lateinit var tempDir: File

    private val originalOut = System.out
    private val capturedOut = ByteArrayOutputStream()

    @BeforeEach
    fun setUp() {
        System.setOut(PrintStream(capturedOut))
        mockkObject(SessionTracker)
        mockkStatic(::readStdin)
        every { SessionTracker.ensureDir(any()) } returns tempDir.resolve(".jolli/jollimemory").apply { mkdirs() }.absolutePath
        every { SessionTracker.saveSession(any(), any()) } returns Unit
    }

    @AfterEach
    fun tearDown() {
        System.setOut(originalOut)
        unmockkAll()
    }

    @Test
    fun `saves gemini session from valid stdin`() {
        val json = """{"session_id":"gem-456","transcript_path":"/tmp/gemini.json","cwd":"${tempDir.absolutePath}"}"""
        every { readStdin() } returns json

        GeminiAfterAgentHook.run()

        val sessionSlot = slot<ai.jolli.jollimemory.core.SessionInfo>()
        verify { SessionTracker.saveSession(capture(sessionSlot), any()) }
        sessionSlot.captured.sessionId shouldBe "gem-456"
        sessionSlot.captured.source shouldBe TranscriptSource.gemini
    }

    @Test
    fun `always writes empty JSON to stdout`() {
        every { readStdin() } returns ""
        GeminiAfterAgentHook.run()
        capturedOut.toString().trim() shouldBe "{}"
    }

    @Test
    fun `writes empty JSON even on stdin failure`() {
        every { readStdin() } throws RuntimeException("broken")
        GeminiAfterAgentHook.run()
        capturedOut.toString().trim() shouldBe "{}"
        verify(exactly = 0) { SessionTracker.saveSession(any(), any()) }
    }

    @Test
    fun `does not save session on invalid JSON`() {
        every { readStdin() } returns "not json"
        GeminiAfterAgentHook.run()
        verify(exactly = 0) { SessionTracker.saveSession(any(), any()) }
        capturedOut.toString().trim() shouldBe "{}"
    }
}
