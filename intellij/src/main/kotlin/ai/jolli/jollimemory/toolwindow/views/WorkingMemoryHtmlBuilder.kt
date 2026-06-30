package ai.jolli.jollimemory.toolwindow.views

/**
 * Renders the "Working Memory" review web view — the full memory the next commit
 * will save. Mirrors the mockup's `pane-working` and reuses [SummaryCssBuilder]
 * for theme tokens so it matches the Memory Summary / PR webviews.
 *
 * Read-only/presentational: it shows what's included, plus a Commit Memory button
 * that bridges back to the IDE to run the AI commit.
 */
object WorkingMemoryHtmlBuilder {

    /** A conversation feeding the next memory. */
    data class WmConversation(val source: String, val title: String, val messageCount: Int)

    /** A linked context item (plan / note / reference / snippet). `tag` is the kb glyph. */
    data class WmContext(val tag: String, val title: String)

    /** A changed file that will be committed. */
    data class WmFile(val name: String, val dir: String, val status: String)

    /** Everything the Working Memory view renders. */
    data class WorkingMemoryView(
        val branch: String,
        val filesChanged: Int,
        val insertions: Int,
        val deletions: Int,
        val detectedTicket: String?,
        /**
         * Heuristic preview of the commit title (ticket + humanized branch), shown
         * before the AI writes the real one at commit time. Null when there's no
         * useful signal — the view then shows an explanatory placeholder.
         */
        val proposedTitle: String?,
        val tokenLabel: String,
        val conversations: List<WmConversation>,
        val context: List<WmContext>,
        val files: List<WmFile>,
    )

    fun buildHtml(view: WorkingMemoryView, isDark: Boolean, bridgeScript: String): String {
        val css = SummaryCssBuilder.buildCss(isDark) + extraCss()
        return """
            <!DOCTYPE html>
            <html>
            <head>
              <meta charset="utf-8">
              <style>$css</style>
              <script>$bridgeScript</script>
            </head>
            <body>
              <div class="wm">
                <h1 class="wm-title">Working Memory</h1>
                ${metaStrip(view)}
                <p class="wm-intro">The full memory your next commit will save — your final review.
                Everything here is included. Nothing is committed until you choose
                <b>Commit Memory</b> below.</p>
                ${proposedTitle(view)}
                ${tokenMeter(view)}
                ${conversationsPanel(view, isDark)}
                ${contextPanel(view)}
                ${filesPanel(view)}
                <p class="wm-privacy">🔒 Full conversation transcripts stay in your repo —
                never included in shared exports.</p>
                <p class="wm-ccnote">Commits the included files with an AI-written message, then
                saves a memory linking the included conversations + context. Conversations &amp;
                context aren't added to your commit — they stay local in your repo.</p>
                <div class="wm-localfirst">$DB_ICON Local-first — your transcripts stay in your repo;
                nothing leaves unless you Share or Sync.</div>
                <button class="wm-commit" onclick="__wmCommit()">Commit Memory</button>
              </div>
              <script>
                function __wmCommit() {
                  if (window.__jbQuery) window.__jbQuery(JSON.stringify({ command: 'commitMemory' }));
                }
              </script>
            </body>
            </html>
        """.trimIndent()
    }

    private fun metaStrip(v: WorkingMemoryView): String {
        val stats = "+${v.insertions} −${v.deletions} · ${v.filesChanged} file${if (v.filesChanged != 1) "s" else ""}"
        return """
            <div class="wm-meta">
              <span class="wm-branch">${esc(v.branch)}</span>
              <span class="wm-sep">·</span>
              <span class="wm-chip wm-chip-local">NOT COMMITTED</span>
              <span class="wm-sep">·</span>
              <span class="wm-stats">$stats</span>
            </div>
        """.trimIndent()
    }

    private fun proposedTitle(v: WorkingMemoryView): String {
        val ticket = v.detectedTicket?.let {
            "<span>Detected&nbsp;ticket&nbsp;<b>${esc(it)}</b></span>"
        } ?: ""
        // A heuristic preview when we have one; otherwise the honest "written at commit" note.
        val titleHtml = if (v.proposedTitle != null) {
            "<div class=\"wm-title-text\">${esc(v.proposedTitle)}</div>" +
                "<div class=\"wm-title-note\">Preview — the AI writes the final message when you commit.</div>"
        } else {
            "<div class=\"wm-title-text\">An AI-written commit message is generated when you commit.</div>"
        }
        return """
            <div class="wm-panel">
              <div class="wm-label">Proposed title <span class="wm-ai">AI</span></div>
              $titleHtml
              <div class="wm-grid">
                <span>Target&nbsp;commit&nbsp;<b>next on ${esc(v.branch)}</b></span>
                $ticket
              </div>
            </div>
        """.trimIndent()
    }

