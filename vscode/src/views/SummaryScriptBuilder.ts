/**
 * SummaryScriptBuilder
 *
 * Returns the JavaScript embedded in the webview for interactive behaviors:
 * toggle expand/collapse, copy hash, copy markdown, push to Jolli, memory
 * edit/delete, and E2E test guide CRUD. The Create PR flow lives in its own
 * pane (CreatePrHtmlBuilder/CreatePrWebviewPanel), so this script no longer
 * wires PR section interactions.
 *
 * Pure string template — no logic dependencies on other view modules.
 */

import { buildContextMenuGuardScript } from "./ContextMenuGuard.js";
import { buildSourceLabelScript } from "./TranscriptEntryRenderer.js";

/** Share-entry options threaded from the panel into the webview script. */
export interface SummaryScriptOptions {
	/**
	 * Kind of the single header Share button — follows the panel's ENTRY so the
	 * button stays consistent with how the user got here: opened via the
	 * sidebar's "Share this branch" → `"branch"`; every other entry (commit
	 * click, per-memory share icon) → `"commit"`. There is no ▾ menu — the
	 * branch/memory choice lives in the sidebar's two share entries.
	 */
	readonly defaultShareKind?: "branch" | "commit";
	/**
	 * One-shot: open the share modal (at `defaultShareKind`) as soon as the
	 * script loads — set when the panel was opened BY a share entry. Baked into
	 * the script rather than posted from the host because a message sent right
	 * after `webview.html` assignment can race the listener setup and get
	 * dropped.
	 */
	readonly autoOpenShare?: boolean;
}

