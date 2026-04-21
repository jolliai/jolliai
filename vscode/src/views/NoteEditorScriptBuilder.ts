/**
 * NoteEditorScriptBuilder
 *
 * Returns the client-side JavaScript for the Note Editor webview.
 * Handles form interaction, validation, and message passing to the extension host.
 */

/** Returns the client-side JS for the Note Editor webview. */
export function buildNoteEditorScript(): string {
	return `
  (function () {
    const vscode = acquireVsCodeApi();

    const titleInput = document.getElementById('noteTitle');
    const contentArea = document.getElementById('noteContent');
    const saveBtn = document.getElementById('saveBtn');
    const feedback = document.getElementById('saveFeedback');
    const errorEl = document.getElementById('contentError');

    /** Enables Save when both title and content are non-empty. */
    function updateSaveState() {
      const hasTitle = titleInput.value.trim().length > 0;
      const hasContent = contentArea.value.trim().length > 0;
      saveBtn.disabled = !(hasTitle && hasContent);
      if (hasTitle && hasContent) errorEl.textContent = '';
    }

    contentArea.addEventListener('input', updateSaveState);
    titleInput.addEventListener('input', updateSaveState);

    /** Sends the note data to the extension host. */
    saveBtn.addEventListener('click', () => {
      const title = titleInput.value.trim();
      const content = contentArea.value.trim();
      if (!title || !content) {
        errorEl.textContent = !title ? 'Title is required' : 'Content is required';
        return;
      }
      saveBtn.disabled = true;
      vscode.postMessage({
        command: 'saveNote',
        title: title,
        content: content,
      });
    });

    /** Handle Ctrl/Cmd+Enter to save. */
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !saveBtn.disabled) {
        saveBtn.click();
      }
    });

    /** Handle messages from extension host. */
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.command) {
        case 'noteSaved':
          feedback.classList.add('visible');
          setTimeout(() => feedback.classList.remove('visible'), 2000);
          saveBtn.disabled = false;
          break;
        case 'noteError':
          errorEl.textContent = msg.message || 'Failed to save note';
          saveBtn.disabled = false;
          break;
      }
    });

    // Focus title input on load (required field)
    titleInput.focus();
  })();
  `;
}
