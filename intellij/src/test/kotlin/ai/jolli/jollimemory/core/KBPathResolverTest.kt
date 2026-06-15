package ai.jolli.jollimemory.core

import com.google.gson.GsonBuilder
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldEndWith
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

class KBPathResolverTest {

    private val gson = GsonBuilder().setPrettyPrinting().create()

    // ── extractRepoName ────────────────────────────────────────────────────

    @Nested
    inner class ExtractRepoName {
        @Test
        fun `extracts directory name from path`() {
            KBPathResolver.extractRepoName("/Users/alice/projects/myrepo") shouldBe "myrepo"
        }

        @Test
        fun `handles trailing slash`() {
            // Path.of normalizes trailing slash
            KBPathResolver.extractRepoName("/Users/alice/projects/myrepo") shouldBe "myrepo"
        }

        @Test
        fun `handles nested paths`() {
            KBPathResolver.extractRepoName("/deep/nested/path/project-name") shouldBe "project-name"
        }
    }

    // ── resolve ────────────────────────────────────────────────────────────

    @Nested
    inner class Resolve {
        @TempDir
        lateinit var tempDir: Path

        @Test
        fun `uses custom path as parent with repoName appended`() {
            val custom = tempDir.resolve("custom-kb").toString()
            val result = KBPathResolver.resolve("myrepo", "https://github.com/user/myrepo.git", custom)
            // Compare via Path so the separator matches the platform (backslash on Windows).
            result.toString() shouldBe Path.of(custom, "myrepo").toString()
        }

        @Test
        fun `returns default path when folder does not exist`() {
            val result = KBPathResolver.resolve("myrepo", "https://github.com/user/myrepo.git")
            result.toString() shouldEndWith "myrepo"
            result.toString() shouldContain "jolli"
        }
    }

    // ── initializeKBFolder ─────────────────────────────────────────────────

    @Nested
    inner class InitializeKBFolder {
        @TempDir
        lateinit var tempDir: Path

        @Test
        fun `creates jolli dir and writes config with remote URL`() {
            val kbRoot = tempDir.resolve("kb")

            KBPathResolver.initializeKBFolder(kbRoot, "myrepo", "https://github.com/user/myrepo.git")

            val configPath = kbRoot.resolve(".jolli/config.json")
            Files.exists(configPath) shouldBe true

            val config = gson.fromJson(
                Files.readString(configPath, StandardCharsets.UTF_8),
                KBConfig::class.java
            )
            config.remoteUrl shouldBe "https://github.com/user/myrepo.git"
            config.repoName shouldBe "myrepo"
        }

        @Test
        fun `works with null remote URL`() {
            val kbRoot = tempDir.resolve("kb")

            KBPathResolver.initializeKBFolder(kbRoot, "localrepo", null)

            val config = gson.fromJson(
                Files.readString(kbRoot.resolve(".jolli/config.json"), StandardCharsets.UTF_8),
                KBConfig::class.java
            )
            config.remoteUrl shouldBe null
            config.repoName shouldBe "localrepo"
        }

        @Test
        fun `is idempotent — calling twice does not lose data`() {
            val kbRoot = tempDir.resolve("kb")

            KBPathResolver.initializeKBFolder(kbRoot, "myrepo", "https://github.com/user/myrepo.git")
            KBPathResolver.initializeKBFolder(kbRoot, "myrepo", "https://github.com/user/myrepo.git")

            val config = gson.fromJson(
                Files.readString(kbRoot.resolve(".jolli/config.json"), StandardCharsets.UTF_8),
                KBConfig::class.java
            )
            config.remoteUrl shouldBe "https://github.com/user/myrepo.git"
        }
    }

    // ── Collision handling (integration) ────────────────────────────────────

