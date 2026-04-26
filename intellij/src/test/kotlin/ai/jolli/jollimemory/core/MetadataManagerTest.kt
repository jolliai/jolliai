package ai.jolli.jollimemory.core

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

class MetadataManagerTest {

    @TempDir
    lateinit var tempDir: Path

    private lateinit var jolliDir: Path
    private lateinit var manager: MetadataManager
    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()

    @BeforeEach
    fun setUp() {
        jolliDir = tempDir.resolve(".jolli")
        manager = MetadataManager(jolliDir)
    }

    private fun makeEntry(
        path: String = "main/abc12345-test.md",
        fileId: String = "abc12345",
        type: String = "commit",
        fingerprint: String = "sha256:deadbeef",
    ) = ManifestEntry(
        path = path,
        fileId = fileId,
        type = type,
        fingerprint = fingerprint,
        source = ManifestSource(commitHash = "abc12345", branch = "main"),
    )

    // ── ensure ─────────────────────────────────────────────────────────────

    @Nested
    inner class Ensure {
        @Test
        fun `creates jolli dir and default files`() {
            manager.ensure()

            Files.isDirectory(jolliDir) shouldBe true
            Files.exists(jolliDir.resolve("manifest.json")) shouldBe true
            Files.exists(jolliDir.resolve("branches.json")) shouldBe true
            Files.exists(jolliDir.resolve("config.json")) shouldBe true
        }

        @Test
        fun `is idempotent — calling twice does not fail`() {
            manager.ensure()
            manager.ensure()

            Files.isDirectory(jolliDir) shouldBe true
        }

        @Test
        fun `does not overwrite existing files`() {
            manager.ensure()
            // Modify manifest
            manager.updateManifest(makeEntry())

            // Call ensure again — should not reset manifest
            manager.ensure()
            manager.readManifest().files shouldHaveSize 1
        }
    }

    // ── Manifest ───────────────────────────────────────────────────────────

    @Nested
    inner class ManifestOps {
        @BeforeEach
        fun init() { manager.ensure() }

        @Test
        fun `readManifest returns empty manifest when fresh`() {
            val manifest = manager.readManifest()
            manifest.version shouldBe 1
            manifest.files.shouldBeEmpty()
        }

        @Test
        fun `updateManifest adds new entry`() {
            manager.updateManifest(makeEntry())
            manager.readManifest().files shouldHaveSize 1
            manager.readManifest().files[0].fileId shouldBe "abc12345"
        }

        @Test
        fun `updateManifest replaces entry with same fileId`() {
            manager.updateManifest(makeEntry(path = "main/old.md"))
            manager.updateManifest(makeEntry(path = "main/new.md"))

            val files = manager.readManifest().files
            files shouldHaveSize 1
            files[0].path shouldBe "main/new.md"
        }

        @Test
        fun `updateManifest keeps entries with different fileId`() {
            manager.updateManifest(makeEntry(fileId = "aaa"))
            manager.updateManifest(makeEntry(fileId = "bbb"))

            manager.readManifest().files shouldHaveSize 2
        }

        @Test
        fun `removeFromManifest removes existing entry`() {
            manager.updateManifest(makeEntry(fileId = "aaa"))
            manager.updateManifest(makeEntry(fileId = "bbb"))

            manager.removeFromManifest("aaa") shouldBe true
            manager.readManifest().files shouldHaveSize 1
            manager.readManifest().files[0].fileId shouldBe "bbb"
        }

        @Test
        fun `removeFromManifest returns false when fileId not found`() {
            manager.removeFromManifest("nonexistent") shouldBe false
        }

        @Test
        fun `findByPath returns matching entry`() {
            manager.updateManifest(makeEntry(path = "main/test.md", fileId = "abc"))
            manager.findByPath("main/test.md")?.fileId shouldBe "abc"
        }

        @Test
        fun `findByPath returns null when not found`() {
            manager.findByPath("nonexistent") shouldBe null
        }

        @Test
        fun `findById returns matching entry`() {
            manager.updateManifest(makeEntry(fileId = "xyz"))
            manager.findById("xyz") shouldNotBe null
        }

        @Test
        fun `findById returns null when not found`() {
            manager.findById("nonexistent") shouldBe null
        }

        @Test
        fun `updatePath changes path for existing entry`() {
            manager.updateManifest(makeEntry(path = "old/path.md", fileId = "abc"))

            manager.updatePath("abc", "new/path.md") shouldBe true
            manager.findById("abc")?.path shouldBe "new/path.md"
        }

        @Test
        fun `updatePath returns false for nonexistent fileId`() {
            manager.updatePath("nonexistent", "new.md") shouldBe false
        }
    }

