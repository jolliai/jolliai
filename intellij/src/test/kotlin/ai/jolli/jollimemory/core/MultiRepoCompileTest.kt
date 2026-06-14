package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.sync.VaultWriteLock
import ai.jolli.jollimemory.sync.VaultWriteLockMode
import com.google.gson.Gson
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.exists

class MultiRepoCompileTest {

    @TempDir
    lateinit var tempDir: Path
    private lateinit var parent: Path

    @BeforeEach
    fun setUp() {
        parent = tempDir.resolve("MemoryBank")
        Files.createDirectories(parent)
    }

    private val config = IngestPipeline.LlmConfig(jolliApiKey = "x")

    /** Seeds a repo at parent/<name> with one root summary as a pending source. */
    private fun seedRepo(name: String, hash: String): Path {
        val kbRoot = parent.resolve(name)
        val mm = MetadataManager(kbRoot.resolve(".jolli"))
        val storage = FolderStorage(kbRoot, mm)
        storage.ensure()
        val summary = CommitSummary(
            commitHash = hash, commitMessage = "Msg $name", commitAuthor = "me",
            commitDate = "2026-01-01T00:00:00Z", branch = "main", generatedAt = "g",
            topics = listOf(TopicSummary(title = "T", trigger = "why", response = "what", decisions = "dec")),
        )
        storage.writeFiles(listOf(FileWrite("summaries/$hash.json", Gson().toJson(summary))), "seed")
        mm.writeIndex(
            SummaryIndex(
                entries = listOf(
                    SummaryIndexEntry(commitHash = hash, parentCommitHash = null, commitMessage = "Msg $name", commitDate = "2026-01-01T00:00:00Z", branch = "main", generatedAt = "g"),
                ),
            ),
        )
        return kbRoot
    }

    private fun result(text: String) = LlmClient.LlmCallResult(text, "m", 0, 0, 0, null)

    private fun fakeLlm(failOnRepoMsg: String? = null) = IngestPipeline.LlmCaller { action, params, _, _ ->
        when (action) {
            "route" -> {
                if (failOnRepoMsg != null && params["sources"]?.contains(failOnRepoMsg) == true) {
                    throw RuntimeException("boom for $failOnRepoMsg")
                }
                result("""{"newTopics":[{"stableSlug":"topic-a","title":"Topic A","sourceIndexes":[0]}]}""")
            }
            "reconcile" -> result("===TOPIC===\n---TITLE---\nTopic A\n---STABLESLUG---\ntopic-a\n---SUMMARY---\ns\n---CONTENT---\nbody\n")
            else -> result("")
        }
    }

    @Test
    fun `discoverRepos includes only folders with a jolli index and respects excludes`() {
        seedRepo("repoB", "b1")
        seedRepo("repoA", "a1")
        // A directory with .jolli but no index.json is not a compilable repo.
        Files.createDirectories(parent.resolve("bare/.jolli"))
        // A plain folder is ignored.
        Files.createDirectories(parent.resolve("notes"))

        MultiRepoCompile.discoverRepos(parent).map { it.fileName.toString() } shouldContainExactly listOf("repoA", "repoB")
        MultiRepoCompile.discoverRepos(parent, excludeFolders = listOf("repoB")).map { it.fileName.toString() } shouldContainExactly listOf("repoA")
    }

    @Test
    fun `compiles every repo and regenerates each wiki`() {
        val a = seedRepo("repoA", "a1")
        val b = seedRepo("repoB", "b1")
        val r = MultiRepoCompile.compileAllRepos(parent, config, nowIso = "2026-02-02T00:00:00Z", llm = fakeLlm())
        r.skipped.shouldBe(false)
        r.failed shouldBe 0
        r.totalIngested shouldBe 2
        r.repos.map { it.folder } shouldContainExactly listOf("repoA", "repoB")
        a.resolve("_wiki/_index.md").exists().shouldBeTrue()
        b.resolve("_wiki/_index.md").exists().shouldBeTrue()
    }

    @Test
    fun `isolates a per-repo failure and continues the sweep`() {
        seedRepo("repoA", "a1")
        seedRepo("repoB", "b1")
        // The fake throws on repoB's route call.
        val r = MultiRepoCompile.compileAllRepos(parent, config, nowIso = "t", llm = fakeLlm(failOnRepoMsg = "Msg repoB"))
        r.failed shouldBe 1
        r.totalIngested shouldBe 1 // only repoA
        r.repos.single { it.folder == "repoB" }.error.shouldNotBeNull()
        r.repos.single { it.folder == "repoA" }.ingested shouldBe 1
    }

    @Test
    fun `skips the sweep when the vault-write lock is held`() {
        seedRepo("repoA", "a1")
        val held = VaultWriteLock.acquire(parent.toString(), VaultWriteLockMode.FailFast)
        held.shouldNotBeNull()
        try {
            val r = MultiRepoCompile.compileAllRepos(parent, config, llm = fakeLlm())
            r.skipped.shouldBeTrue()
            r.repos.isEmpty().shouldBeTrue()
        } finally {
            held!!.release()
        }
    }
}
