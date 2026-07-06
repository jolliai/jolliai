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
            titles = listOf("A", "B"),
        )

    @Test
    fun `put then get round-trips a record`() {
        BranchShareStore.putBranchShare(projectDir, "feature/x", record())
        val got = BranchShareStore.getBranchShare(projectDir, "feature/x")
        got.shouldNotBeNull()
        got.shareId shouldBe "42"
        got.decisionCount shouldBe 3
        got.titles shouldBe listOf("A", "B")
    }

    @Test
    fun `branch and commit shares key independently`() {
        BranchShareStore.putBranchShare(projectDir, "feature/x", record("branch-share"))
        BranchShareStore.putBranchShare(projectDir, "feature/x", record("commit-share"), commitHash = "abc123")
        BranchShareStore.getBranchShare(projectDir, "feature/x")!!.shareId shouldBe "branch-share"
        BranchShareStore.getBranchShare(projectDir, "feature/x", "abc123")!!.shareId shouldBe "commit-share"
    }

    @Test
    fun `LiveRef branchCollection round-trips through JSON`() {
        val ref = BranchShareStore.LiveRef.branchCollection(
            relativePath = "feature-x",
            covered = listOf(BranchShareStore.CoveredEntry("abc123", 7, listOf(8, 9))),
        )
        BranchShareStore.putBranchShare(projectDir, "feature/x", record().copy(ref = ref))
        val got = BranchShareStore.getBranchShare(projectDir, "feature/x")!!
        got.ref.shouldNotBeNull()
        got.ref!!.kind shouldBe BranchShareStore.LiveRef.KIND_BRANCH_COLLECTION
        got.ref!!.relativePath shouldBe "feature-x"
        got.ref!!.covered!!.single().summaryDocId shouldBe 7
        got.ref!!.covered!!.single().attachmentDocIds shouldBe listOf(8, 9)
    }

    @Test
    fun `remove drops the record when not confirmed-public`() {
        BranchShareStore.putBranchShare(projectDir, "feature/x", record())
        BranchShareStore.removeBranchShare(projectDir, "feature/x")
        BranchShareStore.getBranchShare(projectDir, "feature/x").shouldBeNull()
    }

    @Test
    fun `confirmed-public survives put and remove`() {
        BranchShareStore.markPublicConfirmed(projectDir, "feature/x")
        BranchShareStore.isPublicConfirmed(projectDir, "feature/x") shouldBe true

        // Put preserves the flag even though the incoming record omits it.
        BranchShareStore.putBranchShare(projectDir, "feature/x", record())
        BranchShareStore.getBranchShare(projectDir, "feature/x")!!.confirmedPublic shouldBe true

        // Remove keeps a blank placeholder that retains the confirmation.
        BranchShareStore.removeBranchShare(projectDir, "feature/x")
        BranchShareStore.isPublicConfirmed(projectDir, "feature/x") shouldBe true
        BranchShareStore.getBranchShare(projectDir, "feature/x")!!.shareId shouldBe ""
    }

    @Test
    fun `getBranchShare returns null for an unknown subject`() {
        BranchShareStore.getBranchShare(projectDir, "never-shared").shouldBeNull()
    }
}
