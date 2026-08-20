package ai.jolli.jollimemory.core.telemetry

import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldHaveLength
import io.kotest.matchers.string.shouldMatch
import java.io.File
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class TelemetryTest {
    @TempDir
    lateinit var tempDir: File

    private val cwd: String get() = tempDir.absolutePath

    @AfterEach
    fun tearDown() = Telemetry.shutdown()

    // ── helpers ──
    @Test
    fun `bucket maps counts and clamps junk to 0`() {
        Telemetry.bucket(0) shouldBe "0"
        Telemetry.bucket(-3) shouldBe "0"
        Telemetry.bucket(1) shouldBe "1-5"
        Telemetry.bucket(5) shouldBe "1-5"
        Telemetry.bucket(6) shouldBe "6-20"
        Telemetry.bucket(20) shouldBe "6-20"
        Telemetry.bucket(21) shouldBe "21-100"
        Telemetry.bucket(100) shouldBe "21-100"
        Telemetry.bucket(101) shouldBe "100+"
    }

    @Test
    fun `queryLenBucket is coarse`() {
        Telemetry.queryLenBucket("short") shouldBe "short"
        Telemetry.queryLenBucket("a".repeat(40)) shouldBe "medium"
        Telemetry.queryLenBucket("a".repeat(120)) shouldBe "long"
    }

    @Test
    fun `saltedHash is deterministic, salt-sensitive, length-controlled`() {
        Telemetry.saltedHash("repo", "salt") shouldBe Telemetry.saltedHash("repo", "salt")
        (Telemetry.saltedHash("repo", "salt") == Telemetry.saltedHash("repo", "other")) shouldBe false
        Telemetry.saltedHash("repo", "salt").shouldHaveLength(12)
        Telemetry.saltedHash("repo", "salt", 8).shouldHaveLength(8)
        Telemetry.saltedHash("repo", "salt") shouldMatch Regex("^[0-9a-f]+$")
    }

    @Test
    fun `saltedHash matches the cross-surface golden value (NUL separator)`() {
        // SHA-256 of "s3cr3t\u0000repo-42", first 12 hex. The CLI Telemetry.test.ts
        // golden test asserts this exact value — if either surface's separator
        // drifts, one of the two fails, catching a silent hash mismatch.
        Telemetry.saltedHash("repo-42", "s3cr3t") shouldBe "5368b05c2866"
    }

    @Test
    fun `resolveEnv maps allowlisted origins and unknowns`() {
        Telemetry.resolveEnv("https://acme.jolli-local.me") shouldBe "local"
        Telemetry.resolveEnv("https://acme.jolli.dev") shouldBe "dev"
        Telemetry.resolveEnv("https://acme.jolli.cloud") shouldBe "preview"
        Telemetry.resolveEnv("https://acme.jolli.ai") shouldBe "prod"
        Telemetry.resolveEnv("https://jolli.ai") shouldBe "prod"
        Telemetry.resolveEnv(null) shouldBe "unknown"
        Telemetry.resolveEnv("not a url") shouldBe "unknown"
        Telemetry.resolveEnv("https://evil.example.com") shouldBe "unknown"
    }

    @Test
    fun `resolveEnv honors JOLLI_TELEMETRY_ENV=sandbox over origin`() {
        Telemetry.resolveEnv("https://acme.jolli.ai", mapOf("JOLLI_TELEMETRY_ENV" to "sandbox")) shouldBe "sandbox"
        Telemetry.resolveEnv(null, mapOf("JOLLI_TELEMETRY_ENV" to "sandbox")) shouldBe "sandbox"
    }

    @Test
    fun `resolveEnv ignores a non-sandbox JOLLI_TELEMETRY_ENV value`() {
        Telemetry.resolveEnv("https://acme.jolli.ai", mapOf("JOLLI_TELEMETRY_ENV" to "prod")) shouldBe "prod"
        Telemetry.resolveEnv("https://acme.jolli.ai", emptyMap()) shouldBe "prod"
    }

    @Test
    fun `scrubProperties keeps safe values and redacts content`() {
        val out =
            Telemetry.scrubProperties(
                mapOf(
                    "result_count_bucket" to "1-5",
                    "hit" to true,
                    "count" to 7,
                    "path" to "/Users/me/secret/repo",
                    "url" to "https://example.com/x",
                    "email" to "a@b.com",
                    "key" to "sk-jol-abcdef",
                    "long" to "x".repeat(200),
                    "token" to "abc",
                    "sources" to listOf("claude", "codex"),
                ),
            )
        out["result_count_bucket"] shouldBe "1-5"
        out["hit"] shouldBe true
        out["count"] shouldBe 7
        out["path"] shouldBe "[redacted:path]"
        out["url"] shouldBe "[redacted:url]"
        out["email"] shouldBe "[redacted:email]"
        out["key"] shouldBe "[redacted:secret]"
        out["long"] shouldBe "[redacted:long]"
        out.containsKey("token") shouldBe false

        @Suppress("UNCHECKED_CAST")
        (out["sources"] as List<Any?>) shouldContainExactly listOf("claude", "codex")
    }

    @Test
    fun `scrub redacts a mid-string token and content-derived keys`() {
        val out =
            Telemetry.scrubProperties(
                mapOf(
                    "detail" to "auth failed using ghp_AbC123def456ghi789",
                    "note" to "task-force review",
                    "/Users/alice/secret-proj" to 3,
                ),
            )
        out["detail"] shouldBe "[redacted:secret]"
        out["note"] shouldBe "task-force review"
        out.containsKey("/Users/alice/secret-proj") shouldBe false
        out["[redacted:path]"] shouldBe 3
    }

    @Test
    fun `scrub bounds depth`() {
        val nested = Telemetry.scrubProperties(mapOf("a" to mapOf("b" to mapOf("c" to mapOf("d" to mapOf("e" to 1))))))
        com.google.gson.Gson().toJson(nested) shouldMatch Regex(".*redacted:deep.*")
    }

    // ── track / init ──
    @Test
    fun `track is a no-op before init`() {
        Telemetry.track("recall_performed", mapOf("hit" to true))
        TelemetryBuffer.readLines(cwd) shouldHaveSize 0
    }

    @Test
    fun `track buffers a fully-formed envelope when enabled`() {
        Telemetry.init(cwd = cwd, installId = "install-1", surfaceVersion = "1.2.0", sessionId = "s9", origin = "https://acme.jolli.ai", env = emptyMap())
        Telemetry.track("recall_performed", mapOf("result_count_bucket" to "1-5", "hit" to true))
        val events = TelemetryBuffer.read(cwd)
        events shouldHaveSize 1
        val e = events[0]
        e.eventName shouldBe "recall_performed"
        e.surface shouldBe "intellij"
        e.surfaceVersion shouldBe "1.2.0"
        e.installId shouldBe "install-1"
        e.sessionId shouldBe "s9"
        e.env shouldBe "prod"
        e.accountId shouldBe null
    }

    /**
     * The `agent` dimension (CLI-side `core/TelemetryAgent.ts`) records which AI
     * host the work happened in. This port deliberately never emits it: an IDE is
     * not one of the hosts that vocabulary enumerates, and `surface: "intellij"`
     * already says where a tool-window click happened.
     *
     * Pinned with a marker PRESENT in the env because that is the tempting wrong
     * fix. This is a long-lived IDE process, so an inherited `CLAUDECODE` names
     * whatever launched the IDE — possibly days ago — and would then label every
     * button click for the rest of the window's life. The TS side defaults
     * `inferAgentFromEnv` to off for exactly this shape.
     */
    @Test
    fun `track never stamps an agent, even under an inherited host marker`() {
        Telemetry.init(
            cwd = cwd,
            installId = "install-1",
            surfaceVersion = "1.2.0",
            origin = "https://acme.jolli.ai",
            env = mapOf("CLAUDECODE" to "1", "AI_AGENT" to "claude-code_2-1-234_agent"),
        )
        // The tool window's Commit button; the busiest JVM-side event.
        Telemetry.track("memory_committed", mapOf("files_bucket" to "1-5", "has_conversations" to true))
        val e = TelemetryBuffer.read(cwd).single()
        e.surface shouldBe "intellij"
        e.properties.containsKey("agent") shouldBe false
    }

    @Test
    fun `track does not emit when consent is off`() {
        Telemetry.init(cwd = cwd, installId = "i", surfaceVersion = "1", telemetryFlag = "off", env = emptyMap())
        Telemetry.track("recall_performed")
        TelemetryBuffer.readLines(cwd) shouldHaveSize 0
    }

    @Test
    fun `track drops an unregistered event name`() {
        Telemetry.init(cwd = cwd, installId = "i", surfaceVersion = "1", env = emptyMap())
        Telemetry.track("totally_made_up")
        TelemetryBuffer.readLines(cwd) shouldHaveSize 0
    }

    @Test
    fun `track is a no-op again after shutdown`() {
        Telemetry.init(cwd = cwd, installId = "i", surfaceVersion = "1", env = emptyMap())
        Telemetry.shutdown()
        Telemetry.isInitialized() shouldBe false
        Telemetry.track("recall_performed")
        TelemetryBuffer.readLines(cwd) shouldHaveSize 0
    }
}
