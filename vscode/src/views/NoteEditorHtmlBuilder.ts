/**
 * NoteEditorHtmlBuilder
 *
 * Assembles the complete HTML document for the Note Editor webview.
 * Combines CSS, form fields (title + content), action bar, and script.
 */

import { buildNoteEditorCss } from "./NoteEditorCssBuilder.js";
import { buildNoteEditorScript } from "./NoteEditorScriptBuilder.js";

/**
 * Builds the full HTML document for the Note Editor webview.
 * @param nonce - CSP nonce for inline styles and scripts
 */
export function buildNoteEditorHtml(nonce: string): string {
	const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${csp}
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Add Text Snippet</title>
  <style nonce="${nonce}">${buildNoteEditorCss()}</style>
</head>
<body>
  <div class="note-editor">
    <h1>Add Text Snippet</h1>

    <div class="field-group">
      <label for="noteTitle">Title</label>
      <input type="text" id="noteTitle" placeholder="My Note" autocomplete="off" spellcheck="false" />
    </div>

    <div class="field-group content-group">
      <label for="noteContent">Content</label>
      <textarea id="noteContent" placeholder="Enter your note content..."></textarea>
      <div class="error-message" id="contentError"></div>
    </div>
  </div>

  <!-- Action bar -->
  <div class="action-bar">
    <span class="save-feedback" id="saveFeedback">Note saved</span>
    <button class="save-btn" id="saveBtn" disabled>Save</button>
  </div>

  <script nonce="${nonce}">${buildNoteEditorScript()}</script>
</body>
</html>`;
}
