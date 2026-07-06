package ai.jolli.jollimemory.bridge

import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path
import java.util.concurrent.TimeUnit

/**
 * Integration tests for the reflog-based merged-mode resolution that lets the
 * COMMITTED MEMORIES panel show the user's own commits on `main` in a repo with
 * NO remote (where merge-base(HEAD, main) == HEAD). Before this, IntelliJ cleared
 * the panel in that case while VS Code showed the commits via merged mode.
 */
class GitOpsMergedHistoryTest {

    @TempDir
    lateinit var tempDir: Path

    private lateinit var repo: File
    private lateinit var git: GitOps

    @BeforeEach
    fun setUp() {
        repo = tempDir.toFile()
        run("init", "-b", "main")
        run("config", "user.email", "test@example.com")
        run("config", "user.name", "Test User")
        run("commit", "--allow-empty", "-m", "root on main")
        git = GitOps(repo.absolutePath)
    }

    /** Runs a git command in the temp repo and returns trimmed stdout (fails loudly on error). */
    private fun run(vararg args: String): String {
        val pb = ProcessBuilder(listOf("git") + args).directory(repo).redirectErrorStream(true)
        val p = pb.start()
        val out = p.inputStream.bufferedReader().use { it.readText() }
        check(p.waitFor(30, TimeUnit.SECONDS)) { "git ${args.joinToString(" ")} timed out" }
        check(p.exitValue() == 0) { "git ${args.joinToString(" ")} failed: $out" }
        return out.trim()
    }

    private fun rev(ref: String): String = run("rev-parse", ref)

    @Test
    fun `on main with no remote resolves the reflog base and detects own commits`() {
        // A second commit on main (no remote configured at all).
        run("commit", "--allow-empty", "-m", "second on main")
        val root = run("rev-list", "--max-parents=0", "HEAD") // first commit == oldest reflog entry

        val merged = git.resolveMergedHistory("main")
        merged shouldNotBe null
        merged!!.hasOwnCommit shouldBe true
        // Base is the oldest surviving reflog entry (the initial commit), so
        // `<base>..HEAD` lists the user's later commits on main.
        merged.base shouldBe root
    }

    @Test
    fun `a freshly cut branch reports no own commit`() {
        // Created from main, no commits of its own → only a "Created from" reflog op.
        run("checkout", "-b", "feature/fresh")

        val merged = git.resolveMergedHistory("feature/fresh")
        merged shouldNotBe null
        merged!!.hasOwnCommit shouldBe false
    }

    @Test
    fun `own commit is detected after committing on a cut branch`() {
        run("checkout", "-b", "feature/work")
        run("commit", "--allow-empty", "-m", "own work")

        git.resolveMergedHistory("feature/work")!!.hasOwnCommit shouldBe true
    }

    @Test
    fun `detached HEAD has no merged history`() {
        git.resolveMergedHistory("HEAD") shouldBe null
    }

    @Test
    fun `getCurrentUserName reads git config user name`() {
        git.getCurrentUserName() shouldBe "Test User"
    }
}
