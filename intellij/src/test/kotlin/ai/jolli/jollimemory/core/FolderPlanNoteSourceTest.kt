package ai.jolli.jollimemory.core

import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

class FolderPlanNoteSourceTest {

    @TempDir
    lateinit var tempDir: Path
    private lateinit var kbRoot: Path
    private lateinit var metadataManager: MetadataManager

    @BeforeEach
    fun setUp() {
        kbRoot = tempDir.resolve("kb")
        metadataManager = MetadataManager(kbRoot.resolve(".jolli"))
        metadataManager.ensure()
    }

    private fun seedPlan() {
        metadataManager.updateManifest(
            ManifestEntry(
                path = "main/plan--myplan.md", fileId = "plan:myplan", type = "plan",
                fingerprint = "fp", source = ManifestSource(branch = "main"),
                title = "My Plan", updatedAt = "2026-01-02T00:00:00Z",
            ),
        )
        Files.createDirectories(kbRoot.resolve(".jolli/plans"))
        Files.writeString(kbRoot.resolve(".jolli/plans/myplan.md"), "# Plan body\n", StandardCharsets.UTF_8)
    }

    @Test
    fun `lists plan refs from the manifest with branch and timestamp`() {
        seedPlan()
        val refs = FolderPlanNoteSource.listFolderPlanNoteRefs(kbRoot)
        refs shouldHaveSize 1
        val ref = refs[0]
        ref.type shouldBe SourceType.PLAN
        ref.id shouldBe "myplan"
        ref.branch shouldBe "main"
        ref.timestamp shouldBe "2026-01-02T00:00:00Z"
    }

    @Test
    fun `loads plan content and headline, returns null for missing body`() {
        seedPlan()
        val ref = SourceRef(SourceType.PLAN, "myplan", "2026-01-02T00:00:00Z", branch = "main")
        FolderPlanNoteSource.loadFolderPlanNoteContent(kbRoot, ref) shouldBe "# Plan body\n"
        FolderPlanNoteSource.loadFolderPlanNoteHeadline(kbRoot, ref) shouldBe
            "(plan, main, 2026-01-02T00:00:00Z) My Plan"

        val missing = SourceRef(SourceType.NOTE, "nope", "t")
        FolderPlanNoteSource.loadFolderPlanNoteContent(kbRoot, missing).shouldBeNull()
    }

    @Test
    fun `ignores non plan-note manifest entries`() {
        metadataManager.updateManifest(
            ManifestEntry(
                path = "main/summary-abc12345.md", fileId = "abc12345", type = "commit",
                fingerprint = "fp", source = ManifestSource(branch = "main"),
            ),
        )
        FolderPlanNoteSource.listFolderPlanNoteRefs(kbRoot) shouldHaveSize 0
    }
}
