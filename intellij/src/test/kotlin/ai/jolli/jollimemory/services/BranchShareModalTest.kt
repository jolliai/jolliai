package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.core.BranchShareStore
import ai.jolli.jollimemory.services.BranchShareModal.ShareMember
import ai.jolli.jollimemory.services.BranchShareModal.ShareModalState
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf
import io.mockk.every
import io.mockk.mockkObject
import io.mockk.unmockkAll
import io.mockk.verify
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class BranchShareModalTest {

    private val root = "/repo"
    private val branch = "feature/x"

    private class FakeIO : BranchShareModal.ShareModalIO {
        val states = mutableListOf<ShareModalState>()
        val errors = mutableListOf<String>()
        val infos = mutableListOf<String>()
        var copiedText: String? = null
        val copyResults = mutableListOf<Boolean>()
        override fun postState(state: ShareModalState) { states.add(state) }
        override fun copyToClipboard(text: String): Boolean { copiedText = text; return true }
        override fun postCopyResult(result: BranchShareModal.ShareCopyResult) { copyResults.add(result.ok) }
        override fun notifyError(message: String) { errors.add(message) }
        override fun notifyInfo(message: String) { infos.add(message) }
        val last: ShareModalState get() = states.last()
    }

    private fun ctx(apiKey: String? = "sk-jol-test", commitHash: String? = null) =
        BranchShareModal.ShareModalContext(
            workspaceRoot = root,
            branch = branch,
            apiKey = apiKey,
            commitHash = commitHash,
            subjectTitle = "Build the thing",
            canOrg = true,
            owner = ShareMember("Dev", "dev@x.com"),
            accountMembers = emptyList(),
            gitCollaborators = emptyList(),
            loadBranchSummaries = { emptyList() },
            storeSummary = { _, _ -> },
            readPlanFromBranch = { null },
            readNoteBody = { null },
            resolveBinding = { JolliPushOrchestrator.BindingOutcome.CANCELLED },
            nowMs = 1_700_000_000_000L,
        )

    private fun record(visibility: String = "public", recipients: List<String>? = null) =
        BranchShareStore.BranchShareRecord(
            shareId = "42",
            shareUrl = "https://acme.jolli.ai/s/tok",
            visibility = visibility,
            recipients = recipients,
            ref = BranchShareStore.LiveRef.branchCollection("feature-x", emptyList()),
            expiresAt = "2999-01-01T00:00:00Z",
            decisionCount = 3,
        )

    private fun liveResult() = JolliApiClient.LiveShareResult("42", "https://acme.jolli.ai/s/tok", "2999-01-01T00:00:00Z", "public")

    @BeforeEach
    fun setUp() {
        mockkObject(BranchShareStore)
        mockkObject(BranchShareController)
        mockkObject(LiveShareController)
        mockkObject(JolliApiClient)
        every { BranchShareStore.putBranchShare(any(), any(), any(), any()) } returns Unit
    }

    @AfterEach
    fun tearDown() = unmockkAll()

    @Test
    fun `open with no api key posts NeedsApiKey`() {
        val io = FakeIO()
        BranchShareModal.openShareModal(io, ctx(apiKey = null))
        io.last.shouldBeInstanceOf<ShareModalState.NeedsApiKey>()
    }

    @Test
    fun `open with no existing share posts Ready with no link`() {
        every { BranchShareStore.getShare(root, branch, null) } returns null
        val io = FakeIO()
        BranchShareModal.openShareModal(io, ctx())
        val ready = io.last.shouldBeInstanceOf<ShareModalState.Ready>()
        ready.share shouldBe null
    }

    @Test
    fun `open with a live branch share reconciles then posts Ready with the link`() {
        every { BranchShareStore.getShare(root, branch, null) } returns record()
        every { LiveShareController.reconcileLiveShare(any(), branch) } returns Unit
        val io = FakeIO()
        BranchShareModal.openShareModal(io, ctx())
        verify { LiveShareController.reconcileLiveShare(any(), branch) }
        io.states.first().shouldBeInstanceOf<ShareModalState.Loading>()
        io.last.shouldBeInstanceOf<ShareModalState.Ready>().share!!.shareUrl shouldBe "https://acme.jolli.ai/s/tok"
    }

    @Test
    fun `copy link with no existing public share lazily mints then copies`() {
        var current: BranchShareStore.BranchShareRecord? = null
        every { BranchShareStore.getShare(root, branch, null) } answers { current }
        every { LiveShareController.generateLiveShare(any()) } answers { current = record(); liveResult() }

        val io = FakeIO()
        BranchShareModal.copyShareLinkModal(io, ctx(), "public")

        verify { LiveShareController.generateLiveShare(any()) }
        io.copiedText shouldBe "https://acme.jolli.ai/s/tok"
        io.copyResults.last() shouldBe true
    }

    @Test
    fun `copy link for people with no invitees is rejected without minting`() {
        every { BranchShareStore.getShare(root, branch, null) } returns null
        val io = FakeIO()
        BranchShareModal.copyShareLinkModal(io, ctx(), "people")
        verify(exactly = 0) { LiveShareController.generateLiveShare(any()) }
        io.copyResults.last() shouldBe false
        io.errors.size shouldBe 1
    }

    @Test
    fun `set access to public with no link mints silently`() {
        var current: BranchShareStore.BranchShareRecord? = null
        every { BranchShareStore.getShare(root, branch, null) } answers { current }
        every { LiveShareController.generateLiveShare(any()) } answers { current = record(); liveResult() }
        val io = FakeIO()
        BranchShareModal.setShareAccessModal(io, ctx(), "public")
        verify { LiveShareController.generateLiveShare(any()) }
    }

    @Test
    fun `set access to people on an owner-only link revokes it`() {
        every { BranchShareStore.getShare(root, branch, null) } returns record(visibility = "people", recipients = emptyList())
        every { BranchShareController.revokeShare(root, branch, any(), null) } returns Unit
        val io = FakeIO()
        BranchShareModal.setShareAccessModal(io, ctx(), "people")
        verify { BranchShareController.revokeShare(root, branch, any(), null) }
    }

    @Test
    fun `send invite mints, grants access, and merges recipients`() {
        var current: BranchShareStore.BranchShareRecord? = null
        every { BranchShareStore.getShare(root, branch, null) } answers { current }
        every { LiveShareController.generateLiveShare(any()) } answers { current = record(visibility = "people", recipients = emptyList()); liveResult() }
        every { JolliApiClient.sendShareInviteAndGrantAccess(any(), any(), "42", any(), any()) } returns
            JolliApiClient.ShareInviteResult(sent = listOf("a@x.com"), failed = emptyList())

        val io = FakeIO()
        BranchShareModal.sendInviteModal(io, ctx(), listOf("a@x.com"), null, "people")

        verify { JolliApiClient.sendShareInviteAndGrantAccess(any(), any(), "42", listOf("a@x.com"), null) }
        verify { BranchShareStore.putBranchShare(root, branch, match { it.recipients == listOf("a@x.com") }, null) }
        io.infos.size shouldBe 1
    }

    @Test
    fun `remove last recipient on a people share revokes the link`() {
        every { BranchShareStore.getShare(root, branch, null) } returns record(visibility = "people", recipients = listOf("a@x.com"))
        every { BranchShareController.revokeShare(root, branch, any(), null) } returns Unit
        val io = FakeIO()
        BranchShareModal.removeRecipientModal(io, ctx(), "a@x.com")
        verify { BranchShareController.revokeShare(root, branch, any(), null) }
    }

    @Test
    fun `remove one of several recipients patches the allowlist`() {
        every { BranchShareStore.getShare(root, branch, null) } returns record(visibility = "people", recipients = listOf("a@x.com", "b@x.com"))
        every { BranchShareController.patchShareAudience(root, branch, any(), any(), null) } returns record(visibility = "people", recipients = listOf("b@x.com"))
        val io = FakeIO()
        BranchShareModal.removeRecipientModal(io, ctx(), "a@x.com")
        verify { BranchShareController.patchShareAudience(root, branch, any(), match { it.recipients == listOf("b@x.com") }, null) }
    }
}
