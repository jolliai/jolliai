package ai.jolli.jollimemory.toolwindow.views

import ai.jolli.jollimemory.toolwindow.views.SummaryUtils.escHtml

/**
 * CreatePrBodyMarkdown — Kotlin port of `vscode/src/views/CreatePrBodyMarkdown.ts`.
 *
 * Server-side renderer that turns the PR body markdown produced by
 * [SummaryPrMarkdownBuilder.buildPrMarkdown] into formatted HTML for the Create
 * PR pane, so the body reads like the rendered memory detail view instead of
 * raw monospace text.
 *
 * The PR body is GitHub-flavored markdown that mixes markdown syntax
 * (`## heading`, `**bold**`, `- list`, `` `code` ``, `> quote`, `---`) with a
 * small set of structural HTML tags used for folding topics
 * (`<details>` / `<summary>` / `<blockquote>` / `<br>`). We render it safely by:
 *
 *   1. Passing through ONLY whole-line, whitelisted structural tags verbatim so
 *      `<details>` folds and `<blockquote>` quotes render natively.
 *   2. HTML-escaping every other line (via [escHtml]) BEFORE applying markdown,
 *      so any stray angle bracket in prose becomes literal text and can never
 *      inject markup. This is defense-in-depth against injection from an
 *      LLM-generated / hand-edited summary.
 *
 * This is deliberately distinct from the Summary detail view's `renderMarkdown`
 * (which escapes ALL HTML — its content never contains folding tags). Keep the
 * two independent — they have different escaping contracts.
 */
object CreatePrBodyMarkdown {

    /** Whole-line structural tags emitted by [SummaryPrMarkdownBuilder.wrapInGithubDetails] — passed through as-is. */
    private val PASSTHROUGH_LINE = Regex("^(<details>|</details>|<br\\s*/?>|<blockquote>|</blockquote>)$")

    /**
     * A single-line `<summary><strong>…</strong></summary>` row — the exact shape
     * `wrapInGithubDetails` callers produce (see [SummaryPrMarkdownBuilder]).
     * Anchored to that shape, not just the outer tags, so that if the embedded
     * title ever isn't pre-escaped upstream, the stray `<`/`>` it carries makes
     * the line fail to match here and fall through to the paragraph branch —
     * which HTML-escapes it — fail closed rather than emitting untrusted markup.
     */
    private val SUMMARY_LINE = Regex("^<summary><strong>[^<>]*</strong></summary>$")

    /**
     * Reverses [SummaryPrMarkdownBuilder.escapeGithubWrapperTags]'s encoding of
     * the `<details>` / `<blockquote>` tag names before this renderer's own
     * [escHtml] re-escapes the line. That upstream function neutralizes a literal
     * `<details>`/`<blockquote>` typed in body prose into the entity text
     * `&lt;details&gt;` so GitHub's markdown renderer shows it inertly. Without
     * this undo step, [escHtml] here would escape the leftover `&` a second time
     * — `&lt;details&gt;` becomes `&amp;lt;details&amp;gt;`, which the browser
     * then displays as the literal text "&lt;details&gt;" instead of "<details>",
     * diverging from what GitHub shows for the identical markdown. Limited to
     * exactly the two tag names [SummaryPrMarkdownBuilder.escapeGithubWrapperTags]
     * touches, so it can't be used to smuggle other markup back in.
     */
    private val GH_WRAPPER_ENTITY = Regex("&lt;(/?)(details|blockquote)((?:\\s[^&]*)?)&gt;", RegexOption.IGNORE_CASE)

    private fun undoGithubWrapperEntities(text: String): String =
        GH_WRAPPER_ENTITY.replace(text) { m -> "<${m.groupValues[1]}${m.groupValues[2]}${m.groupValues[3]}>" }

    /**
     * Delimits inline-protection placeholder tokens (see [applyInline]).
     * U+E000 is in the Unicode Private Use Area — never produced by [escHtml]
     * or normal PR body text. A PUA collision is theoretically possible (icon
     * fonts, custom tooling) but not observed in GitHub PR bodies; if one ever
     * surfaces, swap to a two-char sentinel (e.g. U+E000 U+E001).
     */
    private const val PLACEHOLDER_DELIM = ''

    private val INLINE_CODE = Regex("`([^`]+)`")
    private val INLINE_LINK = Regex("\\[([^\\]]+)\\]\\((https?://[^)]+)\\)")
    private val INLINE_BOLD = Regex("\\*\\*([^*]+)\\*\\*")
    private val INLINE_ITALIC = Regex("(?<!\\*)\\*([^*]+)\\*(?!\\*)")

    /**
     * Applies inline markdown to an already-HTML-escaped string.
     *
     * Order matters: inline code first, then links, then bold, then italic.
     * `_`-based emphasis is intentionally unsupported because underscores are
     * common in file paths, identifiers, and URLs that appear throughout PR
     * bodies.
     *
     * Code and link matches are swapped for opaque placeholder tokens rather
     * than spliced in directly — otherwise the later bold/italic passes run over
     * the whole string and reprocess `*`/`_` characters that happen to land
     * inside the HTML just inserted for an earlier match (e.g. `` `**not bold**` ``
     * would have its code-span content re-bolded). The tokens are restored after
     * all passes run.
     */
    private fun applyInline(escaped: String): String {
        val placeholders = mutableListOf<String>()
        fun protect(html: String): String {
            val token = "$PLACEHOLDER_DELIM${placeholders.size}$PLACEHOLDER_DELIM"
            placeholders.add(html)
            return token
        }
        var text = escaped
            .replace(INLINE_CODE) { m -> protect("<code class=\"md-inline-code\">${m.groupValues[1]}</code>") }
            .replace(INLINE_LINK) { m -> protect("<a class=\"md-link\" href=\"${m.groupValues[2]}\">${m.groupValues[1]}</a>") }
            .replace(INLINE_BOLD) { m -> "<strong>${m.groupValues[1]}</strong>" }
            .replace(INLINE_ITALIC) { m -> "<em>${m.groupValues[1]}</em>" }
        if (placeholders.isEmpty()) return text
        val restore = Regex("$PLACEHOLDER_DELIM(\\d+)$PLACEHOLDER_DELIM")
        return text.replace(restore) { m -> placeholders[m.groupValues[1].toInt()] }
    }

