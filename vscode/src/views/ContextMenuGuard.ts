/**
 * ContextMenuGuard
 *
 * Returns a JS snippet that suppresses the embedded Chromium's default
 * right-click menu (Cut/Copy/Paste/...) inside a webview, while preserving it
 * on editable controls so users can still copy/paste their own input.
 *
 * Why: every webview is a Chromium iframe. Without an explicit listener, any
 * right-click — including on our own custom context menus — falls through to
 * the native edit menu, which looks jarring inside a styled UI and confused
 * users when they right-clicked a custom menu item and got Cut/Copy/Paste.
 *
 * Editable carve-out covers: <textarea>, contenteditable elements, and
 * <input> types that accept free text (text/number/search/email/url/tel/
 * password). Non-text inputs (checkbox/radio/button/...) get suppressed
 * along with everything else.
 */
export function buildContextMenuGuardScript(): string {
	return `
  (function () {
    function isEditable(el) {
      if (!el) return false;
      if (el.tagName === 'TEXTAREA') return true;
      if (el.isContentEditable) return true;
      if (el.tagName === 'INPUT') {
        var type = (el.type || 'text').toLowerCase();
        return type === 'text' || type === 'number' || type === 'search' ||
               type === 'email' || type === 'url' || type === 'tel' ||
               type === 'password';
      }
      return false;
    }
    document.addEventListener('contextmenu', function(e) {
      if (!isEditable(e.target)) e.preventDefault();
    });
  })();
  `;
}
