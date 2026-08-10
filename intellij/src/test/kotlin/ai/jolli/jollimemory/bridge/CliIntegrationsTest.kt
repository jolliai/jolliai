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

    // ── parseGenerateResponse — the `jolli generate` stdout contract ───────

    @Test
    fun `parseGenerateResponse returns the success object`() {
        val obj = CliIntegrations.parseGenerateResponse(
            """{"type":"commit-message","message":"Add feature"}""",
            "commit-message",
            0,
        )
        obj.get("message").asString shouldBe "Add feature"
    }

    @Test
    fun `parseGenerateResponse takes the last non-blank line (stray runtime noise ignored)`() {
        val stdout = "(node) some experimental warning\n\n" +
            """{"type":"recap","recap":"A recap."}""" + "\n"
        val obj = CliIntegrations.parseGenerateResponse(stdout, "recap", 0)
        obj.get("recap").asString shouldBe "A recap."
    }

    @Test
    fun `parseGenerateResponse surfaces the CLI error message`() {
        val ex = org.junit.jupiter.api.Assertions.assertThrows(RuntimeException::class.java) {
            CliIntegrations.parseGenerateResponse(
                """{"type":"error","message":"No LLM provider available."}""",
                "commit-message",
                1,
            )
        }
        ex.message shouldBe "No LLM provider available."
    }

    @Test
    fun `parseGenerateResponse maps LocalAgentAuthError to sign-in guidance`() {
        val stdout = """{"type":"error","message":"Claude Code returned an error (status 0): """ +
            """Not logged in · Please run /login","errorName":"LocalAgentAuthError"}"""
        val ex = org.junit.jupiter.api.Assertions.assertThrows(RuntimeException::class.java) {
            CliIntegrations.parseGenerateResponse(stdout, "commit-message", 1)
        }
        ex.message shouldContain "not signed in"
    }

    @Test
    fun `parseGenerateResponse fails loud on empty output`() {
        val ex = org.junit.jupiter.api.Assertions.assertThrows(RuntimeException::class.java) {
            CliIntegrations.parseGenerateResponse("\n  \n", "translate", 1)
        }
        ex.message shouldContain "no output"
    }

    @Test
    fun `parseGenerateResponse fails loud on unreadable output`() {
        val ex = org.junit.jupiter.api.Assertions.assertThrows(RuntimeException::class.java) {
            CliIntegrations.parseGenerateResponse("Segmentation fault", "translate", 139)
        }
        ex.message shouldContain "unreadable"
    }

    @Test
    fun `parseGenerateResponse rejects a non-zero exit even with success-shaped output`() {
        val ex = org.junit.jupiter.api.Assertions.assertThrows(RuntimeException::class.java) {
            CliIntegrations.parseGenerateResponse("""{"type":"translate","text":"x"}""", "translate", 1)
        }
        ex.message shouldContain "exit 1"
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
        msg shouldContain "/jolli-recall"
        msg shouldContain "/jolli-search"
    }

    @Test
    fun `warningFor NodeMissing quotes the detector's current floor, not a literal`() {
        // This result is produced by `resolveNode()` -> `NodeRuntime.detect()`, so the
        // warning has to name the same floor that rejected the runtime. Asserting the
        // constant (rather than a "Node.js" substring) is what catches a hard-coded
        // version: the message sat at 22.5 for a whole release after the floor moved to
        // 22.13, and the three substrings above stayed green the entire time.
        CliIntegrations.warningFor(CliIntegrations.Result.NodeMissing)!! shouldContain
            NodeRuntime.MIN_SUPPORTED_DISPLAY
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

    // ── isDistComplete — the extractCliDist short-circuit's completeness gate ──
    // Regression guard for the caching fast path: it used to check only `Cli.js` plus a
    // matching extract stamp, so a dist that lost a per-hook entry script AFTER the
    // stamp landed (external cleanup, AV quarantine) stayed broken for the rest of that
    // plugin version — no number of Enable clicks re-copied it, and the CLI's own
    // `isCompleteRuntimeDist` gate then refused to register the dist at all. The
    // expected set is derived from the bundle listing so there is no hand-maintained
    // mirror of REQUIRED_RUNTIME_FILES to drift.

    /** Builds a fake bundle dir with the given entry-script names and returns the listing. */
    private fun fakeBundle(vararg names: String): List<File> {
        val src = File(tempDir, "cli-dist").apply { mkdirs() }
        return names.map { File(src, it).apply { writeText("bundle") } }
    }

    @Test
    fun `isDistComplete true when every bundled entry script is present`() {
        val srcJs = fakeBundle("Cli.js", "StopHook.js", "QueueWorker.js")
        val dist = File(tempDir, "dist-intellij").apply { mkdirs() }
        srcJs.forEach { File(dist, it.name).writeText("copied") }
        CliIntegrations.isDistComplete(dist, srcJs) shouldBe true
    }

    @Test
    fun `isDistComplete false when a per-hook entry script is missing but Cli js is not`() {
        // The exact shape the old Cli.js-only check waved through.
        val srcJs = fakeBundle("Cli.js", "StopHook.js", "QueueWorker.js")
        val dist = File(tempDir, "dist-intellij").apply { mkdirs() }
        File(dist, "Cli.js").writeText("copied")
        File(dist, "StopHook.js").writeText("copied")
        // QueueWorker.js deliberately absent.
        CliIntegrations.isDistComplete(dist, srcJs) shouldBe false
    }

    @Test
    fun `isDistComplete false when the dist directory does not exist at all`() {
        val srcJs = fakeBundle("Cli.js", "StopHook.js")
        CliIntegrations.isDistComplete(File(tempDir, "never-extracted"), srcJs) shouldBe false
    }

    @Test
    fun `isDistComplete false when a dist entry is a directory rather than a file`() {
        // `isFile` (not `exists`) so a stray directory standing in for an entry script
        // cannot certify the dist — `run-hook` could not execute it.
        val srcJs = fakeBundle("Cli.js", "StopHook.js")
        val dist = File(tempDir, "dist-intellij").apply { mkdirs() }
        File(dist, "Cli.js").writeText("copied")
        File(dist, "StopHook.js").mkdirs()
        CliIntegrations.isDistComplete(dist, srcJs) shouldBe false
    }

    @Test
    fun `isDistComplete false for an empty source listing (never certifies an empty dist)`() {
        // A bundle we failed to list must fall through to the copy branch rather than
        // vacuously satisfying `all {}` on an empty collection.
        val dist = File(tempDir, "dist-intellij").apply { mkdirs() }
        CliIntegrations.isDistComplete(dist, emptyList()) shouldBe false
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

    // ── createSecureTempFile — 0600 on POSIX so `/tmp` neighbours can't
    // read the ide-bridge JSON (which carries token + jolliApiKey on the
    // handle-auth-callback response).

    @Test
    fun `createSecureTempFile creates an owner-read-write file on POSIX`() {
        // Skip on non-POSIX (Windows) — the helper falls back there.
        val fs = java.nio.file.FileSystems.getDefault()
        org.junit.jupiter.api.Assumptions.assumeTrue(fs.supportedFileAttributeViews().contains("posix"))

        val f = CliIntegrations.createSecureTempFile("jolli-secret-", ".json")
        try {
            f.exists() shouldBe true
            val perms = java.nio.file.Files.getPosixFilePermissions(f.toPath())
            // Exactly {OWNER_READ, OWNER_WRITE} — never GROUP_/OTHERS_ bits, which
            // would let another user on /tmp read the bearer token during the
            // finally-block delete window.
            perms shouldBe java.util.EnumSet.of(
                java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                java.nio.file.attribute.PosixFilePermission.OWNER_WRITE,
            )
        } finally {
            f.delete()
        }
    }

    @Test
    fun `createSecureTempFile does not throw on non-POSIX filesystems`() {
        // On Windows the PosixFilePermissions API throws UnsupportedOperationException
        // and we fall back to File.createTempFile. This test just asserts the helper
        // never propagates that up; the permission check above only runs on POSIX.
        val f = CliIntegrations.createSecureTempFile("jolli-fallback-", ".json")
        try {
            f.exists() shouldBe true
        } finally {
            f.delete()
        }
    }

    // ── parseSyncAgentHooksResponse — the `sync-agent-hooks` bridge contract ──
    // The CLI-side shape lives in cli/src/commands/IdeBridgeCommand.ts under
    // case "sync-agent-hooks". Keeping the parser as an internal fun lets the
    // JSON envelope be exercised without spawning the daemon.

    @Test
    fun `parseSyncAgentHooksResponse returns the healthy no-worktree shape`() {
        val json = com.google.gson.JsonParser.parseString(
            """{"manuallyDisabled":false,"worktrees":[],"failures":[]}""",
        )
        val r = CliIntegrations.parseSyncAgentHooksResponse(json)
        r.manuallyDisabled shouldBe false
        r.worktrees shouldBe emptyList()
        r.failures shouldBe emptyList()
    }

    @Test
    fun `parseSyncAgentHooksResponse honours manuallyDisabled short-circuit`() {
        val json = com.google.gson.JsonParser.parseString(
            """{"manuallyDisabled":true,"worktrees":[],"failures":[]}""",
        )
        val r = CliIntegrations.parseSyncAgentHooksResponse(json)
        // The CLI returns manuallyDisabled=true with empty arrays; the caller
        // is expected to skip the notification and let the user re-enable.
        r.manuallyDisabled shouldBe true
    }

    @Test
    fun `parseSyncAgentHooksResponse collects multiple worktrees and failures`() {
        val json = com.google.gson.JsonParser.parseString(
            """{"manuallyDisabled":false,"worktrees":["/repo","/repo.wt/feature"],"""
                + """"failures":["""
                + """{"worktree":"/repo","integration":"Claude","message":"EACCES"},"""
                + """{"worktree":"/repo.wt/feature","integration":"Gemini","message":"unreadable JSON"}"""
                + "]}",
        )
        val r = CliIntegrations.parseSyncAgentHooksResponse(json)
        r.worktrees shouldBe listOf("/repo", "/repo.wt/feature")
        r.failures.size shouldBe 2
        r.failures[0].worktree shouldBe "/repo"
        r.failures[0].integration shouldBe "Claude"
        r.failures[0].message shouldBe "EACCES"
        r.failures[1].integration shouldBe "Gemini"
    }

    @Test
    fun `parseSyncAgentHooksResponse rejects an envelope with manuallyDisabled field missing`() {
        // Fail-loud, symmetric with worktrees/failures. Silent-default to false
        // would make the caller SKIP the manual-disable balloon on a paused
        // repo — an over-suppress the user cannot see. The CLI-side handler
        // always writes the field (see the `sync-agent-hooks` case in
        // `cli/src/commands/IdeBridgeCommand.ts`), so its absence signals wire
        // drift, not a legitimate response.
        val ex = org.junit.jupiter.api.Assertions.assertThrows(RuntimeException::class.java) {
            CliIntegrations.parseSyncAgentHooksResponse(
                com.google.gson.JsonParser.parseString("""{"worktrees":["/repo"],"failures":[]}"""),
            )
        }
        ex.message shouldContain "unreadable"
        ex.message shouldContain "manuallyDisabled"
    }

    @Test
    fun `parseSyncAgentHooksResponse rejects manuallyDisabled not encoded as a boolean`() {
        // Wire-shape defence: a string/number in the boolean slot must not be
        // coerced. Matches the worktrees/failures typed-array checks.
        val ex = org.junit.jupiter.api.Assertions.assertThrows(RuntimeException::class.java) {
            CliIntegrations.parseSyncAgentHooksResponse(
                com.google.gson.JsonParser.parseString(
                    """{"manuallyDisabled":"true","worktrees":[],"failures":[]}""",
                ),
            )
        }
        ex.message shouldContain "unreadable"
        ex.message shouldContain "manuallyDisabled"
    }

    @Test
    fun `parseSyncAgentHooksResponse skips malformed failure entries without throwing`() {
        // Wrong element types under failures[] must not break the whole envelope
        // (one non-object failure entry cannot lose the whole worktree list).
        val json = com.google.gson.JsonParser.parseString(
            """{"manuallyDisabled":false,"worktrees":["/r"],"failures":["not-an-object",{"worktree":"/r","integration":"Claude","message":"x"}]}""",
        )
        val r = CliIntegrations.parseSyncAgentHooksResponse(json)
        r.failures.size shouldBe 1
        r.failures[0].message shouldBe "x"
    }

    @Test
    fun `parseSyncAgentHooksResponse rejects a non-object envelope`() {
        // A malformed response (e.g. a bare array or string) must throw so the
        // caller's outer catch shows the "sync failed" notification instead of
        // treating it as a healthy zero-worktree response.
        val ex = org.junit.jupiter.api.Assertions.assertThrows(RuntimeException::class.java) {
            CliIntegrations.parseSyncAgentHooksResponse(com.google.gson.JsonParser.parseString("""[]"""))
        }
        ex.message shouldContain "unreadable"
    }

    @Test
    fun `parseSyncAgentHooksResponse rejects an envelope with worktrees field missing`() {
        // A missing `worktrees` array is asymmetric with `manuallyDisabled`
        // (which safely defaults to false): silently defaulting worktrees to []
        // would collapse a malformed envelope into the healthy zero-worktree
        // response and hide real per-worktree failures behind "everything's
        // fine". The CLI-side handler always writes both worktrees and failures
        // (empty arrays included), so their absence is wire drift.
        val ex = org.junit.jupiter.api.Assertions.assertThrows(RuntimeException::class.java) {
            CliIntegrations.parseSyncAgentHooksResponse(
                com.google.gson.JsonParser.parseString("""{"manuallyDisabled":false,"failures":[]}"""),
            )
        }
        ex.message shouldContain "unreadable"
        ex.message shouldContain "worktrees"
    }

    @Test
    fun `parseSyncAgentHooksResponse rejects an envelope with failures field missing`() {
        val ex = org.junit.jupiter.api.Assertions.assertThrows(RuntimeException::class.java) {
            CliIntegrations.parseSyncAgentHooksResponse(
                com.google.gson.JsonParser.parseString("""{"manuallyDisabled":false,"worktrees":[]}"""),
            )
        }
        ex.message shouldContain "unreadable"
        ex.message shouldContain "failures"
    }

    @Test
    fun `parseSyncAgentHooksResponse rejects worktrees not encoded as an array`() {
        // Wire-shape defence: if the CLI ever regressed and shipped a string
        // (or object) under `worktrees`, the earlier code would either
        // silently return [] (via Gson's null-on-mismatch getAsJsonArray) or
        // ClassCastException on `.asJsonArray`. Force the explicit
        // "unreadable" contract instead.
        val ex = org.junit.jupiter.api.Assertions.assertThrows(RuntimeException::class.java) {
            CliIntegrations.parseSyncAgentHooksResponse(
                com.google.gson.JsonParser.parseString(
                    """{"manuallyDisabled":false,"worktrees":"oops","failures":[]}""",
                ),
            )
        }
        ex.message shouldContain "unreadable"
        ex.message shouldContain "worktrees"
    }

    @Test
    fun `parseSyncAgentHooksResponse rejects failures not encoded as an array`() {
        val ex = org.junit.jupiter.api.Assertions.assertThrows(RuntimeException::class.java) {
            CliIntegrations.parseSyncAgentHooksResponse(
                com.google.gson.JsonParser.parseString(
                    """{"manuallyDisabled":false,"worktrees":[],"failures":{"oops":1}}""",
                ),
            )
        }
        ex.message shouldContain "unreadable"
        ex.message shouldContain "failures"
    }

    // ── parseMigrateResponse — the `migrate-memory-bank` bridge contract ─────
    // CLI-side reference: cli/src/core/MemoryBankMigration.ts. Restores the
    // testing seam that the internal-fun predecessor carried on `main`.

    @Test
    fun `parseMigrateResponse returns the settled counts on success`() {
        val json = com.google.gson.JsonParser.parseString(
            """{"status":"completed","totalEntries":42,"migratedEntries":42}""",
        )
        val r = CliIntegrations.parseMigrateResponse(json)
        r.status shouldBe "completed"
        r.totalEntries shouldBe 42
        r.migratedEntries shouldBe 42
    }

    @Test
    fun `parseMigrateResponse handles the fresh-install empty run`() {
        val json = com.google.gson.JsonParser.parseString(
            """{"status":"completed","totalEntries":0,"migratedEntries":0}""",
        )
        val r = CliIntegrations.parseMigrateResponse(json)
        r.totalEntries shouldBe 0
        r.migratedEntries shouldBe 0
    }

    @Test
    fun `parseMigrateResponse defaults missing numeric counts to zero`() {
        // Belt-and-suspenders: a partial in-progress state ("dispatched" without
        // counts) is served by the migration engine before writes complete; the
        // parser must not throw NPE on a missing number.
        val json = com.google.gson.JsonParser.parseString("""{"status":"in_progress"}""")
        val r = CliIntegrations.parseMigrateResponse(json)
        r.status shouldBe "in_progress"
        r.totalEntries shouldBe 0
        r.migratedEntries shouldBe 0
    }

    @Test
    fun `parseMigrateResponse rejects a non-object envelope`() {
        val ex = org.junit.jupiter.api.Assertions.assertThrows(RuntimeException::class.java) {
            CliIntegrations.parseMigrateResponse(com.google.gson.JsonParser.parseString("null"))
        }
        ex.message shouldContain "unreadable"
    }
}
