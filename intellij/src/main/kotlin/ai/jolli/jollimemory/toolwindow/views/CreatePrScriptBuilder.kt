package ai.jolli.jollimemory.toolwindow.views

/**
 * CreatePrScriptBuilder — inline JS for the Create PR JCEF webview.
 *
 * Mirrors [SummaryScriptBuilder]'s bridge (`jmSend` → `window.__jbQuery`, and an
 * inbound `jollimemory` CustomEvent from the Kotlin `postToWebview`). The PR body
 * is rendered server-side by [CreatePrBodyMarkdown.renderPrBodyMarkdown] and baked
 * into the initial HTML — matching the VS Code pane. This script no longer parses
 * markdown itself; when the user clicks Done after editing, it sends the raw body
 * back to Kotlin (`renderBody`) and swaps in the returned HTML (`bodyRendered`) so
 * there is exactly one renderer implementation to keep aligned with GitHub's.
 * No CSP nonce is needed — the IntelliJ JCEF webview does not enforce a CSP.
 */
object CreatePrScriptBuilder {

    fun buildScript(): String = """
  function jmSend(msg) {
    if (window.__jbQuery) {
      var json = JSON.stringify(msg);
      var bytes = new TextEncoder().encode(json);
      var binary = '';
      for (var i = 0; i < bytes.length; i++) { binary += String.fromCharCode(bytes[i]); }
      window.__jbQuery(btoa(binary));
    }
  }

  var inFlight = false;
  function setInFlight(on) { inFlight = on; var b = document.getElementById('cmdCreatePr'); if (b) b.disabled = on; }
  function setStatus(t) { var s = document.getElementById('prStatusText'); if (s) s.textContent = t || ''; }
  function submit(payload) { if (inFlight) return; setInFlight(true); jmSend(payload); }

  function show(id, visible) { var el = document.getElementById(id); if (el) el.classList.toggle('hidden', !visible); }

  // Edit toggles the Title/Body panels between their read-only display and inline
  // editors (no separate form). Toggling back re-renders the display via a
  // round-trip to Kotlin's renderPrBodyMarkdown so the client and initial paint
  // never disagree about how the same markdown looks.
  var editing = false;
  function setEditing(on) {
    editing = on;
    show('prTitleDisplay', !on); show('prTitleInput', on);
    show('prBody', !on); show('prBodyInput', on);
    var eb = document.getElementById('cmdEdit');
    if (eb) eb.textContent = on ? 'Done' : 'Edit';
    // Editing is itself a change, so re-enable a dimmed "Up to date" submit button
    // once the user starts editing the title/body.
    if (on) { var cb = document.getElementById('cmdCreatePr'); if (cb) cb.disabled = false; }
    if (!on) {
      var t = document.getElementById('prTitleInput'), d = document.getElementById('prTitleDisplay');
      if (t && d) d.textContent = t.value;
      var b = document.getElementById('prBodyInput');
      // Send the edited body to Kotlin; the `bodyRendered` handler below swaps
      // the rendered HTML into #prBody. Textarea input value is preserved so
      // clicking Edit again resumes the same edit session.
      if (b) jmSend({ command: 'renderBody', body: b.value });
    }
  }

  function showToast(text) {
    var el = document.getElementById('prToast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  // Create/Update always submits the (possibly edited) title + body inputs so the
  // read-only path and the edited path share one code path.
  var createBtn = document.getElementById('cmdCreatePr');
  if (createBtn) createBtn.addEventListener('click', function () {
    var t = document.getElementById('prTitleInput');
    var b = document.getElementById('prBodyInput');
    submit({ command: 'createPr', title: t ? t.value : undefined, body: b ? b.value : undefined });
  });
  var editBtn = document.getElementById('cmdEdit');
  if (editBtn) editBtn.addEventListener('click', function () { setEditing(!editing); });
  var copyBtn = document.getElementById('cmdCopyBody');
  if (copyBtn) copyBtn.addEventListener('click', function () {
    // Send the live textarea body (matches Create/Update) so Copy reflects inline edits.
    var cb = document.getElementById('prBodyInput');
    jmSend({ command: 'copyBody', body: cb ? cb.value : undefined });
  });

  document.querySelectorAll('.row[data-hash]').forEach(function (r) {
    r.addEventListener('click', function () { jmSend({ command: 'openMemory', hash: r.getAttribute('data-hash') }); });
  });
  document.querySelectorAll('.row[data-path]').forEach(function (r) {
    r.addEventListener('click', function () { jmSend({ command: 'openDiff', path: r.getAttribute('data-path') }); });
  });
  var prLink = document.getElementById('prOpenLink');
  if (prLink) prLink.addEventListener('click', function () { jmSend({ command: 'openPr', url: prLink.getAttribute('data-pr-url') }); });
  var signInLink = document.getElementById('prSignInLink');
  if (signInLink) signInLink.addEventListener('click', function () { jmSend({ command: 'signIn' }); });

  // Tell the panel the user has unsaved edits, so a cross-panel memory-state event
  // doesn't reload the page and drop the in-progress title/body. Fires on real content
  // changes (typing), not mere focus; the flag clears on the next full reload.
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
      jmSend({ command: 'editState', editing: true });
    }
  });

  window.addEventListener('jollimemory', function (e) {
    var msg = e.detail || {};
    switch (msg.command) {
      case 'prCreating': setInFlight(true); setStatus(msg.text || 'Creating PR…'); break;
      case 'prProgress': setStatus(msg.text || ''); break;
      case 'prCreated': setInFlight(false); setStatus(msg.text || ''); break;
      case 'prCreateError': setInFlight(false); setStatus(msg.text || ''); break;
      case 'bodyCopied': showToast(msg.text || 'Copied PR body to clipboard'); break;
      case 'bodyRendered': {
        // Kotlin's renderPrBodyMarkdown response after a Done click. Replace the
        // display in place — no other panels re-render so any current scroll
        // position on the page is preserved.
        var bodyEl = document.getElementById('prBody');
        if (bodyEl) bodyEl.innerHTML = msg.html || '';
        break;
      }
    }
  });
"""
}
