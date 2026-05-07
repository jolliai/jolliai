package ai.jolli.jollimemory.core

import com.google.gson.GsonBuilder
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isRegularFile

class MigrationEngineTest {

    @TempDir
    lateinit var tempDir: Path

    private lateinit var orphan: InMemoryStorage
    private lateinit var kbRoot: Path
    private lateinit var metadataManager: MetadataManager
    private lateinit var folderStorage: FolderStorage
    private lateinit var engine: MigrationEngine
    private val gson = GsonBuilder().setPrettyPrinting().create()

    @BeforeEach
    fun setUp() {
        orphan = InMemoryStorage()
        kbRoot = tempDir.resolve("kb")
        metadataManager = MetadataManager(kbRoot.resolve(".jolli"))
        folderStorage = FolderStorage(kbRoot, metadataManager)
        folderStorage.ensure()
    }

    private fun createEngine(): MigrationEngine {
        // MigrationEngine expects OrphanBranchStorage but we use InMemoryStorage for testing.
        // We'll test via the public API which just needs StorageProvider-compatible reads.
        // Since MigrationEngine only calls readFile/listFiles on orphan, we create a
        // test-friendly wrapper.
        return MigrationEngine(
            orphanStorage = TestOrphanStorage(orphan),
            folderStorage = folderStorage,
            metadataManager = metadataManager,
        )
    }

    private fun makeSummary(
        hash: String,
        message: String = "Test commit",
        branch: String = "main",
        parentHash: String? = null,
    ): CommitSummary {
        return CommitSummary(
            commitHash = hash,
            commitMessage = message,
            commitAuthor = "Alice",
            commitDate = "2026-01-15T10:00:00Z",
            branch = branch,
            generatedAt = "2026-01-15T10:00:00Z",
            topics = listOf(TopicSummary("Topic", "trigger", "response", "decisions")),
            stats = DiffStats(2, 20, 5),
            children = if (parentHash != null) listOf(makeSummary(parentHash)) else null,
        )
    }

    private fun makeIndex(entries: List<SummaryIndexEntry>): SummaryIndex {
        return SummaryIndex(version = 3, entries = entries)
    }

    private fun makeIndexEntry(hash: String, parentHash: String? = null, branch: String = "main"): SummaryIndexEntry {
        return SummaryIndexEntry(
            commitHash = hash,
            parentCommitHash = parentHash,
            commitMessage = "Test",
            commitDate = "2026-01-15T10:00:00Z",
            branch = branch,
            generatedAt = "2026-01-15T10:00:00Z",
        )
    }

    /** Seeds the orphan storage with an index, summaries, and optionally transcripts. */
    private fun seedOrphan(summaries: List<CommitSummary>, transcripts: Map<String, String> = emptyMap()) {
        val entries = summaries.map { s ->
            makeIndexEntry(s.commitHash, s.children?.firstOrNull()?.commitHash, s.branch)
        }
        orphan.writeFiles(
            listOf(FileWrite("index.json", gson.toJson(makeIndex(entries)))),
            "seed index",
        )
        for (s in summaries) {
            orphan.writeFiles(
                listOf(FileWrite("summaries/${s.commitHash}.json", gson.toJson(s))),
                "seed summary",
            )
        }
        for ((hash, content) in transcripts) {
            orphan.writeFiles(
                listOf(FileWrite("transcripts/$hash.json", content)),
                "seed transcript",
            )
        }
    }

    // ── Basic migration ────────────────────────────────────────────────────

    @Nested
    inner class BasicMigration {
        @Test
        fun `migrates single summary to markdown`() {
            val summary = makeSummary("aaa11111aaa11111")
            seedOrphan(listOf(summary))

            val engine = createEngine()
            val state = engine.runMigration()

            state.status shouldBe "completed"
            state.totalEntries shouldBe 1
            state.migratedEntries shouldBe 1

            // Hidden JSON should exist
            folderStorage.readFile("summaries/aaa11111aaa11111.json") shouldNotBe null

            // Visible markdown should exist
            val manifest = metadataManager.readManifest()
            manifest.files.filter { it.type == "commit" } shouldHaveSize 1

            val mdEntry = manifest.files.first { it.type == "commit" }
            mdEntry.path shouldContain ".md"

            val mdContent = Files.readString(kbRoot.resolve(mdEntry.path), StandardCharsets.UTF_8)
            mdContent shouldContain "---"
            mdContent shouldContain "commitHash: aaa11111aaa11111"
        }

        @Test
        fun `migrates multiple summaries`() {
            seedOrphan(listOf(
                makeSummary("aaa11111aaa11111", "First commit"),
                makeSummary("bbb22222bbb22222", "Second commit"),
                makeSummary("ccc33333ccc33333", "Third commit", branch = "feature/test"),
            ))

            val state = createEngine().runMigration()

            state.status shouldBe "completed"
            state.migratedEntries shouldBe 3

            val manifest = metadataManager.readManifest()
            manifest.files.filter { it.type == "commit" } shouldHaveSize 3
        }

        @Test
        fun `migrates transcripts alongside summaries`() {
            seedOrphan(
                listOf(makeSummary("aaa11111aaa11111")),
                transcripts = mapOf("aaa11111aaa11111" to """{"sessions":[]}"""),
            )

            createEngine().runMigration()

            folderStorage.readFile("transcripts/aaa11111aaa11111.json") shouldBe """{"sessions":[]}"""
        }

        @Test
        fun `migrates plans`() {
            seedOrphan(listOf(makeSummary("aaa11111aaa11111")))
            orphan.writeFiles(
                listOf(FileWrite("plans/my-plan.md", "# My Plan\n\nSteps...")),
                "seed plan",
            )

            createEngine().runMigration()

            folderStorage.readFile("plans/my-plan.md") shouldBe "# My Plan\n\nSteps..."
        }

        @Test
        fun `migrates plan-progress`() {
            seedOrphan(listOf(makeSummary("aaa11111aaa11111")))
            orphan.writeFiles(
                listOf(FileWrite("plan-progress/my-plan.json", """{"version":1}""")),
                "seed plan-progress",
            )

            createEngine().runMigration()

            folderStorage.readFile("plan-progress/my-plan.json") shouldBe """{"version":1}"""
        }

        @Test
        fun `copies index to folder`() {
            seedOrphan(listOf(makeSummary("aaa11111aaa11111")))

            createEngine().runMigration()

            val indexJson = folderStorage.readFile("index.json")
            indexJson shouldNotBe null
            indexJson!! shouldContain "aaa11111aaa11111"
        }
    }

