package ai.jolli.jollimemory.toolwindow.views

import ai.jolli.jollimemory.toolwindow.CommitMemoryFormat

/**
 * Renders the "Working Memory" review web view — the full memory the next commit
 * will save. Mirrors the mockup's `pane-working` and reuses [SummaryCssBuilder]
 * for theme tokens so it matches the Memory Summary / PR webviews.
 *
 * Interactive: each conversation / context row carries a ✕ (leave out) / + (add
 * back) toggle that flips its commit-selection exclusion in place, and a token
 * meter shows the AI usage captured by the included conversations. A Commit
 * Memory button bridges back to the IDE to run the AI commit.
 */
object WorkingMemoryHtmlBuilder {

    /**
     * Aggregate AI token usage captured by the included conversations, in the
     * canonical (TS-identical) shape: `cached` is cache_creation only, cache_read
     * excluded, so `total = input + output + cached`. [estimatedCostUsd] is the
     * per-model cost estimate (null when unpriced).
     */
    data class WmTokens(
        val total: Long,
        val input: Long,
        val output: Long,
        val cached: Long,
        /** Some included sources didn't report usage — the total understates reality. */
        val partial: Boolean,
        val estimatedCostUsd: Double? = null,
    )

    /**
     * A conversation feeding the next memory. [key] is the commit-selection key
     * (`conversationKey`); [excluded] reflects whether the user has left it out.
     */
    data class WmConversation(
        val source: String,
        val title: String,
        val messageCount: Int,
        val key: String,
        val excluded: Boolean,
    )

