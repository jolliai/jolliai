package ai.jolli.jollimemory.core

import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path
import java.time.LocalDate
import java.time.format.DateTimeFormatter

/**
 * Verifies Codex sessions are scoped to the current repo. Codex has no lifecycle
 * hook, so the discoverer scans `~/.codex/sessions/` (every repo on the machine)
 * and must filter by each session's recorded `payload.cwd` — mirroring the CLI.
 */
class CodexSessionDiscovererTest {

    @TempDir
    lateinit var tempHome: Path
    private var originalHome: String? = null

    @BeforeEach
    fun setUp() {
        originalHome = System.getProperty("user.home")
        System.setProperty("user.home", tempHome.toString())
    }

    @AfterEach
    fun tearDown() {
        originalHome?.let { System.setProperty("user.home", it) }
    }

    /** Writes a Codex rollout file under today's date dir with the given id + optional cwd. */
    private fun writeSession(id: String, cwd: String?) {
        val dayPath = DateTimeFormatter.ofPattern("yyyy/MM/dd").format(LocalDate.now())
        val dayDir = File(tempHome.toFile(), ".codex/sessions/$dayPath").apply { mkdirs() }
        val meta = buildString {
            append("""{"type":"session_meta","payload":{"id":"$id"""")
            if (cwd != null) append(""","cwd":"$cwd"""")
            append("}}")
        }
        File(dayDir, "$id.jsonl").writeText("$meta\n")
    }

    @Test
    fun `keeps only sessions whose cwd matches the project directory`() {
        writeSession("match-1", "/repo/a")
        writeSession("other-1", "/repo/b") // different repo — must be excluded
        writeSession("nocwd-1", null) // unattributable — must be excluded

        val result = CodexSessionDiscoverer.discoverSessions("/repo/a")

        result shouldHaveSize 1
        result[0].sessionId shouldBe "match-1"
        result[0].source shouldBe TranscriptSource.codex
    }

    @Test
    fun `normalizes trailing slashes when matching cwd`() {
        writeSession("match-2", "/repo/a/")
        CodexSessionDiscoverer.discoverSessions("/repo/a") shouldHaveSize 1
    }

    @Test
    fun `returns empty when no session belongs to the project`() {
        writeSession("other-2", "/some/other/repo")
        CodexSessionDiscoverer.discoverSessions("/repo/a") shouldHaveSize 0
    }

    @Test
    fun `returns empty when the sessions directory is absent`() {
        CodexSessionDiscoverer.discoverSessions("/repo/a") shouldHaveSize 0
    }
}