    // ── Idempotency and resume ─────────────────────────────────────────────

    @Nested
    inner class IdempotencyAndResume {
        @Test
        fun `running twice does not duplicate entries`() {
            seedOrphan(listOf(makeSummary("aaa11111aaa11111")))

            val engine = createEngine()
            engine.runMigration()
            engine.runMigration()

            val manifest = metadataManager.readManifest()
            manifest.files.filter { it.type == "commit" } shouldHaveSize 1
        }

        @Test
        fun `tracks progress in migration state`() {
            seedOrphan(listOf(
                makeSummary("aaa11111aaa11111"),
                makeSummary("bbb22222bbb22222"),
            ))

            val engine = createEngine()
            val progressLog = mutableListOf<Pair<Int, Int>>()
            engine.runMigration { migrated, total -> progressLog.add(migrated to total) }

            progressLog shouldHaveSize 2
            progressLog[0] shouldBe (1 to 2)
            progressLog[1] shouldBe (2 to 2)
        }
    }

    // ── Edge cases ─────────────────────────────────────────────────────────

    @Nested
    inner class EdgeCases {
        @Test
        fun `empty orphan branch — no index`() {
            val state = createEngine().runMigration()
            state.status shouldBe "completed"
        }

        @Test
        fun `empty index — no entries`() {
            orphan.writeFiles(
                listOf(FileWrite("index.json", gson.toJson(makeIndex(emptyList())))),
                "empty index",
            )

            val state = createEngine().runMigration()
            state.status shouldBe "completed"
            state.totalEntries shouldBe 0
        }

        @Test
        fun `skips child entries — only migrates roots`() {
            // Root entry with a child
            seedOrphan(listOf(makeSummary("aaa11111aaa11111", parentHash = "bbb22222bbb22222")))
            // Also add child to index
            val entries = listOf(
                makeIndexEntry("aaa11111aaa11111"),
                makeIndexEntry("bbb22222bbb22222", parentHash = "aaa11111aaa11111"),
            )
            orphan.writeFiles(
                listOf(FileWrite("index.json", gson.toJson(makeIndex(entries)))),
                "update index",
            )

            val state = createEngine().runMigration()
            // Only root (no parent) should be migrated
            state.totalEntries shouldBe 1
        }

        @Test
        fun `validates migration`() {
            seedOrphan(listOf(makeSummary("aaa11111aaa11111")))
            createEngine().runMigration()

            createEngine().validateMigration() shouldBe true
        }
    }

    // ── Branch organization ────────────────────────────────────────────────

    @Nested
    inner class BranchOrganization {
        @Test
        fun `summaries are organized by branch folder`() {
            seedOrphan(listOf(
                makeSummary("aaa11111aaa11111", "Feat on main", "main"),
                makeSummary("bbb22222bbb22222", "Feat on branch", "feature/login"),
            ))

            createEngine().runMigration()

            // Check branch folders exist
            Files.isDirectory(kbRoot.resolve("main")) shouldBe true
            Files.isDirectory(kbRoot.resolve("feature-login")) shouldBe true

            // Each branch should have one markdown file
            val mainMd = Files.walk(kbRoot.resolve("main")).use { s ->
                s.filter { it.isRegularFile() && it.toString().endsWith(".md") }.toList()
            }
            mainMd shouldHaveSize 1

            val branchMd = Files.walk(kbRoot.resolve("feature-login")).use { s ->
                s.filter { it.isRegularFile() && it.toString().endsWith(".md") }.toList()
            }
            branchMd shouldHaveSize 1
        }
    }
}

/**
 * Test wrapper that adapts InMemoryStorage to look like OrphanBranchStorage.
 * MigrationEngine expects OrphanBranchStorage type, so we extend it with a
 * minimal test double.
 */
class TestOrphanStorage(private val delegate: InMemoryStorage) : OrphanBranchStorage(
    // Pass a dummy GitOps — we override all methods so it's never called
    ai.jolli.jollimemory.bridge.GitOps("/dev/null")
) {
    override fun readFile(path: String): String? = delegate.readFile(path)
    override fun listFiles(prefix: String): List<String> = delegate.listFiles(prefix)
    override fun exists(): Boolean = true
    override fun ensure() {}
    override fun writeFiles(files: List<FileWrite>, message: String) {
        delegate.writeFiles(files, message)
    }
}
