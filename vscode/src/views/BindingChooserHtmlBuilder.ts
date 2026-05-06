/**
 * BindingChooserHtmlBuilder
 *
 * Assembles the HTML document for the BindingChooserWebviewPanel.
 * Mirrors the SettingsHtmlBuilder structure: CSP nonce, embedded CSS,
 * static markup, embedded script.
 */

import { buildBindingChooserCss } from "./BindingChooserCssBuilder.js";
import { buildBindingChooserScript } from "./BindingChooserScriptBuilder.js";

export function buildBindingChooserHtml(nonce: string): string {
	const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${csp}
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Save this repo's memory</title>
  <style nonce="${nonce}">${buildBindingChooserCss()}</style>
</head>
<body>
  <div class="chooser-page">
    <h1>Choose a Memory space</h1>
    <p class="subtitle">Bind this repo to an existing space. Create or manage spaces on jolli.ai.</p>

    <div class="repo-meta">
      <span class="repo-label">Repo</span>
      <span class="repo-url" id="repoUrlDisplay"></span>
      <div class="repo-hint hidden" id="repoHint"></div>
    </div>

    <div id="banner" class="banner hidden" role="status">
      <div id="bannerText"></div>
      <div class="banner-actions">
        <button type="button" class="btn-primary" id="bannerOkBtn">OK, push now</button>
      </div>
    </div>

    <section class="mode-pane" id="paneExisting">
      <div class="spaces-list" id="spacesList">
        <div class="spaces-loading">Loading…</div>
      </div>
      <div class="error-message" id="existing-error"></div>
    </section>

    <div class="error-message general-error" id="generalError"></div>
  </div>

  <div class="action-bar" id="actionBar">
    <button type="button" class="btn-secondary" id="cancelBtn">Cancel</button>
    <button type="button" class="btn-primary" id="confirmBtn">Bind and push</button>
  </div>

  <script nonce="${nonce}">${buildBindingChooserScript()}</script>
</body>
</html>`;
}
