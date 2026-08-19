package ai.jolli.jollimemory.bridge

import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
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
                  {"sessionId":"s2","source":"cursor","entries":[{"role":"human","content":"second"}]}
                ]}
            """.trimIndent()
            val rows = SummaryReader.parseConversations(json)
            rows.map { it.source } shouldBe listOf("claude", "cursor")
            rows[1].messageCount shouldBe 1
            rows[1].title shouldBe "second"
        }

        /**
         * Zero-turn sessions are dropped uniformly, matching the CLI-owned
         * `groupArchivedSessions` rule: a usage-only carrier or an overlay-emptied
         * shell (both archived with `entries:[]`) has no readable turn, so it must
         * not surface as a `0 msgs` row on the JVM host any more than it does on
         * VS Code or the dashboard.
         */
        @Test
        fun `drops zero-turn sessions but keeps their non-empty siblings`() {
            val json = """
                {"sessions":[
                  {"sessionId":"s1","source":"claude","entries":[{"role":"human","content":"first"}]},
                  {"sessionId":"s2","source":"cursor","entries":[]}
                ]}
            """.trimIndent()
            val rows = SummaryReader.parseConversations(json)
            rows.size shouldBe 1
            rows[0].sessionId shouldBe "s1"
        }

        /**
         * Gson returns JsonNull — not Kotlin null — for `"role": null`, so `?.asString`
         * does not short-circuit and throws. Unguarded, that exception is caught by
         * parseConversations and blanks the WHOLE list.
         */
        @Test
        fun `an explicit null role or content does not blank the conversation list`() {
            val json = """
                {"sessions":[
                  {"sessionId":"s1","source":"claude","entries":[
                    {"role":null,"content":"x"},
                    {"role":"human","content":null},
                    {"role":"human","content":"real turn"}
                  ]}
                ]}
            """.trimIndent()
            val rows = SummaryReader.parseConversations(json)
            rows.size shouldBe 1
            rows[0].messageCount shouldBe 3
            // Falls through the two null-bearing turns to the first usable human line.
            rows[0].title shouldBe "real turn"
        }

        @Test
        fun `an explicit null source or sessionId falls back instead of dropping the row`() {
            // A real turn so the zero-turn filter keeps the row — this case is about
            // null source/sessionId falling back, not about empty-session survival.
            val json =
                """{"sessions":[{"sessionId":null,"source":null,"entries":[{"role":"human","content":"hi"}]}]}"""
            val rows = SummaryReader.parseConversations(json)
            rows.size shouldBe 1
            rows[0].source shouldBe "ai"
            rows[0].sessionId shouldBe ""
            rows[0].transcriptPath shouldBe null
        }
    }

    @Nested
    inner class ParseSummaryBrief {
        private val full = """
            {"commitHash":"abc12345def","commitMessage":"Fix login","commitAuthor":"Ada",
             "commitDate":"2026-07-01","topics":[{"t":1},{"t":2}],"jolliDocId":142}
        """.trimIndent()

        @Test
        fun `parses every field and derives the short hash`() {
            val brief = SummaryReader.parseSummaryBrief(full)!!
            brief.hash shouldBe "abc12345def"
            brief.shortHash shouldBe "abc12345"
            brief.message shouldBe "Fix login"
            brief.author shouldBe "Ada"
            brief.date shouldBe "2026-07-01"
            brief.topicCount shouldBe 2
            brief.hasSummary shouldBe true
            brief.jolliDocId shouldBe 142
        }

        @Test
        fun `null blank or malformed input yields null rather than throwing`() {
            SummaryReader.parseSummaryBrief(null) shouldBe null
            SummaryReader.parseSummaryBrief("") shouldBe null
            SummaryReader.parseSummaryBrief("   ") shouldBe null
            SummaryReader.parseSummaryBrief("{not json") shouldBe null
        }

        /**
         * The regression this guards: Gson returns JsonNull for `"jolliDocId": null`, so
         * `obj.get("jolliDocId")?.asInt` does not short-circuit and throws
         * UnsupportedOperationException. Caught by the parse, that dropped the ENTIRE
         * summary — one stray null field silently removed a memory from the list.
         */
        @Test
        fun `an explicit null jolliDocId yields a row with no doc id, not a dropped summary`() {
            val json = """{"commitHash":"abc12345def","commitMessage":"Fix login","jolliDocId":null}"""
            val brief = SummaryReader.parseSummaryBrief(json)
            brief shouldNotBe null
            brief!!.hash shouldBe "abc12345def"
            brief.jolliDocId shouldBe null
        }

        @Test
        fun `an explicit null on any string field falls back to empty, not a dropped summary`() {
            val json = """
                {"commitHash":null,"commitMessage":null,"commitAuthor":null,
                 "commitDate":null,"topics":null,"jolliDocId":null}
            """.trimIndent()
            val brief = SummaryReader.parseSummaryBrief(json)
            brief shouldNotBe null
            brief!!.hash shouldBe ""
            brief.shortHash shouldBe ""
            brief.message shouldBe ""
            brief.author shouldBe ""
            brief.date shouldBe ""
            brief.topicCount shouldBe 0
            brief.jolliDocId shouldBe null
        }

        @Test
        fun `absent optional fields behave the same as explicit nulls`() {
            val brief = SummaryReader.parseSummaryBrief("""{"commitHash":"abc12345def"}""")!!
            brief.message shouldBe ""
            brief.topicCount shouldBe 0
            brief.jolliDocId shouldBe null
        }
    }
}
