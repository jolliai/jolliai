/**
 * SidebarHtmlBuilder
 *
 * Builds the static HTML skeleton for the sidebar webview. The skeleton has:
 *   - 2 labeled tab buttons (branch / Memory Bank) + a right-side icon area
 *     holding a status indicator icon (settings moved into the Status tab toolbar)
 *   - 3 tab content panels (one shown at a time, the others have the `.hidden` class)
 *   - A disabled-state intro rendered inside the Status panel itself (replaces
 *     the entries area when state.enabled === false). In disabled mode the tab
 *     bar and per-tab toolbar are hidden — only the Status panel is visible,
 *     showing the intro + Enable button instead of "No status to display".
 *
 * Visibility convention: every togglable element here uses the `.hidden` class
 * (defined in SidebarCssBuilder as `display: none !important`). We avoid the
 * HTML `hidden` attribute because UA-stylesheet `display: none` loses to
 * author rules like `display: flex` on `.tab-bar` / `.tab-toolbar`, which
 * silently breaks the toggle. Class-based hiding has consistent specificity.
 *
 * All dynamic content is rendered by SidebarScriptBuilder via DOM API.
 * The skeleton contains no user-supplied data.
 */

import { buildSidebarCss } from "./SidebarCssBuilder.js";
import type { SidebarEmptyStrings } from "./SidebarEmptyMessages.js";
import { buildSidebarScript } from "./SidebarScriptBuilder.js";

export function buildSidebarHtml(
	nonce: string,
	cspSource: string,
	codiconCssUri: string,
	strings: SidebarEmptyStrings,
): string {
	const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; font-src ${cspSource}; script-src 'nonce-${nonce}';" />`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${csp}
  <title>Jolli Memory</title>
  <link rel="stylesheet" href="${codiconCssUri}" />
  <style nonce="${nonce}">${buildSidebarCss()}</style>
</head>
<body>
  <div class="sidebar-root" id="sidebar-root">
    <div class="tab-bar" id="tab-bar" role="tablist">
      <button class="tab active" type="button" data-tab="branch" role="tab" id="tab-button-branch"><i class="codicon codicon-git-branch tab-icon-leading" aria-hidden="true"></i><span class="tab-label">(loading)</span></button>
      <button class="tab" type="button" data-tab="kb" role="tab" id="tab-button-kb"><i class="codicon codicon-book tab-icon-leading" aria-hidden="true"></i><span class="tab-label">Memory Bank</span></button>
      <div class="tab-bar-right">
        <button class="tab tab-icon" type="button" data-tab="status" id="status-icon-btn" title="Status">
          <i class="codicon codicon-circle-filled"></i>
        </button>
      </div>
    </div>
    <div class="tab-toolbar hidden" id="tab-toolbar"></div>
    <div class="tab-content hidden" id="tab-content-kb"><p class="placeholder">Loading...</p></div>
    <div class="tab-content" id="tab-content-branch"><p class="placeholder">Loading...</p></div>
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
  <script nonce="${nonce}" type="application/json" id="empty-strings">${JSON.stringify(strings)}</script>
  <script nonce="${nonce}">${buildSidebarScript()}</script>
</body>
</html>`;
}
