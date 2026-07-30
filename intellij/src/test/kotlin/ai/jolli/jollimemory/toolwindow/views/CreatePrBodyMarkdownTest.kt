package ai.jolli.jollimemory.toolwindow.views

import ai.jolli.jollimemory.toolwindow.views.CreatePrBodyMarkdown.renderPrBodyMarkdown
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import org.junit.jupiter.api.Test

/**
 * Kotlin mirror of `vscode/src/views/CreatePrBodyMarkdown.test.ts`. The two
 * renderers must agree line-for-line on the folding-tag whitelist: any drift is
 * a UI regression (the JCEF pane and the VS Code webview render the same
 * markdown from [SummaryPrMarkdownBuilder] side-by-side).
 */
class CreatePrBodyMarkdownTest {

    @Test
    fun `blank input returns empty string`() {
        renderPrBodyMarkdown("") shouldBe ""
        renderPrBodyMarkdown("   \n\t  ") shouldBe ""
    }

    @Test
    fun `headings offset by +1 so top-level ## renders as h3`() {
        val html = renderPrBodyMarkdown("## Summary")
        html shouldContain """<h3 class="md-heading">Summary</h3>"""
    }

    @Test
    fun `heading level clamps at h6`() {
        // `######` = 6, +1 = 7, clamp to 6. Anything deeper stops at h6.
        renderPrBodyMarkdown("###### Deep") shouldContain """<h6 class="md-heading">Deep</h6>"""
    }

    @Test
    fun `structural HTML tags pass through verbatim (Topics folding regression)`() {
        val body = """
            <details>
            <summary><strong>01 · A Topic Title</strong></summary>
            <br>
            <blockquote>

            Body text.

            </blockquote>
            </details>
        """.trimIndent()
        val html = renderPrBodyMarkdown(body)
        // Every whitelisted structural tag must appear as real HTML.
        html shouldContain "<details>"
        html shouldContain "<summary><strong>01 · A Topic Title</strong></summary>"
        html shouldContain "<br>"
        html shouldContain "<blockquote>"
        html shouldContain "</blockquote>"
        html shouldContain "</details>"
        // And none of them as escaped text (the old bug displayed &lt;details&gt;).
        html shouldNotContain "&lt;details&gt;"
        html shouldNotContain "&lt;summary&gt;"
    }

    @Test
    fun `non-whitelisted HTML is escaped defensively`() {
        // `<script>` is not in the passthrough list, so it must be escaped —
        // an LLM-generated body cannot inject arbitrary markup.
        val html = renderPrBodyMarkdown("<script>alert(1)</script>")
        html shouldContain "&lt;script&gt;alert(1)&lt;/script&gt;"
        html shouldNotContain "<script>"
    }

    @Test
    fun `summary shape must exactly match — a malformed summary line falls through to escape`() {
        // Anchored regex — an extra attribute or nested tag inside <strong> makes
        // the line fail the SUMMARY_LINE match, so it goes through the paragraph
        // branch and gets escaped. Fail-closed guarantee.
        val bad = "<summary><strong>ok<img src=x></strong></summary>"
        val html = renderPrBodyMarkdown(bad)
        html shouldContain "&lt;img src=x&gt;"
        html shouldNotContain "<img src=x>"
    }

    @Test
    fun `undoGithubWrapperEntities reverses escapeGithubWrapperTags for inline prose`() {
        // The CLI-side escapeGithubWrapperTags encodes a stray "<details>" typed in
        // body prose as "&lt;details&gt;" so GitHub renders it inertly. On the
        // display side we want the SAME "&lt;details&gt;" in the final HTML (so the
        // browser shows literal "<details>" as text) — without the undo pass we'd
        // double-escape to "&amp;lt;details&amp;gt;" and the browser would show the
        // entity text "&lt;details&gt;" instead. Verify the round-trip.
        val html = renderPrBodyMarkdown("The tag is &lt;details&gt; here.")
        html shouldContain "&lt;details&gt;"
        html shouldNotContain "&amp;lt;details&amp;gt;"
    }

    @Test
    fun `inline markdown — code, bold, italic, links`() {
        val html = renderPrBodyMarkdown("A `code` **bold** *italic* [link](https://x.y)")
        html shouldContain """<code class="md-inline-code">code</code>"""
        html shouldContain "<strong>bold</strong>"
        html shouldContain "<em>italic</em>"
        html shouldContain """<a class="md-link" href="https://x.y">link</a>"""
    }

    @Test
    fun `underscores are NOT bold — file paths and identifiers stay untouched`() {
        val html = renderPrBodyMarkdown("The var _foo_bar_ and file some_path_here.ts.")
        html shouldNotContain "<em>"
        html shouldNotContain "<strong>"
    }

    @Test
    fun `code span content is not reprocessed for bold or italic`() {
        // `**not bold**` inside a code span — the placeholder trick must keep the
        // literal asterisks out of the bold pass.
        val html = renderPrBodyMarkdown("`**not bold**`")
        html shouldContain """<code class="md-inline-code">**not bold**</code>"""
        html shouldNotContain "<strong>not bold</strong>"
    }

    @Test
    fun `unordered lists render into ul md-list with escaped item text`() {
        val html = renderPrBodyMarkdown("- item one\n- item <two>")
        html shouldContain """<ul class="md-list">"""
        html shouldContain "<li>item one</li>"
        html shouldContain "<li>item &lt;two&gt;</li>"
    }

    @Test
    fun `ordered lists render into ol md-list`() {
        val html = renderPrBodyMarkdown("1. first\n2. second")
        html shouldContain """<ol class="md-list">"""
        html shouldContain "<li>first</li>"
    }

    @Test
    fun `switching list type closes and reopens`() {
        val html = renderPrBodyMarkdown("- a\n1. b")
        // Both lists must appear; the ul closes before the ol opens.
        html shouldContain """<ul class="md-list"><li>a</li></ul><ol class="md-list"><li>b</li></ol>"""
    }

    @Test
    fun `markdown blockquote merges consecutive lines with br separators`() {
        val html = renderPrBodyMarkdown("> line 1\n> line 2")
        html shouldContain """<blockquote class="md-quote">line 1<br />line 2</blockquote>"""
    }

    @Test
    fun `horizontal rule renders md-hr`() {
        renderPrBodyMarkdown("---") shouldContain """<hr class="md-hr" />"""
        renderPrBodyMarkdown("***") shouldContain """<hr class="md-hr" />"""
    }

    @Test
    fun `fenced code block escapes body — never emits raw markup`() {
        val html = renderPrBodyMarkdown("```\n<script>bad</script>\n```")
        html shouldContain """<pre class="md-code-block"><code>&lt;script&gt;bad&lt;/script&gt;</code></pre>"""
    }

    @Test
    fun `unterminated fenced block still flushes buffered content`() {
        val html = renderPrBodyMarkdown("```\nsome text without closing fence")
        html shouldContain """<pre class="md-code-block"><code>some text without closing fence</code></pre>"""
    }

    @Test
    fun `blank line emits md-blank spacer`() {
        val html = renderPrBodyMarkdown("first line\n\nsecond line")
        html shouldContain """<div class="md-blank"></div>"""
    }
}
