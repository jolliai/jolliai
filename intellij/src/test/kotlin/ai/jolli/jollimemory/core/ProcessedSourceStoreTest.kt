package ai.jolli.jollimemory.core

import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

class ProcessedSourceStoreTest {

    @TempDir
    lateinit var tempDir: Path
    private lateinit var storage: FolderStorage

    @BeforeEach
    fun setUp() {
        val kbRoot = tempDir.resolve("kb")
        storage = FolderStorage(kbRoot, MetadataManager(kbRoot.resolve(".jolli")))
        storage.ensure()
    }

    @Test
    fun `emptyProcessedSet serializes with all four buckets in canonical order`() {
        val expected = listOf(
            "{",
            "\t\"schemaVersion\": 1,",
            "\t\"processed\": {",
            "\t\t\"summary\": [],",
            "\t\t\"plan\": [],",
            "\t\t\"note\": [],",
            "\t\t\"userfile\": []",
            "\t}",
            "}",
        ).joinToString("\n")
        TopicJson.stringify(ProcessedSourceStore.emptyProcessedSet()) shouldBe expected
    }

    @Test
    fun `hasProcessed and addProcessed are idempotent`() {
        val ref = SourceRef(SourceType.SUMMARY, "hash1", "t")
        var set = ProcessedSourceStore.emptyProcessedSet()
        ProcessedSourceStore.hasProcessed(set, ref).shouldBeFalse()

        set = ProcessedSourceStore.addProcessed(set, listOf(ref))
        ProcessedSourceStore.hasProcessed(set, ref).shouldBeTrue()

        // Adding again does not duplicate.
        set = ProcessedSourceStore.addProcessed(set, listOf(ref))
        set.processed[SourceType.SUMMARY] shouldBe listOf("hash1")
    }

    @Test
    fun `save then read round-trips through the provider`() {
        val set = ProcessedSourceStore.addProcessed(
            ProcessedSourceStore.emptyProcessedSet(),
            listOf(
                SourceRef(SourceType.SUMMARY, "h1", "t"),
                SourceRef(SourceType.PLAN, "p1", "t"),
            ),
        )
        ProcessedSourceStore.saveProcessedSet(set, storage)
        val read = ProcessedSourceStore.readProcessedSet(storage)
        read.processed[SourceType.SUMMARY] shouldBe listOf("h1")
        read.processed[SourceType.PLAN] shouldBe listOf("p1")
        read.processed[SourceType.NOTE] shouldBe emptyList()
    }

    @Test
    fun `read of missing file yields the empty set`() {
        val read = ProcessedSourceStore.readProcessedSet(storage)
        read.processed[SourceType.USERFILE] shouldBe emptyList()
    }
}
