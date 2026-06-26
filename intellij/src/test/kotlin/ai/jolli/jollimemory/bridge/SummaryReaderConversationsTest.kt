package ai.jolli.jollimemory.bridge

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class SummaryReaderConversationsTest {

    @Nested
    inner class ParseConversations {
        @Test
        fun `null or blank yields empty`() {
            SummaryReader.parseConversations(null) shouldBe emptyList()
            SummaryReader.parseConversations("") shouldBe emptyList()
            SummaryReader.parseConversations("   ") shouldBe emptyList()
        }

        @Test
        fun `malformed json yields empty rather than throwing`() {
            SummaryReader.parseConversations("{not json") shouldBe emptyList()
            SummaryReader.parseConversations("[]") shouldBe emptyList()
            SummaryReader.parseConversations("""{"other":1}""") shouldBe emptyList()
        }

        @Test
        fun `derives source, message count, and title from the first human turn`() {
            val json = """
                {"sessions":[
                  {"sessionId":"s1","source":"claude","entries":[
                    {"role":"human","content":"Redesign the commit memory panel\nmore detail"},
                    {"role":"assistant","content":"ok"},
                    {"role":"human","content":"thanks"}
                  ]}
                ]}
            """.trimIndent()
            val rows = SummaryReader.parseConversations(json)
            rows.size shouldBe 1
            rows[0].source shouldBe "claude"
            rows[0].messageCount shouldBe 3
            // First non-blank line of the first human turn, untruncated.
            rows[0].title shouldBe "Redesign the commit memory panel"
        }

        @Test
        fun `falls back to a source-derived title when there is no human turn`() {
            val json = """{"sessions":[{"sessionId":"s1","source":"codex","entries":[{"role":"assistant","content":"hi"}]}]}"""
            val rows = SummaryReader.parseConversations(json)
            rows.size shouldBe 1
            rows[0].title shouldBe "Codex session"
            rows[0].messageCount shouldBe 1
        }

        @Test
        fun `defaults missing source to ai and truncates long titles`() {
            val longLine = "x".repeat(100)
            val json = """{"sessions":[{"sessionId":"s1","entries":[{"role":"user","content":"$longLine"}]}]}"""
            val rows = SummaryReader.parseConversations(json)
            rows[0].source shouldBe "ai"
            rows[0].title.length shouldBe 58 // 57 chars + ellipsis
            rows[0].title.endsWith("…") shouldBe true
        }

        @Test
        fun `parses multiple sessions in order`() {
            val json = """
                {"sessions":[
                  {"sessionId":"s1","source":"claude","entries":[{"role":"human","content":"first"}]},
                  {"sessionId":"s2","source":"cursor","entries":[]}
                ]}
            """.trimIndent()
            val rows = SummaryReader.parseConversations(json)
            rows.map { it.source } shouldBe listOf("claude", "cursor")
            rows[1].messageCount shouldBe 0
            rows[1].title shouldBe "Cursor session"
        }
    }
}
