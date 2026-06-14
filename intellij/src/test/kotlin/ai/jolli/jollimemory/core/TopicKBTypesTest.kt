package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.string.shouldNotEndWith
import org.junit.jupiter.api.Test

/**
 * Verifies the topic-KB types serialize byte-identically to the CLI's
 * `JSON.stringify(value, null, "\t")` (tab indent, no HTML escaping, declared
 * field order, null fields omitted, no trailing newline) — the synced
 * `topics/` JSON layer must not drift across CLI / VS Code / IntelliJ.
 */
class TopicKBTypesTest {

    @Test
    fun `TopicPage serializes with tab indent and TS field order`() {
        val page = TopicPage(
            stableSlug = "auth",
            title = "Auth",
            content = "Body <x> & y",
            lastUpdatedAt = "2026-01-01T00:00:00Z",
        )
        val expected = listOf(
            "{",
            "\t\"schemaVersion\": 1,",
            "\t\"stableSlug\": \"auth\",",
            "\t\"title\": \"Auth\",",
            "\t\"content\": \"Body <x> & y\",",
            "\t\"relatedBranches\": [],",
            "\t\"sourceRefs\": [],",
            "\t\"lastUpdatedAt\": \"2026-01-01T00:00:00Z\"",
            "}",
        ).joinToString("\n")
        TopicJson.stringify(page) shouldBe expected
    }

    @Test
    fun `serialization does not HTML-escape or add a trailing newline`() {
        val page = TopicPage(stableSlug = "s", title = "<a> & =", content = "x", lastUpdatedAt = "t")
        val json = TopicJson.stringify(page)
        json shouldContain "\"<a> & =\""
        json shouldNotContain "\\u003c"
        json shouldNotContain "\\u0026"
        json shouldNotEndWith "\n"
    }

    @Test
    fun `SourceRef omits null branch but keeps a present branch`() {
        TopicJson.stringify(SourceRef(type = "summary", id = "abc", timestamp = "t")) shouldNotContain "branch"
        TopicJson.stringify(SourceRef(type = "plan", id = "p", timestamp = "t", branch = "main")) shouldContain
            "\"branch\": \"main\""
    }

    @Test
    fun `TopicPage round-trips through parse`() {
        val page = TopicPage(
            stableSlug = "auth",
            title = "Auth",
            content = "Body",
            relatedBranches = listOf("main", "feature/x"),
            sourceRefs = listOf(SourceRef("summary", "abc123", "2026-01-01T00:00:00Z", branch = "main")),
            lastUpdatedAt = "2026-01-02T00:00:00Z",
        )
        TopicJson.parse(TopicJson.stringify(page), TopicPage::class.java) shouldBe page
    }

    @Test
    fun `TopicIndex round-trips through parse`() {
        val index = TopicIndex(
            topics = listOf(
                TopicIndexEntry(
                    stableSlug = "auth",
                    title = "Auth",
                    summary = "Auth stuff",
                    relatedBranches = listOf("main"),
                    sourceRefs = listOf(SourceRef("summary", "abc", "t")),
                    lastUpdatedAt = "2026-01-01T00:00:00Z",
                ),
            ),
        )
        TopicJson.parse(TopicJson.stringify(index), TopicIndex::class.java) shouldBe index
    }
}