    // ── Branch mapping ─────────────────────────────────────────────────────

    @Nested
    inner class BranchMappingOps {
        @BeforeEach
        fun init() { manager.ensure() }

        @Test
        fun `resolveFolderForBranch creates new mapping`() {
            val folder = manager.resolveFolderForBranch("feature/jolli-400")
            folder shouldBe "feature-jolli-400"

            val mappings = manager.listBranchMappings()
            mappings shouldHaveSize 1
            mappings[0].branch shouldBe "feature/jolli-400"
            mappings[0].folder shouldBe "feature-jolli-400"
        }

        @Test
        fun `resolveFolderForBranch returns existing mapping on second call`() {
            manager.resolveFolderForBranch("feature/foo")
            val folder = manager.resolveFolderForBranch("feature/foo")

            folder shouldBe "feature-foo"
            manager.listBranchMappings() shouldHaveSize 1
        }

        @Test
        fun `resolveFolderForBranch handles multiple branches`() {
            manager.resolveFolderForBranch("main")
            manager.resolveFolderForBranch("feature/foo")
            manager.resolveFolderForBranch("bugfix/bar")

            manager.listBranchMappings() shouldHaveSize 3
        }

        @Test
        fun `updateBranchMapping changes branch for existing folder`() {
            manager.resolveFolderForBranch("feature/old")
            manager.updateBranchMapping("feature-old", "feature/new")

            val mappings = manager.listBranchMappings()
            mappings[0].branch shouldBe "feature/new"
            mappings[0].folder shouldBe "feature-old"
        }
    }

    // ── Branch name transcoding ────────────────────────────────────────────

    @Nested
    inner class TranscodeBranchName {
        @Test
        fun `replaces forward slash`() {
            MetadataManager.transcodeBranchName("feature/jolli-400") shouldBe "feature-jolli-400"
        }

        @Test
        fun `replaces backslash`() {
            MetadataManager.transcodeBranchName("user\\foo") shouldBe "user-foo"
        }

        @Test
        fun `replaces colon`() {
            MetadataManager.transcodeBranchName("refs:heads") shouldBe "refs-heads"
        }

        @Test
        fun `replaces asterisk`() {
            MetadataManager.transcodeBranchName("feature*test") shouldBe "feature-test"
        }

        @Test
        fun `replaces question mark`() {
            MetadataManager.transcodeBranchName("what?this") shouldBe "what-this"
        }

        @Test
        fun `replaces tilde`() {
            MetadataManager.transcodeBranchName("branch~1") shouldBe "branch-1"
        }

        @Test
        fun `replaces caret`() {
            MetadataManager.transcodeBranchName("branch^2") shouldBe "branch-2"
        }

        @Test
        fun `replaces double dot with double dash`() {
            MetadataManager.transcodeBranchName("refs..heads") shouldBe "refs--heads"
        }

        @Test
        fun `collapses consecutive dashes`() {
            MetadataManager.transcodeBranchName("a///b") shouldBe "a-b"
        }

        @Test
        fun `trims leading dot and dash`() {
            MetadataManager.transcodeBranchName(".leading") shouldBe "leading"
            MetadataManager.transcodeBranchName("-leading") shouldBe "leading"
        }

        @Test
        fun `trims trailing dot and dash`() {
            MetadataManager.transcodeBranchName("trailing.") shouldBe "trailing"
            MetadataManager.transcodeBranchName("trailing-") shouldBe "trailing"
        }

        @Test
        fun `simple branch names pass through`() {
            MetadataManager.transcodeBranchName("main") shouldBe "main"
            MetadataManager.transcodeBranchName("develop") shouldBe "develop"
        }

        @Test
        fun `returns default for empty result`() {
            MetadataManager.transcodeBranchName("/") shouldBe "default"
            MetadataManager.transcodeBranchName("...") shouldBe "default"
        }

        @Test
        fun `complex branch name`() {
            MetadataManager.transcodeBranchName("user/name/feature/JIRA-123") shouldBe "user-name-feature-JIRA-123"
        }
    }

