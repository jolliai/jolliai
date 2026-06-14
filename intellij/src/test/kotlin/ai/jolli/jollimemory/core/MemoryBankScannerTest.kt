package ai.jolli.jollimemory.core

import io.kotest.matchers.collections.shouldContainExactlyInAnyOrder
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

class MemoryBankScannerTest {

    @TempDir
    lateinit var tempDir: Path
    private lateinit var localFolder: Path
    private lateinit var kbRoot: Path
    private lateinit var metadataManager: MetadataManager

    @BeforeEach
    fun setUp() {
        localFolder = tempDir.resolve("MemoryBank")
        kbRoot = localFolder.resolve("myrepo")
        metadataManager = MetadataManager(kbRoot.resolve(".jolli"))
        metadataManager.ensure()
    }

    private fun write(path: Path, content: String = "x") {
        Files.createDirectories(path.parent)
        Files.writeString(path, content, StandardCharsets.UTF_8)
    }

    @Test
    fun `classifies user files by scope and excludes generated + manifest + system files`() {
        // Global (outside kbRoot).
        write(localFolder.resolve("global.md"))
        // Repo-scope user file (included).
        write(kbRoot.resolve("ideas.md"))
        // Generated suffix + prefix (excluded by the secondary rule).
        write(kbRoot.resolve("add-auth-abc12345.md"))
        write(kbRoot.resolve("plan--foo.md"))
        write(kbRoot.resolve("topic--bar.md"))
        // Tracked in the manifest (excluded by the primary rule).
        write(kbRoot.resolve("tracked.md"))
        metadataManager.updateManifest(
            ManifestEntry(
                path = "tracked.md", fileId = "x", type = "commit",
                fingerprint = "fp", source = ManifestSource(),
            ),
        )
        // System dirs are skipped.
        write(kbRoot.resolve(".jolli/internal.md"))
        write(kbRoot.resolve("_wiki/_index.md"))
        // Branch folder (included, branch reverse-mapped). resolveFolderForBranch
        // creates the branches.json mapping and returns the transcoded folder name.
        val branchFolder = metadataManager.resolveFolderForBranch("feature/x")
        write(kbRoot.resolve("$branchFolder/branch-note.md"))

        val files = MemoryBankScanner.listAllUserKnowledgeFromRoot(kbRoot)

        files.map { it.path }.shouldContainExactlyInAnyOrder(
            "global.md",
            "myrepo/ideas.md",
            "myrepo/$branchFolder/branch-note.md",
        )

        val byPath = files.associateBy { it.path }
        byPath["global.md"]!!.scope shouldBe MemoryBankScanner.UserKnowledgeScope.GLOBAL
        byPath["myrepo/ideas.md"]!!.scope shouldBe MemoryBankScanner.UserKnowledgeScope.REPO
        val branchFile = byPath["myrepo/$branchFolder/branch-note.md"]!!
        branchFile.scope shouldBe MemoryBankScanner.UserKnowledgeScope.BRANCH
        branchFile.branch shouldBe "feature/x" // reverse-mapped from the folder
    }

    @Test
    fun `falls back to folder name when no branch mapping exists`() {
        write(kbRoot.resolve("feature-y/note.md"))
        val files = MemoryBankScanner.listAllUserKnowledgeFromRoot(kbRoot)
        files.single { it.scope == MemoryBankScanner.UserKnowledgeScope.BRANCH }.branch shouldBe "feature-y"
    }
}
