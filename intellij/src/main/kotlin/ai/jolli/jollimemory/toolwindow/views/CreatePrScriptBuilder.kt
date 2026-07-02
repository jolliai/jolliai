package ai.jolli.jollimemory.toolwindow.views

/**
 * CreatePrScriptBuilder — inline JS for the Create PR JCEF webview.
 *
 * Mirrors [SummaryScriptBuilder]'s bridge (`jmSend` → `window.__jbQuery`, and an
 * inbound `jollimemory` CustomEvent from the Kotlin `postToWebview`). Renders the
 * PR body markdown client-side via a ported `renderMarkdown`, and wires the
 * create/edit/copy actions plus memory/file row clicks. No CSP nonce is needed —
 * the IntelliJ JCEF webview does not enforce a CSP (unlike VS Code).
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

  function esc(s) {
    return (s == null ? '' : String(s))
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** Inline markdown: code, bold, italic, links. Uses function replacers to keep it robust. */
  function applyInline(text) {
    text = text.replace(/`([^`]+)`/g, function(m, g) { return '<code class="md-inline-code">' + g + '</code>'; });
    text = text.replace(/\*\*(.+?)\*\*/g, function(m, g) { return '<strong>' + g + '</strong>'; });
    text = text.replace(/__(.+?)__/g, function(m, g) { return '<strong>' + g + '</strong>'; });
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, function(m, label, url) {
      return '<a href="' + url + '" class="md-link">' + label + '</a>';
    });
    return text;
  }

  /** Minimal block-level markdown → HTML (headings, lists, code fences, paragraphs). */
  function renderMarkdown(raw) {
    if (!raw) return '';
    var text = esc(raw);
    text = text.replace(/```[a-zA-Z]*\n([\s\S]*?)```/g, function(m, code) {
      return '<pre class="md-code-block"><code>' + code.replace(/\n$/, '') + '</code></pre>';
    });
    var lines = text.split('\n');
    var out = [];
    var inList = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('<pre class="md-code-block">') !== -1) {
        if (inList) { out.push('</ul>'); inList = false; }
        var block = line;
        while (block.indexOf('</pre>') === -1 && i + 1 < lines.length) { i++; block += '\n' + lines[i]; }
        out.push(block);
        continue;
      }
      var headerMatch = line.match(/^(#{1,4})\s+(.+)${'$'}/);
      if (headerMatch) {
        if (inList) { out.push('</ul>'); inList = false; }
        var level = headerMatch[1].length + 1;
        out.push('<h' + level + ' class="md-heading">' + applyInline(headerMatch[2]) + '</h' + level + '>');
        continue;
      }
      var listMatch = line.match(/^[\-\*]\s+(.+)${'$'}/);
      if (listMatch) {
        if (!inList) { out.push('<ul class="md-list">'); inList = true; }
        out.push('<li>' + applyInline(listMatch[1]) + '</li>');
        continue;
      }
      if (inList) { out.push('</ul>'); inList = false; }
      if (line.trim() === '') { out.push('<div class="md-blank"></div>'); continue; }
      out.push('<div>' + applyInline(line) + '</div>');
    }
    if (inList) out.push('</ul>');
    return out.join('');
  }

  (function () {
    var bodyEl = document.getElementById('prBody');
    if (bodyEl) { bodyEl.innerHTML = renderMarkdown(bodyEl.getAttribute('data-body') || ''); }
  })();

  var inFlight = false;
  function setInFlight(on) { inFlight = on; var b = document.getElementById('cmdCreatePr'); if (b) b.disabled = on; }
  function setStatus(t) { var s = document.getElementById('prStatusText'); if (s) s.textContent = t || ''; }
  function submit(payload) { if (inFlight) return; setInFlight(true); jmSend(payload); }

  function show(id, visible) { var el = document.getElementById(id); if (el) el.classList.toggle('hidden', !visible); }

  // Edit toggles the Title/Body panels between their read-only display and inline
  // editors (no separate form). Toggling back re-renders the display from the edits.
  var editing = false;
  function setEditing(on) {
    editing = on;
    show('prTitleDisplay', !on); show('prTitleInput', on);
    show('prBody', !on); show('prBodyInput', on);
    var eb = document.getElementById('cmdEdit');
    if (eb) eb.textContent = on ? 'Done' : 'Edit';
    if (!on) {
      var t = document.getElementById('prTitleInput'), d = document.getElementById('prTitleDisplay');
      if (t && d) d.textContent = t.value;
      var b = document.getElementById('prBodyInput'), body = document.getElementById('prBody');
      if (b && body) body.innerHTML = renderMarkdown(b.value);
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
  if (copyBtn) copyBtn.addEventListener('click', function () { jmSend({ command: 'copyBody' }); });

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

  window.addEventListener('jollimemory', function (e) {
    var msg = e.detail || {};
    switch (msg.command) {
      case 'prCreating': setInFlight(true); setStatus(msg.text || 'Creating PR…'); break;
      case 'prProgress': setStatus(msg.text || ''); break;
      case 'prCreated': setInFlight(false); setStatus(msg.text || ''); break;
      case 'prCreateError': setInFlight(false); setStatus(msg.text || ''); break;
      case 'bodyCopied': showToast(msg.text || 'Copied PR body to clipboard'); break;
    }
  });
"""
}