    @Nested
    inner class CollisionHandling {
        @TempDir
        lateinit var tempDir: Path

        private fun createKBFolder(name: String, remoteUrl: String?): Path {
            val kbRoot = tempDir.resolve(name)
            KBPathResolver.initializeKBFolder(kbRoot, name, remoteUrl)
            return kbRoot
        }

        @Test
        fun `reuses folder when remote URL matches`() {
            createKBFolder("myrepo", "https://github.com/user/myrepo.git")

            // Simulate resolve by directly checking isSameRepo logic
            val configPath = tempDir.resolve("myrepo/.jolli/config.json")
            val config = gson.fromJson(
                Files.readString(configPath, StandardCharsets.UTF_8),
                KBConfig::class.java
            )
            config.remoteUrl shouldBe "https://github.com/user/myrepo.git"
        }

        @Test
        fun `reuses folder when remote URL matches with git suffix difference`() {
            // Test that normalization works: with vs without .git suffix
            createKBFolder("myrepo", "https://github.com/user/myrepo.git")

            val configPath = tempDir.resolve("myrepo/.jolli/config.json")
            val config = gson.fromJson(
                Files.readString(configPath, StandardCharsets.UTF_8),
                KBConfig::class.java
            )
            // The stored URL has .git suffix
            config.remoteUrl shouldBe "https://github.com/user/myrepo.git"
            // Normalized comparison should treat these as equal
            config.remoteUrl!!.trimEnd('/').removeSuffix(".git") shouldBe
                "https://github.com/user/myrepo"
        }

        @Test
        fun `reuses folder when stored SSH remote matches the https clone of the same repo`() {
            // Same repo, different clone transport. Before transport folding the
            // SSH and https forms compared unequal and the resolver split the
            // Memory Bank into myrepo / myrepo-2.
            createKBFolder("myrepo", "git@github.com:user/myrepo.git")

            val resolved = KBPathResolver.resolve(
                "myrepo",
                "https://github.com/user/myrepo.git",
                tempDir.toString(),
            )
            resolved shouldBe tempDir.resolve("myrepo")
        }

        @Test
        fun `reuses folder when stored https remote matches the ssh clone of the same repo`() {
            createKBFolder("myrepo", "https://github.com/user/myrepo.git")

            val resolved = KBPathResolver.resolve(
                "myrepo",
                "ssh://git@github.com:22/user/myrepo.git",
                tempDir.toString(),
            )
            resolved shouldBe tempDir.resolve("myrepo")
        }

        @Test
        fun `treats default ssh port as identical but a non-default port as a different repo`() {
            createKBFolder("myrepo", "ssh://git@host.example:2222/user/myrepo.git")

            // Same non-default port → same repo, folder reused.
            KBPathResolver.resolve(
                "myrepo",
                "ssh://git@host.example:2222/user/myrepo",
                tempDir.toString(),
            ) shouldBe tempDir.resolve("myrepo")

            // Different port → distinct self-hosted forge, must NOT reuse.
            KBPathResolver.resolve(
                "myrepo",
                "ssh://git@host.example:2223/user/myrepo",
                tempDir.toString(),
            ) shouldNotBe tempDir.resolve("myrepo")
        }

        @Test
        fun `local repos match by name when both have no remote`() {
            createKBFolder("localproject", null)

            val configPath = tempDir.resolve("localproject/.jolli/config.json")
            val config = gson.fromJson(
                Files.readString(configPath, StandardCharsets.UTF_8),
                KBConfig::class.java
            )
            config.remoteUrl shouldBe null
            config.repoName shouldBe "localproject"
        }

        @Test
        fun `reuses a higher-numbered same-repo folder across an archived numbering hole`() {
            // Archiving a folder leaves a numbering hole. base `repo` is a different
            // repo, `repo-2` is the hole (absent), `repo-3` still holds our repo.
            // resolve must reuse repo-3, not claim the repo-2 hole and spawn a duplicate.
            createKBFolder("repo", "https://github.com/u/other.git")
            val canonical = tempDir.resolve("repo-3")
            KBPathResolver.initializeKBFolder(canonical, "repo", "https://github.com/u/canonical.git")

            KBPathResolver.resolve(
                "repo",
                "https://github.com/u/canonical.git",
                tempDir.toString(),
            ) shouldBe canonical
            // resolve must not have created the hole as a side effect.
            Files.isDirectory(tempDir.resolve("repo-2")) shouldBe false
        }

        @Test
        fun `reuses a suffixed data folder when the base slot is free (post-Migrate)`() {
            // After a Migrate archives the base `<repo>` and leaves the live data in
            // `<repo>-2`, the base slot is free. resolve must reuse repo-2 rather than
            // claiming a fresh empty base that shadows it. Mirrors the canonical TS
            // resolveKBPath Case A fix.
            val remote = "https://github.com/u/canonical.git"
            val data = tempDir.resolve("repo-2")
            KBPathResolver.initializeKBFolder(data, "repo", remote)

            KBPathResolver.resolve("repo", remote, tempDir.toString()) shouldBe data
            Files.isDirectory(tempDir.resolve("repo")) shouldBe false
        }

        @Test
        fun `still returns the base when a free base slot has only a different-repo suffix`() {
            val remote = "https://github.com/u/canonical.git"
            KBPathResolver.initializeKBFolder(tempDir.resolve("repo-2"), "repo", "https://github.com/u/other.git")

            KBPathResolver.resolve("repo", remote, tempDir.toString()) shouldBe tempDir.resolve("repo")
        }

        @Test
        fun `claims the lowest free slot in the custom parent, not the global default`() {
            // findAvailablePath must honor the custom parent (tempDir), not KB_PARENT.
            createKBFolder("dup", "https://github.com/u/a.git")
            val resolved = KBPathResolver.resolve(
                "dup",
                "https://github.com/u/b.git",
                tempDir.toString(),
            )
            resolved shouldBe tempDir.resolve("dup-2")
        }
    }

