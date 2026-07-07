package ai.jolli.jollimemory.toolwindow.views

import ai.jolli.jollimemory.services.BranchShareModal

/**
 * ShareWebview — the single source of the share modal's HTML / CSS / JS. It renders as an inline
 * overlay inside the JCEF summary detail view ([modalHtml] + [renderScript] + [css]), mirroring the
 * VS Code webview modal: there is no separate share window. Both entry points converge here — the
 * Commits-row Share icon (commit share) and the sidebar Share button (branch share) open the
 * memory's detail webview and reveal this overlay via `shareOpen('commit' | 'branch')`.
 *
 * The client renders each `shareState` the host posts and sends shareBranch / shareCopyLink /
 * shareSetAccess / shareSendInvite / shareRemoveRecipient back over the JS↔Kotlin bridge, echoing
 * the current `shareKind` so the host builds a commit- or branch-scoped context.
 */
object ShareWebview {

    /** Serializes a modal state to the JSON shape the client's shareRender() expects. */
    fun stateToMap(state: BranchShareModal.ShareModalState): Map<String, Any?> = when (state) {
        is BranchShareModal.ShareModalState.NeedsApiKey -> mapOf("kind" to "needsApiKey")
        is BranchShareModal.ShareModalState.Loading -> mapOf("kind" to "loading", "label" to state.label)
        is BranchShareModal.ShareModalState.Error -> mapOf("kind" to "error", "message" to state.message)
        is BranchShareModal.ShareModalState.Ready -> mapOf(
            "kind" to "ready",
            "branch" to state.branch,
            "subject" to state.subject,
            "subjectTitle" to state.subjectTitle,
            "decisionCount" to state.decisionCount,
            "canOrg" to state.canOrg,
            "share" to state.share?.let {
                mapOf("shareUrl" to it.shareUrl, "visibility" to it.visibility, "recipients" to it.recipients)
            },
            "accountMembers" to state.accountMembers.map { mapOf("name" to it.name, "email" to it.email) },
            "gitCollaborators" to state.gitCollaborators.map { mapOf("name" to it.name, "email" to it.email) },
            "owner" to mapOf("name" to state.owner.name, "email" to state.owner.email),
        )
    }

