package ai.jolli.jollimemory.core

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import org.junit.jupiter.api.Test

/**
 * Local direct-mode prompt templates (Anthropic-key-only ingest). Verifies the
 * route/reconcile templates render with `{{key}}` substitution.
 */
class PromptTemplatesTest {

    @Test
    fun `route template fills topicIndex and sources`() {
        val out = PromptTemplates.render("route", mapOf("topicIndex" to "- auth: Auth", "sources" to "[0] a commit"))!!
        out shouldContain "knowledge-base router"
        out shouldContain "- auth: Auth"
        out shouldContain "[0] a commit"
        out shouldNotContain "{{topicIndex}}"
        out shouldNotContain "{{sources}}"
    }

    @Test
    fun `reconcile template fills topic, page, and sources`() {
        val out = PromptTemplates.render(
            "reconcile",
            mapOf("topicTitle" to "Auth", "currentPage" to "(new topic)", "sources" to "### body"),
        )!!
        out shouldContain "===TOPIC==="
        out shouldContain "Auth"
        out shouldContain "(new topic)"
        out shouldContain "### body"
        out shouldNotContain "{{topicTitle}}"
        out shouldNotContain "{{currentPage}}"
        out shouldNotContain "{{sources}}"
    }

    @Test
    fun `unknown action returns null (caller falls back to proxy)`() {
        PromptTemplates.render("nope", emptyMap()).shouldBeNull()
    }

    @Test
    fun `unfilled placeholders are left as-is`() {
        // sources omitted → its placeholder stays literal (visible, not silently empty).
        val out = PromptTemplates.render("route", mapOf("topicIndex" to "x"))!!
        out shouldContain "{{sources}}"
    }
}