    private fun tokenMeter(v: WorkingMemoryView): String {
        return """
            <div class="wm-tmeter">
              <div class="wm-tmeter-head">
                <span class="wm-tmeter-total">${esc(v.tokenLabel)}</span>
                <span class="wm-tmeter-sub">· captured by this memory</span>
              </div>
            </div>
        """.trimIndent()
    }

    private fun conversationsPanel(v: WorkingMemoryView, isDark: Boolean): String {
        val rows = if (v.conversations.isEmpty()) {
            emptyRow("No active conversations in the last 2 days.")
        } else {
            v.conversations.joinToString("") { c ->
                val meta = if (c.messageCount > 0) "${c.messageCount} msg${if (c.messageCount != 1) "s" else ""}" else ""
                """
                <div class="wm-row">
                  <span class="wm-logo" title="${esc(sourceLabel(c.source))}">${sourceIconSvg(c.source, isDark)}</span>
                  <div class="wm-rmain"><div class="wm-rtitle">${esc(c.title)}</div></div>
                  <span class="wm-rmeta">$meta</span>
                </div>
                """.trimIndent()
            }
        }
        return panel("Conversations", v.conversations.size, rows)
    }

    /**
     * Inlines the per-tool logo SVG (the same `source-*.svg` icons the sidebar
     * uses) so it renders inside the JCEF page. Picks the `_dark` variant in dark
     * themes when one exists; falls back to the source initial on a miss.
     */
    private fun sourceIconSvg(source: String, isDark: Boolean): String {
        val name = if (source == "copilot-chat") "copilot" else source
        val base = "/icons/source-$name"
        val svg = (if (isDark) readResource("${base}_dark.svg") else null)
            ?: readResource("$base.svg")
        return svg ?: esc(sourceLabel(source).take(1))
    }

    private fun readResource(path: String): String? =
        javaClass.getResourceAsStream(path)?.bufferedReader()?.use { it.readText() }

    private fun contextPanel(v: WorkingMemoryView): String {
        val rows = if (v.context.isEmpty()) {
            emptyRow("No linked plans, notes, or references.")
        } else {
            v.context.joinToString("") { c ->
                """
                <div class="wm-row">
                  <span class="wm-kbtag">${esc(c.tag)}</span>
                  <div class="wm-rmain"><div class="wm-rtitle">${esc(c.title)}</div></div>
                </div>
                """.trimIndent()
            }
        }
        return panel("Context", v.context.size, rows)
    }

    private fun filesPanel(v: WorkingMemoryView): String {
        val rows = if (v.files.isEmpty()) {
            emptyRow("No changed files.")
        } else {
            v.files.joinToString("") { f ->
                val dir = if (f.dir.isNotEmpty()) "<div class=\"wm-rsub\">${esc(f.dir)}</div>" else ""
                """
                <div class="wm-row">
                  <div class="wm-rmain"><div class="wm-rtitle wm-fname">${esc(f.name)}</div>$dir</div>
                  <span class="wm-gs wm-gs-${esc(f.status)}">${esc(f.status)}</span>
                </div>
                """.trimIndent()
            }
        }
        return panel("Files", v.files.size, rows)
    }

    private fun panel(title: String, count: Int, rowsHtml: String): String = """
        <div class="wm-panel">
          <div class="wm-panel-head">
            <span class="wm-panel-title">${esc(title)}</span>
            <span class="wm-count">$count</span>
          </div>
          $rowsHtml
        </div>
    """.trimIndent()

    private fun emptyRow(text: String): String =
        "<div class=\"wm-row wm-empty\">${esc(text)}</div>"

    private fun sourceLabel(source: String): String = when (source) {
        "copilot" -> "Copilot"
        "copilot-chat" -> "Copilot Chat"
        "opencode" -> "OpenCode"
        else -> source.replaceFirstChar { it.uppercase() }
    }

