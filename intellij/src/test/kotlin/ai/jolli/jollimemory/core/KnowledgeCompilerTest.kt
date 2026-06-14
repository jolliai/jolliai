package ai.jolli.jollimemory.core

import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Test

class KnowledgeCompilerTest {

    @Test
    fun `parses a topic block with all fields`() {
        val response = """
            ===TOPIC===
            ---TITLE---
            Auth System
            ---STABLESLUG---
            auth-system
            ---CONTENT---
            Body about auth.
            ---KEYDECISIONS---
            - Use OAuth
            - Drop sessions
            ---RELATEDBRANCHES---
            main, feature/oauth
            ---SOURCECOMMITS---
            abc123, def456
        """.trimIndent()
        val topics = KnowledgeCompiler.parseCompileResponse(response)
        topics shouldHaveSize 1
        val t = topics[0]
        t.title shouldBe "Auth System"
        t.stableSlug shouldBe "auth-system"
        t.content shouldBe "Body about auth."
        t.keyDecisions shouldBe listOf("Use OAuth", "Drop sessions")
        t.relatedBranches shouldBe listOf("main", "feature/oauth")
        t.sourceCommits shouldBe listOf("abc123", "def456")
    }

    @Test
    fun `returns empty for NO_TOPICS sentinel and blank`() {
        KnowledgeCompiler.parseCompileResponse("===NO_TOPICS===") shouldBe emptyList()
        KnowledgeCompiler.parseCompileResponse("   ") shouldBe emptyList()
    }

    @Test
    fun `skips blocks missing title or content`() {
        val response = "===TOPIC===\n---TITLE---\nOnly title\n"
        KnowledgeCompiler.parseCompileResponse(response) shouldBe emptyList()
    }

    @Test
    fun `derives slug from title when STABLESLUG missing`() {
        val response = "===TOPIC===\n---TITLE---\nMy Cool Topic\n---CONTENT---\nx\n"
        KnowledgeCompiler.parseCompileResponse(response)[0].stableSlug shouldBe "my-cool-topic"
    }

    @Test
    fun `first-write-wins dedup on stableSlug`() {
        val response = """
            ===TOPIC===
            ---TITLE---
            First
            ---STABLESLUG---
            dup
            ---CONTENT---
            first content
            ===TOPIC===
            ---TITLE---
            Second
            ---STABLESLUG---
            dup
            ---CONTENT---
            second content
        """.trimIndent()
        val topics = KnowledgeCompiler.parseCompileResponse(response)
        topics shouldHaveSize 1
        topics[0].content shouldBe "first content"
    }

    @Test
    fun `extractField is not truncated by an unknown triple-dash marker in content`() {
        val response = "===TOPIC===\n---TITLE---\nT\n---CONTENT---\nLine one\n---NOTE---\nstill content\n---SUMMARY---\nthe summary\n"
        val content = KnowledgeCompiler.parseCompileResponse(response)[0].content
        content shouldContain "---NOTE---"
        content shouldContain "still content"
        // A *known* marker (SUMMARY) ends the CONTENT field.
        content.shouldNotBeNull()
        (content.contains("the summary")) shouldBe false
    }

    @Test
    fun `normalizeSlug enforces kebab and length bounds`() {
        KnowledgeCompiler.normalizeSlug("Hello World!") shouldBe "hello-world"
        KnowledgeCompiler.normalizeSlug("--Auth--") shouldBe "auth" // repeats/edges stripped
        KnowledgeCompiler.normalizeSlug("ab") shouldBe "" // under 3 chars → empty
        KnowledgeCompiler.slugifyTitle("!!") shouldBe "untitled-topic" // unrecoverable → fallback
    }

    @Test
    fun `formatSummaryForCompile renders commit header and topic fields`() {
        val summary = CommitSummary(
            commitHash = "abc12345deadbeef", commitMessage = "Add auth", commitAuthor = "me",
            commitDate = "2026-01-01T00:00:00Z", branch = "main", generatedAt = "g",
            topics = listOf(TopicSummary(title = "Auth", trigger = "needed login", response = "added oauth", decisions = "use oauth", filesAffected = listOf("a.kt"))),
        )
        val out = KnowledgeCompiler.formatSummaryForCompile(summary)
        out shouldContain "### Commit abc12345 -- Add auth (2026-01-01T00:00:00Z)"
        out shouldContain "**Auth**"
        out shouldContain "- Why: needed login"
        out shouldContain "- Decisions: use oauth"
        out shouldContain "- What: added oauth"
        out shouldContain "- Files: a.kt"
    }
}
