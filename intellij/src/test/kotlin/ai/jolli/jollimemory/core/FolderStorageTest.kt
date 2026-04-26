package ai.jolli.jollimemory.core

import com.google.gson.GsonBuilder
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactlyInAnyOrder
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.nio.channels.FileChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import kotlin.io.path.isRegularFile

class FolderStorageTest {

    @TempDir
    lateinit var tempDir: Path

    private lateinit var rootPath: Path
    private lateinit var metadataManager: MetadataManager
    private lateinit var storage: FolderStorage
    private val gson = GsonBuilder().setPrettyPrinting().create()

    @BeforeEach
    fun setUp() {
        rootPath = tempDir.resolve("kb")
        metadataManager = MetadataManager(rootPath.resolve(".jolli"))
        storage = FolderStorage(rootPath, metadataManager)
    }

    private fun makeSummaryJson(
        hash: String = "abc12345deadbeef",
        message: String = "Add login feature",
        branch: String = "main",
    ): String {
        val summary = CommitSummary(
            commitHash = hash,
            commitMessage = message,
            commitAuthor = "Alice",
            commitDate = "2026-01-15T10:00:00Z",
            branch = branch,
            generatedAt = "2026-01-15T10:00:00Z",
            topics = listOf(TopicSummary("Login flow", "Need auth", "Added OAuth", "Use JWT")),
            stats = DiffStats(3, 50, 10),
        )
        return gson.toJson(summary)
    }

    // ── exists / ensure ────────────────────────────────────────────────────

    @Nested
    inner class ExistsAndEnsure {
        @Test
        fun `exists returns false before ensure`() {
            storage.exists() shouldBe false
        }

        @Test
        fun `ensure creates root and jolli dirs`() {
            storage.ensure()
            storage.exists() shouldBe true
            Files.isDirectory(rootPath.resolve(".jolli")) shouldBe true
        }

        @Test
        fun `ensure is idempotent`() {
            storage.ensure()
            storage.ensure()
            storage.exists() shouldBe true
        }
    }

    // ── readFile / writeFiles (data files → .jolli/) ───────────────────────

    @Nested
    inner class ReadWriteHidden {
        @BeforeEach
        fun init() { storage.ensure() }

        @Test
        fun `readFile returns null for nonexistent file`() {
            storage.readFile("nonexistent.txt") shouldBe null
        }

        @Test
        fun `write then read round-trips via hidden dir`() {
            storage.writeFiles(
                listOf(FileWrite("test.txt", "hello world")),
                "test write",
            )
            // Data stored in .jolli/test.txt
            Files.exists(rootPath.resolve(".jolli/test.txt")) shouldBe true
            storage.readFile("test.txt") shouldBe "hello world"
        }

        @Test
        fun `write creates nested directories in hidden dir`() {
            storage.writeFiles(
                listOf(FileWrite("a/b/c/deep.txt", "deep content")),
                "nested write",
            )
            Files.exists(rootPath.resolve(".jolli/a/b/c/deep.txt")) shouldBe true
            storage.readFile("a/b/c/deep.txt") shouldBe "deep content"
        }

        @Test
        fun `write overwrites existing file`() {
            storage.writeFiles(listOf(FileWrite("f.txt", "v1")), "write v1")
            storage.writeFiles(listOf(FileWrite("f.txt", "v2")), "write v2")
            storage.readFile("f.txt") shouldBe "v2"
        }

        @Test
        fun `delete removes hidden file`() {
            storage.writeFiles(listOf(FileWrite("f.txt", "content")), "create")
            storage.writeFiles(listOf(FileWrite("f.txt", "", delete = true)), "delete")
            storage.readFile("f.txt") shouldBe null
        }

        @Test
        fun `index json stored in hidden dir`() {
            storage.writeFiles(
                listOf(FileWrite("index.json", """{"version":3,"entries":[]}""")),
                "write index",
            )
            Files.exists(rootPath.resolve(".jolli/index.json")) shouldBe true
            // NOT at root level
            Files.exists(rootPath.resolve("index.json")) shouldBe false
        }
    }

