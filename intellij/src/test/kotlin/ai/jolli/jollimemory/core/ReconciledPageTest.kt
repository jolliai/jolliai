package ai.jolli.jollimemory.core

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

class ReconciledPageTest {

    @Test
    fun `parses a full reconcile block`() {
        val response = """
            ===TOPIC===
            ---TITLE---
            Auth
            ---STABLESLUG---
            auth
            ---SUMMARY---
            One-line summary
            ---CONTENT---
            The reconciled content.
        """.trimIndent()
        val page = ReconciledPageParser.parseReconciledPage(response, "auth", "Auth")!!
        page.stableSlug shouldBe "auth"
        page.title shouldBe "Auth"
        page.summary shouldBe "One-line summary"
        page.content shouldBe "The reconciled content."
    }

    @Test
    fun `recovers a title-less block using the authoritative title`() {
        val response = "===TOPIC===\n---SUMMARY---\ns\n---CONTENT---\nbody only\n"
        val page = ReconciledPageParser.parseReconciledPage(response, "auth", "Authoritative")!!
        page.title shouldBe "Authoritative"
        page.content shouldBe "body only"
        page.summary shouldBe "s"
    }

    @Test
    fun `returns null when there is no content`() {
        ReconciledPageParser.parseReconciledPage("===TOPIC===\n---TITLE---\nT\n", "slug", "T").shouldBeNull()
        ReconciledPageParser.parseReconciledPage("garbage with no topic block", "slug", "T").shouldBeNull()
    }

    @Test
    fun `keeps the authoritative slug even when the LLM echoes a different one`() {
        val response = "===TOPIC===\n---TITLE---\nT\n---STABLESLUG---\nwrong-slug\n---CONTENT---\nc\n"
        ReconciledPageParser.parseReconciledPage(response, "right-slug", "T")!!.stableSlug shouldBe "right-slug"
    }
}
