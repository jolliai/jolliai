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
}