    // ── listFiles ──────────────────────────────────────────────────────────

    @Nested
    inner class ListFiles {
        @BeforeEach
        fun init() { storage.ensure() }

        @Test
        fun `returns empty list for nonexistent prefix`() {
            storage.listFiles("nonexistent").shouldBeEmpty()
        }

        @Test
        fun `lists files under prefix in hidden dir`() {
            storage.writeFiles(
                listOf(
                    FileWrite("summaries/a.json", makeSummaryJson(hash = "aaa11111")),
                    FileWrite("summaries/b.json", makeSummaryJson(hash = "bbb22222")),
                    FileWrite("plans/p.md", "# Plan"),
                ),
                "seed files",
            )
            val result = storage.listFiles("summaries")
            result shouldHaveSize 2
            result.shouldContainExactlyInAnyOrder("summaries/a.json", "summaries/b.json")
        }
    }

    // ── Markdown generation ────────────────────────────────────────────────

    @Nested
    inner class MarkdownGeneration {
        @BeforeEach
        fun init() { storage.ensure() }

        @Test
        fun `writing summary json generates visible markdown`() {
            val json = makeSummaryJson(hash = "abc12345deadbeef", message = "Add login feature", branch = "main")
            storage.writeFiles(
                listOf(FileWrite("summaries/abc12345deadbeef.json", json)),
                "store summary",
            )

            // Hidden JSON should exist
            Files.exists(rootPath.resolve(".jolli/summaries/abc12345deadbeef.json")) shouldBe true

            // Visible markdown should exist in branch folder
            val mdFiles = Files.walk(rootPath).use { stream ->
                stream.filter { it.isRegularFile() }
                    .filter { it.toString().endsWith(".md") }
                    .filter { !it.toString().contains(".jolli") }
                    .toList()
            }
            mdFiles shouldHaveSize 1
            val mdFile = mdFiles[0]
            mdFile.fileName.toString() shouldContain "abc12345"
            mdFile.fileName.toString() shouldContain "add-login-feature"

            // Markdown should have YAML frontmatter
            val content = Files.readString(mdFile, StandardCharsets.UTF_8)
            content shouldContain "---"
            content shouldContain "commitHash: abc12345deadbeef"
            content shouldContain "branch: main"
            content shouldContain "author: Alice"
            content shouldContain "type: commit"

            // Markdown should have body content
            content shouldContain "Add login feature"
        }

        @Test
        fun `markdown goes into branch subfolder`() {
            val json = makeSummaryJson(branch = "feature/login")
            storage.writeFiles(
                listOf(FileWrite("summaries/abc12345deadbeef.json", json)),
                "store",
            )

            // Branch folder should be transcoded (feature/login → feature-login)
            Files.isDirectory(rootPath.resolve("feature-login")) shouldBe true
        }

        @Test
        fun `manifest tracks generated markdown`() {
            val json = makeSummaryJson(hash = "abc12345deadbeef")
            storage.writeFiles(
                listOf(FileWrite("summaries/abc12345deadbeef.json", json)),
                "store",
            )

            val entry = metadataManager.findById("abc12345deadbeef")
            entry shouldNotBe null
            entry!!.type shouldBe "commit"
            entry.path shouldContain "abc12345"
            entry.path shouldContain ".md"
            entry.fingerprint.length shouldBe 64 // SHA-256
        }

        @Test
        fun `non-summary files do not generate markdown`() {
            storage.writeFiles(
                listOf(
                    FileWrite("index.json", """{"version":3}"""),
                    FileWrite("transcripts/abc.json", """{"sessions":[]}"""),
                ),
                "other files",
            )

            val mdFiles = Files.walk(rootPath).use { stream ->
                stream.filter { it.isRegularFile() }
                    .filter { it.toString().endsWith(".md") }
                    .filter { !it.toString().contains(".jolli") }
                    .toList()
            }
            mdFiles.shouldBeEmpty()
        }

        @Test
        fun `deleting summary also deletes markdown`() {
            val json = makeSummaryJson(hash = "abc12345deadbeef")
            storage.writeFiles(
                listOf(FileWrite("summaries/abc12345deadbeef.json", json)),
                "create",
            )

            // Verify markdown exists
            metadataManager.findById("abc12345deadbeef") shouldNotBe null

            // Delete
            storage.writeFiles(
                listOf(FileWrite("summaries/abc12345deadbeef.json", "", delete = true)),
                "delete",
            )

            // Both hidden JSON and visible markdown should be gone
            storage.readFile("summaries/abc12345deadbeef.json") shouldBe null
            metadataManager.findById("abc12345deadbeef") shouldBe null
        }
    }

