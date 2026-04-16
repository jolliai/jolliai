package ai.jolli.jollimemory.services

import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import java.lang.reflect.Method

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

    // ── shellQuote (private, via reflection) ────────────────────────────

    @Nested
    inner class ShellQuote {
        private fun shellQuote(arg: String): String {
            val method: Method = PrService::class.java.getDeclaredMethod("shellQuote", String::class.java)
            method.isAccessible = true
            return method.invoke(PrService, arg) as String
        }

        @Test
        fun `returns empty quotes for empty string`() {
            shellQuote("") shouldBe "''"
        }

        @Test
        fun `returns safe string unchanged`() {
            shellQuote("hello") shouldBe "hello"
            shellQuote("path/to/file.txt") shouldBe "path/to/file.txt"
            shellQuote("user@host") shouldBe "user@host"
        }

        @Test
        fun `wraps strings with spaces in quotes`() {
            shellQuote("hello world") shouldContain "'"
        }

        @Test
        fun `escapes embedded single quotes`() {
            val result = shellQuote("it's a test")
            result shouldContain "\\'"
        }

        @Test
        fun `wraps strings with special characters`() {
            shellQuote("echo \$HOME") shouldContain "'"
            shellQuote("a && b") shouldContain "'"
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
