/**
 * SettingsHtmlBuilder
 *
 * Assembles the complete HTML document for the Settings webview as a 5-tab
 * layout that mirrors the IntelliJ plugin (with "Sort Order" and "Pause"
 * intentionally omitted from this surface):
 *
 *   1. AI Agents     — per-source toggles (Claude / Codex / Gemini /
 *                      OpenCode / Cursor / Copilot)
 *   2. AI Summary    — Provider dropdown + Anthropic card (key/model/maxTokens)
 *                      or Jolli card (signed-in / no-key / signed-out)
 *   3. Sync to Jolli — sign-in or signed-in state for cloud push
 *   4. Memory Bank   — local folder + Migrate button
 *   5. Others        — exclude patterns
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

    <nav class="tab-nav" role="tablist">
      <button type="button" class="tab-button tab-active" role="tab" data-tab="agents">AI Agents</button>
      <button type="button" class="tab-button" role="tab" data-tab="summary">AI Summary</button>
      <button type="button" class="tab-button" role="tab" data-tab="sync">Sync to Jolli</button>
      <button type="button" class="tab-button" role="tab" data-tab="bank">Memory Bank</button>
      <button type="button" class="tab-button" role="tab" data-tab="others">Others</button>
    </nav>

    <!-- ── Tab 1: AI Agents ── -->
    <section class="tab-panel" data-panel="agents" role="tabpanel">
      <p class="section-hint">Choose which AI agents to track.</p>
      ${buildToggleRow("claudeEnabled", "Claude Code", "Session tracking via Stop hook")}
      ${buildToggleRow("codexEnabled", "Codex CLI", "Session discovery via filesystem scan")}
      ${buildToggleRow("geminiEnabled", "Gemini CLI", "Session tracking via AfterAgent hook")}
      ${buildToggleRow("openCodeEnabled", "OpenCode", "Session discovery via ~/.local/share/opencode/opencode.db")}
      ${buildToggleRow("cursorEnabled", "Cursor", "Session discovery via Cursor's local SQLite store")}
      ${buildToggleRow("copilotEnabled", "Copilot", "Session discovery for GitHub Copilot CLI (~/.copilot/session-store.db) and VS Code Copilot Chat (workspace storage)")}
      <div class="error-message" id="integrations-error"></div>
    </section>

    <!-- ── Tab 2: AI Summary ── -->
    <section class="tab-panel hidden" data-panel="summary" role="tabpanel">
      <div class="settings-row">
        <label class="settings-label" for="aiProvider">Provider</label>
        <select id="aiProvider">
          <option value="anthropic">Anthropic</option>
          <option value="jolli">Jolli</option>
        </select>
      </div>
      <p class="section-hint">Choose how AI summaries are generated for each commit.</p>

      <!-- Provider cards: only one visible at a time, gated by aiProvider + signedIn + hasJolliKey -->
      <div class="card-panel" data-card="anthropic">
        <div class="status-warn hidden" id="anthropicMissingWarn">
          <span class="status-icon">⚠</span> API key is empty. AI summaries won't work without it.
        </div>
        <p class="section-hint">Calls go directly to Anthropic.</p>
        <div class="settings-row">
          <label class="settings-label" for="apiKey">
            API Key
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
            Max Output Tokens
            <span class="hint">Default: 8192</span>
          </label>
          <div class="input-col">
            <input type="number" id="maxTokens" placeholder="8192" min="1" step="1" />
            <div class="error-message" id="maxTokens-error"></div>
          </div>
        </div>
      </div>

      <div class="card-panel hidden" data-card="jolli-ok">
        <div class="status-ok"><span class="status-icon">✓</span> <span id="jolliSiteLabel">Using Jolli to generate summaries</span></div>
        <button type="button" class="link-btn advanced-link" data-advanced="summary">Advanced</button>
        <div class="advanced-panel hidden" data-advanced-panel="summary">
          <div class="settings-row">
            <label class="settings-label" for="jolliApiKey">
              Jolli API Key
              <span class="hint">sk-jol-… — auto-filled on sign-in, or paste a new one</span>
            </label>
            <div class="input-col">
              <input type="text" id="jolliApiKey" placeholder="sk-jol-..." autocomplete="off" spellcheck="false" />
              <div class="error-message" id="jolliApiKey-error"></div>
            </div>
          </div>
        </div>
      </div>

      <div class="card-panel hidden" data-card="jolli-nokey">
        <div class="status-warn">
          <span class="status-icon">⚠</span> Signed in but Jolli API Key is missing.<br/>
          Re-login to get the key automatically, or enter it manually below.
        </div>
        <button type="button" class="browse-btn" id="summaryReLoginBtn">Sign Out &amp; Re-login</button>
        <button type="button" class="link-btn advanced-link" data-advanced="summary-nokey">Advanced</button>
        <div class="advanced-panel hidden" data-advanced-panel="summary-nokey">
          <div class="settings-row">
            <label class="settings-label" for="jolliApiKeyNoKey">
              Jolli API Key
              <span class="hint">sk-jol-…</span>
            </label>
            <div class="input-col">
              <input type="text" id="jolliApiKeyNoKey" placeholder="sk-jol-..." autocomplete="off" spellcheck="false" />
              <div class="error-message" id="jolliApiKeyNoKey-error"></div>
            </div>
          </div>
        </div>
      </div>

      <div class="card-panel hidden" data-card="jolli-signin">
        <p class="section-hint">Sign in to use Jolli for AI summarization.</p>
        <button type="button" class="primary-btn" id="summarySignInBtn">Sign In to Jolli</button>
      </div>
    </section>

    <!-- ── Tab 3: Sync to Jolli ── -->
    <section class="tab-panel hidden" data-panel="sync" role="tabpanel">
      <div class="card-panel" data-sync-card="signed-out">
        <p class="section-hint">Sign in to push memories to Jolli cloud.</p>
        <button type="button" class="primary-btn" id="syncSignInBtn">Sign In to Jolli</button>
      </div>
      <div class="card-panel hidden" data-sync-card="signed-in">
        <div class="status-ok"><span class="status-icon">✓</span> Signed in — ready to push memories</div>
        <button type="button" class="browse-btn" id="syncSignOutBtn">Sign Out</button>
      </div>
    </section>

    <!-- ── Tab 4: Memory Bank ── -->
    <section class="tab-panel hidden" data-panel="bank" role="tabpanel">
      <div class="settings-row column">
        <label class="settings-label" for="localFolder">
          Folder Path
          <span class="hint">Root directory of the Memory Bank on disk. Each repo gets its own subfolder.</span>
        </label>
        <div class="browse-row">
          <input type="text" id="localFolder" readonly placeholder="No folder selected" spellcheck="false" />
          <button type="button" class="browse-btn" id="browseLocalFolderBtn">Browse…</button>
        </div>
      </div>

      <div class="settings-row column rebuild-row">
        <button type="button" class="browse-btn rebuild-btn" id="rebuildKbBtn">Migrate to Memory Bank</button>
        <div class="hint rebuild-hint">Re-migrate this repo from the orphan branch into a fresh Memory Bank folder. The existing folder is preserved (a new <code>-2</code>-suffixed folder is created and the repo registry is repointed).</div>
        <div class="hint" id="rebuildKbStatus"></div>
      </div>

      <!-- ── Cloud sync to Personal Space ───────────────────────────────── -->
      <hr class="settings-divider" />

      <div class="settings-row column">
        <button type="button" class="browse-btn rebuild-btn" id="syncNowBtn">Sync to Personal Space Now</button>
        <span class="hint">Push this Memory Bank to your <strong>private</strong> Personal Space. Requires Jolli sign-in.</span>
      </div>

      <div class="settings-row column" id="syncAutoGroup">
        <label class="settings-toggle">
          <input type="checkbox" id="autoSyncEnabled" />
          Auto-sync to Personal Space
        </label>
        <div id="syncAutoIntervalGroup">
          <label class="settings-label" for="syncPollIntervalMin">Every (minutes)</label>
          <input
            type="number"
            id="syncPollIntervalMin"
            min="90"
            max="1440"
            step="1"
            inputmode="numeric"
            placeholder="90"
          />
          <span class="hint">90–1440 minutes (default 90). Lower values clamp to 90.</span>
        </div>
      </div>

      <div class="settings-row column">
        <label class="settings-toggle">
          <input type="checkbox" id="syncTranscripts" />
          Include transcripts (raw AI conversation logs)
        </label>
        <span class="hint">Off by default. Transcripts may include pasted code, tokens, or sensitive snippets. Applies to both manual and auto-sync.</span>
      </div>

      <div class="settings-row column">
        <div class="warning-banner" role="note">
          ⚠ If <code>localFolder</code> is also synced by iCloud / Dropbox / Syncthing, turn Jolli sync off — pick one sync channel per device.
        </div>
      </div>
    </section>

    <!-- ── Tab 5: Others ── -->
    <section class="tab-panel hidden" data-panel="others" role="tabpanel">
      <div class="toggle-row">
        <label class="settings-label" for="dcoSignoff">
          Sign commits with DCO
          <span class="hint">Adds a <code>Signed-off-by</code> trailer (<code>git commit -s</code>) to commits made by Jolli Memory (commit / amend / squash). Required by many open-source projects' CI.</span>
        </label>
        <label class="toggle-switch">
          <input type="checkbox" id="dcoSignoff" />
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div class="settings-row column">
        <label class="settings-label" for="excludePatterns">
          Exclude Patterns
          <span class="hint">Hide files from the Changes panel and AI commits. Comma-separated globs, e.g. <code>**/*.vsix</code>, <code>dist/**</code>, <code>node_modules/*</code>.</span>
        </label>
        <input type="text" id="excludePatterns" placeholder="**/*.vsix, docs/*.md" spellcheck="false" />
      </div>
    </section>
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
