package ai.jolli.jollimemory.toolwindow.views

/**
 * CreatePrCssBuilder — stylesheet for the dedicated "Create PR" webview, matching
 * the design mockup's `#pane-pr`.
 *
 * Self-contained (own `:root` token block per theme) rather than pulling in the
 * ~1900-line summary stylesheet — it only needs the pane's own vocabulary. Emits
 * hardcoded colours from an `isDark` flag because the IntelliJ JCEF webview has no
 * `var(--vscode-*)` theme tokens (those are VS Code-only). Token values mirror
 * [SummaryCssBuilder] so the two views read as one design system.
 */
object CreatePrCssBuilder {

    private const val FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    private const val MONO_FONT_FAMILY = "'JetBrains Mono', Menlo, Consolas, 'Courier New', monospace"

    fun buildCss(isDark: Boolean): String = """
  :root {
${if (isDark) darkVars() else lightVars()}
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .hidden { display: none !important; }
  body {
    font-family: $FONT_FAMILY; font-size: 14px; color: var(--text-primary);
    background: var(--bg); line-height: 1.65; -webkit-font-smoothing: antialiased;
  }
  .pane { max-width: 860px; margin: 0 auto; padding: 26px 34px 60px; }
  h1 { font-size: 1.4em; font-weight: 700; margin-bottom: 12px; }

  /* ── Meta strip ── */
  .meta-strip {
    display: flex; flex-wrap: wrap; align-items: center; gap: 5px 9px;
    font-size: 0.86em; color: var(--text-secondary); margin-bottom: 6px;
  }
  .meta-strip .meta-sep { color: var(--text-tertiary); opacity: 0.55; }
  .meta-branch {
    display: inline-block; max-width: 240px; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; vertical-align: bottom; padding: 1px 8px; border-radius: 5px;
    background: var(--pill-bg); color: var(--pill-text); font-size: 0.92em;
  }
  .pr-open-link { cursor: pointer; color: var(--link-fg); font-weight: 600; }
  .pr-open-link:hover { text-decoration: underline; }

  /* ── Sign-in / share sub-message ── */
  .ship-sub {
    font-size: 0.82em; color: var(--text-secondary); line-height: 1.45;
    margin: 2px 0 14px; display: flex; align-items: baseline; gap: 5px;
  }
  .ship-sub .sw-link { color: var(--link-fg); cursor: pointer; text-decoration: underline; }

  /* ── Status chip ── */
  .ship-status {
    display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0;
    font-size: 0.72em; font-weight: 650; letter-spacing: 0.02em; padding: 2px 9px;
    border-radius: 11px; background: var(--surface-hover); color: var(--text-secondary);
  }
  .ship-status.is-ok { color: var(--ship-ok); }

  /* ── Panels ── */
  .panel {
    border: 1px solid var(--border-light); border-radius: 12px;
    background: var(--panel-bg); padding: 16px; margin-bottom: 20px;
  }
  .panel-header {
    display: flex; align-items: center; gap: 8px;
    padding-bottom: 8px; margin-bottom: 12px; border-bottom: 1px solid var(--border-light);
  }
  .panel-title {
    font-size: 0.78em; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.09em; color: var(--text-secondary);
  }
  .panel > p { margin: 0; }
  .sec-count { margin-left: auto; font-size: 0.78em; font-weight: 600; color: var(--text-tertiary); }
  .ship-status.is-ok, .panel-header .ship-status { margin-left: auto; }

  /* ── Rows (memories + files) ── */
  .row { display: flex; align-items: center; gap: 10px; padding: 7px 4px; border-radius: 6px; cursor: pointer; }
  .row:hover { background: var(--surface-hover); }
  .mem-ico { font-size: 1em; opacity: 0.5; flex-shrink: 0; }
  .r-main { flex: 1; min-width: 0; }
  .r-title { font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .r-sub { font-size: 0.78em; color: var(--text-secondary); }
  .meta-hash { font-family: $MONO_FONT_FAMILY; color: var(--link-fg); }

  /* ── Git-status letter badge ── */
  .gs { flex-shrink: 0; font-size: 0.75em; font-weight: 700; width: 16px; text-align: center; font-family: $MONO_FONT_FAMILY; }
  .gs-M, .fname-M { color: var(--gs-modified); }
  .gs-A, .fname-A { color: var(--gs-added); }
  .gs-D, .fname-D { color: var(--gs-deleted); }
  .gs-R, .fname-R { color: var(--gs-renamed); }
  .gs-U, .fname-U { color: var(--gs-untracked); }
  .gs-C, .fname-C { color: var(--gs-deleted); }

  /* ── Rendered markdown body ── */
  .md-mock { line-height: 1.65; font-size: 0.93em; }
  .md-mock .md-heading { font-weight: 700; margin: 10px 0 4px; }
  .md-mock h2.md-heading { font-size: 1.05em; } .md-mock h3.md-heading { font-size: 1em; }
  .md-mock .md-list { margin: 4px 0 8px 20px; } .md-mock .md-list li { margin: 2px 0; }
  .md-mock .md-blank { height: 6px; }
  .md-mock .md-inline-code, .md-mock code {
    background: var(--code-block-bg); padding: 1px 5px; border-radius: 4px;
    font-family: $MONO_FONT_FAMILY; font-size: 0.9em;
  }
  .md-mock .md-code-block {
    background: var(--code-block-bg); padding: 10px 12px; border-radius: 6px;
    overflow-x: auto; margin: 6px 0; font-family: $MONO_FONT_FAMILY; font-size: 0.85em;
  }
  .md-mock .md-link { color: var(--link-fg); }

  /* ── Actions ── */
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .btn {
    font-family: $FONT_FAMILY; font-size: 0.88em; padding: 8px 16px; border-radius: 6px;
    cursor: pointer; border: 1px solid var(--btn-border);
    background: var(--btn-primary-bg); color: var(--btn-primary-fg); font-weight: 600;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .btn:hover { background: var(--btn-primary-hover-bg); }
  .btn.secondary { background: var(--btn-secondary-bg); color: var(--btn-secondary-fg); }
  .btn.secondary:hover { background: var(--btn-secondary-hover-bg); color: var(--text-primary); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }

  /* ── Inline editors (revealed by Edit, replace the read-only display in place) ── */
  .pr-input, .pr-textarea {
    width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 4px;
    background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border);
    font-family: $FONT_FAMILY; font-size: 0.9em;
  }
  .pr-textarea { min-height: 240px; resize: vertical; font-family: $MONO_FONT_FAMILY; font-size: 0.85em; }
  .pr-input:focus, .pr-textarea:focus { outline: 1px solid var(--focus-border); outline-offset: -1px; }

  /* ── Toast (copy confirmation) ── */
  .toast {
    position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%) translateY(8px); z-index: 80;
    background: var(--toast-bg); border: 1px solid var(--border-light); color: var(--text-primary);
    border-radius: 7px; padding: 8px 16px; font-size: 0.82em; box-shadow: 0 4px 14px rgba(0,0,0,0.3);
    opacity: 0; pointer-events: none; transition: all 0.18s ease;
  }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
"""

