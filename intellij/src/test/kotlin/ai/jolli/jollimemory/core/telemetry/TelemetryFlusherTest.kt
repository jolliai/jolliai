package ai.jolli.jollimemory.core.telemetry

import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import java.io.File
import java.util.Base64
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class TelemetryFlusherTest {
    @TempDir
    lateinit var tempDir: File

    private val cwd: String get() = tempDir.absolutePath

    private class CapturingSender(private val ok: Boolean = true, val onSend: (() -> Unit)? = null) :
        TelemetryFlusher.Sender {
        data class Call(val url: String, val body: String, val bearer: String?)

        val calls = mutableListOf<Call>()

        override fun send(url: String, body: String, bearer: String?): Boolean {
            calls.add(Call(url, body, bearer))
            onSend?.invoke()
            return ok
        }
    }

    private fun env(installId: String) =
        TelemetryEnvelope(
            schemaVersion = 1,
            eventId = "33333333-3333-4333-8333-333333333333",
            eventName = "app_installed",
            surface = "intellij",
            surfaceVersion = "1.0.0",
            installId = installId,
            os = "mac",
            arch = "arm64",
            runtimeVersion = "jvm-21",
            env = "local",
            tsIso = "2026-06-20T00:00:00.000Z",
            accountId = null,
            properties = emptyMap(),
        )

    private fun seed(n: Int) {
        for (i in 0 until n) TelemetryBuffer.append(cwd, env("i-$i"))
    }

    private fun makeKey(u: String): String {
        val meta = """{"t":"tenant","u":"$u"}"""
        val b64 = Base64.getUrlEncoder().encodeToString(meta.toByteArray(Charsets.UTF_8))
        return "sk-jol-$b64.sig"
    }

    @Test
    fun `no-ops on empty buffer`() {
        val sender = CapturingSender()
        TelemetryFlusher.flush(cwd, origin = "https://jolli.ai", sender = sender) shouldBe
            TelemetryFlusher.FlushResult(0, 0)
        sender.calls shouldHaveSize 0
    }

    @Test
    fun `keeps events when no origin resolves`() {
        seed(3)
        val sender = CapturingSender()
        TelemetryFlusher.flush(cwd, origin = null, sender = sender) shouldBe
            TelemetryFlusher.FlushResult(0, 3)
        sender.calls shouldHaveSize 0
    }

    @Test
    fun `refuses to send to a non-allowlisted origin and keeps events`() {
        seed(3)
        val sender = CapturingSender(ok = true)
        TelemetryFlusher.flush(cwd, origin = "https://evil.example.com", sender = sender) shouldBe
            TelemetryFlusher.FlushResult(0, 3)
        sender.calls shouldHaveSize 0
        TelemetryBuffer.readLines(cwd) shouldHaveSize 3
    }

    @Test
    fun `refuses to send when a key decodes to a non-allowlisted tenant`() {
        seed(2)
        val sender = CapturingSender(ok = true)
        TelemetryFlusher.flush(cwd, origin = "https://jolli.ai", jolliApiKey = makeKey("https://evil.example.com"), sender = sender) shouldBe
            TelemetryFlusher.FlushResult(0, 2)
        sender.calls shouldHaveSize 0
    }

    @Test
    fun `sends anonymously and clears the buffer on success`() {
        seed(2)
        val sender = CapturingSender(ok = true)
        val result = TelemetryFlusher.flush(cwd, origin = "https://jolli.ai", sender = sender)
        result shouldBe TelemetryFlusher.FlushResult(2, 0)
        sender.calls shouldHaveSize 1
        sender.calls[0].url shouldBe "https://jolli.ai/api/telemetry/events"
        sender.calls[0].bearer shouldBe null
        sender.calls[0].body shouldContain "\"events\":["
        TelemetryBuffer.readLines(cwd) shouldHaveSize 0
    }

    @Test
    fun `sends Bearer and targets the key tenant origin when signed in`() {
        seed(1)
        val sender = CapturingSender(ok = true)
        TelemetryFlusher.flush(cwd, origin = "https://jolli.ai", jolliApiKey = makeKey("https://acme.jolli.ai"), sender = sender)
        sender.calls[0].url shouldBe "https://acme.jolli.ai/api/telemetry/events"
        (sender.calls[0].bearer?.startsWith("sk-jol-")) shouldBe true
    }

    @Test
    fun `falls back to anonymous when the key cannot be decoded`() {
        seed(1)
        val sender = CapturingSender(ok = true)
        TelemetryFlusher.flush(cwd, origin = "https://jolli.ai", jolliApiKey = "sk-jol-garbage", sender = sender)
        sender.calls[0].url shouldBe "https://jolli.ai/api/telemetry/events"
        sender.calls[0].bearer shouldBe null
    }

    @Test
    fun `chunks into batches of at most maxBatch`() {
        seed(5)
        val sender = CapturingSender(ok = true)
        val result = TelemetryFlusher.flush(cwd, origin = "https://jolli.ai", maxBatch = 2, sender = sender)
        result shouldBe TelemetryFlusher.FlushResult(5, 0)
        sender.calls shouldHaveSize 3 // 2 + 2 + 1
    }

    @Test
    fun `stops on the first failing batch and keeps the remainder`() {
        seed(5)
        var n = 0
        val sender =
            object : TelemetryFlusher.Sender {
                override fun send(url: String, body: String, bearer: String?): Boolean {
                    n++
                    return n == 1 // first batch ok, second fails
                }
            }
        val result = TelemetryFlusher.flush(cwd, origin = "https://jolli.ai", maxBatch = 2, sender = sender)
        result shouldBe TelemetryFlusher.FlushResult(2, 3)
        TelemetryBuffer.read(cwd).map { it.installId } shouldBe listOf("i-2", "i-3", "i-4")
    }

    @Test
    fun `preserves events appended during the flush`() {
        seed(3)
        val sender = CapturingSender(ok = true, onSend = { TelemetryBuffer.append(cwd, env("late")) })
        val result = TelemetryFlusher.flush(cwd, origin = "https://jolli.ai", maxBatch = 10, sender = sender)
        result.sent shouldBe 3
        TelemetryBuffer.read(cwd).map { it.installId } shouldBe listOf("late")
    }
}