    /** Small database glyph for the Local-first note; inherits the note's color. */
    private const val DB_ICON =
        "<svg class=\"wm-db\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\">" +
            "<ellipse cx=\"8\" cy=\"3.5\" rx=\"5\" ry=\"2\"/>" +
            "<path d=\"M3 3.5v9c0 1.1 2.2 2 5 2s5-.9 5-2v-9\"/>" +
            "<path d=\"M3 8c0 1.1 2.2 2 5 2s5-.9 5-2\"/></svg>"

    private fun esc(s: String): String = s
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

    /** Working-memory-specific styling layered on top of the shared summary theme. */
    private fun extraCss(): String = """
        .wm { padding: 14px 16px 22px; }
        .wm-title { font-size: 19px; margin: 0 0 8px; color: var(--text-primary); }
        .wm-meta { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 12.5px; color: var(--text-secondary); margin-bottom: 6px; }
        .wm-branch { font-weight: 600; color: var(--text-primary); }
        .wm-sep { color: var(--text-tertiary); }
        .wm-chip { font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 8px; letter-spacing: .03em; }
        .wm-chip-local { color: var(--text-secondary); border: 1px solid var(--widget-border); }
        .wm-intro { font-size: 12.5px; color: var(--text-secondary); margin: 2px 0 14px; line-height: 1.5; }
        .wm-panel { background: var(--panel-bg); border: 1px solid var(--widget-border); border-radius: 8px; padding: 10px 12px; margin: 0 0 12px; }
        .wm-label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-tertiary); margin-bottom: 4px; }
        .wm-ai { background: var(--pill-bg); color: var(--pill-text); border-radius: 5px; padding: 0 5px; font-size: 9.5px; font-weight: 700; margin-left: 4px; }
        .wm-title-text { font-size: 13.5px; color: var(--text-primary); margin-bottom: 4px; }
        .wm-title-note { font-size: 11px; color: var(--text-tertiary); margin-bottom: 8px; }
        .wm-grid { display: flex; flex-wrap: wrap; gap: 4px 18px; font-size: 11.5px; color: var(--text-secondary); }
        .wm-grid b { color: var(--text-primary); font-weight: 600; }
        .wm-tmeter { margin: 0 0 12px; }
        .wm-tmeter-total { font-weight: 700; color: var(--text-primary); }
        .wm-tmeter-sub { color: var(--text-tertiary); font-size: 11.5px; margin-left: 4px; }
        .wm-panel-head { display: flex; align-items: center; margin-bottom: 6px; }
        .wm-panel-title { font-weight: 600; color: var(--text-primary); font-size: 12.5px; }
        .wm-count { margin-left: auto; color: var(--text-tertiary); font-size: 11.5px; }
        .wm-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; border-top: 1px solid var(--border-light); }
        .wm-panel-head + .wm-row { border-top: none; }
        .wm-empty { color: var(--text-tertiary); font-size: 12px; font-style: italic; }
        .wm-rmain { flex: 1; min-width: 0; }
        .wm-rtitle { font-size: 12.5px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .wm-rsub { font-size: 11px; color: var(--text-tertiary); }
        .wm-rmeta { font-size: 11px; color: var(--text-tertiary); white-space: nowrap; }
        .wm-logo { display: inline-flex; align-items: center; flex-shrink: 0; }
        .wm-logo svg { width: 15px; height: 15px; display: block; }
        .wm-kbtag { font-size: 10px; font-weight: 700; color: var(--text-secondary); border: 1px solid var(--widget-border); border-radius: 5px; min-width: 16px; text-align: center; padding: 0 4px; }
        .wm-gs { font-size: 11px; font-weight: 700; }
        .wm-gs-M { color: var(--ship-warn); }
        .wm-gs-A { color: var(--stat-add); }
        .wm-gs-D { color: var(--stat-del); }
        .wm-fname { font-family: ui-monospace, monospace; }
        .wm-privacy { display: flex; gap: 6px; align-items: flex-start; font-size: 11.5px; color: var(--text-secondary); margin: 10px 0 6px; }
        .wm-ccnote { font-size: 11.5px; color: var(--text-secondary); line-height: 1.5; margin: 0 0 8px; }
        .wm-localfirst { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--ship-ok); margin: 0 0 10px; }
        .wm-db { width: 13px; height: 13px; flex-shrink: 0; }
        .wm-commit { width: 100%; background: var(--btn-primary-bg); color: var(--btn-primary-fg); border: none; border-radius: 6px; padding: 9px; font-size: 13px; font-weight: 600; cursor: pointer; }
        .wm-commit:hover { background: var(--btn-primary-hover-bg); }
    """.trimIndent()
}
