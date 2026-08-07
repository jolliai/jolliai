package ai.jolli.jollimemory.bridge

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path
import java.util.concurrent.TimeUnit

/**
 * `resolveWorktreeRoot` is what every working-tree path in this host is relative to
 * — the FILES panel's rows, the `File(root, path)` joins behind the VFS refresh, the
 * pathspecs `stageFiles` hands git, and the cwd the CLI's discard service resolves
 * its own repository from. A project opened on a SUBDIRECTORY (one module of a
 * monorepo) is where returning `projectDir` verbatim went wrong: `git status
 * --porcelain` reports repo-root-relative paths wherever it runs, so the two path
 * spaces silently disagree and a discard comes back `not-found` with `ok = true`.
 */
class GitOpsWorktreeRootTest {

    @TempDir
    lateinit var tempDir: Path
    private lateinit var repo: File

    @BeforeEach
    fun setUp() {
        repo = tempDir.toFile()
        run("init", "-b", "main")
    }

    private fun run(vararg args: String): String {
        val pb = ProcessBuilder(listOf("git") + args).directory(repo).redirectErrorStream(true)
        val p = pb.start()
        val out = p.inputStream.bufferedReader().use { it.readText() }
        check(p.waitFor(30, TimeUnit.SECONDS)) { "git ${args.joinToString(" ")} timed out" }
        check(p.exitValue() == 0) { "git ${args.joinToString(" ")} failed: $out" }
        return out.trim()
    }

    @Test
    fun `a project opened on the repo root keeps its own spelling`() {
        // Not just "equals the root": `--show-toplevel` resolves symlinks (macOS
        // /tmp is one), and adopting git's spelling for a project already at its
        // root would change a string every other surface compares to basePath.
        GitOps(repo.absolutePath).resolveWorktreeRoot() shouldBe repo.absolutePath
    }

    @Test
    fun `a project opened on a subdirectory resolves up to the worktree root`() {
        val module = File(repo, "module/nested")
        check(module.mkdirs())

        GitOps(module.absolutePath).resolveWorktreeRoot() shouldBe repo.canonicalFile.path
    }

    @Test
    fun `a directory git cannot answer for falls back to itself`(@TempDir notARepo: Path) {
        // No repo, or no git binary at all: the caller's directory is the answer,
        // which is what this returned unconditionally before.
        val dir = notARepo.toFile().absolutePath
        GitOps(dir).resolveWorktreeRoot() shouldBe dir
    }
}