    // ── Slugify ────────────────────────────────────────────────────────────

    @Nested
    inner class Slugify {
        @Test
        fun `basic message`() {
            FolderStorage.slugify("Add login feature") shouldBe "add-login-feature"
        }

        @Test
        fun `strips special characters`() {
            FolderStorage.slugify("Fix bug (#123)!") shouldBe "fix-bug-123"
        }

        @Test
        fun `collapses whitespace and dashes`() {
            FolderStorage.slugify("Update   the   UI") shouldBe "update-the-ui"
        }

        @Test
        fun `truncates long messages`() {
            val long = "a".repeat(100)
            FolderStorage.slugify(long).length shouldBe 50
        }

        @Test
        fun `returns untitled for empty`() {
            FolderStorage.slugify("") shouldBe "untitled"
            FolderStorage.slugify("!!!") shouldBe "untitled"
        }
    }

    // ── File locking ───────────────────────────────────────────────────────

    @Nested
    inner class FileLocking {
        @BeforeEach
        fun init() { storage.ensure() }

        @Test
        fun `write fails when lock is already held`() {
            val lockFile = rootPath.resolve(".jolli/lock")
            Files.createDirectories(lockFile.parent)

            FileChannel.open(
                lockFile,
                StandardOpenOption.CREATE,
                StandardOpenOption.WRITE,
            ).use { channel ->
                channel.lock().use {
                    assertThrows<IllegalStateException> {
                        storage.writeFiles(
                            listOf(FileWrite("test.txt", "content")),
                            "should fail",
                        )
                    }
                }
            }
        }
    }

    // ── Full lifecycle ─────────────────────────────────────────────────────

    @Nested
    inner class FullLifecycle {
        @BeforeEach
        fun init() { storage.ensure() }

        @Test
        fun `StorageProvider interface`() {
            val provider: StorageProvider = storage
            provider shouldNotBe null
        }

        @Test
        fun `write summary + index, read back, list, delete`() {
            val summaryJson = makeSummaryJson()

            // Write
            storage.writeFiles(
                listOf(
                    FileWrite("summaries/abc12345deadbeef.json", summaryJson),
                    FileWrite("index.json", """{"version":3,"entries":[]}"""),
                ),
                "initial write",
            )

            // Read hidden data
            storage.readFile("index.json") shouldBe """{"version":3,"entries":[]}"""
            storage.readFile("summaries/abc12345deadbeef.json") shouldBe summaryJson

            // List
            storage.listFiles("summaries") shouldHaveSize 1

            // Visible markdown exists
            val mdFiles = Files.walk(rootPath).use { stream ->
                stream.filter { it.isRegularFile() }
                    .filter { it.toString().endsWith(".md") }
                    .filter { !it.toString().contains(".jolli") }
                    .toList()
            }
            mdFiles shouldHaveSize 1

            // Delete
            storage.writeFiles(
                listOf(FileWrite("summaries/abc12345deadbeef.json", "", delete = true)),
                "delete",
            )
            storage.readFile("summaries/abc12345deadbeef.json") shouldBe null
            storage.listFiles("summaries").shouldBeEmpty()
        }
    }
}
