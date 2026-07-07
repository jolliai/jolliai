package ai.jolli.jollimemory.core

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class BranchShareStoreTest {

    @TempDir
    lateinit var tempDir: File

    private val projectDir: String get() = tempDir.absolutePath

    private fun record(id: String = "42", url: String = "https://acme.jolli.ai/s/tok") =
        BranchShareStore.BranchShareRecord(
            shareId = id,
            shareUrl = url,
            visibility = "public",
            expiresAt = "2026-12-31T00:00:00Z",
            decisionCount = 3,
        )

    @Test
    fun `put then get round-trips the single record`() {
        BranchShareStore.putBranchShare(projectDir, "feature/x", record())
        val got = BranchShareStore.getShare(projectDir, "feature/x")
        got.shouldNotBeNull()
        got.shareId shouldBe "42"
        got.decisionCount shouldBe 3
    }

    @Test
    fun `put overwrites in place (single slot per subject)`() {
        BranchShareStore.putBranchShare(projectDir, "feature/x", record(id = "first"))
        BranchShareStore.putBranchShare(projectDir, "feature/x", record(id = "second").copy(visibility = "people", recipients = listOf("a@x.com")))
        val got = BranchShareStore.getShare(projectDir, "feature/x")!!
        got.shareId shouldBe "second"
        got.visibility shouldBe "people"
        got.recipients shouldBe listOf("a@x.com")
    }

    @Test
    fun `branch and commit shares key independently`() {
        BranchShareStore.putBranchShare(projectDir, "feature/x", record("branch-share"))
        BranchShareStore.putBranchShare(projectDir, "feature/x", record("commit-share"), commitHash = "abc123")
        BranchShareStore.getShare(projectDir, "feature/x")!!.shareId shouldBe "branch-share"
        BranchShareStore.getShare(projectDir, "feature/x", "abc123")!!.shareId shouldBe "commit-share"
    }

    @Test
    fun `LiveRef branchCollection and contentHash round-trip through JSON`() {
        val ref = BranchShareStore.LiveRef.branchCollection(
            relativePath = "feature-x",
            covered = listOf(BranchShareStore.CoveredEntry("abc123", 7, listOf(8, 9))),
        )
        BranchShareStore.putBranchShare(projectDir, "feature/x", record().copy(ref = ref, contentHash = "deadbeef"))
        val got = BranchShareStore.getShare(projectDir, "feature/x")!!
        got.ref.shouldNotBeNull()
        got.ref!!.kind shouldBe BranchShareStore.LiveRef.KIND_BRANCH_COLLECTION
        got.ref!!.covered!!.single().summaryDocId shouldBe 7
        got.contentHash shouldBe "deadbeef"
    }

    @Test
    fun `remove drops the record and is idempotent`() {
        BranchShareStore.putBranchShare(projectDir, "feature/x", record())
        BranchShareStore.removeShare(projectDir, "feature/x")
        BranchShareStore.getShare(projectDir, "feature/x").shouldBeNull()
        BranchShareStore.removeShare(projectDir, "feature/x") // no throw
    }

    @Test
    fun `getShare returns null for an unknown subject`() {
        BranchShareStore.getShare(projectDir, "never-shared").shouldBeNull()
    }
}