    private val HEADING = Regex("^(#{1,6})\\s+(.+)$")
    private val HR = Regex("^(-{3,}|\\*{3,}|_{3,})$")
    private val QUOTE = Regex("^>\\s?(.*)$")
    private val UNORDERED = Regex("^[-*]\\s+(.+)$")
    private val ORDERED = Regex("^\\d+[.)]\\s+(.+)$")
    private val FENCE = Regex("^```")

    /**
     * Renders PR body markdown to formatted HTML.
     *
     * @param raw the PR body markdown (without idempotent markers).
     * @return HTML string safe to inject into the pane's `.md-body` container,
     *   or an empty string when the body is blank.
     */
    fun renderPrBodyMarkdown(raw: String): String {
        if (raw.isBlank()) return ""
        val lines = raw.replace("\r\n", "\n").split("\n")
        val out = StringBuilder()
        var listType: String? = null // "ul" or "ol"
        var inCode = false
        val codeLines = mutableListOf<String>()

        fun closeList() {
            if (listType != null) {
                out.append(if (listType == "ul") "</ul>" else "</ol>")
                listType = null
            }
        }

        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val trimmed = line.trim()

            // Fenced code block: toggle, buffering the raw lines between the fences.
            if (FENCE.containsMatchIn(trimmed)) {
                if (inCode) {
                    out.append("<pre class=\"md-code-block\"><code>${escHtml(codeLines.joinToString("\n"))}</code></pre>")
                    codeLines.clear()
                    inCode = false
                } else {
                    closeList()
                    inCode = true
                }
                i++
                continue
            }
            if (inCode) {
                codeLines.add(line)
                i++
                continue
            }

            // Whitelisted structural HTML — emit verbatim so folding renders natively.
            if (PASSTHROUGH_LINE.matches(trimmed) || SUMMARY_LINE.matches(trimmed)) {
                closeList()
                out.append(trimmed)
                i++
                continue
            }

            // ATX heading (# … ######). Level is offset +1 so top-level "##"
            // section titles render as modest labels rather than oversized headings.
            val heading = HEADING.matchEntire(trimmed)
            if (heading != null) {
                closeList()
                val level = (heading.groupValues[1].length + 1).coerceAtMost(6)
                out.append("<h$level class=\"md-heading\">${applyInline(escHtml(undoGithubWrapperEntities(heading.groupValues[2])))}</h$level>")
                i++
                continue
            }

            // Horizontal rule.
            if (HR.matches(trimmed)) {
                closeList()
                out.append("<hr class=\"md-hr\" />")
                i++
                continue
            }

            // Markdown blockquote (`>`), distinct from the passthrough `<blockquote>`
            // HTML tag. Consecutive quote lines merge into one block.
            val quote = QUOTE.matchEntire(trimmed)
            if (quote != null) {
                closeList()
                val parts = mutableListOf(applyInline(escHtml(undoGithubWrapperEntities(quote.groupValues[1]))))
                while (i + 1 < lines.size) {
                    val next = QUOTE.matchEntire(lines[i + 1].trim()) ?: break
                    parts.add(applyInline(escHtml(undoGithubWrapperEntities(next.groupValues[1]))))
                    i++
                }
                out.append("<blockquote class=\"md-quote\">${parts.joinToString("<br />")}</blockquote>")
                i++
                continue
            }

            // List item — unordered (`-`/`*`) or ordered (`1.`). Switching marker
            // type (e.g. a `-` list followed by a `1.` list) closes the open list
            // and opens a new one, matching GFM's own list-type-boundary behavior.
            val unordered = UNORDERED.matchEntire(trimmed)
            val ordered = if (unordered == null) ORDERED.matchEntire(trimmed) else null
            val item = unordered ?: ordered
            if (item != null) {
                val type = if (unordered != null) "ul" else "ol"
                if (listType != type) {
                    closeList()
                    out.append(if (type == "ul") "<ul class=\"md-list\">" else "<ol class=\"md-list\">")
                    listType = type
                }
                out.append("<li>${applyInline(escHtml(undoGithubWrapperEntities(item.groupValues[1])))}</li>")
                i++
                continue
            }

            closeList()

            // Blank line → vertical gap.
            if (trimmed.isEmpty()) {
                out.append("<div class=\"md-blank\"></div>")
                i++
                continue
            }

            // Regular paragraph line.
            out.append("<div class=\"md-line\">${applyInline(escHtml(undoGithubWrapperEntities(trimmed)))}</div>")
            i++
        }

        closeList()
        // An unterminated fenced block still flushes what was buffered.
        if (inCode) {
            out.append("<pre class=\"md-code-block\"><code>${escHtml(codeLines.joinToString("\n"))}</code></pre>")
        }
        return out.toString()
    }
}
