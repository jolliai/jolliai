package ai.jolli.jollimemory.toolwindow.sidebar

import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import java.awt.Color

/**
 * Returns the full CSS for the JCEF sidebar webview.
 *
 * IntelliJ adaptation of VS Code's SidebarCssBuilder. Uses CSS custom
 * properties (`--jb-*`) that are injected at load time via [buildThemeVars]
 * from IntelliJ's UIManager/JBColor palette. When the IDE theme changes,
 * the host regenerates the CSS and reloads the HTML.
 *
 * Port note: VS Code `var(--vscode-foreground)` → `var(--jb-foreground)`.
 * The mapping is done in [buildThemeVars] so this CSS template stays stable.
 */
object SidebarCssBuilder {

	/** Returns CSS custom property declarations for the current IDE theme. */
	fun buildThemeVars(): String {
		val fg = colorHex(JBColor.foreground())
		val bg = colorHex(JBUI.CurrentTheme.ToolWindow.background())
		val descFg = colorHex(JBColor.GRAY)
		val border = colorHex(JBColor.border())
		val linkFg = colorHex(JBColor.BLUE)
		val inputBg = colorHex(JBColor.background())
		val inputFg = colorHex(JBColor.foreground())
		val hoverBg = "rgba(128,128,128,0.15)"
		val activeBg = "rgba(0,122,204,0.2)"
		val btnBg = colorHex(JBColor(Color(0x3574f0), Color(0x3574f0)))
		val btnFg = "#ffffff"
		val btnHoverBg = colorHex(JBColor(Color(0x2e6bd6), Color(0x4a85f5)))
		val errorFg = colorHex(JBColor(Color(0xf85149), Color(0xf85149)))
		val iconPassed = "#89d185"
		val iconQueued = "#cca700"
		val iconFailed = "#f48771"
		val menuBg = colorHex(JBColor(Color(0xf5f5f5), Color(0x2b2d30)))
		val menuFg = fg
		val menuBorder = border
		val selectionBg = colorHex(JBColor(Color(0xcce5ff), Color(0x2d4f67)))
		val focusBorder = colorHex(JBColor(Color(0x3574f0), Color(0x3574f0)))
		val widgetBorder = border
		val widgetBg = colorHex(JBColor(Color(0xf0f0f0), Color(0x3c3f41)))
		val shadowColor = "rgba(0,0,0,0.3)"
		// Git decoration colors
		val gitMod = colorHex(JBColor(Color(0xd5a339), Color(0xd5a339)))
		val gitAdd = colorHex(JBColor(Color(0x388a34), Color(0x73c991)))
		val gitDel = colorHex(JBColor(Color(0xc74e39), Color(0xf48771)))
		val gitUntracked = colorHex(JBColor(Color(0x388a34), Color(0x73c991)))
		val gitRenamed = colorHex(JBColor(Color(0x0065a9), Color(0x73c991)))
		val gitConflict = colorHex(JBColor(Color(0xe24e32), Color(0xf48771)))
		val gitIgnored = colorHex(JBColor.GRAY)
		val chartsBlue = "#2f7adc"
		val chartsGreen = "#388a34"
		val chartsOrange = "#d18616"
		val editorFont = "JetBrains Mono, Consolas, monospace"

		return """
		  :root {
		    --jb-foreground: $fg;
		    --jb-background: $bg;
		    --jb-desc-foreground: $descFg;
		    --jb-border: $border;
		    --jb-link-foreground: $linkFg;
		    --jb-input-bg: $inputBg;
		    --jb-input-fg: $inputFg;
		    --jb-hover-bg: $hoverBg;
		    --jb-active-bg: $activeBg;
		    --jb-btn-bg: $btnBg;
		    --jb-btn-fg: $btnFg;
		    --jb-btn-hover-bg: $btnHoverBg;
		    --jb-error-fg: $errorFg;
		    --jb-icon-passed: $iconPassed;
		    --jb-icon-queued: $iconQueued;
		    --jb-icon-failed: $iconFailed;
		    --jb-menu-bg: $menuBg;
		    --jb-menu-fg: $menuFg;
		    --jb-menu-border: $menuBorder;
		    --jb-selection-bg: $selectionBg;
		    --jb-focus-border: $focusBorder;
		    --jb-widget-border: $widgetBorder;
		    --jb-widget-bg: $widgetBg;
		    --jb-shadow: $shadowColor;
		    --jb-git-mod: $gitMod;
		    --jb-git-add: $gitAdd;
		    --jb-git-del: $gitDel;
		    --jb-git-untracked: $gitUntracked;
		    --jb-git-renamed: $gitRenamed;
		    --jb-git-conflict: $gitConflict;
		    --jb-git-ignored: $gitIgnored;
		    --jb-charts-blue: $chartsBlue;
		    --jb-charts-green: $chartsGreen;
		    --jb-charts-orange: $chartsOrange;
		    --jb-editor-font: $editorFont;
		  }
		""".trimIndent()
	}

