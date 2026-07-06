package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.bridge.GitRemoteUtils
import ai.jolli.jollimemory.core.BranchShareStore
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.KBPathResolver
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.mockk.every
import io.mockk.mockkObject
import io.mockk.slot
import io.mockk.unmockkAll
import io.mockk.verify
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class LiveShareControllerTest {

    private val root = "/repo"
    private val branch = "feature/x"
    private val apiKey = "sk-jol-test"

    private fun summary(hash: String) = CommitSummary(
        commitHash = hash, commitMessage = "feat: $hash", commitAuthor = "Dev",
        commitDate = "t", branch = branch, generatedAt = "t",
    )

    private fun deps(summaries: List<CommitSummary>) = LiveShareController.Deps(
        workspaceRoot = root,
        apiKey = apiKey,
        loadBranchSummaries = { summaries },
        storeSummary = { _, _ -> },
        readPlanFromBranch = { null },
        readNoteBody = { null },
        resolveBinding = { JolliPushOrchestrator.BindingOutcome.CANCELLED },
    )

    @BeforeEach
    fun setUp() {
        mockkObject(JolliApiClient)
        mockkObject(JolliPushOrchestrator)
        mockkObject(BranchShareStore)
        mockkObject(GitRemoteUtils)
        mockkObject(KBPathResolver)

        every { JolliApiClient.parseJolliApiKey(any()) } returns
            JolliApiClient.JolliApiKeyMeta(t = "acme", u = "https://acme.jolli.ai", o = null)
        every { GitRemoteUtils.getCanonicalRepoUrl(any()) } returns "https://github.com/o/r"
        every { GitRemoteUtils.sanitizeBranchSlug(any()) } returns "feature-x"
        every { KBPathResolver.extractRepoName(any()) } returns "r"
        every { BranchShareStore.putBranchShare(any(), any(), any(), any()) } returns Unit

        // Each summary push mints a distinct summary docId (100 + index-ish via hash).
        every { JolliPushOrchestrator.pushSummaryWithAttachments(any(), any(), any(), any(), any()) } answers {
            val s = firstArg<CommitSummary>()
            JolliPushOrchestrator.PushSummaryResult(
                pushedDoc = JolliPushOrchestrator.PushedDoc(
                    commitHash = s.commitHash,
                    summaryDocId = s.commitHash.hashCode() and 0xffff,
                    summaryUrl = "u",
                    plans = emptyList(),
                    notes = emptyList(),
                ),
                updatedSummary = s,
                attachmentFailures = emptyList(),
                isUpdate = false,
                attachmentCount = 0,
            )
        }
    }

    @AfterEach
    fun tearDown() = unmockkAll()

    @Test
    fun `generate branch share builds a branchCollection ref covering every commit`() {
        every { JolliApiClient.createLiveShare(any(), any(), any()) } returns
            JolliApiClient.LiveShareResult("77", "https://acme.jolli.ai/s/tok", "2999-01-01T00:00:00Z", "public", "tok12345")

        val payload = slot<JolliApiClient.LiveSharePayload>()
        every { JolliApiClient.createLiveShare(any(), any(), capture(payload)) } returns
            JolliApiClient.LiveShareResult("77", "https://acme.jolli.ai/s/tok", "2999-01-01T00:00:00Z", "public", "tok12345")
        val stored = slot<BranchShareStore.BranchShareRecord>()
        every { BranchShareStore.putBranchShare(root, branch, capture(stored), null) } returns Unit

        LiveShareController.generateLiveShare(
            LiveShareController.GenerateParams(
                deps = deps(listOf(summary("aaaa1111"), summary("bbbb2222"))),
                branch = branch,
                visibility = "public",
            ),
        )

        payload.captured.kind shouldBe "branch"
        payload.captured.ref.kind shouldBe BranchShareStore.LiveRef.KIND_BRANCH_COLLECTION
        payload.captured.ref.covered!! shouldHaveSize 2
        stored.captured.shareId shouldBe "77"
        stored.captured.token8 shouldBe "tok12345"
    }

    @Test
    fun `generate a commit share builds a commitDocs ref`() {
        val payload = slot<JolliApiClient.LiveSharePayload>()
        every { JolliApiClient.createLiveShare(any(), any(), capture(payload)) } returns
            JolliApiClient.LiveShareResult("88", "https://acme.jolli.ai/s/tok", "2999-01-01T00:00:00Z", "org")

        val target = summary("cccc3333")
        LiveShareController.generateLiveShare(
            LiveShareController.GenerateParams(
                deps = deps(listOf(target)),
                branch = branch,
                commitHash = "cccc3333",
                commitSummary = target,
                visibility = "org",
            ),
        )

        payload.captured.kind shouldBe "commit"
        payload.captured.ref.kind shouldBe BranchShareStore.LiveRef.KIND_COMMIT_DOCS
        payload.captured.ref.summaryDocIds!! shouldHaveSize 1
    }

    @Test
    fun `generate throws NothingToShare when the subject has no summaries`() {
        shouldThrow<LiveShareController.NothingToShareError> {
            LiveShareController.generateLiveShare(
                LiveShareController.GenerateParams(deps = deps(emptyList()), branch = branch, visibility = "public"),
            )
        }
    }

    @Test
    fun `reconcile is a no-op when there is no existing share`() {
        every { BranchShareStore.getBranchShare(root, branch, null) } returns null
        LiveShareController.reconcileLiveShare(deps(listOf(summary("aaaa1111"))), branch)
        verify(exactly = 0) { JolliApiClient.updateLiveShare(any(), any(), any(), any()) }
    }

    @Test
    fun `reconcile is a no-op for a commit-docs share`() {
        every { BranchShareStore.getBranchShare(root, branch, null) } returns
            BranchShareStore.BranchShareRecord(
                shareId = "9", shareUrl = "u", visibility = "public",
                ref = BranchShareStore.LiveRef.commitDocs(listOf(1), emptyList()),
                expiresAt = "2999-01-01T00:00:00Z", decisionCount = 0,
            )
        LiveShareController.reconcileLiveShare(deps(listOf(summary("aaaa1111"))), branch)
        verify(exactly = 0) { JolliApiClient.updateLiveShare(any(), any(), any(), any()) }
    }

    @Test
    fun `reconcile re-pushes and patches an existing branch share`() {
        every { BranchShareStore.getBranchShare(root, branch, null) } returns
            BranchShareStore.BranchShareRecord(
                shareId = "55", shareUrl = "https://acme.jolli.ai/s/tok", visibility = "public",
                ref = BranchShareStore.LiveRef.branchCollection("feature-x", emptyList()),
                token8 = "old12345", expiresAt = "2999-01-01T00:00:00Z", decisionCount = 1,
            )
        every { JolliApiClient.updateLiveShare(any(), any(), "55", any()) } returns
            JolliApiClient.LiveShareUpdateResult(shareId = "55")

        LiveShareController.reconcileLiveShare(deps(listOf(summary("aaaa1111"))), branch)

        verify { JolliApiClient.updateLiveShare(any(), any(), "55", any()) }
        verify { BranchShareStore.putBranchShare(root, branch, any(), null) }
    }
}
