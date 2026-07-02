package ai.jolli.jollimemory.bridge

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path
import java.util.concurrent.TimeUnit

/**
 * Integration tests for the reflog-based fork-point resolution that backs the
 * COMMITTED MEMORIES panel's branch scoping. Exercises a real git repo so the
 * behavior matches production (the panel clears when a fresh branch has no own
 * commits, even when cut from a feature/release branch rather than main).
 */
class GitOpsOwnCommitsBaseTest {

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
    fun `fresh branch cut from a feature branch has no own commits (base equals HEAD)`() {
        // main → A ; feature/base adds B, C ; feature/new is cut from feature/base
        // and adds nothing of its own — so its "own commits" base must be its tip.
        run("checkout", "-b", "feature/base")
        run("commit", "--allow-empty", "-m", "B on feature/base")
        run("commit", "--allow-empty", "-m", "C on feature/base")
        run("checkout", "-b", "feature/new")

        val head = rev("HEAD")
        val mergeBaseMain = rev("main") // merge-base(HEAD, main) collapses to A here anyway

        // The reflog records "Created from feature/base" at C == HEAD.
        val creationPoint = git.findBranchCreationPoint("feature/new", requireExplicit = true)
        creationPoint shouldBe head

        // Own-commits base is the creation point (downstream of the mainline base),
        // which equals HEAD → getBranchCommits returns empty → panel clears.
        git.resolveOwnCommitsBase("feature/new", mergeBaseMain) shouldBe head
    }

    @Test
    fun `branch cut directly from main measures own commits from the mainline base`() {
        val mainTip = rev("main")
        run("checkout", "-b", "feature/direct")
        run("commit", "--allow-empty", "-m", "own work")

        // Cut from main: creation point equals the mainline merge-base, so the base
        // stays at the mainline fork point and the branch's own commit is listed.
        git.resolveOwnCommitsBase("feature/direct", mainTip) shouldBe mainTip
    }

    @Test
    fun `feature branch with its own commits keeps them (base is the parent tip)`() {
        run("checkout", "-b", "feature/base")
        run("commit", "--allow-empty", "-m", "B on feature/base")
        val baseTip = rev("HEAD")
        run("checkout", "-b", "feature/work")
        run("commit", "--allow-empty", "-m", "own work on feature/work")

        // Cut from feature/base then committed: base is feature/base's tip, so
        // only feature/work's own commit is in `<base>..HEAD`, not feature/base's.
        git.resolveOwnCommitsBase("feature/work", rev("main")) shouldBe baseTip
    }

    @Test
    fun `findBranchCreationPoint returns null when no explicit creation entry and requireExplicit`() {
        // main's own reflog has no "branch: Created from" entry (it is the initial branch).
        git.findBranchCreationPoint("main", requireExplicit = true) shouldBe null
    }

    @Test
    fun `detached HEAD has no creation point`() {
        git.findBranchCreationPoint("HEAD", requireExplicit = true) shouldBe null
    }
}