    /**
     * A linked context item (plan / note / reference). `tag` is the kb glyph;
     * [kind] is the commit-selection kind (`plans` / `notes` / `references`) and
     * [key] its selection key (slug / id / mapKey).
     */
    data class WmContext(
        val tag: String,
        val title: String,
        val kind: String,
        val key: String,
        val excluded: Boolean,
    )

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
        /** AI usage captured by the included conversations; null when none reported. */
        val token: WmTokens?,
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
                Everything here is included; leave an item out with <b>✕</b> or add it back with <b>+</b>.
                Nothing is committed until you choose <b>Commit Memory</b> below.</p>
                ${proposedTitle(view)}
                ${tokenMeter(view.token)}
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
                function __wmToggle(kind, key, excluded) {
                  if (window.__jbQuery) window.__jbQuery(JSON.stringify({ command: 'toggleExclude', kind: kind, key: key, excluded: excluded }));
                }
                document.querySelectorAll('.wm-excl').forEach(function (btn) {
                  btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    // data-excluded holds the CURRENT state; clicking flips it.
                    var nowExcluded = btn.getAttribute('data-excluded') !== 'true';
                    __wmToggle(btn.getAttribute('data-kind'), btn.getAttribute('data-key'), nowExcluded);
                  });
                });
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

    /**
     * Token usage meter: a segmented input/output/cache bar + legend when usage was
     * reported, or an honest "recorded at commit" note when it wasn't (live sessions
     * from sources that don't emit per-message usage). Mirrors the mockup's `.tmeter`.
     */
    private fun tokenMeter(t: WmTokens?): String {
        if (t == null || t.total <= 0) {
            return """
                <div class="wm-tmeter wm-tmeter-na">
                  <div class="wm-tmeter-head">
                    <span class="wm-tmeter-total">Token usage is recorded when you commit</span>
                  </div>
                </div>
            """.trimIndent()
        }
        val cache = t.cached
        fun pct(n: Long): Int = if (t.total <= 0) 0 else Math.round(n * 100.0 / t.total).toInt()
        val partialNote = if (t.partial) """<span class="wm-tmeter-sub">· partial (some sources don't report)</span>""" else ""
        // Estimated USD cost next to the total (priced per model; null when unpriced).
        val costNote = t.estimatedCostUsd?.let {
            """<span class="wm-tmeter-sub">· ${esc(CommitMemoryFormat.formatCost(it))}</span>"""
        } ?: ""
        val tip = "${CommitMemoryFormat.formatTokens(t.input)} input · ${CommitMemoryFormat.formatTokens(t.output)} output · " +
            "${CommitMemoryFormat.formatTokens(t.cached)} cache write"
        return """
            <div class="wm-tmeter">
              <div class="wm-tmeter-head">
                <span class="wm-tmeter-total">${CommitMemoryFormat.formatTokens(t.total)} tokens</span>
                $costNote
                <span class="wm-tmeter-sub">· captured by this memory</span>
                $partialNote
              </div>
              <div class="wm-tmeter-bar" title="${esc(tip)}">
                <span class="wm-seg-in" style="width:${pct(t.input)}%"></span>
                <span class="wm-seg-out" style="width:${pct(t.output)}%"></span>
                <span class="wm-seg-cache" style="width:${pct(cache)}%"></span>
              </div>
              <div class="wm-tmeter-legend">
                <span><i class="wm-lg-dot wm-seg-in"></i>${CommitMemoryFormat.formatTokens(t.input)} input</span>
                <span><i class="wm-lg-dot wm-seg-out"></i>${CommitMemoryFormat.formatTokens(t.output)} output</span>
                <span><i class="wm-lg-dot wm-seg-cache"></i>${CommitMemoryFormat.formatTokens(cache)} cached</span>
              </div>
            </div>
        """.trimIndent()
    }

    /** ✕ (leave out) / + (add back) toggle appended to a row. */
    private fun exclBtn(kind: String, key: String, excluded: Boolean): String {
        val glyph = if (excluded) "+" else "✕"
        val title = if (excluded) "Add back to this memory" else "Leave out of this memory"
        return """<button class="wm-excl" data-kind="${esc(kind)}" data-key="${esc(key)}" """ +
            """data-excluded="$excluded" title="$title" aria-label="$title">$glyph</button>"""
    }

    private fun conversationsPanel(v: WorkingMemoryView, isDark: Boolean): String {
        val rows = if (v.conversations.isEmpty()) {
            emptyRow("No active conversations in the last 2 days.")
        } else {
            v.conversations.joinToString("") { c ->
                val meta = if (c.messageCount > 0) "${c.messageCount} msg${if (c.messageCount != 1) "s" else ""}" else ""
                """
                <div class="wm-row${if (c.excluded) " wm-excluded" else ""}">
                  <span class="wm-logo" title="${esc(sourceLabel(c.source))}">${sourceIconSvg(c.source, isDark)}</span>
                  <div class="wm-rmain"><div class="wm-rtitle">${esc(c.title)}</div></div>
                  <span class="wm-rmeta">$meta</span>
                  ${exclBtn("conversations", c.key, c.excluded)}
                </div>
                """.trimIndent()
            }
        }
        return panel("Conversations", v.conversations.size, rows)
    }

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
                <div class="wm-row${if (c.excluded) " wm-excluded" else ""}">
                  <span class="wm-kbtag">${esc(c.tag)}</span>
                  <div class="wm-rmain"><div class="wm-rtitle">${esc(c.title)}</div></div>
                  ${exclBtn(c.kind, c.key, c.excluded)}
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

    private const val DB_ICON =
        "<svg class=\"wm-db\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\">" +
            "<ellipse cx=\"8\" cy=\"3.5\" rx=\"5\" ry=\"2\"/>" +
            "<path d=\"M3 3.5v9c0 1.1 2.2 2 5 2s5-.9 5-2v-9\"/>" +
            "<path d=\"M3 8c0 1.1 2.2 2 5 2s5-.9 5-2\"/></svg>"

    private fun esc(s: String): String = s
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

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
        /* ── Token meter ── */
        .wm-tmeter { margin: 2px 0 14px; }
        .wm-tmeter-head { font-size: 12.5px; color: var(--text-secondary); display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
        .wm-tmeter-total { font-size: 15px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }
        .wm-tmeter-sub { color: var(--text-tertiary); font-size: 11px; }
        .wm-tmeter-na .wm-tmeter-total { font-size: 12.5px; font-weight: 400; font-style: italic; color: var(--text-tertiary); }
        .wm-tmeter-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; margin: 8px 2px; max-width: 380px; background: rgba(128,128,128,0.16); }
        .wm-tmeter-bar > span { display: block; height: 100%; }
        .wm-seg-in { background: var(--stat-add); }
        .wm-seg-out { background: rgba(128,128,128,0.55); }
        .wm-seg-cache { background: var(--link-fg); }
        .wm-tmeter-legend { display: flex; flex-wrap: wrap; gap: 13px; font-size: 10.5px; color: var(--text-secondary); }
        .wm-tmeter-legend span { display: inline-flex; align-items: center; gap: 5px; font-variant-numeric: tabular-nums; }
        .wm-lg-dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; display: inline-block; }
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
        /* ── Remove / add toggle ── */
        .wm-excl { flex-shrink: 0; width: 20px; height: 20px; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: none; border: none; border-radius: 4px; cursor: pointer; color: var(--text-secondary); font-size: 14px; font-weight: 600; line-height: 1; }
        .wm-excl:hover { background: var(--surface-hover); color: var(--text-primary); }
        .wm-excluded { opacity: 0.6; }
        .wm-excluded .wm-rtitle { text-decoration: line-through; }
        .wm-excluded .wm-excl { color: var(--link-fg); }
        .wm-privacy { display: flex; gap: 6px; align-items: flex-start; font-size: 11.5px; color: var(--text-secondary); margin: 10px 0 6px; }
        .wm-ccnote { font-size: 11.5px; color: var(--text-secondary); line-height: 1.5; margin: 0 0 8px; }
        .wm-localfirst { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--ship-ok); margin: 0 0 10px; }
        .wm-db { width: 13px; height: 13px; flex-shrink: 0; }
        .wm-commit { width: 100%; background: var(--btn-primary-bg); color: var(--btn-primary-fg); border: none; border-radius: 6px; padding: 9px; font-size: 13px; font-weight: 600; cursor: pointer; }
        .wm-commit:hover { background: var(--btn-primary-hover-bg); }
    """.trimIndent()
}
