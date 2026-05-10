/**
 * SettingsCssBuilder
 *
 * Returns the full CSS stylesheet for the Settings webview.
 * Uses VS Code CSS variables for automatic light/dark theme support.
 * Pure string template — no logic dependencies on other view modules.
 */

/** Returns the full CSS stylesheet for the Settings webview. */
export function buildSettingsCss(): string {
	return `
  /* ── Base reset ── */
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 0;
  }

  /* ── Page layout ── */
  .settings-page {
    max-width: 680px;
    margin: 0 auto;
    padding: 24px 32px 80px;
  }

  .settings-page h1 {
    font-size: 22px;
    font-weight: 600;
    margin-bottom: 16px;
    color: var(--vscode-foreground);
  }

  /* Universal display:none switch — keep all dynamic show/hide on this class
     so it always wins over display:flex / display:block on the same element. */
  .hidden { display: none !important; }

  /* ── Tab navigation ── */
  .tab-nav {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
    margin-bottom: 20px;
  }
  .tab-button {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 8px 14px;
    font-size: 13px;
    font-family: var(--vscode-font-family);
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
    margin-bottom: -1px;
  }
  .tab-button:hover {
    color: var(--vscode-foreground);
  }
  .tab-button.tab-active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder, var(--vscode-button-background));
    font-weight: 600;
  }

  .tab-panel {
    display: block;
  }
  .section-hint {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 12px;
    line-height: 1.5;
  }

  /* ── Card panels (provider/sync state cards inside a tab) ── */
  .card-panel {
    margin-bottom: 12px;
  }
  .card-panel + .card-panel {
    margin-top: 8px;
  }

  /* ── Form rows ── */
  .settings-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 14px;
  }
  .settings-row.column {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    min-width: 0;
  }
  .rebuild-btn {
    align-self: flex-start;
  }
  .rebuild-hint {
    display: block;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    white-space: normal;
    word-break: break-word;
    overflow-wrap: anywhere;
    line-height: 1.45;
  }
  .rebuild-hint code {
    white-space: normal;
    word-break: break-all;
  }
  .input-col {
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .settings-label {
    min-width: 140px;
    font-size: 13px;
    color: var(--vscode-foreground);
    flex-shrink: 0;
  }
  .settings-label .hint {
    display: block;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-top: 2px;
  }

  /* ── Inputs ── */
  input[type="text"],
  input[type="number"],
  select {
    flex: 1;
    padding: 5px 8px;
    font-size: 13px;
    font-family: var(--vscode-font-family);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 3px;
    outline: none;
    transition: border-color 0.15s;
  }
  input:focus, select:focus {
    border-color: var(--vscode-focusBorder);
  }
  input.error, select.error {
    border-color: var(--vscode-inputValidation-errorBorder, #f44);
  }
  .error-message {
    font-size: 11px;
    color: var(--vscode-errorForeground, #f44);
    margin-top: 2px;
    min-height: 14px;
  }

  select {
    cursor: pointer;
    appearance: auto;
  }

  /* ── Toggle switch ── */
  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 0;
  }
  /* In toggle rows the label is the only flexible element — let it grow
     into available space and shrink below its 140px min-width so long
     hints (e.g. the Copilot row) wrap instead of pushing the toggle off
     the right edge. */
  .toggle-row .settings-label {
    flex: 1;
    min-width: 0;
  }
  .toggle-switch {
    position: relative;
    width: 36px;
    height: 20px;
    flex-shrink: 0;
  }
  .toggle-switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }
  .toggle-slider {
    position: absolute;
    cursor: pointer;
    inset: 0;
    background: var(--vscode-input-border, rgba(128,128,128,0.4));
    border-radius: 20px;
    transition: background 0.2s;
  }
  .toggle-slider::before {
    content: "";
    position: absolute;
    height: 14px;
    width: 14px;
    left: 3px;
    bottom: 3px;
    background: var(--vscode-editor-background);
    border-radius: 50%;
    transition: transform 0.2s;
  }
  .toggle-switch input:checked + .toggle-slider {
    background: var(--vscode-button-background);
  }
  .toggle-switch input:checked + .toggle-slider::before {
    transform: translateX(16px);
  }

  /* ── Browse / secondary button ── */
  .browse-row {
    flex: 1;
    display: flex;
    gap: 6px;
  }
  .browse-row input[type="text"] {
    flex: 1;
    opacity: 0.85;
    cursor: default;
  }
  .browse-btn {
    padding: 5px 12px;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 3px;
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    white-space: nowrap;
    transition: opacity 0.15s;
  }
  .browse-btn:hover { opacity: 0.85; }

  /* ── Primary action button (Sign In etc.) ── */
  .primary-btn {
    padding: 6px 16px;
    font-size: 13px;
    font-family: var(--vscode-font-family);
    border: none;
    border-radius: 3px;
    cursor: pointer;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    transition: opacity 0.15s;
  }
  .primary-btn:hover { opacity: 0.9; }
  .primary-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Status indicators ── */
  .status-ok,
  .status-warn {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 13px;
    line-height: 1.5;
    padding: 4px 0 8px;
  }
  /* Reuse VS Code's theme tokens so high-contrast / light / dim themes stay
     coherent. Hex fallbacks match the SidebarCssBuilder status icons so the
     two webviews render identically when a theme omits the variable. */
  .status-ok { color: var(--vscode-testing-iconPassed, #89d185); }
  .status-warn { color: var(--vscode-testing-iconQueued, #cca700); }
  .status-icon { font-size: 14px; flex-shrink: 0; }

  /* ── Advanced toggle (link-style button) ── */
  .link-btn {
    background: none;
    border: none;
    padding: 4px 0;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    color: var(--vscode-textLink-foreground, var(--vscode-button-background));
    cursor: pointer;
    text-decoration: none;
  }
  .link-btn:hover { text-decoration: underline; }
  .advanced-link { display: inline-block; margin-top: 6px; }
  .advanced-panel { margin-top: 8px; }

  /* ── Action bar ── */
  .action-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 12px 32px;
    display: flex;
    justify-content: flex-end;
    background: var(--vscode-editor-background);
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
  }
  .apply-btn {
    padding: 6px 20px;
    font-size: 13px;
    font-family: var(--vscode-font-family);
    border: none;
    border-radius: 3px;
    cursor: pointer;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    transition: opacity 0.15s;
  }
  .apply-btn:hover { opacity: 0.9; }
  .apply-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .save-feedback {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    align-self: center;
    margin-right: 12px;
    opacity: 0;
    transition: opacity 0.3s;
    max-width: 480px;
  }
  .save-feedback.visible { opacity: 1; }
  .save-feedback.error {
    color: var(--vscode-errorForeground);
    font-weight: 600;
  }
  `;
}
