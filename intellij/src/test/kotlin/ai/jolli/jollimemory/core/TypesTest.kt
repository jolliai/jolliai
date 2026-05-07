package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class TypesTest {

    @Nested
    inner class Enums {
        @Test
        fun `TranscriptSource has correct values`() {
            TranscriptSource.entries.map { it.name } shouldBe listOf("claude", "codex", "gemini", "opencode")
        }

        @Test
        fun `TopicCategory has all expected values`() {
            TopicCategory.entries shouldBe listOf(
                TopicCategory.feature, TopicCategory.bugfix, TopicCategory.refactor,
                TopicCategory.`tech-debt`, TopicCategory.performance, TopicCategory.security,
                TopicCategory.test, TopicCategory.docs, TopicCategory.ux, TopicCategory.devops,
            )
        }

        @Test
        fun `TopicImportance has correct values`() {
            TopicImportance.entries.map { it.name } shouldBe listOf("major", "minor")
        }

        @Test
        fun `CommitType has all expected values`() {
            CommitType.entries.map { it.name } shouldBe listOf("commit", "amend", "squash", "rebase", "cherry-pick", "revert")
        }

        @Test
        fun `CommitSource has correct values`() {
            CommitSource.entries.map { it.name } shouldBe listOf("cli", "plugin")
        }

        @Test
        fun `LogLevel priorities are ordered`() {
            LogLevel.debug.priority shouldBe 0
            LogLevel.info.priority shouldBe 1
            LogLevel.warn.priority shouldBe 2
            LogLevel.error.priority shouldBe 3
        }
    }

    @Nested
    inner class DataClasses {
        @Test
        fun `DiffStats has sensible defaults`() {
            val stats = DiffStats()
            stats.filesChanged shouldBe 0
            stats.insertions shouldBe 0
            stats.deletions shouldBe 0
        }

        @Test
        fun `CommitSummary has sensible defaults`() {
            val summary = CommitSummary(
                commitHash = "abc",
                commitMessage = "msg",
                commitAuthor = "author",
                commitDate = "date",
                branch = "main",
                generatedAt = "now",
            )
            summary.version shouldBe 3
            summary.topics shouldBe null
            summary.children shouldBe null
            summary.ticketId shouldBe null
        }

        @Test
        fun `SummaryIndex has sensible defaults`() {
            val index = SummaryIndex()
            index.version shouldBe 3
            index.entries shouldBe emptyList()
            index.commitAliases shouldBe null
        }

        @Test
        fun `FileWrite has delete default false`() {
            val fw = FileWrite("path", "content")
            fw.delete shouldBe false
        }

        @Test
        fun `InstallResult has empty warnings by default`() {
            val result = ai.jolli.jollimemory.core.InstallResult(true, "ok")
            result.warnings shouldBe emptyList()
        }

        @Test
        fun `SessionsRegistry has sensible defaults`() {
            val registry = SessionsRegistry()
            registry.version shouldBe 1
            registry.sessions shouldBe emptyMap()
        }

        @Test
        fun `PlansRegistry has sensible defaults`() {
            val registry = PlansRegistry()
            registry.version shouldBe 1
            registry.plans shouldBe emptyMap()
        }

        @Test
        fun `TopicUpdates allows partial updates`() {
            val updates = TopicUpdates(title = "New Title")
            updates.title shouldBe "New Title"
            updates.trigger shouldBe null
            updates.response shouldBe null
        }
    }
}
