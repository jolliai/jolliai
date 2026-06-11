package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

class KBRepoDiscovererTest {

    @TempDir
    lateinit var tempDir: Path

    @Test
    fun `matches current repo across SSH and https transports of the same remote`() {
        // Config persisted from an SSH clone, current checkout uses https.
        // Without transport folding the discoverer called the current repo
        // "foreign" even though KBPathResolver.isSameRepo reuses its folder —
        // breaking current-repo highlighting in the Memory Bank UI.
        KBPathResolver.initializeKBFolder(
            tempDir.resolve("sshstored"),
            "sshstored",
            "git@github.com:user/repo.git",
        )

        val repos = KBRepoDiscoverer.discover(null, "https://github.com/user/repo.git", tempDir.toString())
        repos.first { it.repoName == "sshstored" }.isCurrentRepo shouldBe true
    }

    @Test
    fun `matches current repo when the stored config is https and the live remote is ssh`() {
        KBPathResolver.initializeKBFolder(
            tempDir.resolve("httpsstored"),
            "httpsstored",
            "https://github.com/other/thing.git",
        )

        val repos = KBRepoDiscoverer.discover(null, "ssh://git@github.com:22/other/thing", tempDir.toString())
        repos.first { it.repoName == "httpsstored" }.isCurrentRepo shouldBe true
    }

    @Test
    fun `does not match a genuinely different repo`() {
        KBPathResolver.initializeKBFolder(
            tempDir.resolve("unrelated"),
            "unrelated",
            "git@github.com:someone/else.git",
        )

        val repos = KBRepoDiscoverer.discover(null, "https://github.com/user/repo.git", tempDir.toString())
        repos.first { it.repoName == "unrelated" }.isCurrentRepo shouldBe false
    }
}
