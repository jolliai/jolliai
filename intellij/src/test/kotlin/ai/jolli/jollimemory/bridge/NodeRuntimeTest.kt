package ai.jolli.jollimemory.bridge

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.types.shouldBeInstanceOf
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.api.parallel.Isolated
import java.io.File

/**
 * Tests for the pure/deterministic parts of [NodeRuntime]: shell-output PATH
 * extraction, version parsing/sorting, and the node-info.json record round-trip.
 * The live probes (shell spawning, binary verification) depend on the host
 * environment and are exercised implicitly by the callers' graceful-degradation
 * tests (see CliIntegrationsTest).
 *
 * `@Isolated`: NodeRuntime is a process-wide singleton (cachedInfo /
 * detectionDone / rejectedList / env). This suite's @AfterEach calls
 * `resetForTest()` to null those fields, which would race any concurrent
 * test class that indirectly reaches NodeRuntime.detect() (e.g. via
 * `CliIntegrations.resolveNode()`). Running this class alone against the
 * rest of the suite is the least-invasive fix until the singleton is
 * refactored behind an injected instance.
 */
@Isolated
class NodeRuntimeTest {

    @TempDir
    lateinit var tempDir: File

    @AfterEach
    fun resetSingletonState() {
        // adoptManualSelection mutates the NodeRuntime singleton's in-process cache;
        // clear it so other tests in this JVM see a fresh detector.
        NodeRuntime.resetForTest()
    }

    private val isWindows = System.getProperty("os.name").lowercase().contains("win")

    /** Writes an executable fake `node` script that prints [version] for --version. */
    private fun fakeNode(version: String): File {
        val script = File(tempDir, "node")
        script.writeText("#!/bin/sh\necho $version\n")
        script.setExecutable(true)
        return script
    }

    // ── extractMarkedPath — sentinel extraction survives rc-file noise ──────

    @Test
    fun `extractMarkedPath returns the marked PATH`() {
        NodeRuntime.extractMarkedPath("__JOLLI_PATH_START__/usr/bin:/bin__JOLLI_PATH_END__") shouldBe
            "/usr/bin:/bin"
    }

    @Test
    fun `extractMarkedPath ignores rc-file noise around the markers`() {
        val out = "Welcome banner\nnvm warning: something\n" +
            "__JOLLI_PATH_START__/opt/homebrew/bin:/usr/bin__JOLLI_PATH_END__\ntrailing prompt"
        NodeRuntime.extractMarkedPath(out) shouldBe "/opt/homebrew/bin:/usr/bin"
    }

    @Test
    fun `extractMarkedPath uses the LAST start marker (rc file echoed the command)`() {
        val out = "echo __JOLLI_PATH_START__ noise\n" +
            "__JOLLI_PATH_START__/real/path__JOLLI_PATH_END__"
        NodeRuntime.extractMarkedPath(out) shouldBe "/real/path"
    }

    @Test
    fun `extractMarkedPath is null when markers are missing or empty`() {
        NodeRuntime.extractMarkedPath("no markers at all").shouldBeNull()
        NodeRuntime.extractMarkedPath("__JOLLI_PATH_START__/no/end/marker").shouldBeNull()
        NodeRuntime.extractMarkedPath("__JOLLI_PATH_START____JOLLI_PATH_END__").shouldBeNull()
    }

    // ── parseVersionOutput — `node --version` output shapes ────────────────

    @Test
    fun `parseVersionOutput reads a plain version line`() {
        NodeRuntime.parseVersionOutput("v22.14.0\n") shouldBe "v22.14.0"
    }

    @Test
    fun `parseVersionOutput ignores surrounding noise lines`() {
        NodeRuntime.parseVersionOutput("some warning\nv18.19.1\n") shouldBe "v18.19.1"
    }

    @Test
    fun `parseVersionOutput is null for non-version output`() {
        NodeRuntime.parseVersionOutput("command not found").shouldBeNull()
        NodeRuntime.parseVersionOutput("").shouldBeNull()
    }

    // ── versionMajor — minimum-version gate input ───────────────────────────

