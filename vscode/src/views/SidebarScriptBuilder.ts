/**
 * SidebarScriptBuilder
 *
 * Returns the client-side JS for the sidebar webview.
 *
 * Responsibilities (added incrementally across phases):
 *   - Tab switching + persistence (vscode.setState/getState)
 *   - Message bus to/from extension
 *   - DOM-based renderers for each tab's content
 *
 * XSS posture: all renderers build DOM with createElement + textContent +
 * setAttribute via the shared el() helper. We never use innerHTML for content
 * that contains user-supplied strings.
 *
 * !! Backtick landmine: the entire body of buildSidebarScript() is a single
 * template literal (`return ` + backtick + ... + backtick`). Any unescaped
 * backtick INSIDE — including inside JS comments — closes the template
 * literal early and breaks parsing of the whole file. Use single / double
 * quotes (or no quotes) when referring to identifiers in comments below.
 */

import { buildContextMenuGuardScript } from "./ContextMenuGuard.js";

export function buildSidebarScript(): string {
	return `
  ${buildContextMenuGuardScript()}

  const vscode = acquireVsCodeApi();

  // Empty-state strings — populated from a JSON <script> tag injected by HtmlBuilder
  // (Task 35 will fully wire this; for now we read it tolerantly with fallbacks).
  const STRINGS = (function() {
    try {
      const node = document.getElementById('empty-strings');
      return node ? JSON.parse(node.textContent || '{}') : {};
    } catch (_) { return {}; }
  })();

  // ---- DOM helper (used by every renderer). ----
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'className') n.className = String(v);
        else if (k === 'hidden' || k === 'tabIndex') n[k] = v;
        else if (k === 'style') n.setAttribute('style', String(v));
        else if (k === 'text') n.textContent = String(v);
        else if (k === 'title') n.title = String(v);
        else n.setAttribute(k, String(v));
      }
    }
    if (children) {
      const list = Array.isArray(children) ? children : [children];
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c == null) continue;
        if (typeof c === 'string') n.appendChild(document.createTextNode(c));
        else n.appendChild(c);
      }
    }
    return n;
  }
  function mountIn(container, nodes) {
    const arr = Array.isArray(nodes) ? nodes : [nodes];
    container.replaceChildren.apply(container, arr);
  }
  function clear(container) { container.replaceChildren(); }

  // ---- State (persisted via vscode.setState/getState). ----
  // 'authenticated' is NOT persisted from setState: persisting auth across
  // sessions could surface a stale Sign Out button after the user revoked
  // credentials in another window. Always start from the host-pushed truth.
  let state = Object.assign({
    activeTab: 'branch',
    kbMode: 'folders',
    authenticated: false,
    sectionsCollapsed: {},
    // Per-commit expand toggle (hash → bool). Native TreeView starts each
    // commit collapsed; we mirror that default but persist user toggles
    // across reloads via vscode.setState.
    commitsExpanded: {},
    scrollTops: {},
    // Live flag pushed by the host whenever the post-commit Worker is holding
    // the lock. Drives the "AI summary in progress…" indicator on the Branch
    // toolbar. Not persisted — start from false on every load and let the next
    // worker:busy or status push correct it.
    workerBusy: false
  }, vscode.getState() || {});
  // workerBusy is intentionally reset on load (above), even if persisted state
  // had it set — the lock is process-bound and cannot survive a reload.
  state.workerBusy = false;
  function persist() { vscode.setState(state); }

  // Display name for the repo-root header rendered above the KB tree (origin
  // URL basename when available, else workspace basename — see Extension.ts's
  // resolveKbRepoFolderName). Populated from the init message and updated by
  // kb:foldersReset. Empty string falls back to "Memory Bank" so the header
  // still draws on a fresh KB before any push.
  let kbRepoFolder = '';

  // ---- DOM refs ----
  const root = document.getElementById('sidebar-root');
  const tabBar = document.getElementById('tab-bar');
  const tabToolbar = document.getElementById('tab-toolbar');
  const disabledBanner = document.getElementById('disabled-banner');
  const enableBtn = document.getElementById('enable-btn');
  const ctxMenu = document.getElementById('context-menu');
  const tabButtonKb = document.getElementById('tab-button-kb');
  const tabBranchBtn = document.getElementById('tab-button-branch');
  const statusIconBtn = document.getElementById('status-icon-btn');
  const tabContents = {
    kb: document.getElementById('tab-content-kb'),
    branch: document.getElementById('tab-content-branch'),
    status: document.getElementById('tab-content-status')
  };
  // Status panel has two stacked children: the disabled-banner (intro + Enable
  // button shown when state.enabled === false) and the status-entries list
  // (rendered by renderStatus when state.enabled === true). They are siblings
  // — and applyEnabled flips a single hidden flag on each — because renderStatus
  // calls mountIn(statusEntries, ...) which replaceChildren()s its target;
  // mounting into the panel root would clobber the banner.
  const statusEntries = document.getElementById('status-entries');

  // ---- Plain-text tooltip ----
  // Replaces the native title= tooltip on status rows and toolbar buttons. The
  // native title attribute is unreliable in VSCode webviews — focus shifts
  // across the iframe boundary, IPC quirks, and Chromium's per-node hover-rest
  // timer combine to surface as "tooltip sometimes shows, sometimes doesn't".
  // This helper is a deliberately minimal alternative: a single shared <div>,
  // per-element mouseenter/mouseleave listeners, no rich content, no grace
  // window. Element-level listeners (rather than root delegation) keep the
  // logic simple and clean themselves up via GC when the element is removed.
  const textTip = document.getElementById('text-tip');
  let textTipTimer = null;
  const TEXT_TIP_SHOW_DELAY_MS = 600;

  function showTextTip(text, x, y) {
    textTip.textContent = text;
    textTip.classList.remove('hidden');
    // Read after un-hiding so getBoundingClientRect reflects the laid-out box.
    // Position with a small offset from the cursor and clamp to the viewport
    // so long tooltips never escape the right/bottom edges.
    const rect = textTip.getBoundingClientRect();
    const left = Math.max(0, Math.min(x + 12, window.innerWidth - rect.width - 8));
    const top = Math.max(0, Math.min(y + 18, window.innerHeight - rect.height - 8));
    textTip.style.left = left + 'px';
    textTip.style.top = top + 'px';
  }

  function hideTextTip() {
    if (textTipTimer) { clearTimeout(textTipTimer); textTipTimer = null; }
    textTip.classList.add('hidden');
  }

  function attachTextTip(el, text) {
    if (!el || !text) return el;
    // dataset.tip lets callers update the tooltip text without re-attaching the
    // listeners (used by status-icon-btn to follow OK/Warning/Error). Read at
    // show time, not at attach time, so closure text is just the fallback.
    el.dataset.tip = text;
    let lastX = 0;
    let lastY = 0;
    el.addEventListener('mousemove', function(e) {
      lastX = e.clientX;
      lastY = e.clientY;
    });
    el.addEventListener('mouseenter', function(e) {
      lastX = e.clientX;
      lastY = e.clientY;
      if (textTipTimer) clearTimeout(textTipTimer);
      textTipTimer = setTimeout(function() {
        showTextTip(el.dataset.tip || text, lastX, lastY);
      }, TEXT_TIP_SHOW_DELAY_MS);
    });
    el.addEventListener('mouseleave', function() {
      hideTextTip();
    });
    return el;
  }

  // Status icon lives in the static HTML skeleton (not the toolbar), so attach
  // its tooltip once here. renderStatus updates dataset.tip in lockstep with
  // the indicator color so the hover text always matches the dot.
  if (statusIconBtn) attachTextTip(statusIconBtn, 'Jolli Memory: All good');

  // ---- Tab switching ----
  function switchTab(tab) {
    if (state.activeTab === tab) return;
    const outgoing = tabContents[state.activeTab];
    if (outgoing) state.scrollTops[state.activeTab] = outgoing.scrollTop;

    state.activeTab = tab;
    persist();
    document.querySelectorAll('.tab').forEach(function(elBtn) {
      elBtn.classList.toggle('active', elBtn.getAttribute('data-tab') === tab);
    });
    Object.keys(tabContents).forEach(function(t) { tabContents[t].classList.toggle('hidden', t !== tab); });
    renderToolbar();
    const incoming = tabContents[tab];
    if (incoming) incoming.scrollTop = state.scrollTops[tab] || 0;
    // Tab content can be stale if data arrived while a different tab was active
    // (the message handlers gate renders on activeTab). Re-render on switch so
    // already-cached data appears instead of the initial "Loading..." placeholder.
    if (tab === 'branch') renderBranch();
    else if (tab === 'kb') {
      if (state.kbMode === 'folders') {
        renderFolders();
        // Folders are lazy: host only pushes kb:foldersData in response to a
        // kb:expandFolder request. The init handler fires that request only when
        // initial activeTab is already 'kb'; if the user lands on Branch/Status
        // first and switches to Memory Bank later, the root cache stays empty
        // and renderFolders() is stuck on "Loading...". Re-request on cache miss.
        if (!folderCache['']) vscode.postMessage({ type: 'kb:expandFolder', path: '' });
      } else {
        renderMemories();
      }
    }
    vscode.postMessage({ type: 'tab:switched', tab: tab });
  }

  document.querySelectorAll('.tab').forEach(function(elBtn) {
    elBtn.addEventListener('click', function() { switchTab(elBtn.getAttribute('data-tab')); });
  });

  // Settings button in the tab-bar-right area — not a .tab so not covered above.
  tabBar.addEventListener('click', function(e) {
    const settingsBtn = e.target.closest('[data-action="open-settings"]');
    if (settingsBtn) {
      e.stopPropagation();
      vscode.postMessage({ type: 'command', command: 'jollimemory.openSettings' });
    }
  });

  // ---- Toolbar (tab-specific contents are filled by phase-specific code). ----
  // Helper: build an iconbtn whose visual is a codicon glyph (matches VSCode's
  // native toolbar style). aria-label keeps screen-reader access; the visible
  // hover tooltip is driven by attachTextTip (not the native title attribute).
  function iconButton(action, title, codicon, opts) {
    const toggled = !!(opts && opts.toggled);
    const disabled = !!(opts && opts.disabled);
    const btn = el('button', {
      type: 'button',
      className: 'iconbtn' + (toggled ? ' toggled' : ''),
      'data-action': action,
      'aria-label': title,
    }, [el('i', { className: 'codicon codicon-' + codicon })]);
    // Native HTML disabled: browser blocks click events automatically (so the
    // toolbar event delegation doesn't need a per-action "is it disabled?"
    // check), but mouseenter/leave still fire — attachTextTip keeps working.
    if (disabled) btn.disabled = true;
    return attachTextTip(btn, title);
  }

  function buildKbSearchBox() {
    // Always-visible search affordance for memories mode. Leading magnifier
    // glyph (codicon) sits inside the input box via CSS positioning. Pressing
    // Enter posts kb:search; clearing the box + Enter posts kb:clearSearch
    // (handled by the document keydown listener below).
    const wrap = el('div', { className: 'kb-search-box', id: 'kb-search-box' });
    wrap.appendChild(el('i', { className: 'codicon codicon-search kb-search-icon' }));
    wrap.appendChild(el('input', {
      type: 'text',
      id: 'kb-search-input',
      placeholder: 'Search memories…',
      title: 'Search memories — press Enter',
      'aria-label': 'Search memories',
    }));
    return wrap;
  }

  function renderToolbar() {
    // Toolbar buttons own attachTextTip listeners; the about-to-be-replaced
    // buttons can no longer fire mouseleave to hide a tip whose timer was
    // already in flight, so do it preemptively.
    hideTextTip();
    if (state.activeTab === 'kb') {
      const folderToggled = state.kbMode === 'folders';
      const memoryToggled = state.kbMode === 'memories';
      const items = [];
      // Search input goes first (left). Folders mode has no search backend,
      // so we only render it in memories mode.
      if (memoryToggled) items.push(buildKbSearchBox());
      items.push(iconButton('kb-mode-folders', 'Tree', 'list-tree', { toggled: folderToggled }));
      items.push(iconButton('kb-mode-memories', 'Timeline', 'history', { toggled: memoryToggled }));
      items.push(iconButton('refresh', 'Refresh', 'refresh'));
      mountIn(tabToolbar, items);
    } else if (state.activeTab === 'status') {
      // Order: configuration → account → power → refresh.
      // - Settings (was on the global tab bar; moved here so configuration lives
      //   in the same panel as the status it affects).
      // - Sign In / Sign Out swaps based on state.authenticated; only one is
      //   ever visible (mutually exclusive flows, no point showing both).
      // - Disable: visible only when enabled — toolbar itself is hidden in
      //   disabled mode, and Enable is offered on the disabled-banner instead.
      // - Refresh: rightmost (matches the convention used on the other tabs).
      const items = [
        iconButton('open-settings', 'Settings', 'gear'),
        state.authenticated
          ? iconButton('sign-out', 'Sign Out', 'sign-out')
          : iconButton('sign-in', 'Sign In', 'sign-in'),
        iconButton('disable-jolli', 'Disable Jolli Memory', 'stop-circle'),
        iconButton('refresh', 'Refresh', 'refresh'),
      ];
      mountIn(tabToolbar, items);
    } else {
      // Branch tab: optional left-side worker-busy indicator + refresh.
      // The indicator container is always mounted so the right-edge refresh
      // button stays in a stable position; its inner content is only filled
      // when state.workerBusy is true.
      const items = [];
      const busyEl = el('div', {
        className: 'toolbar-worker-status' + (state.workerBusy ? '' : ' hidden'),
        id: 'toolbar-worker-status'
      });
      if (state.workerBusy) {
        busyEl.appendChild(el('i', {
          className: 'codicon codicon-loading codicon-modifier-spin',
          'aria-hidden': 'true'
        }));
        busyEl.appendChild(el('span', {
          className: 'toolbar-worker-status-text',
          text: 'AI summary in progress…'
        }));
      }
      items.push(busyEl);
      items.push(iconButton('refresh', 'Refresh', 'refresh'));
      mountIn(tabToolbar, items);
    }
  }

  tabToolbar.addEventListener('click', function(e) {
    const btn = e.target.closest('.iconbtn');
    if (!btn) return;
    // Blur immediately so the button doesn't retain focus after click —
    // Chromium suppresses the native title tooltip on a hover-target that
    // is currently the activeElement, which causes "tooltip works once,
    // then never again until you click elsewhere" weirdness on toolbar
    // icons.
    btn.blur();
    const action = btn.getAttribute('data-action');
    if (action === 'refresh') {
      vscode.postMessage({
        type: 'refresh',
        scope: state.activeTab === 'kb' ? 'kb' : state.activeTab === 'branch' ? 'branch' : 'status'
      });
    } else if (action === 'kb-mode-folders' || action === 'kb-mode-memories') {
      state.kbMode = action === 'kb-mode-folders' ? 'folders' : 'memories';
      persist();
      renderToolbar();
      if (state.kbMode === 'folders') renderFolders();
      else renderMemories();
      vscode.postMessage({ type: 'kb:setMode', mode: state.kbMode });
    } else if (action === 'open-settings') {
      vscode.postMessage({ type: 'command', command: 'jollimemory.openSettings' });
    } else if (action === 'sign-in') {
      vscode.postMessage({ type: 'command', command: 'jollimemory.signIn' });
    } else if (action === 'sign-out') {
      vscode.postMessage({ type: 'command', command: 'jollimemory.signOut' });
    } else if (action === 'disable-jolli') {
      vscode.postMessage({ type: 'command', command: 'jollimemory.disableJolliMemory' });
    }
  });

  // The button text + dispatched command are mutated by applyDegraded for
  // no-workspace / no-git modes; data-command on the button is the source of
  // truth so the click handler stays a single line regardless of mode.
  enableBtn.dataset.command = 'jollimemory.enableJolliMemory';
  enableBtn.addEventListener('click', function() {
    vscode.postMessage({ type: 'command', command: enableBtn.dataset.command || 'jollimemory.enableJolliMemory' });
  });

  // Close context menu on outside click.
  document.addEventListener('click', function(e) {
    if (!ctxMenu.contains(e.target)) ctxMenu.classList.add('hidden');
  });

  // ---- Message bus ----
  window.addEventListener('message', function(event) {
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    handleMessage(msg);
  });

  function handleMessage(msg) {
    switch (msg.type) {
      case 'init':
        if (typeof msg.state.authenticated === 'boolean') state.authenticated = msg.state.authenticated;
        if (msg.state.degradedReason) {
          // Degraded path: no workspace folder open, or workspace is not a git
          // repo. Skip the rest of init (data providers aren't wired in this
          // mode, and switchTab/renderToolbar would error out on missing deps).
          applyDegraded(msg.state.degradedReason);
          break;
        }
        applyEnabled(msg.state.enabled);
        if (msg.state.activeTab) switchTab(msg.state.activeTab);
        if (msg.state.kbMode) state.kbMode = msg.state.kbMode;
        if (typeof msg.state.kbRepoFolder === 'string') kbRepoFolder = msg.state.kbRepoFolder;
        renderBranchTabName(msg.state.branchName, msg.state.detached);
        renderToolbar();
        if (msg.state.enabled && state.activeTab === 'kb') {
          if (state.kbMode === 'folders') {
            vscode.postMessage({ type: 'kb:expandFolder', path: '' });
          } else {
            // Memories: extension already pushes data on ready (Task 19), just render with whatever we have.
            renderMemories();
          }
        }
        if (msg.state.enabled && state.activeTab === 'branch') {
          renderBranch();
        }
        persist();
        break;
      case 'enabled:changed':
        applyEnabled(msg.enabled);
        // Toolbar contents (and visibility) depend on enabled — the Status tab
        // toolbar shows the Disable button only while enabled.
        renderToolbar();
        break;
      case 'auth:changed':
        state.authenticated = !!msg.authenticated;
        // The Sign In / Sign Out icon is mutually exclusive on the Status tab
        // toolbar; re-render so the swap takes effect immediately.
        if (state.activeTab === 'status') renderToolbar();
        break;
      case 'worker:busy': {
        const next = !!msg.busy;
        if (state.workerBusy === next) break;
        state.workerBusy = next;
        // Only the Branch tab toolbar shows this indicator; other tabs ignore
        // the flag, so re-render is scoped to avoid wiping their toolbars.
        if (state.activeTab === 'branch') renderToolbar();
        break;
      }
      case 'branch:branchName':
        renderBranchTabName(msg.name, msg.detached);
        break;
      case 'status:data':
        renderStatus(msg.entries);
        break;
      case 'kb:foldersData':
        mergeFolders(msg.tree);
        break;
      case 'kb:foldersReset':
        // Drop every cached level — paths deeper than the root may have been
        // renamed/removed by the host operation that triggered this reset
        // (e.g. Migrate to Memory Bank creates a -N-suffixed folder and the
        // old paths under the prior repo folder no longer apply).
        for (const k in folderCache) delete folderCache[k];
        folderCache[''] = null;
        // Refresh the repo-root header label — Migrate may move the Memory Bank
        // folder to a -N-suffixed name, in which case the header must follow.
        if (typeof msg.kbRepoFolder === 'string') kbRepoFolder = msg.kbRepoFolder;
        // Render immediately so the user sees "Loading..." instead of stale
        // tree contents while the host's follow-up kb:foldersData is in flight.
        if (state.activeTab === 'kb' && state.kbMode === 'folders') renderFolders();
        break;
      case 'kb:memoriesData':
        memoriesState = { items: msg.items.slice(), hasMore: msg.hasMore };
        if (state.activeTab === 'kb' && state.kbMode === 'memories') renderMemories();
        break;
      case 'branch:plansData':
        branchData.plans = msg.items.slice();
        if (state.activeTab === 'branch') renderBranch();
        break;
      case 'branch:changesData':
        branchData.changes = msg.items.slice();
        if (state.activeTab === 'branch') renderBranch();
        break;
      case 'branch:commitsData':
        branchData.commits = msg.items.slice();
        branchData.commitsMode = msg.mode || 'empty';
        if (state.activeTab === 'branch') renderBranch();
        break;
      // Renderers added in later phases handle the remaining message types.
      default:
        break;
    }
  }

  function applyEnabled(enabled) {
    disabledBanner.classList.toggle('hidden', !!enabled);
    statusEntries.classList.toggle('hidden', !enabled);
    // Tab bar itself stays visible always; we hide just the labeled KB / Branch
    // tab buttons so only the Status icon remains in the bar when disabled.
    tabButtonKb.classList.toggle('hidden', !enabled);
    tabBranchBtn.classList.toggle('hidden', !enabled);
    tabToolbar.classList.toggle('hidden', !enabled);
    // Invalidate the status-entries cache: visibility flipped, so the next
    // status:data push must repaint regardless of whether the JSON changed.
    lastStatusEntriesJson = null;

    // Sync the .active class on tab buttons. When disabled, the Status icon is
    // the only visible tab and Status content is force-shown, so the icon
    // should look active regardless of state.activeTab. state.activeTab is
    // preserved untouched so re-enabling restores the user's previous tab.
    const visualActive = enabled ? state.activeTab : 'status';
    document.querySelectorAll('.tab').forEach(function(elBtn) {
      elBtn.classList.toggle('active', elBtn.getAttribute('data-tab') === visualActive);
    });

    if (enabled) {
      // Normal mode: only the active tab's content is visible.
      Object.keys(tabContents).forEach(function(t) {
        tabContents[t].classList.toggle('hidden', t !== state.activeTab);
      });
    } else {
      // Disabled mode: hide KB and Branch panels, force Status panel visible
      // so the disabled-banner inside it (intro + Enable button) is the only
      // thing the user sees — no labeled tabs, no toolbar, no entries area.
      tabContents.kb.classList.add('hidden');
      tabContents.branch.classList.add('hidden');
      tabContents.status.classList.remove('hidden');
    }
  }

  // Degraded mode (no workspace / no git) reuses the disabled visuals — same
  // hidden tabs/toolbar, same banner-only Status panel — but swaps the banner
  // copy and primary-button command for the reason-specific CTA. The standard
  // "Enable Jolli Memory" path doesn't apply because the underlying problem is
  // outside our control (user must open a folder or init git first).
  function applyDegraded(reason) {
    applyEnabled(false);
    const intro = disabledBanner.querySelector('.disabled-intro');
    if (reason === 'no-workspace') {
      if (intro) intro.textContent = 'Open a folder to start capturing memories from your AI coding sessions.';
      enableBtn.textContent = 'Open Folder';
      enableBtn.dataset.command = 'vscode.openFolder';
    } else if (reason === 'no-git') {
      if (intro) intro.textContent = 'This folder is not a git repository. Jolli Memory needs git to track commit summaries.';
      enableBtn.textContent = 'Initialize Git';
      enableBtn.dataset.command = 'jollimemory.initGit';
    }
  }

  function renderBranchTabName(name, detached) {
    // Tab button is "<i class=codicon> + <span class=tab-label>" — only update
    // the label text so we never wipe the leading icon. textContent on the
    // button itself would clobber the <i> child.
    const labelEl = tabBranchBtn.querySelector('.tab-label');
    if (!name) {
      if (labelEl) labelEl.textContent = '(no branch)';
      tabBranchBtn.title = '';
      return;
    }
    if (detached) {
      const short = name.length > 7 ? name.slice(0, 7) : name;
      if (labelEl) labelEl.textContent = '(detached: ' + short + ')';
      tabBranchBtn.title = 'detached HEAD: ' + name;
      return;
    }
    if (labelEl) labelEl.textContent = name;
    tabBranchBtn.title = name;
  }

  // Map iconColor / iconKey to a predefined CSS class (defined in
  // SidebarCssBuilder). We use a class instead of a dynamic style="color:..."
  // attribute because the webview's CSP has no 'unsafe-inline' for style-src,
  // which blocks inline style attributes. CSS rules in our nonced <style>
  // block are unaffected.
  //   1) Known iconColor token → semantic class
  //   2) Missing iconColor → infer from semantic iconKey (check=green, x=red, …)
  // Hoisted out of renderStatus so renderPlanRow (and any future renderer)
  // can share the same iconKey → CSS class mapping.
  const COLOR_CLASS_BY_TOKEN = {
    'charts.green':  'icon-color-green',
    'charts.red':    'icon-color-red',
    'charts.yellow': 'icon-color-yellow',
  };
  const COLOR_CLASS_BY_KEY = {
    'check': 'icon-color-green', 'pulse': 'icon-color-green',
    'globe': 'icon-color-green', 'pass':  'icon-color-green',
    'x': 'icon-color-red', 'error': 'icon-color-red',
    'warning': 'icon-color-yellow', 'alert': 'icon-color-yellow',
  };
  function pickIconColorClass(iconColor, iconKey) {
    if (iconColor && COLOR_CLASS_BY_TOKEN[iconColor]) return COLOR_CLASS_BY_TOKEN[iconColor];
    if (iconKey && COLOR_CLASS_BY_KEY[iconKey]) return COLOR_CLASS_BY_KEY[iconKey];
    return '';
  }

  // Cache of last rendered entries (JSON). status:data fires on every
  // statusProvider.onDidChangeTreeData — including frequent setWorkerBusy
  // toggles and watcher-driven refresh()es that often produce semantically
  // identical entries. Re-running mountIn() in those cases destroys the row
  // DOM under the cursor, which prevents Chromium's native title tooltip from
  // ever reaching its ~500ms hover-rest threshold (the new node never
  // receives a fresh mouseenter while the cursor is stationary). Skip the
  // rebuild when nothing changed; still update the tab-bar indicator dot
  // since that's a className tweak on an existing node and never replaces
  // the hover target.
  let lastStatusEntriesJson = null;

  function renderStatus(entries) {
    const container = statusEntries;
    const entriesJson = JSON.stringify(entries || []);
    const changed = entriesJson !== lastStatusEntriesJson;
    lastStatusEntriesJson = entriesJson;

    if (changed) {
      // Hide any tooltip that was anchored to a row about to be replaced.
      // Without this the tip would orphan: its mouseleave listener belongs to
      // the old row which is being removed, so it never fires to hide the tip.
      hideTextTip();
      if (!entries || entries.length === 0) {
        mountIn(container, el('div', { className: 'empty-state', text: 'No status to display.' }));
      } else {
        const rows = entries.map(function(e) {
          const colorClass = pickIconColorClass(e.iconColor, e.iconKey);
          const row = el('div', {
            className: 'status-entry',
            'data-command': e.command ? e.command.command : null,
            'data-command-args': e.command && e.command.args ? JSON.stringify(e.command.args) : null,
          }, [
            e.iconKey ? el('i', {
              className: 'codicon codicon-' + e.iconKey + (colorClass ? ' ' + colorClass : ''),
            }) : null,
            el('span', { className: 'label', text: e.label }),
            el('span', { className: 'desc', text: e.description || '' }),
          ]);
          return attachTextTip(row, e.tooltip || '');
        });
        mountIn(container, rows);
      }
    }

    // Update the status indicator color (and matching tooltip text) based on
    // overall health. The dot and the tip travel together so a red dot never
    // says "All good" — they read the same entries array in one pass.
    const indicator = document.querySelector('#status-icon-btn .codicon');
    if (indicator) {
      // Worst icon color wins: red > yellow > green (default).
      let cls = 'status-icon-ok';
      let tip = 'Jolli Memory: All good';
      const list = entries || [];
      for (let i = 0; i < list.length; i++) {
        const c = list[i].iconColor;
        const k = list[i].iconKey;
        if (c === 'charts.red' || k === 'x' || k === 'error') {
          cls = 'status-icon-error';
          tip = 'Jolli Memory: Errors';
          break;
        }
        if (c === 'charts.yellow' || k === 'warning' || k === 'alert') {
          cls = 'status-icon-warn';
          tip = 'Jolli Memory: Warnings';
        }
      }
      indicator.className = 'codicon codicon-circle-filled ' + cls;
      if (statusIconBtn) statusIconBtn.dataset.tip = tip;
    }
  }

  // Click delegation for status entries with a command.
  tabContents.status.addEventListener('click', function(e) {
    const row = e.target.closest('.status-entry[data-command]');
    if (!row) return;
    const command = row.getAttribute('data-command');
    const argsRaw = row.getAttribute('data-command-args');
    let args;
    try { args = argsRaw ? JSON.parse(argsRaw) : undefined; } catch (_) { args = undefined; }
    vscode.postMessage({ type: 'command', command: command, args: args });
  });

  // Status panel has no row-level right-click actions, but we still kill the
  // embedded-Chromium native menu so users don't see Cut/Copy/Reload — same
  // policy as the empty-area branches in the KB and Branch panels.
  tabContents.status.addEventListener('contextmenu', function(e) {
    e.preventDefault();
  });

  // ---- Folders tree renderer ----
  // Cache: relPath → FolderNode (most recent server response merged in).
  const folderCache = { '': null };

  function renderFolders() {
    const container = tabContents.kb;
    const root = folderCache[''];
    if (!root) {
      mountIn(container, el('div', { className: 'placeholder', text: 'Loading...' }));
      return;
    }
    // The Memory Bank tree is rendered with a single repo-root header node at
    // depth 0, mirroring the IntelliJ Memory Bank view (MB > <repoName> >
    // <branch> > <files>). The header label is kbRepoFolder, which
    // Extension.ts computes from the git origin URL — so opening a worktree
    // shows the real repo name, not the worktree directory name. Children
    // always render at depth 1, regardless of whether the listing has data,
    // so the header is visible (and useful) even on a fresh Memory Bank.
    const repoLabel = kbRepoFolder || 'Memory Bank';
    const repoHeader = el(
      'div',
      {
        className: 'tree-node expanded',
        'data-indent': '0',
        'data-kind': 'repo-root',
        title: repoLabel,
      },
      [
        el('i', { className: 'codicon codicon-chevron-down commit-twirl' }),
        el('span', { className: 'icon' }, [
          el('i', { className: 'codicon codicon-repo' }),
        ]),
        el('span', { className: 'label', text: repoLabel }),
      ],
    );
    const nodes = [repoHeader];
    if (!root.children || root.children.length === 0) {
      nodes.push(
        el('div', {
          className: 'empty-state',
          text: STRINGS.kbFoldersEmpty || 'No files yet.',
        }),
      );
    } else {
      const kids = renderFolderChildren(root.children, 1);
      for (let i = 0; i < kids.length; i++) nodes.push(kids[i]);
    }
    mountIn(container, nodes);
  }

  function renderFolderChildren(children, depth) {
    const out = [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const isDir = child.isDirectory;
      const expanded = isDir && Array.isArray(child.children);
      const fileKind = isDir ? '' : (child.fileKind || 'other');
      const attrs = {
        className: 'tree-node' + (expanded ? ' expanded' : ''),
        'data-indent': String(depth),
        'data-kind': isDir ? 'dir' : 'file',
        'data-path': child.relPath,
      };
      if (!isDir) {
        attrs['data-file-kind'] = fileKind;
        if (child.fileKey) attrs['data-key'] = child.fileKey;
      }
      // Manifest-tracked files show their human-readable title (commit message
      // for memories, slug/id for plans/notes) in place of the slug-style
      // filename — matching the Memories view's row display. Multi-line commit
      // messages are truncated to the first line; full filename moves to the
      // hover title so the user can still find files by their on-disk name.
      let labelText = child.name;
      let titleAttr = '';
      if (!isDir && child.fileTitle) {
        const firstLine = String(child.fileTitle).split('\\n')[0];
        labelText = firstLine.length > 0 ? firstLine : child.name;
        titleAttr = child.name;
      }
      // Chevron: codicon-chevron-right ↔ chevron-down, identical pattern to
      // the commit row chevron ([data-commit-toggle] elsewhere). File rows
      // get an empty placeholder so labels stay column-aligned with dirs.
      const twirl = isDir
        ? el('i', {
            className:
              'codicon ' +
              (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right') +
              ' commit-twirl',
          })
        : el('span', { className: 'twirl' });
      // Icon column:
      //   - dirs → codicon-folder (the repo-root header has its own renderer
      //     with codicon-repo; children always start at depth >= 1 here)
      //   - memory/plan/note files → codicon-markdown (all are .md), tinted
      //     by .kb-icon-{kind} class so the kind reads at a glance
      //   - other files → codicon-file
      let iconCodicon;
      if (isDir) {
        iconCodicon = 'folder';
      } else if (fileKind === 'memory' || fileKind === 'plan' || fileKind === 'note') {
        iconCodicon = 'markdown';
      } else {
        iconCodicon = 'file';
      }
      const iconKindClass =
        !isDir && fileKind !== 'other' ? ' kb-icon-' + fileKind : '';
      const iconEl = el('span', { className: 'icon' + iconKindClass }, [
        el('i', { className: 'codicon codicon-' + iconCodicon }),
      ]);
      // Label + trailing kind tag (plan / note only). memory has no tag —
      // the tinted markdown icon already conveys "this is a memory MD".
      const labelChildren = [
        el('span', { className: 'label', text: labelText }),
      ];
      if (!isDir && (fileKind === 'plan' || fileKind === 'note')) {
        labelChildren.push(
          el('span', {
            className: 'kb-tag kb-tag-' + fileKind,
            text: fileKind === 'plan' ? 'P' : 'N',
            title: fileKind === 'plan' ? 'Plan' : 'Note',
          }),
        );
      }
      const rowChildren = [twirl, iconEl].concat(labelChildren);
      if (titleAttr) attrs.title = titleAttr;
      const row = el('div', attrs, rowChildren);
      out.push(row);
      if (expanded && child.children) {
        const kids = renderFolderChildren(child.children, depth + 1);
        for (let k = 0; k < kids.length; k++) out.push(kids[k]);
      }
    }
    return out;
  }

  // Replace folderCache[path]=node, then bubble the new reference up through
  // every ancestor's children array so a fresh object replaces each ancestor.
  // Without bubble-up, render walks folderCache[''] and sees stale references
  // for any node deeper than depth 1 — e.g. expanding 'projects/repo' would
  // update folderCache['projects'] but folderCache[''].children[projectsIdx]
  // would still point at the pre-expansion object, hiding the new children.
  function propagateUp(startPath, startNode) {
    let currentPath = startPath;
    let currentNode = startNode;
    while (currentPath !== '') {
      const parts = currentPath.split('/');
      parts.pop();
      const parentPath = parts.join('/');
      const parent = folderCache[parentPath];
      if (!parent || !parent.children) return;
      const idx = parent.children.findIndex(function(c) { return c.relPath === currentPath; });
      if (idx < 0) return;
      const newKids = parent.children.slice();
      newKids[idx] = currentNode;
      const newParent = Object.assign({}, parent, { children: newKids });
      folderCache[parentPath] = newParent;
      currentNode = newParent;
      currentPath = parentPath;
    }
  }

  // Re-attach already-expanded subtrees from folderCache onto a freshly fetched
  // root listing. KbFoldersService returns lazy directory children (children:
  // undefined), and renderFolderChildren treats only Array-typed children as
  // "expanded" — so without this, manual refresh would collapse every folder
  // the user had open. Cache-miss entries (newly visible folders) keep their
  // lazy form so they render closed, which is correct.
  // After a kb:foldersReset the cache is empty, so this is a no-op for rebuild.
  function reattachExpandedFromCache(node) {
    if (!node || !node.isDirectory || !Array.isArray(node.children)) return node;
    const newChildren = node.children.map(function(child) {
      if (!child.isDirectory) return child;
      const cached = folderCache[child.relPath];
      if (cached && Array.isArray(cached.children)) {
        return reattachExpandedFromCache(cached);
      }
      return child;
    });
    return Object.assign({}, node, { children: newChildren });
  }

  // Merge incoming kb:foldersData into the cache, then re-render.
  function mergeFolders(tree) {
    if (tree.relPath === '') tree = reattachExpandedFromCache(tree);
    folderCache[tree.relPath] = tree;
    propagateUp(tree.relPath, tree);
    if (state.activeTab === 'kb' && state.kbMode === 'folders') renderFolders();
  }

  let memoriesState = { items: [], hasMore: false };

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const s = Math.floor(diff / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.floor(h / 24);
    return d + 'd ago';
  }

  function renderMemories() {
    const container = tabContents.kb;
    const nodes = [];
    if (memoriesState.items.length === 0) {
      nodes.push(el('div', { className: 'empty-state', text: STRINGS.kbMemoriesEmpty || 'No memories yet.' }));
      mountIn(container, nodes);
      return;
    }
    for (let i = 0; i < memoriesState.items.length; i++) {
      const m = memoriesState.items[i];
      // No title= attribute — hover content is rendered by the custom
      // .hover-card popup (renderHoverCard / showHoverCard below) so the
      // legacy native MarkdownString experience (codicons + command links)
      // can be reproduced. A title= would surface a duplicate native tooltip.
      const row = el('div', {
        className: 'memory-row',
        'data-id': m.id,
        'data-hash': m.commitHash,
      }, [
        // Leading M icon mirrors the Tree view (codicon-markdown tinted via
        // kb-icon-memory) so a Memories-list row reads as the same artifact
        // type as the Tree-mode memory file.
        el('span', { className: 'memory-row-icon kb-icon-memory' }, [
          el('i', { className: 'codicon codicon-markdown' }),
        ]),
        el('div', { className: 'memory-row-main' }, [
          el('div', { className: 'title', text: m.title }),
          el('div', { className: 'meta' }, [
            el('span', { className: 'hash', text: m.commitHash.slice(0, 8) }),
            ' ',
            el('span', { className: 'branch', text: m.branch }),
            ' ',
            el('span', { className: 'time', text: timeAgo(m.timestamp) }),
          ]),
        ]),
        el('span', { className: 'inline-actions' }, [
          // Native title= is unreliable across webview focus transitions
          // (see iconButton helper at the top of this file); attachTextTip
          // drives the visible tooltip via the same plain-text tip popover
          // used by toolbar buttons + status-icon-btn.
          attachTextTip(
            el('button', {
              type: 'button',
              className: 'iconbtn',
              'data-inline': 'copy-recall',
              'data-hash': m.commitHash,
              'aria-label': 'Copy Recall Prompt',
            }, [el('i', { className: 'codicon codicon-copy' })]),
            'Copy Recall Prompt',
          ),
        ]),
      ]);
      nodes.push(row);
    }
    if (memoriesState.hasMore) {
      // Leading chevron-down occupies the same 16px icon column as the M
      // glyph on real memory rows so the load-more row's text starts at the
      // same x-coordinate (column-alignment, not pixel-padding tweaking).
      // No kb-icon-memory tint — load-more is an action, not a memory.
      nodes.push(el('div', { className: 'memory-row', 'data-action': 'load-more' }, [
        el('span', { className: 'memory-row-icon' }, [
          el('i', { className: 'codicon codicon-chevron-down' }),
        ]),
        el('div', { className: 'title', text: 'Load more...' }),
      ]));
    }
    mountIn(container, nodes);
  }

  // ---- Memory hover card (replaces native title= tooltip with a 1:1
  // reproduction of the legacy MarkdownString tooltip: codicons + command
  // links). CSP-safe: positioned via JS-driven CSSStyleDeclaration writes,
  // never via HTML inline style attributes (see context-menu pattern below).
  const hoverCardEl = document.getElementById('memory-hover');
  let hoverHideTimer = null;
  let hoverCurrentHash = null;

  // Renders the .hover-card body for a normalized entry produced by
  // lookupHoverEntry: { commitHash, hover, hasMemory }. The shape lets
  // Memories rows (which always have a memory) and Commits rows (where
  // hasMemory is per-commit) feed the same renderer.
  function renderHoverCard(m) {
    const h = m && m.hover;
    if (!h) return null;
    const kids = [el('div', { className: 'hc-title', text: h.message })];
    kids.push(el('div', { className: 'hc-row' }, [
      el('i', { className: 'codicon codicon-clock' }),
      el('span', { text: h.relativeDate }),
    ]));
    if (h.commitType) {
      kids.push(el('div', { className: 'hc-row' }, [
        el('i', { className: 'codicon codicon-tag' }),
        el('span', { text: h.commitType }),
      ]));
    }
    // Branch line is Memories-only: Commits rows omit it because the entire
    // Branch panel already represents one branch — a per-row branch line
    // would just repeat the section header.
    if (h.branch) {
      kids.push(el('div', { className: 'hc-row' }, [
        el('i', { className: 'codicon codicon-git-branch' }),
        el('span', { text: h.branch }),
      ]));
    }
    if (h.statsLine) {
      kids.push(el('hr'));
      kids.push(el('div', { className: 'hc-stats', text: h.statsLine }));
    }
    kids.push(el('hr'));
    const actions = [
      el('span', {
        className: 'hc-link',
        'data-cmd': 'jollimemory.copyCommitHash',
        'data-hash': m.commitHash,
        title: 'Copy commit hash',
      }, [
        el('i', { className: 'codicon codicon-git-commit' }),
        el('span', { className: 'hc-hash', text: h.shortHash }),
        el('i', { className: 'codicon codicon-copy' }),
      ]),
    ];
    // The View Commit Memory link only makes sense when a summary actually
    // exists — for memory-less commits the command would dead-end on a 404.
    // Memories rows always have a summary so hasMemory is forced true at
    // lookup time.
    if (m.hasMemory) {
      // Memory rows route to the "memory" panel slot (viewMemorySummary);
      // Commit rows route to the "commit" panel slot (viewSummary). The two
      // slots are independent SummaryWebviewPanel instances — picking the
      // right one keeps the hover-card click consistent with the legacy
      // tooltip command links from each surface.
      actions.push(el('span', { className: 'hc-sep', text: '|' }));
      actions.push(el('span', {
        className: 'hc-link',
        'data-cmd': m.viewMemoryCommand,
        'data-hash': m.commitHash,
      }, [
        el('i', { className: 'codicon codicon-eye' }),
        el('span', { text: 'View Commit Memory' }),
      ]));
    }
    kids.push(el('div', { className: 'hc-actions' }, actions));
    return kids;
  }

  // Anchor the popover's top-left corner exactly at the cursor — the
  // row→popover transition is then a zero-distance hop, so mouseout's
  // relatedTarget is the popover and the existing guard keeps it open.
  // Default extends down-right from cursor; flips so the bottom-right
  // corner aligns to the cursor when the default would overflow. A final
  // clamp is a safety net for viewports smaller than the popover.
  function positionHoverCard(mouseX, mouseY) {
    hoverCardEl.style.left = '-9999px';
    hoverCardEl.style.top = '0px';
    const cardRect = hoverCardEl.getBoundingClientRect();
    const edge = 8;
    let left = mouseX;
    let top = mouseY;
    if (left + cardRect.width > window.innerWidth - edge) {
      left = mouseX - cardRect.width;
    }
    if (top + cardRect.height > window.innerHeight - edge) {
      top = mouseY - cardRect.height;
    }
    if (left < edge) left = edge;
    if (top < edge) top = edge;
    hoverCardEl.style.left = left + 'px';
    hoverCardEl.style.top = top + 'px';
  }

  // Locate a hover-card entry for a given commit hash. Memories rows store
  // hover data on MemoryItem; Commit rows store it on the SerializedTreeItem
  // produced by HistoryTreeProvider. Returns a normalized shape so
  // renderHoverCard doesn't care which surface the entry came from.
  // viewMemoryCommand routes the bottom-link click to the right panel slot
  // (memory vs commit) — see Extension.ts registrations.
  function lookupHoverEntry(hash) {
    const memItems = (memoriesState && memoriesState.items) || [];
    for (let i = 0; i < memItems.length; i++) {
      if (memItems[i].commitHash === hash) {
        return {
          commitHash: hash,
          hover: memItems[i].hover,
          hasMemory: true,
          viewMemoryCommand: 'jollimemory.viewMemorySummary',
        };
      }
    }
    const commits = branchData.commits || [];
    for (let j = 0; j < commits.length; j++) {
      // Commit row id is the full commit hash (HistoryTreeProvider sets
      // CommitItem.id = commit.hash). hover may be undefined on stale
      // serializations — renderHoverCard returns null in that case.
      if (commits[j].id === hash) {
        return {
          commitHash: hash,
          hover: commits[j].hover,
          hasMemory: !!commits[j].hasMemory,
          viewMemoryCommand: 'jollimemory.viewSummary',
        };
      }
    }
    return null;
  }

  function showHoverCard(hash, mouseX, mouseY) {
    if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
    // Already showing this hash → don't re-position. Re-anchoring on every
    // bubbled mouseover (.title → .meta etc.) would make the popover jitter
    // along with intra-row mouse movement.
    if (hoverCurrentHash === hash && !hoverCardEl.classList.contains('hidden')) return;
    const m = lookupHoverEntry(hash);
    const content = m && renderHoverCard(m);
    if (!content) return;
    mountIn(hoverCardEl, content);
    hoverCardEl.classList.remove('hidden');
    hoverCurrentHash = hash;
    positionHoverCard(mouseX, mouseY);
  }

  let hoverShowTimer = null;
  const HOVER_SHOW_DELAY_MS = 1000;
  const HOVER_HIDE_GRACE_MS = 200;

  function cancelHoverShow() {
    if (hoverShowTimer) { clearTimeout(hoverShowTimer); hoverShowTimer = null; }
  }

  // Hide the current popover and clear hide-state. Does NOT touch the
  // show timer — show and hide are independent tracks: when switching
  // rows, the old popover's hide timer and the new row's show timer run
  // in parallel (200ms hide grace, then 1s show delay).
  function hideHoverCardNow() {
    if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
    hoverCardEl.classList.add('hidden');
    hoverCurrentHash = null;
  }

  // Full dismissal: cancel any pending show AND hide current popover.
  // Used by contextmenu and link-click — those want to wipe everything.
  function dismissHoverCard() {
    cancelHoverShow();
    hideHoverCardNow();
  }

  function scheduleHideHoverCard() {
    if (hoverHideTimer) clearTimeout(hoverHideTimer);
    // Grace period gives the user time to move the mouse onto the card and
    // click a command link without it disappearing under their cursor.
    hoverHideTimer = setTimeout(hideHoverCardNow, HOVER_HIDE_GRACE_MS);
  }

  // Schedule the popover to appear after a hover-stable delay so quick
  // mouse-throughs don't flash a popover. Crucially, we do NOT cancel a
  // pending hide here when switching rows — the old popover's hide grace
  // runs in parallel with the new row's show delay, matching native
  // VSCode tooltip behaviour (old fades, new appears after its own delay).
  function scheduleShowHoverCard(hash, mouseX, mouseY) {
    if (hoverCurrentHash === hash && !hoverCardEl.classList.contains('hidden')) {
      // Same-row re-hover (e.g. mouse left and came back within 200ms).
      // Cancel the pending hide so the popover stays up. This branch is
      // the ONLY place where we cancel hide from a mouseover — the
      // different-hash branch deliberately leaves hide running.
      if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
      return;
    }
    cancelHoverShow();
    hoverShowTimer = setTimeout(function() {
      hoverShowTimer = null;
      showHoverCard(hash, mouseX, mouseY);
    }, HOVER_SHOW_DELAY_MS);
  }

  tabContents.kb.addEventListener('mouseover', function(e) {
    const row = e.target.closest('.memory-row[data-hash]');
    if (!row) return;
    // Inline action buttons (e.g. Copy Recall) own their own attachTextTip
    // tooltip; dismiss the row hover card so the two don't stack. mouseout
    // can't do this alone — its row.contains(to) guard intentionally keeps
    // the card open during intra-row child transitions.
    if (e.target.closest('.inline-actions')) {
      dismissHoverCard();
      return;
    }
    scheduleShowHoverCard(row.getAttribute('data-hash'), e.clientX, e.clientY);
  });
  tabContents.kb.addEventListener('mouseout', function(e) {
    const row = e.target.closest('.memory-row[data-hash]');
    if (!row) return;
    const to = e.relatedTarget;
    // Stay open if mouse moved onto the hover card itself or stayed on the row.
    if (to && (to === hoverCardEl || hoverCardEl.contains(to) || row.contains(to))) return;
    cancelHoverShow();
    scheduleHideHoverCard();
  });
  hoverCardEl.addEventListener('mouseenter', function() {
    if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
  });
  hoverCardEl.addEventListener('mouseleave', scheduleHideHoverCard);
  hoverCardEl.addEventListener('click', function(e) {
    const link = e.target.closest('[data-cmd]');
    if (!link) return;
    const cmd = link.getAttribute('data-cmd');
    const hash = link.getAttribute('data-hash');
    if (cmd && hash) {
      vscode.postMessage({ type: 'command', command: cmd, args: [hash] });
    }
    // Close the card after invoking — matches native tooltip behaviour where
    // clicking a command link dismisses the tooltip.
    dismissHoverCard();
    e.stopPropagation();
  });

  // Right-click in the KB tab.
  //
  //   - Memories mode (.memory-row): show the legacy 3-action menu (hash-based).
  //   - Folders mode (.tree-node):
  //       * directories — preventDefault but show NO custom menu (so the
  //         browser's native Cut/Copy/Reload menu is suppressed and nothing
  //         takes its place — clean no-op).
  //       * memory MD files — show the same 3-action menu as Memories view,
  //         using the manifest-derived data-key attribute (full commit hash).
  //       * plan / note / other files — same no-op as directories. Plans and
  //         notes have their own menus elsewhere; user-dropped files have
  //         nothing meaningful to act on.
  //   - Empty area (no row hit): preventDefault only — suppresses the
  //     embedded-Chromium "Cut/Copy/Paste/Reload" menu without putting
  //     anything in its place.
  tabContents.kb.addEventListener('contextmenu', function(e) {
    const node = e.target.closest('.tree-node');
    if (node) {
      e.preventDefault();
      dismissHoverCard();
      if (node.getAttribute('data-kind') !== 'file') return;
      if (node.getAttribute('data-file-kind') !== 'memory') return;
      const key = node.getAttribute('data-key');
      if (!key) return;
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Copy Recall Prompt',  command: 'jollimemory.copyRecallPrompt',  args: [key] },
        { label: 'Open in Claude Code', command: 'jollimemory.openInClaudeCode',  args: [key] },
        { separator: true },
        { label: 'View Memory',         command: 'jollimemory.viewMemorySummary', args: [key] },
      ]);
      return;
    }
    const row = e.target.closest('.memory-row[data-hash]');
    if (!row) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    dismissHoverCard();
    const hash = row.getAttribute('data-hash');
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Copy Recall Prompt',  command: 'jollimemory.copyRecallPrompt',  args: [hash] },
      { label: 'Open in Claude Code', command: 'jollimemory.openInClaudeCode',  args: [hash] },
      { separator: true },
      { label: 'View Memory',         command: 'jollimemory.viewMemorySummary', args: [hash] },
    ]);
  });

  // Click delegation: dir → expand/collapse; file → open.
  tabContents.kb.addEventListener('click', function(e) {
    // Inline actions on memory rows (e.g. copy recall prompt). Must run
    // before the .memory-row[data-id] handler so button clicks don't bubble
    // up and accidentally open the memory summary panel.
    const memInline = e.target.closest('.memory-row [data-inline]');
    if (memInline) {
      const action = memInline.getAttribute('data-inline');
      const hash = memInline.getAttribute('data-hash');
      if (action === 'copy-recall' && hash) {
        vscode.postMessage({ type: 'command', command: 'jollimemory.copyRecallPrompt', args: [hash] });
      }
      e.stopPropagation();
      return;
    }
    // Memory list (mode === memories)
    const more = e.target.closest('[data-action="load-more"]');
    if (more) { vscode.postMessage({ type: 'kb:loadMore' }); return; }
    const memRow = e.target.closest('.memory-row[data-hash]');
    if (memRow) {
      vscode.postMessage({ type: 'kb:openMemory', commitHash: memRow.getAttribute('data-hash') });
      return;
    }

    // Folder tree (mode === folders) — existing logic from Task 16
    const node = e.target.closest('.tree-node');
    if (!node) return;
    const kind = node.getAttribute('data-kind');
    const path = node.getAttribute('data-path');
    // Repo-root header is a decorative banner — clicks fall through to a
    // no-op (it has no data-path, and folding the whole tree isn't useful
    // in a single-repo view).
    if (kind === 'repo-root') return;
    if (kind === 'dir') {
      const cached = folderCache[path];
      const expanded = cached && Array.isArray(cached.children);
      if (expanded) {
        // Collapse: drop children to undefined, then propagate up so render
        // sees the collapsed node from the root walk.
        const collapsed = Object.assign({}, cached, { children: undefined });
        folderCache[path] = collapsed;
        propagateUp(path, collapsed);
        renderFolders();
      } else {
        vscode.postMessage({ type: 'kb:expandFolder', path: path });
      }
    } else {
      vscode.postMessage({ type: 'kb:openFile', path: path });
    }
  });

  document.addEventListener('keydown', function(e) {
    const input = document.getElementById('kb-search-input');
    if (input && document.activeElement === input && e.key === 'Enter') {
      const q = (input.value || '').trim();
      if (q.length === 0) {
        vscode.postMessage({ type: 'kb:clearSearch' });
      } else {
        vscode.postMessage({ type: 'kb:search', query: q });
      }
    }
  });

  // ---- Branch tab renderer ----
  let branchData = { plans: [], changes: [], commits: [], commitsMode: 'empty' };

  function isCollapsed(section) {
    return !!state.sectionsCollapsed[section];
  }

  function renderBranch() {
    const container = tabContents.branch;
    const sections = [
      { id: 'plans', title: 'Plans & Notes', items: branchData.plans, emptyText: STRINGS.plansEmpty || 'No plans or notes yet.' },
      { id: 'changes', title: 'Changes', items: branchData.changes, emptyText: STRINGS.changesEmpty || 'No changes.' },
      { id: 'commits', title: 'Commits', items: branchData.commits, emptyText: STRINGS.commitsEmpty || 'No commits yet.' },
    ];
    mountIn(container, sections.map(renderSection));
  }

  function renderSection(s) {
    const collapsed = isCollapsed(s.id);
    const headerKids = [
      el('span', { className: 'twirl', text: '▾' }),
      el('span', { className: 'section-title', text: s.title }),
      el('span', { className: 'section-actions', 'data-section-actions': s.id }, renderSectionActions(s.id)),
    ];
    const rowFn =
      s.id === 'plans'   ? renderPlanRow :
      s.id === 'changes' ? renderChangeRow :
      s.id === 'commits' ? renderCommitRow :
      function(it, depth) { return renderTreeItem(it, depth); };
    // rowFn may return either a single node OR an array (commit rows fan
    // out into commit + nested file children when expanded). Flatten one
    // level so the result is a flat list of DOM nodes the section body
    // can append directly.
    const bodyKids = collapsed
      ? null
      : (s.items.length === 0
          ? [el('div', { className: 'empty-state', text: s.emptyText })]
          : s.items.reduce(function(acc, it) {
              const out = rowFn(it, 0);
              if (Array.isArray(out)) {
                for (let i = 0; i < out.length; i++) acc.push(out[i]);
              } else {
                acc.push(out);
              }
              return acc;
            }, []));
    return el('div', {
      className: 'collapsible-section' + (collapsed ? ' collapsed' : ''),
      'data-section': s.id,
    }, [
      el('div', { className: 'section-header' }, headerKids),
      el('div', { className: 'section-body' }, bodyKids),
    ]);
  }

  function renderSectionActions(sectionId) {
    // Codicons mirror the legacy native TreeView action icons declared in
    // package.json contributes.commands — keeping a single source of truth so
    // webview UI matches command palette / keybindings.
    if (sectionId === 'plans') {
      return [
        iconButton('plans-add-menu', 'Add Plan / Note / Snippet', 'add'),
      ];
    }
    if (sectionId === 'changes') {
      // Commit-AI needs at least one staged change to operate on; Discard
      // similarly has no work to do with zero selection. Disable both below
      // that threshold. Re-enables itself on the next branch:changesData
      // push (which always follows a checkbox toggle on the host side).
      const selectedCount = branchData.changes.filter(function(c) {
        return !!c.isSelected;
      }).length;
      const noneSelected = selectedCount === 0;
      return [
        iconButton('changes-select-all', 'Select/Deselect All Files', 'check-all'),
        iconButton('changes-commit-ai',  'Commit (AI message)',       'sparkle',  { disabled: noneSelected }),
        iconButton('changes-discard',    'Discard Selected Changes',  'discard',  { disabled: noneSelected }),
      ];
    }
    if (sectionId === 'commits') {
      const m = branchData.commitsMode;
      if (m === 'multi') {
        // Squash is only meaningful with 2+ commits selected. Disable the
        // button below that threshold; it auto-re-enables when the user picks
        // a 2nd commit because branch:commitsData triggers renderBranch which
        // rebuilds these section actions with a fresh selectedCount.
        const selectedCount = branchData.commits.filter(function(c) {
          return !!c.isSelected;
        }).length;
        return [
          iconButton('commits-select-all', 'Select/Deselect All Commits', 'check-all'),
          iconButton('commits-squash',     'Squash Selected',             'git-merge', { disabled: selectedCount < 2 }),
        ];
      }
      if (m === 'single') {
        return [
          iconButton('commits-push-branch', 'Push Branch', 'cloud-upload'),
        ];
      }
      return [];
    }
    return [];
  }

  function renderPlanRow(item, depth) {
    const isNote = item.contextValue === 'note';
    // Icon comes from the SerializedTreeItem.iconKey set by
    // PlansTreeProvider — committed entries get "lock" with charts.green,
    // uncommitted plans get "file-text", notes get "note", snippets get
    // "comment". Falls back to a kind-appropriate codicon if iconKey is
    // missing (defensive — should always be set by the provider).
    const iconKey = item.iconKey || (isNote ? 'note' : 'file-text');
    const colorClass = pickIconColorClass(item.iconColor, iconKey);
    const iconEl = el('i', {
      className: 'codicon codicon-' + iconKey + (colorClass ? ' ' + colorClass : ''),
    });
    // Plans rows omit the .row-leading checkbox slot — that 18px column
    // only carries weight in the Changes section (where it holds a real
    // checkbox). Keeping it on plans rows just to vertically align with
    // changes was over-alignment: the two sections are visually
    // independent, so the empty slot read as "something missing".
    const kids = [
      el('span', { className: 'twirl' }),
      el('span', { className: 'icon' }, [iconEl]),
      el('span', { className: 'label', text: item.label }),
    ];
    if (item.description) {
      kids.push(el('span', { className: 'desc', text: item.description }));
    }
    // Inline-actions: only the trash (remove) button. The edit button was
    // dropped because the row click already opens the .md file for editing
    // (see click delegation: ctx 'plan' → editPlan, ctx 'note' → editNote),
    // so a separate edit affordance was redundant.
    kids.push(
      el('span', { className: 'inline-actions' }, [
        el('button', {
          type: 'button',
          className: 'iconbtn',
          'data-inline': 'remove',
          'data-id': item.id,
          title: 'Remove',
          'aria-label': 'Remove',
        }, [el('i', { className: 'codicon codicon-trash' })]),
      ]),
    );
    return el('div', {
      className: 'tree-node',
      'data-indent': String(depth),
      'data-context': item.contextValue || '',
      'data-id': item.id,
      title: item.tooltip || '',
    }, kids);
  }

  function gitStatusToCodicon(s) {
    switch (s) {
      case 'M': return 'codicon-diff-modified';
      case 'A': return 'codicon-diff-added';
      case 'D': return 'codicon-diff-removed';
      case 'R': return 'codicon-diff-renamed';
      case 'U': return 'codicon-diff-added';
      case 'C': return 'codicon-warning';
      case 'I': return 'codicon-diff-ignored';
      default:  return 'codicon-file';
    }
  }

  // Maps a filename (or path) to the closest matching codicon for the
  // commit-file row icon column. We can't access the user's file-icon
  // theme from a webview (that lives inside VSCode's ResourceLabel
  // widget), so we approximate native default icons by extension. The
  // git-status color is applied separately via .gs-{code} so the icon
  // says "what kind of file" while the color says "what changed".
  function pathToFileCodicon(name) {
    const ix = name.lastIndexOf('.');
    const ext = ix >= 0 ? name.slice(ix + 1).toLowerCase() : '';
    if (ext === 'md' || ext === 'markdown') return 'codicon-markdown';
    if (ext === 'json') return 'codicon-json';
    if (ext === 'yaml' || ext === 'yml') return 'codicon-file-code';
    if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') return 'codicon-file-code';
    if (ext === 'css' || ext === 'scss' || ext === 'less') return 'codicon-file-code';
    if (ext === 'html' || ext === 'htm' || ext === 'xml') return 'codicon-file-code';
    if (ext === 'py' || ext === 'rb' || ext === 'go' || ext === 'rs' || ext === 'java' || ext === 'c' || ext === 'cpp' || ext === 'h') return 'codicon-file-code';
    if (ext === 'sh' || ext === 'bash' || ext === 'zsh' || ext === 'fish') return 'codicon-terminal';
    return 'codicon-file';
  }

  function renderChangeRow(item, depth) {
    const gs = item.gitStatus || '';
    const cb = el('input', {
      type: 'checkbox',
      'data-checkbox': '1',
      'data-id': item.id,
    });
    cb.checked = !!item.isSelected;
    // Visual parity with renderCommitFileRow: file-type icon (by extension)
    // + git-status color via .gs-{code}, then label / dirname / trailing
    // letter / hover-only discard. Functional differences (checkbox,
    // discard) live alongside the shared visual language.
    const fileCodicon = pathToFileCodicon(item.description || item.label || '');
    const iconEl = el('i', {
      className: 'codicon ' + fileCodicon + (gs ? ' gs-' + gs : ''),
    });
    const kids = [
      el('span', { className: 'twirl' }),
      el('span', { className: 'row-leading' }, [cb]),
      el('span', { className: 'icon' }, [iconEl]),
      el('span', { className: 'label' + (gs ? ' ' + 'gs-' + gs : ''), text: item.label }),
    ];
    // dirname-only desc — same truncation as commit-file rows.
    if (item.description) {
      const slash = item.description.lastIndexOf('/');
      const descDir = slash > 0 ? item.description.slice(0, slash) : '';
      if (descDir) {
        kids.push(el('span', { className: 'desc', text: descDir }));
      }
    }
    // Trailing layout: [discard (hover-only)] [gs-letter (always)].
    // Order matters — inline-actions is pushed first so the gs-letter
    // sits at the row's right edge; CSS gives inline-actions the
    // margin-left:auto that pushes the whole pair to the right (letter
    // alone gets margin:0 here, overriding the commit-file default).
    // codicon-discard mirrors package.json contributes.commands
    // ["jollimemory.discardFileChanges"], matching the legacy native
    // TreeView affordance 1:1.
    kids.push(
      el('span', { className: 'inline-actions' }, [
        el('button', {
          type: 'button',
          className: 'iconbtn',
          'data-inline': 'discard',
          'data-id': item.id,
          title: 'Discard Changes',
          'aria-label': 'Discard Changes',
        }, [el('i', { className: 'codicon codicon-discard' })]),
      ]),
    );
    if (gs) {
      kids.push(
        el('span', { className: 'gs-letter gs-' + gs, text: gs }),
      );
    }
    return el('div', {
      // tree-node--changes is the hover-reveal hook for inline-actions
      // (CSS scopes the visibility toggle to changes rows so plans / commits
      // keep their always-visible inline buttons).
      className: 'tree-node tree-node--changes',
      'data-indent': String(depth),
      'data-context': item.contextValue || '',
      'data-id': item.id,
      // Stash the two extra fields the openFileChange command needs but
      // can't recover from item.id alone (id is absolutePath; relativePath
      // and statusCode get dropped by the SerializedTreeItem → command
      // bridge unless we surface them explicitly).
      'data-rel-path':    item.description || '',
      'data-status-code': gs,
      title: item.tooltip || '',
    }, kids);
  }

  function renderCommitRow(item, depth) {
    const hasMem = item.contextValue === 'commitWithMemory';
    // Children are pre-serialized by HistoryTreeProvider when CommitItem
    // collapsibleState !== None, so an empty array means "no files in this
    // commit" (rare but possible — empty merge commits) and we suppress the
    // chevron to avoid a no-op expand.
    const expandable = !!(item.children && item.children.length > 0);
    const expanded = expandable && !!state.commitsExpanded[item.id];
    const twirl = expandable
      ? el('i', {
          className:
            'codicon ' +
            (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right') +
            ' commit-twirl',
          'data-commit-toggle': item.id,
          title: expanded ? 'Collapse' : 'Expand',
        })
      : el('span', { className: 'twirl' });
    // Multi-commit mode renders a checkbox for squash-selection; single /
    // merged modes show a git-commit codicon in the slot instead, matching
    // the legacy native TreeView (HistoryTreeProvider set iconPath to
    // ThemeIcon("git-commit") whenever the checkbox was hidden). The slot
    // width is kept constant so commit rows align horizontally with
    // commit-file rows regardless of mode.
    const isMulti = branchData.commitsMode === 'multi';
    let leading;
    if (isMulti) {
      const cb = el('input', {
        type: 'checkbox',
        'data-checkbox': '1',
        'data-checkbox-kind': 'commit',
        'data-id': item.id,
      });
      cb.checked = !!item.isSelected;
      leading = el('span', { className: 'row-leading' }, [cb]);
    } else {
      leading = el('span', { className: 'row-leading' }, [
        el('i', { className: 'codicon codicon-git-commit' }),
      ]);
    }
    // hasMem rows get the M (markdown) glyph tinted via kb-icon-memory —
    // matches the Tree view's memory file rows and the Memories-list rows
    // so all three surfaces share one visual vocabulary for "this row maps
    // to a memory summary". Memory-less commits show codicon-code (< >) at
    // default foreground weight, signalling "code-only commit, not yet
    // promoted to a memory" while keeping the icon column aligned.
    const memIcon = hasMem
      ? el('span', { className: 'icon kb-icon-memory' }, [
          el('i', { className: 'codicon codicon-markdown' }),
        ])
      : el('span', { className: 'icon' }, [
          el('i', { className: 'codicon codicon-code' }),
        ]);
    const kids = [
      twirl,
      leading,
      memIcon,
      el('span', { className: 'label', text: item.label }),
    ];
    if (item.description) {
      kids.push(el('span', { className: 'desc', text: item.description }));
    }
    if (hasMem) {
      kids.push(
        el('span', { className: 'inline-actions' }, [
          el('button', {
            type: 'button',
            className: 'iconbtn',
            'data-inline': 'viewSummary',
            'data-id': item.id,
            title: 'View Memory',
            'aria-label': 'View Memory',
          }, [el('i', { className: 'codicon codicon-eye' })]),
        ]),
      );
    } else {
      kids.push(el('span', { className: 'inline-actions' }));
    }
    // No title= attribute — hover content is rendered by the custom
    // .hover-card popup (renderHoverCard / showHoverCard) so the legacy
    // MarkdownString tooltip experience (codicons + command links) can be
    // reproduced. A title= would surface a duplicate native tooltip.
    const row = el('div', {
      className: 'tree-node',
      'data-indent': String(depth),
      'data-context': item.contextValue || '',
      'data-id': item.id,
    }, kids);
    if (!expanded) return row;
    const fileRows = item.children.map(function(c) {
      return renderCommitFileRow(c, depth + 1);
    });
    return [row].concat(fileRows);
  }

  function renderCommitFileRow(item, depth) {
    const cf = item.commitFile || {};
    const gs = item.gitStatus || cf.statusCode || '';
    // File-type icon (by extension) + git-status color via .gs-{code}.
    // This mirrors native VSCode TreeView's two-channel encoding: shape
    // = what kind of file, color = what changed about it. Falls back to
    // codicon-file when the extension isn't recognized.
    const fileCodicon = pathToFileCodicon(cf.relativePath || item.label || '');
    const iconEl = el('i', {
      className: 'codicon ' + fileCodicon + (gs ? ' gs-' + gs : ''),
    });
    // Native VSCode TreeView fidelity: file row shows
    //   <icon> <label> <description (path)>            <status letter>
    // The path lives in item.description (HistoryTreeProvider sets it
    // from relativePath); the trailing status letter (M / A / D / R / U)
    // goes at the end of the row colored by .gs-{code}. Changes rows
    // intentionally diverge from this — they want a compact look — but
    // commit-file rows mirror the legacy commit-history experience.
    const kids = [
      el('span', { className: 'twirl' }),
      el('span', { className: 'row-leading' }),
      el('span', { className: 'icon' }, [iconEl]),
      el('span', { className: 'label' + (gs ? ' gs-' + gs : ''), text: item.label }),
    ];
    // Description is the full repo-relative path; we only want the
    // directory portion next to the label (e.g. ".github/workflows" for
    // ".github/workflows/publish-cli.yaml"). Root-level files have no
    // slash → no desc rendered. Tooltip / data-rel-path keep the full
    // path for clipboard / diff purposes.
    if (item.description) {
      const slash = item.description.lastIndexOf('/');
      const descDir = slash > 0 ? item.description.slice(0, slash) : '';
      if (descDir) {
        kids.push(el('span', { className: 'desc', text: descDir }));
      }
    }
    if (gs) {
      kids.push(
        el('span', { className: 'gs-letter gs-' + gs, text: gs }),
      );
    }
    // Stash the four fields we need to dispatch openCommitFileChange via
    // data-* attributes — DOM-only state, no extra lookup table needed.
    return el('div', {
      className: 'tree-node',
      'data-indent': String(depth),
      'data-context': 'commitFile',
      'data-id': item.id,
      'data-commit-hash': cf.commitHash || '',
      'data-rel-path':    cf.relativePath || '',
      'data-status-code': cf.statusCode || '',
      'data-old-path':    cf.oldPath || '',
      title: item.tooltip || '',
    }, kids);
  }

  function renderInlineButtons(item) {
    const ctx = item.contextValue || '';
    // Match contextValue strings emitted by PlansTreeProvider — common values are 'plan', 'note', 'plansItem'.
    // Match contextValue strings emitted by FilesTreeProvider — common values are 'file', 'fileChange'.
    // If real contextValue differs, this just returns null and falls through to plain row.
    const isPlanLike = ctx === 'plan' || ctx === 'note' || ctx === 'plansItem';
    const isFile = ctx === 'file' || ctx === 'fileChange';
    if (isPlanLike) {
      return el('span', { className: 'inline-actions' }, [
        el('button', { type: 'button', className: 'iconbtn', 'data-inline': 'edit', 'data-id': item.id, title: 'Edit', text: '✎' }),
        el('button', { type: 'button', className: 'iconbtn', 'data-inline': 'remove', 'data-id': item.id, title: 'Remove', text: '🗑' }),
      ]);
    }
    if (isFile) {
      return el('span', { className: 'inline-actions' }, [
        el('button', { type: 'button', className: 'iconbtn', 'data-inline': 'discard', 'data-id': item.id, title: 'Discard', text: '↻' }),
      ]);
    }
    return null;
  }

  function renderTreeItem(item, depth) {
    const kids = [
      el('span', { className: 'twirl' }),
      el('span', { className: 'icon', text: item.iconKey ? '●' : '·' }),
      el('span', { className: 'label', text: item.label }),
    ];
    if (item.description) {
      kids.push(el('span', { className: 'desc', text: item.description }));
    }
    const inline = renderInlineButtons(item);
    if (inline) kids.push(inline);
    return el('div', {
      className: 'tree-node',
      'data-indent': String(depth),
      'data-context': item.contextValue || '',
      'data-id': item.id,
      title: item.tooltip || '',
    }, kids);
  }

  // Context menu: show and handle clicks.
  //
  // Two dispatch shapes are supported per item:
  //   - { command, args }   → posts { type: 'command', command, args } (default)
  //   - { rawMessage: {...} } → posts the raw message verbatim. Used when the
  //     handler on the host expects a non-'command' message type — e.g.
  //     'branch:discardFile' which carries relativePath / statusCode that the
  //     host bridges back into a FileItem before invoking the real command.
  function showContextMenu(x, y, items) {
    const kids = items.map(function(i) {
      if (i.separator) return el('div', { className: 'menu-separator' });
      const attrs = { className: 'menu-item' };
      if (i.rawMessage) {
        attrs['data-raw-msg'] = JSON.stringify(i.rawMessage);
      } else {
        attrs['data-cmd'] = i.command;
        attrs['data-args'] = JSON.stringify(i.args || []);
      }
      return el('div', attrs, i.label);
    });
    mountIn(ctxMenu, kids);
    ctxMenu.classList.remove('hidden');
    // Position via direct property mutation. CSP gates inline style attributes
    // (parsed from HTML) but allows JavaScript-driven CSSStyleDeclaration writes.
    const rect = ctxMenu.getBoundingClientRect();
    const maxLeft = window.innerWidth - rect.width;
    const maxTop = window.innerHeight - rect.height;
    ctxMenu.style.left = Math.min(x, Math.max(0, maxLeft)) + 'px';
    ctxMenu.style.top = Math.min(y, Math.max(0, maxTop)) + 'px';
  }

  ctxMenu.addEventListener('click', function(e) {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    const rawMsg = item.getAttribute('data-raw-msg');
    if (rawMsg) {
      try { vscode.postMessage(JSON.parse(rawMsg)); } catch (_) { /* malformed payload: drop */ }
    } else {
      const cmd = item.getAttribute('data-cmd');
      let args; try { args = JSON.parse(item.getAttribute('data-args') || '[]'); } catch (_) { args = []; }
      vscode.postMessage({ type: 'command', command: cmd, args: args });
    }
    ctxMenu.classList.add('hidden');
  });

  // Section header + action + inline buttons + row click delegation.
  // Order matters: action buttons live INSIDE the section header (their
  // section-actions wrapper is a header child), so the specific selectors
  // must run before the section-header collapse-toggle catch-all — otherwise
  // every action-button click also collapses the panel.
  tabContents.branch.addEventListener('click', function(e) {
    // Section toolbar actions.
    const sectionAction = e.target.closest('.section-actions [data-action]');
    if (sectionAction) {
      const a = sectionAction.getAttribute('data-action');
      // Plans submenu: open dropdown anchored under the ➕ button.
      if (a === 'plans-add-menu') {
        const r = sectionAction.getBoundingClientRect();
        showContextMenu(r.left, r.bottom + 2, [
          { label: 'Add Plan',          command: 'jollimemory.addPlan' },
          { label: 'Add Markdown Note', command: 'jollimemory.addMarkdownNote' },
          { label: 'Add Text Snippet',  command: 'jollimemory.addTextSnippet' },
        ]);
        e.stopPropagation();
        return;
      }
      const cmdMap = {
        'changes-select-all':  'jollimemory.selectAllFiles',
        'changes-commit-ai':   'jollimemory.commitAI',
        'changes-discard':     'jollimemory.discardSelectedChanges',
        'commits-select-all':  'jollimemory.selectAllCommits',
        'commits-squash':      'jollimemory.squash',
        'commits-push-branch': 'jollimemory.pushBranch',
      };
      if (cmdMap[a]) {
        vscode.postMessage({ type: 'command', command: cmdMap[a] });
        e.stopPropagation();
        return;
      }
    }

    // Commit row chevron: toggles per-commit expansion to reveal nested
    // file children. Must run before the row-click branch below — otherwise
    // clicking the chevron also fires openCommit and opens the diff panel.
    const commitToggle = e.target.closest('[data-commit-toggle]');
    if (commitToggle) {
      const hash = commitToggle.getAttribute('data-commit-toggle');
      state.commitsExpanded[hash] = !state.commitsExpanded[hash];
      persist();
      renderBranch();
      e.stopPropagation();
      return;
    }

    const header = e.target.closest('.section-header');
    if (header) {
      const section = header.parentElement && header.parentElement.getAttribute('data-section');
      if (!section) return;
      state.sectionsCollapsed[section] = !state.sectionsCollapsed[section];
      persist();
      renderBranch();
      vscode.postMessage({ type: 'section:toggle', section: section, open: !state.sectionsCollapsed[section] });
      return;
    }

    // Inline buttons on tree nodes (edit, remove, discard).
    const inline = e.target.closest('[data-inline]');
    if (inline) {
      const action = inline.getAttribute('data-inline');
      const id = inline.getAttribute('data-id');
      const row = inline.closest('.tree-node');
      const ctx = row ? row.getAttribute('data-context') : '';
      if (action === 'edit') {
        const cmd = ctx === 'note' ? 'jollimemory.editNote' : 'jollimemory.editPlan';
        vscode.postMessage({ type: 'command', command: cmd, args: [id] });
      }
      if (action === 'remove') {
        const cmd = ctx === 'note' ? 'jollimemory.removeNote' : 'jollimemory.removePlan';
        vscode.postMessage({ type: 'command', command: cmd, args: [id] });
      }
      if (action === 'discard') {
        // jollimemory.discardFileChanges expects a FileItem-shape (item.fileStatus.*),
        // not a bare id. Route through branch:discardFile so the host rebuilds
        // {fileStatus:{absolutePath,relativePath,statusCode}} — same pattern as
        // branch:openChange. data-rel-path / data-status-code live on the row
        // (set by renderChangeRow) so we read them off the closest tree-node.
        vscode.postMessage({
          type: 'branch:discardFile',
          filePath:     id,
          relativePath: row ? (row.getAttribute('data-rel-path')    || '') : '',
          statusCode:   row ? (row.getAttribute('data-status-code') || '') : '',
        });
      }
      if (action === 'viewSummary') {
        vscode.postMessage({ type: 'command', command: 'jollimemory.viewSummary', args: [id] });
      }
      e.stopPropagation();
      return;
    }

    // Plain row click — for plans, dispatch openPlan; for files, dispatch openChange; for commits, dispatch openCommit.
    // Skip row-dispatch when the click landed on a checkbox: the checkbox
    // toggle has its own change-event listener and we don't also want to
    // open a diff editor / commit summary as a side effect of selecting.
    if (e.target.closest('[data-checkbox="1"]')) {
      return;
    }
    const row = e.target.closest('.tree-node[data-context]');
    if (row) {
      const ctx = row.getAttribute('data-context');
      const id = row.getAttribute('data-id');
      // Plan vs note dispatch: each TreeItem command differs in the
      // extension (editPlan / editNote), and routing them through the
      // wrong command treats the id as the wrong kind of identifier
      // (note id ≠ plan slug → editPlan would 404 on noteId.md).
      if (ctx === 'plan' || ctx === 'plansItem') {
        vscode.postMessage({ type: 'branch:openPlan', planId: id });
      }
      if (ctx === 'note') {
        vscode.postMessage({ type: 'branch:openNote', noteId: id });
      }
      if (ctx === 'file' || ctx === 'fileChange') {
        // Forward all three fields the openFileChange command needs.
        // FilesTreeProvider serialises absolutePath into idHint, so id
        // already carries the absolute path; relativePath + statusCode
        // ride along via data-* attributes set in renderChangeRow.
        vscode.postMessage({
          type: 'branch:openChange',
          filePath:     id,
          relativePath: row.getAttribute('data-rel-path')    || '',
          statusCode:   row.getAttribute('data-status-code') || '',
        });
      }
      if (ctx === 'commit' || ctx === 'commitWithMemory') {
        vscode.postMessage({ type: 'branch:openCommit', hash: id });
      }
      if (ctx === 'commitFile') {
        const oldPath = row.getAttribute('data-old-path');
        const payload = {
          commitHash:   row.getAttribute('data-commit-hash') || '',
          relativePath: row.getAttribute('data-rel-path')    || '',
          statusCode:   row.getAttribute('data-status-code') || '',
          // Drop oldPath when empty — the command handler treats it as
          // optional and a "" value would confuse rename diffing.
          oldPath: oldPath ? oldPath : undefined,
        };
        vscode.postMessage({
          type: 'command',
          command: 'jollimemory.openCommitFileChange',
          args: [payload],
        });
      }
    }
  });

  // Checkbox toggle — routed by data-checkbox-kind:
  //   'commit' → branch:toggleCommitSelection (commits squash flow)
  //   anything else (default 'file') → branch:toggleFileSelection (changes
  //   discard / commit flow). The default-to-file fallback preserves the
  //   original behaviour for renderChangeRow which doesn't set the kind.
  tabContents.branch.addEventListener('change', function(e) {
    const cb = e.target.closest('[data-checkbox="1"]');
    if (!cb) return;
    e.stopPropagation();
    const kind = cb.getAttribute('data-checkbox-kind') || 'file';
    if (kind === 'commit') {
      vscode.postMessage({
        type: 'branch:toggleCommitSelection',
        hash: cb.getAttribute('data-id'),
        selected: !!cb.checked,
      });
    } else {
      // Path-semantic: FilesStore.selectedPaths is keyed by RELATIVE path
      // (see FilesStore.refresh prune logic + mergeWithSelection lookup).
      // The cb's data-id carries the ABSOLUTE path because that's what the
      // diff opener needs — reading it here would silently fail to match
      // selectedPaths and the toggle would round-trip back as isSelected:false,
      // surfacing as "checkbox unchecks itself after a brief flicker".
      // Read data-rel-path off the parent row instead.
      const row = cb.closest('.tree-node');
      const filePath = row ? row.getAttribute('data-rel-path') : cb.getAttribute('data-id');
      vscode.postMessage({
        type: 'branch:toggleFileSelection',
        filePath: filePath,
        selected: !!cb.checked,
      });
    }
  });

  // Hover card for commit rows. Mirrors the KB tab's mouseover/mouseout
  // wiring (1s show delay, 200ms hide grace) — see scheduleShowHoverCard /
  // scheduleHideHoverCard. Only commit / commitWithMemory rows get a card;
  // other branch-tab rows (plans, notes, file changes) bail out early so
  // the popover doesn't anchor onto them.
  function isCommitRow(node) {
    if (!node) return false;
    const ctx = node.getAttribute('data-context');
    return ctx === 'commit' || ctx === 'commitWithMemory';
  }
  tabContents.branch.addEventListener('mouseover', function(e) {
    const row = e.target.closest('.tree-node[data-context]');
    if (!isCommitRow(row)) return;
    scheduleShowHoverCard(row.getAttribute('data-id'), e.clientX, e.clientY);
  });
  tabContents.branch.addEventListener('mouseout', function(e) {
    const row = e.target.closest('.tree-node[data-context]');
    if (!isCommitRow(row)) return;
    const to = e.relatedTarget;
    if (to && (to === hoverCardEl || hoverCardEl.contains(to) || row.contains(to))) return;
    cancelHoverShow();
    scheduleHideHoverCard();
  });

  // Right-click context menu for the branch panel (Plans & Notes / Changes /
  // Commits sections).
  //
  // We always preventDefault on this panel — the embedded-Chromium native
  // menu (Cut/Copy/Paste/Reload) is never useful in our UI, so we suppress
  // it everywhere and only show a custom menu when a recognised row is hit.
  // Empty area / unhandled rows (e.g. commitFile children) get nothing.
  //
  //   - Plans & Notes rows ('plan' / 'plansItem' / 'note'):
  //       single 'Edit Plan' or 'Edit Note' item — mirrors the inline ✎
  //       button which dispatches editPlan / editNote based on contextValue.
  //   - Changes rows ('file' / 'fileChange'):
  //       single 'Discard Changes' item — routed through the same
  //       'branch:discardFile' message the inline discard button uses, so
  //       the host can rebuild the FileItem shape (filePath / relativePath /
  //       statusCode) that jollimemory.discardFileChanges expects.
  //   - Commit rows ('commit' / 'commitWithMemory'):
  //       'Copy Commit Hash' always; 'View Memory' only when the commit has
  //       a summary — gated like the MarkdownString tooltip's hasSummary.
  tabContents.branch.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    dismissHoverCard();
    const row = e.target.closest('.tree-node[data-context]');
    if (!row) return;
    const ctx = row.getAttribute('data-context');
    const id = row.getAttribute('data-id');
    if (ctx === 'commit' || ctx === 'commitWithMemory') {
      const items = [];
      if (ctx === 'commitWithMemory') {
        items.push({ label: 'View Memory',      command: 'jollimemory.viewSummary',    args: [id] });
        items.push({ separator: true });
      }
      items.push({ label: 'Copy Commit Hash', command: 'jollimemory.copyCommitHash', args: [id] });
      showContextMenu(e.clientX, e.clientY, items);
      return;
    }
    if (ctx === 'plan' || ctx === 'plansItem' || ctx === 'note') {
      const cmd   = ctx === 'note' ? 'jollimemory.editNote' : 'jollimemory.editPlan';
      const label = ctx === 'note' ? 'Edit Note' : 'Edit Plan';
      showContextMenu(e.clientX, e.clientY, [
        { label: label, command: cmd, args: [id] },
      ]);
      return;
    }
    if (ctx === 'file' || ctx === 'fileChange') {
      showContextMenu(e.clientX, e.clientY, [
        {
          label: 'Discard Changes',
          rawMessage: {
            type: 'branch:discardFile',
            filePath:     id,
            relativePath: row.getAttribute('data-rel-path')    || '',
            statusCode:   row.getAttribute('data-status-code') || '',
          },
        },
      ]);
      return;
    }
  });

  // ---- Boot ----
  switchTab(state.activeTab);
  vscode.postMessage({ type: 'ready' });
  `;
}
