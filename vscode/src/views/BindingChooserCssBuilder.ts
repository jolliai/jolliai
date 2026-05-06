/**
 * BindingChooserCssBuilder
 *
 * Minimal CSS for the BindingChooserWebviewPanel. Reuses VS Code theme
 * variables so the chooser blends with the rest of the editor chrome.
 */

export function buildBindingChooserCss(): string {
	return `
* { box-sizing: border-box; }
.hidden { display: none !important; }
body {
  margin: 0;
  padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
.chooser-page {
  max-width: 640px;
  margin: 0 auto;
  padding: 24px 32px 96px 32px;
}
h1 {
  font-size: 1.4em;
  margin: 0 0 8px 0;
  font-weight: 600;
}
.subtitle {
  color: var(--vscode-descriptionForeground);
  margin: 0 0 20px 0;
  font-size: 0.95em;
  line-height: 1.5;
}

.repo-meta {
  margin-bottom: 20px;
  font-size: 0.95em;
}
.repo-meta .repo-label {
  font-weight: 600;
  margin-right: 8px;
  color: var(--vscode-descriptionForeground);
}
.repo-meta .repo-url {
  font-family: var(--vscode-editor-font-family);
  word-break: break-all;
  color: var(--vscode-textPreformat-foreground);
}
.repo-meta .repo-hint {
  margin-top: 6px;
  color: var(--vscode-descriptionForeground);
  font-size: 0.85em;
}

.mode-pane {
  margin-bottom: 16px;
}

.spaces-list {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background: var(--vscode-editorWidget-background);
  max-height: 220px;
  overflow-y: auto;
}
.space-row {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--vscode-panel-border);
  cursor: pointer;
}
.space-row:last-child {
  border-bottom: none;
}
.space-row:hover {
  background: var(--vscode-list-hoverBackground);
}
.space-row input[type="radio"] {
  margin-right: 10px;
}
.space-row .space-name {
  font-weight: 500;
}
.space-row .space-slug {
  color: var(--vscode-descriptionForeground);
  font-size: 0.85em;
  margin-left: 6px;
}
.spaces-empty, .spaces-loading {
  padding: 16px;
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}

.error-message {
  color: var(--vscode-errorForeground);
  font-size: 0.85em;
  margin-top: 4px;
  min-height: 1.1em;
}
.error-message.general-error {
  margin-top: 8px;
}

.banner {
  background: var(--vscode-inputValidation-infoBackground);
  border: 1px solid var(--vscode-inputValidation-infoBorder);
  color: var(--vscode-inputValidation-infoForeground, var(--vscode-foreground));
  padding: 16px;
  border-radius: 4px;
  margin-bottom: 16px;
  font-size: 0.95em;
  line-height: 1.5;
}
.banner .banner-actions {
  margin-top: 12px;
  text-align: right;
}

.action-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--vscode-editor-background);
  border-top: 1px solid var(--vscode-panel-border);
  padding: 12px 32px;
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  align-items: center;
}
button {
  padding: 6px 16px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  border-radius: 3px;
  cursor: pointer;
  border: 1px solid transparent;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.btn-primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}
.btn-secondary {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border-color: var(--vscode-button-border, var(--vscode-panel-border));
}
.btn-secondary:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
}
`;
}
