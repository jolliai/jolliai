package ai.jolli.jollimemory.core

import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class SummarizerTest {

    // ── resolveModelId ──────────────────────────────────────────────────

    @Nested
    inner class ResolveModelId {
        @Test
        fun `resolves haiku alias`() {
            Summarizer.resolveModelId("haiku") shouldBe "claude-haiku-4-5-20251001"
        }

        @Test
        fun `resolves sonnet alias`() {
            Summarizer.resolveModelId("sonnet") shouldBe "claude-sonnet-4-6"
        }

        @Test
        fun `resolves opus alias`() {
            Summarizer.resolveModelId("opus") shouldBe "claude-opus-4-6"
        }

        @Test
        fun `returns custom model ID as-is`() {
            Summarizer.resolveModelId("claude-custom-model") shouldBe "claude-custom-model"
        }

        @Test
        fun `defaults to sonnet when null`() {
            Summarizer.resolveModelId(null) shouldBe "claude-sonnet-4-6"
        }
    }

    // ── buildSummarizationPrompt ────────────────────────────────────────

    @Nested
    inner class BuildSummarizationPrompt {
        @Test
        fun `includes commit info in prompt`() {
            val commitInfo = CommitInfo("abc123", "Fix login bug", "Alice", "2026-01-01T00:00:00Z")
            val prompt = Summarizer.buildSummarizationPrompt("conversation text", "diff text", commitInfo)

            prompt shouldContain "abc123"
            prompt shouldContain "Fix login bug"
            prompt shouldContain "Alice"
            prompt shouldContain "conversation text"
            prompt shouldContain "diff text"
        }

        @Test
        fun `includes structured format instructions`() {
            val commitInfo = CommitInfo("abc", "msg", "Author", "2026-01-01T00:00:00Z")
            val prompt = Summarizer.buildSummarizationPrompt("", "", commitInfo)

            prompt shouldContain "===TOPIC==="
            prompt shouldContain "---TITLE---"
            prompt shouldContain "---TRIGGER---"
            prompt shouldContain "---DECISIONS---"
        }
    }

    // ── parseSummaryResponse ────────────────────────────────────────────

    @Nested
    inner class ParseSummaryResponse {
        @Test
        fun `parses single topic with all fields`() {
            val response = """
---TICKETID---
JOLLI-123

===TOPIC===
---TITLE---
Add user authentication
---TRIGGER---
Users needed secure login.
---RESPONSE---
Implemented OAuth2 flow.
---DECISIONS---
Chose OAuth2 over session-based auth for scalability.
---TODO---
Add refresh token rotation.
---FILESAFFECTED---
src/Auth.ts, src/Middleware.ts
---CATEGORY---
feature
---IMPORTANCE---
major
            """.trimIndent()

            val result = Summarizer.parseSummaryResponse(response)
            result.ticketId shouldBe "JOLLI-123"
            result.topics shouldHaveSize 1

            val topic = result.topics[0]
            topic.title shouldBe "Add user authentication"
            topic.trigger shouldBe "Users needed secure login."
            topic.response shouldBe "Implemented OAuth2 flow."
            topic.decisions shouldBe "Chose OAuth2 over session-based auth for scalability."
            topic.todo shouldBe "Add refresh token rotation."
            topic.filesAffected shouldBe listOf("src/Auth.ts", "src/Middleware.ts")
            topic.category shouldBe TopicCategory.feature
            topic.importance shouldBe TopicImportance.major
        }

        @Test
        fun `parses multiple topics`() {
            val response = """
===TOPIC===
---TITLE---
First topic
---TRIGGER---
First trigger
---RESPONSE---
First response
---DECISIONS---
First decision

===TOPIC===
---TITLE---
Second topic
---TRIGGER---
Second trigger
---RESPONSE---
Second response
---DECISIONS---
Second decision
            """.trimIndent()

            val result = Summarizer.parseSummaryResponse(response)
            result.topics shouldHaveSize 2
            result.topics[0].title shouldBe "First topic"
            result.topics[1].title shouldBe "Second topic"
        }

        @Test
        fun `filters out topics with empty decisions`() {
            val response = """
===TOPIC===
---TITLE---
Topic with empty decisions
---TRIGGER---
Trigger
---RESPONSE---
Response
---DECISIONS---
No design decisions recorded
            """.trimIndent()

            val result = Summarizer.parseSummaryResponse(response)
            result.topics.shouldBeEmpty()
        }

        @Test
        fun `filters out topics with NA decisions`() {
            val response = """
===TOPIC===
---TITLE---
Topic with NA decisions
---TRIGGER---
Trigger
---RESPONSE---
Response
---DECISIONS---
N/A
            """.trimIndent()

            val result = Summarizer.parseSummaryResponse(response)
            result.topics.shouldBeEmpty()
        }

        @Test
        fun `handles NO_TOPICS response`() {
            val result = Summarizer.parseSummaryResponse("===NO_TOPICS===")
            result.topics.shouldBeEmpty()
            result.intentionallyEmpty shouldBe true
        }

        @Test
        fun `handles empty response`() {
            val result = Summarizer.parseSummaryResponse("")
            result.topics.shouldBeEmpty()
        }

        @Test
        fun `strips fenced code blocks from response`() {
            val response = """
```
===TOPIC===
---TITLE---
Fenced topic
---TRIGGER---
Trigger
---RESPONSE---
Response
---DECISIONS---
Real decision here
```
            """.trimIndent()

            val result = Summarizer.parseSummaryResponse(response)
            result.topics shouldHaveSize 1
            result.topics[0].title shouldBe "Fenced topic"
        }

        @Test
        fun `handles topic without optional fields`() {
            val response = """
===TOPIC===
---TITLE---
Minimal topic
---TRIGGER---
Minimal trigger
---RESPONSE---
Minimal response
---DECISIONS---
Minimal decision
            """.trimIndent()

            val result = Summarizer.parseSummaryResponse(response)
            result.topics shouldHaveSize 1
            result.topics[0].todo shouldBe null
            result.topics[0].filesAffected shouldBe null
            result.topics[0].category shouldBe null
            result.topics[0].importance shouldBe null
        }

        @Test
        fun `parses all category values`() {
            for (cat in TopicCategory.entries) {
                val response = """
===TOPIC===
---TITLE---
Test
---TRIGGER---
Trigger
---RESPONSE---
Response
---DECISIONS---
Decision
---CATEGORY---
${cat.name}
                """.trimIndent()

                val result = Summarizer.parseSummaryResponse(response)
                result.topics shouldHaveSize 1
                result.topics[0].category shouldBe cat
            }
        }
    }

    // ── parseE2eTestResponse ────────────────────────────────────────────

    @Nested
    inner class ParseE2eTestResponse {
        @Test
        fun `parses single scenario`() {
            val response = """
===SCENARIO===
---TITLE---
Login flow test
---PRECONDITIONS---
Have a test account ready
---STEPS---
1. Open the app
2. Click on Login
3. Enter credentials
---EXPECTED---
- Dashboard should display
- Welcome message should appear
            """.trimIndent()

            val scenarios = Summarizer.parseE2eTestResponse(response)
            scenarios shouldHaveSize 1

            val s = scenarios[0]
            s.title shouldBe "Login flow test"
            s.preconditions shouldBe "Have a test account ready"
            s.steps shouldHaveSize 3
            s.steps[0] shouldBe "Open the app"
            s.expectedResults shouldHaveSize 2
        }

        @Test
        fun `parses scenario without preconditions`() {
            val response = """
===SCENARIO===
---TITLE---
Simple test
---STEPS---
1. Do something
---EXPECTED---
- Something happens
            """.trimIndent()

            val scenarios = Summarizer.parseE2eTestResponse(response)
            scenarios shouldHaveSize 1
            scenarios[0].preconditions shouldBe null
        }

        @Test
        fun `returns empty list for no scenarios`() {
            Summarizer.parseE2eTestResponse("").shouldBeEmpty()
        }

        @Test
        fun `skips scenarios without steps`() {
            val response = """
===SCENARIO===
---TITLE---
No steps
---EXPECTED---
- Something
            """.trimIndent()

            Summarizer.parseE2eTestResponse(response).shouldBeEmpty()
        }

        @Test
        fun `strips fenced code blocks`() {
            val response = """
```
===SCENARIO===
---TITLE---
Fenced test
---STEPS---
1. Step one
---EXPECTED---
- Result one
```
            """.trimIndent()

            val scenarios = Summarizer.parseE2eTestResponse(response)
            scenarios shouldHaveSize 1
            scenarios[0].title shouldBe "Fenced test"
        }

        @Test
        fun `parses multiple scenarios`() {
            val response = """
===SCENARIO===
---TITLE---
Test A
---STEPS---
1. Step A1
---EXPECTED---
- Result A

===SCENARIO===
---TITLE---
Test B
---STEPS---
1. Step B1
---EXPECTED---
- Result B
            """.trimIndent()

            val scenarios = Summarizer.parseE2eTestResponse(response)
            scenarios shouldHaveSize 2
        }
    }

    // ── buildCommitMessagePrompt ────────────────────────────────────────

    @Nested
    inner class BuildCommitMessagePrompt {
        @Test
        fun `includes branch and files in prompt`() {
            val params = CommitMessageParams(
                stagedDiff = "diff content",
                branch = "feature/jolli-123-something",
                stagedFiles = listOf("src/Auth.ts", "src/Middleware.ts"),
            )
            val prompt = Summarizer.buildCommitMessagePrompt(params)

            prompt shouldContain "feature/jolli-123-something"
            prompt shouldContain "src/Auth.ts, src/Middleware.ts"
            prompt shouldContain "diff content"
        }

        @Test
        fun `handles empty files list`() {
            val params = CommitMessageParams(
                stagedDiff = "",
                branch = "main",
                stagedFiles = emptyList(),
            )
            val prompt = Summarizer.buildCommitMessagePrompt(params)
            prompt shouldContain "(none)"
        }

        @Test
        fun `handles empty diff`() {
            val params = CommitMessageParams(
                stagedDiff = "",
                branch = "main",
                stagedFiles = listOf("file.ts"),
            )
            val prompt = Summarizer.buildCommitMessagePrompt(params)
            prompt shouldContain "(empty diff"
        }
    }

    // ── buildE2eTestPrompt ──────────────────────────────────────────────

    @Nested
    inner class BuildE2eTestPrompt {
        @Test
        fun `sets max 5 scenarios for 3 or fewer topics`() {
            val topics = listOf(
                TopicSummary("Title", "Trigger", "Response", "Decisions"),
            )
            val prompt = Summarizer.buildE2eTestPrompt(topics, "commit msg", "diff")
            prompt shouldContain "at most 5 scenarios"
        }

        @Test
        fun `sets max 10 scenarios for more than 3 topics`() {
            val topics = (1..4).map {
                TopicSummary("Title $it", "Trigger", "Response", "Decisions")
            }
            val prompt = Summarizer.buildE2eTestPrompt(topics, "commit msg", "diff")
            prompt shouldContain "at most 10 scenarios"
        }
    }

    // ── buildTranslationPrompt ──────────────────────────────────────────

    @Test
    fun `buildTranslationPrompt includes content`() {
        val prompt = Summarizer.buildTranslationPrompt("# 测试内容")
        prompt shouldContain "# 测试内容"
        prompt shouldContain "Translate"
    }
}
