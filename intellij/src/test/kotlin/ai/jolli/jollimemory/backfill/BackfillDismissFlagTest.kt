package ai.jolli.jollimemory.backfill

import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path
import java.util.concurrent.TimeUnit

/**
 * Round-trips the dismiss marker against a real git repo, asserting it lands under the
 * shared git common dir (`<git-common-dir>/jollimemory/backfill-card-dismissed`) so it is
 * repo-wide — the same location the VS Code extension reads/writes.
 */
class BackfillDismissFlagTest {

	@TempDir
	lateinit var tempDir: Path
	private lateinit var repo: File

	@BeforeEach
	fun setUp() {
		repo = tempDir.toFile()
		run("init", "-b", "main")
		run("config", "user.email", "test@example.com")
		run("config", "user.name", "Test User")
	}

	private fun run(vararg args: String) {
		val p = ProcessBuilder(listOf("git") + args).directory(repo).redirectErrorStream(true).start()
		check(p.waitFor(30, TimeUnit.SECONDS)) { "git ${args.joinToString(" ")} timed out" }
		check(p.exitValue() == 0) { "git ${args.joinToString(" ")} failed" }
	}

	@Test
	fun `defaults to not dismissed`() {
		BackfillDismissFlag.isDismissed(repo.absolutePath).shouldBeFalse()
	}

	@Test
	fun `set true writes the marker under the git common dir, set false removes it`() {
		BackfillDismissFlag.setDismissed(repo.absolutePath, true)
		BackfillDismissFlag.isDismissed(repo.absolutePath).shouldBeTrue()
		File(repo, ".git/jollimemory/backfill-card-dismissed").exists().shouldBeTrue()

		BackfillDismissFlag.setDismissed(repo.absolutePath, false)
		BackfillDismissFlag.isDismissed(repo.absolutePath).shouldBeFalse()
	}

	@Test
	fun `setting false when absent is a no-op (no throw)`() {
		BackfillDismissFlag.setDismissed(repo.absolutePath, false)
		BackfillDismissFlag.isDismissed(repo.absolutePath).shouldBeFalse()
	}

	@Test
	fun `outside a git repo it reports not dismissed and does not throw`(@TempDir nonRepo: Path) {
		// A SEPARATE temp dir (not the git-inited class tempDir, nor a child of it), so
		// `git rev-parse --git-common-dir` finds no repo.
		val dir = nonRepo.toFile().absolutePath
		BackfillDismissFlag.isDismissed(dir).shouldBeFalse()
		// Writing is inert (no common dir) — must not throw.
		BackfillDismissFlag.setDismissed(dir, true)
		BackfillDismissFlag.isDismissed(dir).shouldBeFalse()
	}
}
