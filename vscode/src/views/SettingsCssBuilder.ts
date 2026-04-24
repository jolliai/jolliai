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
    margin-bottom: 24px;
    color: var(--vscode-foreground);
  }

  /* ── Group cards ── */
  .settings-group {
    margin-bottom: 24px;
  }
  .settings-group h2 {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 12px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
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
    padding: 6px 0;
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

  /* ── Browse row ── */
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

  /* ── Radio / fieldset ── */
  fieldset.settings-row.column {
    border: none;
    padding: 0;
  }
  fieldset.settings-row.column legend {
    margin-bottom: 8px;
  }
  .radio-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--vscode-foreground);
    padding: 3px 0;
    cursor: pointer;
  }
  .radio-label input[type="radio"] {
    accent-color: var(--vscode-button-background);
    cursor: pointer;
  }
  .radio-label input[type="radio"]:disabled {
    cursor: not-allowed;
  }
  .radio-hint {
    font-style: italic;
  }

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
