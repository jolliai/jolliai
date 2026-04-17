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
import java.io.File

class StopHookTest {

    @TempDir
    lateinit var tempDir: File

    @BeforeEach
    fun setUp() {
        mockkObject(SessionTracker)
        mockkStatic(::readStdin)
        every { SessionTracker.ensureDir(any()) } returns tempDir.resolve(".jolli/jollimemory").apply { mkdirs() }.absolutePath
        every { SessionTracker.saveSession(any(), any()) } returns Unit
    }

    @AfterEach
    fun tearDown() {
        unmockkAll()
    }

    @Test
    fun `saves session from valid stdin JSON`() {
        val json = """{"session_id":"sess-123","transcript_path":"/tmp/transcript.jsonl","cwd":"${tempDir.absolutePath}"}"""
        every { readStdin() } returns json

        StopHook.run()

        val sessionSlot = slot<ai.jolli.jollimemory.core.SessionInfo>()
        verify { SessionTracker.saveSession(capture(sessionSlot), any()) }
        sessionSlot.captured.sessionId shouldBe "sess-123"
        sessionSlot.captured.transcriptPath shouldBe "/tmp/transcript.jsonl"
        sessionSlot.captured.source shouldBe TranscriptSource.claude
    }

    @Test
    fun `returns early on empty stdin`() {
        every { readStdin() } returns ""
        StopHook.run()
        verify(exactly = 0) { SessionTracker.saveSession(any(), any()) }
    }

    @Test
    fun `returns early on invalid JSON`() {
        every { readStdin() } returns "not json"
        StopHook.run()
        verify(exactly = 0) { SessionTracker.saveSession(any(), any()) }
    }

    @Test
    fun `returns early on stdin read failure`() {
        every { readStdin() } throws RuntimeException("pipe broken")
        StopHook.run()
        verify(exactly = 0) { SessionTracker.saveSession(any(), any()) }
    }
}