    /** The inner panes of the share modal (shared by the inline overlay and the standalone dialog). */
    private fun panes(): String = """
    <div class="share-modal-head">
      <span class="share-modal-title">&#x1F517; <span id="shareModalTitle">Share this memory</span></span>
      <button class="share-modal-close" id="shareModalClose" title="Close" aria-label="Close">&#x2715;</button>
    </div>
    <p class="share-modal-sub" id="shareModalSub"></p>

    <div class="share-pane" id="sharePaneMain" hidden>
      <div class="share-search-wrap">
        <input type="text" class="share-search" id="shareTeammateSearch" placeholder="Search teammates by name or email&#x2026;" aria-label="Search teammates or add an email" autocomplete="off" />
        <div class="share-suggest" id="shareSuggest" hidden></div>
      </div>
      <div class="share-section-label">COLLABORATORS</div>
      <div class="share-collab-list" id="shareInvitedList" aria-label="Collaborators"></div>
      <div class="share-section-label">GENERAL ACCESS</div>
      <div class="share-access-row">
        <span class="share-access-icon" aria-hidden="true">&#x1F441;</span>
        <select class="share-select" id="shareAccessSelect" aria-label="Who can open this link">
          <option value="org" id="shareOrgOption">Anyone in your Jolli account</option>
          <option value="public">Anyone with the link</option>
          <option value="people">Only people you add</option>
        </select>
      </div>
      <p class="share-access-sub" id="shareAccessDesc"></p>
      <div class="share-travel-banner">
        <span class="share-travel-icon" aria-hidden="true">&#x21C4;</span>
        <span>Summaries + decisions + linked refs travel.<br /><strong>Conversation transcripts stay on your machine.</strong></span>
      </div>
      <div class="share-modal-actions share-actions-main">
        <button class="action-btn primary" id="shareCopyBtn" title="Copy the link for the selected access level (created on first copy)">&#x1F4CB; Copy link</button>
      </div>
    </div>

    <div class="share-pane" id="sharePaneInvite" hidden>
      <div class="share-invite-head">
        <button type="button" class="share-invite-back" id="shareInviteBack" title="Back" aria-label="Back">&#x2039;</button>
        <span class="share-invite-title">Send invite</span>
      </div>
      <div class="share-section-label">TO</div>
      <div class="share-chips" id="shareInviteTo"></div>
      <div class="share-search-wrap">
        <input type="text" class="share-search" id="shareInviteSearch" placeholder="Add another &#x2014; name or email&#x2026;" aria-label="Add a person by name or email" autocomplete="off" />
        <div class="share-suggest" id="shareInviteSuggest" hidden></div>
      </div>
      <div class="share-section-label">MESSAGE <span class="share-label-soft">optional</span></div>
      <textarea class="share-invite-message" id="shareInviteMessage" rows="3" placeholder="Add a note &#x2014; it appears at the top of their email&#x2026;"></textarea>
      <p class="share-invite-foot">They'll get an email with a link to open this in Jolli.</p>
      <div class="share-modal-actions">
        <button class="action-btn" id="shareInviteCancel">Cancel</button>
        <button class="action-btn primary" id="shareInviteSend" disabled>Send invite <span id="shareInviteSendCount"></span></button>
      </div>
    </div>

    <div class="share-pane" id="sharePaneLoading" hidden>
      <p class="share-loading"><span class="share-spinner" aria-hidden="true"></span><span id="shareLoadingLabel">Syncing to Jolli&#x2026;</span></p>
    </div>
    <div class="share-pane" id="sharePaneNoKey" hidden>
      <p class="share-nokey">Sign in to Jolli (Settings &#x25B8; Tools &#x25B8; Jolli Memory) to create a share link.</p>
    </div>
    <div class="share-pane" id="sharePaneError" hidden>
      <p class="share-error-msg" id="shareErrorMsg"></p>
      <div class="share-modal-actions"><button class="action-btn primary" id="shareRetryBtn">Try again</button></div>
    </div>"""

    /** Inline overlay markup for the JCEF summary view (hidden until the Share button opens it). */
    fun modalHtml(): String = """
<div class="share-overlay" id="shareOverlay" hidden>
  <div class="share-modal" role="dialog" aria-modal="true" aria-labelledby="shareModalTitle">
${panes()}
  </div>
</div>"""

