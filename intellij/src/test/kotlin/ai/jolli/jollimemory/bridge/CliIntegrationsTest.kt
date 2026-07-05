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
}
