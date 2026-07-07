package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.core.BranchShareStore
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.mockk.every
import io.mockk.mockkObject
import io.mockk.slot
import io.mockk.unmockkAll
import io.mockk.verify
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class BranchShareControllerTest {

    private val root = "/repo"
    private val branch = "feature/x"
    private val apiKey = "sk-jol-test"

    private fun record(
        id: String = "42",
        visibility: String = "public",
        recipients: List<String>? = null,
    ) = BranchShareStore.BranchShareRecord(
        shareId = id,
        shareUrl = "https://acme.jolli.ai/s/tok",
        visibility = visibility,
        recipients = recipients,
        expiresAt = "2026-12-31T00:00:00Z",
        decisionCount = 2,
    )

    @BeforeEach
    fun setUp() {
        mockkObject(BranchShareStore)
        mockkObject(JolliApiClient)
        every { BranchShareStore.putBranchShare(any(), any(), any(), any()) } returns Unit
        every { BranchShareStore.removeShare(any(), any(), any()) } returns Unit
    }

    @AfterEach
    fun tearDown() = unmockkAll()

    @Test
    fun `revoke calls the server then clears the local record`() {
        every { BranchShareStore.getShare(root, branch, null) } returns record(id = "99")
        every { JolliApiClient.revokeShare(any(), any(), any()) } returns Unit

        BranchShareController.revokeShare(root, branch, apiKey)

        verify { JolliApiClient.revokeShare(null, apiKey, "99") }
        verify { BranchShareStore.removeShare(root, branch, null) }
    }

    @Test
    fun `revoke with no existing share only clears locally`() {
        every { BranchShareStore.getShare(root, branch, null) } returns null
        BranchShareController.revokeShare(root, branch, apiKey)
        verify(exactly = 0) { JolliApiClient.revokeShare(any(), any(), any()) }
        verify { BranchShareStore.removeShare(root, branch, null) }
    }

    @Test
    fun `patchShareAudience to people persists the recipients allowlist`() {
        every { BranchShareStore.getShare(root, branch, null) } returns record(visibility = "public")
        every { JolliApiClient.updateLiveShare(any(), any(), any(), any()) } returns
            JolliApiClient.LiveShareUpdateResult(visibility = "people", recipients = listOf("a@x.com"))
        val stored = slot<BranchShareStore.BranchShareRecord>()
        every { BranchShareStore.putBranchShare(root, branch, capture(stored), null) } returns Unit

        val out = BranchShareController.patchShareAudience(
            root, branch, apiKey,
            BranchShareController.ShareAudiencePatch(visibility = "people", recipients = listOf("a@x.com")),
        )

        out!!.visibility shouldBe "people"
        stored.captured.recipients shouldBe listOf("a@x.com")
    }

    @Test
    fun `patchShareAudience to public drops the recipients allowlist`() {
        every { BranchShareStore.getShare(root, branch, null) } returns record(visibility = "people", recipients = listOf("a@x.com"))
        every { JolliApiClient.updateLiveShare(any(), any(), any(), any()) } returns
            JolliApiClient.LiveShareUpdateResult(visibility = "public")
        val stored = slot<BranchShareStore.BranchShareRecord>()
        every { BranchShareStore.putBranchShare(root, branch, capture(stored), null) } returns Unit

        BranchShareController.patchShareAudience(root, branch, apiKey, BranchShareController.ShareAudiencePatch(visibility = "public"))

        stored.captured.visibility shouldBe "public"
        stored.captured.recipients.shouldBeNull()
    }

    @Test
    fun `patchShareAudience with no share returns null`() {
        every { BranchShareStore.getShare(root, branch, null) } returns null
        BranchShareController.patchShareAudience(root, branch, apiKey, BranchShareController.ShareAudiencePatch(visibility = "org")).shouldBeNull()
    }
}