    /** The share CSS block (referenced by SummaryCssBuilder so the inline modal is styled too). */
    fun css(): String = """
  /* ── Share modal (webview, single-slot) ── */
  .share-overlay {
    position: fixed; inset: 0; z-index: 1000;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.45);
  }
  .share-overlay[hidden] { display: none; }
  .share-modal {
    width: 440px; max-width: 92vw; max-height: 86vh; overflow-y: auto;
    /* Opaque surface (the editor background) so the card is fully readable over the dim
       overlay — --panel-bg is a near-transparent tint meant to sit on top of the page. */
    background: var(--bg); border: 1px solid var(--border-light);
    border-radius: 10px; padding: 16px 16px 14px; box-shadow: 0 12px 40px rgba(0,0,0,0.4);
  }
  .share-modal-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .share-modal-title { font-size: 1.05em; font-weight: 650; display: inline-flex; gap: 6px; align-items: center; }
  .share-modal-close { background: transparent; border: none; color: var(--text-secondary); padding: 4px 7px; border-radius: 4px; cursor: pointer; font-size: 1em; }
  .share-modal-close:hover { background: var(--list-hover-bg); color: var(--text-primary); }
  .share-modal-sub { font-size: 0.85em; color: var(--text-secondary); margin: 2px 0 14px; }
  .share-pane[hidden] { display: none; }
  .share-search-wrap { position: relative; margin-bottom: 14px; }
  .share-search { width: 100%; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 6px; padding: 7px 10px; font-size: 0.9em; }
  .share-search:focus { outline: 1px solid var(--focus-border); outline-offset: -1px; }
  .share-suggest { margin-top: 4px; max-height: 168px; overflow-y: auto; background: var(--panel-inner); border: 1px solid var(--border-light); border-radius: 6px; }
  .share-suggest[hidden] { display: none; }
  .share-suggest-group { padding: 7px 10px 3px; font-size: 0.68em; font-weight: 700; letter-spacing: 0.07em; color: var(--text-tertiary); text-transform: uppercase; }
  .share-suggest-item { display: flex; flex-direction: column; width: 100%; padding: 6px 10px; background: transparent; border: none; text-align: left; cursor: pointer; color: var(--text-primary); }
  .share-suggest-item:hover { background: var(--list-hover-bg); }
  .share-suggest-name { font-weight: 600; font-size: 0.88em; }
  .share-suggest-email { color: var(--text-secondary); font-size: 0.8em; }
  .share-section-label { font-size: 0.72em; font-weight: 700; letter-spacing: 0.07em; color: var(--text-tertiary); text-transform: uppercase; margin: 12px 0 8px; }
  .share-collab-list { display: flex; flex-direction: column; gap: 2px; max-height: 168px; overflow-y: auto; }
  .share-collab-row { display: flex; gap: 10px; align-items: center; padding: 4px 2px; }
  .share-collab-meta { flex: 1; min-width: 0; line-height: 1.25; }
  .share-collab-name { font-size: 0.88em; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .share-collab-email { font-size: 0.78em; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; }
  .share-collab-role { color: var(--text-secondary); font-size: 0.8em; }
  .share-collab-remove { background: transparent; border: none; color: var(--text-secondary); cursor: pointer; padding: 2px 6px; border-radius: 4px; }
  .share-collab-remove:hover { background: var(--list-hover-bg); color: var(--error-fg); }
  .share-access-row { display: flex; gap: 8px; align-items: center; }
  .share-access-icon { color: var(--text-secondary); }
  .share-select { width: 100%; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 6px; padding: 7px 9px; font-size: 0.9em; cursor: pointer; }
  .share-access-sub { font-size: 0.8em; color: var(--text-secondary); margin: 6px 0 12px; }
  .share-travel-banner { display: flex; gap: 10px; padding: 10px 12px; border-radius: 8px; background: var(--panel-inner); font-size: 0.82em; line-height: 1.5; margin: 4px 0 12px; }
  .share-travel-icon { color: var(--link-fg); }
  .share-modal-actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-top: 14px; }
  .share-actions-main { justify-content: flex-start; }
  .share-invite-head { display: flex; gap: 6px; align-items: center; margin-bottom: 10px; }
  .share-invite-back { background: transparent; border: none; color: var(--text-primary); font-size: 1.2em; cursor: pointer; padding: 2px 8px; }
  .share-invite-title { font-size: 1em; font-weight: 650; }
  .share-chips { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; max-height: 140px; overflow-y: auto; }
  .share-chip { display: flex; gap: 9px; align-items: center; padding: 5px 7px; border: 1px solid var(--border-light); border-radius: 7px; background: var(--panel-inner); }
  .share-chip-main { flex: 1; min-width: 0; }
  .share-chip-x { background: transparent; border: none; color: var(--text-secondary); cursor: pointer; padding: 2px 6px; }
  .share-chip-x:hover { color: var(--text-primary); }
  .share-invite-message { width: 100%; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 6px; padding: 7px 10px; font-size: 0.9em; resize: vertical; }
  .share-invite-foot { font-size: 0.8em; color: var(--text-secondary); margin: 8px 0 0; }
  .share-label-soft { font-weight: 400; letter-spacing: normal; text-transform: none; color: var(--text-tertiary); }
  .share-loading { display: flex; gap: 10px; align-items: center; color: var(--text-secondary); padding: 8px 0; }
  .share-spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--border-light); border-top-color: var(--link-fg); animation: share-spin 0.8s linear infinite; }
  @keyframes share-spin { to { transform: rotate(360deg); } }
  .share-error-msg { font-size: 0.9em; color: var(--error-fg); }
  .share-nokey { font-size: 0.9em; color: var(--text-secondary); }"""

