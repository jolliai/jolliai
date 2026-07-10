package ai.jolli.jollimemory.bridge

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.types.shouldBeInstanceOf
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

/**
 * Smoke tests for [CliIntegrations]. The heavy paths (running the bundled CLI, PATH
 * resolution) depend on the environment, so these assert the null-safe contract:
 * nothing throws, and a missing bundle degrades gracefully instead of erroring.
 */
class CliIntegrationsTest {

    @TempDir
    lateinit var tempDir: File

    @Test
    fun `resolveBundledCliJs does not throw (no cli-dist in the test classpath)`() {
        // In the test runtime there is no plugin cli-dist/, so this resolves to null
        // rather than throwing — the graceful path the installer relies on.
        CliIntegrations.resolveBundledCliJs() // must not throw
    }

    @Test
    fun `enableIntegrations degrades gracefully without a bundle or node`() {
        // With no bundled Cli.js on the test classpath, the result is never Ok and never
        // throws: NodeMissing (no node on PATH) or BundleMissing (node present, no bundle).
        val result = CliIntegrations.enableIntegrations(tempDir.absolutePath)
        result shouldNotBe CliIntegrations.Result.Ok
        result.shouldBeInstanceOf<CliIntegrations.Result>()
    }

    @Test
    fun `retryPendingPushes no-ops (no throw) when there is nothing pending`() {
        // No push-pending.json → the cheap pre-check returns before any Node work,
        // so a normal commit never pays a spawn. Must not throw, either mode.
        File(tempDir, ".jolli/jollimemory").mkdirs()
        CliIntegrations.retryPendingPushes(tempDir.absolutePath)
        CliIntegrations.retryPendingPushes(tempDir.absolutePath, waitForCompletion = true)
    }

    @Test
    fun `retryPendingPushes degrades gracefully when a pending file exists but no node`() {
        // With push-pending.json present the guard passes; with no node/bundle on the
        // test classpath it still returns cleanly (never throws) rather than erroring.
        File(tempDir, ".jolli/jollimemory").mkdirs()
        File(tempDir, ".jolli/jollimemory/push-pending.json")
            .writeText("""{"version":1,"entries":{"abc":{"branch":"x","enqueuedAt":"2026-01-01T00:00:00Z","retryCount":0}}}""")
        CliIntegrations.retryPendingPushes(tempDir.absolutePath, waitForCompletion = true)
    }

    // ── warningFor — every non-Ok result yields a user-facing message ──────

    @Test
    fun `warningFor Ok is null`() {
        CliIntegrations.warningFor(CliIntegrations.Result.Ok).shouldBeNull()
    }

    @Test
    fun `warningFor NodeMissing mentions Node and the skipped skills`() {
        val msg = CliIntegrations.warningFor(CliIntegrations.Result.NodeMissing)
        msg shouldNotBe null
        msg!! shouldContain "Node.js"
        msg shouldContain "/jolli-search"
        msg shouldContain "/jolli-pr"
    }

    @Test
    fun `warningFor BundleMissing is surfaced (not silent)`() {
        val msg = CliIntegrations.warningFor(CliIntegrations.Result.BundleMissing)
        msg shouldNotBe null
        msg!! shouldContain "bundled CLI"
    }

    @Test
    fun `warningFor Failed includes the underlying message`() {
        val msg = CliIntegrations.warningFor(CliIntegrations.Result.Failed("exit 1"))
        msg shouldNotBe null
        msg!! shouldContain "exit 1"
    }

    // ── integrationsUpToDate — stamp means "enabled", not merely "extracted" ──
    // Regression guard for the bug where extractCliDist() wrote the version stamp at
    // extraction time, so a FAILED enable still looked "up to date" and was never retried
    // (and the StatusPanel showed a false "active").

    @Test
    fun `extracted-but-not-enabled is NOT up to date`() {
        // Simulate the bundle having been copied (Cli.js present) with no successful enable
        // recorded (no .version stamp). This is exactly the extract-succeeded-enable-failed
        // state — it must report false so startup retries.
        File(tempDir, "Cli.js").writeText("bundle")
        CliIntegrations.integrationsUpToDate(tempDir) shouldBe false
    }

    @Test
    fun `up to date only after a successful enable is recorded`() {
        File(tempDir, "Cli.js").writeText("bundle")
        CliIntegrations.integrationsUpToDate(tempDir) shouldBe false // extracted only

        CliIntegrations.markIntegrationsEnabled(tempDir) // enable succeeded
        CliIntegrations.integrationsUpToDate(tempDir) shouldBe true

        CliIntegrations.clearIntegrationsEnabled(tempDir) // e.g. a later failure
        CliIntegrations.integrationsUpToDate(tempDir) shouldBe false // retries again
    }

    // ── mcpRegistrationStale — self-heal trigger for a dead .mcp.json ──────
    // Regression guard for the bug where .mcp.json's jollimemory entry pointed at a
    // `node <Cli.js>` under a removed VS Code extension dist. The version stamp stayed
    // current (env change, not a plugin upgrade), so startup never re-registered.

    @Test
    fun `mcpRegistrationStale false when there is no mcp json`() {
        CliIntegrations.mcpRegistrationStale(tempDir.absolutePath) shouldBe false
    }

    @Test
    fun `mcpRegistrationStale true when node Cli js path no longer exists`() {
        val gone = File(tempDir, "removed-extension/dist/Cli.js").absolutePath.replace("\\", "/")
        File(tempDir, ".mcp.json").writeText(
            """{"mcpServers":{"jollimemory":{"command":"node","args":["$gone","mcp"]}}}""",
        )
        CliIntegrations.mcpRegistrationStale(tempDir.absolutePath) shouldBe true
    }

    @Test
    fun `mcpRegistrationStale false when the node Cli js still exists`() {
        val cliJs = File(tempDir, "dist/Cli.js").apply { parentFile.mkdirs(); writeText("bundle") }
        File(tempDir, ".mcp.json").writeText(
            """{"mcpServers":{"jollimemory":{"command":"node","args":["${cliJs.absolutePath.replace("\\", "/")}","mcp"]}}}""",
        )
        CliIntegrations.mcpRegistrationStale(tempDir.absolutePath) shouldBe false
    }

    @Test
    fun `mcpRegistrationStale false for the POSIX run-cli indirection form`() {
        // The run-cli dispatch form re-resolves at spawn time and never goes stale, so a
        // non-node command is always treated as healthy regardless of whether it exists.
        File(tempDir, ".mcp.json").writeText(
            """{"mcpServers":{"jollimemory":{"command":"/home/u/.jolli/jollimemory/run-cli","args":["mcp"]}}}""",
        )
        CliIntegrations.mcpRegistrationStale(tempDir.absolutePath) shouldBe false
    }

    @Test
    fun `mcpRegistrationStale false when there is no jollimemory entry`() {
        File(tempDir, ".mcp.json").writeText("""{"mcpServers":{"other":{"command":"node","args":["x"]}}}""")
        CliIntegrations.mcpRegistrationStale(tempDir.absolutePath) shouldBe false
    }

    @Test
    fun `mcpRegistrationStale false on malformed json`() {
        File(tempDir, ".mcp.json").writeText("{ not json")
        CliIntegrations.mcpRegistrationStale(tempDir.absolutePath) shouldBe false
    }
}