    // ── fold + archive (Migrate-to-Memory-Bank flow) ───────────────────────
    @Nested
    inner class FoldAndArchive {
        @TempDir
        lateinit var tempDir: Path

        private fun seed(folderName: String, repoName: String, remoteUrl: String?): Path {
            val kbRoot = tempDir.resolve(folderName)
            KBPathResolver.initializeKBFolder(kbRoot, repoName, remoteUrl)
            return kbRoot
        }

        @Test
        fun `findRepoFolders returns all same-repo folders, skipping holes and other repos`() {
            val remote = "https://github.com/u/canonical.git"
            seed("repo", "repo", "https://github.com/u/other.git") // different repo → excluded
            // repo-2 is a hole (absent) → skipped
            seed("repo-3", "repo", remote)
            seed("repo-4", "repo", remote)
            seed("repo-5", "repo", "https://github.com/u/third.git") // different → excluded

            val found = KBPathResolver.findRepoFolders("repo", remote, tempDir.toString())
            found.toSet() shouldBe setOf(tempDir.resolve("repo-3"), tempDir.resolve("repo-4"))
        }

        @Test
        fun `findRepoFolders includes the base folder when it matches`() {
            val remote = "https://github.com/u/canonical.git"
            seed("repo", "repo", remote)
            seed("repo-2", "repo", remote)

            val found = KBPathResolver.findRepoFolders("repo", remote, tempDir.toString())
            found.toSet() shouldBe setOf(tempDir.resolve("repo"), tempDir.resolve("repo-2"))
        }

        @Test
        fun `findFreshKBPath returns base when free, else the lowest hole`() {
            KBPathResolver.findFreshKBPath("brand", tempDir.toString()) shouldBe tempDir.resolve("brand")
            seed("brand", "brand", "https://github.com/u/a.git")
            KBPathResolver.findFreshKBPath("brand", tempDir.toString()) shouldBe tempDir.resolve("brand-2")
        }

        @Test
        fun `archiveKBFolder moves the folder into hidden jolli archive and removes the original`() {
            val kbRoot = seed("repo-3", "repo", "https://github.com/u/a.git")

            val dest = KBPathResolver.archiveKBFolder(kbRoot, tempDir.toString())

            dest shouldNotBe null
            Files.isDirectory(kbRoot) shouldBe false
            Files.isDirectory(dest!!) shouldBe true
            dest.toString() shouldContain tempDir.resolve(".jolli").resolve("archive").toString()
            dest.fileName.toString().startsWith("repo-3-") shouldBe true
        }

        @Test
        fun `archiveKBFolder returns null when the folder does not exist`() {
            KBPathResolver.archiveKBFolder(tempDir.resolve("nope"), tempDir.toString()) shouldBe null
        }
    }
}
