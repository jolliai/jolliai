package ai.jolli.jollimemory.bridge

import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldEndWith
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class GlobalInstructionsInstallerTest {

    private val block = GlobalInstructionsInstaller.renderInstructionsBlock()

    @Nested
    inner class RenderInstructionsBlock {
        @Test
        fun `brackets the managed heading with markers and steers to all three skills`() {
            block shouldContain GlobalInstructionsInstaller.BLOCK_START
            block shouldContain GlobalInstructionsInstaller.BLOCK_END
            block shouldContain GlobalInstructionsInstaller.MANAGED_HEADING
            block shouldContain "`jolli-pr`"
            block shouldContain "`jolli-search`"
            block shouldContain "`jolli-recall`"
        }

        @Test
        fun `ends with a single trailing newline`() {
            block shouldEndWith "-->\n"
        }
    }

    @Nested
    inner class ApplyInstructionsBlock {
        @Test
        fun `writes the block verbatim into an empty file`() {
            GlobalInstructionsInstaller.applyInstructionsBlock("", block) shouldBe block
        }

        @Test
        fun `appends to existing content, adding a separating newline`() {
            val result = GlobalInstructionsInstaller.applyInstructionsBlock("hello", block)
            result shouldBe "hello\n$block"
        }

        @Test
        fun `replaces a pre-existing marker block in place, preserving surrounding text`() {
            val existing = "top matter\n\n$block\nbottom matter\n"
            val result = GlobalInstructionsInstaller.applyInstructionsBlock(existing, block)
            result shouldContain "top matter"
            result shouldContain "bottom matter"
            // Exactly one managed block remains (no duplicate appended).
            val occurrences = result.split(GlobalInstructionsInstaller.BLOCK_START).size - 1
            occurrences shouldBe 1
        }

        @Test
        fun `adopts an unmarked hand-pasted Jolli Memory section instead of duplicating`() {
            val existing = "# Title\n\n## Jolli Memory\n\nold hand-written text\n\n## Other\n\nkeep me\n"
            val result = GlobalInstructionsInstaller.applyInstructionsBlock(existing, block)
            result shouldContain "# Title"
            result shouldContain "## Other"
            result shouldContain "keep me"
            result shouldContain GlobalInstructionsInstaller.BLOCK_START
            result.contains("old hand-written text") shouldBe false
        }
    }

    @Nested
    inner class RemoveInstructionsBlock {
        @Test
        fun `removes the marker block and its blank separator`() {
            val existing = "keep\n\n$block"
            val result = GlobalInstructionsInstaller.removeInstructionsBlock(existing)
            // The blank separator before the block is dropped; the block's own trailing
            // newline survives as the file's final newline.
            result shouldBe "keep\n"
        }

        @Test
        fun `is a no-op when no block is present`() {
            val existing = "nothing to see here\n"
            GlobalInstructionsInstaller.removeInstructionsBlock(existing) shouldBe existing
        }

        @Test
        fun `apply then remove round-trips back to the original`() {
            val original = "header\nbody\n"
            val withBlock = GlobalInstructionsInstaller.applyInstructionsBlock(original, block)
            val removed = GlobalInstructionsInstaller.removeInstructionsBlock(withBlock)
            removed shouldBe original
        }
    }

    @Nested
    inner class ResolveDecision {
        @Test
        fun `enabled writes without persisting`() {
            val d = GlobalInstructionsInstaller.resolveDecision("enabled", null)
            d shouldBe GlobalInstructionsInstaller.Decision(write = true)
        }

        @Test
        fun `disabled removes without persisting`() {
            val d = GlobalInstructionsInstaller.resolveDecision("disabled", null)
            d shouldBe GlobalInstructionsInstaller.Decision(write = false, remove = true)
        }

        @Test
        fun `undecided without a confirm callback is a no-op`() {
            val d = GlobalInstructionsInstaller.resolveDecision(null, null)
            d shouldBe GlobalInstructionsInstaller.Decision(write = false)
        }

        @Test
        fun `undecided plus a yes callback writes and persists enabled`() {
            val d = GlobalInstructionsInstaller.resolveDecision(null) { true }
            d shouldBe GlobalInstructionsInstaller.Decision(write = true, persist = "enabled")
        }

        @Test
        fun `undecided plus a no callback removes and persists disabled`() {
            val d = GlobalInstructionsInstaller.resolveDecision(null) { false }
            d shouldBe GlobalInstructionsInstaller.Decision(write = false, remove = true, persist = "disabled")
        }
    }
}
