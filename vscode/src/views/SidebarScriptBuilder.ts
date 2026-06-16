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
import { SOURCE_TITLES } from "./SourceLabels.js";

export function buildSidebarScript(): string {
	return `
  ${buildContextMenuGuardScript()}

  const vscode = acquireVsCodeApi();

  // Source display labels (Linear / Jira / GitHub / Notion) — injected from host
  // so webview JS doesn't hardcode the source list. Keep in lockstep with
  // ./SourceLabels.ts SOURCE_TITLES.
  const SOURCE_TITLES = ${JSON.stringify(SOURCE_TITLES)};

  // Empty-state strings — populated from a JSON <script> tag injected by HtmlBuilder
  // (Task 35 will fully wire this; for now we read it tolerantly with fallbacks).
  const STRINGS = (function() {
    try {
      const node = document.getElementById('empty-strings');
      return node ? JSON.parse(node.textContent || '{}') : {};
    } catch (_) { return {}; }
  })();

  // ---- DOM helper (used by every renderer). ----
  // Allowed attrs: className, tabIndex, text, title, plus anything that goes
  // through setAttribute. The 'hidden' HTML property and inline 'style' attr
  // are deliberately NOT supported — sidebar CSP forbids inline styles, and
  // visibility flips must go through the .hidden CSS class so 'display: flex'
  // overrides don't silently outrank the HTML hidden attribute (see CLAUDE.md
  // memories on webview .hidden class + inline style/JS prohibition).
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'className') n.className = String(v);
        else if (k === 'tabIndex') n[k] = v;
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
    // 'enabled' / 'configured' default to truthy so the HTML default state
    // (onboarding panel hidden, tab UI visible) does not flicker before the
    // host's init message arrives. The init handler reconciles both fields
    // against the real values from the host.
    enabled: true,
    configured: true,
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
    workerBusy: false,
    // Live phase of the running worker (currently only 'ingest'), pushed on the
    // worker:phase channel. Selects "Updating Memory Bank..." over the default
    // summary label. Not persisted -- host re-pushes on reload.
    workerPhase: null,
    // Live sync-phase indicator pushed by the host as the sync engine
    // advances through phases (downloading / merging / uploading) or ends
    // in a sticky terminal failure. Shape: { label, severity } | null. Not
    // persisted — host re-pushes on reload.
    syncPhase: null
  }, vscode.getState() || {});
  // workerBusy is intentionally reset on load (above), even if persisted state
  // had it set — the lock is process-bound and cannot survive a reload.
  state.workerBusy = false;
  state.workerPhase = null;
  state.syncPhase = null;
  function persist() { vscode.setState(state); }

  // ---- DOM refs ----
  const root = document.getElementById('sidebar-root');
  const tabBar = document.getElementById('tab-bar');
  const tabToolbar = document.getElementById('tab-toolbar');
  const disabledBanner = document.getElementById('disabled-banner');
  const enableBtn = document.getElementById('enable-btn');
  const ctxMenu = document.getElementById('context-menu');
  const kbIconBtn = document.getElementById('kb-icon-btn');
  const statusIconBtn = document.getElementById('status-icon-btn');
  const settingsIconBtn = document.getElementById('settings-icon-btn');
  const breadcrumbRepoBtn = document.getElementById('breadcrumb-repo-btn');
  const breadcrumbBranchBtn = document.getElementById('breadcrumb-branch-btn');
  const breadcrumbRepoLabel = document.getElementById('breadcrumb-repo-label');
  const breadcrumbBranchLabel = document.getElementById('breadcrumb-branch-label');
  const breadcrumbMenu = document.getElementById('breadcrumb-menu');
  // Repo/branch enumeration for the dropdowns. Populated by selection:repos /
  // selection:branches inbound messages. Until the host pushes either, the
  // chevron stays hidden and the segment behaves as a static label.
  let repoChoices = [];
  let branchChoicesByRepo = {};
  // Cache of unfiltered per-branch memories for the foreign-readonly Branch
  // tab. Keyed by '<repoName>::<branchName>'. Host populates lazily in
  // response to selection:requestBranchMemories. Cache-miss while a fetch is
  // in flight = empty array → empty state in the Memories section, which
  // immediately fills once selection:branchMemories arrives.
  const branchMemoriesCache = {};
  const branchMemoriesPending = {};
  function branchMemoriesKey(repoName, branchName) {
    return (repoName || '') + '::' + (branchName || '');
  }
  // Onboarding panel — full-viewport replacement for the tab UI when the
  // user has not configured AI yet (no Jolli sign-in and no Anthropic key).
  const onboardingPanel = document.getElementById('onboarding-panel');
  const onboardingSigninBtn = document.getElementById('onboarding-signin-btn');
  const onboardingApikeyBtn = document.getElementById('onboarding-apikey-btn');
  // Disabled panel — full-viewport "Enable" CTA shown when the user is
  // configured but has explicitly disabled the extension. Sibling of the
  // onboarding panel; mutually exclusive with it.
  const disabledPanel = document.getElementById('disabled-panel');
  const disabledEnableBtn = document.getElementById('disabled-enable-btn');
  // API key entry panel — replaces the onboarding cards when the user
  // clicks "Configure API Key". Also a sibling of onboarding-panel: only
  // one of {onboarding, apikey, disabled} is visible at any time when
  // configured===false. Successful save flips configured to true via
  // statusStore, after which applyConfigured(true) hides this panel.
  const apikeyPanel = document.getElementById('apikey-panel');
  const apikeyInput = document.getElementById('apikey-input');
  const apikeyError = document.getElementById('apikey-error');
  const apikeySaveBtn = document.getElementById('apikey-save-btn');
  const apikeyBackBtn = document.getElementById('apikey-back-btn');
  // Loading panel — visible on first paint (no .hidden in HTML), then
  // hidden as soon as the host's init message arrives. Bridges the gap
  // between webview-load and the first real configured/enabled values
  // so reload doesn't briefly show the onboarding panel as a side effect
  // of host's currentConfigured starting at false.
  const loadingPanel = document.getElementById('loading-panel');
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
    // VSCode modal dialogs (showWarningMessage with { modal: true }, command
    // palettes, etc.) overlay the webview at the native layer without
    // dispatching mouseleave — from the DOM's view, the cursor never moved.
    // A tooltip that was already visible when the user clicked therefore
    // outlives the click and stays pinned until the user wiggles the mouse
    // back over and off the button. mousedown fires before the modal opens
    // so dismissing here closes the gap.
    el.addEventListener('mousedown', function() {
      hideTextTip();
    });
    return el;
  }

  // Header-bar icons live in the static HTML skeleton (not the toolbar), so
  // attach their tooltips once here. renderStatus updates dataset.tip on
  // statusIconBtn in lockstep with the indicator color so the hover text
  // always matches the dot; KB and Settings have static tooltips.
  if (statusIconBtn) attachTextTip(statusIconBtn, 'Jolli Memory: All good');
  if (kbIconBtn) attachTextTip(kbIconBtn, 'Memory Bank');
  if (settingsIconBtn) attachTextTip(settingsIconBtn, 'Settings');

  // ---- Tab switching ----
  // The new icon-driven header doesn't have a Branch button — the Branch view
  // is the default that surfaces whenever no overlay (KB / Status) is active.
  // Clicking the active KB or Status icon a second time collapses back to
  // Branch; that toggle behavior is implemented at the click-handler level
  // (icon clicks pass the icon's data-tab through a switchTabFromIcon shim).
  function switchTab(tab) {
    if (state.activeTab === tab) return;
    const outgoing = tabContents[state.activeTab];
    if (outgoing) state.scrollTops[state.activeTab] = outgoing.scrollTop;

    state.activeTab = tab;
    persist();
    // Only tab-icon buttons (KB / Status) carry .active — Branch is the
    // implicit default so no button is highlighted in Branch mode.
    document.querySelectorAll('.tab[data-tab]').forEach(function(elBtn) {
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

  // Icon buttons own the click-to-toggle behavior: clicking the icon that
  // matches the active tab collapses back to Branch instead of being a no-op.
  // Only [data-tab] elements participate; [data-action] icons (Settings)
  // route through the open-settings handler below.
  document.querySelectorAll('.tab[data-tab]').forEach(function(elBtn) {
    elBtn.addEventListener('click', function() {
      const target = elBtn.getAttribute('data-tab');
      if (state.activeTab === target) switchTab('branch');
      else switchTab(target);
    });
  });

  // Settings icon lives in tab-bar-right with data-action="open-settings".
  // Routes to the openSettings command rather than the tab dispatch.
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
      // Sync-phase indicator (StatusOrchestrator's per-phase label). Anchored
      // to the leftmost slot so the activity copy sits where the eye lands
      // first, ahead of the mode toggles and actions. Container collapses
      // (hidden class) when syncPhase is null, so the rest of the toolbar
      // closes up tightly in the idle case. Sync moves memories to/from the
      // Personal Space, so the indicator lives on the Memory Bank toolbar.
      items.push(buildToolbarIndicator(state.syncPhase));
      // Search input next. Folders mode has no search backend, so we only
      // render it in memories mode. While a sync round is in flight we also
      // suppress the search box in memories mode: the indicator and the
      // search input both want flex:1 1 auto, and at sidebar widths the
      // split squeezes both down to unreadable widths. The search affordance
      // returns the moment the round ends (indicator clears, renderToolbar
      // re-runs from the sync:phase handler).
      if (memoryToggled && !state.syncPhase) items.push(buildKbSearchBox());
      items.push(iconButton('kb-mode-folders', 'Tree', 'list-tree', { toggled: folderToggled }));
      items.push(iconButton('kb-mode-memories', 'Timeline', 'history', { toggled: memoryToggled }));
      // Sync to Personal Space: fires the same jollimemory.syncNow command as
      // the Settings webview Sync button. The manual sync button is
      // deliberately independent of the auto-sync toggle (plan §0.7) — we
      // always render it, and the command handler only toasts when the
      // user isn't authenticated. (NB: avoid backticks in comments; file
      // header explains why.)
      items.push(iconButton('sync-now', 'Sync to Personal Space', 'cloud-upload'));
      items.push(iconButton('compile-now', 'Build Knowledge Wiki', 'database'));
      items.push(iconButton('refresh', 'Refresh', 'refresh'));
      mountIn(tabToolbar, items);
    } else if (state.activeTab === 'status') {
      // Order: account → power → refresh. Settings has been promoted to the
      // top-level icon row on the header bar so it's reachable from every
      // panel, not just Status.
      // - Sign In / Sign Out swaps based on state.authenticated; only one is
      //   ever visible (mutually exclusive flows, no point showing both).
      // - Disable: visible only when enabled — toolbar itself is hidden in
      //   disabled mode, and Enable is offered on the disabled-banner instead.
      // - Refresh: rightmost (matches the convention used on the other tabs).
      const items = [
        state.authenticated
          ? iconButton('sign-out', 'Sign Out', 'sign-out')
          : iconButton('sign-in', 'Sign In', 'sign-in'),
        iconButton('disable-jolli', 'Disable Jolli Memory', 'stop-circle'),
        iconButton('refresh', 'Refresh', 'refresh'),
      ];
      mountIn(tabToolbar, items);
    } else {
      // Branch tab: optional left-side AI-summary worker indicator + refresh.
      // The container is always mounted so the right-edge refresh button
      // stays in a stable position. Sync-phase lives on the Memory Bank tab
      // toolbar — it's about moving memories to/from the Personal Space, not
      // about the working-tree branch.
      const items = [];
      const indicator = state.workerBusy
        ? (state.workerPhase === 'ingest'
            ? { label: 'Updating Memory Bank…', severity: 'info' }
            : { label: 'AI summary in progress…', severity: 'info' })
        : null;
      items.push(buildToolbarIndicator(indicator));
      items.push(iconButton('refresh', 'Refresh', 'refresh'));
      mountIn(tabToolbar, items);
    }
  }

  // Shared chrome for the toolbar's left-side status indicator. Used by both
  // the Memory Bank tab (sync-phase) and the Branch tab (AI-summary worker).
  // Always returns a mounted container so the right-edge refresh button keeps
  // a stable position; the hidden class collapses it when indicator is null.
  function buildToolbarIndicator(indicator) {
    const busyEl = el('div', {
      className: 'toolbar-worker-status' + (indicator ? '' : ' hidden'),
      id: 'toolbar-worker-status'
    });
    if (indicator) {
      const isError = indicator.severity === 'error';
      busyEl.appendChild(el('i', {
        className: isError
          ? 'codicon codicon-error toolbar-worker-icon-error'
          : 'codicon codicon-loading codicon-modifier-spin',
        'aria-hidden': 'true'
      }));
      busyEl.appendChild(el('span', {
        className: 'toolbar-worker-status-text',
        text: indicator.label
      }));
    }
    return busyEl;
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
    } else if (action === 'sync-now') {
      vscode.postMessage({ type: 'command', command: 'jollimemory.syncNow' });
    } else if (action === 'compile-now') {
      vscode.postMessage({ type: 'command', command: 'jollimemory.compileNow' });
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

  // Onboarding panel buttons. Configure API Key swaps the cards view for the
  // inline apikey-panel (single input + Save) so the user doesn't have to
  // open the full Settings webview just to set one value. Sign In / Sign Up
  // runs the OAuth-based jollimemory.signIn command.
  onboardingApikeyBtn.addEventListener('click', function() {
    showApikeyPanel();
  });
  onboardingSigninBtn.addEventListener('click', function() {
    vscode.postMessage({ type: 'command', command: 'jollimemory.signIn' });
  });

  // ---- API key entry panel ----
  // showApikeyPanel / showOnboardingPanel toggle exclusively between the two
  // configured===false views. Only one of {onboarding-panel, apikey-panel}
  // is visible at a time. Both are hidden simultaneously by applyConfigured(true)
  // when the user finishes configuring (typed key saved or signed in).
  function showApikeyPanel() {
    onboardingPanel.classList.add('hidden');
    apikeyPanel.classList.remove('hidden');
    apikeyError.classList.add('hidden');
    apikeyError.textContent = '';
    apikeyInput.value = '';
    apikeySaveBtn.disabled = true;
    apikeySaveBtn.textContent = 'Save';
    setTimeout(function() { apikeyInput.focus(); }, 0);
  }
  function showOnboardingPanel() {
    apikeyPanel.classList.add('hidden');
    onboardingPanel.classList.remove('hidden');
  }
  apikeyBackBtn.addEventListener('click', showOnboardingPanel);
  apikeyInput.addEventListener('input', function() {
    apikeySaveBtn.disabled = apikeyInput.value.trim().length === 0;
    // Typing dismisses any prior error so the user isn't staring at a stale
    // message while editing.
    if (!apikeyError.classList.contains('hidden')) {
      apikeyError.classList.add('hidden');
      apikeyError.textContent = '';
    }
  });
  apikeyInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !apikeySaveBtn.disabled) {
      e.preventDefault();
      submitApikey();
    }
  });
  apikeySaveBtn.addEventListener('click', submitApikey);
  function submitApikey() {
    const key = apikeyInput.value.trim();
    if (key.length === 0) return;
    apikeySaveBtn.disabled = true;
    apikeySaveBtn.textContent = 'Saving…';
    apikeyError.classList.add('hidden');
    apikeyError.textContent = '';
    // Successful save flips configured via statusStore.onChange → the panel
    // is hidden by applyConfigured(true). Failure comes back as an
    // 'apikey:saveError' message handled below; we re-enable the Save button
    // and surface the error inline.
    vscode.postMessage({
      type: 'command',
      command: 'jollimemory.saveAnthropicApiKey',
      args: [key],
    });
  }

  // Disabled-panel Enable button — same command as the legacy in-Status
  // disabled-banner Enable button (jollimemory.enableJolliMemory). Wired
  // separately because the two buttons live in disjoint DOM regions and
  // only one is visible at a time (disabled-panel for user-opt-out,
  // disabled-banner for the degraded fallback).
  disabledEnableBtn.addEventListener('click', function() {
    vscode.postMessage({ type: 'command', command: 'jollimemory.enableJolliMemory' });
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
    // Tear down the first-paint loading placeholder on the FIRST host message,
    // not just on init. Used to gate this on init exclusively, but the hosts
    // statusStore.refresh during initialLoad fires onChange synchronously and
    // posts configured:changed / enabled:changed BEFORE the gated init —
    // those handlers call applyConfigured/applyEnabled which un-hide the
    // onboarding-panel or disabled-panel while loading-panel is still up,
    // leaving both stacked in the flex column. Hiding here covers every
    // state-bearing entry path uniformly. Idempotent on already-hidden.
    loadingPanel.classList.add('hidden');
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
        // Onboarding gate sits on top of enabled — when configured===false it
        // hides the tab UI applyEnabled just configured. configured defaults to
        // true on undefined (e.g. older host code, transient init message)
        // so the regular UI keeps working without a strict-host upgrade.
        applyConfigured(msg.state.configured !== false);
        if (msg.state.activeTab) switchTab(msg.state.activeTab);
        if (msg.state.kbMode) state.kbMode = msg.state.kbMode;
        state.branchName = msg.state.branchName;
        state.detached = !!msg.state.detached;
        state.currentRepoName = msg.state.currentRepoName;
        state.selectedRepoName = msg.state.selectedRepoName;
        state.selectedBranchName = msg.state.selectedBranchName;
        renderBreadcrumb();
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
      case 'configured:changed': {
        // Capture the prior value BEFORE applyConfigured mutates state.configured —
        // we use the false→true edge to detect "user just finished onboarding"
        // (either sign-in OAuth callback or API key save). Same-value pushes
        // (host re-broadcasts during background refresh, init race) leave
        // wasConfigured===true so the auto-switch below is skipped.
        const wasConfigured = state.configured;
        applyConfigured(!!msg.configured);
        // After flipping configured back to true we're back on the regular
        // UI surface; refresh the toolbar so the active-tab buttons reflect
        // the current state (e.g. Sign In/Out icon, worker-busy label).
        if (msg.configured) {
          // Land the user on the Status tab the first time they finish
          // onboarding so they see the live state of what they just
          // configured (auth status, settings entry, worker indicator)
          // instead of the default Branch tab. Both sign-in and API key
          // paths converge on this same configured=false→true transition.
          if (!wasConfigured) switchTab('status');
          renderToolbar();
        }
        break;
      }
      case 'apikey:saveError':
        // Only re-enable Save + show the error if the apikey-panel is still
        // the active surface. If the panel has been retired (success path
        // raced past us), stay quiet — applyConfigured already hid us.
        if (!apikeyPanel.classList.contains('hidden')) {
          apikeySaveBtn.disabled = apikeyInput.value.trim().length === 0;
          apikeySaveBtn.textContent = 'Save';
          apikeyError.textContent = typeof msg.message === 'string' && msg.message.length > 0
            ? msg.message
            : 'Failed to save the API key.';
          apikeyError.classList.remove('hidden');
        }
        break;
      case 'worker:busy': {
        const next = !!msg.busy;
        if (state.workerBusy === next) break;
        state.workerBusy = next;
        // Only the Branch tab reacts to workerBusy: the toolbar shows the
        // "AI summary in progress…" indicator (renderToolbar) and the
        // Changes section's Commit-AI icon must flip its disabled state
        // (renderSectionActions reads state.workerBusy → renderBranch
        // re-mounts the section action span). Other tabs ignore the flag
        // so we don't wipe their toolbars.
        if (state.activeTab === 'branch') {
          renderToolbar();
          renderBranch();
        }
        break;
      }
      case 'worker:phase': {
        // Per-phase label for the post-commit Worker. Independent of
        // worker:busy; only 'ingest' is surfaced today, anything else clears to
        // the default summary label. Only the Branch tab reacts. renderBranch
        // runs too because the commit buttons' disabled state depends on the
        // phase (ingest is exempt from blocking — see isWorkerBlocking), not
        // just on worker:busy.
        const nextPhase = (msg.phase === 'ingest') ? 'ingest' : null;
        if (state.workerPhase === nextPhase) break;
        state.workerPhase = nextPhase;
        if (state.activeTab === 'branch') {
          renderToolbar();
          renderBranch();
        }
        break;
      }
      case 'sync:phase': {
        // Per-phase sync indicator from StatusOrchestrator. Independent of
        // worker:busy (the post-commit Worker channel). Only the Memory Bank
        // tab toolbar consumes it — sync moves memories to/from the Personal
        // Space, so the indicator sits next to the Sync-now action it
        // describes; other tabs ignore the field.
        state.syncPhase = msg.phase || null;
        if (state.activeTab === 'kb') {
          renderToolbar();
        }
        break;
      }
      case 'branch:branchName':
        state.branchName = msg.name;
        state.detached = !!msg.detached;
        renderBreadcrumb();
        // Workspace branch changed — if the user was viewing the workspace
        // branch (no override), the breadcrumb label has just updated and
        // foreign-readonly chrome may need to lift. If the user was viewing
        // a foreign branch the predicate is unaffected.
        if (state.activeTab === 'branch') renderBranch();
        break;
      case 'selection:repos':
        repoChoices = Array.isArray(msg.repos) ? msg.repos.slice() : [];
        renderBreadcrumb();
        break;
      case 'selection:branches':
        if (msg.repoName) {
          branchChoicesByRepo[msg.repoName] = Array.isArray(msg.branches) ? msg.branches.slice() : [];
          renderBreadcrumb();
        }
        break;
      case 'selection:set':
        state.selectedRepoName = msg.repoName;
        state.selectedBranchName = msg.branchName;
        renderBreadcrumb();
        // Picking a repo/branch from the breadcrumb returns focus to the
        // Branch tab — the Memory Bank and Status overlays are global
        // workspace-oriented surfaces, so leaving them open while the
        // breadcrumb has shifted to a different context is disorienting.
        // switchTab handles the panel swap + Branch re-render itself; the
        // else branch covers the already-on-Branch case where we still
        // need to re-render to pick up the new selection.
        if (state.activeTab !== 'branch') {
          switchTab('branch');
        } else {
          renderBranch();
        }
        // Branch tab foreign view needs per-branch memories from the host
        // (workspace-bound branchData.commits can't represent a foreign pick).
        // Request lazily when the selection materializes; the response fills
        // branchMemoriesCache and a renderBranch() inside that handler paints
        // the rows. Skip if already cached or a fetch is pending — host pushes
        // are sticky for the life of the session.
        //
        // Repo/branch fall back to the workspace's own — picking only a branch
        // (without first picking a repo) leaves state.selectedRepoName
        // undefined but should still trigger a fetch for currentRepoName +
        // pickedBranch. The render path, isViewingForeign, and the response
        // handler all use the same selectedX-||-currentX fallback; the
        // trigger key MUST match or the request never fires and the Memories
        // section stays empty until the user re-picks the repo.
        {
          const repo = state.selectedRepoName || state.currentRepoName;
          const branch = state.selectedBranchName || state.branchName;
          if (isViewingForeign() && repo && branch) {
            const key = branchMemoriesKey(repo, branch);
            if (!branchMemoriesCache[key] && !branchMemoriesPending[key]) {
              branchMemoriesPending[key] = true;
              vscode.postMessage({
                type: 'selection:requestBranchMemories',
                repoName: repo,
                branchName: branch,
              });
            }
          }
        }
        break;
      case 'selection:branchMemories':
        // Cache by repoName::branchName. The response echoes both keys so we
        // can match even if state.selected* has moved on (user picked again
        // mid-fetch). If the result still matches the active selection AND
        // we're on the Branch tab in foreign mode, re-render so the section
        // populates.
        {
          const k = branchMemoriesKey(msg.repoName, msg.branchName);
          branchMemoriesCache[k] = msg.items.slice();
          delete branchMemoriesPending[k];
          const activeKey = branchMemoriesKey(
            state.selectedRepoName || state.currentRepoName,
            state.selectedBranchName || state.branchName,
          );
          if (k === activeKey && state.activeTab === 'branch' && isViewingForeign()) {
            renderBranch();
          }
        }
        break;
      case 'selection:invalidateBranchMemories':
        // Toolbar Refresh while viewing a foreign repo+branch: the cache is
        // session-sticky (populated once per key on selection:set, never
        // re-fetched) so without this signal Refresh would not change what
        // the user sees. Drop every cached key, then re-trigger the lazy
        // fetch for the currently-active foreign selection. Other keys
        // refetch on demand the next time the user navigates to them.
        {
          for (const k in branchMemoriesCache) delete branchMemoriesCache[k];
          for (const k in branchMemoriesPending) delete branchMemoriesPending[k];
          const repo = state.selectedRepoName || state.currentRepoName;
          const branch = state.selectedBranchName || state.branchName;
          if (isViewingForeign() && repo && branch) {
            const key = branchMemoriesKey(repo, branch);
            branchMemoriesPending[key] = true;
            vscode.postMessage({
              type: 'selection:requestBranchMemories',
              repoName: repo,
              branchName: branch,
            });
            // Repaint while the request is in flight so the section drops
            // its old rows for an empty "Loading"-equivalent state until
            // selection:branchMemories arrives.
            if (state.activeTab === 'branch') renderBranch();
          }
        }
        break;
      case 'status:data':
        renderStatus(msg.entries);
        break;
      case 'kb:foldersData':
        mergeFolders(msg.tree);
        break;
      case 'kb:markDiverged':
        setFileDivergedFlag(msg.path, true);
        break;
      case 'kb:clearDiverged':
        setFileDivergedFlag(msg.path, false);
        break;
      case 'kb:foldersReset':
        // Drop every cached level — paths deeper than the root may have been
        // renamed/removed by the host operation that triggered this reset
        // (e.g. Migrate to Memory Bank creates a -N-suffixed folder and the
        // old paths under the prior repo folder no longer apply).
        for (const k in folderCache) delete folderCache[k];
        folderCache[''] = null;
        // Migrate may swap which repo is "current" (post-migration the new
        // -N-suffixed folder takes that role). Re-arm the one-shot so the
        // next kb:foldersData re-expands the right repo.
        currentRepoAutoExpanded = false;
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
      case 'branch:conversationsData':
        branchData.conversations = msg.items.slice();
        branchData.conversationsFailedSources = Array.isArray(msg.failedSources) ? msg.failedSources.slice() : [];
        if (state.activeTab === 'branch') renderBranch();
        break;
      // Renderers added in later phases handle the remaining message types.
      default:
        break;
    }
  }

  function applyEnabled(enabled) {
    state.enabled = !!enabled;
    // While the onboarding panel is showing, keep all main-UI elements hidden
    // regardless of the enabled flag — the onboarding flow takes the entire
    // viewport. applyConfigured(true) re-invokes applyEnabled on its own when
    // the user finishes configuring, so this branch never traps the UI.
    if (state.configured === false) {
      disabledPanel.classList.add('hidden');
      disabledBanner.classList.add('hidden');
      statusEntries.classList.add('hidden');
      return;
    }
    statusEntries.classList.toggle('hidden', !enabled);
    // The legacy disabled-banner inside the Status panel is reserved for the
    // degraded (no-workspace / no-git) fallback. The standard user-disabled
    // path uses the new disabled-panel above, so keep the banner hidden here
    // and let applyDegraded re-show it when needed.
    disabledBanner.classList.add('hidden');
    // Disabled-panel mirrors enabled: hidden when enabled, visible when not.
    disabledPanel.classList.toggle('hidden', !!enabled);
    // Tab bar — hidden entirely in the disabled state because the
    // disabled-panel takes the full viewport (no Status tab to land on).
    tabBar.classList.toggle('hidden', !enabled);
    tabToolbar.classList.toggle('hidden', !enabled);
    // Invalidate the status-entries cache: visibility flipped, so the next
    // status:data push must repaint regardless of whether the JSON changed.
    lastStatusEntriesJson = null;

    if (enabled) {
      // Sync .active class on the icon buttons against the persisted active
      // tab. Branch has no button so it never gets .active — the absence of
      // .active on KB/Status icons is the visual signal that Branch is current.
      document.querySelectorAll('.tab[data-tab]').forEach(function(elBtn) {
        elBtn.classList.toggle('active', elBtn.getAttribute('data-tab') === state.activeTab);
      });
      // Normal mode: only the active tab's content is visible.
      Object.keys(tabContents).forEach(function(t) {
        tabContents[t].classList.toggle('hidden', t !== state.activeTab);
      });
    } else {
      // Disabled mode: the disabled-panel is the entire UI. Hide every
      // tab-content so the panel sits cleanly in the viewport, and clear the
      // .active class on tab buttons so re-enable starts from a clean slate.
      tabContents.kb.classList.add('hidden');
      tabContents.branch.classList.add('hidden');
      tabContents.status.classList.add('hidden');
      document.querySelectorAll('.tab[data-tab]').forEach(function(elBtn) {
        elBtn.classList.remove('active');
      });
    }
  }

  // Toggles between the onboarding flow and the regular tab UI based on
  // whether the user has supplied any AI credentials (Jolli sign-in OR
  // Anthropic key). When configured=false the onboarding panel takes the
  // entire sidebar viewport and every other element is hidden. When
  // configured=true we restore the regular UI by re-running applyEnabled
  // against the last-known enabled flag (host always pushes enabled:changed
  // before we'd flip configured back, but defending against ordering keeps
  // this idempotent).
  function applyConfigured(configured) {
    state.configured = !!configured;
    if (!configured) {
      // Land on the cards view when configured flips back to false (e.g.
      // user signed out). The apikey-panel is a sub-view of onboarding,
      // not a stable state on its own, so we always reset back to cards.
      onboardingPanel.classList.remove('hidden');
      apikeyPanel.classList.add('hidden');
      disabledPanel.classList.add('hidden');
      tabBar.classList.add('hidden');
      tabToolbar.classList.add('hidden');
      tabContents.kb.classList.add('hidden');
      tabContents.branch.classList.add('hidden');
      tabContents.status.classList.add('hidden');
      disabledBanner.classList.add('hidden');
      return;
    }
    onboardingPanel.classList.add('hidden');
    // Hide apikey-panel here too — when the user successfully saves a key,
    // statusStore re-derives configured=true and we land here. This is the
    // single hand-off that retires the apikey input view.
    apikeyPanel.classList.add('hidden');
    // applyEnabled() now manages the .hidden flag on tabBar itself (it hides
    // the bar in disabled mode because disabled-panel owns the viewport),
    // so just delegate — no manual tabBar.classList.remove('hidden') needed.
    applyEnabled(state.enabled);
  }

  // Degraded mode (no workspace / no git) keeps the legacy disabled-banner
  // path: it has reason-specific copy and a non-Enable primary command
  // (Open Folder / Initialize Git) that the new disabled-panel doesn't
  // model. We start from applyEnabled(false) — which hides everything
  // including the disabled-panel — then explicitly swap in the Status tab
  // + banner so the reason-specific CTA is the only visible element.
  function applyDegraded(reason) {
    applyEnabled(false);
    disabledPanel.classList.add('hidden');
    tabContents.status.classList.remove('hidden');
    disabledBanner.classList.remove('hidden');
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

  function renderBreadcrumbBranchLabel(name, detached) {
    // Only update the label text — leave the leading icon and chevron alone.
    if (!name) {
      breadcrumbBranchLabel.textContent = '(no branch)';
      breadcrumbBranchBtn.title = '';
      return;
    }
    if (detached) {
      const short = name.length > 7 ? name.slice(0, 7) : name;
      breadcrumbBranchLabel.textContent = '(detached: ' + short + ')';
      breadcrumbBranchBtn.title = 'detached HEAD: ' + name;
      return;
    }
    breadcrumbBranchLabel.textContent = name;
    breadcrumbBranchBtn.title = name;
  }

  function renderBreadcrumbRepoLabel(name) {
    breadcrumbRepoLabel.textContent = name || '(workspace)';
    breadcrumbRepoBtn.title = name || '';
  }

  // Single source of truth for "is the user browsing somewhere other than the
  // workspace's own repo+branch?" The renderers consult this to decide
  // whether to render checkboxes, squash/push buttons, plans/changes
  // sections. The host is responsible for refilling branch:* data when the
  // selection changes; this function only flips the visual chrome.
  function isViewingForeign() {
    const repoMatch = !state.selectedRepoName || state.selectedRepoName === state.currentRepoName;
    const branchMatch = !state.selectedBranchName || state.selectedBranchName === state.branchName;
    return !(repoMatch && branchMatch);
  }

  // Branch list as the dropdown should see it. The host's listBranches reads
  // <kbRoot>/.jolli/branches.json, so a brand-new git branch the user just
  // created in the workspace — but on which no memory has been generated yet
  // — is absent from the saved mapping. That left the user with no way to
  // return to it after picking a foreign branch from the breadcrumb. Inject
  // the workspace branch (state.branchName) when it's missing from the
  // workspace repo's branch list so the breadcrumb stays round-trippable
  // even before the first commit summary lands. No injection for foreign
  // repos — they have no "workspace branch" concept.
  function getEffectiveBranchList(repoName) {
    const saved = branchChoicesByRepo[repoName] || [];
    if (repoName !== state.currentRepoName) return saved;
    const wb = state.branchName;
    if (!wb) return saved;
    if (saved.indexOf(wb) !== -1) return saved;
    return [wb].concat(saved);
  }

  function applyForeignReadonly() {
    root.classList.toggle('foreign-readonly', isViewingForeign());
  }

  function renderBreadcrumb() {
    // Repo: show selectedRepoName when set, else currentRepoName. The chevron
    // is only meaningful when there is a real choice (>= 2 repos).
    const repoDisplay = state.selectedRepoName || state.currentRepoName || '';
    renderBreadcrumbRepoLabel(repoDisplay);
    const repoChevron = breadcrumbRepoBtn.querySelector('.breadcrumb-seg-chevron');
    if (repoChevron) repoChevron.classList.toggle('hidden', repoChoices.length < 2);
    // Branch: show selectedBranchName when set, else fall back to the
    // workspace branch (branchName/detached are always the workspace's).
    const branchDisplay = state.selectedBranchName || state.branchName;
    const detached = state.selectedBranchName ? false : state.detached;
    renderBreadcrumbBranchLabel(branchDisplay, detached);
    const repoForBranches = state.selectedRepoName || state.currentRepoName || '';
    const branchList = getEffectiveBranchList(repoForBranches);
    const branchChevron = breadcrumbBranchBtn.querySelector('.breadcrumb-seg-chevron');
    if (branchChevron) branchChevron.classList.toggle('hidden', branchList.length < 2);
    applyForeignReadonly();
  }

  function hideBreadcrumbMenu() {
    breadcrumbMenu.classList.add('hidden');
    breadcrumbRepoBtn.setAttribute('aria-expanded', 'false');
    breadcrumbBranchBtn.setAttribute('aria-expanded', 'false');
  }

  function showBreadcrumbMenu(anchorBtn, items, onPick) {
    if (!items || items.length === 0) return;
    clear(breadcrumbMenu);
    // Reset inline max-height left over from a previous open so the CSS
    // default (50vh) governs again until we compute the real cap below.
    breadcrumbMenu.style.maxHeight = '';

    // Show the filter input only when scanning by eye gets tedious. 8 is
    // roughly one viewport-height of rows in a typical sidebar width.
    const SEARCH_THRESHOLD = 8;
    const showSearch = items.length >= SEARCH_THRESHOLD;

    const list = el('div', { className: 'dropdown-list', role: 'none' });
    const rows = [];
    items.forEach(function(it) {
      const isCurrent = !!it.current;
      const isWorkspace = !!it.workspace;
      // Two independent class flags: .current drives the leading check
      // icon (selected for viewing); .workspace drives bold weight (the
      // IDE's actual repo/branch). They can co-occur (initial state) or
      // be on different rows (after the user picks a foreign target).
      const row = el('div', {
        className: 'dropdown-item' + (isCurrent ? ' current' : '') + (isWorkspace ? ' workspace' : ''),
        role: 'menuitem',
        'data-value': it.value,
      }, [
        el('i', {
          className: 'codicon dropdown-item-check ' + (isCurrent ? 'codicon-check' : ''),
          'aria-hidden': 'true',
        }),
        el('span', { text: it.label }),
      ]);
      row.addEventListener('click', function() {
        hideBreadcrumbMenu();
        onPick(it.value);
      });
      list.appendChild(row);
      rows.push({ el: row, label: String(it.label || '').toLowerCase() });
    });
    const emptyMsg = el('div', { className: 'dropdown-empty hidden', text: 'No matches' });
    list.appendChild(emptyMsg);

    let searchInput = null;
    if (showSearch) {
      searchInput = el('input', {
        type: 'text',
        placeholder: 'Filter...',
        'aria-label': 'Filter list',
        autocomplete: 'off',
        spellcheck: 'false',
      });
      searchInput.addEventListener('input', function() {
        const q = String(searchInput.value || '').trim().toLowerCase();
        let visible = 0;
        for (let i = 0; i < rows.length; i++) {
          const match = q === '' || rows[i].label.indexOf(q) !== -1;
          rows[i].el.classList.toggle('hidden', !match);
          if (match) visible++;
        }
        emptyMsg.classList.toggle('hidden', visible !== 0);
      });
      // The document-level click handler closes the menu on outside clicks;
      // clicks inside the menu already short-circuit via breadcrumbMenu.contains,
      // but stopping propagation on the input itself keeps the menu open even
      // if a future change tightens that guard.
      searchInput.addEventListener('click', function(e) { e.stopPropagation(); });
      searchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
          // Let the document-level Escape handler close the menu so behaviour
          // matches clicking outside; stopping here would trap focus.
          return;
        }
      });
      const searchWrap = el('div', { className: 'dropdown-search' }, [searchInput]);
      breadcrumbMenu.appendChild(searchWrap);
    }
    breadcrumbMenu.appendChild(list);

    // Position relative to the viewport. The menu uses position:absolute
    // anchored to the document, so getBoundingClientRect is enough. CSS
    // caps the menu at 50vh; if the anchor sits close to the viewport
    // bottom we tighten that further to whatever space remains, so the
    // list scrolls inside the menu instead of overflowing off-screen.
    const r = anchorBtn.getBoundingClientRect();
    breadcrumbMenu.style.left = String(Math.round(r.left)) + 'px';
    breadcrumbMenu.style.top = String(Math.round(r.bottom + 2)) + 'px';
    const availableBelow = window.innerHeight - r.bottom - 12;
    const cap50vh = Math.round(window.innerHeight * 0.5);
    // Math.max with a floor keeps the menu usable even when the anchor is
    // pinned near the bottom edge (e.g. user shrank the sidebar height).
    const cappedMax = Math.max(120, Math.min(cap50vh, availableBelow));
    breadcrumbMenu.style.maxHeight = String(cappedMax) + 'px';
    breadcrumbMenu.classList.remove('hidden');
    anchorBtn.setAttribute('aria-expanded', 'true');
    if (searchInput) searchInput.focus();
  }

  // Pulls items flagged as 'workspace' to the front while preserving the
  // host-supplied order (alphabetical) for the remainder. There is at most
  // one workspace item per list — see renderBreadcrumbMenu callers — so this
  // is effectively "move one element to index 0" with a guard for the
  // already-first case.
  function pinWorkspaceFirst(items) {
    const idx = items.findIndex(function(it) { return !!it.workspace; });
    if (idx <= 0) return items;
    const head = items[idx];
    return [head].concat(items.slice(0, idx)).concat(items.slice(idx + 1));
  }

  breadcrumbRepoBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    if (repoChoices.length < 2) return;
    const isOpen = breadcrumbRepoBtn.getAttribute('aria-expanded') === 'true';
    hideBreadcrumbMenu();
    if (isOpen) return;
    // workspace flag marks the IDE-workspace repo and pins it to the top
    // regardless of which repo the user has selected. The 'current' flag
    // still tracks the picked-for-viewing repo (drives the check-mark) and
    // is independent — when the user views a foreign repo, the workspace
    // row is bold (.workspace) without a check and the foreign row carries
    // the check without bold.
    const items = repoChoices.map(function(rc) {
      return {
        value: rc.repoName,
        label: rc.repoName + (rc.isCurrent ? ' (current)' : ''),
        current: rc.repoName === (state.selectedRepoName || state.currentRepoName),
        workspace: !!rc.isCurrent,
      };
    });
    showBreadcrumbMenu(breadcrumbRepoBtn, pinWorkspaceFirst(items), function(picked) {
      vscode.postMessage({ type: 'selection:request', repoName: picked });
    });
  });

  breadcrumbBranchBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    const repoForBranches = state.selectedRepoName || state.currentRepoName || '';
    // Effective list ensures the workspace branch is selectable even when
    // it has no saved memories yet — without this a freshly-created branch
    // becomes a trap: the user can leave it via the dropdown but cannot
    // come back.
    const list = getEffectiveBranchList(repoForBranches);
    if (list.length < 2) return;
    const isOpen = breadcrumbBranchBtn.getAttribute('aria-expanded') === 'true';
    hideBreadcrumbMenu();
    if (isOpen) return;
    const currentBranchInRepo = state.selectedBranchName || state.branchName;
    const isWorkspaceRepo = repoForBranches === state.currentRepoName;
    const items = list.map(function(b) {
      const isWorkspaceBranch = isWorkspaceRepo && b === state.branchName;
      return {
        value: b,
        label: b + (isWorkspaceBranch ? ' (current)' : ''),
        current: b === currentBranchInRepo,
        workspace: isWorkspaceBranch,
      };
    });
    showBreadcrumbMenu(breadcrumbBranchBtn, pinWorkspaceFirst(items), function(picked) {
      vscode.postMessage({ type: 'selection:request', branchName: picked });
    });
  });

  // Dismiss the dropdown on any outside click — guarding against clicks
  // inside the menu itself, which would otherwise close before onPick runs.
  document.addEventListener('click', function(e) {
    if (breadcrumbMenu.classList.contains('hidden')) return;
    if (breadcrumbMenu.contains(e.target)) return;
    if (breadcrumbRepoBtn.contains(e.target)) return;
    if (breadcrumbBranchBtn.contains(e.target)) return;
    hideBreadcrumbMenu();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && !breadcrumbMenu.classList.contains('hidden')) {
      hideBreadcrumbMenu();
    }
  });

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
  // One-shot guard for the "auto-expand current repo" behavior. Set after we
  // (a) see the current repo already has children populated, or (b) request a
  // lazy expand for it. Reset by kb:foldersReset so a Migrate to Memory Bank
  // — which renames the current repo's folder — gets to auto-expand the new
  // current repo on the next data delivery.
  let currentRepoAutoExpanded = false;

  function renderFolders() {
    // mountIn replaces the whole subtree below: any rows currently anchoring
    // a visible tooltip will be detached without firing mouseleave, leaving
    // the tip orphaned on screen. Dismissing here mirrors renderStatus /
    // renderToolbar and keeps every section-level re-render symmetric.
    hideTextTip();
    const container = tabContents.kb;
    const root = folderCache[''];
    if (!root) {
      mountIn(container, el('div', { className: 'placeholder', text: 'Loading...' }));
      return;
    }
    // Repos are promoted to top-level (depth 0): one node per discovered repo
    // under <localFolder>. There's intentionally no "Memory Bank" / repo-name
    // banner above this list — which repo is the user's own is already shown
    // by the per-repo (current) suffix on current-repo-node. Matches the
    // IntelliJ Memory Bank tool window's flat repo listing.
    if (!root.children || root.children.length === 0) {
      mountIn(
        container,
        el('div', {
          className: 'empty-state',
          text: STRINGS.kbFoldersEmpty || 'No files yet.',
        }),
      );
      return;
    }
    mountIn(container, renderFolderChildren(root.children, 0));
  }

  function renderFolderChildren(children, depth) {
    const out = [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const isDir = child.isDirectory;
      const isRepoRoot = !!child.isRepoRoot;
      const isCurrentRepo = !!child.isCurrentRepo;
      const expanded = isDir && Array.isArray(child.children);
      const fileKind = isDir ? '' : (child.fileKind || 'other');
      const attrs = {
        className:
          'tree-node' +
          (expanded ? ' expanded' : '') +
          (isRepoRoot ? ' repo-root-node' : '') +
          (isCurrentRepo ? ' current-repo-node' : ''),
        'data-indent': String(depth),
        'data-kind': isRepoRoot ? 'repo' : (isDir ? 'dir' : 'file'),
        'data-path': child.relPath,
      };
      if (isCurrentRepo) attrs['data-current-repo'] = '1';
      if (!isDir) {
        attrs['data-file-kind'] = fileKind;
        if (child.fileKey) attrs['data-key'] = child.fileKey;
        // Drives the conditional "Revert to System Version" entry in the
        // right-click contextmenu. Mirrors the ✎ codicon below: if the
        // marker shows, the menu entry shows. Boolean-attr convention —
        // presence means true, absence means false — same as the
        // data-current-repo flag on the repo-root container above.
        if (child.isDiverged) attrs['data-diverged'] = '1';
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
      //   - repo-root dirs → codicon-repo (top-level entries under the
      //     Memory Bank header, one per discovered repo — matches the
      //     IntelliJ Memory Bank tool window)
      //   - plain dirs → codicon-folder
      //   - memory/plan/note files → codicon-markdown (all are .md), tinted
      //     by .kb-icon-{kind} class so the kind reads at a glance
      //   - other files → codicon-file
      let iconCodicon;
      if (isRepoRoot) {
        iconCodicon = 'repo';
      } else if (isDir) {
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
          attachTextTip(
            el('span', {
              className: 'kb-tag kb-tag-' + fileKind,
              text: fileKind === 'plan' ? 'P' : 'N',
            }),
            fileKind === 'plan' ? 'Plan' : 'Note',
          ),
        );
      }
      // "Edited on disk" ✎ marker — mirrors the conversation-row pattern
      // (renderConversationRow above). Same codicon, same .edited-icon
      // class, same color token, so a user familiar with the conversations
      // edit indicator recognises this immediately. Tooltip phrasing
      // matches MemoryFileDecorationProvider's native badge.
      if (!isDir && child.isDiverged) {
        labelChildren.push(
          attachTextTip(
            el('i', {
              className: 'codicon codicon-edit edited-icon',
              'aria-label': 'Edited',
            }),
            'Edited on disk — system view unavailable',
          ),
        );
      }
      const rowChildren = [twirl, iconEl].concat(labelChildren);
      // Repo rows get a trailing "view knowledge graph" button. It dispatches the
      // jollimemory.viewKnowledgeGraph command (handled host-side) via the generic
      // command message — the click handler below stops it short of the row toggle.
      if (isRepoRoot) {
        rowChildren.push(
          attachTextTip(
            el(
              'span',
              {
                className: 'repo-graph-btn',
                'data-action': 'view-graph',
                'data-repo': child.relPath,
                role: 'button',
              },
              [el('i', { className: 'codicon codicon-type-hierarchy' })],
            ),
            'View knowledge graph',
          ),
        );
      }
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
      // Defensive merge: a lazy-expand response describes the contents OF
      // a node, not its identity AS displayed in its parent. If the existing
      // child carries repo-level metadata (set by listParentRoot — name as
      // configured, isRepoRoot, isCurrentRepo) that the incoming node
      // forgot to carry over, fold those identity fields forward. Caught
      // the bug where re-expanding the current repo replaced its name
      // with "" and its repo icon with a generic folder.
      const oldChild = parent.children[idx];
      let merged = currentNode;
      if (oldChild && oldChild.isRepoRoot && !currentNode.isRepoRoot) {
        merged = Object.assign({}, currentNode, {
          name: oldChild.name,
          isRepoRoot: oldChild.isRepoRoot,
          isCurrentRepo: oldChild.isCurrentRepo,
        });
      }
      const newKids = parent.children.slice();
      newKids[idx] = merged;
      const newParent = Object.assign({}, parent, { children: newKids });
      folderCache[parentPath] = newParent;
      currentNode = newParent;
      currentPath = parentPath;
    }
  }

  // Graft already-expanded subtrees from folderCache onto a freshly fetched
  // listing. KbFoldersService returns lazy directory children (children:
  // undefined), and renderFolderChildren treats only Array-typed children as
  // "expanded" — so without this, a refresh would collapse every folder the
  // user had open. Cache-miss entries (newly visible folders) keep their lazy
  // form so they render closed, which is correct. PURE: no re-request — the
  // refresh fan-out is kicked off once by requestExpandedRefresh.
  //
  // Applied to EVERY merged reply (see mergeFolders), not just the root, so a
  // per-folder reply's lazy children can never overwrite a deeper expansion
  // the user had open: each reply re-grafts whatever is currently expanded in
  // the cache, making the merge order-independent. After a kb:foldersReset the
  // cache is empty, so this is a no-op for rebuild.
  function graftExpandedFromCache(node) {
    if (!node || !node.isDirectory || !Array.isArray(node.children)) return node;
    const newChildren = node.children.map(function(child) {
      if (!child.isDirectory) return child;
      const cached = folderCache[child.relPath];
      if (cached && Array.isArray(cached.children)) {
        return graftExpandedFromCache(cached);
      }
      return child;
    });
    return Object.assign({}, node, { children: newChildren });
  }

  // On a manual refresh the root listing arrives with NO preceding
  // kb:foldersReset, so folderCache still holds every expanded dir. Re-request
  // each (recursively, all depths) so listInRepo recomputes its files'
  // isDiverged on the reply — a row edited on disk while the sidebar was open
  // finally gets its ✎ marker. Fired ONCE, from the root merge only; the
  // per-folder replies are merged by mergeFolders, which grafts expansion back
  // in, so they can land in any order without collapsing the tree. Grafting on
  // the replies (rather than here) is what keeps this from looping — we never
  // re-post off a reply.
  function requestExpandedRefresh(node) {
    if (!node || !node.isDirectory || !Array.isArray(node.children)) return;
    node.children.forEach(function(child) {
      if (!child.isDirectory) return;
      const cached = folderCache[child.relPath];
      if (cached && Array.isArray(cached.children)) {
        vscode.postMessage({ type: 'kb:expandFolder', path: child.relPath });
        requestExpandedRefresh(cached);
      }
    });
  }

  // Merge incoming kb:foldersData into the cache, then re-render. Graft expanded
  // descendants onto EVERY reply (root and per-folder) so an out-of-order
  // per-folder reply can't overwrite a deeper expansion with a lazy child. Only
  // the root merge kicks off the isDiverged refresh fan-out.
  function mergeFolders(tree) {
    const grafted = graftExpandedFromCache(tree);
    if (tree.relPath === '') requestExpandedRefresh(tree);
    folderCache[grafted.relPath] = grafted;
    propagateUp(grafted.relPath, grafted);
    if (state.activeTab === 'kb' && state.kbMode === 'folders') renderFolders();
    maybeAutoExpandCurrentRepo();
  }

  // Flip a single already-rendered file row's diverged flag in place. Set true
  // on kb:markDiverged (the host sends it when the user opens a .md whose
  // on-disk sha256 no longer matches the manifest fingerprint); set false on
  // kb:clearDiverged (after the host reverts the file to the system version).
  // The row is already in the tree, so we just rebuild its parent dir with the
  // child's new isDiverged (fresh references so render sees the change, matching
  // mergeFolders' style) — no host round-trip / re-listing.
  //
  // The host sends these targeted flips instead of kb:foldersReset precisely so
  // the surrounding tree keeps its expansion state: a content change touches one
  // file's bytes, not the tree's shape, so wiping folderCache (which collapses
  // every open folder) would be the wrong tool. Mark and clear are the same
  // operation with opposite truth values, so they share one body — a future fix
  // to the parentPath derivation or the render gate can't drift between them.
  function setFileDivergedFlag(relPath, diverged) {
    const idx = relPath.lastIndexOf('/');
    const parentPath = idx === -1 ? '' : relPath.slice(0, idx);
    const parent = folderCache[parentPath];
    if (!parent || !Array.isArray(parent.children)) return;
    let changed = false;
    const newChildren = parent.children.map(function(child) {
      if (child.relPath === relPath && !child.isDirectory && !!child.isDiverged !== diverged) {
        changed = true;
        return Object.assign({}, child, { isDiverged: diverged });
      }
      return child;
    });
    if (!changed) return;
    const newParent = Object.assign({}, parent, { children: newChildren });
    folderCache[parentPath] = newParent;
    propagateUp(parentPath, newParent);
    if (state.activeTab === 'kb' && state.kbMode === 'folders') renderFolders();
  }

  // Auto-expand the current repo on first delivery so the user lands inside
  // their own memories instead of staring at a single bold row. One-shot: once
  // we've done it (or seen it already expanded via graftExpandedFromCache),
  // we never auto-expand again so user-driven collapses stick. Triggers off
  // any merge — usually the root listing, but a lazy expand reply that arrives
  // before the root finishes is also fine.
  function maybeAutoExpandCurrentRepo() {
    if (currentRepoAutoExpanded) return;
    const root = folderCache[''];
    if (!root || !Array.isArray(root.children)) return;
    const current = root.children.find(function(c) {
      return c.isCurrentRepo && c.isRepoRoot;
    });
    if (!current) return;
    if (Array.isArray(current.children)) {
      // Already expanded (cache rehydrate / second delivery). Mark done so a
      // later host refresh doesn't fight a user-initiated collapse.
      currentRepoAutoExpanded = true;
      return;
    }
    currentRepoAutoExpanded = true;
    vscode.postMessage({ type: 'kb:expandFolder', path: current.relPath });
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
    hideTextTip();
    const container = tabContents.kb;
    const nodes = [];
    // KB tab Memories timeline is intentionally NOT scoped by the breadcrumb —
    // it's the global "every memory I've created" activity stream. The
    // breadcrumb selection drives the Branch tab Memories section instead,
    // via branchMemoriesCache / getForeignCommitItems. Showing the same data
    // in both places, gated differently, was the source of confusion that
    // led to two separate code paths.
    const visibleItems = memoriesState.items;
    if (visibleItems.length === 0) {
      nodes.push(el('div', { className: 'empty-state', text: STRINGS.kbMemoriesEmpty || 'No memories yet.' }));
      mountIn(container, nodes);
      return;
    }
    // Detect cross-repo mode by counting distinct repoName values across the
    // currently-loaded items. In single-repo views all items share the same
    // repoName, so showing a repo badge would be visual noise; in multi-repo
    // views (Memory Bank aggregating other repos) the badge disambiguates
    // same-named branches across repos.
    const repoNames = new Set();
    for (let i = 0; i < visibleItems.length; i++) {
      const r = visibleItems[i].repoName;
      if (r) repoNames.add(r);
    }
    const showRepoBadge = repoNames.size > 1;
    for (let i = 0; i < visibleItems.length; i++) {
      const m = visibleItems[i];
      // No title= attribute — hover content is rendered by the custom
      // .hover-card popup (renderHoverCard / showHoverCard below) so the
      // legacy native MarkdownString experience (codicons + command links)
      // can be reproduced. A title= would surface a duplicate native tooltip.
      const metaChildren = [
        el('span', { className: 'hash', text: m.commitHash.slice(0, 8) }),
        ' ',
      ];
      if (showRepoBadge && m.repoName) {
        metaChildren.push(el('span', { className: 'repo', text: m.repoName }));
        metaChildren.push(' ');
      }
      metaChildren.push(el('span', { className: 'branch', text: m.branch }));
      metaChildren.push(' ');
      metaChildren.push(el('span', { className: 'time', text: timeAgo(m.timestamp) }));
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
          el('div', { className: 'meta' }, metaChildren),
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
      attachTextTip(
        el('span', {
          className: 'hc-link',
          'data-cmd': 'jollimemory.copyCommitHash',
          'data-hash': m.commitHash,
        }, [
          el('i', { className: 'codicon codicon-git-commit' }),
          el('span', { className: 'hc-hash', text: h.shortHash }),
          el('i', { className: 'codicon codicon-copy' }),
        ]),
        'Copy commit hash',
      ),
    ];
    // The View Memory link only makes sense when a summary actually exists —
    // for memory-less commits the command would dead-end on a 404. Memories
    // rows always have a summary so hasMemory is forced true at lookup time.
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
        el('span', { text: 'View Memory' }),
      ]));
    }
    kids.push(el('div', { className: 'hc-actions' }, actions));
    return kids;
  }

  // Renders the .hover-card body for a Plan row. Same shape as the Memories
  // card (hc-title + hc-row stack + hc-actions) so the shared popover element
  // and CSS work unchanged. Action set differs by committed/uncommitted state:
  // committed plans get hash-copy + Preview Plan, uncommitted plans get just
  // a Preview Plan link (the panel's openPlanForPreview command handles both
  // states — there is no separate edit command at the panel layer).
  function renderPlanHoverCard(slug, h) {
    if (!h) return null;
    const kids = [el('div', { className: 'hc-title', text: h.title })];
    kids.push(el('div', { className: 'hc-row' }, [
      el('i', { className: 'codicon codicon-clock' }),
      el('span', { text: h.relativeDate }),
    ]));
    kids.push(el('div', { className: 'hc-row' }, [
      el('i', { className: 'codicon codicon-markdown' }),
      el('span', { text: h.filename }),
    ]));
    // No "edited N times" row — edit-count tracking was removed because the
    // transcript scanner misses plan touches outside Claude's tool calls, so
    // the number was misleading (often showing "0 times" for actively-edited
    // plans).
    kids.push(el('hr'));
    const actions = [];
    if (h.commitHash) {
      // Committed: short hash + copy icon, then a separator, then Preview.
      actions.push(attachTextTip(
        el('span', {
          className: 'hc-link',
          'data-cmd': 'jollimemory.copyCommitHash',
          'data-hash': h.commitHash,
        }, [
          el('i', { className: 'codicon codicon-git-commit' }),
          el('span', { className: 'hc-hash', text: h.commitHash.substring(0, 8) }),
          el('i', { className: 'codicon codicon-copy' }),
        ]),
        'Copy commit hash',
      ));
      actions.push(el('span', { className: 'hc-sep', text: '|' }));
    }
    actions.push(attachTextTip(
      el('span', {
        className: 'hc-link',
        'data-cmd': 'jollimemory.openPlanForPreview',
        'data-hash': slug,
      }, [
        el('i', { className: 'codicon codicon-eye' }),
        el('span', { text: 'Open Plan' }),
      ]),
      'Open plan',
    ));
    kids.push(el('div', { className: 'hc-actions' }, actions));
    return kids;
  }

  // Renders the .hover-card body for a Note row. Layout mirrors the Plan card
  // but with note-specific fields: the leading icon switches between "note"
  // and "comment" based on format, and the format label replaces the
  // edit-count row (notes don't track edit counts).
  function renderNoteHoverCard(noteId, h) {
    if (!h) return null;
    const kids = [el('div', { className: 'hc-title', text: h.title })];
    kids.push(el('div', { className: 'hc-row' }, [
      el('i', { className: 'codicon codicon-clock' }),
      el('span', { text: h.relativeDate }),
    ]));
    const fileIcon = h.format === 'snippet' ? 'codicon-comment' : 'codicon-note';
    kids.push(el('div', { className: 'hc-row' }, [
      el('i', { className: 'codicon ' + fileIcon }),
      el('span', { text: h.filename }),
    ]));
    kids.push(el('div', { className: 'hc-row' }, [
      el('i', { className: 'codicon codicon-tag' }),
      el('span', { text: h.formatLabel }),
    ]));
    if (h.contentPreview) {
      kids.push(el('hr'));
      // Same hc-description class as Linear's description preview — snippet
      // bodies can contain newlines that hc-stats's default whitespace
      // handling would silently collapse.
      kids.push(el('div', { className: 'hc-description', text: h.contentPreview }));
    }
    kids.push(el('hr'));
    const actions = [];
    if (h.commitHash) {
      actions.push(attachTextTip(
        el('span', {
          className: 'hc-link',
          'data-cmd': 'jollimemory.copyCommitHash',
          'data-hash': h.commitHash,
        }, [
          el('i', { className: 'codicon codicon-git-commit' }),
          el('span', { className: 'hc-hash', text: h.commitHash.substring(0, 8) }),
          el('i', { className: 'codicon codicon-copy' }),
        ]),
        'Copy commit hash',
      ));
      actions.push(el('span', { className: 'hc-sep', text: '|' }));
    }
    actions.push(attachTextTip(
      el('span', {
        className: 'hc-link',
        'data-cmd': 'jollimemory.openNoteForPreview',
        'data-hash': noteId,
      }, [
        el('i', { className: 'codicon codicon-eye' }),
        el('span', { text: 'Open Note' }),
      ]),
      'Open note',
    ));
    kids.push(el('div', { className: 'hc-actions' }, actions));
    return kids;
  }

  // Renders the .hover-card body for a multi-source reference row (Linear /
  // Jira / GitHub / Notion). Mirrors renderHoverCard's shape (hc-title +
  // hc-row stack + hc-actions) so the shared popover element (#memory-hover)
  // and its CSS work unchanged. The card swaps the commit-specific fields
  // (date / commitType / branch / statsLine / hash) for a source badge, the
  // opaque per-source fields rows, and an Open-in-<Source> link.
  function renderReferenceHoverCard(mapKey, h) {
    if (!h) return null;
    // Title row: bold title plus a tiny source badge so the user can tell
    // at a glance which provider the reference came from (L / J / GH / N).
    // Per-source colour is intentionally NOT applied — the Linear-only
    // ancestor of this card explicitly rejected brand tints to keep rows
    // visually uniform; the badge alone is the minimum-viable surfacing.
    const sourceLabel = ({ linear: 'L', jira: 'J', github: 'GH', notion: 'N' })[h.source] || (h.source || '').slice(0, 2).toUpperCase();
    const titleRow = el('div', { className: 'hc-title' }, [
      el('span', { className: 'hc-source-badge', text: sourceLabel }),
      el('span', { text: h.title }),
    ]);
    const kids = [titleRow];
    // Opaque, source-specific fields: one row each (adapter-chosen icon +
    // value). The renderer never names a field — a new source just works.
    for (const f of (h.fields || [])) {
      kids.push(el('div', { className: 'hc-row' }, [
        el('i', { className: 'codicon codicon-' + (f.icon || 'circle-small') }),
        el('span', { text: f.value }),
      ]));
    }
    // Description preview is intentionally not surfaced — see PlansTreeProvider
    // ReferenceItem comment for the rationale.
    kids.push(el('hr'));
    // Single action row: Open in <Source>. Remove lives as the row's inline
    // 🗑 button and Preview / Edit Markdown in the context menu, so the card
    // stays focused on jumping to the upstream record.
    const openLabel = SOURCE_TITLES[h.source]
      ? 'Open in ' + SOURCE_TITLES[h.source]
      : 'Open in Browser';
    const openLink = attachTextTip(
      el('span', {
        className: 'hc-link',
        'data-cmd': 'jollimemory.openReferenceInBrowser',
        'data-hash': mapKey,
      }, [
        el('i', { className: 'codicon codicon-link-external' }),
        el('span', { text: openLabel }),
      ]),
      openLabel,
    );
    kids.push(el('div', { className: 'hc-actions' }, [openLink]));
    return kids;
  }

  // Linear-specific show / schedule functions were removed: the branch-tab
  // mouseover handler now goes through scheduleShowBranchHoverCard (defined
  // alongside lookupBranchHoverById below), which is type-agnostic and
  // accepts the pre-rendered card DOM. Keeping the old Linear-only path
  // would have duplicated the timer dance per row type.

  // Anchor the popover's top-left corner exactly at the cursor — the
  // row→popover transition is then a zero-distance hop, so mouseout's
  // relatedTarget is the popover and the existing guard keeps it open.
  // Vertical: prefer extending down from cursor; flip to bottom-at-cursor
  // when the natural height does not fit below; finally, if neither side
  // can host the full card (panel shorter than card), pick the larger
  // side and cap the card's height with an inline overflow so it never
  // bleeds past the viewport. Reset maxHeight/overflowY first so the
  // measurement reflects natural height, not the previous popover's cap.
  function positionHoverCard(mouseX, mouseY) {
    hoverCardEl.style.left = '-9999px';
    hoverCardEl.style.top = '0px';
    hoverCardEl.style.maxHeight = '';
    hoverCardEl.style.overflowY = '';
    const cardRect = hoverCardEl.getBoundingClientRect();
    const edge = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const spaceBelow = vh - mouseY - edge;
    const spaceAbove = mouseY - edge;
    let top;
    if (cardRect.height <= spaceBelow) {
      top = mouseY;
    } else if (cardRect.height <= spaceAbove) {
      top = mouseY - cardRect.height;
    } else if (spaceAbove >= spaceBelow) {
      top = edge;
      hoverCardEl.style.maxHeight = spaceAbove + 'px';
      hoverCardEl.style.overflowY = 'auto';
    } else {
      top = mouseY;
      hoverCardEl.style.maxHeight = spaceBelow + 'px';
      hoverCardEl.style.overflowY = 'auto';
    }
    let left = mouseX;
    if (left + cardRect.width > vw - edge) {
      left = mouseX - cardRect.width;
    }
    if (left < edge) left = edge;
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
    // Foreign-mode branch view: workspace's branchData.commits does not carry
    // memories from another repo+branch, so fall back to the per-selection
    // cache. The active key matches whatever the breadcrumb currently shows;
    // when the user pivots, the renderBranch() call rebuilds the rows so this
    // lookup will already be aligned with what is on screen.
    const foreignRepo = state.selectedRepoName || state.currentRepoName;
    const foreignBranch = state.selectedBranchName || state.branchName;
    if (foreignRepo && foreignBranch) {
      const foreignItems = branchMemoriesCache[branchMemoriesKey(foreignRepo, foreignBranch)] || [];
      for (let k = 0; k < foreignItems.length; k++) {
        if (foreignItems[k].commitHash === hash) {
          return {
            commitHash: hash,
            hover: foreignItems[k].hover,
            // Foreign rows always represent a stored memory — the list itself
            // is sourced from the cross-repo summary index, not git log.
            hasMemory: true,
            // Cross-repo lookup so the popover's bottom command link opens the
            // right summary panel (same routing the inline "Copy Recall"
            // button uses for foreign rows).
            viewMemoryCommand: 'jollimemory.viewMemorySummary',
          };
        }
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
  // Plans & Notes panel (branch tab): wire plan / note / reference rows into
  // the same hover-card popover that the Memories section uses. Each row
  // type carries its own structured hover field (planHover / noteHover /
  // referenceHover) on the serialized item — the lookup returns the matching
  // entry along with its context so the mouseover handler can pick the right
  // renderer. Plain-text tooltip on the SerializedTreeItem remains the
  // activity-bar TreeView fallback.
  function lookupBranchHoverById(rowId) {
    const items = (branchData && branchData.plans) || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].id !== rowId) continue;
      if (items[i].planHover) return { kind: 'plan', hover: items[i].planHover };
      if (items[i].noteHover) return { kind: 'note', hover: items[i].noteHover };
      if (items[i].referenceHover) return { kind: 'reference', hover: items[i].referenceHover };
      return null;
    }
    return null;
  }
  // Pre-rendered hover-card content scheduler. Mirrors the timer dance of
  // scheduleShowHoverCard (memory rows) — same key-equality re-hover guard,
  // same hide-timer-cancel — but accepts an already-built DOM fragment so
  // the dispatch site doesn't have to know which renderer to call. The
  // alternative (one schedule-show per kind) would duplicate this timer
  // logic three times.
  function scheduleShowBranchHoverCard(rowId, content, mouseX, mouseY) {
    if (hoverCurrentHash === rowId && !hoverCardEl.classList.contains('hidden')) {
      if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
      return;
    }
    cancelHoverShow();
    hoverShowTimer = setTimeout(function() {
      hoverShowTimer = null;
      if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
      mountIn(hoverCardEl, content);
      hoverCardEl.classList.remove('hidden');
      hoverCurrentHash = rowId;
      positionHoverCard(mouseX, mouseY);
    }, HOVER_SHOW_DELAY_MS);
  }
  tabContents.branch.addEventListener('mouseover', function(e) {
    const row = e.target.closest('.tree-node[data-id]');
    if (!row) return;
    const ctx = row.getAttribute('data-context');
    // Only plan / note / reference rows opt into the hover card — commit
    // rows have their own dedicated hover (see renderCommitRow + lookupHoverEntry),
    // and change rows are too dense for one.
    if (ctx !== 'plan' && ctx !== 'note' && ctx !== 'reference') return;
    // Inline action buttons own their own visual feedback; dismiss the row
    // hover card to avoid stacking a popover on top of a button tooltip.
    if (e.target.closest('.inline-actions')) {
      dismissHoverCard();
      return;
    }
    const rowId = row.getAttribute('data-id');
    const found = lookupBranchHoverById(rowId);
    if (!found) return;
    let content;
    if (found.kind === 'plan') content = renderPlanHoverCard(rowId, found.hover);
    else if (found.kind === 'note') content = renderNoteHoverCard(rowId, found.hover);
    else content = renderReferenceHoverCard(rowId, found.hover);
    if (!content) return;
    scheduleShowBranchHoverCard(rowId, content, e.clientX, e.clientY);
  });
  tabContents.branch.addEventListener('mouseout', function(e) {
    const row = e.target.closest('.tree-node[data-id]');
    if (!row) return;
    const ctx = row.getAttribute('data-context');
    if (ctx !== 'plan' && ctx !== 'note' && ctx !== 'reference') return;
    const to = e.relatedTarget;
    // Stay open if mouse moved onto the card itself or stayed on the row
    // (transitioning between child spans — label / desc / icon).
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
      const fileKind = node.getAttribute('data-file-kind');
      // Build menu items per file kind. memory carries the legacy 3-action
      // set keyed off the manifest hash; plan / note are revert-only and
      // start with an empty base list. Other / untracked files exit early
      // so the native browser context menu stays suppressed (the
      // preventDefault above already did that) and nothing replaces it.
      const items = [];
      if (fileKind === 'memory') {
        const key = node.getAttribute('data-key');
        if (!key) return;
        items.push({ label: 'Copy Recall Prompt',  command: 'jollimemory.copyRecallPrompt',  args: [key] });
        items.push({ label: 'Open in Claude Code', command: 'jollimemory.openInClaudeCode',  args: [key] });
        items.push({ separator: true });
        items.push({ label: 'View Memory',         command: 'jollimemory.viewMemorySummary', args: [key] });
      } else if (fileKind !== 'plan' && fileKind !== 'note') {
        return;
      }
      // Append Revert when the renderer flagged this row as diverged. The
      // data-diverged='1' attribute is set in renderFolderChildren above,
      // mirroring the ✎ codicon — so menu visibility tracks the marker
      // exactly. relPath drives the kbRoot-relative wrapper command which
      // resolves to an abs path host-side before delegating to the
      // existing jollimemory.revertMemoryFileEdits handler.
      if (node.getAttribute('data-diverged') === '1') {
        const relPath = node.getAttribute('data-path');
        if (relPath) {
          if (items.length > 0) items.push({ separator: true });
          items.push({ label: 'Revert to System Version', command: 'jollimemory.revertMemoryFileByRelPath', args: [relPath] });
        }
      }
      if (items.length === 0) return;
      showContextMenu(e.clientX, e.clientY, items);
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
    // Per-repo "view knowledge graph" button. Runs before the .tree-node branch
    // so it opens the graph instead of toggling the repo's expand/collapse.
    const graphBtn = e.target.closest('[data-action="view-graph"]');
    if (graphBtn) {
      const repo = graphBtn.getAttribute('data-repo');
      if (repo) vscode.postMessage({ type: 'command', command: 'jollimemory.viewKnowledgeGraph', args: [repo] });
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
    // Repo nodes are directories on disk (their data-path is the repo's dir
    // name under <localFolder>) — clicking one must expand/collapse, not fire
    // kb:openFile, which would route the path through openTextDocument and
    // fail with "is a directory". 'repo' and 'dir' share the same toggle path.
    if (kind === 'dir' || kind === 'repo') {
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
  let branchData = { plans: [], changes: [], commits: [], commitsMode: 'empty', conversations: [], conversationsFailedSources: [] };

  function isCollapsed(section) {
    return !!state.sectionsCollapsed[section];
  }

  function renderBranch() {
    hideTextTip();
    const container = tabContents.branch;
    // Plans & Notes and Changes are workspace-local — they have no meaningful
    // representation for a foreign repo/branch selection. Drop them entirely
    // in foreign-readonly mode so the panel reduces to the Memories list.
    const foreign = isViewingForeign();
    const sections = [];
    if (!foreign) {
      // failedSources is the list of TranscriptSource keys whose discoverer
      // failed (threw or returned r.error) during the most recent aggregator
      // pass. When non-empty, the section renders a small banner above the
      // rows so the user understands "list incomplete", not "list truly empty".
      const failedSources = branchData.conversationsFailedSources || [];
      const conversationsWarning = failedSources.length > 0
        ? 'Some sources unavailable (' + failedSources.join(', ') + '). List may be incomplete.'
        : null;
      sections.push({ id: 'conversations', title: 'CONVERSATIONS', items: branchData.conversations, emptyText: 'No active AI conversations in the last 2 days.', warning: conversationsWarning });
      sections.push({ id: 'plans', title: 'Plans & Notes', items: branchData.plans, emptyText: STRINGS.plansEmpty || 'No plans or notes yet.' });
      sections.push({ id: 'changes', title: 'Changes', items: branchData.changes, emptyText: STRINGS.changesEmpty || 'No changes.' });
    }
    // Section id stays 'commits' (back-compat: section-toggle state and CSS
    // selectors key off it), but the user-facing title is now "Memories"
    // because every selected row maps to — or will become — a Jolli memory.
    //
    // Data source switches with the breadcrumb selection:
    //  - workspace view → branchData.commits (rich BranchCommit shape pushed
    //    by host via branch:commitsData; supports checkboxes / squash / push).
    //  - foreign view   → memoriesState.items filtered by selectedRepoName +
    //    selectedBranchName, adapted to the display-item shape renderCommitRow
    //    consumes. Host doesn't refetch commits on selection change (the bridge
    //    only knows how to git-log workspace HEAD), so we re-derive locally
    //    from the cross-repo summary index that's already loaded.
    const commitsItems = foreign ? getForeignCommitItems() : branchData.commits;
    // Foreign-mode banner — placed at the top of the Memories section body
    // so the user sees an explicit in-panel signal that they are viewing
    // another repo (the chrome-only foreign-readonly CSS class is silent on
    // its own). Wording mirrors IntelliJ CommitsPanel.kt:722 so the two
    // surfaces stay aligned. Uses sectionBanner (not warning) to keep the
    // partial-data orange affordance free for the conversations failure case.
    //
    // The "(read-only)" suffix only renders when the repo itself is foreign;
    // browsing another branch in the workspace repo drops the suffix because
    // those branches are not actually read-only (the user could check them
    // out). Both foreign-flavors get a "Switch back to current workspace"
    // affordance so the user is never stranded after a breadcrumb pick.
    const repo = state.selectedRepoName || state.currentRepoName || '';
    const branch = state.selectedBranchName || state.branchName || '';
    const repoForeign = !!state.selectedRepoName && state.selectedRepoName !== state.currentRepoName;
    const memoriesBanner = foreign && repo && branch
      ? { text: 'Viewing memories from ' + repo + ' / ' + branch + (repoForeign ? ' (read-only)' : ''), showResetLink: true }
      : null;
    sections.push({ id: 'commits', title: 'Memories', items: commitsItems, emptyText: STRINGS.commitsEmpty || 'No memories yet.', sectionBanner: memoriesBanner });
    mountIn(container, sections.map(renderSection));
  }

  // Adapts BranchMemoryItem → the minimal display-item shape renderCommitRow
  // reads. Foreign-readonly mode already suppresses squash / push / checkbox
  // (renderSectionActions returns [] and isMulti is forced false), so the
  // BranchCommit-specific fields (isSelected, children-as-files, etc.) don't
  // need real values — null/false placeholders are enough.
  //
  // Data source is branchMemoriesCache (host-fetched per repo+branch, no
  // parent filter — matches Memory Bank tree's count). Cache miss returns []
  // until the pending selection:branchMemories response arrives.
  function getForeignCommitItems() {
    const repo = state.selectedRepoName || state.currentRepoName || '';
    const branch = state.selectedBranchName || state.branchName || '';
    if (!repo || !branch) return [];
    const items = branchMemoriesCache[branchMemoriesKey(repo, branch)] || [];
    return items.map(function(m) {
      return {
        id: m.commitHash,
        label: m.title || m.commitHash.slice(0, 8),
        description: m.timestamp ? timeAgo(m.timestamp) : '',
        contextValue: 'commitWithMemory',
        children: null,
        isSelected: false,
        // hover is forwarded straight through — the lookup at hover time reads
        // it back from the cache (see lookupHoverEntry), so the foreign Branch
        // panel renders the same popover the KB-tab Memories list shows.
        hover: m.hover,
      };
    });
  }

  function renderSection(s) {
    const collapsed = isCollapsed(s.id);
    const headerKids = [
      el('span', { className: 'twirl', text: '▾' }),
      el('span', { className: 'section-title', text: s.title }),
      el('span', { className: 'section-actions', 'data-section-actions': s.id }, renderSectionActions(s.id)),
    ];
    const rowFn =
      s.id === 'conversations' ? renderConversationRow :
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
    // Partial-data banner — prepended to the body so it survives both the
    // empty-state and the populated-list rendering paths. Sections that don't
    // set a warning skip this entirely.
    if (bodyKids && s.warning) {
      bodyKids.unshift(el('div', { className: 'conversations-warning', text: s.warning }));
    }
    // Foreign-readonly banner ("Viewing memories from <repo> / <branch>
    // [(read-only)]") — prepended after the warning so it sits at the very
    // top of the section body and reads as a section-scoped label rather
    // than a row. Distinct className from the warning above so styling
    // (muted gray vs partial-data orange) is independent. The trailing
    // "Switch back to current workspace" button is a link-styled <button>
    // so it works under the webview's strict CSP (no inline onclick, no
    // javascript: href). Click is handled by the tabContents.branch
    // delegation block keyed off data-action="reset-to-workspace".
    if (bodyKids && s.sectionBanner) {
      const kids = [document.createTextNode(s.sectionBanner.text)];
      if (s.sectionBanner.showResetLink) {
        kids.push(document.createTextNode(' '));
        kids.push(el('button', {
          type: 'button',
          className: 'foreign-banner-reset',
          'data-action': 'reset-to-workspace',
          text: 'Switch back to current workspace',
        }));
      }
      bodyKids.unshift(el('div', { className: 'foreign-banner' }, kids));
    }
    // Primary CTA mounted as a SIBLING of .section-body so it survives the
    // Changes section being collapsed. Commit Memory operates on the group
    // (Plans + Changes + Commits selections together), so hiding it whenever
    // the user folds Changes makes the cross-panel action unreachable. The
    // header sparkle iconbtn is too easy to miss, and a labelled button
    // mirrors the SCM "Commit" pattern users expect. Stays visible when
    // Changes is empty (sits below the empty-state placeholder, disabled via
    // renderCommitMemoryButton's selectedCount===0 guard). Foreign-readonly
    // mode drops the Changes section entirely above, so the s.id==='changes'
    // predicate already implicitly excludes foreign view — no extra check
    // needed.
    const sectionKids = [
      el('div', { className: 'section-header' }, headerKids),
      el('div', { className: 'section-body' }, bodyKids),
    ];
    if (s.id === 'changes') {
      sectionKids.push(renderCommitMemoryButton());
    }
    return el('div', {
      className: 'collapsible-section' + (collapsed ? ' collapsed' : ''),
      'data-section': s.id,
    }, sectionKids);
  }

  function isWorkerBlocking() {
    // Busy with a phase that must disable commit actions. The ingest phase
    // (Memory Bank wiki update, ~80s+) is exempt: it never touches the commit
    // pipeline, so commits landed during it are simply queued for the next
    // worker. Mirrors isWorkerBlockingBusy in util/LockUtils.ts.
    return state.workerBusy && state.workerPhase !== 'ingest';
  }

  function renderCommitMemoryButton() {
    const selectedCount = branchData.changes.filter(function(c) {
      return !!c.isSelected;
    }).length;
    const disabled = selectedCount === 0 || isWorkerBlocking();
    const btn = el('button', {
      type: 'button',
      className: 'commit-memory-btn',
      'data-action': 'changes-commit-memory',
      'aria-label': 'Commit Memory',
    }, [
      el('i', { className: 'codicon codicon-sparkle' }),
      el('span', { className: 'commit-memory-btn-label', text: 'Commit Memory' }),
    ]);
    if (disabled) btn.disabled = true;
    return el('div', { className: 'commit-memory-action' }, [btn]);
  }

  function renderSectionActions(sectionId) {
    // Codicons mirror the legacy native TreeView action icons declared in
    // package.json contributes.commands — keeping a single source of truth so
    // webview UI matches command palette / keybindings.
    if (sectionId === 'conversations') {
      return [
        iconButton('conversations-select-all', 'Select/Deselect All Conversations', 'check-all'),
      ];
    }
    if (sectionId === 'plans') {
      return [
        iconButton('plans-select-all', 'Select/Deselect All Plans & Notes', 'check-all'),
        iconButton('plans-add-menu', 'Add Plan / Note / Snippet', 'add'),
      ];
    }
    if (sectionId === 'changes') {
      // Commit-AI needs at least one staged change to operate on; Discard
      // similarly has no work to do with zero selection. Disable both below
      // that threshold. Re-enables itself on the next branch:changesData
      // push (which always follows a checkbox toggle on the host side).
      // Commit-AI is also disabled while a background AI summary is in
      // progress (isWorkerBlocking) — kicking off another LLM call while
      // the queue worker is mid-summary risks racing the same provider /
      // hitting rate limits. The ingest phase is exempt (see isWorkerBlocking).
      // Discard is local-only so it stays available.
      const selectedCount = branchData.changes.filter(function(c) {
        return !!c.isSelected;
      }).length;
      const noneSelected = selectedCount === 0;
      return [
        iconButton('changes-select-all', 'Select/Deselect All Files', 'check-all'),
        iconButton('changes-commit-ai',  'Commit (AI message)',       'sparkle',  { disabled: noneSelected || isWorkerBlocking() }),
        iconButton('changes-discard',    'Discard Selected Changes',  'discard',  { disabled: noneSelected }),
      ];
    }
    if (sectionId === 'commits') {
      // Foreign-readonly: hide every write-action on the Memories section
      // (Squash, Push Branch, Select All). The user can still open and read
      // individual memories via the row's inline View Memory icon.
      if (isViewingForeign()) return [];
      const m = branchData.commitsMode;
      if (m === 'multi') {
        // Squash is only meaningful with 2+ commits selected. Disable the
        // button below that threshold; it auto-re-enables when the user picks
        // a 2nd commit because branch:commitsData triggers renderBranch which
        // rebuilds these section actions with a fresh selectedCount.
        // Squash is also disabled while a blocking worker run is in progress
        // (isWorkerBlocking, ingest exempt) so the button matches the
        // SquashCommand handler gate and the jollimemory.workerBusy command
        // enablement — same pairing as changes-commit-ai above.
        // Push Branch is also exposed in multi mode now that PushCommand
        // supports any commit count >= 1 — squashing remains a user choice,
        // not a precondition.
        const selectedCount = branchData.commits.filter(function(c) {
          return !!c.isSelected;
        }).length;
        return [
          iconButton('commits-select-all', 'Select/Deselect All Commits', 'check-all'),
          iconButton('commits-squash',     'Squash Selected',             'git-merge', { disabled: selectedCount < 2 || isWorkerBlocking() }),
          iconButton('commits-push-branch', 'Push Branch',                'cloud-upload'),
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
    // isReference gates the title= suppression and the checkbox-omission guard
    // below. The legacy isLinearIssue field was renamed alongside the
    // ReferenceItem refactor — reference rows now cover Linear / Jira / GitHub /
    // Notion uniformly. Regression-tested by the "renderPlanRow suppresses
    // native title= on reference rows" test in SidebarScriptBuilder.test.ts.
    const isReference = item.contextValue === 'reference';
    // Icon comes from the SerializedTreeItem.iconKey set by
    // PlansTreeProvider — committed entries get "lock" with charts.green,
    // uncommitted plans get "file-text", notes get "note", snippets get
    // "comment", Linear/Jira/GitHub references get "issues", Notion
    // pages get "file-text". No row-icon recolour for references — the
    // default text colour matches every other row and avoids brand-specific
    // tints that the user explicitly rejected.
    const iconKey = item.iconKey || (isNote ? 'note' : 'file-text');
    const colorClass = pickIconColorClass(item.iconColor, iconKey);
    const iconEl = el('i', {
      className: 'codicon codicon-' + iconKey + (colorClass ? ' ' + colorClass : ''),
    });
    // Selection checkbox — plan / note / reference rows all carry one (since
    // panel-level reference exclusion landed). 'data-checkbox="1"' opts into the
    // delegated click guard so clicking the checkbox does not also open the
    // underlying editor / browser.
    // For plans: 'data-plan-id' carries the plan slug (item.id = slug from
    // PlansTreeProvider.serialize). For notes: 'data-note-id' carries the
    // note id. For references: 'data-reference-key' carries the
    // source:nativeId mapKey (item.id = reference.mapKey from the same
    // serialize path).
    let rowCheck = null;
    if (isNote) {
      const noteCb = el('input', {
        type: 'checkbox',
        className: 'jm-note-check',
        'data-checkbox': '1',
        'data-note-id': item.id,
      });
      noteCb.checked = !!item.isSelected;
      rowCheck = noteCb;
    } else if (isReference) {
      const referenceCb = el('input', {
        type: 'checkbox',
        className: 'jm-reference-check',
        'data-checkbox': '1',
        'data-reference-key': item.id,
      });
      referenceCb.checked = !!item.isSelected;
      rowCheck = referenceCb;
    } else {
      const planCb = el('input', {
        type: 'checkbox',
        className: 'jm-plan-check',
        'data-checkbox': '1',
        'data-plan-id': item.id,
      });
      planCb.checked = !!item.isSelected;
      rowCheck = planCb;
    }
    // Wrap checkbox in .row-leading so plan / note / reference rows share the
    // same fixed 18px leading slot as Changes rows — column-aligns across
    // sections.
    const kids = [
      el('span', { className: 'twirl' }),
      el('span', { className: 'row-leading' }, rowCheck ? [rowCheck] : []),
      el('span', { className: 'icon' }, [iconEl]),
      el('span', { className: 'label', text: item.label }),
    ];
    if (item.description) {
      kids.push(el('span', { className: 'desc', text: item.description }));
    }
    // Inline-actions: ✎ (edit) then 🗑 (remove). Row click stays preview-only;
    // the inline ✎ mirrors the context menu's edit entry ('Edit Plan' /
    // 'Edit Note' / 'Edit Markdown') as a faster affordance. Both buttons use
    // the small iconbtn variant so the trailing icons read lighter than the
    // Memories rows' View Memory eye instead of dominating the row.
    const editLabel = isReference ? 'Edit Markdown' : isNote ? 'Edit Note' : 'Edit Plan';
    kids.push(
      el('span', { className: 'inline-actions' }, [
        attachTextTip(
          el('button', {
            type: 'button',
            className: 'iconbtn iconbtn--sm',
            'data-inline': 'edit',
            'data-id': item.id,
            'aria-label': editLabel,
          }, [el('i', { className: 'codicon codicon-edit' })]),
          editLabel,
        ),
        attachTextTip(
          el('button', {
            type: 'button',
            className: 'iconbtn iconbtn--sm',
            'data-inline': 'remove',
            'data-id': item.id,
            'aria-label': 'Remove',
          }, [el('i', { className: 'codicon codicon-trash' })]),
          'Remove',
        ),
      ]),
    );
    // Suppress the native title= on every row type that drives the .hover-card
    // popover (plan / note / reference — see the tabContents.branch mouseover
    // handler). A title= would surface a duplicate native tooltip showing the
    // MarkdownString-source plain text, and worse it would trigger on a
    // different timer than the card so the two tooltips would compete.
    return el('div', {
      className: 'tree-node',
      'data-indent': String(depth),
      'data-context': item.contextValue || '',
      'data-id': item.id,
      title: null,
    }, kids);
  }

  // CONVERSATIONS section: lists active AI coding sessions (Claude, Cursor,
  // Codex, Gemini, OpenCode, Copilot, Copilot Chat) updated in the last 2
  // days. Pure read — clicking posts branch:openConversation to the host
  // (extension decides how to surface the transcript). updatedAt arrives as
  // an ISO-8601 string per ActiveConversationItem; timeAgo wants a numeric
  // epoch ms, so parse first and fall back to empty string on garbage input
  // rather than rendering "NaN ms ago".
  function renderConversationRow(item, depth) {
    const ts = Date.parse(item.updatedAt);
    const relative = Number.isFinite(ts) ? timeAgo(ts) : '';
    // Fallback-resolve once here so the row label and the panel tab title
    // share an identical string (panel renders msg.title verbatim, no
    // re-derived fallback).
    const displayTitle = item.title || '(untitled)';
    // Selection checkbox — wrapped in .row-leading after the twirl so it
    // shares the same fixed 18px leading slot as Changes rows (column-
    // aligned across sections). 'data-checkbox="1"' opts into the delegated
    // click guard so clicking the checkbox does not also fire the row's
    // open-conversation listener.
    const convCb = el('input', {
      type: 'checkbox',
      className: 'jm-conv-check',
      'data-checkbox': '1',
      'data-source': item.source,
      'data-session': item.sessionId,
    });
    convCb.checked = !!item.isSelected;
    const kids = [
      el('span', { className: 'twirl' }),
      el('span', { className: 'row-leading' }, [convCb]),
      el('span', { className: 'icon' }, [
        el('i', { className: 'codicon codicon-comment-discussion' }),
      ]),
      el('span', { className: 'label', text: displayTitle }),
    ];
    if (item.isEdited) {
      kids.push(attachTextTip(
        el('i', {
          className: 'codicon codicon-edit edited-icon',
          'aria-label': 'Edited',
        }),
        'Conversation content has been modified',
      ));
    }
    kids.push(el('span', {
      className: 'badge transcript-source-' + item.source,
      text: providerLabel(item.source),
    }));
    kids.push(el('span', { className: 'count', text: String(item.messageCount) }));
    if (relative) {
      kids.push(el('span', { className: 'time', text: relative }));
    }
    const root = attachTextTip(el('div', {
      className: 'tree-node conversation-row',
      'data-indent': String(depth),
      'data-session-id': item.sessionId,
      'data-source': item.source,
    }, kids), displayTitle);
    root.addEventListener('click', function(e) {
      // Guard: clicking the checkbox should not also open the conversation
      // panel. 'data-checkbox="1"' is enough for the delegated click handler
      // at the tabContents.branch level, but this direct listener fires on
      // the same click event, so we need to bail out here too.
      if (e.target && e.target.closest && e.target.closest('[data-checkbox="1"]')) return;
      // Belt-and-suspenders: the aggregator already filters rows with
      // messageCount === 0 (those would open a panel that just says
      // 'No conversation entries to display.'). If a future change
      // bypasses that filter, this guard at the click site keeps the panel
      // from opening on a row the user cannot meaningfully interact with.
      if (!item.messageCount || item.messageCount <= 0) return;
      vscode.postMessage({
        type: 'branch:openConversation',
        sessionId: item.sessionId,
        source: item.source,
        transcriptPath: item.transcriptPath,
        title: displayTitle,
      });
    });
    return root;
  }

  function providerLabel(source) {
    switch (source) {
      case 'claude':       return 'Claude';
      case 'cursor':       return 'Cursor';
      case 'codex':        return 'Codex';
      case 'gemini':       return 'Gemini';
      case 'opencode':     return 'OpenCode';
      case 'copilot':      return 'Copilot';
      case 'copilot-chat': return 'Copilot Chat';
      default:             return source;
    }
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
        attachTextTip(
          el('button', {
            type: 'button',
            className: 'iconbtn',
            'data-inline': 'discard',
            'data-id': item.id,
            'aria-label': 'Discard Changes',
          }, [el('i', { className: 'codicon codicon-discard' })]),
          'Discard Changes',
        ),
      ]),
    );
    if (gs) {
      kids.push(
        el('span', { className: 'gs-letter gs-' + gs, text: gs }),
      );
    }
    return attachTextTip(el('div', {
      // tree-node--changes is the hover-reveal hook for inline-actions
      // (CSS scopes the visibility toggle to changes rows so plans / commits
      // keep their always-visible inline buttons).
      className: 'tree-node tree-node--changes',
      'data-indent': String(depth),
      'data-context': item.contextValue || '',
      'data-id': item.id,
      // Stash the fields the openFileChange / discardFile commands need but
      // can't recover from item.id alone (id is absolutePath; relativePath
      // and statusCode get dropped by the SerializedTreeItem → command
      // bridge unless we surface them explicitly). indexStatus +
      // worktreeStatus are the porcelain v1 raw columns — bridge.discardFiles
      // routes on those (not on the collapsed gs letter), so omitting them
      // would silently break discard for untracked / added / renamed files
      // and leave the activity-bar badge stale post-click.
      'data-rel-path':       item.description || '',
      'data-status-code':    gs,
      'data-index-status':   item.indexStatus    || '',
      'data-worktree-status':item.worktreeStatus || '',
      'data-original-path':  item.originalPath   || '',
    }, kids), item.tooltip || '');
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
      ? attachTextTip(
          el('i', {
            className:
              'codicon ' +
              (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right') +
              ' commit-twirl',
            'data-commit-toggle': item.id,
          }),
          expanded ? 'Collapse' : 'Expand',
        )
      : el('span', { className: 'twirl' });
    // Multi-commit mode renders a checkbox for squash-selection; single /
    // merged modes show a git-commit codicon in the slot instead, matching
    // the legacy native TreeView (HistoryTreeProvider set iconPath to
    // ThemeIcon("git-commit") whenever the checkbox was hidden). The slot
    // width is kept constant so commit rows align horizontally with
    // commit-file rows regardless of mode.
    // Foreign-readonly suppresses the checkbox even in multi mode — squash
    // wouldn't be meaningful against a foreign repo's history.
    const isMulti = branchData.commitsMode === 'multi' && !isViewingForeign();
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
      // Foreign Memories rows (any non-workspace selection — foreign repo OR
      // foreign branch in the workspace repo) mirror the KB-tab timeline
      // view: the primary inline affordance is "Copy Recall Prompt"
      // (codicon-copy), not "View Memory" (codicon-eye). The View Memory
      // route still lives in the row's hover-card + the contextmenu below,
      // so it's not lost — just demoted from the primary tap-target because
      // out-of-workspace browsing is dominated by "pull this memory into
      // the AI context" rather than "open the heavy detail panel".
      // isViewingForeign() returns true for both flavors (see its
      // definition: not (repoMatch and branchMatch)), so workspace-view rows
      // (same repo + same branch) keep the eye icon unchanged.
      const inlineBtn = isViewingForeign()
        ? attachTextTip(
            el('button', {
              type: 'button',
              className: 'iconbtn',
              'data-inline': 'copy-recall',
              'data-id': item.id,
              'aria-label': 'Copy Recall Prompt',
            }, [el('i', { className: 'codicon codicon-copy' })]),
            'Copy Recall Prompt',
          )
        : attachTextTip(
            el('button', {
              type: 'button',
              className: 'iconbtn',
              'data-inline': 'viewSummary',
              'data-id': item.id,
              'aria-label': 'View Memory',
            }, [el('i', { className: 'codicon codicon-eye' })]),
            'View Memory',
          );
      kids.push(el('span', { className: 'inline-actions' }, [inlineBtn]));
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
    // Children share the parent commit's depth (not depth + 1) so the
    // file-row icon column-aligns with the commit row's leading M↓ /
    // git-commit icon. The chevron on the commit row already signals the
    // parent/child relationship, so an extra 20px indent on the file rows
    // would just visually break the icon column without adding info.
    const fileRows = item.children.map(function(c) {
      return renderCommitFileRow(c, depth);
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
    return attachTextTip(el('div', {
      className: 'tree-node',
      'data-indent': String(depth),
      'data-context': 'commitFile',
      'data-id': item.id,
      'data-commit-hash': cf.commitHash || '',
      'data-rel-path':    cf.relativePath || '',
      'data-status-code': cf.statusCode || '',
      'data-old-path':    cf.oldPath || '',
    }, kids), item.tooltip || '');
  }

  // Fallback renderer for sections without a dedicated row function. Every
  // Branch-tab section has one (renderConversationRow / renderPlanRow /
  // renderChangeRow / renderCommitRow), so this renders a plain row with no
  // inline actions — the per-row buttons (🗑 remove, ↻ discard, …) all live
  // in the dedicated renderers.
  function renderTreeItem(item, depth) {
    const kids = [
      el('span', { className: 'twirl' }),
      el('span', { className: 'icon', text: item.iconKey ? '●' : '·' }),
      el('span', { className: 'label', text: item.label }),
    ];
    if (item.description) {
      kids.push(el('span', { className: 'desc', text: item.description }));
    }
    return attachTextTip(el('div', {
      className: 'tree-node',
      'data-indent': String(depth),
      'data-context': item.contextValue || '',
      'data-id': item.id,
    }, kids), item.tooltip || '');
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
    // Foreign-banner "Switch back to current workspace" — sent as TWO
    // selection:request messages because the host handler is single-field
    // if/else (a combined { repoName, branchName } payload would silently
    // drop the branch). First message resets the repo (host auto-picks
    // branches[0]); second message overrides that pick with the workspace
    // branch. Net effect: webview state.selectedRepoName / selectedBranchName
    // collapse back to the workspace identity and the chrome lifts.
    const resetBtn = e.target.closest('[data-action="reset-to-workspace"]');
    if (resetBtn) {
      if (state.currentRepoName) {
        vscode.postMessage({ type: 'selection:request', repoName: state.currentRepoName });
      }
      if (state.branchName) {
        vscode.postMessage({ type: 'selection:request', branchName: state.branchName });
      }
      e.stopPropagation();
      return;
    }
    // Bottom-of-section Commit Memory CTA — not gated on .section-actions
    // because it lives inside .section-body, not the header. Routes to the
    // same command as the header sparkle iconbtn.
    const commitMemoryBtn = e.target.closest('.commit-memory-btn[data-action="changes-commit-memory"]');
    if (commitMemoryBtn && !commitMemoryBtn.disabled) {
      vscode.postMessage({ type: 'command', command: 'jollimemory.commitAI' });
      e.stopPropagation();
      return;
    }
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
        'changes-select-all':        'jollimemory.selectAllFiles',
        'changes-commit-ai':         'jollimemory.commitAI',
        'changes-discard':           'jollimemory.discardSelectedChanges',
        'commits-select-all':        'jollimemory.selectAllCommits',
        'commits-squash':            'jollimemory.squash',
        'commits-push-branch':       'jollimemory.pushBranch',
        'conversations-select-all':  'jollimemory.selectAllConversations',
        'plans-select-all':          'jollimemory.selectAllPlansAndNotes',
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

    // Inline buttons on tree nodes (edit, remove, discard, viewSummary,
    // copy-recall).
    const inline = e.target.closest('[data-inline]');
    if (inline) {
      const action = inline.getAttribute('data-inline');
      const id = inline.getAttribute('data-id');
      const row = inline.closest('.tree-node');
      const ctx = row ? row.getAttribute('data-context') : '';
      if (action === 'edit') {
        // Same three-way routing as the context menu's edit entry: reference
        // markdown is host-resolved by mapKey (branch:openReferenceMarkdown),
        // plan / note go through their editor commands.
        if (ctx === 'reference') {
          vscode.postMessage({ type: 'branch:openReferenceMarkdown', mapKey: id });
        } else {
          const cmd = ctx === 'note' ? 'jollimemory.editNote' : 'jollimemory.editPlan';
          vscode.postMessage({ type: 'command', command: cmd, args: [id] });
        }
      }
      if (action === 'remove') {
        // Plan / Note / Reference rows all share the trash button rendered by
        // renderPlanRow, so the click handler has to route by contextValue.
        // Before this branch existed, reference rows dispatched jollimemory.removePlan
        // — which doesn't know about reference mapKeys, so the trash button
        // silently no-op'd on those rows while working fine on plans/notes.
        const cmd =
          ctx === 'note'      ? 'jollimemory.removeNote' :
          ctx === 'reference' ? 'jollimemory.ignoreReference' :
                                'jollimemory.removePlan';
        vscode.postMessage({ type: 'command', command: cmd, args: [id] });
      }
      if (action === 'discard') {
        // jollimemory.discardFileChanges expects a FileItem-shape (item.fileStatus.*),
        // not a bare id. Route through branch:discardFile so the host rebuilds
        // {fileStatus:{absolutePath,relativePath,statusCode,indexStatus,worktreeStatus,...}}
        // — same pattern as branch:openChange. data-* attrs live on the row
        // (set by renderChangeRow). indexStatus + worktreeStatus must travel
        // through because bridge.discardFiles routes on the raw porcelain
        // columns, NOT on the collapsed gitStatus letter.
        vscode.postMessage({
          type: 'branch:discardFile',
          filePath:        id,
          relativePath:    row ? (row.getAttribute('data-rel-path')        || '') : '',
          statusCode:      row ? (row.getAttribute('data-status-code')     || '') : '',
          indexStatus:     row ? (row.getAttribute('data-index-status')    || '') : '',
          worktreeStatus:  row ? (row.getAttribute('data-worktree-status') || '') : '',
          originalPath:    row ? (row.getAttribute('data-original-path')   || '') : '',
        });
      }
      if (action === 'viewSummary') {
        // Foreign rows live in another repo's storage — single-repo
        // viewSummary silently misses. Route through viewMemorySummary
        // (cross-repo) and into the "memory" panel slot in foreign mode.
        const cmd = isViewingForeign() ? 'jollimemory.viewMemorySummary' : 'jollimemory.viewSummary';
        vscode.postMessage({ type: 'command', command: cmd, args: [id] });
      }
      if (action === 'copy-recall') {
        // Foreign Memories rows (any non-workspace repo/branch) expose
        // Copy Recall Prompt as the primary inline action (matches the
        // KB-tab timeline view's copy-icon idiom). The command is the same
        // one the KB tab's memory rows dispatch — copyRecallPrompt resolves
        // the commit hash through the multi-repo summary index so it works
        // for both workspace and foreign hashes.
        vscode.postMessage({ type: 'command', command: 'jollimemory.copyRecallPrompt', args: [id] });
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
      // Plan vs note dispatch: the host preview commands differ
      // (openPlanForPreview / openNoteForPreview), and routing them through
      // the wrong message treats the id as the wrong kind of identifier
      // (note id ≠ plan slug → the plan path would 404 on noteId.md).
      if (ctx === 'plan') {
        vscode.postMessage({ type: 'branch:openPlan', planId: id });
      }
      if (ctx === 'note') {
        vscode.postMessage({ type: 'branch:openNote', noteId: id });
      }
      if (ctx === 'reference') {
        // Row click previews the reference markdown — same click-equals-preview
        // contract as plan / note rows. The editor path (openReferenceMarkdown)
        // moved to the context menu's 'Edit Markdown'.
        vscode.postMessage({ type: 'branch:openReferencePreview', mapKey: id });
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
        // Memory rows route through kb:openMemory (→ viewMemorySummary →
        // cross-repo getSummaryAnyRepoWithSource): a lookup that resolves
        // amend/rebase hash aliases AND surfaces "No summary found" feedback
        // on a true miss. The Commit slot's branch:openCommit → viewSummary
        // is single-repo, single-hash, and SILENTLY returns on a miss — so a
        // memory stored under a pre-amend hash (the exact stranded-amend case)
        // or in a foreign repo made the click a dead no-op. Applies to every
        // commitWithMemory row (workspace or foreign) plus all foreign rows.
        // Plain unsummarized workspace commit rows keep branch:openCommit
        // (Commit slot; intentionally silent — the code glyph already signals
        // "no memory").
        if (ctx === 'commitWithMemory' || isViewingForeign()) {
          vscode.postMessage({ type: 'kb:openMemory', commitHash: id });
        } else {
          vscode.postMessage({ type: 'branch:openCommit', hash: id });
        }
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

  // Checkbox toggle — routed by class name for conversation/plan/note/reference rows,
  // then by data-checkbox-kind for commit rows, and finally the default-to-file
  // fallback for renderChangeRow (which does not set 'data-checkbox-kind').
  //
  // Conversation rows: 'jm-conv-check' class → branch:toggleConversationSelection
  //   data-source + data-session identify the session uniquely across providers.
  // Plan rows: 'jm-plan-check' class → branch:togglePlanSelection
  //   data-plan-id carries the plan slug (same key as 'setExcluded' uses).
  // Note rows: 'jm-note-check' class → branch:toggleNoteSelection
  //   data-note-id carries the note id (same key as 'setExcluded' uses).
  // Reference rows: 'jm-reference-check' class → branch:toggleReferenceSelection
  //   data-reference-key carries the source:nativeId mapKey.
  // Commit rows: data-checkbox-kind='commit' → branch:toggleCommitSelection
  // File rows: everything else → branch:toggleFileSelection (default fallback)
  tabContents.branch.addEventListener('change', function(e) {
    const cb = e.target.closest('[data-checkbox="1"]');
    if (!cb) return;
    e.stopPropagation();
    // Conversation checkbox — class 'jm-conv-check'
    if (cb.classList.contains('jm-conv-check')) {
      vscode.postMessage({
        type: 'branch:toggleConversationSelection',
        source: cb.getAttribute('data-source'),
        sessionId: cb.getAttribute('data-session'),
        selected: !!cb.checked,
      });
      return;
    }
    // Plan checkbox — class 'jm-plan-check'
    if (cb.classList.contains('jm-plan-check')) {
      vscode.postMessage({
        type: 'branch:togglePlanSelection',
        planId: cb.getAttribute('data-plan-id'),
        selected: !!cb.checked,
      });
      return;
    }
    // Note checkbox — class 'jm-note-check'
    if (cb.classList.contains('jm-note-check')) {
      vscode.postMessage({
        type: 'branch:toggleNoteSelection',
        noteId: cb.getAttribute('data-note-id'),
        selected: !!cb.checked,
      });
      return;
    }
    // Reference checkbox — class 'jm-reference-check'
    if (cb.classList.contains('jm-reference-check')) {
      vscode.postMessage({
        type: 'branch:toggleReferenceSelection',
        mapKey: cb.getAttribute('data-reference-key'),
        selected: !!cb.checked,
      });
      return;
    }
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
  //   - Plans & Notes rows ('plan' / 'note' / 'reference'):
  //       unified Preview / Edit … / ─ / Remove menu. Preview re-posts the
  //       same message the row click sends; Edit opens the source file in a
  //       text editor; Remove mirrors the inline 🗑 button. Reference rows
  //       additionally expose 'Open in Browser' for the upstream record.
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
      // Foreign Memories rows (any non-workspace selection — foreign repo
      // OR foreign branch in the workspace repo, as defined by
      // isViewingForeign) get the same 3-action menu the KB-tab timeline
      // view exposes: Copy Recall Prompt / Open in Claude Code / sep /
      // View Memory. View Memory routes through viewMemorySummary so it
      // resolves the commit through the multi-repo summary index,
      // matching the KB tab's behavior. Workspace-view rows (same repo +
      // same branch) keep the original View Memory + Copy Commit Hash pair.
      if (isViewingForeign() && ctx === 'commitWithMemory') {
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Copy Recall Prompt',  command: 'jollimemory.copyRecallPrompt',  args: [id] },
          { label: 'Open in Claude Code', command: 'jollimemory.openInClaudeCode',  args: [id] },
          { separator: true },
          { label: 'View Memory',         command: 'jollimemory.viewMemorySummary', args: [id] },
        ]);
        return;
      }
      const items = [];
      if (ctx === 'commitWithMemory') {
        items.push({ label: 'View Memory',      command: 'jollimemory.viewSummary',    args: [id] });
        items.push({ separator: true });
      }
      items.push({ label: 'Copy Commit Hash', command: 'jollimemory.copyCommitHash', args: [id] });
      showContextMenu(e.clientX, e.clientY, items);
      return;
    }
    if (ctx === 'plan' || ctx === 'note') {
      const isNote = ctx === 'note';
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Preview',
          rawMessage: isNote
            ? { type: 'branch:openNote', noteId: id }
            : { type: 'branch:openPlan', planId: id } },
        { label: isNote ? 'Edit Note' : 'Edit Plan',
          command: isNote ? 'jollimemory.editNote' : 'jollimemory.editPlan', args: [id] },
        { separator: true },
        { label: 'Remove',
          command: isNote ? 'jollimemory.removeNote' : 'jollimemory.removePlan', args: [id] },
      ]);
      return;
    }
    if (ctx === 'reference') {
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Preview',         rawMessage: { type: 'branch:openReferencePreview',  mapKey: id } },
        { label: 'Edit Markdown',   rawMessage: { type: 'branch:openReferenceMarkdown', mapKey: id } },
        { label: 'Open in Browser', rawMessage: { type: 'branch:openReference',         mapKey: id } },
        { separator: true },
        { label: 'Remove',          rawMessage: { type: 'branch:ignoreReference',       mapKey: id } },
      ]);
      return;
    }
    if (ctx === 'file' || ctx === 'fileChange') {
      showContextMenu(e.clientX, e.clientY, [
        {
          label: 'Discard Changes',
          rawMessage: {
            type: 'branch:discardFile',
            filePath:        id,
            relativePath:    row.getAttribute('data-rel-path')        || '',
            statusCode:      row.getAttribute('data-status-code')     || '',
            indexStatus:     row.getAttribute('data-index-status')    || '',
            worktreeStatus:  row.getAttribute('data-worktree-status') || '',
            originalPath:    row.getAttribute('data-original-path')   || '',
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
