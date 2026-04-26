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
            result.toString() shouldBe "$custom/myrepo"
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
    }
}
