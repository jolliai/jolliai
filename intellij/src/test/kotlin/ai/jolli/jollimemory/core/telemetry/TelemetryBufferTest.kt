package ai.jolli.jollimemory.core.telemetry

import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import java.io.File
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class TelemetryBufferTest {
    @TempDir
    lateinit var tempDir: File

    private val cwd: String get() = tempDir.absolutePath

    private fun env(
        installId: String = "install-1",
        eventName: String = "recall_performed",
        properties: Map<String, Any?> = mapOf("hit" to true),
    ) = TelemetryEnvelope(
        schemaVersion = 1,
        eventId = "22222222-2222-4222-8222-222222222222",
        eventName = eventName,
        surface = "intellij",
        surfaceVersion = "1.0.0",
        installId = installId,
        sessionId = "s1",
        os = "mac",
        arch = "arm64",
        runtimeVersion = "jvm-21",
        env = "local",
        tsIso = "2026-06-20T00:00:00.000Z",
        accountId = null,
        properties = properties,
    )

    private fun queueFile() = File("$cwd/.jolli/jollimemory/telemetry-queue.ndjson")

    @Test
    fun `append then read round-trips (missing file starts empty)`() {
        TelemetryBuffer.readLines(cwd) shouldHaveSize 0
        TelemetryBuffer.append(cwd, env(eventName = "app_installed"))
        TelemetryBuffer.append(cwd, env(eventName = "search_performed"))
        TelemetryBuffer.readLines(cwd) shouldHaveSize 2
        val parsed = TelemetryBuffer.read(cwd)
        parsed shouldHaveSize 2
        parsed[0].eventName shouldBe "app_installed"
        parsed[1].eventName shouldBe "search_performed"
    }

    @Test
    fun `compacts in place when the file exceeds MAX_BYTES`() {
        val big = env(properties = mapOf("pad" to "x".repeat(500)))
        val perEvent = com.google.gson.Gson().toJson(big).length + 1
        val count = ((TelemetryBuffer.MAX_BYTES * 2) / perEvent).toInt() + 1
        repeat(count) { TelemetryBuffer.append(cwd, big) }
        (queueFile().length() <= TelemetryBuffer.MAX_BYTES) shouldBe true
        TelemetryBuffer.readLines(cwd) shouldHaveSize TelemetryBuffer.MAX_EVENTS
    }

    @Test
    fun `read caps to the newest MAX_EVENTS`() {
        for (i in 0 until TelemetryBuffer.MAX_EVENTS + 10) {
            TelemetryBuffer.append(cwd, env(installId = "i-$i"))
        }
        val lines = TelemetryBuffer.readLines(cwd)
        lines shouldHaveSize TelemetryBuffer.MAX_EVENTS
        // oldest 10 dropped → first kept is i-10
        (lines.first().contains("\"installId\":\"i-10\"")) shouldBe true
    }

    @Test
    fun `read skips a corrupt line but keeps the rest`() {
        val f = queueFile()
        f.parentFile.mkdirs()
        f.writeText(
            "${com.google.gson.Gson().toJson(env(installId = "good-1"))}\n" +
                "{torn json\n\n" +
                "${com.google.gson.Gson().toJson(env(installId = "good-2"))}\n",
            Charsets.UTF_8,
        )
        TelemetryBuffer.read(cwd).map { it.installId } shouldBe listOf("good-1", "good-2")
    }

    @Test
    fun `replaceLines overwrites and caps, and empty input removes the file`() {
        TelemetryBuffer.append(cwd, env(installId = "old"))
        TelemetryBuffer.replaceLines(cwd, listOf("""{"a":1}""", """{"b":2}"""))
        TelemetryBuffer.readLines(cwd) shouldHaveSize 2

        TelemetryBuffer.replaceLines(cwd, emptyList())
        TelemetryBuffer.readLines(cwd) shouldHaveSize 0
        queueFile().exists() shouldBe false
    }

    @Test
    fun `clear removes the buffer and is idempotent`() {
        TelemetryBuffer.append(cwd, env())
        TelemetryBuffer.clear(cwd)
        TelemetryBuffer.readLines(cwd) shouldHaveSize 0
        TelemetryBuffer.clear(cwd) // no throw when already absent
    }
}
