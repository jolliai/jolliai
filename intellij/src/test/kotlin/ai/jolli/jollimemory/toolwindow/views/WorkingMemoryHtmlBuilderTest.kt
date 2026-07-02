package ai.jolli.jollimemory.toolwindow.views

import ai.jolli.jollimemory.toolwindow.views.WorkingMemoryHtmlBuilder.WmContext
import ai.jolli.jollimemory.toolwindow.views.WorkingMemoryHtmlBuilder.WmConversation
import ai.jolli.jollimemory.toolwindow.views.WorkingMemoryHtmlBuilder.WmFile
import ai.jolli.jollimemory.toolwindow.views.WorkingMemoryHtmlBuilder.WmTokens
import ai.jolli.jollimemory.toolwindow.views.WorkingMemoryHtmlBuilder.WorkingMemoryView
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import org.junit.jupiter.api.Test

class WorkingMemoryHtmlBuilderTest {

    private fun view(
        token: WmTokens? = null,
        conversations: List<WmConversation> = emptyList(),
        context: List<WmContext> = emptyList(),
        files: List<WmFile> = emptyList(),
    ) = WorkingMemoryView(
        branch = "feature/x",
        filesChanged = files.size,
        insertions = 10,
        deletions = 2,
        detectedTicket = null,
        proposedTitle = "feat: thing",
        token = token,
        conversations = conversations,
        context = context,
        files = files,
    )

    private fun build(v: WorkingMemoryView) = WorkingMemoryHtmlBuilder.buildHtml(v, isDark = true, bridgeScript = "")

    @Test
    fun `renders the token meter with total, segments and legend when usage is reported`() {
        val html = build(view(token = WmTokens(total = 1_400_000, input = 96_000, output = 47_000, cacheRead = 1_200_000, cacheWrite = 61_000, partial = false)))
        html shouldContain "1.4M tokens"
        html shouldContain "captured by this memory"
        html shouldContain "wm-tmeter-bar"
        html shouldContain "wm-seg-in"
        html shouldContain "wm-seg-out"
        html shouldContain "wm-seg-cache"
        // legend numbers (input / output / cached = read+write)
        html shouldContain "96k input"
        html shouldContain "47k output"
        html shouldContain "1.3M cached"
        // tooltip breaks cache into read + write
        html shouldContain "cache read"
        html shouldContain "cache write"
        html shouldNotContain "recorded when you commit"
    }

    @Test
    fun `shows the not-reported state when no usage is available`() {
        val html = build(view(token = null))
        html shouldContain "wm-tmeter-na"
        html shouldContain "Token usage is recorded when you commit"
        // No rendered meter head/bar element in the not-reported state (the CSS class
        // definitions are always present in <style>, so assert on rendered content).
        html shouldNotContain "captured by this memory"
        html shouldNotContain """<div class="wm-tmeter-bar""""
    }

    @Test
    fun `flags partial usage`() {
        val html = build(view(token = WmTokens(1000, 600, 400, 0, 0, partial = true)))
        html shouldContain "partial"
    }

    @Test
    fun `included conversation shows leave-out toggle and excluded shows add-back with strikethrough`() {
        val html = build(
            view(
                conversations = listOf(
                    WmConversation("claude", "Kept convo", 7, key = "claude:s1", excluded = false),
                    WmConversation("codex", "Dropped convo", 3, key = "codex:s2", excluded = true),
                ),
            ),
        )
        // Included → ✕ (leave out), data-excluded=false, kind=conversations
        html shouldContain """data-kind="conversations" data-key="claude:s1" data-excluded="false""""
        html shouldContain "Leave out of this memory"
        // Excluded → + (add back), dimmed/strikethrough row
        html shouldContain """data-kind="conversations" data-key="codex:s2" data-excluded="true""""
        html shouldContain "Add back to this memory"
        html shouldContain "wm-excluded"
    }

    @Test
    fun `context rows carry the correct kind and key for plans, notes, and references`() {
        val html = build(
            view(
                context = listOf(
                    WmContext("P", "My plan", kind = "plans", key = "my-plan", excluded = false),
                    WmContext("N", "My note", kind = "notes", key = "note-1", excluded = true),
                    WmContext("L", "ENG-1", kind = "references", key = "linear:ENG-1", excluded = false),
                ),
            ),
        )
        html shouldContain """data-kind="plans" data-key="my-plan""""
        html shouldContain """data-kind="notes" data-key="note-1""""
        html shouldContain """data-kind="references" data-key="linear:ENG-1""""
    }

    @Test
    fun `escapes HTML in titles`() {
        val html = build(view(conversations = listOf(WmConversation("claude", "<img onerror=x>", 1, "claude:s", false))))
        html shouldContain "&lt;img onerror=x&gt;"
        html shouldNotContain "<img onerror=x>"
    }
}
