package ai.jolli.jollimemory.toolwindow.sidebar

/**
 * Builds the static HTML skeleton for the JCEF sidebar webview.
 *
 * Port of VS Code's SidebarHtmlBuilder.ts. The skeleton contains no user data;
 * all dynamic content is rendered by SidebarScriptBuilder's JS via DOM API.
 *
 * The [bridgeScript] parameter is the `window.__jbQuery = ...` snippet generated
 * by JBCefJSQuery — it must be injected before the main script so the bridge
 * is available immediately.
 *
 * [codiconCssInline] is the full text of codicon.css with its @font-face url
 * rewritten to a data: URI (since JCEF loadHTML has no base URL for relative paths).
 */
object SidebarHtmlBuilder {

	fun buildHtml(
		themeVars: String,
		css: String,
		codiconCss: String,
		bridgeScript: String,
		mainScript: String,
	): String {
		val emptyStrings = """{"noMemories":"No memories yet","noPlans":"No plans or notes","noChanges":"No changes","noCommits":"No commits on this branch"}"""

		return """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Jolli Memory</title>
  <style>$codiconCss</style>
  <style>$themeVars
$css</style>
</head>
<body>
  <div class="sidebar-root" id="sidebar-root">
    <div class="loading-panel" id="loading-panel" role="status" aria-live="polite">
      <i class="codicon codicon-loading codicon-modifier-spin loading-icon" aria-hidden="true"></i>
      <span class="loading-text">Loading...</span>
    </div>
    <div class="tab-bar hidden" id="tab-bar" role="toolbar" aria-label="Jolli Memory header">
      <div class="breadcrumb" id="breadcrumb">
        <button class="breadcrumb-seg" type="button" id="breadcrumb-repo-btn" aria-haspopup="menu" aria-expanded="false">
          <i class="codicon codicon-repo breadcrumb-seg-icon" aria-hidden="true"></i>
          <span class="breadcrumb-seg-label" id="breadcrumb-repo-label">(repo)</span>
          <i class="codicon codicon-chevron-down breadcrumb-seg-chevron hidden" aria-hidden="true"></i>
        </button>
        <span class="breadcrumb-sep" aria-hidden="true">/</span>
        <button class="breadcrumb-seg" type="button" id="breadcrumb-branch-btn" aria-haspopup="menu" aria-expanded="false">
          <i class="codicon codicon-git-branch breadcrumb-seg-icon" aria-hidden="true"></i>
          <span class="breadcrumb-seg-label" id="breadcrumb-branch-label">(loading)</span>
          <i class="codicon codicon-chevron-down breadcrumb-seg-chevron hidden" aria-hidden="true"></i>
        </button>
      </div>
      <div class="tab-bar-right">
        <button class="tab tab-icon" type="button" data-tab="kb" id="kb-icon-btn" aria-label="Memory Bank">
          <i class="codicon codicon-book" aria-hidden="true"></i>
        </button>
        <button class="tab tab-icon" type="button" data-action="open-settings" id="settings-icon-btn" aria-label="Settings">
          <i class="codicon codicon-gear" aria-hidden="true"></i>
        </button>
        <button class="tab tab-icon" type="button" data-tab="status" id="status-icon-btn" aria-label="Status">
          <i class="codicon codicon-circle-filled"></i>
        </button>
      </div>
    </div>
    <div class="dropdown-menu hidden" id="breadcrumb-menu" role="menu"></div>
    <div class="tab-toolbar hidden" id="tab-toolbar"></div>
    <div class="tab-content hidden" id="tab-content-kb"><p class="placeholder">Loading...</p></div>
    <div class="tab-content hidden" id="tab-content-branch"><p class="placeholder">Loading...</p></div>
    <div class="tab-content hidden" id="tab-content-status">
      <div class="disabled-banner hidden" id="disabled-banner">
        <p class="disabled-intro">Capture searchable memories from your AI coding sessions and weave them into your git history. Each commit gets an AI-generated summary you can recall later.</p>
        <button type="button" id="enable-btn" class="enable-btn">Enable Jolli Memory</button>
      </div>
      <div class="status-entries" id="status-entries"><p class="placeholder">Loading...</p></div>
    </div>
    <div class="context-menu hidden" id="context-menu"></div>
    <div class="hover-card hidden" id="memory-hover" role="tooltip"></div>
    <div class="text-tip hidden" id="text-tip" role="tooltip"></div>
  </div>
  <script type="application/json" id="empty-strings">$emptyStrings</script>
  <script>$bridgeScript</script>
  <script>$mainScript</script>
</body>
</html>"""
	}
}
