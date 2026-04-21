/**
 * NoteEditorCssBuilder
 *
 * Returns the CSS stylesheet for the Note Editor webview.
 * Uses VS Code CSS variables for automatic light/dark theme support.
 * Reuses styling conventions from SettingsCssBuilder for consistency.
 */

/** Returns the full CSS stylesheet for the Note Editor webview. */
export function buildNoteEditorCss(): string {
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
  .note-editor {
    max-width: 680px;
    margin: 0 auto;
    padding: 24px 32px 80px;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  .note-editor h1 {
    font-size: 22px;
    font-weight: 600;
    margin-bottom: 24px;
    color: var(--vscode-foreground);
  }

  /* ── Form fields ── */
  .field-group {
    margin-bottom: 16px;
  }
  .field-group label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--vscode-foreground);
    margin-bottom: 6px;
  }
  .field-group .hint {
    font-size: 11px;
    font-weight: 400;
    color: var(--vscode-descriptionForeground);
    margin-left: 6px;
  }

  input[type="text"] {
    width: 100%;
    padding: 6px 8px;
    font-size: 13px;
    font-family: var(--vscode-font-family);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 3px;
    outline: none;
    transition: border-color 0.15s;
  }
  input[type="text"]:focus {
    border-color: var(--vscode-focusBorder);
  }

  textarea {
    width: 100%;
    flex: 1;
    min-height: 200px;
    padding: 8px;
    font-size: 13px;
    font-family: var(--vscode-editor-font-family, monospace);
    line-height: 1.5;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 3px;
    outline: none;
    resize: vertical;
    transition: border-color 0.15s;
  }
  textarea:focus {
    border-color: var(--vscode-focusBorder);
  }

  .content-group {
    flex: 1;
    display: flex;
    flex-direction: column;
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
    align-items: center;
    background: var(--vscode-editor-background);
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
    gap: 12px;
  }
  .save-btn {
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
  .save-btn:hover { opacity: 0.9; }
  .save-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .save-feedback {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    opacity: 0;
    transition: opacity 0.3s;
  }
  .save-feedback.visible { opacity: 1; }

  .error-message {
    font-size: 11px;
    color: var(--vscode-errorForeground, #f44);
    margin-top: 4px;
    min-height: 14px;
  }
  `;
}