    /**
     * The shared client JS: render each state + wire controls. `shareOpen(kind)` reveals the
     * overlay and starts the share for that kind ('commit' | 'branch'); `shareClose` hides it. The
     * inline caller (SummaryScriptBuilder) already defines `jmSend` and the `jollimemory` message
     * listener that routes `shareState` / `shareCopyResult` here.
     */
    fun renderScript(): String = """
  var shareOverlay = document.getElementById('shareOverlay');
  var shareState = null;
  var shareInvitePending = [];
  // 'commit' shares this memory; 'branch' shares the whole branch. Set by shareOpen and
  // echoed on every shareBranch/retry so the host builds the matching context.
  var shareCurrentKind = 'commit';
  var SHARE_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+${'$'}/;

  function shareById(id) { return document.getElementById(id); }
  function shareShowPane(id) {
    ['sharePaneMain','sharePaneInvite','sharePaneLoading','sharePaneNoKey','sharePaneError'].forEach(function(p){
      var el = shareById(p); if (el) el.hidden = (p !== id);
    });
  }
  function shareOpen(kind) {
    shareCurrentKind = (kind === 'branch') ? 'branch' : 'commit';
    if (shareOverlay) shareOverlay.hidden = false;
    shareShowPane('sharePaneLoading');
    jmSend({ command: 'shareBranch', shareKind: shareCurrentKind });
  }
  function shareClose() {
    if (shareOverlay) shareOverlay.hidden = true;
  }

  function shareRender(state) {
    if (!state) return;
    if (state.kind === 'needsApiKey') { shareShowPane('sharePaneNoKey'); return; }
    if (state.kind === 'loading') {
      var lbl = shareById('shareLoadingLabel'); if (lbl && state.label) lbl.textContent = state.label;
      shareShowPane('sharePaneLoading'); return;
    }
    if (state.kind === 'error') {
      var em = shareById('shareErrorMsg'); if (em) em.textContent = state.message || 'Something went wrong.';
      shareShowPane('sharePaneError'); return;
    }
    shareState = state;
    shareInvitePending = [];
    var titleEl = shareById('shareModalTitle');
    if (titleEl) titleEl.textContent = (state.subject && state.subject.indexOf('commit') >= 0) ? 'Share this memory' : 'Share this branch';
    var sub = shareById('shareModalSub');
    if (sub) { var n = state.decisionCount || 0; sub.textContent = (state.subjectTitle || state.subject || state.branch) + ' · ' + n + ' decision' + (n === 1 ? '' : 's'); }
    var orgOpt = shareById('shareOrgOption');
    if (orgOpt) { orgOpt.disabled = !state.canOrg; orgOpt.hidden = !state.canOrg; }
    var sel = shareById('shareAccessSelect');
    if (sel) sel.value = state.share ? state.share.visibility : (state.canOrg ? 'org' : 'public');
    shareUpdateAccessDesc();
    shareRenderCollaborators();
    shareResetCopyBtn();
    shareShowPane('sharePaneMain');
  }

  function shareUpdateAccessDesc() {
    var sel = shareById('shareAccessSelect'); var d = shareById('shareAccessDesc');
    if (!sel || !d) return;
    var v = sel.value;
    d.textContent = v === 'public' ? 'Anyone with the link can open this — no account needed.'
      : v === 'org' ? 'Anyone in your Jolli account can open this.'
      : 'Only the people you add can open this.';
  }

  function shareRowEl(name, email, isOwner) {
    var row = document.createElement('div'); row.className = 'share-collab-row';
    var meta = document.createElement('div'); meta.className = 'share-collab-meta';
    var nm = document.createElement('div'); nm.className = 'share-collab-name'; nm.textContent = name || email;
    var em = document.createElement('div'); em.className = 'share-collab-email'; em.textContent = email;
    meta.appendChild(nm); meta.appendChild(em); row.appendChild(meta);
    if (isOwner) {
      var r = document.createElement('span'); r.className = 'share-collab-role'; r.textContent = 'Owner'; row.appendChild(r);
    } else {
      var btn = document.createElement('button'); btn.className = 'share-collab-remove'; btn.textContent = '✕'; btn.title = 'Remove access';
      btn.addEventListener('click', function(){ jmSend({ command: 'shareRemoveRecipient', email: email }); });
      row.appendChild(btn);
    }
    return row;
  }

  function shareRenderCollaborators() {
    var box = shareById('shareInvitedList'); if (!box || !shareState) return;
    box.innerHTML = '';
    var owner = shareState.owner || { name: '', email: '' };
    box.appendChild(shareRowEl(owner.name || owner.email, owner.email, true));
    var recips = (shareState.share && shareState.share.recipients) ? shareState.share.recipients : [];
    recips.forEach(function(e){ box.appendChild(shareRowEl(shareResolveName(e), e, false)); });
  }

  function shareResolveName(email) {
    if (!shareState) return email;
    var all = (shareState.accountMembers || []).concat(shareState.gitCollaborators || []);
    for (var i = 0; i < all.length; i++) { if ((all[i].email || '').toLowerCase() === email.toLowerCase()) return all[i].name || email; }
    return email;
  }

  function shareResetCopyBtn() { var b = shareById('shareCopyBtn'); if (b) { b.disabled = false; b.textContent = '📋 Copy link'; } }
  function shareFlashCopy(ok) {
    var b = shareById('shareCopyBtn'); if (!b) return;
    b.textContent = ok ? 'Copied ✓' : 'Copy failed';
    setTimeout(shareResetCopyBtn, 1800);
  }

  function shareRenderSuggest(inputEl, boxEl, onPick) {
    if (!shareState || !boxEl) return;
    var q = (inputEl.value || '').trim().toLowerCase();
    boxEl.innerHTML = '';
    if (!q) { boxEl.hidden = true; return; }
    var ownerLower = (shareState.owner && shareState.owner.email ? shareState.owner.email : '').toLowerCase();
    var invited = {};
    ((shareState.share && shareState.share.recipients) ? shareState.share.recipients : []).forEach(function(e){ invited[e.toLowerCase()] = true; });
    shareInvitePending.forEach(function(e){ invited[e.toLowerCase()] = true; });
    function group(label, members) {
      var matches = (members || []).filter(function(m){
        var e = (m.email || '').toLowerCase(); var nm = (m.name || '').toLowerCase();
        return (e.indexOf(q) >= 0 || nm.indexOf(q) >= 0) && e !== ownerLower && !invited[e];
      }).slice(0, 50);
      if (matches.length === 0) return;
      var g = document.createElement('div'); g.className = 'share-suggest-group'; g.textContent = label; boxEl.appendChild(g);
      matches.forEach(function(m){
        var it = document.createElement('button'); it.className = 'share-suggest-item';
        var nm = document.createElement('span'); nm.className = 'share-suggest-name'; nm.textContent = m.name || m.email;
        var em = document.createElement('span'); em.className = 'share-suggest-email'; em.textContent = m.email;
        it.appendChild(nm); it.appendChild(em);
        it.addEventListener('click', function(){ onPick(m.email); });
        boxEl.appendChild(it);
      });
    }
    group('From your Jolli account', shareState.accountMembers);
    group('From this repo', shareState.gitCollaborators);
    if (SHARE_EMAIL_RE.test(q) && !invited[q]) {
      var g2 = document.createElement('div'); g2.className = 'share-suggest-group'; g2.textContent = 'Invite by email'; boxEl.appendChild(g2);
      var it2 = document.createElement('button'); it2.className = 'share-suggest-item';
      var nm2 = document.createElement('span'); nm2.className = 'share-suggest-name'; nm2.textContent = q; it2.appendChild(nm2);
      it2.addEventListener('click', function(){ onPick(q); });
      boxEl.appendChild(it2);
    }
    boxEl.hidden = boxEl.children.length === 0;
  }

  function shareEnterInvite(email) {
    if (email && shareInvitePending.indexOf(email.toLowerCase()) < 0) shareInvitePending.push(email.toLowerCase());
    var msg = shareById('shareInviteMessage'); if (msg && shareInvitePending.length <= 1) msg.value = '';
    shareRenderChips();
    shareShowPane('sharePaneInvite');
    var ts = shareById('shareTeammateSearch'); if (ts) ts.value = '';
    var sug = shareById('shareSuggest'); if (sug) sug.hidden = true;
    var s = shareById('shareInviteSearch'); if (s) { s.value = ''; s.focus(); }
  }
  function shareRenderChips() {
    var box = shareById('shareInviteTo'); if (!box) return;
    box.innerHTML = '';
    shareInvitePending.forEach(function(e){
      var chip = document.createElement('div'); chip.className = 'share-chip';
      var main = document.createElement('div'); main.className = 'share-chip-main'; main.textContent = e;
      var x = document.createElement('button'); x.className = 'share-chip-x'; x.textContent = '✕';
      x.addEventListener('click', function(){ shareInvitePending = shareInvitePending.filter(function(p){ return p !== e; }); shareRenderChips(); });
      chip.appendChild(main); chip.appendChild(x); box.appendChild(chip);
    });
    var b = shareById('shareInviteSend'); var c = shareById('shareInviteSendCount');
    if (b) b.disabled = shareInvitePending.length === 0;
    if (c) c.textContent = shareInvitePending.length > 0 ? '(' + shareInvitePending.length + ')' : '';
  }

  (function shareWire() {
    var close = shareById('shareModalClose'); if (close) close.addEventListener('click', shareClose);
    if (shareOverlay) shareOverlay.addEventListener('click', function(e){ if (e.target === shareOverlay) shareClose(); });
    var sel = shareById('shareAccessSelect');
    if (sel) sel.addEventListener('change', function(){ shareUpdateAccessDesc(); jmSend({ command: 'shareSetAccess', visibility: sel.value }); });
    var copy = shareById('shareCopyBtn');
    if (copy) copy.addEventListener('click', function(){ var v = sel ? sel.value : 'public'; jmSend({ command: 'shareCopyLink', visibility: v }); });
    var ts = shareById('shareTeammateSearch'); var sug = shareById('shareSuggest');
    if (ts && sug) {
      ts.addEventListener('input', function(){ shareRenderSuggest(ts, sug, function(email){ shareEnterInvite(email); }); });
      ts.addEventListener('keydown', function(e){ if (e.key === 'Enter') { var v = ts.value.trim(); if (SHARE_EMAIL_RE.test(v)) shareEnterInvite(v); } });
    }
    var back = shareById('shareInviteBack'); if (back) back.addEventListener('click', function(){ shareShowPane('sharePaneMain'); });
    var cancel = shareById('shareInviteCancel'); if (cancel) cancel.addEventListener('click', function(){ shareInvitePending = []; shareShowPane('sharePaneMain'); });
    var is = shareById('shareInviteSearch'); var isug = shareById('shareInviteSuggest');
    if (is && isug) {
      is.addEventListener('input', function(){ shareRenderSuggest(is, isug, function(email){ if (shareInvitePending.indexOf(email.toLowerCase()) < 0) shareInvitePending.push(email.toLowerCase()); is.value = ''; isug.hidden = true; shareRenderChips(); }); });
      is.addEventListener('keydown', function(e){ if (e.key === 'Enter') { var v = is.value.trim(); if (SHARE_EMAIL_RE.test(v)) { if (shareInvitePending.indexOf(v.toLowerCase()) < 0) shareInvitePending.push(v.toLowerCase()); is.value = ''; isug.hidden = true; shareRenderChips(); } } });
    }
    var send = shareById('shareInviteSend');
    if (send) send.addEventListener('click', function(){
      if (shareInvitePending.length === 0) return;
      var msgEl = shareById('shareInviteMessage');
      var vis = (sel && sel.value === 'org') ? 'org' : 'people';
      var payload = { command: 'shareSendInvite', recipients: shareInvitePending.slice(), visibility: vis };
      if (msgEl && msgEl.value.trim()) payload.message = msgEl.value.trim();
      jmSend(payload);
    });
    var retry = shareById('shareRetryBtn'); if (retry) retry.addEventListener('click', function(){ shareShowPane('sharePaneLoading'); jmSend({ command: 'shareBranch', shareKind: shareCurrentKind }); });
  })();"""
}
