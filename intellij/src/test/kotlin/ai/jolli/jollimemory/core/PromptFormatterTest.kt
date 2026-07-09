package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

/**
 * Tests for [PlanPromptFormatter] and [NotePromptFormatter] — caller-order
 * preservation and per-item / total char-budget truncation.
 */
class PromptFormatterTest {

    @TempDir
    lateinit var tempDir: Path

    private fun writePlan(slug: String, body: String): PlanEntry {
        val f = tempDir.resolve("$slug.md").toFile()
        f.writeText(body)
        return PlanEntry(slug = slug, title = "Plan $slug", sourcePath = f.absolutePath, addedAt = "", updatedAt = "", commitHash = null)
    }

    private fun writeNote(id: String, body: String): NoteEntry {
        val f = tempDir.resolve("note-$id.md").toFile()
        f.writeText(body)
        return NoteEntry(id = id, title = "Note $id", format = NoteFormat.markdown, addedAt = "", updatedAt = "", branch = "main", commitHash = null, sourcePath = f.absolutePath)
    }

    @Nested
    inner class Plans {
        @Test
        fun `returns empty string for no entries`() {
            PlanPromptFormatter.formatPlansBlock(emptyList()) shouldBe ""
        }

        @Test
        fun `wraps plans in a plans block preserving caller order`() {
            val block = PlanPromptFormatter.formatPlansBlock(
                listOf(writePlan("first", "body one"), writePlan("second", "body two")),
            )
            block shouldContain "<plans>"
            block shouldContain "</plans>"
            block shouldContain "slug=\"first\""
            block shouldContain "body one"
            // caller order: "first" element appears before "second".
            (block.indexOf("slug=\"first\"") < block.indexOf("slug=\"second\"")) shouldBe true
        }

        @Test
        fun `drops tail plans that exceed the total budget`() {
            // Each plan body ~1000 chars; a tiny total budget keeps only the first.
            val plans = (1..4).map { writePlan("p$it", "x".repeat(1000)) }
            val block = PlanPromptFormatter.formatPlansBlock(plans, maxCharsPerPlan = 4000, maxTotalChars = 1100)
            block shouldContain "slug=\"p1\""
            (block.contains("slug=\"p2\"")) shouldBe false
        }

        @Test
        fun `truncates a per-plan body over the per-item cap`() {
            val block = PlanPromptFormatter.formatPlansBlock(
                listOf(writePlan("big", "y".repeat(5000))), maxCharsPerPlan = 200,
            )
            block shouldContain "truncated"
        }
    }

    @Nested
    inner class Notes {
        @Test
        fun `returns empty string for no entries`() {
            NotePromptFormatter.formatNotesBlock(emptyList()) shouldBe ""
        }

        @Test
        fun `wraps notes in a notes block preserving caller order`() {
            val block = NotePromptFormatter.formatNotesBlock(
                listOf(writeNote("n1", "alpha body"), writeNote("n2", "beta body")),
            )
            block shouldContain "<notes>"
            block shouldContain "</notes>"
            block shouldContain "id=\"n1\""
            block shouldContain "alpha body"
            (block.indexOf("id=\"n1\"") < block.indexOf("id=\"n2\"")) shouldBe true
        }

        @Test
        fun `renders a note with a null sourcePath as an empty-body element`() {
            val note = NoteEntry(id = "empty", title = "T", format = NoteFormat.snippet, addedAt = "", updatedAt = "", branch = "main", commitHash = null, sourcePath = null)
            val block = NotePromptFormatter.formatNotesBlock(listOf(note))
            block shouldContain "id=\"empty\""
        }
    }
}