/** Returns the JavaScript for toggle interactions and the Copy Markdown button. */
export function buildScript(options: SummaryScriptOptions = {}): string {
	const defaultShareKind = options.defaultShareKind === "branch" ? "branch" : "commit";
	return `
  ${buildContextMenuGuardScript()}

  const vscode = acquireVsCodeApi();

  // Toggle expand/collapse for individual memory sections (skip clicks on action buttons).
  // Idempotent so attachE2eHandlers can safely revisit headers after section replacement.
  function attachToggleHeader(header) {
    if (header._toggleAttached) { return; }
    header._toggleAttached = true;
    header.addEventListener('click', function(e) {
      if (e.target.closest('.topic-actions')) { return; }
      header.parentElement.classList.toggle('collapsed');
    });
  }
  document.querySelectorAll('.toggle-header').forEach(attachToggleHeader);

  // ── Redesign v2: Details disclosure ──
  // Net-new presentational toggle, bound once at load (the header is never
  // replaced). Ships with .collapsed by default.
  var detailsToggle = document.getElementById('detailsToggle');
  if (detailsToggle) {
    detailsToggle.addEventListener('click', function() {
      var t = document.getElementById('propTable');
      if (!t) { return; }
      var open = t.classList.toggle('collapsed') === false;
      detailsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      detailsToggle.textContent = open ? 'Details \\u25B4' : 'Details \\u25BE';
    });
  }
  // The generic [data-collapse] head->target collapse binding (formerly used
  // by the Attachments & context panel's .attach-card wrappers) was removed
  // alongside that panel — the flat Context panel (buildContextPanel) has no
  // collapsible cards, and no other markup emits data-collapse.

  // ── Token meter (.tmeter): segment widths + help popover pin ──
  // Segment widths cannot be inline style="width" — the webview CSP has no
  // unsafe-inline for styles. buildTokenMeter emits each segment with a
  // data-pct attribute instead; a JS property write (el.style.width) is
  // allowed even though an inline style attribute is not, so we set it here.
  document.querySelectorAll('.tmeter-bar [data-pct]').forEach(function(el) {
    el.style.width = el.dataset.pct + '%';
  });
  // The '?' help button toggles a pinned popover (click-to-pin rather than
  // hover-only, so it stays reachable on touch/keyboard). Clicking elsewhere
  // on the page closes any open popover.
  document.querySelectorAll('.tok-help').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var wrap = btn.closest('.tok-help-wrap');
      if (!wrap) { return; }
      var wasPinned = wrap.classList.contains('pinned');
      document.querySelectorAll('.tok-help-wrap.pinned').forEach(function(w) {
        w.classList.remove('pinned');
      });
      if (!wasPinned) { wrap.classList.add('pinned'); }
    });
  });
  document.addEventListener('click', function() {
    document.querySelectorAll('.tok-help-wrap.pinned').forEach(function(w) {
      w.classList.remove('pinned');
    });
  });

  // Hash copy button: copy full commit hash to clipboard inline
  document.querySelectorAll('.hash-copy').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const hash = btn.dataset.hash || '';
      navigator.clipboard.writeText(hash).then(function() {
        btn.classList.add('copied');
        const original = btn.textContent;
        btn.textContent = '\\u2713';
        setTimeout(function() {
          btn.textContent = original;
          btn.classList.remove('copied');
        }, 1500);
      });
    });
  });

  // Copy Markdown button with brief visual feedback
  var copyBtn = document.getElementById('copyMdBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', function() {
      vscode.postMessage({ command: 'copyMarkdown' });
      var original = copyBtn.textContent;
      copyBtn.textContent = 'Copied \\u2713';
      setTimeout(function() { copyBtn.textContent = original; }, 1500);
    });
  }

  // Export menu toggle (meta strip): holds Copy Markdown / Save as Markdown
  // File / Regenerate. Same open/close mechanics as the old copyMd split
  // button, just relocated + renamed to match the meta-strip redesign.
  var dropdownToggle = document.getElementById('exportMenuToggle');
  var dropdownMenu = document.getElementById('exportMenu');
  if (dropdownToggle && dropdownMenu) {
    dropdownToggle.addEventListener('click', function(e) {
      e.stopPropagation();
      dropdownMenu.classList.toggle('open');
    });
    // Close dropdown when clicking anywhere else
    document.addEventListener('click', function() {
      dropdownMenu.classList.remove('open');
    });
  }

  // Download .md button
  var downloadBtn = document.getElementById('downloadMdBtn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', function() {
      vscode.postMessage({ command: 'downloadMarkdown' });
      if (dropdownMenu) { dropdownMenu.classList.remove('open'); }
    });
  }

  // Push button (Jolli only — local push pathway was removed in 2026-05).
  // Always pushes: on a synced doc this re-uploads it in place ("Update on
  // Jolli"), otherwise it creates the doc ("Push to Jolli"). The existing
  // article is opened via the links in #jolliRow, not this button.
  var pushBtn = document.getElementById('pushJolliBtn');
  if (pushBtn) {
    pushBtn.addEventListener('click', function() {
      vscode.postMessage({ command: 'push' });
    });
  }

  // ── Share popover (live Space-backed share): this memory (commit) or whole branch ──
  // The redesigned header exposes Share via the meta-strip button (#metaShareBtn);
  // the old #shareBtn id was retired in the mockup alignment, so the popover
  // trigger + positioning anchor is #metaShareBtn.
  var shareOverlay = document.getElementById('shareOverlay');
  var shareBtn = document.getElementById('metaShareBtn');
  // Set on open; included in every share message so the host knows which subject
  // (this commit vs whole branch) to act on. Defaults to commit (the primary button).
  var shareKind = 'commit';
  function sharePane(id) {
    var panes = document.querySelectorAll('.share-pane');
    for (var i = 0; i < panes.length; i++) { panes[i].hidden = (panes[i].id !== id); }
    // A pane swap changes the card's height — drop any leftover inner scroll so the
    // new pane always shows from its top (a stale scroll made the card look broken).
    var card = shareOverlay ? shareOverlay.querySelector('.share-modal') : null;
    if (card) { card.scrollTop = 0; }
  }
  // Anchor the card under the Share button — the overlay is a transparent full-screen
  // click-catcher with no DOM relationship to the button, so position it in JS.
  function sharePositionCard() {
    if (!shareBtn || !shareOverlay) { return; }
    var card = shareOverlay.querySelector('.share-modal');
    if (!card) { return; }
    var r = shareBtn.getBoundingClientRect();
    // The Share button is left-aligned in the header, so open the card RIGHTWARD from
    // the button's left edge; clamp BOTH axes to the viewport so the card can never
    // detach off-screen (e.g. after a scroll or a pane swap that changes its height).
    var cardW = card.offsetWidth || 440;
    var cardH = card.offsetHeight || 300;
    var maxLeft = Math.max(8, window.innerWidth - cardW - 8);
    var left = Math.min(Math.max(8, Math.round(r.left)), maxLeft);
    var maxTop = Math.max(8, window.innerHeight - cardH - 8);
    var top = Math.min(Math.max(8, Math.round(r.bottom + 6)), maxTop);
    card.style.top = top + 'px';
    card.style.left = left + 'px';
    card.style.right = 'auto';
  }
  // Keep the card glued to its anchor while the page scrolls under the fixed overlay
  // (capture: the scroller is the document or any inner container).
  document.addEventListener('scroll', function() {
    if (shareOverlay && !shareOverlay.hidden) { sharePositionCard(); }
  }, true);
  // Lazy on open: the host only READS existing links (reconciling live branch
  // shares) and returns 'ready' — nothing is created until Copy / invite / org-on.
  function shareOpen(kind) {
    if (!shareOverlay) { return; }
    shareDefaultsPrefilled = false;
    // The explicit tier pick is in-session only — it must NOT leak into the next open of
    // a different subject (which has its own link tier / prior default). Without this, a
    // 'people' picked here would shadow the next subject's seeded default (issue #5).
    shareUserPickedTier = '';
    shareKind = (kind === 'branch') ? 'branch' : 'commit';
    // Text only — the share glyph is a sibling SVG in the modal head, so setting
    // textContent here must not wipe it.
    var title = document.getElementById('shareModalTitle');
    if (title) { title.textContent = (shareKind === 'branch') ? 'Share this branch' : 'Share this memory'; }
    shareOverlay.hidden = false;
    sharePositionCard();
    sharePane('sharePaneLoading');
    shareSetSyncBadge('loading');
    vscode.postMessage({ command: 'shareBranch', shareKind: shareKind });
  }
  function shareClose() {
    if (shareOverlay) { shareOverlay.hidden = true; }
  }

  // Single Share button (no ▾ menu — the branch/memory choice lives in the
  // sidebar's two entries). It re-shares at the panel's ENTRY kind: 'commit'
  // ("this memory") by default, 'branch' when the panel was opened via a
  // share-this-branch entry, so the button stays consistent with how the user
  // got here.
  var defaultShareKind = ${JSON.stringify(defaultShareKind)};
  if (shareBtn) {
    if (defaultShareKind === 'branch') { shareBtn.title = 'Share this branch as a read-only link'; }
    shareBtn.addEventListener('click', function() { shareClose(); shareOpen(defaultShareKind); });
  }

  var shareModalClose = document.getElementById('shareModalClose');
  if (shareModalClose) { shareModalClose.addEventListener('click', shareClose); }

  if (shareOverlay) {
    shareOverlay.addEventListener('click', function(e) { if (e.target === shareOverlay) { shareClose(); } });
  }
  window.addEventListener('resize', function() { if (shareOverlay && !shareOverlay.hidden) { sharePositionCard(); } });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && shareOverlay && !shareOverlay.hidden) { shareClose(); }
  });

  // Single-slot state: the subject's ONE link (access tier + invited people),
  // plus the two suggestion groups. Set on each render.
  var shareLink = null;              // { shareUrl, visibility: 'public'|'org'|'people', recipients[] } | null
  var shareAccountMembers = [];      // "From your Jolli account" (site members)
  var shareGitCollaborators = [];    // "From this repo" (git contributors)
  var shareCanOrg = false;
  var shareOwnerEmail = '';
  var shareOwnerName = '';
  var shareInvitePending = [];       // emails staged in the invite pane, sent on "Send invite"
  var shareUserPickedTier = '';      // the access tier the user explicitly chose (preserved across re-renders while no link exists)
  var shareDefaults = null;          // last-used {visibility, recipients[]} for a subject with no link (amend re-keyed it)
  var shareDefaultsPrefilled = false; // one prefill per modal open — a later ready re-render must not re-stage removed people
  function shareSetSyncBadge(mode) {
    var badge = document.getElementById('shareSyncBadge');
    if (!badge) { return; }
    if (mode === 'ready') { badge.textContent = '\\u25CF SYNCED'; badge.className = 'share-sync-badge synced'; badge.hidden = false; }
    else if (mode === 'loading') { badge.textContent = 'SYNCING\\u2026'; badge.className = 'share-sync-badge syncing'; badge.hidden = false; }
    else { badge.hidden = true; }
  }
  // Resolve a display name for an email from either suggestion group.
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
  // Remove an invited person from the member link (server-side; no email involved).
  function shareRemoveRecipient(email) {
    shareSetSyncBadge('loading');
    vscode.postMessage({ command: 'shareRemoveRecipient', email: email, shareKind: shareKind });
  }
  function shareInitials(name, email) {
    var src = (name || '').trim() || (email || '').trim();
    if (!src) { return '?'; }
    var parts = src.split(/\\s+/);
    if (name && parts.length >= 2) { return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase(); }
    return src.slice(0, 2).toUpperCase();
  }
  // Builds one person row (avatar + name + email). Rows use textContent so
  // names/emails can never inject HTML. onRemove null = fixed Owner row.
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
      // Mockup: an ellipsis "Manage access" menu with a Remove-access item.
      var wrap = document.createElement('span');
      wrap.className = 'share-role-wrap';
      var dots = document.createElement('button');
      dots.type = 'button';
      dots.className = 'share-collab-menu-btn';
      dots.title = 'Manage access';
      dots.setAttribute('aria-label', 'Manage access for ' + (email || ''));
      dots.textContent = '\\u22EF';
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
  // Member block: the fixed Owner row + each invited person (server-confirmed).
  function shareRenderInvited() {
    var box = document.getElementById('shareInvitedList');
    if (!box) { return; }
    box.innerHTML = '';
    box.appendChild(shareRowEl(shareOwnerName || shareOwnerEmail, shareOwnerEmail, true, null));
    (shareLink && shareLink.recipients ? shareLink.recipients : []).forEach(function(e) {
      box.appendChild(shareRowEl(shareResolveName(e), e, false, shareRemoveRecipient));
    });
  }
  var EMAIL_RE = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
  // Emails that shouldn't be suggested again: the owner, already-invited people,
  // and anything staged in the invite pane.
  function shareExcludedEmails() {
    var inList = {};
    if (shareOwnerEmail) { inList[shareOwnerEmail.toLowerCase()] = true; }
    (shareLink && shareLink.recipients ? shareLink.recipients : []).forEach(function(e) { inList[e.toLowerCase()] = true; });
    shareInvitePending.forEach(function(e) { inList[e.toLowerCase()] = true; });
    return inList;
  }
  // Grouped suggestions panel (inline, pushes content down), reusable for any
  // (input, box) pair. Focus with an empty query shows the groups in full
  // (scrollable, 100 per group); typing filters. Any typed address matching
  // EMAIL_RE gets a trailing "Invite by email" row (no domain restriction).
  // Picking calls onPick(email).
  function shareRenderSuggestInto(inputEl, boxEl, onPick) {
    if (!boxEl) { return; }
    boxEl.innerHTML = '';
    var query = (inputEl && inputEl.value ? inputEl.value : '').trim().toLowerCase();
    var inList = shareExcludedEmails();
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
    if (EMAIL_RE.test(raw) && !inList[raw.toLowerCase()]) {
      var head2 = document.createElement('div');
      head2.className = 'share-suggest-group';
      head2.textContent = 'Invite by email';
      boxEl.appendChild(head2);
      boxEl.appendChild(itemEl({ name: raw, email: raw }));
    }
    boxEl.hidden = boxEl.children.length === 0;
  }
  function shareHideSuggests() {
    var boxes = document.querySelectorAll('.share-suggest');
    for (var i = 0; i < boxes.length; i++) { boxes[i].hidden = true; boxes[i].innerHTML = ''; }
  }
  // Wires one search input to its grouped dropdown: opens on focus (empty query
  // shows everything), filters on input, Enter adds a typed email directly, and
  // clicks are swallowed so the global click-away handler doesn't close it.
  function shareWireSuggest(inputId, boxId, onPick) {
    var input = document.getElementById(inputId);
    var box = document.getElementById(boxId);
    if (!input || !box) { return; }
    var render = function() { shareRenderSuggestInto(input, box, onPick); };
    input.addEventListener('focus', render);
    input.addEventListener('input', render);
    input.addEventListener('keydown', function(e) {
      if (e.key !== 'Enter') { return; }
      e.preventDefault();
      var raw = (input.value || '').trim();
      if (EMAIL_RE.test(raw) && !shareExcludedEmails()[raw.toLowerCase()]) {
        input.value = '';
        shareHideSuggests();
        onPick(raw);
      }
    });
    input.addEventListener('click', function(e) { e.stopPropagation(); });
  }
  document.addEventListener('click', shareHideSuggests);
  var shareRetryBtn = document.getElementById('shareRetryBtn');
  if (shareRetryBtn) { shareRetryBtn.addEventListener('click', function() { shareOpen(shareKind); }); }
  // ── General access select: the single link's access tier. ──
  // 'public' = bearer (anyone with the link); 'org' = any signed-in member ∪
  // invited people; 'people' = invited people only. Changing it flips the one link.
  function shareAccessValue() {
    var sel = document.getElementById('shareAccessSelect');
    return sel && sel.value ? sel.value : (shareCanOrg ? 'org' : 'people');
  }
  function shareAccessDescText(v) {
    if (v === 'public') { return 'Anyone with the link can open this \\u2014 no account needed.'; }
    if (v === 'people') { return 'Only the people above can open this.'; }
    return 'Anyone in your Jolli Account can open this.';
  }
  function shareSyncAccessUi() {
    var v = shareAccessValue();
    var desc = document.getElementById('shareAccessDesc');
    if (desc) { desc.textContent = shareAccessDescText(v); }
  }
  var shareAccessSelect = document.getElementById('shareAccessSelect');
  if (shareAccessSelect) {
    shareAccessSelect.addEventListener('click', function(e) { e.stopPropagation(); });
    shareAccessSelect.addEventListener('change', function() {
      var v = shareAccessSelect.value;
      // Remember the explicit choice so a re-render with no minted link yet (e.g.
      // 'people' waiting for its first invite) doesn't snap the dropdown back to the
      // default tier — which would silently widen the access the user just narrowed.
      shareUserPickedTier = v;
      shareSyncAccessUi();
      // Flip the single link to the chosen tier. When a link already exists the host
      // PATCHes it in place (the old URL dies); with no link yet, 'public'/'org' mint
      // one and 'people' waits for the first invite. Skip the no-op (tier unchanged).
      if (!shareLink || shareLink.visibility !== v) {
        shareSetSyncBadge('loading');
        vscode.postMessage({ command: 'shareSetAccess', visibility: v, shareKind: shareKind });
      }
    });
  }
  var shareCopyBtn = document.getElementById('shareCopyBtn');
  // The default label, captured so the waiting state can be restored verbatim.
  var shareCopyBtnLabel = shareCopyBtn ? shareCopyBtn.innerHTML : '';
  function shareResetCopyBtn() {
    if (shareCopyBtn) { shareCopyBtn.disabled = false; shareCopyBtn.innerHTML = shareCopyBtnLabel; }
  }
  if (shareCopyBtn) {
    shareCopyBtn.addEventListener('click', function() {
      var v = shareAccessValue();
      // The card doesn't move; but until the host's shareCopyResult ack the link may
      // still be minting (a network round-trip) AND the clipboard write hasn't run —
      // so show an explicit waiting label, or the user thinks they already have the URL.
      shareCopyBtn.disabled = true;
      shareCopyBtn.innerHTML = '\\u23F3 Copying\\u2026';
      vscode.postMessage({ command: 'shareCopyLink', visibility: v, shareKind: shareKind });
    });
  }
  // Bottom-of-card toast (mockup's confirmation style — the button itself never changes).
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
  // Copy ack from the host (the clipboard write happens host-side — postMessage
  // has no return channel for the URL): re-enable the button, toast on success.
  function shareFlashCopy(ok) {
    shareResetCopyBtn();
    if (ok) { shareShowToast('Link copied: opens the shared page'); }
  }

  // ── Send invite sub-pane: stage people locally, send once (server grants + emails). ──
  function shareRenderInvitePending() {
    var box = document.getElementById('shareInviteTo');
    if (!box) { return; }
    box.innerHTML = '';
    if (shareInvitePending.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'share-invite-empty';
      empty.textContent = 'No one added yet \\u2014 search below.';
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
      rm.textContent = '\\u00D7';
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
  // Entering invite mode happens by PICKING someone in the main search (mockup flow:
  // the default pane shows Copy link; Cancel/Send invite only appear once a teammate
  // is staged). Fresh entry clears the note; the picked person is already staged.
  // The card swaps wholesale: its own title/subtitle hide (the .inviting class).
  function shareSetInviting(on) {
    var card = shareOverlay ? shareOverlay.querySelector('.share-modal') : null;
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
    sharePositionCard();
    // Mockup behavior: keep momentum — the "Add another" input takes focus.
    if (input) { setTimeout(function() { input.focus(); }, 20); }
  }
  function shareInviteLeave() {
    shareInvitePending = [];
    shareSetInviting(false);
    sharePane('sharePaneMain');
    sharePositionCard();
  }
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
      // Carry the selected access tier so the FIRST invite mints the link at the tier
      // the user picked (e.g. "Anyone within your Jolli Account") — not always people-only.
      var payload = { command: 'shareSendInvite', recipients: shareInvitePending.slice(), visibility: shareAccessValue(), shareKind: shareKind };
      if (note) { payload.message = note; }
      vscode.postMessage(payload);
      // Sending CLOSES the share popover — the host's toasts report the outcome,
      // and reopening Share shows the invitees in Collaborators (server-confirmed).
      shareInvitePending = [];
      shareSetInviting(false);
      shareClose();
    });
  }
  function shareStagePending(email) {
    var lower = (email || '').trim().toLowerCase();
    if (!lower) { return; }
    if (shareInvitePending.indexOf(lower) === -1) { shareInvitePending = shareInvitePending.concat([lower]); }
  }
  // Main-pane search: picking a teammate stages them and flips into invite mode
  // (Cancel / Send invite). The invite pane's "Add another" stages in place.
  shareWireSuggest('shareTeammateSearch', 'shareSuggest', function(email) {
    shareStagePending(email);
    shareInviteEnter();
  });
  shareWireSuggest('shareInviteSearch', 'shareInviteSuggest', function(email) {
    shareStagePending(email);
    shareRenderInvitePending();
  });

  function shareRender(state) {
    if (!state || !shareOverlay) { return; }
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

  // The main pane (mockup layout): search → Collaborators → General access select →
  // banner → single Copy link. The select sets the one link's access tier;
  // Copy copies it (minting on first use).
  function shareRenderMain(state) {
    // Defensive: a ready re-render always leaves the Copy button usable + relabeled,
    // in case an action returned without a shareCopyResult ack (disabled on click).
    shareResetCopyBtn();
    shareLink = state.share || null;
    shareAccountMembers = state.accountMembers || [];
    shareGitCollaborators = state.gitCollaborators || [];
    shareCanOrg = !!state.canOrg;
    shareOwnerEmail = state.owner ? (state.owner.email || '') : '';
    shareOwnerName = state.owner ? (state.owner.name || '') : '';
    var sub = document.getElementById('shareModalSub');
    if (sub) {
      var n = state.decisionCount || 0;
      sub.textContent = (state.subjectTitle || state.subject || state.branch) + ' \\u00B7 ' + n + ' decision' + (n === 1 ? '' : 's');
    }
    var orgOption = document.getElementById('shareOrgOption');
    if (orgOption) {
      orgOption.disabled = !shareCanOrg;
      orgOption.hidden = !shareCanOrg;
      orgOption.textContent = 'Anyone within your Jolli Account';
    }
    shareDefaults = state.defaults || null;
    // Preselect the access that matches the existing link's tier. With no link yet,
    // keep whatever tier the user explicitly picked (so selecting "people" isn't
    // reverted to the org default and later Copy-minted as an org link); then the
    // branch's last-used tier (the previous subject was re-keyed by an amend); on the
    // first render (nothing picked, no history) fall back to org — or "only people
    // you add" without an org-carrying key — so a public share is always explicit.
    if (shareAccessSelect) {
      var seededTier;
      if (shareLink) {
        // A real link: show its actual tier verbatim — never clamp, or an existing org
        // link would misrender as 'people' if the key's org capability later lapsed.
        seededTier = shareLink.visibility;
      } else {
        seededTier = shareUserPickedTier || (shareDefaults && shareDefaults.visibility) || (shareCanOrg ? 'org' : 'people');
        // Clamp only the SEEDED (no-link) tier to what THIS key can back: a seeded 'org'
        // from a prior share (or a stale picked tier) is invalid when the current key has
        // no org — the org <option> is hidden+disabled, so 'org' would leave the select on a
        // tier the UI can't represent and a later Copy/mint would use an org tier the key
        // can't carry. Fall to 'people'.
        if (seededTier === 'org' && !shareCanOrg) { seededTier = 'people'; }
      }
      shareAccessSelect.value = seededTier;
    }
    shareSyncAccessUi();
    shareRenderInvited();
    // No link but the branch has last-used people (the previous commit share's subject
    // was stranded by an amend): restore them ONCE per open — staged in invite mode so a
    // single "Send invite" re-grants everyone on the fresh link. Cancel drops to the
    // normal main pane; nothing is granted until the user sends.
    if (!shareLink && !shareDefaultsPrefilled && shareDefaults
        && shareDefaults.recipients && shareDefaults.recipients.length > 0) {
      shareDefaultsPrefilled = true;
      shareInvitePending = [];
      shareDefaults.recipients.forEach(function(e) { shareStagePending(e); });
      var prefillSearch = document.getElementById('shareTeammateSearch');
      if (prefillSearch) { prefillSearch.value = ''; }
      shareHideSuggests();
      shareSetSyncBadge('hide');
      shareInviteEnter();
      return;
    }
    // A ready render always lands on the main pane: drop any staged-but-unsent
    // invitees (a completed send re-renders here too) and reset the search box.
    shareInvitePending = [];
    shareSetInviting(false);
    var mainSearch = document.getElementById('shareTeammateSearch');
    if (mainSearch) { mainSearch.value = ''; }
    shareHideSuggests();
    shareSetSyncBadge(shareLink ? 'ready' : 'hide');
    sharePane('sharePaneMain');
    sharePositionCard();
  }

  // Stale-readonly banner: "Open new commit's summary" button. The live
  // root hash is rendered into data-target-hash by buildHtml; the
  // extension routes the message to jollimemory.viewSummary.
  var staleOpenBtn = document.getElementById('staleOpenNewBtn');
  if (staleOpenBtn) {
    staleOpenBtn.addEventListener('click', function() {
      var hash = staleOpenBtn.getAttribute('data-target-hash');
      if (hash) {
        vscode.postMessage({ command: 'openRewrittenCommit', hash: hash });
      }
    });
  }

  // Listen for messages from the extension (push + topic edit status updates).
  // The push button is disabled on 'pushStarted' and re-enabled on
  // 'pushToJolliResult'. Success/failure feedback comes via vscode
  // notifications and the panel re-render on success — the button label
  // itself is never changed mid-push.
  window.addEventListener('message', function(event) {
    var msg = event.data;

    // ── Share modal state ──
    if (msg.command === 'shareState') {
      shareRender(msg.state);
    }
    if (msg.command === 'shareCopyResult') {
      shareFlashCopy(msg.ok === true);
    }

    // ── Push status ──
    if (pushBtn && msg.command === 'pushStarted') {
      pushBtn.disabled = true;
    }
    if (pushBtn && msg.command === 'pushToJolliResult') {
      pushBtn.disabled = false;
    }

    // ── Memory edit status ──
    if (msg.command === 'topicUpdated' && typeof msg.topicIndex === 'number' && msg.html) {
      var oldToggle = document.getElementById('topic-' + msg.topicIndex);
      if (oldToggle) {
        // Clean up ESC handler if still in edit mode
        if (oldToggle._escHandler) {
          document.removeEventListener('keydown', oldToggle._escHandler);
        }
        // Preserve the collapsed state across the re-render. Topics collapse via
        // the "collapsed" class ("open" is for dropdown menus / the snippet form),
        // so the prior "open" snapshot here was a no-op that silently dropped the
        // collapse state on every single-topic edit.
        var wasCollapsed = oldToggle.classList.contains('collapsed');
        // Replace with server-rendered HTML
        var wrapper = document.createElement('div');
        wrapper.innerHTML = msg.html;
        var newToggle = wrapper.firstElementChild;
        if (newToggle) {
          oldToggle.replaceWith(newToggle);
          if (wasCollapsed) { newToggle.classList.add('collapsed'); }
          // Re-attach edit/delete button handlers on the new element
          attachTopicHandlers(newToggle);
        }
      }
    } else if (msg.command === 'topicUpdateError') {
      // Re-enable save/cancel buttons so the user can retry
      var editingToggle = document.querySelector('.toggle.editing');
      if (editingToggle) {
        var saveBtn = editingToggle.querySelector('.edit-save-btn');
        var cancelBtn = editingToggle.querySelector('.edit-cancel-btn');
        if (saveBtn) { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }
        if (cancelBtn) { cancelBtn.disabled = false; }
      }
    }

    // ── Topics whole-section replace (after a topic delete) ──
    // Topic edit/delete buttons carry positional treeIndex values; deleting one
    // shifts every later index, so we rebuild the whole #topicsSection rather
    // than removing a single node. But a blind rebuild would re-expand the
    // topics the user had collapsed, so we snapshot each surviving topic's
    // collapsed state — keyed by its data-topic payload, which is stable across
    // the treeIndex renumbering (the topic-<index> id is NOT) — and restore it
    // after the replace, then recompute allCollapsed so the #toggleAllBtn label
    // stays accurate. Editing ESC handlers are also cleaned up before the nodes
    // are discarded (partial replace keeps the JS context, so a leaked global
    // keydown would accumulate).
    if (msg.command === 'topicsUpdated' && typeof msg.html === 'string') {
      var oldTopicsSec = document.getElementById('topicsSection');
      var collapseByTopic = {};
      if (oldTopicsSec) {
        oldTopicsSec.querySelectorAll('.toggle').forEach(function(t) {
          var key = t.getAttribute('data-topic');
          if (key) collapseByTopic[key] = t.classList.contains('collapsed');
          if (t.classList.contains('editing') && t._escHandler) {
            document.removeEventListener('keydown', t._escHandler);
          }
        });
      }
      replaceSection('topicsSection', msg.html);
      var newTopicsSec = document.getElementById('topicsSection');
      var topicCount = 0;
      var everyCollapsed = true;
      if (newTopicsSec) {
        attachTopicHandlers(newTopicsSec);
        newTopicsSec.querySelectorAll('.toggle-header').forEach(attachToggleHeader);
        newTopicsSec.querySelectorAll('.toggle').forEach(function(t) {
          topicCount++;
          var key = t.getAttribute('data-topic');
          if (key && collapseByTopic[key]) t.classList.add('collapsed');
          if (!t.classList.contains('collapsed')) everyCollapsed = false;
        });
      }
      allCollapsed = topicCount > 0 && everyCollapsed;
      attachToggleAllBtnHandler();
    }

    // ── Recap edit / generate status ──
    if (msg.command === 'recapUpdated' && msg.html) {
      // Server re-renders the whole recap section so we get the canonical HTML
      // (handles the empty-recap → section-removed case automatically too).
      var oldRecap = document.getElementById('recapSection');
      if (oldRecap) {
        var oldSep = oldRecap.nextElementSibling;
        if (msg.html.trim().length === 0) {
          // Empty recap after edit — remove section + trailing separator.
          if (oldSep && oldSep.tagName === 'HR') oldSep.remove();
          oldRecap.remove();
        } else {
          var recapWrap = document.createElement('div');
          recapWrap.innerHTML = msg.html;
          // The buildRecapSection result contains <div class="section">…</div><hr/>.
          // Replace the old section + its trailing <hr> with the new pair.
          var nodes = Array.prototype.slice.call(recapWrap.childNodes).filter(function(n) { return n.nodeType === 1; });
          if (oldSep && oldSep.tagName === 'HR') oldSep.remove();
          oldRecap.replaceWith.apply(oldRecap, nodes);
          // Reattach BOTH handlers: edit (state-2 only) and generate/regen
          // (state-1 has only Generate button, state-2 has only Regenerate).
          // Both attach functions internally null-check the buttons so calling
          // them in either state is safe.
          attachEditRecapHandler();
          attachGenerateRecapHandler();
        }
      }
    } else if (msg.command === 'recapUpdateError') {
      // Edit-mode failure — restore Save/Cancel button state.
      var editingRecap = document.querySelector('.recap-section.recap-editing');
      if (editingRecap) {
        var rSave = editingRecap.querySelector('.recap-edit-actions .primary');
        var rCancel = editingRecap.querySelector('.recap-edit-actions .action-btn');
        if (rSave) { rSave.textContent = 'Save'; rSave.disabled = false; }
        if (rCancel) { rCancel.disabled = false; }
      }
      // Generate-mode failure — restore button labels and clear the
      // .generating spinning state on the regen icon. The section is
      // never simultaneously editing and generating, so this is independent.
      var genBtn2 = document.getElementById('generateRecapBtn');
      var regenBtn2 = document.getElementById('regenerateRecapBtn');
      if (genBtn2) {
        genBtn2.textContent = '\\u2728 Generate';
        genBtn2.disabled = false;
      }
      if (regenBtn2) {
        regenBtn2.classList.remove('generating');
        regenBtn2.title = 'Regenerate';
        regenBtn2.disabled = false;
      }
    }

    // ── Regenerate summary status ──
    // Lifecycle:
    //   summaryRegenerating  → enter regenerating-readonly mode (CSS hides
    //                          every action button via the foreign-safe
    //                          allow-list), insert the top-of-page banner
    //   summaryRegenerated   → swap in new topics/recap HTML, leave
    //                          regenerating-readonly mode, remove banner
    //   summaryRegenerateError → leave regenerating-readonly mode, remove
    //                          banner; topics/recap DOM untouched
    if (msg.command === 'summaryRegenerating') {
      enterRegeneratingReadonly();
      return;
    }
    if (msg.command === 'summaryRegenerated') {
      if (msg.topicsHtml) replaceSection('topicsSection', msg.topicsHtml);
      if (msg.recapHtml) replaceSection('recapSection', msg.recapHtml);
      // Banner replace/remove: empty string → remove existing banner;
      // non-empty → replace existing (outerHTML) or insert at top of .page.
      // The click delegate (attachRegenerateSummaryDelegate) is bound on
      // .page so any newly-inserted #summaryErrorRegenerateBtn is picked
      // up without re-binding.
      if (typeof msg.summaryErrorBannerHtml === 'string') {
        var existingBanner = document.querySelector('.summary-error-banner');
        if (msg.summaryErrorBannerHtml === '') {
          if (existingBanner) existingBanner.remove();
        } else if (existingBanner) {
          existingBanner.outerHTML = msg.summaryErrorBannerHtml;
        } else {
          var pageRoot = document.querySelector('.page');
          if (pageRoot) pageRoot.insertAdjacentHTML('afterbegin', msg.summaryErrorBannerHtml);
        }
      }
      leaveRegeneratingReadonly();
      // Re-attach handlers on the NEW DOM nodes inside topics + recap.
      // NOTE: the Regenerate buttons (#regenerateSummaryBtn in the
      // Conversations card AND #summaryErrorRegenerateBtn in the banner)
      // are reached via an event delegate on .page (see
      // attachRegenerateSummaryDelegate), so they keep working through
      // DOM replacement without any re-binding.
      attachEditRecapHandler();
      attachGenerateRecapHandler();
      var newTopicsRoot = document.getElementById('topicsSection');
      if (newTopicsRoot) {
        attachTopicHandlers(newTopicsRoot);
        // attachTopicHandlers wires edit/delete inside .toggle but NOT the
        // toggle-header expand/collapse click — re-attach explicitly on
        // the new headers. The function is idempotent (_toggleAttached).
        newTopicsRoot.querySelectorAll('.toggle-header').forEach(attachToggleHeader);
      }
      // Fresh topicsSection brings a NEW #toggleAllBtn whose click listener
      // doesn't carry over from the old DOM. Reset allCollapsed because the
      // new topics are always rendered uncollapsed, then re-bind.
      allCollapsed = false;
      attachToggleAllBtnHandler();
      return;
    }
    if (msg.command === 'summaryRegenerateError') {
      leaveRegeneratingReadonly();
      return;
    }
  });

  // Toggle All: expand / collapse all topic toggles and timeline groups.
  // Scoped to topics — explicitly excludes .e2e-scenario so the E2E section
  // has its own independent #toggleAllE2eBtn.
  //
  // allCollapsed lives in the buildScript closure so the state survives a
  // regenerate re-render. The handler is only called twice in the lifecycle:
  // once at page load, and once after summaryRegenerated swaps in a brand-new
  // #toggleAllBtn element (the old element is gone, so the new one needs its
  // own listener — not a re-bind on the same node).
  var allCollapsed = false;
  function attachToggleAllBtnHandler() {
    var toggleAllBtn = document.getElementById('toggleAllBtn');
    if (!toggleAllBtn) return;
    // Sync the button label with allCollapsed so a regenerate's freshly-
    // rendered topics (always uncollapsed) and the button text agree.
    toggleAllBtn.textContent = allCollapsed ? 'Expand All' : 'Collapse All';
    toggleAllBtn.addEventListener('click', function() {
      var items = document.querySelectorAll('.toggle:not(.e2e-scenario), .timeline-group');
      allCollapsed = !allCollapsed;
      items.forEach(function(t) {
        if (allCollapsed) {
          t.classList.add('collapsed');
        } else {
          t.classList.remove('collapsed');
        }
      });
      toggleAllBtn.textContent = allCollapsed ? 'Expand All' : 'Collapse All';
    });
  }
  attachToggleAllBtnHandler();

  // ── Attach collapsible callout toggle handlers inside a root element ──
  function attachCollapsibleHandlers(root) {
    root.querySelectorAll('.callout.collapsible .callout-label').forEach(function(label) {
      label.addEventListener('click', function() {
        label.closest('.callout').classList.toggle('callout-collapsed');
      });
    });
  }

  // ── Attach edit/delete handlers to buttons inside a root element ─────
  function attachTopicHandlers(root) {
    attachCollapsibleHandlers(root);
    root.querySelectorAll('.topic-delete-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = parseInt(btn.dataset.topicIndex, 10);
        var toggle = document.getElementById('topic-' + idx);
        var titleEl = toggle ? toggle.querySelector('.toggle-title') : null;
        var title = titleEl ? titleEl.textContent : '';
        vscode.postMessage({ command: 'deleteTopic', topicIndex: idx, title: title });
      });
    });
    root.querySelectorAll('.topic-edit-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = parseInt(btn.dataset.topicIndex, 10);
        var toggle = document.getElementById('topic-' + idx);
        if (toggle && !toggle.classList.contains('editing')) {
          enterEditMode(toggle, idx);
        }
      });
    });
  }
  attachTopicHandlers(document);

  // ── Edit memory handler ────────────────────────────────────────────────
  var EDIT_FIELDS = [
    { key: 'trigger',       label: '\\u26A1 Why this change' },
    { key: 'decisions',     label: '\\uD83D\\uDCA1 Decisions behind the code' },
    { key: 'response',      label: '\\u2705 What was implemented' },
    { key: 'todo',          label: '\\uD83D\\uDCCB Future enhancements' },
    { key: 'filesAffected', label: '\\uD83D\\uDCC1 Files' }
  ];

  function autoResize(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function enterEditMode(toggle, topicIndex) {
    var data = JSON.parse(toggle.dataset.topic || '{}');
    toggle.classList.add('editing');
    toggle.classList.remove('collapsed');

    // Replace title span with input in the header (in-place)
    var header = toggle.querySelector('.toggle-header');
    var titleSpan = header.querySelector('.toggle-title');
    toggle._originalTitleHtml = titleSpan.outerHTML;
    var titleInput = document.createElement('input');
    titleInput.className = 'edit-title-input';
    titleInput.dataset.editField = 'title';
    titleInput.value = data.title;
    titleInput.style.pointerEvents = 'auto';
    titleInput.addEventListener('click', function(e) { e.stopPropagation(); });
    titleSpan.replaceWith(titleInput);

    // Hide cat pill during edit
    var catPill = header.querySelector('.cat-pill');
    if (catPill) { catPill.style.display = 'none'; }

    var content = toggle.querySelector('.toggle-content');
    // Save original HTML for cancel
    toggle._originalHtml = content.innerHTML;

    // Build edit form (no title input here — it's in the header)
    var html = '';

    for (var i = 0; i < EDIT_FIELDS.length; i++) {
      var f = EDIT_FIELDS[i];
      var val = data[f.key] || '';
      var cls = f.key === 'filesAffected' ? 'files-affected-edit' : f.key;
      html += '<div class="callout ' + cls + '">' +
        '<div class="callout-body">' +
        '<div class="callout-label">' + f.label + '</div>' +
        '<textarea class="edit-textarea" data-edit-field="' + f.key + '"' +
        (f.key === 'filesAffected' ? ' placeholder="One file per line"' : '') +
        '>' +
        val.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
        '</textarea></div></div>';
    }

    html += '<div class="edit-actions">' +
      '<button class="edit-cancel-btn">Cancel</button>' +
      '<button class="edit-save-btn">Save</button></div>';

    content.innerHTML = html;

    // Auto-resize all textareas
    content.querySelectorAll('.edit-textarea').forEach(function(ta) {
      autoResize(ta);
      ta.addEventListener('input', function() { autoResize(ta); });
    });

    // Cancel button
    content.querySelector('.edit-cancel-btn').addEventListener('click', function() {
      exitEditMode(toggle);
    });

    // Save button — collect fields from both header (title) and content (other fields)
    var saveBtn = content.querySelector('.edit-save-btn');
    saveBtn.addEventListener('click', function() {
      var updates = {};
      toggle.querySelectorAll('[data-edit-field]').forEach(function(el) {
        var field = el.dataset.editField;
        var value = el.value;
        if (field === 'filesAffected') {
          // Split by newlines, filter empty
          var files = value.split('\\n').map(function(f) { return f.trim(); }).filter(function(f) { return f.length > 0; });
          updates[field] = files;
        } else {
          updates[field] = value;
        }
      });
      // Validate required fields
      if (!updates.title || !updates.title.trim()) {
        var titleInput = toggle.querySelector('[data-edit-field="title"]');
        if (titleInput) { titleInput.focus(); titleInput.style.borderColor = 'var(--vscode-inputValidation-errorBorder, #f44)'; }
        return;
      }
      // Disable buttons and show saving state
      saveBtn.textContent = 'Saving...';
      saveBtn.disabled = true;
      content.querySelector('.edit-cancel-btn').disabled = true;
      vscode.postMessage({ command: 'editTopic', topicIndex: topicIndex, updates: updates });
    });

    // ESC key exits edit mode
    toggle._escHandler = function(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        exitEditMode(toggle);
      }
    };
    document.addEventListener('keydown', toggle._escHandler);
  }

  function exitEditMode(toggle) {
    // Remove ESC handler
    if (toggle._escHandler) {
      document.removeEventListener('keydown', toggle._escHandler);
      delete toggle._escHandler;
    }
    toggle.classList.remove('editing');
    // Restore title span in header
    var titleInput = toggle.querySelector('.edit-title-input');
    if (titleInput && toggle._originalTitleHtml) {
      var temp = document.createElement('div');
      temp.innerHTML = toggle._originalTitleHtml;
      titleInput.replaceWith(temp.firstChild);
      delete toggle._originalTitleHtml;
    }
    // Restore cat pill visibility
    var catPill = toggle.querySelector('.cat-pill');
    if (catPill) { catPill.style.display = ''; }
    // Restore content and reattach collapsible callout handlers
    var content = toggle.querySelector('.toggle-content');
    if (toggle._originalHtml) {
      content.innerHTML = toggle._originalHtml;
      delete toggle._originalHtml;
      attachCollapsibleHandlers(toggle);
    }
  }

  // ── E2E Test Guide ────────────────────────────────────────────────────
  // Mirrors the Topics pattern: each scenario is a .toggle.e2e-scenario
  // with its own edit/delete buttons; the section header has a Collapse-All
  // button. Inline edit replaces title (in header) and content fields with
  // textareas; Save posts editE2eScenario, Cancel restores cached HTML.
  // E2E scenario toggle is handled by the generic .toggle-header handler above.

  var E2E_EDIT_FIELDS = [
    { key: 'preconditions',   label: '📋 Preconditions', placeholder: '' },
    { key: 'steps',           label: '👣 Steps',          placeholder: 'One step per line' },
    { key: 'expectedResults', label: '✅ Expected Results',     placeholder: 'One result per line' }
  ];

  function attachE2eHandlers(root) {
    if (!root) return;

    // Re-bind toggle-header click on freshly-rendered scenarios — the page-level
    // attach pass runs once on script load and misses elements inserted later.
    root.querySelectorAll('.toggle-header').forEach(attachToggleHeader);

    // Generate / Regenerate (placeholder + section header buttons share command).
    var genBtn = root.querySelector('#generateE2eBtn');
    if (genBtn) genBtn.addEventListener('click', function() {
      vscode.postMessage({ command: 'generateE2eTest' });
    });
    var regenBtn = root.querySelector('#regenE2eBtn');
    if (regenBtn) regenBtn.addEventListener('click', function() {
      vscode.postMessage({ command: 'generateE2eTest' });
    });

    // Section-level Delete (deletes the whole guide).
    var sectionDelBtn = root.querySelector('#deleteE2eBtn');
    if (sectionDelBtn) sectionDelBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      vscode.postMessage({ command: 'deleteE2eTest' });
    });

    // Collapse-All for E2E (scoped to the e2e section only).
    var toggleAllBtn = root.querySelector('#toggleAllE2eBtn');
    if (toggleAllBtn) toggleAllBtn.addEventListener('click', function() {
      var section = document.getElementById('e2eTestSection');
      if (!section) return;
      var scenarios = section.querySelectorAll('.toggle.e2e-scenario');
      var allCollapsed = scenarios.length > 0 && Array.prototype.every.call(scenarios, function(s) {
        return s.classList.contains('collapsed');
      });
      var collapseNext = !allCollapsed;
      scenarios.forEach(function(s) {
        if (collapseNext) { s.classList.add('collapsed'); }
        else { s.classList.remove('collapsed'); }
      });
      toggleAllBtn.textContent = collapseNext ? 'Expand All' : 'Collapse All';
    });

    // Per-scenario Delete.
    root.querySelectorAll('.e2e-delete-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = parseInt(btn.dataset.scenarioIndex, 10);
        var scenarioEl = document.getElementById('e2e-scenario-' + idx);
        var titleEl = scenarioEl ? scenarioEl.querySelector('.toggle-title') : null;
        var title = titleEl ? titleEl.textContent : '';
        vscode.postMessage({ command: 'deleteE2eScenario', index: idx, title: title });
      });
    });

    // Per-scenario Edit.
    root.querySelectorAll('.e2e-edit-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = parseInt(btn.dataset.scenarioIndex, 10);
        var toggle = document.getElementById('e2e-scenario-' + idx);
        if (toggle && !toggle.classList.contains('editing')) {
          enterE2eEditMode(toggle, idx);
        }
      });
    });
  }

  // ── Recap edit handler ─────────────────────────────────────────────────
  function attachEditRecapHandler() {
    var btn = document.getElementById('editRecapBtn');
    if (!btn) return;
    btn.addEventListener('click', function() {
      var section = document.getElementById('recapSection');
      if (!section || section.classList.contains('recap-editing')) return;
      enterRecapEditMode(section);
    });
  }

  function enterRecapEditMode(section) {
    section.classList.add('recap-editing');
    var body = section.querySelector('.recap-body');
    var raw = section.dataset.raw || (body ? body.textContent : '') || '';

    // Stash original HTML so Cancel can restore it verbatim (cheap revert).
    section._originalRecapBody = body ? body.outerHTML : '';

    var ta = document.createElement('textarea');
    ta.className = 'recap-edit-area';
    ta.value = raw;
    if (body) { body.replaceWith(ta); } else { section.appendChild(ta); }

    var actions = document.createElement('div');
    actions.className = 'recap-edit-actions';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'action-btn';
    cancelBtn.textContent = 'Cancel';
    var saveBtn = document.createElement('button');
    saveBtn.className = 'action-btn primary';
    saveBtn.textContent = 'Save';
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    ta.insertAdjacentElement('afterend', actions);

    // Auto-resize and focus.
    ta.style.height = ta.scrollHeight + 'px';
    ta.addEventListener('input', function() {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    });
    ta.focus();

    function exitRecapEditMode() {
      if (section._recapEscHandler) {
        document.removeEventListener('keydown', section._recapEscHandler);
        delete section._recapEscHandler;
      }
      section.classList.remove('recap-editing');
      var ed = section.querySelector('.recap-edit-area');
      if (ed && section._originalRecapBody) {
        // Recreate the original .recap-body element from the stashed HTML.
        var temp = document.createElement('div');
        temp.innerHTML = section._originalRecapBody;
        ed.replaceWith(temp.firstChild);
      }
      var act = section.querySelector('.recap-edit-actions');
      if (act) act.remove();
      delete section._originalRecapBody;
    }

    cancelBtn.addEventListener('click', exitRecapEditMode);

    saveBtn.addEventListener('click', function() {
      var newRecap = ta.value.trim();
      saveBtn.textContent = 'Saving...';
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      vscode.postMessage({ command: 'editRecap', recap: newRecap });
    });

    // ESC cancels
    section._recapEscHandler = function(ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        cancelBtn.click();
      }
    };
    document.addEventListener('keydown', section._recapEscHandler);
  }
  attachEditRecapHandler();

  // ── Recap generate / regenerate handler ────────────────────────────────
  // Both buttons post the same 'generateRecap' command; the extension
  // decides whether this is a first-time generate or a regenerate based on
  // whether summary.recap is already set. Loading state is reflected on
  // whichever button is in the DOM.
  function attachGenerateRecapHandler() {
    var ids = ['generateRecapBtn', 'regenerateRecapBtn'];
    ids.forEach(function(id) {
      var btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({ command: 'generateRecap' });
      });
    });
  }
  attachGenerateRecapHandler();

  // ── Regenerate-summary shared request + delegated click handlers ────────
  // Drives the end-to-end re-run from either entry point:
  //   - The page header's #regenerateSummaryBtn (in the initial DOM)
  //   - The top-of-page #summaryErrorRegenerateBtn (banner; may be inserted
  //     dynamically by the summaryRegenerated handler — event delegation
  //     means we don't need to re-bind after DOM replacement)
  // Both go through the same guards (unsaved edits + in-flight LLM) so the
  // banner button can't bypass them. The actual confirm dialog + LLM call
  // lives on the extension host; this side only gates the click and
  // renders progress state.
  function requestRegenerateSummary(btn) {
    if (btn && btn.disabled) return;
    // Block when user has unsaved edits in topics or recap — otherwise a
    // 30-second LLM call would silently overwrite in-progress work.
    if (document.querySelector('#topicsSection .toggle.editing, #recapSection.recap-editing')) {
      alert('You have unsaved edits in topics or recap. Save or cancel them before regenerating.');
      return;
    }
    // Block when another LLM action is already in flight.
    if (document.querySelector('.generating')) {
      alert('Another action is in progress. Please wait for it to finish.');
      return;
    }
    vscode.postMessage({ command: 'regenerateSummary' });
  }

  function attachRegenerateSummaryDelegate() {
    var page = document.querySelector('.page');
    if (!page) return;
    page.addEventListener('click', function(e) {
      var target = e.target;
      if (!target || typeof target.closest !== 'function') return;
      var btn = target.closest('#regenerateSummaryBtn, #summaryErrorRegenerateBtn');
      if (!btn) return;
      e.stopPropagation();
      requestRegenerateSummary(btn);
    });
  }
  attachRegenerateSummaryDelegate();

  // Toggle the page into / out of regenerating-readonly mode. CSS
  // (.page.regenerating-readonly button:not([data-foreign-safe])) takes
  // care of hiding every action button; the banner explains why. The
  // host's dispatchWebviewMessage adds a second-layer guard against any
  // postMessage that slips through (e.g. from a tab still on the old
  // pre-readonly DOM).
  function enterRegeneratingReadonly() {
    var page = document.querySelector('.page');
    if (page) page.classList.add('regenerating-readonly');
    insertRegeneratingBanner();
  }

  function leaveRegeneratingReadonly() {
    var page = document.querySelector('.page');
    if (page) page.classList.remove('regenerating-readonly');
    removeRegeneratingBanner();
  }

  function insertRegeneratingBanner() {
    if (document.getElementById('regeneratingBanner')) return;
    var page = document.querySelector('.page');
    if (!page) return;
    var banner = document.createElement('div');
    banner.id = 'regeneratingBanner';
    banner.className = 'regenerating-banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML =
      '<span class="regenerating-banner-spinner" aria-hidden="true">\\u21BB</span>' +
      '<span class="regenerating-banner-text">Regenerating summary\\u2026 Other actions are temporarily disabled.</span>';
    page.insertBefore(banner, page.firstChild);
  }

  function removeRegeneratingBanner() {
    var banner = document.getElementById('regeneratingBanner');
    if (banner) banner.remove();
  }

  // CONTRACT: callers pass section HTML from SummaryHtmlBuilder.ts. Two shapes
  // exist and both are handled by the trailing-<hr> logic below:
  //   - "<div id='…'>…</div><hr class='separator'/>" (two siblings) —
  //     buildRecapSection, buildE2eTestSection, buildPlansAndNotesSection.
  //   - "<div id='…'>…</div>" (single node, no trailing <hr>) —
  //     buildTopicsSection (last content section before the footer).
  // Used by summaryRegenerated (recap+topics), topicsUpdated, and
  // plansAndNotesUpdated. If any of those builders' trailing-separator shape
  // changes, update the logic below in the same commit — otherwise the partial
  // refresh leaves stacked or missing <hr class="separator">.
  function replaceSection(id, html) {
    var old = document.getElementById(id);
    if (!old) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    var nodes = Array.prototype.slice.call(wrap.childNodes).filter(function(n) { return n.nodeType === 1; });
    if (nodes.length === 0) return;
    // If the NEW html ends with its own <hr class="separator"> sibling, drop the
    // OLD node's trailing <hr> first so we don't stack two separators. The
    // recap / e2e / plansAndNotes sections all emit a "<div>…</div><hr/>" pair;
    // topicsSection ends in "</div>" (no trailing <hr>), so the guard is a
    // no-op there. Generalized from the former recap-only special case so the
    // same helper serves topicsUpdated / plansAndNotesUpdated too.
    var lastNew = nodes[nodes.length - 1];
    var sep = old.nextElementSibling;
    if (lastNew && lastNew.tagName === 'HR' && sep && sep.tagName === 'HR') sep.remove();
    old.replaceWith.apply(old, nodes);
  }

  // Recap status messages — generation flow only. The 'recapUpdated' /
  // 'recapUpdateError' messages are handled in the top-level message
  // listener above and reused here; we only add the generating-loading
  // state here so the button reflects in-flight work.
  // Mirrors the E2E regenerate UX: regen icon button gets the .generating
  // class (spinning animation + opacity dim + wait cursor); the larger
  // Generate text button just changes its label to "Generating...".
  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (msg.command === 'recapGenerating') {
      var genBtn = document.getElementById('generateRecapBtn');
      var regenBtn = document.getElementById('regenerateRecapBtn');
      if (genBtn) {
        genBtn.textContent = 'Generating...';
        genBtn.disabled = true;
      }
      if (regenBtn) {
        regenBtn.classList.add('generating');
        regenBtn.title = 'Generating...';
        regenBtn.disabled = true;
      }
    }
  });

  function enterE2eEditMode(toggle, scenarioIndex) {
    var data = JSON.parse(toggle.dataset.scenario || '{}');
    toggle.classList.add('editing');
    toggle.classList.remove('collapsed');

    // Replace title span with input in the header (mirrors topic pattern).
    var header = toggle.querySelector('.toggle-header');
    var titleSpan = header.querySelector('.toggle-title');
    toggle._originalTitleHtml = titleSpan.outerHTML;
    var titleInput = document.createElement('input');
    titleInput.className = 'edit-title-input';
    titleInput.dataset.editField = 'title';
    titleInput.value = data.title || '';
    titleInput.style.pointerEvents = 'auto';
    titleInput.addEventListener('click', function(e) { e.stopPropagation(); });
    titleSpan.replaceWith(titleInput);

    var content = toggle.querySelector('.toggle-content');
    toggle._originalHtml = content.innerHTML;

    var html = '';
    for (var i = 0; i < E2E_EDIT_FIELDS.length; i++) {
      var f = E2E_EDIT_FIELDS[i];
      var val = data[f.key] || '';
      html += '<div class="callout ' + f.key + '">' +
        '<div class="callout-body">' +
        '<div class="callout-label">' + f.label + '</div>' +
        '<textarea class="edit-textarea" data-edit-field="' + f.key + '"' +
        (f.placeholder ? ' placeholder="' + f.placeholder + '"' : '') +
        '>' +
        val.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
        '</textarea></div></div>';
    }

    html += '<div class="edit-actions">' +
      '<button class="edit-cancel-btn">Cancel</button>' +
      '<button class="edit-save-btn">Save</button></div>';

    content.innerHTML = html;

    content.querySelectorAll('.edit-textarea').forEach(function(ta) {
      autoResize(ta);
      ta.addEventListener('input', function() { autoResize(ta); });
    });

    content.querySelector('.edit-cancel-btn').addEventListener('click', function() {
      exitE2eEditMode(toggle);
    });

    var saveBtn = content.querySelector('.edit-save-btn');
    saveBtn.addEventListener('click', function() {
      var updates = {};
      var titleEl = toggle.querySelector('[data-edit-field="title"]');
      updates.title = titleEl ? titleEl.value : '';
      content.querySelectorAll('[data-edit-field]').forEach(function(el) {
        var field = el.dataset.editField;
        var value = el.value;
        if (field === 'steps' || field === 'expectedResults') {
          updates[field] = value.split('\\n').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
        } else if (field === 'preconditions') {
          updates[field] = value.trim(); // empty string signals clear to backend
        }
      });
      // Validation: title required.
      if (!updates.title || !updates.title.trim()) {
        var ti = toggle.querySelector('[data-edit-field="title"]');
        if (ti) {
          ti.focus();
          ti.style.borderColor = 'var(--vscode-inputValidation-errorBorder, #f44)';
        }
        return;
      }
      // Validation: at least one step required.
      if (!updates.steps || updates.steps.length === 0) {
        var stepsEl = content.querySelector('[data-edit-field="steps"]');
        if (stepsEl) {
          stepsEl.focus();
          stepsEl.style.borderColor = 'var(--vscode-inputValidation-errorBorder, #f44)';
        }
        return;
      }
      saveBtn.textContent = 'Saving...';
      saveBtn.disabled = true;
      content.querySelector('.edit-cancel-btn').disabled = true;
      vscode.postMessage({ command: 'editE2eScenario', index: scenarioIndex, updates: updates });
    });

    toggle._escHandler = function(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        exitE2eEditMode(toggle);
      }
    };
    document.addEventListener('keydown', toggle._escHandler);
  }

  function exitE2eEditMode(toggle) {
    if (toggle._escHandler) {
      document.removeEventListener('keydown', toggle._escHandler);
      delete toggle._escHandler;
    }
    toggle.classList.remove('editing');
    var titleInput = toggle.querySelector('.edit-title-input');
    if (titleInput && toggle._originalTitleHtml) {
      var temp = document.createElement('div');
      temp.innerHTML = toggle._originalTitleHtml;
      titleInput.replaceWith(temp.firstChild);
      delete toggle._originalTitleHtml;
    }
    var content = toggle.querySelector('.toggle-content');
    if (toggle._originalHtml) {
      content.innerHTML = toggle._originalHtml;
      delete toggle._originalHtml;
      attachCollapsibleHandlers(toggle);
    }
  }

  attachE2eHandlers(document);

  // Handle E2E status messages from the extension
  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (msg.command === 'e2eTestGenerating') {
      var btn = document.getElementById('generateE2eBtn') || document.getElementById('regenE2eBtn');
      if (btn) {
        if (btn.id === 'regenE2eBtn') {
          btn.classList.add('generating');
          btn.title = 'Generating...';
        } else {
          btn.textContent = 'Generating...';
        }
        btn.disabled = true;
      }
    } else if (msg.command === 'e2eTestUpdated' && msg.html) {
      // Whole-section replacement (used by Generate, section-level Delete,
      // and per-scenario Delete since indices shift after removal).
      var section = document.getElementById('e2eTestSection');
      if (section) {
        // Clean up any ESC handlers from scenarios currently in edit mode
        // before the DOM nodes are discarded.
        section.querySelectorAll('.e2e-scenario.editing').forEach(function(t) {
          if (t._escHandler) {
            document.removeEventListener('keydown', t._escHandler);
          }
        });
        var wrapper = document.createElement('div');
        wrapper.innerHTML = msg.html;
        var newSection = wrapper.querySelector('#e2eTestSection');
        if (newSection) {
          var hr = section.nextElementSibling;
          section.replaceWith(newSection);
          var newHr = wrapper.querySelector('hr.separator');
          if (newHr && hr && hr.tagName === 'HR') {
            hr.replaceWith(newHr);
          } else if (newHr && !hr) {
            newSection.insertAdjacentElement('afterend', newHr);
          }
          attachE2eHandlers(newSection);
        }
      }
    } else if (msg.command === 'e2eScenarioUpdated' && typeof msg.scenarioIndex === 'number' && msg.html) {
      // Surgical per-scenario replacement preserves collapsed state of other scenarios.
      var oldToggle = document.getElementById('e2e-scenario-' + msg.scenarioIndex);
      if (oldToggle) {
        if (oldToggle._escHandler) {
          document.removeEventListener('keydown', oldToggle._escHandler);
        }
        var wasCollapsed = oldToggle.classList.contains('collapsed');
        var wrapper = document.createElement('div');
        wrapper.innerHTML = msg.html;
        var newToggle = wrapper.firstElementChild;
        if (newToggle) {
          oldToggle.replaceWith(newToggle);
          if (wasCollapsed) { newToggle.classList.add('collapsed'); }
          attachE2eHandlers(newToggle);
        }
      }
    } else if (msg.command === 'e2eScenarioUpdateError') {
      // Re-enable save/cancel so the user can retry.
      var editing = document.querySelector('.e2e-scenario.editing');
      if (editing) {
        var saveBtn = editing.querySelector('.edit-save-btn');
        var cancelBtn = editing.querySelector('.edit-cancel-btn');
        if (saveBtn) { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }
        if (cancelBtn) { cancelBtn.disabled = false; }
      }
    } else if (msg.command === 'e2eTestError') {
      var btn = document.getElementById('generateE2eBtn') || document.getElementById('regenE2eBtn');
      if (btn) {
        if (btn.id === 'regenE2eBtn') {
          btn.classList.remove('generating');
          btn.title = 'Regenerate';
        } else {
          btn.textContent = '\\u2728 Generate';
        }
        btn.disabled = false;
      }
    }

  // ── Plan inline edit messages ──
  if (msg.command === 'planContentLoaded' && msg.slug && msg.content !== undefined) {
    var planEl = document.getElementById('plan-' + msg.slug);
    if (planEl) {
      var editArea = planEl.querySelector('.plan-edit-area');
      var textarea = planEl.querySelector('.plan-edit-textarea');
      if (editArea && textarea) {
        textarea.value = msg.content;
        planEl.classList.add('editing');
        textarea.focus();
      }
    }
  }

  if (msg.command === 'planSaved' && msg.slug) {
    var planEl2 = document.getElementById('plan-' + msg.slug);
    if (planEl2) {
      planEl2.classList.remove('editing');
    }
  }

  // ── Note inline edit messages ──
  if (msg.command === 'noteContentLoaded' && msg.id && msg.content !== undefined) {
    var noteEl = document.getElementById('note-' + msg.id);
    if (noteEl) {
      var noteEditArea = noteEl.querySelector('.plan-edit-area');
      var noteTextarea = noteEl.querySelector('.plan-edit-textarea');
      if (noteEditArea && noteTextarea) {
        noteTextarea.value = msg.content;
        noteEl.classList.add('editing');
        noteTextarea.focus();
      }
    }
  }

  if (msg.command === 'noteSaved' && msg.id) {
    var noteEl2 = document.getElementById('note-' + msg.id);
    if (noteEl2) {
      noteEl2.classList.remove('editing');
    }
  }

  if (msg.command === 'snippetSaved') {
    hideSnippetForm();
  }

  // ── Plans & Notes whole-section replace ──
  // After a plan/note/reference add/remove/save/translate the host re-renders
  // the whole #plansAndNotesSection (keeps the count badge + empty-state in
  // sync). data-action buttons are document-delegated so they survive the
  // replace; the snippet form's per-element input listeners do NOT, so
  // bindPlansAndNotesSection re-binds them.
  if (msg.command === 'plansAndNotesUpdated' && typeof msg.html === 'string') {
    replaceSection('plansAndNotesSection', msg.html);
    bindPlansAndNotesSection();
    // The visible "CONTEXT N" chip is #contextPanel's panel-header .sec-count,
    // which sits OUTSIDE the just-replaced #plansAndNotesSection (that section's
    // own header is CSS-hidden), so replaceSection can't update it — sync it here
    // from the recomputed count the host sent alongside the html.
    if (typeof msg.count === 'number') {
      var ctxPanel = document.getElementById('contextPanel');
      var ctxCount = ctxPanel ? ctxPanel.querySelector('.panel-header .sec-count') : null;
      if (ctxCount) ctxCount.textContent = String(msg.count);
    }
  }

  // ── Header Jolli row (published Plans & Notes link list) ──
  // Sent alongside plansAndNotesUpdated because #jolliRow embeds that link list.
  // Replace if present; remove if the new html is empty; ignore if absent
  // (#jolliRow only exists after the commit is pushed, and push takes the
  // full-rebuild path).
  if (msg.command === 'jolliRowUpdated' && typeof msg.html === 'string') {
    var oldJolliRow = document.getElementById('jolliRow');
    if (oldJolliRow) {
      if (msg.html.trim().length === 0) {
        oldJolliRow.remove();
      } else {
        var jolliWrap = document.createElement('div');
        jolliWrap.innerHTML = msg.html;
        var newJolliRow = jolliWrap.firstElementChild;
        if (newJolliRow) oldJolliRow.replaceWith(newJolliRow);
      }
    }
  }

  // ── Plan translation status ──
  if (msg.command === 'planTranslating' && msg.slug) {
    var translateBtn = document.querySelector('.plan-translate-btn[data-plan-slug="' + msg.slug + '"]');
    if (translateBtn) {
      translateBtn.disabled = true;
      translateBtn.classList.add('translating');
      translateBtn.setAttribute('title', 'Translating...');
    }
  }
  if (msg.command === 'planTranslateError' && msg.slug) {
    var translateBtn2 = document.querySelector('.plan-translate-btn[data-plan-slug="' + msg.slug + '"]');
    if (translateBtn2) {
      translateBtn2.disabled = false;
      translateBtn2.classList.remove('translating');
      translateBtn2.setAttribute('title', 'Translate to English');
    }
  }

  // ── Note translation status ──
  if (msg.command === 'noteTranslating' && msg.id) {
    var noteTransBtn = document.querySelector('.note-translate-btn[data-note-id="' + msg.id + '"]');
    if (noteTransBtn) {
      noteTransBtn.disabled = true;
      noteTransBtn.classList.add('translating');
      noteTransBtn.setAttribute('title', 'Translating...');
    }
  }
  if (msg.command === 'noteTranslateError' && msg.id) {
    var noteTransBtn2 = document.querySelector('.note-translate-btn[data-note-id="' + msg.id + '"]');
    if (noteTransBtn2) {
      noteTransBtn2.disabled = false;
      noteTransBtn2.classList.remove('translating');
      noteTransBtn2.setAttribute('title', 'Translate to English');
    }
  }

  // ── Reference inline edit messages (mirrors plan/note) ──
  if (msg.command === 'referenceContentLoaded' && msg.archivedKey && msg.source && msg.content !== undefined) {
    // DOM id strips '<source>:' prefix uniformly across all sources so the id
    // is 'reference-<source>-<bareKey>' — matches SummaryHtmlBuilder.buildReferenceRow.
    var refLePrefix = msg.source + ':';
    var refLeKey = msg.archivedKey.indexOf(refLePrefix) === 0 ? msg.archivedKey.slice(refLePrefix.length) : msg.archivedKey;
    var referenceEl = document.getElementById('reference-' + msg.source + '-' + refLeKey);
    if (referenceEl) {
      var referenceEditArea = referenceEl.querySelector('.plan-edit-area');
      var referenceTextareaIn = referenceEl.querySelector('.plan-edit-textarea');
      if (referenceEditArea && referenceTextareaIn) {
        referenceTextareaIn.value = msg.content;
        referenceEl.classList.add('editing');
        referenceTextareaIn.focus();
      }
    }
  }

  if (msg.command === 'referenceSaved' && msg.archivedKey && msg.source) {
    var refSavedPrefix = msg.source + ':';
    var refSavedDomKey = msg.archivedKey.indexOf(refSavedPrefix) === 0 ? msg.archivedKey.slice(refSavedPrefix.length) : msg.archivedKey;
    var referenceEl2 = document.getElementById('reference-' + msg.source + '-' + refSavedDomKey);
    if (referenceEl2) {
      referenceEl2.classList.remove('editing');
    }
  }

  // ── Reference translation status ──
  if (msg.command === 'referenceTranslating' && msg.archivedKey) {
    var refTransBtn = document.querySelector('.reference-translate-btn[data-reference-key="' + msg.archivedKey + '"]');
    if (refTransBtn) {
      refTransBtn.disabled = true;
      refTransBtn.classList.add('translating');
      refTransBtn.setAttribute('title', 'Translating...');
    }
  }
  if (msg.command === 'referenceTranslateError' && msg.archivedKey) {
    var refTransBtn2 = document.querySelector('.reference-translate-btn[data-reference-key="' + msg.archivedKey + '"]');
    if (refTransBtn2) {
      refTransBtn2.disabled = false;
      refTransBtn2.classList.remove('translating');
      refTransBtn2.setAttribute('title', 'Translate to English');
    }
  }

  });

  // ── Plan & Note actions: event delegation for data-action attributes ──
  // Replaces inline onclick handlers for CSP compliance.
  document.addEventListener('click', function(e) {
    var target = e.target.closest('[data-action]');
    if (!target) return;
    var action = target.getAttribute('data-action');
    var slug = target.getAttribute('data-plan-slug');
    var title = target.getAttribute('data-plan-title') || '';

    switch (action) {
      case 'translatePlan':
        vscode.postMessage({ command: 'translatePlan', slug: slug });
        break;
      case 'previewPlan':
        e.preventDefault();
        vscode.postMessage({ command: 'previewPlan', slug: slug, title: title });
        break;
      case 'loadPlanContent':
        vscode.postMessage({ command: 'loadPlanContent', slug: slug });
        break;
      case 'removePlan':
        vscode.postMessage({ command: 'removePlan', slug: slug, title: title });
        break;
      case 'removeExcludedContext':
        // Excluded (soft-excluded) rows carry kind/key/title on data-excluded-*.
        // Removes the entry from THIS commit's excludedContext only — does not
        // touch the working registry (sidebar/worktree unaffected).
        vscode.postMessage({
          command: 'removeExcludedContext',
          kind: target.getAttribute('data-excluded-kind') || '',
          key: target.getAttribute('data-excluded-key') || '',
          title: target.getAttribute('data-excluded-title') || '',
        });
        break;
      case 'savePlanEdit': {
        var planItem = document.getElementById('plan-' + slug);
        if (!planItem) break;
        var textarea = planItem.querySelector('.plan-edit-textarea');
        if (!textarea) break;
        vscode.postMessage({ command: 'savePlan', slug: slug, content: textarea.value });
        break;
      }
      case 'cancelPlanEdit': {
        var planEl = document.getElementById('plan-' + slug);
        if (!planEl) break;
        planEl.classList.remove('editing');
        break;
      }
      case 'addPlan':
        closeAddMenu();
        vscode.postMessage({ command: 'addPlan' });
        break;
      case 'addMarkdownNote':
        closeAddMenu();
        vscode.postMessage({ command: 'addMarkdownNote' });
        break;
      case 'addTextSnippet':
        closeAddMenu();
        showSnippetForm();
        break;
      case 'saveSnippet': {
        var sTitle = document.getElementById('snippetTitle');
        var sContent = document.getElementById('snippetContent');
        if (!sContent || !sContent.value.trim()) break;
        vscode.postMessage({ command: 'saveSnippet', title: sTitle ? sTitle.value.trim() : '', content: sContent.value });
        break;
      }
      case 'cancelSnippet':
        hideSnippetForm();
        break;
      case 'toggleAddMenu':
        toggleAddMenu();
        break;
      case 'loadNoteContent': {
        var loadNoteId = target.getAttribute('data-note-id') || '';
        var loadNoteFormat = target.getAttribute('data-note-format') || 'markdown';
        vscode.postMessage({ command: 'loadNoteContent', id: loadNoteId, format: loadNoteFormat });
        break;
      }
      case 'saveNoteEdit': {
        var saveNoteId = target.getAttribute('data-note-id') || '';
        var saveNoteFormat = target.getAttribute('data-note-format') || 'markdown';
        var noteItem = document.getElementById('note-' + saveNoteId);
        if (!noteItem) break;
        var noteTextarea = noteItem.querySelector('.plan-edit-textarea');
        if (!noteTextarea) break;
        vscode.postMessage({ command: 'saveNote', id: saveNoteId, content: noteTextarea.value, format: saveNoteFormat });
        break;
      }
      case 'cancelNoteEdit': {
        var cancelNoteId = target.getAttribute('data-note-id') || '';
        var cancelNoteEl = document.getElementById('note-' + cancelNoteId);
        if (!cancelNoteEl) break;
        cancelNoteEl.classList.remove('editing');
        break;
      }
      case 'previewNote': {
        var previewNoteId = target.getAttribute('data-note-id') || '';
        var previewNoteTitle = target.getAttribute('data-note-title') || '';
        e.preventDefault();
        vscode.postMessage({ command: 'previewNote', id: previewNoteId, title: previewNoteTitle });
        break;
      }
      case 'translateNote': {
        var translateNoteId = target.getAttribute('data-note-id') || '';
        vscode.postMessage({ command: 'translateNote', id: translateNoteId });
        break;
      }
      case 'removeNote': {
        var noteId = target.getAttribute('data-note-id') || '';
        var noteTitle = target.getAttribute('data-note-title') || '';
        vscode.postMessage({ command: 'removeNote', id: noteId, title: noteTitle });
        break;
      }
      case 'previewReference': {
        // Title click -> host opens read-only webview rendering the archived
        // markdown for this reference. archivedKey carries the source prefix
        // so the host dispatches without re-parsing the source.
        e.preventDefault();
        var pevKey = target.getAttribute('data-reference-key') || '';
        var pevSource = target.getAttribute('data-reference-source') || '';
        var pevNativeId = target.getAttribute('data-reference-native-id') || '';
        var pevTitle = target.getAttribute('data-reference-title') || '';
        vscode.postMessage({ command: 'previewReference', archivedKey: pevKey, source: pevSource, nativeId: pevNativeId, title: pevTitle });
        break;
      }
      case 'openReferenceExternal': {
        // 🌍 → host opens reference.url in the default browser. URL is round-
        // tripped via data-reference-url so the host doesn't need to re-query
        // the orphan branch summary — the row already has it.
        var oeUrl = target.getAttribute('data-reference-url') || '';
        vscode.postMessage({ command: 'openReferenceExternal', url: oeUrl });
        break;
      }
      case 'translateReference': {
        // 🌐 → host calls the same translation pipeline plans use; result
        // stored in the same translation cache keyed by archivedKey.
        var teKey = target.getAttribute('data-reference-key') || '';
        var teSource = target.getAttribute('data-reference-source') || '';
        vscode.postMessage({ command: 'translateReference', archivedKey: teKey, source: teSource });
        break;
      }
      case 'loadReferenceContent': {
        // ✎ → host reads the archived markdown body and sends it back via
        // referenceContentLoaded; the webview then opens the inline textarea.
        var leKey = target.getAttribute('data-reference-key') || '';
        var leSource = target.getAttribute('data-reference-source') || '';
        vscode.postMessage({ command: 'loadReferenceContent', archivedKey: leKey, source: leSource });
        break;
      }
      case 'saveReferenceEdit': {
        // Save -> host writes back to orphan branch under references/source/.
        var seKey = target.getAttribute('data-reference-key') || '';
        var seSource = target.getAttribute('data-reference-source') || '';
        // buildReferenceRow's id strips the "<source>:" prefix for ALL sources
        // (stripSourcePrefix), so replicate that for every source — not just
        // Linear — or the textarea lookup misses on jira/github/notion rows.
        var seDomKey = (seKey.indexOf(seSource + ':') === 0) ? seKey.slice((seSource + ':').length) : seKey;
        var referenceItem = document.getElementById('reference-' + seSource + '-' + seDomKey);
        if (!referenceItem) break;
        var referenceTextarea = referenceItem.querySelector('.plan-edit-textarea');
        if (!referenceTextarea) break;
        vscode.postMessage({ command: 'saveReferenceEdit', archivedKey: seKey, source: seSource, content: referenceTextarea.value });
        break;
      }
      case 'cancelReferenceEdit': {
        var ceKey = target.getAttribute('data-reference-key') || '';
        var ceSource = target.getAttribute('data-reference-source') || '';
        var ceDomKey = (ceKey.indexOf(ceSource + ':') === 0) ? ceKey.slice((ceSource + ':').length) : ceKey;
        var ceReferenceEl = document.getElementById('reference-' + ceSource + '-' + ceDomKey);
        if (!ceReferenceEl) break;
        ceReferenceEl.classList.remove('editing');
        break;
      }
      case 'removeReference': {
        var reKey = target.getAttribute('data-reference-key') || '';
        var reSource = target.getAttribute('data-reference-source') || '';
        var reNativeId = target.getAttribute('data-reference-native-id') || '';
        var reTitle = target.getAttribute('data-reference-title') || '';
        vscode.postMessage({ command: 'removeReference', archivedKey: reKey, source: reSource, nativeId: reNativeId, title: reTitle });
        break;
      }
    }
  });

  // ── Add dropdown helpers ──
  function toggleAddMenu() {
    var menu = document.getElementById('addDropdownMenu');
    if (menu) menu.classList.toggle('open');
  }
  function closeAddMenu() {
    var menu = document.getElementById('addDropdownMenu');
    if (menu) menu.classList.remove('open');
  }
  // Close dropdown when clicking outside
  document.addEventListener('click', function(e) {
    var dropdown = document.getElementById('addDropdown');
    if (dropdown && !dropdown.contains(e.target)) {
      closeAddMenu();
    }
  });

  // ── Inline snippet form helpers ──
  function showSnippetForm() {
    var form = document.getElementById('snippetForm');
    if (form) {
      form.classList.remove('hidden');
      form.classList.add('open');
      var titleInput = document.getElementById('snippetTitle');
      if (titleInput) titleInput.focus();
    }
    var addBtn = document.getElementById('addDropdown');
    if (addBtn) addBtn.classList.add('hidden');
  }
  function hideSnippetForm() {
    var form = document.getElementById('snippetForm');
    if (form) {
      form.classList.remove('open');
      form.classList.add('hidden');
    }
    var sTitle = document.getElementById('snippetTitle');
    var sContent = document.getElementById('snippetContent');
    if (sTitle) sTitle.value = '';
    if (sContent) sContent.value = '';
    updateSaveSnippetBtn();
    var addBtn = document.getElementById('addDropdown');
    if (addBtn) addBtn.classList.remove('hidden');
  }
  function updateSaveSnippetBtn() {
    var sTitle = document.getElementById('snippetTitle');
    var sContent = document.getElementById('snippetContent');
    var saveBtn = document.getElementById('saveSnippetBtn');
    var hasTitle = sTitle && sTitle.value.trim();
    var hasContent = sContent && sContent.value.trim();
    if (saveBtn) saveBtn.disabled = !(hasTitle && hasContent);
  }
  // Enable/disable Save button based on title and content. The snippet form
  // lives inside #plansAndNotesSection, so these per-element input listeners are
  // lost when that section is replaced (plansAndNotesUpdated). bindPlansAndNotesSection
  // re-grabs + re-binds them; it runs at init AND after each section replace.
  // (The plan/note/reference data-action buttons are document-delegated, so
  // they need no re-bind.)
  function bindPlansAndNotesSection() {
    var snippetTitleEl = document.getElementById('snippetTitle');
    var snippetContentEl = document.getElementById('snippetContent');
    if (snippetTitleEl) {
      snippetTitleEl.addEventListener('input', updateSaveSnippetBtn);
    }
    if (snippetContentEl) {
      snippetContentEl.addEventListener('input', updateSaveSnippetBtn);
    }
  }
  bindPlansAndNotesSection();

  // ── Transcript Stats (async load for section description) ───────────────
  // Reassigned by bindConversationsSection after a section replace; the
  // transcriptStatsLoaded handler fills whatever it points at. The initial (and
  // post-refresh) stats load is kicked off from bindConversationsSection().
  var conversationsStats = document.getElementById('conversationsStats');

  // ── Inline Conversations rows (mockup) ─────────────────────────────────────
  // Body container for the inline .row list. Reassigned by
  // bindConversationsSection after each conversationsUpdated rebuild; the
  // conversationsData message handler fills whatever it points at.
  var conversationsBody = document.getElementById('conversationsBody');

  // Per-source brand glyphs for conversation rows — mirrors the sidebar's
  // SOURCE_ICON_SVG (SidebarScriptBuilder), which ports the IntelliJ source-*.svg
  // set so all three surfaces stay visually identical. Brand-colored sources
  // (Claude #D97757, Codex #10A37F, Gemini gradient) carry their own hex; the
  // neutral marks (Cursor / Copilot / OpenCode) use currentColor so they follow
  // the badge's icon-foreground on either theme. copilot-chat reuses Copilot.
  // Each is a fixed first-party constant, injected as inline <svg> (CSP forbids
  // <img> / data-URI backgrounds, but permits inline SVG markup in innerHTML).
  var SOURCE_ICON_SVG = {
    claude:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
      '<g stroke="#D97757" stroke-width="1.4" stroke-linecap="round">' +
      '<line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/>' +
      '<line x1="3.76" y1="3.76" x2="12.24" y2="12.24"/><line x1="12.24" y1="3.76" x2="3.76" y2="12.24"/>' +
      '<line x1="11" y1="2.8" x2="5" y2="13.2"/><line x1="13.2" y1="5" x2="2.8" y2="11"/>' +
      '<line x1="5" y1="2.8" x2="11" y2="13.2"/><line x1="2.8" y1="5" x2="13.2" y2="11"/></g></svg>',
    codex:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
      '<g fill="none" stroke="#10A37F" stroke-width="1.3">' +
      '<ellipse cx="8" cy="8" rx="6.4" ry="2.9"/>' +
      '<ellipse cx="8" cy="8" rx="6.4" ry="2.9" transform="rotate(60 8 8)"/>' +
      '<ellipse cx="8" cy="8" rx="6.4" ry="2.9" transform="rotate(120 8 8)"/></g></svg>',
    gemini:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
      '<defs><linearGradient id="jm-gem-detail" x1="2" y1="2" x2="14" y2="14" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0" stop-color="#4796E3"/><stop offset="1" stop-color="#9177C7"/></linearGradient></defs>' +
      '<path fill="url(#jm-gem-detail)" d="M8 1c.3 4.2 2.8 6.7 7 7-4.2.3-6.7 2.8-7 7-.3-4.2-2.8-6.7-7-7 4.2-.3 6.7-2.8 7-7Z"/></svg>',
    cursor:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
      '<g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">' +
      '<path d="M8 1.5 14 5v6L8 14.5 2 11V5L8 1.5Z"/><path d="M8 1.5V8M8 8l6-3M8 8l-6-3M8 8v6.5"/></g></svg>',
    copilot:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
      '<g stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round">' +
      '<line x1="8" y1="2.5" x2="8" y2="5"/><rect x="2.5" y="5" width="11" height="7" rx="3"/>' +
      '<line x1="2.5" y1="8.5" x2="1.5" y2="8.5"/><line x1="13.5" y1="8.5" x2="14.5" y2="8.5"/></g>' +
      '<g fill="currentColor"><circle cx="8" cy="2.2" r="1"/><circle cx="6" cy="8.7" r="1"/><circle cx="10" cy="8.7" r="1"/></g></svg>',
    opencode:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
      '<g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3.5 5 7 8l-3.5 3"/><line x1="8.5" y1="11.5" x2="13" y2="11.5"/></g></svg>',
    cline:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
      '<circle cx="8" cy="2.1" r="1.05" fill="currentColor"/>' +
      '<g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round">' +
      '<line x1="8" y1="3.15" x2="8" y2="4.7"/>' +
      '<path d="M5.1 4.7h5.8a2.9 2.9 0 0 1 2.9 2.9v.5l1 1.7-1 1.7v.5a2.9 2.9 0 0 1-2.9 2.9H5.1a2.9 2.9 0 0 1-2.9-2.9v-.5l-1-1.7 1-1.7v-.5A2.9 2.9 0 0 1 5.1 4.7Z"/></g>' +
      '<g fill="currentColor"><rect x="5.5" y="7.6" width="1.5" height="3.5" rx="0.75"/><rect x="9" y="7.6" width="1.5" height="3.5" rx="0.75"/></g></svg>',
  };
  SOURCE_ICON_SVG['copilot-chat'] = SOURCE_ICON_SVG.copilot;
  // Cline's VS Code extension + terminal CLI share one robot-head mark, as
  // copilot / copilot-chat do above.
  SOURCE_ICON_SVG['cline-cli'] = SOURCE_ICON_SVG.cline;

  // Render inline conversation rows from the host's conversationsData payload.
  // Interpolated host-supplied strings (title/source/ids) go through esc(),
  // the same HTML-escape helper used for markdown rendering below.
  function renderConversations(items) {
    if (!conversationsBody) return;
    items = items || [];
    if (items.length === 0) {
      conversationsBody.innerHTML = '<p class="conv-empty">No conversations linked to this memory.</p>';
      return;
    }
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var source = it.source || 'claude';
      var label = getSourceLabel(source);
      var msgs = it.messageCount || 0;
      html += '<div class="row" data-session="' + esc(it.sessionId) + '" data-hash="' + esc(it.hash) + '" data-source="' + esc(source) + '">';
      var srcSvg = SOURCE_ICON_SVG[source] || '<span class="codicon codicon-comment-discussion"></span>';
      html += '<span class="badge src-' + esc(source) + '" title="' + esc(label) + '" aria-label="' + esc(label) + '">' + srcSvg + '</span>';
      html += '<div class="r-main"><div class="r-title">' + esc(it.title) + '</div></div>';
      html += '<span class="r-meta hide-on-hover">' + msgs + ' msgs</span>';
      html += '<span class="r-actions"><button class="icon-btn danger conv-detach" title="Detach from this memory"><span class="codicon codicon-trash"></span></button></span>';
      html += '</div>';
    }
    conversationsBody.innerHTML = html;
  }

  // Detach: event-delegated click on the (reassigned-each-refresh) body, so no
  // per-row inline handlers (CSP) and no re-bind needed after a rebuild — the
  // listener is registered ONCE below on document. On the host's ack we remove
  // just that row in place and decrement the count chip (mirrors the sidebar's
  // precise in-place update rather than a full-panel rebuild).
  function detachCountEl() {
    var section = document.getElementById('allConversationsSection');
    return section ? section.querySelector('.sec-count') : null;
  }

${buildSourceLabelScript()}

  // Escape helper for interpolating host-supplied strings into innerHTML.
  function esc(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Conversations section binding (init + after conversationsUpdated) ────
  // After conversationsUpdated replaces #allConversationsSection the old body
  // container + stats element are discarded, so we re-grab both refs on every
  // rebuild (this function is the single re-bind entrypoint).
  function bindConversationsSection() {
    conversationsStats = document.getElementById('conversationsStats');

    // Kick off / refresh the async stats line for the (possibly new) element.
    if (conversationsStats) vscode.postMessage({ command: 'loadTranscriptStats' });

    // Inline Conversations rows (mockup): re-grab the body container and request
    // per-conversation data. Fires on init AND after every conversationsUpdated
    // rebuild (this function is the single re-bind entrypoint), so the rows are
    // never left stuck on the build-time "Loading…" placeholder — the
    // lazy-trigger-on-every-entrypoint rule.
    conversationsBody = document.getElementById('conversationsBody');
    if (conversationsBody) vscode.postMessage({ command: 'loadConversations' });
  }
  bindConversationsSection();

  // ── Files panel (per-file status + diff, Task 9) ─────────────────────────
  // This document has no tab-switching (unlike the sidebar) — #filesBody is
  // only ever rebuilt by a full webview.html re-render (update()), never by a
  // partial replaceSection, so the single init-time bind below is the only
  // entrypoint that needs the request (still following the
  // lazy-trigger-on-every-entrypoint rule: one entrypoint here, one request).
  var filesBody = document.getElementById('filesBody');
  var filesCommitHash = '';

  // Renders the Files panel body from the host's files:rows payload. This is
  // the single row renderer for the Files panel — there is no server-side
  // equivalent; SummaryHtmlBuilder.ts only emits the loading shell
  // (buildFilesPanelShell) at initial render time. Resolvable rows carry
  // data-path/data-status (and data-old-path for renames, so a rename's
  // diff can resolve its pre-rename blob); off-branch rows render inert
  // (.is-unresolvable, no data-path) with a trailing hint naming the branch.
  function renderFiles(rows, offBranch, branch) {
    if (!filesBody) return;
    rows = rows || [];
    var countEl = document.getElementById('filesCount');
    if (countEl) countEl.textContent = String(rows.length);
    if (rows.length === 0) {
      filesBody.innerHTML = '<p class="files-loading">No files changed in this commit.</p>';
      return;
    }
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var f = rows[i];
      var fname = f.path.indexOf('/') >= 0 ? f.path.slice(f.path.lastIndexOf('/') + 1) : f.path;
      var cls = offBranch ? 'row is-unresolvable' : 'row';
      var dataOldPath = (!offBranch && f.status === 'R' && f.oldPath) ? ' data-old-path="' + esc(f.oldPath) + '"' : '';
      var dataPath = offBranch ? '' : ' data-path="' + esc(f.path) + '" data-status="' + esc(f.status) + '"' + dataOldPath;
      var title = offBranch ? ' title="Diffs open only on the checked-out branch"' : '';
      html += '<div class="' + cls + '"' + dataPath + title + '>' +
        '<div class="r-main"><div class="r-title fname-' + esc(f.status) + '">' + esc(fname) + '</div>' +
        '<div class="r-sub">' + esc(f.dir) + '</div></div>' +
        '<span class="gs gs-' + esc(f.status) + '">' + esc(f.status) + '</span></div>';
    }
    if (offBranch) {
      html += '<p class="muted files-offbranch-hint"><span>Diffs open only on the checked-out branch. Check out <code>' +
        esc(branch) + '</code> to view these changes.</span></p>';
    }
    filesBody.innerHTML = html;
  }

  function bindFilesSection() {
    filesBody = document.getElementById('filesBody');
    if (filesBody) vscode.postMessage({ command: 'loadFiles' });
  }
  bindFilesSection();

  // Delegated click for resolvable file rows (registered ONCE — filesBody is
  // only replaced by a full page re-render, but delegation on document keeps
  // this robust either way and matches the conv-detach / commitFile pattern).
  document.addEventListener('click', function(e) {
    var row = e.target && e.target.closest ? e.target.closest('#filesPanel .row[data-path]') : null;
    if (!row) return;
    vscode.postMessage({
      command: 'openFileDiff',
      path: row.getAttribute('data-path'),
      commitHash: filesCommitHash,
      status: row.getAttribute('data-status') || 'M',
      oldPath: row.getAttribute('data-old-path') || undefined,
    });
  });

  // GLOBAL delegated detach click — registered ONCE. Reads the row's data-*
  // attributes so it survives conversationsData re-renders without re-binding.
  document.addEventListener('click', function(e) {
    var btn = e.target && e.target.closest ? e.target.closest('.conv-detach') : null;
    if (!btn) return;
    var row = btn.closest('.row');
    if (!row) return;
    vscode.postMessage({
      command: 'conversationDetach',
      hash: row.getAttribute('data-hash'),
      sessionId: row.getAttribute('data-session'),
      source: row.getAttribute('data-source'),
    });
  });

  // GLOBAL delegated conversation-row click — opens the transcript in a
  // read-only ConversationDetailsPanel (archived snapshot off the orphan
  // branch). Registered ONCE; reads data-* so it survives conversationsData
  // rebuilds. Guarded against the detach button (its own handler above) so a
  // detach click doesn't also open the panel.
  document.addEventListener('click', function(e) {
    if (!e.target || !e.target.closest) return;
    if (e.target.closest('.conv-detach')) return;
    var row = e.target.closest('.conversations-body .row[data-session]');
    if (!row) return;
    vscode.postMessage({
      command: 'openConversation',
      sessionId: row.getAttribute('data-session'),
      source: row.getAttribute('data-source'),
    });
  });

  // Matches a row by the same 'source:sessionId' composite identity the host
  // groups sessions by, not bare sessionId — two different sources can mint
  // the same raw sessionId, so a sessionId-only lookup could resolve to (or
  // remove) the wrong row.
  function conversationRowSelector(sessionId, source) {
    var cssEsc = window.CSS && CSS.escape ? CSS.escape : function(s) { return s; };
    return '.row[data-session="' + cssEsc(sessionId) + '"][data-source="' + cssEsc(source || 'claude') + '"]';
  }

  // Handle transcript messages from extension
  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (msg.command === 'conversationsData') {
      renderConversations(msg.items || []);
      var cnt = detachCountEl();
      if (cnt) cnt.textContent = String((msg.items || []).length);
    }
    if (msg.command === 'conversationDetached') {
      // Precise in-place removal (no full-panel rebuild): drop just the acked
      // row and decrement the count chip.
      var sid = msg.sessionId;
      if (conversationsBody && sid != null) {
        var gone = conversationsBody.querySelector(conversationRowSelector(sid, msg.source));
        if (gone) gone.remove();
        var remaining = conversationsBody.querySelectorAll('.row').length;
        var cntEl = detachCountEl();
        if (cntEl) cntEl.textContent = String(remaining);
        if (remaining === 0) {
          conversationsBody.innerHTML = '<p class="conv-empty">No conversations linked to this memory.</p>';
        }
      }
    }
    if (msg.command === 'transcriptStatsLoaded') {
      if (conversationsStats) {
        var sessionCounts = msg.sessionCounts || {};
        var parts = [];
        var sourceOrder = ['claude', 'codex', 'gemini', 'opencode', 'cursor', 'copilot', 'copilot-chat', 'cline', 'cline-cli'];
        for (var i = 0; i < sourceOrder.length; i++) {
          var source = sourceOrder[i];
          var count = sessionCounts[source] || 0;
          if (count > 0) parts.push('<strong>' + count + '</strong> ' + getSourceLabel(source));
        }
        var totalSessions = 0;
        for (var key in sessionCounts) {
          if (Object.prototype.hasOwnProperty.call(sessionCounts, key)) {
            totalSessions += sessionCounts[key] || 0;
          }
        }
        conversationsStats.innerHTML = '<strong>' + msg.totalEntries + '</strong> entries across <strong>' + totalSessions + '</strong> session' + (totalSessions !== 1 ? 's' : '') + ' (' + parts.join(', ') + ')';
      }
    }
    if (msg.command === 'files:rows') {
      filesCommitHash = msg.commitHash || '';
      renderFiles(msg.rows, !!msg.offBranch, msg.branch || '');
    }
  });

  ${options.autoOpenShare ? `shareOpen(${JSON.stringify(defaultShareKind)});` : ""}
`;
}
