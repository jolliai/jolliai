package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.core.BranchShareStore
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
        token8: String? = "abcd1234",
    ) = BranchShareStore.BranchShareRecord(
        shareId = id,
        shareUrl = "https://acme.jolli.ai/s/tok",
        visibility = visibility,
        recipients = recipients,
        token8 = token8,
        expiresAt = "2026-12-31T00:00:00Z",
        decisionCount = 2,
    )

    @BeforeEach
    fun setUp() {
        mockkObject(BranchShareStore)
        mockkObject(JolliApiClient)
        every { BranchShareStore.putBranchShare(any(), any(), any(), any()) } returns Unit
        every { BranchShareStore.removeBranchShare(any(), any(), any()) } returns Unit
    }

    @AfterEach
    fun tearDown() = unmockkAll()

    @Test
    fun `revoke calls the server then clears the local record`() {
        every { BranchShareStore.getBranchShare(root, branch, null) } returns record(id = "99")
        every { JolliApiClient.revokeShare(any(), any(), any()) } returns Unit

        BranchShareController.revokeBranchShareForBranch(root, branch, apiKey)

        verify { JolliApiClient.revokeShare(null, apiKey, "99") }
        verify { BranchShareStore.removeBranchShare(root, branch, null) }
    }

    @Test
    fun `revoke with no existing share only clears locally`() {
        every { BranchShareStore.getBranchShare(root, branch, null) } returns null

        BranchShareController.revokeBranchShareForBranch(root, branch, apiKey)

        verify(exactly = 0) { JolliApiClient.revokeShare(any(), any(), any()) }
        verify { BranchShareStore.removeBranchShare(root, branch, null) }
    }

    @Test
    fun `setExpiry patches the server and mirrors the confirmed value`() {
        every { BranchShareStore.getBranchShare(root, branch, null) } returns record()
        every { JolliApiClient.updateShareExpiry(any(), any(), any(), any()) } returns
            JolliApiClient.ShareExpiryResult(shareId = "42", expiresAt = "2027-06-01T00:00:00Z")

        val stored = slot<BranchShareStore.BranchShareRecord>()
        every { BranchShareStore.putBranchShare(root, branch, capture(stored), null) } returns Unit

        val out = BranchShareController.setBranchShareExpiry(root, branch, apiKey, "2027-06-01T00:00:00Z")

        out shouldBe "2027-06-01T00:00:00Z"
        stored.captured.expiresAt shouldBe "2027-06-01T00:00:00Z"
    }

    @Test
    fun `setExpiry with no share returns null`() {
        every { BranchShareStore.getBranchShare(root, branch, null) } returns null
        BranchShareController.setBranchShareExpiry(root, branch, apiKey, "2027-06-01T00:00:00Z") shouldBe null
    }

    @Test
    fun `setVisibility to people persists the recipients allowlist`() {
        every { BranchShareStore.getBranchShare(root, branch, null) } returns record(visibility = "public")
        every { JolliApiClient.updateLiveShare(any(), any(), any(), any()) } returns
            JolliApiClient.LiveShareUpdateResult(visibility = "people", recipients = listOf("a@x.com"))

        val stored = slot<BranchShareStore.BranchShareRecord>()
        every { BranchShareStore.putBranchShare(root, branch, capture(stored), null) } returns Unit

        val out = BranchShareController.setBranchShareVisibility(root, branch, apiKey, "people", recipients = listOf("a@x.com"))

        out shouldBe "people"
        stored.captured.visibility shouldBe "people"
        stored.captured.recipients shouldBe listOf("a@x.com")
        // Non-public → no bearer token retained.
        stored.captured.token8 shouldBe null
    }

    @Test
    fun `setVisibility keeps the token when the result stays public`() {
        every { BranchShareStore.getBranchShare(root, branch, null) } returns record(visibility = "public", token8 = "keepme12")
        every { JolliApiClient.updateLiveShare(any(), any(), any(), any()) } returns
            JolliApiClient.LiveShareUpdateResult(visibility = "public")

        val stored = slot<BranchShareStore.BranchShareRecord>()
        every { BranchShareStore.putBranchShare(root, branch, capture(stored), null) } returns Unit

        BranchShareController.setBranchShareVisibility(root, branch, apiKey, "public")

        stored.captured.token8 shouldBe "keepme12"
    }
}
