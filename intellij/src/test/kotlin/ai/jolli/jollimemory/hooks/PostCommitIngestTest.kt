package ai.jolli.jollimemory.hooks

import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.FileWrite
import ai.jolli.jollimemory.core.FolderStorage
import ai.jolli.jollimemory.core.IngestPipeline
import ai.jolli.jollimemory.core.LlmClient
import ai.jolli.jollimemory.core.MetadataManager
import ai.jolli.jollimemory.core.SummaryIndex
import ai.jolli.jollimemory.core.SummaryIndexEntry
import ai.jolli.jollimemory.core.TopicSummary
import com.google.gson.Gson
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import kotlin.io.path.exists

/**
 * Covers the new post-commit auto-compile glue ([PostCommitHook.ingestAndRenderRepo]):
 * the conditional-render rule (`ingested > 0 || wiki missing`) that keeps the
 * IntelliJ wiki fresh on commit without the manual button.
 */
class PostCommitIngestTest {

    @TempDir
    lateinit var tempDir: Path
    private lateinit var kbRoot: Path
    private lateinit var storage: FolderStorage

    @BeforeEach
    fun setUp() {
        kbRoot = tempDir.resolve("MemoryBank").resolve("myrepo")
        storage = FolderStorage(kbRoot, MetadataManager(kbRoot.resolve(".jolli")))
        storage.ensure()
    }

    private fun result(text: String) = LlmClient.LlmCallResult(text, "m", 0, 0, 0, null)

    private val fakeLlm = IngestPipeline.LlmCaller { action, _, _, _ ->
        when (action) {
            "route" -> result("""{"newTopics":[{"stableSlug":"t","title":"T","sourceIndexes":[0]}]}""")
            "reconcile" -> result("===TOPIC===\n---TITLE---\nT\n---STABLESLUG---\nt\n---SUMMARY---\ns\n---CONTENT---\nbody\n")
            else -> result("")
        }
    }

    private fun seedSummary(hash: String) {
        val summary = CommitSummary(
            commitHash = hash, commitMessage = "Msg", commitAuthor = "me",
            commitDate = "2026-01-01T00:00:00Z", branch = "main", generatedAt = "g",
            topics = listOf(TopicSummary(title = "T", trigger = "why", response = "what", decisions = "dec")),
        )
        storage.writeFiles(listOf(FileWrite("summaries/$hash.json", Gson().toJson(summary))), "seed")
        MetadataManager(kbRoot.resolve(".jolli")).writeIndex(
            SummaryIndex(entries = listOf(SummaryIndexEntry(commitHash = hash, parentCommitHash = null, commitMessage = "Msg", commitDate = "2026-01-01T00:00:00Z", branch = "main", generatedAt = "g"))),
        )
    }

    @Test
    fun `ingests pending sources and renders the wiki`() {
        seedSummary("hash1")
        val rendered = PostCommitHook.ingestAndRenderRepo(kbRoot, storage, fakeLlm, null)
        rendered.shouldBeTrue()
        kbRoot.resolve("_wiki/_index.md").exists().shouldBeTrue()
        kbRoot.resolve("_wiki/topic--t.md").exists().shouldBeTrue()
    }

    @Test
    fun `re-renders a deleted wiki even when nothing new is pending`() {
        seedSummary("hash1")
        PostCommitHook.ingestAndRenderRepo(kbRoot, storage, fakeLlm, null) // first pass ingests + renders

        // Nothing new pending now; wiki present → no render.
        PostCommitHook.ingestAndRenderRepo(kbRoot, storage, fakeLlm, null).shouldBeFalse()

        // User deletes the wiki → next pass re-renders even with nothing pending.
        kbRoot.resolve("_wiki/_index.md").toFile().delete()
        kbRoot.resolve("_wiki/topic--t.md").toFile().delete()
        PostCommitHook.ingestAndRenderRepo(kbRoot, storage, fakeLlm, null).shouldBeTrue()
        kbRoot.resolve("_wiki/_index.md").exists().shouldBeTrue()
    }
}
