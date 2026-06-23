package ai.jolli.jollimemory.core.telemetry

import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldMatch
import java.io.File
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class TelemetrySharedConfigTest {
    @TempDir
    lateinit var tempDir: File

    private val dir: String get() = tempDir.absolutePath

    private fun configFile() = File(dir, "config.json")

    @Test
    fun `mints a UUID on first call and persists it (created=true)`() {
        val (id, created) = TelemetrySharedConfig.getOrCreateInstallId(dir)
        created.shouldBeTrue()
        id shouldMatch Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        configFile().readText() shouldContain "\"installId\""
    }

    @Test
    fun `returns the existing id on subsequent calls (created=false)`() {
        val first = TelemetrySharedConfig.getOrCreateInstallId(dir)
        val second = TelemetrySharedConfig.getOrCreateInstallId(dir)
        second.second.shouldBeFalse()
        second.first shouldBe first.first
    }

    @Test
    fun `adopts the sentinel id when another run already claimed it (created=false)`() {
        // Simulate the race loser: the sentinel exists (winner claimed it) but
        // config.json has no installId yet. We must adopt the sentinel's id, not
        // mint our own, and not report created=true.
        File(dir).mkdirs()
        File(dir, "install-id").writeText("11111111-1111-4111-8111-111111111111")
        val (id, created) = TelemetrySharedConfig.getOrCreateInstallId(dir)
        created.shouldBeFalse()
        id shouldBe "11111111-1111-4111-8111-111111111111"
        configFile().readText() shouldContain "11111111-1111-4111-8111-111111111111"
    }

    @Test
    fun `preserves CLI-owned fields and integer formatting`() {
        configFile().writeText("""{"jolliApiKey":"sk-jol-x","maxTokens":4096}""", Charsets.UTF_8)
        TelemetrySharedConfig.getOrCreateInstallId(dir)
        val text = configFile().readText()
        text shouldContain "\"jolliApiKey\":\"sk-jol-x\""
        // JsonObject tree preserves the integer token — must NOT widen to 4096.0
        text shouldContain "\"maxTokens\":4096"
    }

    @Test
    fun `telemetry flag, notice, and setters round-trip`() {
        TelemetrySharedConfig.telemetryFlag(dir) shouldBe null
        TelemetrySharedConfig.noticeShown(dir).shouldBeFalse()

        TelemetrySharedConfig.setTelemetry(false, dir)
        TelemetrySharedConfig.telemetryFlag(dir) shouldBe "off"

        TelemetrySharedConfig.setTelemetry(true, dir)
        TelemetrySharedConfig.telemetryFlag(dir) shouldBe "on"
        TelemetrySharedConfig.noticeShown(dir).shouldBeTrue() // enabling marks notice shown
    }

    @Test
    fun `markNoticeShown sets the flag`() {
        TelemetrySharedConfig.markNoticeShown(dir)
        TelemetrySharedConfig.noticeShown(dir).shouldBeTrue()
    }

    @Test
    fun `markAiSourceSeen returns true only the first time per source`() {
        TelemetrySharedConfig.markAiSourceSeen("codex", dir) shouldBe true
        TelemetrySharedConfig.markAiSourceSeen("codex", dir) shouldBe false
        TelemetrySharedConfig.markAiSourceSeen("claude", dir) shouldBe true
        configFile().readText() shouldContain "codex"
        configFile().readText() shouldContain "claude"
    }

    @Test
    fun `corrupt config file is treated as empty`() {
        configFile().writeText("{not json", Charsets.UTF_8)
        val (_, created) = TelemetrySharedConfig.getOrCreateInstallId(dir)
        created.shouldBeTrue()
    }
}
