package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.core.BranchShareStore
import ai.jolli.jollimemory.services.BranchShareModal.ShareMember
import ai.jolli.jollimemory.services.BranchShareModal.ShareModalState
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.types.shouldBeInstanceOf
import io.mockk.every
import io.mockk.mockkObject
import io.mockk.slot
import io.mockk.unmockkAll
import io.mockk.verify
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class BranchShareModalTest {

    private val root = "/repo"
    private val branch = "feature/x"
    private val nowMs = 1_700_000_000_000L // fixed clock

    private class FakeIO : BranchShareModal.ShareModalIO {
        val states = mutableListOf<ShareModalState>()
        val errors = mutableListOf<String>()
        val infos = mutableListOf<String>()
        var openedUrl: String? = null
        var copied = false
        var emailed = false
        var social: ShareMessage.SocialPlatform? = null
        override fun postState(state: ShareModalState) { states.add(state) }
        override fun openUrl(url: String) { openedUrl = url }
        override fun composeEmail(branch: String, url: String, decisionCount: Int, titles: List<String>, recipients: List<String>) { emailed = true }
        override fun copyMessage(branch: String, url: String, decisionCount: Int, titles: List<String>) { copied = true }
        override fun openSocial(platform: ShareMessage.SocialPlatform, branch: String, url: String, decisionCount: Int, titles: List<String>) { social = platform }
        override fun formatExpiry(iso: String): String = "expires later"
        override fun notifyError(message: String) { errors.add(message) }
        override fun notifyInfo(message: String) { infos.add(message) }
        val last: ShareModalState get() = states.last()
    }

    private fun ctx(
        apiKey: String? = "sk-jol-test",
        commitHash: String? = null,
        visibility: String = "public",
        canOrg: Boolean = false,
        recipients: List<String> = emptyList(),
        expiryDays: Int? = null,
    ) = BranchShareModal.ShareModalContext(
        workspaceRoot = root,
        branch = branch,
        apiKey = apiKey,
        commitHash = commitHash,
        subjectTitle = "Build the thing",
        visibility = visibility,
        recipients = recipients,
        expiryDays = expiryDays,
        canOrg = canOrg,
        owner = ShareMember("Dev", "dev@x.com"),
        directory = emptyList(),
        loadBranchSummaries = { emptyList() },
        storeSummary = { _, _ -> },
        readPlanFromBranch = { null },
        readNoteBody = { null },
        resolveBinding = { JolliPushOrchestrator.BindingOutcome.CANCELLED },
        nowMs = nowMs,
    )

    private fun record(
        visibility: String = "public",
        refKind: String = BranchShareStore.LiveRef.KIND_BRANCH_COLLECTION,
        expiresAt: String = "2999-01-01T00:00:00Z",
    ) = BranchShareStore.BranchShareRecord(
        shareId = "42",
        shareUrl = "https://acme.jolli.ai/s/tok",
        visibility = visibility,
        ref = if (refKind == BranchShareStore.LiveRef.KIND_BRANCH_COLLECTION)
            BranchShareStore.LiveRef.branchCollection("feature-x", emptyList())
        else BranchShareStore.LiveRef.commitDocs(listOf(1), emptyList()),
        token8 = "abcd1234",
        expiresAt = expiresAt,
        decisionCount = 3,
        titles = listOf("A"),
    )

    @BeforeEach
    fun setUp() {
        mockkObject(BranchShareStore)
        mockkObject(BranchShareController)
        mockkObject(LiveShareController)
    }

    @AfterEach
    fun tearDown() = unmockkAll()

    @Test
    fun `deriveShareCollaborators puts owner first and resolves names`() {
        val rows = BranchShareModal.deriveShareCollaborators(
            owner = ShareMember("Dev", "dev@x.com"),
            recipients = listOf("dev@x.com", "sam@x.com", ""),
            directory = listOf(ShareMember("Sam Smith", "sam@x.com")),
        )
        rows.size shouldBe 2 // owner + sam (owner de-duped from recipients, blank skipped)
        rows[0].isOwner shouldBe true
        rows[1].name shouldBe "Sam Smith"
        rows[1].isOwner shouldBe false
    }

    @Test
    fun `open with no api key posts NeedsApiKey`() {
        val io = FakeIO()
        BranchShareModal.openShareModal(io, ctx(apiKey = null))
        io.last.shouldBeInstanceOf<ShareModalState.NeedsApiKey>()
    }

    @Test
    fun `open with no existing share posts NeedsCreate, defaulting public to org when canOrg`() {
        every { BranchShareStore.getBranchShare(root, branch, null) } returns null
        val io = FakeIO()
        BranchShareModal.openShareModal(io, ctx(canOrg = true))
        val state = io.last.shouldBeInstanceOf<ShareModalState.NeedsCreate>()
        state.visibility shouldBe "org"
    }

    @Test
    fun `open with a live branch share reconciles then posts Ready`() {
        every { BranchShareStore.getBranchShare(root, branch, null) } returns record()
        every { LiveShareController.reconcileLiveShare(any(), branch) } returns Unit

        val io = FakeIO()
        BranchShareModal.openShareModal(io, ctx())

        verify { LiveShareController.reconcileLiveShare(any(), branch) }
        io.states.first().shouldBeInstanceOf<ShareModalState.Loading>()
        io.last.shouldBeInstanceOf<ShareModalState.Ready>()
    }

    @Test
    fun `open with an expired share falls through to NeedsCreate`() {
        every { BranchShareStore.getBranchShare(root, branch, null) } returns
            record(expiresAt = "2000-01-01T00:00:00Z")
        val io = FakeIO()
        BranchShareModal.openShareModal(io, ctx())
        io.last.shouldBeInstanceOf<ShareModalState.NeedsCreate>()
    }

    @Test
    fun `create generates a live share and posts Ready`() {
        val params = slot<LiveShareController.GenerateParams>()
        every { LiveShareController.generateLiveShare(capture(params)) } returns
            JolliApiClient.LiveShareResult("42", "https://acme.jolli.ai/s/tok", "2999-01-01T00:00:00Z", "public")
        every { BranchShareStore.markPublicConfirmed(root, branch) } returns Unit
        every { BranchShareStore.getBranchShare(root, branch, null) } returns record()

        val io = FakeIO()
        BranchShareModal.createShareModal(io, ctx())

        params.captured.visibility shouldBe "public"
        verify { BranchShareStore.markPublicConfirmed(root, branch) }
        io.last.shouldBeInstanceOf<ShareModalState.Ready>()
    }

    @Test
    fun `create surfaces NothingToShare as an error state`() {
        every { BranchShareStore.markPublicConfirmed(root, branch) } returns Unit
        every { LiveShareController.generateLiveShare(any()) } throws LiveShareController.NothingToShareError(branch)

        val io = FakeIO()
        BranchShareModal.createShareModal(io, ctx())

        val err = io.last.shouldBeInstanceOf<ShareModalState.Error>()
        err.message shouldContain "No memories on"
    }

    @Test
    fun `target copy invokes copyMessage`() {
        every { BranchShareStore.getBranchShare(root, branch, null) } returns record()
        val io = FakeIO()
        BranchShareModal.shareModalTarget(io, ctx(), BranchShareModal.ShareTarget.Copy)
        io.copied shouldBe true
    }

    @Test
    fun `target on an expired link posts an error instead of acting`() {
        every { BranchShareStore.getBranchShare(root, branch, null) } returns
            record(expiresAt = "2000-01-01T00:00:00Z")
        val io = FakeIO()
        BranchShareModal.shareModalTarget(io, ctx(), BranchShareModal.ShareTarget.Page)
        io.openedUrl shouldBe null
        io.last.shouldBeInstanceOf<ShareModalState.Error>()
    }

    @Test
    fun `setVisibility to public records the one-time confirmation`() {
        every { BranchShareStore.markPublicConfirmed(root, branch) } returns Unit
        every { BranchShareController.setBranchShareVisibility(root, branch, any(), "public", null, null) } returns "public"
        every { BranchShareStore.getBranchShare(root, branch, null) } returns record()

        val io = FakeIO()
        BranchShareModal.setShareVisibilityModal(io, ctx(), "public")

        verify { BranchShareStore.markPublicConfirmed(root, branch) }
        io.last.shouldBeInstanceOf<ShareModalState.Ready>()
    }

    @Test
    fun `revoke posts Revoked and notifies`() {
        every { BranchShareController.revokeBranchShareForBranch(root, branch, any(), null) } returns Unit
        val io = FakeIO()
        BranchShareModal.revokeShareModal(io, ctx())
        io.last.shouldBeInstanceOf<ShareModalState.Revoked>()
        io.infos.shouldContain("Sharing stopped — the link no longer works.")
    }
}
