package ai.jolli.jollimemory.toolwindow.views

import ai.jolli.jollimemory.services.BranchShareModal

/**
 * ShareWebview — the single source of the share modal's HTML / CSS / JS, so all three surfaces
 * render the identical webview (mirroring the VS Code webview modal):
 *  - the inline overlay inside the JCEF summary view ([modalHtml] + [renderScript]),
 *  - the standalone JCEF dialog launched from the Swing sidebar / Commits row ([standaloneDocument]).
 *
 * The client renders each `shareState` the host posts and sends shareBranch / shareCopyLink /
 * shareSetAccess / shareSendInvite / shareRemoveRecipient back over the JS↔Kotlin bridge. The
 * `window.SHARE_STANDALONE` flag switches open/close behavior between the two hosts.
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
      <span class="share-head-right">
        <span class="share-sync-badge" id="shareSyncBadge" hidden></span>
        <button type="button" class="share-modal-close" id="shareModalClose" title="Close" aria-label="Close">&#x2715;</button>
      </span>
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
        <div class="share-select-wrap">
          <button type="button" class="share-select" id="shareAccessSelect" aria-haspopup="listbox" aria-expanded="false" aria-label="Who can open this link">
            <span class="share-select-value" id="shareAccessValueText">Anyone within your Jolli Account</span>
            <span class="share-select-arrow" aria-hidden="true">&#x25BE;</span>
          </button>
          <div class="share-access-menu" id="shareAccessMenu" role="listbox" hidden>
            <button type="button" class="share-access-option" data-value="org" id="shareOrgOption" role="option">Anyone within your Jolli Account</button>
            <button type="button" class="share-access-option" data-value="public" role="option">Anyone with the link</button>
            <button type="button" class="share-access-option" data-value="people" role="option">Only people you add</button>
          </div>
        </div>
      </div>
      <p class="share-access-sub" id="shareAccessDesc"></p>

      <div class="share-travel-banner">
        <span class="share-travel-icon" aria-hidden="true">&#x21C4;</span>
        <span>Summaries + decisions + linked refs travel.<br /><strong>Conversation transcripts stay on your machine.</strong></span>
      </div>

      <label class="share-transcript-opt" title="Not available &#x2014; transcripts stay on your machine.">
        <input type="checkbox" disabled />
        <span>Include conversation transcripts</span>
        <span class="share-optin-badge">opt-in</span>
      </label>

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
        <button class="action-btn primary" id="shareInviteSend" disabled>Send invite <span id="shareInviteSendCount"></span> &#x2192;</button>
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

    /** Standalone modal body for the JCEF dialog (fills the dialog; no dimmed overlay). */
    private fun standaloneBody(): String = """
  <div class="share-modal share-standalone" role="dialog" aria-modal="true" aria-labelledby="shareModalTitle">
${panes()}
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
    background: var(--bg); border: 1px solid var(--border-light);
    border-radius: 10px; padding: 16px 18px; box-shadow: 0 12px 40px rgba(0,0,0,0.4);
  }
  .share-standalone { width: 100%; max-width: none; max-height: none; overflow: visible; border: none; border-radius: 0; box-shadow: none; padding: 14px 16px; }
  .share-standalone .share-modal-close { display: none; }
  .share-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
  .share-head-right { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
  .share-modal-title { font-size: 1.1em; font-weight: 650; display: inline-flex; align-items: center; gap: 6px; }
  .share-modal-close { background: transparent; border: none; color: var(--text-secondary); padding: 4px 7px; border-radius: 4px; cursor: pointer; font-size: 1.05em; line-height: 1; }
  .share-modal-close:hover { background: var(--list-hover-bg); color: var(--text-primary); }
  .share-modal-sub { color: var(--text-secondary); font-size: 0.85em; margin: 0 0 14px; }
  .share-pane[hidden] { display: none; }
  /* Invite mode: the card's own title/subtitle disappear, "Send invite" becomes the header. */
  .share-modal.inviting .share-modal-head, .share-modal.inviting .share-modal-sub { display: none; }
  /* Sync status badge */
  .share-sync-badge { flex: 0 0 auto; font-size: 0.72em; font-weight: 700; letter-spacing: 0.05em; padding: 2px 9px; border-radius: 10px; }
  .share-sync-badge[hidden] { display: none; }
  .share-sync-badge.synced { color: #3fb950; background: rgba(63,185,80,0.14); }
  .share-sync-badge.syncing { color: var(--text-secondary); background: rgba(127,127,127,0.16); }
  /* Teammate search + add-people suggestions dropdown */
  .share-search-wrap { position: relative; margin-bottom: 14px; }
  .share-search { display: block; width: 100%; box-sizing: border-box; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 6px; padding: 7px 10px; font-size: 0.85em; }
  .share-search:focus { outline: 1px solid var(--focus-border); outline-offset: -1px; }
  .share-suggest { position: static; margin-top: 5px; max-height: 160px; overflow-y: auto; background: var(--bg); border: 1px solid var(--border-light); border-radius: 6px; box-shadow: 0 2px 6px rgba(0,0,0,0.08); }
  .share-suggest[hidden] { display: none; }
  .share-suggest .share-avatar { width: 24px; height: 24px; font-size: 0.62em; }
  .share-suggest-item { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box; text-align: left; background: var(--bg); border: none; padding: 7px 10px; cursor: pointer; font-size: 0.85em; color: var(--text-primary); }
  .share-suggest-item:hover { background: var(--list-hover-bg); }
  .share-suggest-name { font-weight: 600; }
  .share-suggest-email { color: var(--text-secondary); font-size: 0.92em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .share-suggest-group { padding: 7px 10px 3px; font-size: 0.68em; font-weight: 700; letter-spacing: 0.07em; color: var(--text-secondary); text-transform: uppercase; position: sticky; top: 0; background: var(--bg); z-index: 1; }
  .share-section-label { font-size: 0.72em; font-weight: 700; letter-spacing: 0.07em; color: var(--text-secondary); margin: 0 0 8px; }
  .share-label-soft { font-weight: 400; letter-spacing: normal; text-transform: none; }
  /* General access */
  .share-access-row { display: flex; align-items: center; gap: 8px; }
  .share-access-icon { flex: 0 0 auto; color: var(--text-secondary); }
  .share-select-wrap { position: relative; flex: 1 1 auto; }
  .share-select { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; box-sizing: border-box; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 6px; padding: 7px 10px; font-family: inherit; font-size: 0.85em; text-align: left; cursor: pointer; }
  .share-select:hover { border-color: var(--focus-border); }
  .share-select:focus { outline: 1px solid var(--focus-border); outline-offset: -1px; }
  .share-select-value { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .share-select-arrow { flex: 0 0 auto; color: var(--text-secondary); font-size: 0.9em; line-height: 1; transition: transform 0.15s ease; }
  .share-select[aria-expanded="true"] .share-select-arrow { transform: rotate(180deg); }
  .share-access-menu { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 20; background: var(--bg); border: 1px solid var(--border-light); border-radius: 6px; padding: 3px; box-shadow: 0 6px 16px rgba(0,0,0,0.35); }
  .share-access-menu[hidden] { display: none; }
  .share-access-option { display: block; width: 100%; box-sizing: border-box; background: transparent; border: none; padding: 7px 10px; border-radius: 4px; font-family: inherit; font-size: 0.85em; color: var(--text-primary); text-align: left; cursor: pointer; }
  .share-access-option:hover { background: var(--list-hover-bg); }
  .share-access-option.selected { background: var(--list-hover-bg); font-weight: 600; }
  .share-access-option[hidden] { display: none; }
  .share-access-option:disabled { opacity: 0.5; cursor: not-allowed; }
  .share-access-sub { color: var(--text-secondary); font-size: 0.8em; margin: 6px 0 14px; }
  /* Invited people rows (collaborators block) */
  .share-collab-list { display: flex; flex-direction: column; gap: 2px; margin-bottom: 16px; max-height: 168px; overflow-y: auto; }
  .share-collab-row { display: flex; align-items: center; gap: 10px; padding: 5px 4px; }
  .share-avatar { flex: 0 0 auto; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.72em; font-weight: 700; color: #fff; background: var(--link-fg); }
  .share-collab-meta { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
  .share-collab-name { font-size: 0.88em; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .share-collab-email { font-size: 0.78em; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .share-collab-role { flex: 0 0 auto; color: var(--text-secondary); font-size: 0.8em; }
  /* Per-person "Manage access" ellipsis menu */
  .share-role-wrap { flex: 0 0 auto; position: relative; }
  .share-collab-menu-btn { background: none; border: none; color: var(--text-secondary); font-size: 1.1em; line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 4px; }
  .share-collab-menu-btn:hover { background: var(--list-hover-bg); color: var(--text-primary); }
  .share-role-menu { position: absolute; right: 0; top: calc(100% + 2px); z-index: 6; background: var(--bg); border: 1px solid var(--border-light); border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); padding: 3px; }
  .share-role-menu[hidden] { display: none; }
  .share-role-menu button { display: block; width: 100%; text-align: left; white-space: nowrap; background: none; border: none; color: var(--error-fg); font-family: inherit; font-size: 0.85em; padding: 5px 10px; border-radius: 4px; cursor: pointer; }
  .share-role-menu button:hover { background: var(--list-hover-bg); }
  /* "What travels" banner */
  .share-travel-banner { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 8px; background: var(--panel-inner); font-size: 0.83em; line-height: 1.5; margin-bottom: 12px; }
  .share-travel-icon { flex: 0 0 auto; color: var(--link-fg); font-size: 1.05em; }
  /* Transcript opt-in (disabled mock) */
  .share-transcript-opt { display: flex; align-items: center; gap: 8px; font-size: 0.85em; color: var(--text-secondary); cursor: not-allowed; }
  .share-transcript-opt input { margin: 0; }
  .share-optin-badge { font-size: 0.7em; font-weight: 700; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 4px; background: rgba(127,127,127,0.16); color: var(--text-secondary); text-transform: uppercase; }
  /* Footer actions */
  .share-modal-actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-top: 16px; }
  .share-actions-main { justify-content: flex-start; }
  /* In-page copy confirmation toast */
  .share-toast { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%) translateY(8px); z-index: 1200; background: var(--bg); color: var(--text-primary); border: 1px solid var(--border-light); border-radius: 6px; padding: 7px 14px; font-size: 0.85em; box-shadow: 0 6px 18px rgba(0,0,0,0.4); opacity: 0; pointer-events: none; transition: opacity 0.15s ease, transform 0.15s ease; }
  .share-toast.on { opacity: 1; transform: translateX(-50%) translateY(0); }
  /* Send-invite pane */
  .share-invite-head { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
  .share-invite-back { background: transparent; border: none; color: var(--text-primary); font-size: 1.3em; line-height: 1; cursor: pointer; padding: 2px 8px; border-radius: 4px; }
  .share-invite-back:hover { background: var(--list-hover-bg); }
  .share-invite-title { font-size: 1em; font-weight: 650; }
  /* TO recipients: full-width stacked row cards (avatar + name/email + remove) */
  .share-chips { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; max-height: 168px; overflow-y: auto; }
  .share-recip { display: flex; align-items: center; gap: 9px; padding: 5px 7px; border: 1px solid var(--border-light); border-radius: 7px; background: var(--bg); }
  .share-recip-main { display: flex; flex-direction: column; min-width: 0; flex: 1; line-height: 1.25; }
  .share-recip-name { font-size: 0.88em; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .share-recip-email { font-size: 0.78em; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .share-recip-x { flex: 0 0 auto; background: none; border: none; color: var(--text-secondary); font-size: 1.05em; line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 4px; }
  .share-recip-x:hover { background: var(--list-hover-bg); color: var(--text-primary); }
  .share-invite-empty { color: var(--text-secondary); font-size: 0.8em; margin: 4px 2px; }
  .share-invite-message { display: block; width: 100%; box-sizing: border-box; resize: vertical; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 6px; padding: 7px 10px; font-size: 0.85em; margin-bottom: 8px; }
  .share-invite-message:focus { outline: 1px solid var(--focus-border); outline-offset: -1px; }
  .share-invite-foot { color: var(--text-secondary); font-size: 0.8em; margin: 0; }
  /* Shared panes (loading / error / no-key) */
  .share-loading { display: flex; align-items: center; gap: 10px; color: var(--text-secondary); }
  .share-spinner { width: 14px; height: 14px; border: 2px solid var(--text-secondary); border-top-color: transparent; border-radius: 50%; animation: share-spin 0.8s linear infinite; }
  @keyframes share-spin { to { transform: rotate(360deg); } }
  .share-error-msg { color: var(--error-fg); font-size: 0.9em; }
  .share-nokey { color: var(--text-secondary); font-size: 0.9em; }"""

    /**
     * The shared client JS: render each state + wire controls. `shareOpen`/`shareClose` branch on
     * `window.SHARE_STANDALONE`. Inline callers (SummaryScriptBuilder) already define `jmSend` and the
     * `jollimemory` message listener; the standalone document adds those itself.
     */
    fun renderScript(): String = """
  var shareOverlay = document.getElementById('shareOverlay');
  var SHARE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+${'$'}/;

  // Log to the host so JS internals show up in .jolli/jollimemory/debug.log alongside Kotlin logs.
  function jmDebug(msg) {
    try { if (typeof jmSend === 'function') { jmSend({ command: 'shareDebug', message: String(msg) }); } } catch (_) {}
  }

  var shareLink = null;
  var shareAccountMembers = [];
  var shareGitCollaborators = [];
  var shareCanOrg = false;
  var shareOwnerEmail = '';
  var shareOwnerName = '';
  var shareInvitePending = [];
  var shareUserPickedTier = '';

  function sharePane(id) {
    var panes = document.querySelectorAll('.share-pane');
    for (var i = 0; i < panes.length; i++) { panes[i].hidden = (panes[i].id !== id); }
    var card = document.querySelector('.share-modal');
    if (card) { card.scrollTop = 0; }
    shareReportSize();
  }

  var shareResizeTimer = null;
  var shareLastReportedH = 0;
  var shareLastReportedW = 0;
  // While the mouse is pressed we must NOT resize the dialog: setSize between mousedown and
  // mouseup shifts CEF's native coordinate system, so mouseup lands on a different element than
  // mousedown and Chromium dispatches the click to their common ancestor (document) — closing
  // the very dropdown the user was opening.
  var shareMouseDown = false;
  document.addEventListener('mousedown', function() { shareMouseDown = true; }, true);
  document.addEventListener('mouseup', function() {
    shareMouseDown = false;
    // Trigger a size report shortly after mouseup so any pending grow finally lands.
    setTimeout(shareReportSize, 30);
  }, true);
  function shareReportSize() {
    if (!window.SHARE_STANDALONE) { return; }
    if (shareResizeTimer) { clearTimeout(shareResizeTimer); }
    shareResizeTimer = setTimeout(function() {
      if (shareMouseDown) { jmDebug('reportSize: skipped (mouse down)'); return; }
      var body = document.body;
      var root = document.documentElement;
      if (!body || !root) { return; }
      var h = Math.max(body.scrollHeight, body.offsetHeight, root.scrollHeight, root.offsetHeight);
      var w = Math.max(body.scrollWidth, body.offsetWidth, root.scrollWidth, root.offsetWidth);
      if (h === shareLastReportedH && w === shareLastReportedW) { return; }
      shareLastReportedH = h;
      shareLastReportedW = w;
      jmSend({ command: 'shareResize', width: w, height: h });
    }, 40);
  }

  function shareSetSyncBadge(mode) {
    var badge = document.getElementById('shareSyncBadge');
    if (!badge) { return; }
    if (mode === 'ready') { badge.textContent = '● SYNCED'; badge.className = 'share-sync-badge synced'; badge.hidden = false; }
    else if (mode === 'loading') { badge.textContent = 'SYNCING…'; badge.className = 'share-sync-badge syncing'; badge.hidden = false; }
    else { badge.hidden = true; }
  }

  function shareOpen() {
    if (!window.SHARE_STANDALONE && shareOverlay) { shareOverlay.hidden = false; }
    sharePane('sharePaneLoading');
    shareSetSyncBadge('loading');
    jmSend({ command: 'shareBranch' });
  }
  function shareClose() {
    if (window.SHARE_STANDALONE) { jmSend({ command: 'shareCloseDialog' }); return; }
    if (shareOverlay) { shareOverlay.hidden = true; }
  }

  function shareResolveName(email) {
    var lower = (email || '').toLowerCase();
    var groups = [shareAccountMembers, shareGitCollaborators];
    for (var g = 0; g < groups.length; g++) {
      var arr = groups[g] || [];
      for (var i = 0; i < arr.length; i++) {
        if ((arr[i].email || '').toLowerCase() === lower) { return arr[i].name || email; }
      }
    }
    return email;
  }

  function shareRemoveRecipient(email) {
    shareSetSyncBadge('loading');
    jmSend({ command: 'shareRemoveRecipient', email: email });
  }

  function shareInitials(name, email) {
    var src = (name || '').trim() || (email || '').trim();
    if (!src) { return '?'; }
    var parts = src.split(/\s+/);
    if (name && parts.length >= 2) { return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase(); }
    return src.slice(0, 2).toUpperCase();
  }

  function shareRowEl(name, email, isOwner, onRemove) {
    var row = document.createElement('div');
    row.className = 'share-collab-row';
    var av = document.createElement('span');
    av.className = 'share-avatar';
    av.textContent = shareInitials(name, email);
    var meta = document.createElement('div');
    meta.className = 'share-collab-meta';
    var nm = document.createElement('span');
    nm.className = 'share-collab-name';
    nm.textContent = (name || email) + (isOwner ? ' (you)' : '');
    var em = document.createElement('span');
    em.className = 'share-collab-email';
    em.textContent = email || '';
    meta.appendChild(nm); meta.appendChild(em);
    row.appendChild(av); row.appendChild(meta);
    if (isOwner) {
      var role = document.createElement('span');
      role.className = 'share-collab-role';
      role.textContent = 'Owner';
      row.appendChild(role);
    } else if (onRemove) {
      var wrap = document.createElement('span');
      wrap.className = 'share-role-wrap';
      var dots = document.createElement('button');
      dots.type = 'button';
      dots.className = 'share-collab-menu-btn';
      dots.title = 'Manage access';
      dots.setAttribute('aria-label', 'Manage access for ' + (email || ''));
      dots.textContent = '⋯';
      var menu = document.createElement('div');
      menu.className = 'share-role-menu';
      menu.hidden = true;
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = 'Remove access';
      rm.addEventListener('click', function(ev) { ev.stopPropagation(); onRemove(email); });
      menu.appendChild(rm);
      dots.addEventListener('click', function(ev) { ev.stopPropagation(); shareHideRoleMenus(menu); menu.hidden = !menu.hidden; });
      wrap.appendChild(dots); wrap.appendChild(menu);
      row.appendChild(wrap);
    }
    return row;
  }

  function shareHideRoleMenus(except) {
    var menus = document.querySelectorAll('.share-role-menu');
    for (var i = 0; i < menus.length; i++) { if (menus[i] !== except) { menus[i].hidden = true; } }
  }
  document.addEventListener('click', function() { shareHideRoleMenus(null); });

  function shareRenderInvited() {
    var box = document.getElementById('shareInvitedList');
    if (!box) { return; }
    box.innerHTML = '';
    box.appendChild(shareRowEl(shareOwnerName || shareOwnerEmail, shareOwnerEmail, true, null));
    (shareLink && shareLink.recipients ? shareLink.recipients : []).forEach(function(e) {
      box.appendChild(shareRowEl(shareResolveName(e), e, false, shareRemoveRecipient));
    });
  }

  function shareExcludedEmails() {
    var inList = {};
    if (shareOwnerEmail) { inList[shareOwnerEmail.toLowerCase()] = true; }
    (shareLink && shareLink.recipients ? shareLink.recipients : []).forEach(function(e) { inList[e.toLowerCase()] = true; });
    shareInvitePending.forEach(function(e) { inList[e.toLowerCase()] = true; });
    return inList;
  }

  function shareRenderSuggestInto(inputEl, boxEl, onPick) {
    if (!boxEl) { jmDebug('renderSuggest: boxEl missing'); return; }
    boxEl.innerHTML = '';
    var query = (inputEl && inputEl.value ? inputEl.value : '').trim().toLowerCase();
    var inList = shareExcludedEmails();
    jmDebug('renderSuggest: input=' + (inputEl ? inputEl.id : 'null')
      + ' box=' + boxEl.id
      + ' query="' + query + '"'
      + ' accountMembers=' + (shareAccountMembers ? shareAccountMembers.length : 'null')
      + ' gitCollaborators=' + (shareGitCollaborators ? shareGitCollaborators.length : 'null')
      + ' invitePending=' + shareInvitePending.length
      + ' ownerEmail=' + (shareOwnerEmail || 'none'));
    var itemEl = function(m) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'share-suggest-item';
      var av = document.createElement('span');
      av.className = 'share-avatar';
      av.textContent = shareInitials(m.name, m.email);
      var main = document.createElement('span'); main.className = 'share-recip-main';
      var nm = document.createElement('span'); nm.className = 'share-suggest-name'; nm.textContent = m.name || m.email;
      var em = document.createElement('span'); em.className = 'share-suggest-email'; em.textContent = m.email || '';
      main.appendChild(nm); main.appendChild(em);
      item.appendChild(av); item.appendChild(main);
      item.addEventListener('click', function() { if (inputEl) { inputEl.value = ''; } shareHideSuggests(); onPick(m.email); });
      return item;
    };
    var appendGroup = function(label, members) {
      var matches = (members || []).filter(function(m) {
        var hay = ((m.name || '') + ' ' + (m.email || '')).toLowerCase();
        if ((query && hay.indexOf(query) === -1) || inList[(m.email || '').toLowerCase()]) { return false; }
        return true;
      }).slice(0, 100);
      if (matches.length === 0) { return; }
      var head = document.createElement('div');
      head.className = 'share-suggest-group';
      head.textContent = label;
      boxEl.appendChild(head);
      matches.forEach(function(m) { boxEl.appendChild(itemEl(m)); });
    };
    appendGroup('From your Jolli account', shareAccountMembers);
    appendGroup('From this repo', shareGitCollaborators);
    var raw = (inputEl && inputEl.value ? inputEl.value : '').trim();
    if (SHARE_EMAIL_RE.test(raw) && !inList[raw.toLowerCase()]) {
      var head2 = document.createElement('div');
      head2.className = 'share-suggest-group';
      head2.textContent = 'Invite by email';
      boxEl.appendChild(head2);
      boxEl.appendChild(itemEl({ name: raw, email: raw }));
    }
    boxEl.hidden = boxEl.children.length === 0;
    jmDebug('renderSuggest done: box=' + boxEl.id + ' children=' + boxEl.children.length + ' hidden=' + boxEl.hidden);
  }

  function shareHideSuggests() {
    var boxes = document.querySelectorAll('.share-suggest');
    var visibleBefore = 0;
    for (var i = 0; i < boxes.length; i++) { if (!boxes[i].hidden) { visibleBefore++; } }
    for (var i = 0; i < boxes.length; i++) { boxes[i].hidden = true; boxes[i].innerHTML = ''; }
    if (visibleBefore > 0) { jmDebug('hideSuggests: cleared ' + visibleBefore + ' visible box(es)'); }
  }

  function shareWireSuggest(inputId, boxId, onPick) {
    var input = document.getElementById(inputId);
    var box = document.getElementById(boxId);
    if (!input || !box) { jmDebug('wireSuggest: element missing input=' + inputId + ' box=' + boxId); return; }
    jmDebug('wireSuggest: bound input=' + inputId + ' box=' + boxId);
    var render = function(evtType) { return function() { jmDebug('wireSuggest event=' + evtType + ' on input=' + inputId); shareRenderSuggestInto(input, box, onPick); }; };
    input.addEventListener('focus', render('focus'));
    input.addEventListener('input', render('input'));
    input.addEventListener('keydown', function(e) {
      if (e.key !== 'Enter') { return; }
      e.preventDefault();
      var raw = (input.value || '').trim();
      if (SHARE_EMAIL_RE.test(raw) && !shareExcludedEmails()[raw.toLowerCase()]) {
        input.value = '';
        shareHideSuggests();
        onPick(raw);
      }
    });
    input.addEventListener('click', function(e) { e.stopPropagation(); });
    input.addEventListener('blur', function() { jmDebug('wireSuggest event=blur on input=' + inputId); });
  }
  document.addEventListener('click', function() { jmDebug('document click -> shareHideSuggests'); shareHideSuggests(); });

  // Custom dropdown replacing native <select> so the menu renders identically across platforms
  // (native <select> pops out an OS-drawn menu we can't style). The menu is absolutely
  // positioned so opening it does NOT grow the body and does NOT trigger a dialog resize.
  var shareAccessSelectedValue = 'org';
  var shareAccessSelect = document.getElementById('shareAccessSelect');
  var shareAccessMenu = document.getElementById('shareAccessMenu');
  var shareAccessValueText = document.getElementById('shareAccessValueText');

  function shareAccessValue() {
    return shareAccessSelectedValue || (shareCanOrg ? 'org' : 'people');
  }
  function shareAccessSetValue(v) {
    shareAccessSelectedValue = v;
    if (!shareAccessMenu) { return; }
    var opts = shareAccessMenu.querySelectorAll('.share-access-option');
    for (var i = 0; i < opts.length; i++) {
      var opt = opts[i];
      if (opt.getAttribute('data-value') === v) {
        if (shareAccessValueText) { shareAccessValueText.textContent = opt.textContent; }
        opt.classList.add('selected');
      } else {
        opt.classList.remove('selected');
      }
    }
  }
  function shareAccessOpen() {
    if (!shareAccessMenu) { return; }
    shareAccessMenu.hidden = false;
    if (shareAccessSelect) { shareAccessSelect.setAttribute('aria-expanded', 'true'); }
  }
  function shareAccessClose() {
    if (!shareAccessMenu) { return; }
    if (!shareAccessMenu.hidden) {
      shareAccessMenu.hidden = true;
      if (shareAccessSelect) { shareAccessSelect.setAttribute('aria-expanded', 'false'); }
    }
  }
  function shareAccessDescText(v) {
    if (v === 'public') { return 'Anyone with the link can open this — no account needed.'; }
    if (v === 'people') { return 'Only the people above can open this.'; }
    return 'Anyone in your Jolli Account can open this.';
  }
  function shareSyncAccessUi() {
    var v = shareAccessValue();
    var desc = document.getElementById('shareAccessDesc');
    if (desc) { desc.textContent = shareAccessDescText(v); }
  }

  if (shareAccessSelect && shareAccessMenu) {
    shareAccessSelect.addEventListener('click', function(e) {
      e.stopPropagation();
      if (shareAccessMenu.hidden) { shareAccessOpen(); } else { shareAccessClose(); }
    });
    var opts = shareAccessMenu.querySelectorAll('.share-access-option');
    for (var i = 0; i < opts.length; i++) {
      (function(opt) {
        opt.addEventListener('click', function(e) {
          e.stopPropagation();
          if (opt.disabled || opt.hidden) { return; }
          var v = opt.getAttribute('data-value');
          shareAccessSetValue(v);
          shareAccessClose();
          shareUserPickedTier = v;
          shareSyncAccessUi();
          if (!shareLink || shareLink.visibility !== v) {
            shareSetSyncBadge('loading');
            jmSend({ command: 'shareSetAccess', visibility: v });
          }
        });
      })(opts[i]);
    }
    shareAccessMenu.addEventListener('click', function(e) { e.stopPropagation(); });
    // Close on outside click or Escape (piggy-back on the existing document click handler below).
    document.addEventListener('click', shareAccessClose);
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && shareAccessMenu && !shareAccessMenu.hidden) { shareAccessClose(); }
    });
  }

  var shareCopyBtn = document.getElementById('shareCopyBtn');
  var shareCopyBtnLabel = shareCopyBtn ? shareCopyBtn.innerHTML : '';
  function shareResetCopyBtn() {
    if (shareCopyBtn) { shareCopyBtn.disabled = false; shareCopyBtn.innerHTML = shareCopyBtnLabel; }
  }
  if (shareCopyBtn) {
    shareCopyBtn.addEventListener('click', function() {
      var v = shareAccessValue();
      shareCopyBtn.disabled = true;
      shareCopyBtn.innerHTML = '⏳ Copying…';
      jmSend({ command: 'shareCopyLink', visibility: v });
    });
  }

  var shareToastTimer = null;
  function shareShowToast(msg) {
    var t = document.getElementById('shareToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'shareToast';
      t.className = 'share-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('on');
    if (shareToastTimer) { clearTimeout(shareToastTimer); }
    shareToastTimer = setTimeout(function() { t.classList.remove('on'); }, 2200);
  }

  function shareFlashCopy(ok) {
    shareResetCopyBtn();
    if (ok) { shareShowToast('Link copied: opens the shared page'); }
  }

  function shareRenderInvitePending() {
    var box = document.getElementById('shareInviteTo');
    if (!box) { return; }
    box.innerHTML = '';
    if (shareInvitePending.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'share-invite-empty';
      empty.textContent = 'No one added yet — search below.';
      box.appendChild(empty);
    }
    shareInvitePending.forEach(function(e) {
      var row = document.createElement('span');
      row.className = 'share-recip';
      var av = document.createElement('span');
      av.className = 'share-avatar';
      av.textContent = shareInitials(shareResolveName(e), e);
      var main = document.createElement('span');
      main.className = 'share-recip-main';
      var nm = document.createElement('span');
      nm.className = 'share-recip-name';
      nm.textContent = shareResolveName(e);
      var em = document.createElement('span');
      em.className = 'share-recip-email';
      em.textContent = e;
      main.appendChild(nm); main.appendChild(em);
      row.appendChild(av); row.appendChild(main);
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'share-recip-x';
      rm.title = 'Remove ' + e;
      rm.setAttribute('aria-label', 'Remove ' + e);
      rm.textContent = '×';
      rm.addEventListener('click', function() {
        shareInvitePending = shareInvitePending.filter(function(x) { return x !== e; });
        shareRenderInvitePending();
      });
      row.appendChild(rm);
      box.appendChild(row);
    });
    var send = document.getElementById('shareInviteSend');
    if (send) { send.disabled = shareInvitePending.length === 0; }
    var count = document.getElementById('shareInviteSendCount');
    if (count) { count.textContent = shareInvitePending.length > 1 ? String(shareInvitePending.length) : ''; }
  }

  function shareSetInviting(on) {
    var card = document.querySelector('.share-modal');
    if (card) { card.classList.toggle('inviting', !!on); }
  }

  function shareInviteEnter() {
    if (shareInvitePending.length <= 1) {
      var msgBox = document.getElementById('shareInviteMessage');
      if (msgBox) { msgBox.value = ''; }
    }
    var input = document.getElementById('shareInviteSearch');
    if (input) { input.value = ''; }
    shareRenderInvitePending();
    shareSetInviting(true);
    sharePane('sharePaneInvite');
    if (input) { setTimeout(function() { input.focus(); }, 20); }
  }

  function shareInviteLeave() {
    shareInvitePending = [];
    shareSetInviting(false);
    sharePane('sharePaneMain');
  }

  function shareStagePending(email) {
    var lower = (email || '').trim().toLowerCase();
    if (!lower) { return; }
    if (shareInvitePending.indexOf(lower) === -1) { shareInvitePending = shareInvitePending.concat([lower]); }
  }

  var shareModalClose = document.getElementById('shareModalClose');
  if (shareModalClose) { shareModalClose.addEventListener('click', shareClose); }
  if (shareOverlay) {
    shareOverlay.addEventListener('click', function(e) { if (e.target === shareOverlay) { shareClose(); } });
  }
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (shareOverlay && !shareOverlay.hidden) { shareClose(); }
      else if (window.SHARE_STANDALONE) { shareClose(); }
    }
  });

  var shareRetryBtn = document.getElementById('shareRetryBtn');
  if (shareRetryBtn) { shareRetryBtn.addEventListener('click', function() { shareOpen(); }); }

  var shareInviteBack = document.getElementById('shareInviteBack');
  if (shareInviteBack) { shareInviteBack.addEventListener('click', shareInviteLeave); }
  var shareInviteCancel = document.getElementById('shareInviteCancel');
  if (shareInviteCancel) { shareInviteCancel.addEventListener('click', shareInviteLeave); }

  var shareInviteSend = document.getElementById('shareInviteSend');
  if (shareInviteSend) {
    shareInviteSend.addEventListener('click', function() {
      if (shareInvitePending.length === 0) { return; }
      var msgBox = document.getElementById('shareInviteMessage');
      var note = msgBox && msgBox.value ? msgBox.value.trim() : '';
      var payload = { command: 'shareSendInvite', recipients: shareInvitePending.slice(), visibility: shareAccessValue() };
      if (note) { payload.message = note; }
      jmSend(payload);
      shareInvitePending = [];
      shareSetInviting(false);
      shareClose();
    });
  }

  shareWireSuggest('shareTeammateSearch', 'shareSuggest', function(email) {
    shareStagePending(email);
    shareInviteEnter();
  });
  shareWireSuggest('shareInviteSearch', 'shareInviteSuggest', function(email) {
    shareStagePending(email);
    shareRenderInvitePending();
  });

  function shareRender(state) {
    if (!state) { return; }
    if (state.kind === 'needsApiKey') { shareSetSyncBadge('hide'); sharePane('sharePaneNoKey'); return; }
    if (state.kind === 'ready') { shareRenderMain(state); return; }
    if (state.kind === 'loading') {
      var lbl = document.getElementById('shareLoadingLabel');
      if (lbl && state.label) { lbl.textContent = state.label; }
      shareSetSyncBadge('loading');
      sharePane('sharePaneLoading');
      return;
    }
    if (state.kind === 'error') {
      var em = document.getElementById('shareErrorMsg');
      if (em) { em.textContent = state.message || 'Something went wrong.'; }
      shareSetSyncBadge('hide');
      sharePane('sharePaneError');
      return;
    }
  }

  if (window.SHARE_STANDALONE) {
    if (window.ResizeObserver) {
      var shareRo = new ResizeObserver(function() { shareReportSize(); });
      if (document.body) { shareRo.observe(document.body); }
      var card = document.querySelector('.share-modal');
      if (card) { shareRo.observe(card); }
    }
    // Fallback: poll for size changes for the first few seconds so the dialog resizes even
    // when ResizeObserver fires before content has fully laid out (or is unavailable).
    var sharePollCount = 0;
    var sharePollTimer = setInterval(function() {
      shareReportSize();
      if (++sharePollCount >= 30) { clearInterval(sharePollTimer); }
    }, 150);
  }

  function shareRenderMain(state) {
    shareResetCopyBtn();
    shareLink = state.share || null;
    shareAccountMembers = state.accountMembers || [];
    shareGitCollaborators = state.gitCollaborators || [];
    shareCanOrg = !!state.canOrg;
    shareOwnerEmail = state.owner ? (state.owner.email || '') : '';
    shareOwnerName = state.owner ? (state.owner.name || '') : '';
    jmDebug('renderMain: accountMembers=' + shareAccountMembers.length
      + ' gitCollaborators=' + shareGitCollaborators.length
      + ' canOrg=' + shareCanOrg
      + ' owner=' + shareOwnerEmail
      + ' hasShare=' + (shareLink ? 'yes' : 'no')
      + ' recipients=' + (shareLink && shareLink.recipients ? shareLink.recipients.length : 0));
    var titleEl = document.getElementById('shareModalTitle');
    if (titleEl) { titleEl.textContent = (state.subject && state.subject.indexOf('commit') >= 0) ? 'Share this memory' : 'Share this branch'; }
    var sub = document.getElementById('shareModalSub');
    if (sub) {
      var n = state.decisionCount || 0;
      sub.textContent = (state.subjectTitle || state.subject || state.branch) + ' · ' + n + ' decision' + (n === 1 ? '' : 's');
    }
    var orgOption = document.getElementById('shareOrgOption');
    if (orgOption) {
      orgOption.disabled = !shareCanOrg;
      orgOption.hidden = !shareCanOrg;
      orgOption.textContent = 'Anyone within your Jolli Account';
    }
    shareAccessSetValue(shareLink
      ? shareLink.visibility
      : (shareUserPickedTier || (shareCanOrg ? 'org' : 'people')));
    shareSyncAccessUi();
    shareRenderInvited();
    shareInvitePending = [];
    shareSetInviting(false);
    var mainSearch = document.getElementById('shareTeammateSearch');
    if (mainSearch) { mainSearch.value = ''; }
    shareHideSuggests();
    shareSetSyncBadge(shareLink ? 'ready' : 'hide');
    sharePane('sharePaneMain');
  }"""

    /**
     * The full standalone HTML document for the JCEF share dialog. [css] is the summary stylesheet
     * (which already includes [css]() via SummaryCssBuilder); [bridgeScript] defines `window.__jbQuery`.
     */
    fun standaloneDocument(css: String, bridgeScript: String): String = """<!doctype html>
<html>
<head><meta charset="UTF-8" />
<style>
$css
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text-primary); }
</style>
</head>
<body>
${standaloneBody()}
<script>$bridgeScript</script>
<script>
  window.SHARE_STANDALONE = true;
  function jmSend(msg) {
    if (!window.__jbQuery) return;
    var json = JSON.stringify(msg);
    var bytes = new TextEncoder().encode(json);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) { binary += String.fromCharCode(bytes[i]); }
    window.__jbQuery(btoa(binary));
  }
${renderScript()}
  window.addEventListener('jollimemory', function(e) {
    var msg = e.detail;
    if (msg.command === 'shareState') { shareRender(msg.state); }
    else if (msg.command === 'shareCopyResult') { shareFlashCopy(msg.ok === true); }
  });
  shareOpen();
</script>
</body>
</html>"""
}
