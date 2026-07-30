package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.CommitSummary
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Test

/**
 * Identity contract that keeps [MemoryTabOpener]'s tab-reuse path working.
 *
 * The reuse plan is: MemoryTabOpener holds at most one live SummaryFileEditor
 * per project and swaps its summary in place. If IntelliJ's tab manager saw
 * two `SummaryVirtualFile` instances as "equal" (because they carry the same
 * commit hash), it would dedupe them — closing the reused tab and opening a
 * fresh one, defeating the reuse and triggering the macOS NSView first-attach
 * repaint bug we're working around. So `equals` MUST be identity-based, and
 * `updateSummary` MUST preserve identity across content swaps.
 */
class SummaryVirtualFileTest {

    private fun summary(hash: String, message: String = "test"): CommitSummary = CommitSummary(
        commitHash = hash,
        commitMessage = message,
        commitAuthor = "Test",
        commitDate = "2026-01-01T00:00:00Z",
        branch = "main",
        generatedAt = "2026-01-01T00:00:00Z",
    )

    @Test
    fun `two instances with the same summary are NOT equal`() {
        val s = summary("abcdef1234567890")
        val a = SummaryVirtualFile(s)
        val b = SummaryVirtualFile(s)

        a shouldNotBe b
        a.hashCode() shouldNotBe b.hashCode()

        // …but each is equal to itself (identity).
        a shouldBe a
    }

    @Test
    fun `updateSummary swaps content in place and preserves identity`() {
        val original = summary("aaaaaaaaaaaaaaaa", message = "first")
        val replacement = summary("bbbbbbbbbbbbbbbb", message = "second")
        val vf = SummaryVirtualFile(original)
        val identityBefore = System.identityHashCode(vf)

        vf.summary shouldBe original
        vf.readOnly shouldBe false

        vf.updateSummary(replacement, newReadOnly = true)

        vf.summary shouldBe replacement
        vf.readOnly shouldBe true
        // Same JVM instance — critical for tab reuse.
        System.identityHashCode(vf) shouldBe identityBefore
    }

    @Test
    fun `getName tracks the current summary so a swap updates the tab title`() {
        val original = summary("aaaaaaaaaaaaaaaa", message = "original commit title")
        val replacement = summary("bbbbbbbbbbbbbbbb", message = "swapped commit title")
        val vf = SummaryVirtualFile(original)

        vf.getName() shouldContain "aaaaaaaa"
        vf.getName() shouldContain "original commit title"

        vf.updateSummary(replacement, newReadOnly = false)

        vf.getName() shouldContain "bbbbbbbb"
        vf.getName() shouldContain "swapped commit title"
    }

    @Test
    fun `getName truncates commit hash to 8 chars and commit message to 50 chars`() {
        val longHash = "0123456789abcdef" + "x".repeat(24)
        val longMessage = "M".repeat(120)
        val vf = SummaryVirtualFile(summary(longHash, message = longMessage))

        // Short hash prefix (8 chars).
        vf.getName() shouldContain longHash.substring(0, 8)
        // Message clamped to 50 chars — the full 120-char string must NOT appear.
        (vf.getName().contains(longMessage)) shouldBe false
        vf.getName() shouldContain "M".repeat(50)
    }

    @Test
    fun `isWritable is always false regardless of readOnly flag`() {
        val vf = SummaryVirtualFile(summary("cccccccccccccccc"), initialReadOnly = false)
        vf.isWritable shouldBe false
        vf.updateSummary(summary("dddddddddddddddd"), newReadOnly = true)
        vf.isWritable shouldBe false
    }
}