    // ── Index ──────────────────────────────────────────────────────────────

    @Nested
    inner class IndexOps {
        @BeforeEach
        fun init() { manager.ensure() }

        @Test
        fun `readIndex returns null when no index exists`() {
            manager.readIndex() shouldBe null
        }

        @Test
        fun `writeIndex and readIndex round-trip`() {
            val index = SummaryIndex(
                version = 3,
                entries = listOf(
                    SummaryIndexEntry(
                        commitHash = "abc123",
                        commitMessage = "test",
                        commitDate = "2026-01-01T00:00:00Z",
                        branch = "main",
                        generatedAt = "2026-01-01T00:00:00Z",
                    )
                ),
            )
            manager.writeIndex(index)

            val read = manager.readIndex()
            read shouldNotBe null
            read!!.entries shouldHaveSize 1
            read.entries[0].commitHash shouldBe "abc123"
        }

        @Test
        fun `rebuildIndex scans summary JSON files`() {
            val summariesDir = jolliDir.resolve("summaries")
            Files.createDirectories(summariesDir)

            val summary = CommitSummary(
                commitHash = "abc123",
                commitMessage = "test commit",
                commitAuthor = "Alice",
                commitDate = "2026-01-15T10:00:00Z",
                branch = "main",
                generatedAt = "2026-01-15T10:00:00Z",
                topics = listOf(
                    TopicSummary("t1", "trigger", "response", "decisions")
                ),
                stats = DiffStats(3, 10, 5),
            )
            Files.writeString(summariesDir.resolve("abc123.json"), gson.toJson(summary))

            // Add to manifest so rebuildIndex finds it
            manager.updateManifest(makeEntry(fileId = "abc123", type = "commit"))

            val index = manager.rebuildIndex(summariesDir)
            index.entries shouldHaveSize 1
            index.entries[0].commitHash shouldBe "abc123"
            index.entries[0].commitMessage shouldBe "test commit"
            index.entries[0].topicCount shouldBe 1
            index.entries[0].diffStats?.filesChanged shouldBe 3

            // Should also persist
            manager.readIndex()!!.entries shouldHaveSize 1
        }

        @Test
        fun `rebuildIndex skips missing summary files`() {
            manager.updateManifest(makeEntry(fileId = "missing", type = "commit"))

            val summariesDir = jolliDir.resolve("summaries")
            Files.createDirectories(summariesDir)

            val index = manager.rebuildIndex(summariesDir)
            index.entries.shouldBeEmpty()
        }

        @Test
        fun `rebuildIndex ignores non-commit manifest entries`() {
            manager.updateManifest(makeEntry(fileId = "plan1", type = "plan"))

            val summariesDir = jolliDir.resolve("summaries")
            Files.createDirectories(summariesDir)

            val index = manager.rebuildIndex(summariesDir)
            index.entries.shouldBeEmpty()
        }
    }

    // ── Config ─────────────────────────────────────────────────────────────

    @Nested
    inner class ConfigOps {
        @BeforeEach
        fun init() { manager.ensure() }

        @Test
        fun `readConfig returns defaults when fresh`() {
            val config = manager.readConfig()
            config.version shouldBe 1
            config.sortOrder shouldBe "date"
        }

        @Test
        fun `saveConfig and readConfig round-trip`() {
            manager.saveConfig(KBConfig(sortOrder = "name"))

            val config = manager.readConfig()
            config.sortOrder shouldBe "name"
        }
    }

    // ── Resilience ─────────────────────────────────────────────────────────

    @Nested
    inner class Resilience {
        @Test
        fun `readManifest returns empty manifest on corrupted file`() {
            Files.createDirectories(jolliDir)
            Files.writeString(jolliDir.resolve("manifest.json"), "not json!!!")

            manager.readManifest().files.shouldBeEmpty()
        }

        @Test
        fun `readConfig returns defaults on corrupted file`() {
            Files.createDirectories(jolliDir)
            Files.writeString(jolliDir.resolve("config.json"), "{bad json")

            manager.readConfig().sortOrder shouldBe "date"
        }
    }