    @Test
    fun `versionMajor parses the major component`() {
        NodeRuntime.versionMajor("v22.14.0") shouldBe 22
        NodeRuntime.versionMajor("v8.17.0") shouldBe 8
        NodeRuntime.versionMajor("v18.0.0-nightly") shouldBe 18
    }

    @Test
    fun `versionMajor is null for unparseable input`() {
        NodeRuntime.versionMajor("garbage").shouldBeNull()
        NodeRuntime.versionMajor("22.14.0").shouldBeNull()
        NodeRuntime.versionMajor("").shouldBeNull()
    }

    // ── parseRegInstallPath — Windows MSI registry record ───────────────────

    @Test
    fun `parseRegInstallPath reads the InstallPath value from reg query output`() {
        val out = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Node.js\r\n" +
            "    InstallPath    REG_SZ    C:\\Program Files\\nodejs\\\r\n\r\n"
        NodeRuntime.parseRegInstallPath(out) shouldBe "C:\\Program Files\\nodejs\\"
    }

    @Test
    fun `parseRegInstallPath handles REG_EXPAND_SZ and is null when absent`() {
        val expand = "    InstallPath    REG_EXPAND_SZ    D:\\tools\\node\r\n"
        NodeRuntime.parseRegInstallPath(expand) shouldBe "D:\\tools\\node"
        NodeRuntime.parseRegInstallPath("ERROR: The system was unable to find the specified registry key.")
            .shouldBeNull()
    }

    // ── versionSortKey — newest-first ordering of version-manager dirs ─────

    @Test
    fun `versionSortKey orders semver directory names numerically`() {
        val sorted = listOf("v8.17.0", "v22.14.0", "v10.24.1", "v22.9.0")
            .sortedByDescending { NodeRuntime.versionSortKey(it) }
        sorted shouldBe listOf("v22.14.0", "v22.9.0", "v10.24.1", "v8.17.0")
    }

    @Test
    fun `versionSortKey sorts unparseable names last`() {
        val sorted = listOf("alias", "v20.1.0").sortedByDescending { NodeRuntime.versionSortKey(it) }
        sorted shouldBe listOf("v20.1.0", "alias")
    }

    @Test
    fun `versionSortKey accepts unprefixed version names (mise layout)`() {
        val sorted = listOf("20.11.1", "22.14.0").sortedByDescending { NodeRuntime.versionSortKey(it) }
        sorted shouldBe listOf("22.14.0", "20.11.1")
    }

    // ── node-info.json record round-trip ────────────────────────────────────

    @Test
    fun `write then read round-trips path and version`() {
        val file = File(tempDir, "node-info.json")
        val info = NodeInfo("/opt/homebrew/bin/node", "v22.14.0")
        NodeRuntime.writeRecordedInfo(file, info)
        NodeRuntime.readRecordedInfo(file) shouldBe info
    }

    @Test
    fun `write creates missing parent directories`() {
        val file = File(tempDir, "nested/dir/node-info.json")
        NodeRuntime.writeRecordedInfo(file, NodeInfo("/usr/local/bin/node", "v20.11.0"))
        NodeRuntime.readRecordedInfo(file) shouldBe NodeInfo("/usr/local/bin/node", "v20.11.0")
    }

    @Test
    fun `read is null for a missing file`() {
        NodeRuntime.readRecordedInfo(File(tempDir, "absent.json")).shouldBeNull()
    }

    // ── node-path sibling — the shell dispatchers' plain-text fallback record ──

    @Test
    fun `writeRecordedInfo writes the bare path to the node-path sibling`() {
        val file = File(tempDir, "node-info.json")
        NodeRuntime.writeRecordedInfo(file, NodeInfo("/opt/homebrew/bin/node", "v22.14.0"))
        // One line, the exact absolute path — run-hook / run-cli read it with sed,
        // so the format must stay this trivial.
        File(tempDir, "node-path").readText() shouldBe "/opt/homebrew/bin/node\n"
    }

