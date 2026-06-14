package ai.jolli.jollimemory.core

import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldContainExactlyInAnyOrder
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.exists

/**
 * End-to-end render test: topic pages + index written through the stores into a
 * [FolderStorage], rendered to the visible `_wiki/` layer via [TopicWikiRenderer].
 */
class TopicWikiRendererTest {

    @TempDir
    lateinit var tempDir: Path

    private lateinit var rootPath: Path
    private lateinit var metadataManager: MetadataManager
    private lateinit var storage: FolderStorage

    @BeforeEach
    fun setUp() {
        rootPath = tempDir.resolve("kb")
        metadataManager = MetadataManager(rootPath.resolve(".jolli"))
        storage = FolderStorage(rootPath, metadataManager)
        storage.ensure()
        metadataManager.saveConfig(KBConfig(repoName = "myrepo"))
    }

    private fun page(slug: String, title: String, refs: List<SourceRef> = emptyList()) = TopicPage(
        stableSlug = slug,
        title = title,
        content = "Content of $title.",
        relatedBranches = emptyList(),
        sourceRefs = refs,
        lastUpdatedAt = "2026-01-01T00:00:00Z",
    )

    private fun indexFor(vararg pages: TopicPage) = TopicIndex(
        topics = pages.map {
            TopicIndexEntry(it.stableSlug, it.title, "summary", it.relatedBranches, it.sourceRefs, it.lastUpdatedAt)
        },
    )

    private fun read(rel: String): String = Files.readString(rootPath.resolve(rel), StandardCharsets.UTF_8)

    @Test
    fun `renders index and topic pages from the authoritative index`() {
        val auth = page("auth", "Auth")
        val sync = page("sync", "Sync")
        TopicPageStore.saveTopicPage(auth, storage)
        TopicPageStore.saveTopicPage(sync, storage)
        TopicIndexStore.saveTopicIndex(indexFor(auth, sync), storage)

        TopicWikiRenderer.renderTopicKBWiki(storage)

        rootPath.resolve("_wiki/_index.md").exists().shouldBeTrue()
        rootPath.resolve("_wiki/topic--auth.md").exists().shouldBeTrue()
        rootPath.resolve("_wiki/topic--sync.md").exists().shouldBeTrue()

        val index = read("_wiki/_index.md")
        index shouldContain "# myrepo · Knowledge Wiki"
        index shouldContain "- [Auth](topic--auth.md)"
        index shouldContain "- [Sync](topic--sync.md)"

        read("_wiki/topic--auth.md") shouldContain "Content of Auth."

        storage.isTopicWikiPresent().shouldBeTrue()

        // Manifest tracks all wiki artifacts (2 topics + index) as type="wiki".
        val wikiEntries = metadataManager.readManifest().files.filter { it.type == "wiki" }
        wikiEntries.map { it.path }.shouldContainExactlyInAnyOrder(
            "_wiki/topic--auth.md", "_wiki/topic--sync.md", "_wiki/_index.md",
        )
    }

    @Test
    fun `re-render wipes topic pages no longer in the index`() {
        val auth = page("auth", "Auth")
        val sync = page("sync", "Sync")
        TopicPageStore.saveTopicPage(auth, storage)
        TopicPageStore.saveTopicPage(sync, storage)
        TopicIndexStore.saveTopicIndex(indexFor(auth, sync), storage)
        TopicWikiRenderer.renderTopicKBWiki(storage)
        rootPath.resolve("_wiki/topic--sync.md").exists().shouldBeTrue()

        // Drop "sync" from the index (e.g. after --rebuild) and re-render.
        TopicIndexStore.saveTopicIndex(indexFor(auth), storage)
        TopicWikiRenderer.renderTopicKBWiki(storage)

        rootPath.resolve("_wiki/topic--auth.md").exists().shouldBeTrue()
        rootPath.resolve("_wiki/topic--sync.md").exists().shouldBeFalse()

        val wikiEntries = metadataManager.readManifest().files.filter { it.type == "wiki" }
        wikiEntries.map { it.path }.shouldContainExactlyInAnyOrder("_wiki/topic--auth.md", "_wiki/_index.md")
    }

    @Test
    fun `source commit links resolve through the manifest`() {
        // A commit manifest entry + branch mapping lets a summary sourceRef render a link.
        metadataManager.updateBranchMapping("feature-oauth", "feature/oauth")
        metadataManager.updateManifest(
            ManifestEntry(
                path = "feature-oauth/summary--add-auth-abc12345.md",
                fileId = "abc12345deadbeef",
                type = "commit",
                fingerprint = "fp",
                source = ManifestSource(commitHash = "abc12345deadbeef", branch = "feature/oauth"),
                title = "Add auth",
            ),
        )
        val auth = page("auth", "Auth", refs = listOf(SourceRef("summary", "abc12345deadbeef", "t", branch = "feature/oauth")))
        TopicPageStore.saveTopicPage(auth, storage)
        TopicIndexStore.saveTopicIndex(indexFor(auth), storage)

        TopicWikiRenderer.renderTopicKBWiki(storage)

        read("_wiki/topic--auth.md") shouldContain
            "- [abc12345](../feature-oauth/summary--add-auth-abc12345.md) — Add auth"
    }
}
