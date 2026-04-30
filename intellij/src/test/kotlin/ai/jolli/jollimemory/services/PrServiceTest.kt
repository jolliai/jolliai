package ai.jolli.jollimemory.services

import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class PrServiceTest {

    // ── wrapWithMarkers ─────────────────────────────────────────────────

    @Nested
    inner class WrapWithMarkers {
        @Test
        fun `wraps content with start and end markers`() {
            val result = PrService.wrapWithMarkers("## Summary\nContent here")
            result shouldContain "<!-- jollimemory-summary-start -->"
            result shouldContain "<!-- jollimemory-summary-end -->"
            result shouldContain "## Summary"
        }
    }

    // ── replaceSummaryInBody ────────────────────────────────────────────

    @Nested
    inner class ReplaceSummaryInBody {
        @Test
        fun `replaces existing marker region`() {
            val currentBody = "Desc\n\n<!-- jollimemory-summary-start -->\nOld\n<!-- jollimemory-summary-end -->\n\nOther"
            val result = PrService.replaceSummaryInBody(currentBody, "New")
            result shouldContain "New"
            result shouldNotContain "Old"
            result shouldContain "Desc"
            result shouldContain "Other"
        }

        @Test
        fun `appends when no markers exist`() {
            val result = PrService.replaceSummaryInBody("Existing body", "Summary")
            result shouldContain "Existing body"
            result shouldContain "Summary"
            result shouldContain "<!-- jollimemory-summary-start -->"
        }

        @Test
        fun `returns wrapped content for empty body`() {
            val result = PrService.replaceSummaryInBody("", "Summary")
            result shouldContain "<!-- jollimemory-summary-start -->"
            result shouldContain "Summary"
        }
    }

    // ── PrInfo data class ───────────────────────────────────────────────

    @Test
    fun `PrInfo fields work`() {
        val info = PrService.PrInfo(123, "https://github.com/org/repo/pull/123", "Title", "Body")
        info.number shouldBe 123
        info.url shouldBe "https://github.com/org/repo/pull/123"
        info.title shouldBe "Title"
        info.body shouldBe "Body"
    }
}