    @Test
    fun `node-path lands next to the record file even in nested dirs`() {
        val file = File(tempDir, "nested/dir/node-info.json")
        NodeRuntime.writeRecordedInfo(file, NodeInfo("/usr/local/bin/node", "v20.11.0"))
        File(tempDir, "nested/dir/node-path").readText() shouldBe "/usr/local/bin/node\n"
    }

    // ── isNodeExecutableName — the chooser-side filename filter ─────────────

    @Test
    fun `isNodeExecutableName accepts only node binaries (case-insensitive)`() {
        NodeRuntime.isNodeExecutableName("node") shouldBe true
        NodeRuntime.isNodeExecutableName("node.exe") shouldBe true
        NodeRuntime.isNodeExecutableName("Node.EXE") shouldBe true
        NodeRuntime.isNodeExecutableName("node.cmd") shouldBe true
        NodeRuntime.isNodeExecutableName("nodemon") shouldBe false
        NodeRuntime.isNodeExecutableName("node.txt") shouldBe false
        NodeRuntime.isNodeExecutableName("npm") shouldBe false
    }

    // ── adoptManualSelection — user-picked binaries get the same proof ──────

    @Test
    fun `adoptManualSelection rejects a missing or non-executable pick`() {
        val record = File(tempDir, "record.json")
        NodeRuntime.adoptManualSelection(File(tempDir, "absent").absolutePath, record)
            .shouldBeInstanceOf<NodeRuntime.ManualSelectionResult.NotExecutable>()
        record.exists() shouldBe false
    }

    @Test
    fun `adoptManualSelection rejects a file that is not node`() {
        Assumptions.assumeTrue(!isWindows) // fake executable is a POSIX shell script
        val notNode = File(tempDir, "node").apply {
            writeText("#!/bin/sh\necho command not found\nexit 1\n")
            setExecutable(true)
        }
        val record = File(tempDir, "record.json")
        NodeRuntime.adoptManualSelection(notNode.absolutePath, record)
            .shouldBeInstanceOf<NodeRuntime.ManualSelectionResult.NotNode>()
        record.exists() shouldBe false
    }

    @Test
    fun `adoptManualSelection rejects a node below the minimum version`() {
        Assumptions.assumeTrue(!isWindows)
        val record = File(tempDir, "record.json")
        val result = NodeRuntime.adoptManualSelection(fakeNode("v12.22.0").absolutePath, record)
        result.shouldBeInstanceOf<NodeRuntime.ManualSelectionResult.TooOld>()
        result.version shouldBe "v12.22.0"
        record.exists() shouldBe false
    }

    @Test
    fun `adoptManualSelection accepts a usable pick and records it as manual`() {
        Assumptions.assumeTrue(!isWindows)
        val record = File(tempDir, "record.json")
        val bin = fakeNode("v22.14.0")
        val result = NodeRuntime.adoptManualSelection(bin.absolutePath, record)
        result.shouldBeInstanceOf<NodeRuntime.ManualSelectionResult.Accepted>()
        result.info shouldBe NodeInfo(bin.absolutePath, "v22.14.0")
        // Persisted, tagged as a manual pick, and now the in-process detection result.
        NodeRuntime.readRecordedInfo(record) shouldBe result.info
        record.readText() shouldContain "\"source\":\"manual\""
        // The shell dispatchers' fallback record is written alongside.
        File(tempDir, "node-path").readText() shouldBe bin.absolutePath + "\n"
        NodeRuntime.cached() shouldBe result.info
    }

    @Test
    fun `read is null for corrupt or incomplete records`() {
        val corrupt = File(tempDir, "corrupt.json").apply { writeText("not json at all") }
        NodeRuntime.readRecordedInfo(corrupt).shouldBeNull()

        val missingVersion = File(tempDir, "partial.json").apply { writeText("""{"path":"/usr/bin/node"}""") }
        NodeRuntime.readRecordedInfo(missingVersion).shouldBeNull()

        val blankPath = File(tempDir, "blank.json").apply { writeText("""{"path":"","version":"v20.0.0"}""") }
        NodeRuntime.readRecordedInfo(blankPath).shouldBeNull()
    }
}
