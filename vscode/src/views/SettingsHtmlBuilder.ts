/**
 * SettingsHtmlBuilder
 *
 * Assembles the complete HTML document for the Settings webview.
 * Combines CSS, form sections (AI config, integrations, files),
 * action bar, and interactive script into a single HTML string.
 */

import { buildSettingsCss } from "./SettingsCssBuilder.js";
import { buildSettingsScript } from "./SettingsScriptBuilder.js";

/**
 * Builds the full HTML document for the Settings webview.
 * @param nonce - CSP nonce for inline styles and scripts
 */
export function buildSettingsHtml(nonce: string): string {
	const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${csp}
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Jolli Memory Settings</title>
  <style nonce="${nonce}">${buildSettingsCss()}</style>
</head>
<body>
  <div class="settings-page">
    <h1>Jolli Memory Settings</h1>

    <!-- AI Configuration -->
    <div class="settings-group">
      <h2>AI Configuration</h2>

      <div class="settings-row">
        <label class="settings-label" for="apiKey">
          Anthropic API Key
          <span class="hint">Stored in ~/.jolli/jollimemory/config.json</span>
        </label>
        <div class="input-col">
          <input type="text" id="apiKey" placeholder="sk-ant-..." autocomplete="off" spellcheck="false" />
          <div class="error-message" id="apiKey-error"></div>
        </div>
      </div>

      <div class="settings-row">
        <label class="settings-label" for="model">Model</label>
        <select id="model">
          <option value="haiku">Haiku — fastest</option>
          <option value="sonnet" selected>Sonnet — balanced (default)</option>
          <option value="opus">Opus — most capable</option>
        </select>
      </div>

      <div class="settings-row">
        <label class="settings-label" for="maxTokens">
          Max Tokens
          <span class="hint">Default: 8192</span>
        </label>
        <div class="input-col">
          <input type="number" id="maxTokens" placeholder="8192" min="1" step="1" />
          <div class="error-message" id="maxTokens-error"></div>
        </div>
      </div>
    </div>

    <!-- Integrations -->
    <div class="settings-group">
      <h2>Integrations</h2>

      <div class="settings-row">
        <label class="settings-label" for="jolliApiKey">
          Jolli API Key
          <span class="hint">sk-jol-...</span>
        </label>
        <div class="input-col">
          <input type="text" id="jolliApiKey" placeholder="sk-jol-..." autocomplete="off" spellcheck="false" />
          <div class="error-message" id="jolliApiKey-error"></div>
        </div>
      </div>

      ${buildToggleRow("claudeEnabled", "Claude Code", "Session tracking via Stop hook")}
      ${buildToggleRow("codexEnabled", "Codex CLI", "Session discovery via filesystem scan")}
      ${buildToggleRow("geminiEnabled", "Gemini CLI", "Session tracking via AfterAgent hook")}
      ${buildToggleRow("openCodeEnabled", "OpenCode", "Session discovery via ~/.local/share/opencode/opencode.db")}
      ${buildToggleRow("cursorEnabled", "Cursor", "Session discovery via Cursor's local SQLite store")}
      <div class="error-message" id="integrations-error"></div>
    </div>

    <!-- Local Memory Bank -->
    <div class="settings-group">
      <h2>Local Memory Bank</h2>

      <div class="settings-row">
        <label class="settings-label" for="localFolder">
          Local Folder
          <span class="hint">Root directory of the Memory Bank on disk</span>
        </label>
        <div class="browse-row">
          <input type="text" id="localFolder" readonly placeholder="No folder selected" spellcheck="false" />
          <button type="button" class="browse-btn" id="browseLocalFolderBtn">Browse\u2026</button>
        </div>
      </div>

      <div class="settings-row column rebuild-row">
        <button type="button" class="browse-btn rebuild-btn" id="rebuildKbBtn">Migrate to Memory Bank</button>
        <div class="hint rebuild-hint">Re-migrate this repo from the orphan branch into a fresh Memory Bank folder. The existing folder is preserved (a new <code>-2</code>-suffixed folder is created and the repo registry is repointed).</div>
        <div class="hint" id="rebuildKbStatus"></div>
      </div>
    </div>

    <!-- Files -->
    <div class="settings-group">
      <h2>Files</h2>

      <div class="settings-row">
        <label class="settings-label" for="excludePatterns">
          Exclude Patterns
          <span class="hint">Comma-separated globs</span>
        </label>
        <input type="text" id="excludePatterns" placeholder="**/*.vsix, docs/*.md" spellcheck="false" />
      </div>
    </div>
  </div>

  <!-- Action bar -->
  <div class="action-bar">
    <span class="save-feedback" id="saveFeedback">Settings saved</span>
    <button class="apply-btn" id="applyBtn" disabled>Apply Changes</button>
  </div>

  <script nonce="${nonce}">${buildSettingsScript()}</script>
</body>
</html>`;
}

/** Renders a toggle row for a boolean setting. */
function buildToggleRow(id: string, label: string, hint: string): string {
	return `
      <div class="toggle-row">
        <label class="settings-label" for="${id}">
          ${label}
          <span class="hint">${hint}</span>
        </label>
        <label class="toggle-switch">
          <input type="checkbox" id="${id}" checked />
          <span class="toggle-slider"></span>
        </label>
      </div>`;
}
