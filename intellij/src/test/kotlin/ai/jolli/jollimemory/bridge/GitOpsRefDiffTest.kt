package ai.jolli.jollimemory.bridge

import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path
import java.util.concurrent.TimeUnit

/**
 * Tests the hash-parametric GitOps accessors the git-op-queue depends on. When the
 * queue drains, a commit may no longer be HEAD, so the diff / stats / commit info
 * must be resolved by the op's OWN commit hash — a plain `HEAD~1..HEAD` would be the
 * wrong change. Also covers the root-commit (no parent) fallback.
 */
class GitOpsRefDiffTest {

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
        git = GitOps(repo.absolutePath)
    }

    private fun run(vararg args: String): String {
        val pb = ProcessBuilder(listOf("git") + args).directory(repo).redirectErrorStream(true)
        val p = pb.start()
        val out = p.inputStream.bufferedReader().use { it.readText() }
        check(p.waitFor(30, TimeUnit.SECONDS)) { "git ${args.joinToString(" ")} timed out" }
        check(p.exitValue() == 0) { "git ${args.joinToString(" ")} failed: $out" }
        return out.trim()
    }

    private fun commitFile(name: String, content: String, msg: String): String {
        File(repo, name).writeText(content)
        run("add", ".")
        run("commit", "-m", msg)
        return run("rev-parse", "HEAD")
    }

    @Test
    fun `getDiffContent resolves the given commit, not HEAD`() {
        val c1 = commitFile("a.txt", "alpha\n", "add a")
        val c2 = commitFile("b.txt", "beta\n", "add b")

        // HEAD is c2. Diffing c1 (no longer HEAD) must show a.txt, not b.txt.
        val diffC1 = git.getDiffContent(c1) ?: ""
        diffC1 shouldContain "a.txt"
        diffC1 shouldNotContain "b.txt"

        val diffC2 = git.getDiffContent(c2) ?: ""
        diffC2 shouldContain "b.txt"
        diffC2 shouldNotContain "a.txt"
    }

    @Test
    fun `getDiffContent handles a root commit (no parent) via git show`() {
        val root = commitFile("a.txt", "alpha\n", "root commit")
        // Must not fail resolving <root>~1 — falls back to `git show`.
        val diff = git.getDiffContent(root) ?: ""
        diff shouldContain "a.txt"
    }

    @Test
    fun `getDiffStats resolves the given commit's stats`() {
        val c1 = commitFile("a.txt", "l1\nl2\nl3\n", "add a")
        commitFile("b.txt", "x\n", "add b")
        val stats = git.getDiffStats(c1) ?: ""
        stats shouldContain "a.txt"
        stats shouldNotContain "b.txt"
    }

    @Test
    fun `getHeadCommitInfo resolves a non-HEAD ref`() {
        val c1 = commitFile("a.txt", "alpha\n", "first message")
        commitFile("b.txt", "beta\n", "second message")

        val info = git.getHeadCommitInfo(c1) ?: ""
        info shouldContain c1.take(8)
        info shouldContain "first message"
    }
}