    private fun darkVars() = """
    --bg: #1e1e1e; --text-primary: #e0e0e0;
    --text-secondary: rgba(255,255,255,0.45); --text-tertiary: rgba(255,255,255,0.30);
    --link-fg: #3794ff; --focus-border: #007acc;
    --surface-hover: rgba(255,255,255,0.035); --border-light: rgba(255,255,255,0.06);
    --pill-bg: rgba(255,255,255,0.08); --pill-text: rgba(255,255,255,0.60);
    --panel-bg: rgba(255,255,255,0.018); --code-block-bg: rgba(128,128,128,0.1);
    --btn-primary-bg: #0e639c; --btn-primary-fg: #fff; --btn-primary-hover-bg: #1177bb;
    --btn-secondary-bg: #3a3d41; --btn-secondary-fg: #fff; --btn-secondary-hover-bg: #45494e;
    --btn-border: rgba(255,255,255,0.06);
    --input-bg: #1e1e1e; --input-fg: #ccc; --input-border: #444;
    --toast-bg: #2b2d30; --ship-ok: #4ece8d;
    --gs-modified: #e0ac2b; --gs-added: #4ece8d; --gs-deleted: #f47067;
    --gs-renamed: #b494f0; --gs-untracked: #8c8c8c;"""

    private fun lightVars() = """
    --bg: #ffffff; --text-primary: #1e1e1e;
    --text-secondary: rgba(0,0,0,0.45); --text-tertiary: rgba(0,0,0,0.32);
    --link-fg: #0066bf; --focus-border: #007acc;
    --surface-hover: rgba(0,0,0,0.028); --border-light: rgba(0,0,0,0.06);
    --pill-bg: rgba(0,0,0,0.06); --pill-text: rgba(0,0,0,0.55);
    --panel-bg: rgba(0,0,0,0.015); --code-block-bg: rgba(128,128,128,0.1);
    --btn-primary-bg: #007acc; --btn-primary-fg: #fff; --btn-primary-hover-bg: #0062a3;
    --btn-secondary-bg: #e8e8e8; --btn-secondary-fg: #444; --btn-secondary-hover-bg: #d6d6d6;
    --btn-border: rgba(0,0,0,0.06);
    --input-bg: #ffffff; --input-fg: #1e1e1e; --input-border: #cecece;
    --toast-bg: #ffffff; --ship-ok: #1b8a4f;
    --gs-modified: #96680e; --gs-added: #1b8a4f; --gs-deleted: #c0392b;
    --gs-renamed: #5c35a0; --gs-untracked: #6e6e6e;"""
}
