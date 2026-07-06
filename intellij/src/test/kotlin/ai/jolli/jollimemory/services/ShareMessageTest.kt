package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.services.ShareMessage.ShareKind
import ai.jolli.jollimemory.services.ShareMessage.SocialPlatform
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.string.shouldStartWith
import org.junit.jupiter.api.Test

class ShareMessageTest {

    private val branch = "feature/login"
    private val url = "https://acme.jolli.ai/s/abc123"
    private val titles = listOf("Chose JWT over sessions", "Rate-limited the token endpoint")

    @Test
    fun `email subject leads with branch and decision count`() {
        val email = ShareMessage.buildShareEmail(ShareMessage.ShareMessageInput(branch, url, 3, titles))
        email.subject shouldBe "How we built \"$branch\" — 3 decisions on Jolli Memory"
        email.body shouldContain "A few of the decisions inside:"
        email.body shouldContain "  • Chose JWT over sessions"
        email.body shouldContain url
        email.body shouldContain "— Shared via Jolli Memory"
    }

    @Test
    fun `email singular decision has no plural s`() {
        val email = ShareMessage.buildShareEmail(ShareMessage.ShareMessageInput(branch, url, 1, emptyList()))
        email.subject shouldContain "1 decision on Jolli Memory"
        email.subject shouldNotContain "1 decisions"
        // No teaser block when there are no titles.
        email.body shouldNotContain "A few of the decisions inside:"
    }

    @Test
    fun `commit-kind email uses commit phrasing`() {
        val email = ShareMessage.buildShareEmail(
            ShareMessage.ShareMessageInput(branch, url, 2, titles, ShareKind.COMMIT),
        )
        email.subject shouldStartWith "A commit on \"$branch\""
        email.body shouldContain "the reasoning behind a commit on the \"$branch\""
    }

    @Test
    fun `copy message teases the first two decisions`() {
        val msg = ShareMessage.buildShareCopyMessage(ShareMessage.ShareMessageInput(branch, url, 5, titles))
        msg shouldContain "How we built $branch — 5 decisions incl. “Chose JWT over sessions” & “Rate-limited the token endpoint”"
        msg shouldContain url
    }

    @Test
    fun `X share url encodes text and carries the url`() {
        val out = ShareMessage.buildSocialShareUrl(
            SocialPlatform.X,
            ShareMessage.SocialShareInput(branch, url, 3, titles),
        )
        out shouldStartWith "https://twitter.com/intent/tweet?text="
        out shouldContain "url=https%3A%2F%2Facme.jolli.ai%2Fs%2Fabc123"
        // encodeURIComponent-style spaces (%20), never "+".
        out shouldNotContain "+"
    }

    @Test
    fun `linkedin share url is url-only`() {
        val out = ShareMessage.buildSocialShareUrl(
            SocialPlatform.LINKEDIN,
            ShareMessage.SocialShareInput(branch, url, 3, titles),
        )
        out shouldBe "https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Facme.jolli.ai%2Fs%2Fabc123"
    }

    @Test
    fun `reddit share url carries a title param`() {
        val out = ShareMessage.buildSocialShareUrl(
            SocialPlatform.REDDIT,
            ShareMessage.SocialShareInput(branch, url, 3, titles),
        )
        out shouldStartWith "https://www.reddit.com/submit?url="
        out shouldContain "title="
        out shouldContain "read-only%20dev%20memory"
    }

    @Test
    fun `whatsapp and telegram share urls exist and differ`() {
        val wa = ShareMessage.buildSocialShareUrl(SocialPlatform.WHATSAPP, ShareMessage.SocialShareInput(branch, url, 1, emptyList()))
        val tg = ShareMessage.buildSocialShareUrl(SocialPlatform.TELEGRAM, ShareMessage.SocialShareInput(branch, url, 1, emptyList()))
        wa shouldStartWith "https://wa.me/?text="
        tg shouldStartWith "https://t.me/share/url?url="
    }
}