	/** Returns the full sidebar CSS (stable across theme changes). */
	fun buildCss(): String = """
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .hidden { display: none !important; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    color: var(--jb-foreground);
    background: var(--jb-background);
    overflow: hidden;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .sidebar-root { display: flex; flex-direction: column; height: 100%; }
  .sidebar-root .disabled-banner {
    padding: 20px 16px 16px;
    color: var(--jb-foreground);
    flex-shrink: 0;
  }
  .sidebar-root .disabled-banner .disabled-intro {
    margin: 0 0 12px;
    color: var(--jb-desc-foreground);
    line-height: 1.4;
  }
  .sidebar-root .disabled-banner .enable-btn {
    padding: 6px 14px;
    background: var(--jb-btn-bg);
    color: var(--jb-btn-fg);
    border: none;
    cursor: pointer;
    border-radius: 2px;
  }
  .sidebar-root .disabled-banner .enable-btn:hover {
    background: var(--jb-btn-hover-bg);
  }

  .tab-bar {
    display: flex;
    align-items: center;
    background: transparent;
    border-bottom: 1px solid var(--jb-border);
    flex-shrink: 0;
    gap: 4px;
    padding: 2px 4px 2px 6px;
    min-height: 28px;
  }

  .breadcrumb {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .breadcrumb-seg {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 6px;
    border: none;
    background: transparent;
    color: var(--jb-foreground);
    cursor: pointer;
    font-size: 11px;
    border-radius: 3px;
    min-width: 0;
  }
  .breadcrumb-seg:hover { background: var(--jb-hover-bg); }
  .breadcrumb-seg[aria-expanded="true"] { background: var(--jb-active-bg); }
  .breadcrumb-seg-icon { flex: 0 0 auto; font-size: 13px; opacity: 0.8; }
  .breadcrumb-seg-label {
    min-width: 0;
    max-width: 140px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .breadcrumb-seg-chevron { flex: 0 0 auto; font-size: 11px; opacity: 0.6; }
  .breadcrumb-sep {
    color: var(--jb-desc-foreground);
    font-size: 11px;
    flex: 0 0 auto;
    user-select: none;
  }
  .tab-bar-right { display: flex; align-items: center; gap: 2px; margin-left: auto; flex-shrink: 0; }

  .tab {
    flex: 0 0 auto;
    padding: 4px 6px;
    border: none;
    background: transparent;
    color: var(--jb-foreground);
    cursor: pointer;
    border-radius: 3px;
    min-width: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .tab.tab-icon { }
  .tab:hover { background: var(--jb-hover-bg); }
  .tab.active { background: var(--jb-active-bg); color: var(--jb-foreground); }

  .dropdown-menu {
    position: absolute;
    z-index: 10;
    min-width: 160px;
    max-width: 280px;
    background: var(--jb-menu-bg);
    color: var(--jb-menu-fg);
    border: 1px solid var(--jb-menu-border);
    box-shadow: 0 2px 8px var(--jb-shadow);
    padding: 4px 0;
    border-radius: 3px;
    display: flex;
    flex-direction: column;
    max-height: 50vh;
  }
  .dropdown-search {
    flex: 0 0 auto;
    padding: 4px 6px;
    border-bottom: 1px solid var(--jb-border);
  }
  .dropdown-search input {
    width: 100%;
    padding: 3px 6px;
    font-size: 12px;
    font-family: inherit;
    color: var(--jb-input-fg);
    background: var(--jb-input-bg);
    border: 1px solid var(--jb-border);
    border-radius: 2px;
    outline: none;
  }
  .dropdown-search input:focus {
    border-color: var(--jb-focus-border);
  }
  .dropdown-list {
    flex: 1 1 auto;
    overflow-y: auto;
    min-height: 0;
  }
  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    cursor: pointer;
    font-size: 12px;
    white-space: nowrap;
  }
  .dropdown-item:hover { background: var(--jb-selection-bg); }
  .dropdown-item .dropdown-item-check { width: 14px; flex: 0 0 14px; font-size: 12px; }
  .dropdown-item.current,
  .dropdown-item.workspace { font-weight: 600; }
  .dropdown-item.workspace + .dropdown-item {
    border-top: 1px solid var(--jb-border);
    margin-top: 2px;
    padding-top: 4px;
  }
  .dropdown-empty {
    padding: 6px 10px;
    font-size: 12px;
    color: var(--jb-desc-foreground);
    font-style: italic;
  }

  .status-icon-ok { color: var(--jb-icon-passed); }
  .status-icon-warn { color: var(--jb-icon-queued); }
  .status-icon-error { color: var(--jb-icon-failed); }

  .sidebar-root.foreign-readonly .collapsible-section[data-section="plans"],
  .sidebar-root.foreign-readonly .collapsible-section[data-section="changes"] {
    display: none;
  }
  .sidebar-root.foreign-readonly .collapsible-section[data-section="commits"] input[type="checkbox"][data-checkbox-kind="commit"] {
    visibility: hidden;
  }

  .tab-toolbar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--jb-border);
    flex-shrink: 0;
  }
  .toolbar-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--jb-desc-foreground);
    cursor: pointer;
    padding: 0;
    font-size: 14px;
  }
  .toolbar-icon-btn:hover {
    background: var(--jb-hover-bg);
    color: var(--jb-foreground);
  }
  .toolbar-icon-btn.active {
    color: var(--jb-foreground);
    background: var(--jb-hover-bg);
  }
  .kb-search-box {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    margin-right: 4px;
    display: flex;
    align-items: center;
  }
  .kb-search-box .kb-search-icon {
    position: absolute;
    left: 6px;
    pointer-events: none;
    color: var(--jb-desc-foreground);
    font-size: 13px;
  }
  .kb-search-box input {
    flex: 1 1 auto;
    width: 100%;
    padding: 3px 6px 3px 22px;
    background: var(--jb-input-bg);
    color: var(--jb-input-fg);
    border: 1px solid var(--jb-border);
    font-size: 12px;
    height: 22px;
    line-height: 1;
  }
  .kb-search-box input:focus {
    outline: 1px solid var(--jb-focus-border);
    outline-offset: -1px;
  }
  .toolbar-worker-status {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--jb-desc-foreground);
    font-size: 12px;
    padding-left: 2px;
  }
  .toolbar-worker-status-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .iconbtn {
    width: 24px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    color: var(--jb-foreground);
    cursor: pointer;
    font-size: 14px;
  }
  .iconbtn:hover {
    background: var(--jb-hover-bg);
  }
  .iconbtn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .iconbtn:disabled:hover {
    background: transparent;
  }
  .iconbtn.toggled {
    background: var(--jb-active-bg);
    color: var(--jb-foreground);
    border-color: transparent;
  }

  .tab-content {
    flex: 1;
    overflow: auto;
    overflow-x: hidden;
  }
  .placeholder { padding: 16px; color: var(--jb-desc-foreground); font-style: italic; }
  .empty-state {
    padding: 24px 16px;
    text-align: center;
    color: var(--jb-desc-foreground);
    line-height: 1.5;
  }

  .collapsible-section { display: flex; flex-direction: column; }
  .collapsible-section .section-header {
    display: flex;
    align-items: center;
    background: transparent;
    color: var(--jb-foreground);
    padding: 4px 8px;
    font-size: 11px;
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.5px;
    cursor: pointer;
    user-select: none;
    border-top: 1px solid var(--jb-border);
    border-bottom: 1px solid var(--jb-border);
  }
  .collapsible-section .section-header .twirl {
    width: 12px;
    transition: transform 0.1s;
  }
  .collapsible-section.collapsed .section-header .twirl { transform: rotate(-90deg); }
  .collapsible-section .section-title { flex: 1; }
  .collapsible-section .section-actions {
    display: inline-flex;
    gap: 2px;
    margin-left: 8px;
    visibility: hidden;
  }
  .collapsible-section .section-header:hover .section-actions { visibility: visible; }
  .collapsible-section.collapsed .section-body { display: none; }

  .collapsible-section[data-section="changes"] .section-body {
    padding-bottom: 12px;
    border-bottom: 1px solid var(--jb-widget-border);
  }

  .commit-memory-action {
    margin: 12px 0 0 0;
    padding: 0 8px 12px 8px;
    display: flex;
    justify-content: flex-end;
  }
  .commit-memory-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    background: var(--jb-btn-bg);
    color: var(--jb-btn-fg);
    border: 1px solid transparent;
    border-radius: 3px;
    font-size: 13px;
    cursor: pointer;
  }
  .commit-memory-btn:hover {
    background: var(--jb-btn-hover-bg);
  }
  .commit-memory-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .commit-memory-btn:disabled:hover {
    background: var(--jb-btn-bg);
  }
  .commit-memory-btn .codicon {
    font-size: 14px;
  }

  .tree-node {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    padding-left: 8px;
    cursor: pointer;
    white-space: nowrap;
    user-select: none;
  }
  .tree-node[data-indent="1"] { padding-left: 28px; }
  .tree-node[data-indent="2"] { padding-left: 48px; }
  .tree-node[data-indent="3"] { padding-left: 68px; }
  .tree-node[data-indent="4"] { padding-left: 88px; }
  .tree-node[data-indent="5"] { padding-left: 108px; }
  .tree-node[data-indent="6"] { padding-left: 128px; }
  .tree-node[data-indent="7"] { padding-left: 148px; }
  .tree-node[data-indent="8"] { padding-left: 168px; }
  .tree-node[data-kind] {
    padding-top: 6px;
    padding-bottom: 6px;
  }
  .tree-node:hover { background: var(--jb-selection-bg); }
  .tree-node.selected { background: var(--jb-selection-bg); color: var(--jb-foreground); }
  .tree-node .twirl {
    width: 12px;
    flex-shrink: 0;
    color: var(--jb-foreground);
    transition: transform 0.1s;
  }
  .tree-node.expanded > .twirl { transform: rotate(90deg); }
  .tree-node .commit-twirl {
    width: 12px;
    flex-shrink: 0;
    cursor: pointer;
    color: var(--jb-foreground);
    font-size: 12px;
    line-height: 1;
  }
  .tree-node .icon { width: 16px; flex-shrink: 0; text-align: center; }
  .tree-node .icon .codicon { font-size: 14px; line-height: 1; }
  .tree-node .icon.kb-icon-memory .codicon { color: var(--jb-charts-blue); }
  .tree-node .icon.kb-icon-plan   .codicon { color: var(--jb-charts-green); }
  .tree-node .icon.kb-icon-note   .codicon { color: var(--jb-charts-orange); }
  .tree-node[data-kind="repo"] > .label {
    font-weight: 600;
  }
  .tree-node.current-repo-node {
    border-left: 2px solid var(--jb-focus-border);
    padding-left: 6px;
  }
  .tree-node.current-repo-node > .label::after {
    content: " (current)";
    color: var(--jb-desc-foreground);
    font-weight: 400;
  }
  .tree-node .label { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .tree-node[data-context="commitFile"] .label,
  .tree-node.tree-node--changes .label {
    flex: 0 1 auto;
    min-width: 0;
    max-width: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tree-node[data-context="commitFile"] .desc,
  .tree-node.tree-node--changes .desc {
    flex: 0 9999 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tree-node .kb-tag {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    margin-left: 4px;
    border-radius: 3px;
    font-size: 9px;
    font-weight: 600;
    line-height: 1;
    flex-shrink: 0;
    color: #ffffff;
  }
  .tree-node .kb-tag-plan { background: var(--jb-charts-green); }
  .tree-node .kb-tag-note { background: var(--jb-charts-orange); }
  .tree-node .desc {
    color: var(--jb-desc-foreground);
    font-size: 11px;
    margin-left: 4px;
    flex-shrink: 0;
  }
  .tree-node .inline-actions { display: inline-flex; gap: 2px; flex-shrink: 0; }
  .tree-node.tree-node--changes .inline-actions {
    visibility: hidden;
    margin-left: auto;
  }
  .tree-node.tree-node--changes:hover .inline-actions { visibility: visible; }
  .tree-node.tree-node--changes .gs-letter { margin-left: 0; }

  .memory-row {
    padding: 6px 12px;
    border-bottom: 1px solid var(--jb-border);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .memory-row:hover { background: var(--jb-selection-bg); }
  .memory-row-icon { width: 16px; flex-shrink: 0; text-align: center; }
  .memory-row-icon .codicon { font-size: 14px; line-height: 1; }
  .memory-row-icon.kb-icon-memory .codicon { color: var(--jb-charts-blue); }
  .memory-row-main { flex: 1; min-width: 0; }
  .memory-row .title {
    color: var(--jb-foreground);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-bottom: 2px;
  }
  .memory-row .meta { color: var(--jb-desc-foreground); font-size: 10px; }
  .memory-row .meta .hash { font-family: var(--jb-editor-font); }
  .memory-row .inline-actions { display: inline-flex; gap: 2px; flex-shrink: 0; visibility: hidden; }
  .memory-row:hover .inline-actions { visibility: visible; }

  .text-tip {
    position: fixed;
    z-index: 1100;
    width: max-content;
    max-width: 320px;
    padding: 4px 8px;
    background: var(--jb-widget-bg);
    color: var(--jb-foreground);
    border: 1px solid var(--jb-border);
    border-radius: 2px;
    box-shadow: 0 2px 8px var(--jb-shadow);
    font-size: 12px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
    pointer-events: none;
  }

  .hover-card {
    position: fixed;
    z-index: 1000;
    max-width: 480px;
    min-width: 280px;
    padding: 8px 12px;
    background: var(--jb-widget-bg);
    color: var(--jb-foreground);
    border: 1px solid var(--jb-border);
    border-radius: 3px;
    box-shadow: 0 2px 8px var(--jb-shadow);
    font-size: 12px;
    line-height: 1.5;
    pointer-events: auto;
  }
  .hover-card .hc-title {
    font-weight: 600;
    color: var(--jb-foreground);
    margin-bottom: 6px;
    word-break: break-word;
  }
  .hover-card .hc-row { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
  .hover-card .hc-row .codicon { color: var(--jb-foreground); flex-shrink: 0; }
  .hover-card hr {
    border: none;
    border-top: 1px solid var(--jb-border);
    margin: 6px 0;
  }
  .hover-card .hc-stats {
    color: var(--jb-desc-foreground);
    font-size: 11px;
  }
  .hover-card .hc-actions { display: flex; gap: 12px; align-items: center; }
  .hover-card .hc-link {
    color: var(--jb-link-foreground);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    user-select: none;
  }
  .hover-card .hc-link:hover { text-decoration: underline; }
  .hover-card .hc-hash {
    font-family: var(--jb-editor-font);
  }
  .hover-card .hc-sep { color: var(--jb-desc-foreground); }

  .status-entry {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    min-width: 0;
  }
  .status-entry:hover { background: var(--jb-selection-bg); cursor: pointer; }
  .status-entry .label {
    flex-shrink: 0;
    white-space: nowrap;
  }
  .status-entry .desc {
    color: var(--jb-desc-foreground);
    flex: 1 1 auto;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .codicon.icon-color-green  { color: var(--jb-icon-passed); }
  .codicon.icon-color-red    { color: var(--jb-icon-failed); }
  .codicon.icon-color-yellow { color: var(--jb-icon-queued); }

  .context-menu {
    position: fixed;
    background: var(--jb-menu-bg);
    color: var(--jb-menu-fg);
    border: 1px solid var(--jb-menu-border);
    box-shadow: 0 2px 8px var(--jb-shadow);
    padding: 2px 0;
    z-index: 100;
    min-width: 160px;
    font-size: 12px;
  }
  .context-menu .menu-item {
    padding: 4px 16px;
    cursor: pointer;
    white-space: nowrap;
  }
  .context-menu .menu-item:hover {
    background: var(--jb-selection-bg);
  }
  .context-menu .menu-separator {
    height: 1px;
    background: var(--jb-border);
    margin: 2px 0;
  }

  .row-leading {
    width: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .row-leading input[type="checkbox"] {
    margin: 0;
    cursor: pointer;
  }
  .gs-M { color: var(--jb-git-mod); }
  .gs-A { color: var(--jb-git-add); }
  .gs-D { color: var(--jb-git-del); }
  .gs-U { color: var(--jb-git-untracked); }
  .gs-R { color: var(--jb-git-renamed); }
  .gs-C { color: var(--jb-git-conflict); }
  .gs-I { color: var(--jb-git-ignored); }
  .tree-node .gs-letter {
    margin-left: auto;
    padding-left: 4px;
    font-size: 11px;
    flex-shrink: 0;
  }

  .loading-panel {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 16px;
    height: 100%;
    box-sizing: border-box;
    color: var(--jb-desc-foreground);
  }
  .loading-icon { font-size: 20px; }
  .loading-text { font-size: 12px; }

  /* KB Memories search + load-more */
  .kb-memories-search-wrap {
    padding: 6px 8px;
    border-bottom: 1px solid var(--jb-border);
  }
  .kb-memories-search {
    width: 100%;
    padding: 3px 6px;
    font-size: 12px;
    font-family: inherit;
    color: var(--jb-input-fg);
    background: var(--jb-input-bg);
    border: 1px solid var(--jb-border);
    border-radius: 2px;
    outline: none;
    box-sizing: border-box;
  }
  .kb-memories-search:focus {
    border-color: var(--jb-focus-border);
  }
  .kb-memories-load-more {
    margin: 8px auto;
    display: block;
    padding: 4px 12px;
    font-size: 12px;
    font-family: inherit;
    color: var(--jb-link-foreground);
    background: transparent;
    border: 1px solid var(--jb-border);
    border-radius: 2px;
    cursor: pointer;
  }
  .kb-memories-load-more:hover {
    background: var(--jb-hover-bg);
  }

  /* Foreign read-only mode: defense-in-depth — hide write-action surfaces
     in case any slip through future refactors. JS already drops Plans /
     Changes sections entirely when foreign; this only catches stragglers. */
  .foreign-readonly [data-inline="discard"],
  .foreign-readonly [data-inline="edit"],
  .foreign-readonly [data-inline="remove"],
  .foreign-readonly [data-action="changes-discard"],
  .foreign-readonly [data-action="changes-commit-ai"],
  .foreign-readonly [data-action="commits-squash"],
  .foreign-readonly [data-action="commits-push-branch"],
  .foreign-readonly [data-action="plans-add-menu"] {
    display: none !important;
  }

"""

	private fun colorHex(c: Color): String {
		return String.format("#%02x%02x%02x", c.red, c.green, c.blue)
	}
}