    // ── Branch folder rename ──────────────────────────────────────────────

    @Nested
    inner class RenameBranchFolder {
        @BeforeEach
        fun init() { manager.ensure() }

        @Test
        fun `renames branch folder in branches json and manifest`() {
            manager.resolveFolderForBranch("feature/old")
            manager.updateManifest(makeEntry(path = "feature-old/abc.md", fileId = "abc"))
            manager.updateManifest(makeEntry(path = "feature-old/def.md", fileId = "def"))

            val count = manager.renameBranchFolder("feature-old", "feature-new")
            count shouldBe 2

            // Manifest paths updated
            manager.findById("abc")?.path shouldBe "feature-new/abc.md"
            manager.findById("def")?.path shouldBe "feature-new/def.md"

            // Branches json updated
            val mappings = manager.listBranchMappings()
            mappings.any { it.folder == "feature-new" } shouldBe true
            mappings.any { it.folder == "feature-old" } shouldBe false
        }

        @Test
        fun `does not affect other branch entries`() {
            manager.updateManifest(makeEntry(path = "main/x.md", fileId = "x"))
            manager.updateManifest(makeEntry(path = "feature-old/y.md", fileId = "y"))

            manager.renameBranchFolder("feature-old", "feature-new")

            manager.findById("x")?.path shouldBe "main/x.md"
            manager.findById("y")?.path shouldBe "feature-new/y.md"
        }
    }

    // ── Remove branch folder ──────────────────────────────────────────────

    @Nested
    inner class RemoveBranchFolder {
        @BeforeEach
        fun init() { manager.ensure() }

        @Test
        fun `removes branch folder entries from manifest and branches json`() {
            manager.resolveFolderForBranch("feature/delete-me")
            manager.updateManifest(makeEntry(path = "feature-delete-me/a.md", fileId = "a"))
            manager.updateManifest(makeEntry(path = "feature-delete-me/b.md", fileId = "b"))
            manager.updateManifest(makeEntry(path = "main/c.md", fileId = "c"))

            val removed = manager.removeBranchFolder("feature-delete-me")
            removed shouldBe 2

            manager.readManifest().files shouldHaveSize 1
            manager.findById("c") shouldNotBe null
            manager.listBranchMappings().any { it.folder == "feature-delete-me" } shouldBe false
        }
    }

    // ── Reconciliation ────────────────────────────────────────────────────

    @Nested
    inner class Reconciliation {
        @BeforeEach
        fun init() { manager.ensure() }

        @Test
        fun `removes manifest entry when file is deleted`() {
            val kbRoot = tempDir.resolve("kb")
            Files.createDirectories(kbRoot.resolve("main"))
            val file = kbRoot.resolve("main/test.md")
            Files.writeString(file, "# Test")

            manager.updateManifest(makeEntry(path = "main/test.md", fileId = "abc", fingerprint = "fp1"))

            // Delete the file
            Files.delete(file)

            val fixed = manager.reconcile(kbRoot)
            fixed shouldBe 1
            manager.findById("abc") shouldBe null
        }

        @Test
        fun `updates path when file is moved (same fingerprint)`() {
            val kbRoot = tempDir.resolve("kb")
            Files.createDirectories(kbRoot.resolve("main"))
            Files.createDirectories(kbRoot.resolve("other"))
            val content = "# Moved file content"
            val fp = ai.jolli.jollimemory.core.FolderStorage.sha256(content)

            // File originally at main/test.md
            manager.updateManifest(makeEntry(path = "main/test.md", fileId = "abc", fingerprint = fp))

            // File moved to other/test.md
            Files.writeString(kbRoot.resolve("other/test.md"), content)

            val fixed = manager.reconcile(kbRoot)
            fixed shouldBe 1
            manager.findById("abc")?.path shouldBe "other/test.md"
        }

        @Test
        fun `no changes when files are in place`() {
            val kbRoot = tempDir.resolve("kb")
            Files.createDirectories(kbRoot.resolve("main"))
            Files.writeString(kbRoot.resolve("main/test.md"), "# Test")

            manager.updateManifest(makeEntry(path = "main/test.md", fileId = "abc"))

            val fixed = manager.reconcile(kbRoot)
            fixed shouldBe 0
        }
    }
}
