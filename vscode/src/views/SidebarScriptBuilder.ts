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

import { backfillListRendererSource, COLD_START_CAP } from "./BackfillListRenderer.js";
import { buildContextMenuGuardScript } from "./ContextMenuGuard.js";
import { SOURCE_TITLES } from "./SourceLabels.js";
import {
	SONNET_CACHE_WRITE_PER_TOKEN,
	SONNET_INPUT_PER_TOKEN,
	SONNET_OUTPUT_PER_TOKEN,
} from "./SummaryUtils.js";

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
    // Filter null/undefined (matching el()'s child handling): replaceChildren does
    // NOT — it stringifies null to a literal "null" text node. Callers that build
    // a top-level children array with a conditional else-null entry rely on this.
    const arr = (Array.isArray(nodes) ? nodes : [nodes]).filter(function(n) { return n != null; });
    container.replaceChildren.apply(container, arr);
  }
  function clear(container) { container.replaceChildren(); }

  // Shared back-fill row-label helpers (formatBackfillMeta / formatBackfillResult) —
  // single source of truth with the Settings panel; see BackfillListRenderer.ts.
  ${backfillListRendererSource()}

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
    // Per-subsection "show all" toggle (Current Memory's conversations / plans /
    // changes). When false (default) the sub-section caps its row list at
    // SUBSECTION_PREVIEW and shows a "Show N more" affordance; when true it
    // renders every row and shows "Show less". Persisted so the expanded state
    // survives re-renders and reloads.
    subsectionShowAll: {},
    // Per-commit expand toggle (hash → bool). Native TreeView starts each
    // commit collapsed; we mirror that default but persist user toggles
    // across reloads via vscode.setState.
    commitsExpanded: {},
    // Per-memory expand toggle (commitHash → bool) for the Memory Bank
    // Timeline evidence sub-rows. Persisted so toggled rows survive re-renders
    // and tab switches.
    memoriesExpanded: {},
    scrollTops: {},
    // Live flag pushed by the host whenever the post-commit Worker is holding
    // the lock. Drives the "AI summary in progress…" indicator on the Branch
    // toolbar. Not persisted — start from false on every load and let the next
    // worker:busy or status push correct it.
    workerBusy: false,
    // Live phase of the running worker ('ingest:wiki' / 'ingest:graph', or the
    // legacy bare 'ingest'), pushed on the worker:phase channel. Selects the
    // matching "Building knowledge wiki/graph…" label over the default summary
    // label. Not persisted -- host re-pushes on reload.
    workerPhase: null,
    // Workspace HEAD short hash attached to worker:busy while the blocking
    // summary runs — drives the "Summarizing <hash>…" Working Memory row.
    // null when idle or when the host can't resolve it. Not persisted.
    summarizingHash: null,
    // Live sync-phase indicator pushed by the host as the sync engine
    // advances through phases (downloading / merging / uploading) or ends
    // in a sticky terminal failure. Shape: { label, severity } | null. Not
    // persisted — host re-pushes on reload.
    syncPhase: null,
    // Aggregated token usage for the current branch, pushed alongside
    // branch:commitsData. Shape: { input, output, total } | null. Not
    // persisted -- host re-pushes on reload.
    tokenStats: null,
    // ── Back-fill cold-start card ──────────────────────────────────────
    // repoHasMemories / backfillDismissed are pushed by the host on init and
    // reset below on load (never trusted from persisted state — a stale value
    // would flash the card). Optimistic defaults (has memories / not dismissed)
    // so the card never appears before init resolves the truth.
    repoHasMemories: true,
    backfillDismissed: false,
    // Which cold-start card variant applies ('empty' | 'gaps' | null). The card
    // keys visibility on THIS (not repoHasMemories). recentMissingCount is the N
    // in the 'gaps' copy. Host-driven; reset on load.
    coldStartVariant: null,
    recentMissingCount: 0,
    // Card runtime (all reset on load): 'offer' → 'loading' → 'list' →
    // 'progress' → 'done'. candidates/selected/result hold the current flow.
    backfillMode: 'offer',
    backfillCandidates: [],
    backfillSelected: {},
    backfillTotalMissing: 0,
    backfillProgress: { done: 0, total: 0 },
    backfillResult: null
  }, vscode.getState() || {});
  // workerBusy is intentionally reset on load (above), even if persisted state
  // had it set — the lock is process-bound and cannot survive a reload.
  state.workerBusy = false;
  state.workerPhase = null;
  state.summarizingHash = null;
  state.syncPhase = null;
  state.tokenStats = null;
  // Cold-start signals + card runtime are host-driven / transient — never
  // resurrected from persisted state (would flash a stale card on reload).
  state.repoHasMemories = true;
  state.backfillDismissed = false;
  state.coldStartVariant = null;
  state.recentMissingCount = 0;
  state.backfillMode = 'offer';
  state.backfillCandidates = [];
  state.backfillSelected = {};
  state.backfillTotalMissing = 0;
  state.backfillProgress = { done: 0, total: 0 };
  state.backfillResult = null;
  function persist() { vscode.setState(state); }

  // Whether an 'init' message has already reconciled the active tab. The host
  // re-broadcasts init on events that are not sidebar reloads — notably the
  // Working Memory panel's ready handshake, which re-runs the host's
  // handleReady and fans init out to this sidebar. Since getInitialState()
  // always reports activeTab 'branch', an unguarded re-init would yank a user
  // viewing Memory Bank/Status back to Branch. Only the FIRST init sets the
  // tab; later ones reconcile the rest of the state but leave the tab alone.
  var didInitTab = false;

  // ---- DOM refs ----
  const root = document.getElementById('sidebar-root');
  const tabBar = document.getElementById('tab-bar');
  const viewSwitch = document.getElementById('view-switch');
  const tabToolbar = document.getElementById('tab-toolbar');
  const disabledBanner = document.getElementById('disabled-banner');
  const enableBtn = document.getElementById('enable-btn');
  const ctxMenu = document.getElementById('context-menu');
  const breadcrumbEl = document.getElementById('breadcrumb');
  const breadcrumbRepoBtn = document.getElementById('breadcrumb-repo-btn');
  const breadcrumbBranchBtn = document.getElementById('breadcrumb-branch-btn');
  const breadcrumbRepoLabel = document.getElementById('breadcrumb-repo-label');
  const breadcrumbBranchLabel = document.getElementById('breadcrumb-branch-label');
  const breadcrumbMenu = document.getElementById('breadcrumb-menu');
  const repoFilterEl = document.getElementById('repo-filter');
  const repoFilterBtn = document.getElementById('repo-filter-btn');
  const repoFilterValue = document.getElementById('repo-filter-value');
  // Repo/branch enumeration for the dropdowns. Populated by selection:repos /
  // selection:branches inbound messages. Until the host pushes either, the
  // chevron stays hidden and the segment behaves as a static label.
  let repoChoices = [];
  let branchChoicesByRepo = {};
  // kbRepoFilter: the currently selected repo filter on the Memory Bank view.
  // Empty string means 'All repos' (no filter). Scopes renderMemories by m.repoName.
  let kbRepoFilter = '';
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
  // Back-fill cold-start card — full-viewport panel (like onboarding/disabled),
  // shown when enabled + configured + repo has zero memories + not dismissed.
  const backfillPanel = document.getElementById('backfill-panel');
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
    // listeners. Read at show time, not at attach time, so closure text is just
    // the fallback.
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

  // ---- Tab switching ----
  // Navigation has two surfaces that both dispatch through switchTab():
  // the two view-switch buttons (Current Branch / Memory Bank,
  // class 'view-tab') always navigate to their view, and the native
  // "JOLLI MEMORY" title-bar Status icon (jollimemory.toggleStatus → the
  // 'status:toggle' inbound message) toggles the Status overlay open and
  // collapses back to Branch on a second click.
  function switchTab(tab) {
    if (state.activeTab === tab) return;
    const outgoing = tabContents[state.activeTab];
    if (outgoing) state.scrollTops[state.activeTab] = outgoing.scrollTop;

    state.activeTab = tab;
    persist();
    // All [data-tab] elements (the view-switch buttons) sync .active. When the
    // Status overlay is active none of the three match, so none is highlighted.
    document.querySelectorAll('[data-tab]').forEach(function(elBtn) {
      elBtn.classList.toggle('active', elBtn.getAttribute('data-tab') === tab);
    });
    Object.keys(tabContents).forEach(function(t) { tabContents[t].classList.toggle('hidden', t !== tab); });
    renderToolbar();
    applyRepoFilterVisibility();
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
    // switchTab unconditionally reveals the target tab content. If the cold-start
    // card should own the viewport (e.g. init posts activeTab:'branch' after the
    // card was shown, or onboarding lands on 'status'), re-assert it so the card
    // and a tab's content never render stacked. No-op when the card is inactive
    // (applyBackfillCard only touches tab visibility when it is showing), and the
    // "Open your Memory Bank" path flips repoHasMemories=true BEFORE its
    // switchTab('kb'), so that navigation is unaffected.
    applyBackfillCard();
  }

  // The Status overlay's click-to-toggle behavior: opening it when already
  // active collapses back to Branch instead of being a no-op. Triggered by the
  // native title-bar Status icon via the 'status:toggle' inbound message; the
  // logic lives in one place so both the (former in-webview) and the native
  // entry points behave identically.
  function toggleStatusOverlay() {
    if (state.activeTab === 'status') switchTab('branch');
    else switchTab('status');
  }

  // View-switch buttons always navigate to their view (no toggle-to-Branch
  // collapse — that behavior is reserved for the Status overlay).
  document.querySelectorAll('.view-tab[data-tab]').forEach(function(elBtn) {
    elBtn.addEventListener('click', function() {
      switchTab(elBtn.getAttribute('data-tab'));
    });
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

  // Unified expand/collapse chevron used by every collapsible block on the
  // Branch tab (Current Memory, its sub-sections, Pinned, Committed Memories).
  // Matches the codicon chevron the committed-memory rows already use
  // (.commit-twirl) — the glyph itself encodes open/closed (chevron-down when
  // expanded, chevron-right when collapsed), so no CSS rotation is involved.
  function chevron(expanded) {
    return el('i', {
      className: 'codicon ' + (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right') + ' section-twirl',
      'aria-hidden': 'true',
    });
  }

  // Default cap on rows shown per Current-Memory sub-section before the
  // "Show N more" affordance appears. Mirrors the native-tree feel of a short
  // preview list that expands on demand.
  const SUBSECTION_PREVIEW = 5;

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
    // Branch tab carries no toolbar — refresh moved to the Current Memory /
    // Committed Memories section headers, and the post-commit AI-summary signal
    // moved into the Committed Memories header (renderWorkerSignal).
    // Collapse the bar so no empty strip sits above the tree.
    if (state.activeTab === 'branch') {
      clear(tabToolbar);
      tabToolbar.classList.add('hidden');
      return;
    }
    // Other tabs carry toolbar content. Tab switches don't re-run applyEnabled,
    // so re-assert visibility here (gated on enabled + configured to match the
    // applyEnabled / applyConfigured contract).
    tabToolbar.classList.toggle('hidden', !(state.enabled && state.configured !== false));
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
    }
    // No trailing else: the Branch tab returned early above (no toolbar).
  }

  // Shared chrome for the toolbar's left-side status indicator. Used by the
  // Memory Bank tab (sync-phase). The Branch tab's AI-summary signal now lives
  // in the Committed Memories header (renderWorkerSignal), not here.
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
      vscode.postMessage({ type: 'refresh', scope: state.activeTab });
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
        // Cold-start signals must be set BEFORE applyConfigured/applyEnabled,
        // which call applyBackfillCard() and read these. Card visibility keys on
        // coldStartVariant ('empty' | 'gaps' | null); undefined → null (no card).
        state.repoHasMemories = msg.state.repoHasMemories !== false;
        state.backfillDismissed = !!msg.state.backfillDismissed;
        state.coldStartVariant = msg.state.coldStartVariant || null;
        state.recentMissingCount = msg.state.recentMissingCount || 0;
        applyEnabled(msg.state.enabled);
        // Onboarding gate sits on top of enabled — when configured===false it
        // hides the tab UI applyEnabled just configured. configured defaults to
        // true on undefined (e.g. older host code, transient init message)
        // so the regular UI keeps working without a strict-host upgrade.
        applyConfigured(msg.state.configured !== false);
        // Guard against a stale persisted tab that no longer exists (e.g. the
        // removed 'knowledge' view): fall back to the default 'branch' rather
        // than switching to a tab with no panel/toolbar. Only honored on the
        // first init (see didInitTab) so a spurious re-init can't reset the tab.
        if (!didInitTab) {
          didInitTab = true;
          if (msg.state.activeTab && tabContents[msg.state.activeTab]) switchTab(msg.state.activeTab);
        }
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
      case 'status:toggle':
        // Native title-bar Status icon (jollimemory.toggleStatus) was clicked.
        toggleStatusOverlay();
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
        // Host attaches the workspace HEAD short hash while busy so the Working
        // Memory "Summarizing <hash>…" row can name the commit being summarized.
        const nextHash = next ? (msg.commit || null) : null;
        if (state.workerBusy === next && state.summarizingHash === nextHash) break;
        state.workerBusy = next;
        state.summarizingHash = nextHash;
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
        // worker:busy; any 'ingest'-prefixed sub-phase ('ingest', 'ingest:wiki',
        // 'ingest:graph') is kept verbatim so renderToolbar can pick the matching
        // wiki/graph label, anything else clears to the default summary label.
        // Only the Branch tab reacts. renderBranch runs too because the commit
        // buttons' disabled state depends on the phase (ingest is exempt from
        // blocking — see isWorkerBlocking), not just on worker:busy.
        const nextPhase = (msg.phase && msg.phase.indexOf('ingest') === 0) ? msg.phase : null;
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
      case 'kb:memoryEvidence': {
        evidenceCache[msg.commitHash] = msg.evidence;
        delete evidencePending[msg.commitHash];
        // Multiple expanded rows each lazily request evidence; rebuilding the
        // whole tree on every trickling response causes flicker and resets
        // scroll/hover state. Update only the affected row's evidence node in
        // place (precise-message pattern). Fall back to a full render only when
        // the row isn't currently mounted (e.g. the active tab changed since the
        // request was sent) so the cache still surfaces on the next render.
        const placedEvidence = updateMemoryEvidenceInPlace(msg.commitHash, msg.evidence);
        if (!placedEvidence) {
          if (state.activeTab === 'kb' && state.kbMode === 'memories') renderMemories();
          else if (state.activeTab === 'branch') renderBranch();
        }
        break;
      }
      case 'kb:prStatus': {
        // Response to kb:requestPrStatus. Cache the result (pr object or null)
        // keyed by branch, then update only the matching shipped-group(s) in
        // place so the SHIPPED group flips from loading to resolved without a
        // whole-tree rebuild. Fall back to a full render only when no group is
        // currently mounted for this branch.
        prStatusCache[msg.branch] = msg.pr;
        delete prStatusPending[msg.branch];
        const placedPr = updatePrStatusInPlace(msg.branch);
        if (!placedPr) {
          if (state.activeTab === 'branch') renderBranch();
          else if (state.activeTab === 'kb' && state.kbMode === 'memories') renderMemories();
        }
        break;
      }
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
      case 'branch:tokenStats':
        // cached defaults to 0 for back-compat with an older host that didn't
        // send the field (the bar then renders just input/output, no third seg).
        // reporting/memories drive the "N of M memories report token usage"
        // tooltip line; default both to 0 (older host) so the line is suppressed.
        state.tokenStats = {
          input: msg.input,
          output: msg.output,
          cached: msg.cached || 0,
          total: msg.total,
          reporting: msg.reporting || 0,
          memories: msg.memories || 0,
        };
        if (state.activeTab === 'branch') renderBranch();
        break;
      case 'branch:conversationsData':
        branchData.conversations = msg.items.slice();
        branchData.conversationsFailedSources = Array.isArray(msg.failedSources) ? msg.failedSources.slice() : [];
        if (state.activeTab === 'branch') renderBranch();
        break;
      case 'branch:pinsData': {
        const wasEmpty = pinsData.length === 0;
        pinsData = Array.isArray(msg.items) ? msg.items.slice() : [];
        // A collapsed Pinned section whose pins were all removed stops
        // rendering entirely (no header to toggle). When pins reappear the
        // section rebuilds with the stale collapsed state and an empty body,
        // making a just-added pin look lost. Force-expand on that transition.
        if (pinsHydrated && wasEmpty && pinsData.length > 0) {
          state.sectionsCollapsed['pinned'] = false;
        }
        pinsHydrated = true;
        if (state.activeTab === 'branch') renderBranch();
        break;
      }
      case 'backfill:candidates': {
        // Ignore a stale reply for a scope we're no longer showing (only the
        // sidebar card requests, and only 'recent-month', but guard anyway).
        if (msg.scope !== 'recent-month') break;
        // Only accept candidates while awaiting them (offer → 'loading'). A late
        // or duplicate reply must not clobber an in-progress / done view back to
        // the selectable list (which would also reset the user's selection).
        if (state.backfillMode !== 'loading') break;
        state.backfillCandidates = Array.isArray(msg.items) ? msg.items.slice() : [];
        state.backfillTotalMissing = typeof msg.totalMissing === 'number' ? msg.totalMissing : 0;
        // Default every candidate selected.
        state.backfillSelected = {};
        state.backfillCandidates.forEach(function(c) { state.backfillSelected[c.commitHash] = true; });
        state.backfillMode = 'list';
        if (shouldShowBackfillCard()) renderBackfillCard();
        break;
      }
      case 'backfill:progress':
        state.backfillProgress = { done: msg.done || 0, total: msg.total || 0 };
        if (state.backfillMode === 'progress' && shouldShowBackfillCard()) renderBackfillCard();
        break;
      case 'backfill:done':
        state.backfillResult = {
          rows: Array.isArray(msg.rows) ? msg.rows.slice() : [],
          generated: msg.generated || 0,
          skipped: msg.skipped || 0,
          errors: msg.errors || 0,
        };
        state.backfillMode = 'done';
        if (shouldShowBackfillCard()) renderBackfillCard();
        break;
      case 'backfill:coldStart':
        // Live re-push after enable. Ignore entirely while a flow is active
        // (loading/list/progress/done): an enable re-push only matters when the
        // card isn't already mid-flow, and absorbing a variant→null here could
        // later hide the card (via applyBackfillCard on a subsequent
        // enabled:changed) and lose an in-progress selection.
        if (state.backfillMode !== 'offer') break;
        state.repoHasMemories = msg.repoHasMemories !== false;
        state.backfillDismissed = !!msg.backfillDismissed;
        state.recentMissingCount = msg.recentMissingCount || 0;
        state.coldStartVariant = msg.coldStartVariant || null;
        applyBackfillCard();
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
      applyBackfillCard();
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
    viewSwitch.classList.toggle('hidden', !enabled);
    // Branch tab has no toolbar (refresh → section headers, AI-summary signal →
    // Committed Memories header), so the bar collapses there even when enabled.
    // Covers the boot-on-Branch case where switchTab('branch') early-returns and
    // renderToolbar — which otherwise owns this — never runs.
    tabToolbar.classList.toggle('hidden', !enabled || state.activeTab === 'branch');
    // Invalidate the status-entries cache: visibility flipped, so the next
    // status:data push must repaint regardless of whether the JSON changed.
    lastStatusEntriesJson = null;

    if (enabled) {
      // Sync .active class on all [data-tab] elements (icon buttons + view-switch).
      document.querySelectorAll('[data-tab]').forEach(function(elBtn) {
        elBtn.classList.toggle('active', elBtn.getAttribute('data-tab') === state.activeTab);
      });
      // Normal mode: only the active tab's content is visible.
      Object.keys(tabContents).forEach(function(t) {
        tabContents[t].classList.toggle('hidden', t !== state.activeTab);
      });
      applyRepoFilterVisibility();
    } else {
      // Disabled mode: the disabled-panel is the entire UI. Hide every
      // tab-content so the panel sits cleanly in the viewport, and clear the
      // .active class on tab buttons so re-enable starts from a clean slate.
      tabContents.kb.classList.add('hidden');
      tabContents.branch.classList.add('hidden');
      tabContents.status.classList.add('hidden');
      document.querySelectorAll('[data-tab]').forEach(function(elBtn) {
        elBtn.classList.remove('active');
      });
      // Hide the repo filter in disabled mode — tab bar is hidden anyway.
      if (repoFilterEl) repoFilterEl.classList.add('hidden');
    }
    // Cold-start card sits on top of the enabled tab UI: when active it takes
    // the viewport (like onboarding/disabled). Run last so it can re-hide the
    // tab content applyEnabled just revealed.
    applyBackfillCard();
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
      viewSwitch.classList.add('hidden');
      tabToolbar.classList.add('hidden');
      tabContents.kb.classList.add('hidden');
      tabContents.branch.classList.add('hidden');
      tabContents.status.classList.add('hidden');
      disabledBanner.classList.add('hidden');
      // Onboarding owns the viewport when unconfigured — the cold-start card
      // must not compete with it.
      applyBackfillCard();
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

  // ── Back-fill cold-start card ────────────────────────────────────────────
  // Shown when the repo has zero memories (per-repo cold start): offer →
  // (dry-run) list → (LLM) progress → done. All content is built with el()
  // (textContent, no innerHTML) and the progress bar uses fixed-width classes
  // (no inline style — CSP), matching renderTokenBar.
  function shouldShowBackfillCard() {
    // Visibility keys on the host-computed variant: 'empty' (zero memories) or
    // 'gaps' (has memories but a last-month backlog). null/undefined → no card.
    return state.enabled
      && state.configured !== false
      && !state.backfillDismissed
      && (state.coldStartVariant === 'empty' || state.coldStartVariant === 'gaps');
  }
  // The card is an in-flow bordered card at the TOP of the Branch tab, above
  // the PINNED section — it does NOT mask the breadcrumb or other panels. It
  // lives as the first child of the Branch tab content (so it scrolls with the
  // sections). Shown only on the Branch tab; removed elsewhere. renderBranch
  // re-invokes this after rebuilding branch content (which detaches the card).
  function applyBackfillCard() {
    const show = shouldShowBackfillCard() && state.activeTab === 'branch';
    if (!show) {
      backfillPanel.classList.add('hidden');
      if (backfillPanel.parentNode) backfillPanel.parentNode.removeChild(backfillPanel);
      return;
    }
    backfillPanel.classList.remove('hidden');
    const branchEl = tabContents.branch;
    if (branchEl.firstChild !== backfillPanel) branchEl.insertBefore(backfillPanel, branchEl.firstChild);
    renderBackfillCard();
  }
  // Dismiss (✕): persist the per-repo marker + remove the card. The rest of the
  // Branch tab is already visible (the card never masked it), so just hide.
  function bfDismiss() {
    state.backfillDismissed = true;
    vscode.postMessage({ type: 'backfill:dismiss' });
    persist();
    applyBackfillCard();
  }
  function bfDismissButton() {
    const b = el('button', { className: 'bf-dismiss', type: 'button', title: 'Dismiss', 'aria-label': 'Dismiss' }, [
      el('i', { className: 'codicon codicon-close', 'aria-hidden': 'true' }),
    ]);
    b.addEventListener('click', bfDismiss);
    return b;
  }
  function bfSelectedHashes() {
    // Use the SAME predicate the checkbox render uses (!== false) so the visible
    // checked state and the acted-on set never disagree — a candidate with no
    // explicit entry reads as selected in both places.
    return state.backfillCandidates
      .filter(function(c) { return state.backfillSelected[c.commitHash] !== false; })
      .map(function(c) { return c.commitHash; });
  }
  function renderBackfillCard() {
    if (state.backfillMode === 'loading') { mountIn(backfillPanel, renderBackfillLoading()); return; }
    if (state.backfillMode === 'list') { mountIn(backfillPanel, renderBackfillList()); return; }
    if (state.backfillMode === 'progress') { mountIn(backfillPanel, renderBackfillProgress()); return; }
    if (state.backfillMode === 'done') { mountIn(backfillPanel, renderBackfillDone()); return; }
    mountIn(backfillPanel, renderBackfillOffer());
  }
  function bfHeader(titleText, subText) {
    return el('header', { className: 'ob-header bf-header' }, [
      bfDismissButton(),
      el('div', { className: 'ob-title-row' }, [
        el('i', { className: 'codicon codicon-sparkle ob-title-icon', 'aria-hidden': 'true' }),
        el('h2', { className: 'ob-title', text: titleText }),
      ]),
      subText ? el('p', { className: 'ob-subtitle', text: subText }) : null,
    ]);
  }
  // The ✓ note switches on the cold-start variant — wording lives in the shared,
  // unit-tested formatColdStartNote (BackfillListRenderer.ts) so it can't drift.
  function backfillOfferNote() {
    return formatColdStartNote(state.coldStartVariant === 'gaps' ? 'gaps' : 'empty', state.recentMissingCount || 0, ${COLD_START_CAP});
  }
  function renderBackfillOffer() {
    const benefits = [
      ['play', 'Pick up where you left off.', 'Sessions and plans replay next time.'],
      ['references', 'Recall in any tool.', 'Claude, Cursor, Codex via MCP. No copy-paste.'],
      ['graph', 'Knowledge builds itself.', 'A wiki + graph from your commits.'],
    ].map(function(b) {
      return el('div', { className: 'bf-benefit' }, [
        el('i', { className: 'codicon codicon-' + b[0] + ' bf-benefit-icon', 'aria-hidden': 'true' }),
        el('span', {}, [ el('b', { text: b[1] }), document.createTextNode(' ' + b[2]) ]),
      ]);
    });
    const cta = el('button', { className: 'ob-btn ob-btn--primary bf-cta', type: 'button' }, [
      el('i', { className: 'codicon codicon-database', 'aria-hidden': 'true' }),
      document.createTextNode(' Build memories from commits'),
    ]);
    cta.addEventListener('click', function() {
      state.backfillMode = 'loading';
      vscode.postMessage({ type: 'backfill:requestCandidates', scope: 'recent-month' });
      renderBackfillCard();
    });
    return [
      bfHeader('Never re-explain a decision again',
        'The conversations, plans and the why behind every commit, replayed into your next session — in any AI tool.'),
      el('div', { className: 'bf-benefits' }, benefits),
      // ✓ "You're set up" note — top-border divider + green check (mockup .sf-auto).
      el('div', { className: 'bf-note' }, [
        el('i', { className: 'codicon codicon-check bf-note-icon', 'aria-hidden': 'true' }),
        el('span', { text: backfillOfferNote() }),
      ]),
      cta,
      // 🔒 honest footer — top-border divider (mockup .sf-honest).
      el('p', { className: 'bf-honest' }, '🔒 Runs locally on your machine: nothing leaves unless you Share or Sync.'),
    ];
  }
  function renderBackfillLoading() {
    return [
      bfHeader('Scanning your recent commits…', null),
      el('div', { className: 'bf-prog' }, [
        el('i', { className: 'codicon codicon-loading codicon-modifier-spin', 'aria-hidden': 'true' }),
        el('span', { text: 'Looking for the conversations behind each commit. This stays on your machine.' }),
      ]),
    ];
  }
  function renderBackfillRow(c) {
    const cb = el('input', { type: 'checkbox', className: 'bf-row-cb' });
    cb.checked = state.backfillSelected[c.commitHash] !== false;
    cb.addEventListener('change', function() {
      state.backfillSelected[c.commitHash] = cb.checked;
      bfUpdateGenerateBtn();
    });
    return el('label', { className: 'bf-row' }, [
      cb,
      el('div', { className: 'bf-row-main' }, [
        el('div', { className: 'bf-row-title', title: c.subject, text: c.subject }),
        el('div', { className: 'bf-row-meta', text: formatBackfillMeta(c.sessions, c.conversationTurns) }),
      ]),
    ]);
  }
  function bfUpdateGenerateBtn() {
    const btn = backfillPanel.querySelector('.bf-generate');
    if (!btn) return;
    const n = bfSelectedHashes().length;
    btn.disabled = n === 0;
    btn.textContent = n === 0 ? 'Select commits to build' : 'Build ' + n + ' memor' + (n === 1 ? 'y' : 'ies');
  }
  function renderBackfillList() {
    const candidates = state.backfillCandidates;
    if (candidates.length === 0) {
      return [
        bfHeader('No commits to build from', null),
        el('p', { className: 'bf-note' }, 'No commits from the last month need a memory. Keep coding — new commits capture automatically.'),
      ];
    }
    const rows = candidates.map(renderBackfillRow);
    const children = [
      bfHeader('Build memories from your recent commits',
        'Pick the commits to reconstruct. We attach the AI conversation behind each one when we can find it.'),
      el('div', { className: 'bf-list' }, rows),
    ];
    // "N more commits" escape hatch → full scope lives in Settings. The excess
    // is everything missing beyond this capped/windowed list (older commits AND
    // any recent-month commits past the 10-item cap), so label it "more", not "older".
    const more = state.backfillTotalMissing - candidates.length;
    if (more > 0) {
      const link = el('button', { className: 'bf-link', type: 'button' },
        more + ' more commit' + (more === 1 ? '' : 's') + ' without a memory — manage all in Settings');
      link.addEventListener('click', function() { vscode.postMessage({ type: 'backfill:openSettings' }); });
      children.push(el('p', { className: 'bf-older' }, [link]));
    }
    const gen = el('button', { className: 'ob-btn ob-btn--primary bf-generate', type: 'button' });
    // Initial label reflects the default all-selected state (bfUpdateGenerateBtn
    // keeps it in sync as checkboxes toggle).
    const initialN = bfSelectedHashes().length;
    gen.disabled = initialN === 0;
    gen.textContent = initialN === 0 ? 'Select commits to build' : 'Build ' + initialN + ' memor' + (initialN === 1 ? 'y' : 'ies');
    gen.addEventListener('click', function() {
      const hashes = bfSelectedHashes();
      if (hashes.length === 0) return;
      state.backfillProgress = { done: 0, total: hashes.length };
      state.backfillMode = 'progress';
      vscode.postMessage({ type: 'backfill:run', hashes: hashes });
      renderBackfillCard();
    });
    children.push(gen);
    children.push(el('p', { className: 'bf-honest' }, 'Runs one AI call per commit, locally. Nothing leaves unless you Share or Sync.'));
    return children;
  }
  function bfBarWidthClass(done, total) {
    var pct = total > 0 ? Math.floor((done / total) * 10) * 10 : 0;
    if (pct < 0) pct = 0; else if (pct > 100) pct = 100;
    return 'bf-bar-fill bf-bar-fill--w' + pct;
  }
  function renderBackfillProgress() {
    const p = state.backfillProgress;
    return [
      bfHeader('Building memories from your commits…', null),
      el('div', { className: 'bf-prog' }, [
        el('i', { className: 'codicon codicon-loading codicon-modifier-spin', 'aria-hidden': 'true' }),
        el('span', {}, [ el('b', { text: String(p.done) }), document.createTextNode(' / ' + p.total + ' built') ]),
      ]),
      el('div', { className: 'bf-bar' }, [ el('span', { className: bfBarWidthClass(p.done, p.total) }) ]),
      el('p', { className: 'bf-honest' }, "Reading each commit's message + diff. This stays on your machine."),
    ];
  }
  function renderBackfillDone() {
    const r = state.backfillResult || { rows: [], generated: 0, skipped: 0, errors: 0 };
    const rows = r.rows.map(function(row) {
      const isErr = row.status === 'error';
      return el('div', { className: 'bf-result-row' }, [
        el('i', { className: 'codicon codicon-' + (isErr ? 'warning' : 'sparkle') + ' bf-result-icon', 'aria-hidden': 'true' }),
        el('span', { className: 'bf-row-title', title: row.subject, text: row.subject }),
        isErr
          ? el('span', { className: 'bf-chip bf-chip--err', text: 'failed' })
          : el('span', { className: 'bf-chip', text: formatBackfillResult(row.sessions, row.topics) }),
      ]);
    });
    // All-error / nothing built (backfill:done also fires on the failure path with
    // generated: 0). Do NOT clear cold-start state or send the user to an empty
    // Memory Bank — keep the card and offer an in-session retry.
    if (r.generated === 0) {
      const nErr = r.errors || 0;
      const retry = el('button', { className: 'ob-btn ob-btn--primary bf-cta', type: 'button' }, [
        el('i', { className: 'codicon codicon-refresh', 'aria-hidden': 'true' }),
        document.createTextNode(' Try again'),
      ]);
      retry.addEventListener('click', function() {
        // Re-fetch candidates and return to the list; cold-start state untouched.
        state.backfillMode = 'loading';
        vscode.postMessage({ type: 'backfill:requestCandidates', scope: 'recent-month' });
        renderBackfillCard();
      });
      // Build children conditionally — a top-level null entry would reach mountIn's
      // replaceChildren (which, unlike el(), does not filter nulls) and render a
      // literal "null" text node. The thrown-run path posts rows: [] exactly here.
      const errChildren = [
        bfHeader("Couldn't build memories", null),
        el('div', { className: 'bf-note' }, [
          el('i', { className: 'codicon codicon-warning bf-note-icon bf-note-icon--err', 'aria-hidden': 'true' }),
          el('span', { text: nErr + ' commit' + (nErr === 1 ? '' : 's') + " couldn't be built. Check your AI credentials, then try again." }),
        ]),
      ];
      if (rows.length) errChildren.push(el('div', { className: 'bf-result-list' }, rows));
      errChildren.push(retry);
      return errChildren;
    }

    const errNote = r.errors > 0 ? ' · ' + r.errors + ' could not be built' : '';
    const open = el('button', { className: 'ob-btn ob-btn--primary bf-open', type: 'button' }, [
      el('i', { className: 'codicon codicon-arrow-right', 'aria-hidden': 'true' }),
      document.createTextNode(' Open your Memory Bank'),
    ]);
    open.addEventListener('click', function() {
      // Memories now exist for this repo — leave cold start, land on the bank.
      state.repoHasMemories = true;
      state.coldStartVariant = null; // card visibility keys on this → hides the card
      state.backfillMode = 'offer';
      persist();
      applyBackfillCard();
      switchTab('kb');
    });
    return [
      bfHeader(r.generated + ' memor' + (r.generated === 1 ? 'y' : 'ies') + ' built from your history', null),
      el('p', { className: 'bf-note' },
        'Reconstructed from each commit + diff' + errNote + '. Live AI sessions will add richer memories as you work.'),
      el('div', { className: 'bf-result-list' }, rows),
      open,
    ];
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
    applyRepoFilterVisibility();
  }

  // Show the repo-filter control and hide the repo/branch breadcrumb when the
  // Memory Bank tab is active; restore the breadcrumb on other tabs.
  // Called from renderBreadcrumb (runs on every tab switch that touches the
  // breadcrumb) and from applyEnabled (when the tab bar visibility itself changes).
  function applyRepoFilterVisibility() {
    const isKb = state.activeTab === 'kb';
    if (repoFilterEl) repoFilterEl.classList.toggle('hidden', !isKb);
    // On the Memory Bank tab the repo-filter ("Showing: <repo>")
    // is the sole repo selector, so hide the entire repo/branch breadcrumb to
    // avoid a redundant second repo dropdown sitting beside it. The Branch tab
    // keeps the breadcrumb as its repo/branch navigation surface.
    if (breadcrumbEl) breadcrumbEl.classList.toggle('hidden', isKb);
  }

  // Update the repo-filter label to reflect kbRepoFilter.
  function updateRepoFilterLabel() {
    if (repoFilterValue) {
      repoFilterValue.textContent = kbRepoFilter || 'All repos';
    }
  }

  function hideBreadcrumbMenu() {
    breadcrumbMenu.classList.add('hidden');
    breadcrumbRepoBtn.setAttribute('aria-expanded', 'false');
    breadcrumbBranchBtn.setAttribute('aria-expanded', 'false');
    if (repoFilterBtn) repoFilterBtn.setAttribute('aria-expanded', 'false');
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

  // Repo-filter button on the Memory Bank header. Reuses the breadcrumb
  // dropdown (showBreadcrumbMenu / repoChoices) with an 'All repos' prepended
  // entry. Picking a repo sets kbRepoFilter and re-renders the Timeline.
  if (repoFilterBtn) {
    repoFilterBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      const isOpen = repoFilterBtn.getAttribute('aria-expanded') === 'true';
      hideBreadcrumbMenu();
      if (isOpen) return;
      const allItem = {
        value: '',
        label: 'All repos',
        current: kbRepoFilter === '',
        workspace: false,
      };
      const repoItems = repoChoices.map(function(rc) {
        return {
          value: rc.repoName,
          label: rc.repoName + (rc.isCurrent ? ' (current)' : ''),
          current: rc.repoName === kbRepoFilter,
          workspace: !!rc.isCurrent,
        };
      });
      const items = [allItem].concat(repoItems);
      showBreadcrumbMenu(repoFilterBtn, items, function(picked) {
        kbRepoFilter = picked;
        updateRepoFilterLabel();
        if (state.kbMode === 'folders') renderFolders();
        else renderMemories();
      });
    });
  }

  // Dismiss the dropdown on any outside click — guarding against clicks
  // inside the menu itself, which would otherwise close before onPick runs.
  document.addEventListener('click', function(e) {
    if (breadcrumbMenu.classList.contains('hidden')) return;
    if (breadcrumbMenu.contains(e.target)) return;
    if (breadcrumbRepoBtn.contains(e.target)) return;
    if (breadcrumbBranchBtn.contains(e.target)) return;
    if (repoFilterBtn && repoFilterBtn.contains(e.target)) return;
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
    // The header-bar health dot that used to live here was removed when the
    // Status action moved to the native title bar (a static $(pulse) icon that
    // can't carry a runtime color). Health now reads from the entry rows
    // rendered above, visible once the Status overlay is open.
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
    // Scope the tree to a single repo when the user picks one from the
    // 'Showing' repo-filter (kbRepoFilter). Repo roots carry the raw repoName,
    // so this matches the exact key the Memories and Knowledge renderers also
    // filter on — empty string = All repos (no filter).
    const repoChildren = (root.children || []).filter(function(c) {
      return !kbRepoFilter || c.repoName === kbRepoFilter;
    });
    if (repoChildren.length === 0) {
      mountIn(
        container,
        el('div', {
          className: 'empty-state',
          text: STRINGS.kbFoldersEmpty || 'No files yet.',
        }),
      );
      return;
    }
    mountIn(container, renderFolderChildren(repoChildren, 0));
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
  // Evidence cache keyed by commitHash. Populated on kb:memoryEvidence responses;
  // entries survive tab switches and re-renders until the webview is torn down.
  const evidenceCache = {};
  // In-flight kb:expandMemory requests keyed by commitHash. renderMemories runs
  // on every onDidChangeTreeData tick (new commits, sync); without this guard an
  // expanded-but-uncached row re-posts the same request each tick until the
  // first response lands. Mirrors branchMemoriesPending. Cleared on response.
  const evidencePending = {};
  // PR status cache keyed by branch name. Populated by kb:prStatus responses.
  // Values: { number, url } object when a PR exists, null when none.
  // The distinction between absent (not yet fetched) and null (fetched, no PR) is
  // represented by the key being absent vs present with a null value.
  const prStatusCache = {};
  // In-flight kb:requestPrStatus requests keyed by branch. Guards against
  // re-posting on every render tick while the first response is in flight.
  const prStatusPending = {};

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

  function timeGroupLabel(ts) {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayMs = 86400000;
    if (ts >= startOfToday) return 'Today';
    if (ts >= startOfToday - dayMs) return 'Yesterday';
    if (ts >= startOfToday - 7 * dayMs) return 'Earlier this week';
    return 'Older';
  }

  function renderMemories() {
    hideTextTip();
    const container = tabContents.kb;
    const nodes = [];
    // KB tab Memories timeline is the global activity stream across all repos.
    // kbRepoFilter scopes it to a single repo when the user picks one from
    // the 'Showing' repo-filter control in the header. Empty string = All repos.
    // The breadcrumb selection (selectedRepoName) drives the Branch tab instead.
    const visibleItems = kbRepoFilter
      ? memoriesState.items.filter(function(m) { return m.repoName === kbRepoFilter; })
      : memoriesState.items;
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
    let lastGroupLabel = null;
    for (let i = 0; i < visibleItems.length; i++) {
      const m = visibleItems[i];
      const hash = m.commitHash;
      const expanded = !!state.memoriesExpanded[hash];
      const currentGroupLabel = timeGroupLabel(m.timestamp);
      if (currentGroupLabel !== lastGroupLabel) {
        nodes.push(el('div', { className: 'tl-group-label', text: currentGroupLabel }));
        lastGroupLabel = currentGroupLabel;
      }
      // Twirl chevron — clicking it toggles expanded state without opening
      // the memory summary panel. Uses data-memory-toggle so the delegated
      // click handler can intercept before the row-level open fires.
      const twirl = attachTextTip(
        el('i', {
          className: 'codicon ' + (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right') + ' memory-twirl',
          'data-memory-toggle': hash,
        }),
        expanded ? 'Collapse' : 'Expand evidence',
      );
      // No title= attribute — hover content is rendered by the custom
      // .hover-card popup (renderHoverCard / showHoverCard below) so the
      // legacy native MarkdownString experience (codicons + command links)
      // can be reproduced. A title= would surface a duplicate native tooltip.
      const metaChildren = [
        el('span', { className: 'hash', text: hash.slice(0, 8) }),
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
        'data-hash': hash,
      }, [
        twirl,
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
          // used by the toolbar buttons.
          attachTextTip(
            el('button', {
              type: 'button',
              className: 'iconbtn',
              'data-inline': 'copy-recall',
              'data-hash': hash,
              'aria-label': 'Copy Recall Prompt',
            }, [el('i', { className: 'codicon codicon-copy' })]),
            'Copy Recall Prompt',
          ),
        ]),
      ]);
      nodes.push(row);
      // Evidence sub-rows — only rendered when the row is expanded.
      if (expanded) {
        // Also pre-warm the PR-status cache on expansion so the Branch-tab SHIPPED
        // group resolves faster when the user switches over. Uses m.branch directly
        // (KB timeline items carry the branch as a top-level field, not nested in hover).
        const memBranchForPr = m.branch || '';
        if (memBranchForPr && !Object.prototype.hasOwnProperty.call(prStatusCache, memBranchForPr) && !prStatusPending[memBranchForPr]) {
          prStatusPending[memBranchForPr] = true;
          vscode.postMessage({ type: 'kb:requestPrStatus', branch: memBranchForPr });
        }
        const cached = evidenceCache[hash];
        if (cached) {
          nodes.push(renderMemoryEvidence(hash, cached));
        } else {
          // Cache miss: request the evidence (once per hash while in flight) and
          // show a loading placeholder. The pending guard stops the per-tick
          // re-render from re-posting before the first response arrives.
          if (!evidencePending[hash]) {
            evidencePending[hash] = true;
            vscode.postMessage({ type: 'kb:expandMemory', commitHash: hash });
          }
          nodes.push(el('div', { className: 'memory-evidence-loading' }, [
            el('span', { className: 'memory-evidence-loading-text', text: 'Loading…' }),
          ]));
        }
      }
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

  // Renders the three evidence sub-groups (Conversations / Context / Files)
  // for an expanded memory row. Each item row is wired to the appropriate
  // open dispatcher for COMMITTED artifacts (archived snapshots), not the
  // live Branch-tab registry paths — a committed memory's notes/references
  // are gone from plans.json, so the live commands silently fail.
  // 'commitHash' is the memory's own hash, used to open commit-file diffs.
  // sourceRepoName (null = current workspace) routes note/reference reads to
  // the owning repo's storage and gates foreign file-diff opening.
  // Context kind to the colored square letter badge shared by the committed-
  // memory evidence "Context" rows, the live Working Memory CONTEXT rows
  // (renderPlanRow), and the Pinned context rows (renderPinnedRow) so all three
  // surfaces read identically (mockup parity — the prior "no brand tints" entity
  // styling was reversed in favour of matching committed memory). 'kind' is
  // 'plan' | 'note' | 'reference'; 'source' is the reference provider (linear /
  // jira / github / notion) and is ignored for plan / note. The badgeKind drives
  // the hue (see the mem-ctx-badge variants in SidebarCssBuilder).
  function ctxBadge(kind, source) {
    let letter = 'C';
    let badgeKind = kind || '';
    if (kind === 'plan')      letter = 'P';
    else if (kind === 'note') letter = 'N';
    else if (kind === 'reference') {
      const s = source || '';
      badgeKind = s || 'reference';
      if (s === 'linear')      letter = 'L';
      else if (s === 'jira')   letter = 'J';
      else if (s === 'github') letter = 'G';
      else if (s === 'notion') letter = 'N';
      else                     letter = 'R';
    }
    return el('span', { className: 'mem-ctx-badge mem-ctx-badge--' + badgeKind, text: letter });
  }

  function renderMemoryEvidence(commitHash, evidence) {
    const groups = [];
    const convItems = (evidence && evidence.conversations) || [];
    const ctxItems  = (evidence && evidence.context)       || [];
    const fileItems = (evidence && evidence.files)         || [];
    const srcRepoName = (evidence && evidence.sourceRepoName) || null;
    const srcRemoteUrl = (evidence && evidence.sourceRemoteUrl) || null;
    // A foreign-repo memory's files can't be diffed against the workspace git
    // (the commit doesn't exist there), so file rows are non-interactive then.
    const isForeignMemory = !!srcRepoName;

    // Group labels are plain uppercase text separated by a top-border divider
    // (styled in CSS) — no leading codicon, matching the mockup's .mem-group
    // typography. The icon column is reserved for the rows themselves.
    function makeGroup(label, items, makeRow) {
      if (!items || items.length === 0) return null;
      const rows = [];
      for (let i = 0; i < items.length; i++) {
        rows.push(makeRow(items[i]));
      }
      return el('div', { className: 'memory-evidence-group' }, [
        el('div', { className: 'memory-evidence-group-label', text: label }),
        el('div', { className: 'memory-evidence-rows' }, rows),
      ]);
    }

    // Conversations: open via branch:openConversation (same path as the
    // Branch tab conversation rows and pinned conversation rows).
    const convGroup = makeGroup('Conversations', convItems, function(item) {
      const convRow = el('div', {
        className: 'memory-evidence-row' + (isForeignMemory ? ' memory-evidence-row--static' : ''),
        'data-evidence-kind': 'conversation',
        'data-session-id': item.id || '',
        'data-source': item.source || '',
        'data-transcript-path': item.transcriptPath || '',
      }, [
        // Per-source brand glyph (convSourceIcon), kept in lockstep with the
        // live CONVERSATIONS rows and the Pinned rows so the agent identity
        // reads identically across all three. Unknown/absent source falls back
        // to the generic comment-discussion glyph inside convSourceIcon.
        attachTextTip(
          el('span', { className: 'icon conv-source-icon' }, [convSourceIcon(item.source)]),
          providerLabel(item.source),
        ),
        el('span', { className: 'memory-evidence-title', text: item.title || item.id || '' }),
        // Mockup shows the agent identity via the leading icon and a trailing
        // "N msgs" count instead of a source text pill.
        (typeof item.messageCount === 'number') ? el('span', { className: 'msgs', text: String(item.messageCount) + ' msgs' }) : null,
      ]);
      // A foreign-repo memory stores the transcript's absolute path as captured
      // on its own machine/checkout; that file does not exist locally, so the
      // open handler would surface an empty/broken panel. Mirror the Files
      // group: show the row for context but make it non-interactive.
      if (isForeignMemory) {
        attachTextTip(convRow, 'Conversations are only available for memories in the current workspace');
        return convRow;
      }
      convRow.addEventListener('click', function() {
        // Committed memory: open the ARCHIVED snapshot off the orphan branch,
        // NOT branch:openConversation. The live path reads the cursor-trimmed
        // unread slice, which is empty once the turns are consumed into the
        // commit — the host re-reads the full snapshot by commitHash+sessionId.
        vscode.postMessage({
          type: 'kb:openEvidenceConversation',
          commitHash: commitHash,
          sessionId: item.id,
          source: item.source,
          title: item.title || item.id || '',
        });
      });
      return convRow;
    });

    // Context items: plan, note, or reference — routed by kind.
    const ctxGroup = makeGroup('Context', ctxItems, function(item) {
      // Colored square letter badge (P plan / N note / per-source reference
      // letter) via the shared ctxBadge helper — same vocabulary the live
      // Working Memory CONTEXT rows and the Pinned rows now use.
      const ctxRow = el('div', {
        className: 'memory-evidence-row',
        'data-evidence-kind': item.kind || '',
        'data-id': item.id || '',
      }, [
        ctxBadge(item.kind, item.source),
        el('span', { className: 'memory-evidence-title', text: item.title || item.id || '' }),
      ]);
      ctxRow.addEventListener('click', function() {
        if (item.kind === 'plan') {
          if (isForeignMemory) {
            // Foreign-repo plan: branch:openPlan / openPlanForPreview resolve
            // against the current workspace's plans.json + workspace orphan
            // branch, where a foreign repo's plan doesn't exist. Route through
            // the provenance-aware command so the body comes from the owning
            // repo's storage — mirrors the note/reference rows below.
            vscode.postMessage({
              type: 'kb:openEvidencePlan',
              planId: item.id,
              title: item.title || item.id || '',
              sourceRepoName: srcRepoName,
              sourceRemoteUrl: srcRemoteUrl,
            });
          } else {
            // Local memory: openPlanForPreview prefers the local draft and
            // falls back to the workspace orphan-branch snapshot for committed
            // plans, so the live Branch-tab message is the right behavior.
            vscode.postMessage({ type: 'branch:openPlan', planId: item.id });
          }
        } else if (item.kind === 'note') {
          // Committed note → orphan-only previewNote (kb:openEvidenceNote), not
          // the live openNoteForPreview which no-ops once the note is archived.
          vscode.postMessage({
            type: 'kb:openEvidenceNote',
            noteId: item.id,
            title: item.title || item.id || '',
            sourceRepoName: srcRepoName,
            sourceRemoteUrl: srcRemoteUrl,
          });
        } else if (item.kind === 'reference') {
          // Committed reference → archived snapshot read by source + archivedKey
          // (kb:openEvidenceReference), not the live openReferenceForPreview
          // which matches plans.json by mapKey and is empty post-commit.
          vscode.postMessage({
            type: 'kb:openEvidenceReference',
            archivedKey: item.id,
            source: item.source || '',
            sourceRepoName: srcRepoName,
            sourceRemoteUrl: srcRemoteUrl,
          });
        }
      });
      return ctxRow;
    });

    // Files: open as commit-file diffs using the memory's commitHash +
    // relativePath. statusCode falls back to 'M' when absent (per Controller
    // note: CommitSummary per-file data is path-only). For a foreign-repo
    // memory the diff is unsupported (openCommitFileChange resolves the git
    // URI against the workspace repo, where the foreign commit doesn't exist),
    // so the row is shown for context but rendered non-interactive.
    const fileGroup = makeGroup('Files', fileItems, function(item) {
      const sc = item.statusCode || 'M';
      // Mockup file rows mirror the native-TreeView two-channel encoding the
      // Branch-tab commit-file rows use, but stacked: filename (tinted by
      // git-status .gs-{code}) on top, the directory portion muted below, and
      // the trailing status letter (M / A / D / R ...) pinned to the right.
      // No leading codicon — the status letter + filename tint carry the state.
      const relPath = item.relativePath || item.title || '';
      const slash = relPath.lastIndexOf('/');
      const fileName = slash >= 0 ? relPath.slice(slash + 1) : relPath;
      const dirPart  = slash > 0  ? relPath.slice(0, slash)  : '';
      const fileRow = el('div', {
        className: 'memory-evidence-row memory-evidence-file' + (isForeignMemory ? ' memory-evidence-row--static' : ''),
        'data-evidence-kind': 'file',
        'data-commit-hash': commitHash,
        'data-rel-path': relPath,
        'data-status-code': sc,
      }, [
        el('span', { className: 'mef-text' }, [
          el('span', { className: 'mef-name gs-' + sc, text: fileName }),
          dirPart ? el('span', { className: 'mef-dir', text: dirPart }) : null,
        ]),
        el('span', { className: 'gs-letter gs-' + sc, text: sc }),
      ]);
      if (isForeignMemory) {
        attachTextTip(fileRow, 'File diffs are only available for memories in the current workspace');
        return fileRow;
      }
      fileRow.addEventListener('click', function() {
        vscode.postMessage({
          type: 'command',
          command: 'jollimemory.openCommitFileChange',
          // oldPath rides along for renames (statusCode 'R') so the command can
          // diff old path (parent) against new path (commit). Dropped when empty
          // — the handler treats it as optional and '' would confuse rename diffing.
          args: [{ commitHash: commitHash, relativePath: relPath, statusCode: sc, oldPath: item.oldPath ? item.oldPath : undefined }],
        });
      });
      return fileRow;
    });

    if (convGroup) groups.push(convGroup);
    if (ctxGroup)  groups.push(ctxGroup);
    if (fileGroup) groups.push(fileGroup);

    if (groups.length === 0) {
      return el('div', { className: 'memory-evidence-empty', text: 'No evidence recorded.' });
    }
    // Bottom collapse control (mockup .mem-collapse): right-aligned "Hide memory
    // details" with an up chevron. Reuses the same data-commit-toggle channel as
    // the row chevron / show-details text, so one delegated handler drives both
    // expand and collapse.
    const collapse = el('button', {
      type: 'button',
      className: 'memory-evidence-collapse',
      'data-commit-toggle': commitHash,
    }, [
      'Hide memory details',
      el('i', { className: 'codicon codicon-chevron-up' }),
    ]);
    return el('div', { className: 'memory-evidence' }, groups.concat([collapse]));
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
    // Twirl chevron: toggle per-memory evidence expand state. Must run before
    // the .memory-row[data-hash] handler so the chevron doesn't also open the
    // memory summary panel.
    const memToggle = e.target.closest('[data-memory-toggle]');
    if (memToggle) {
      const toggleHash = memToggle.getAttribute('data-memory-toggle');
      state.memoriesExpanded[toggleHash] = !state.memoriesExpanded[toggleHash];
      persist();
      renderMemories();
      e.stopPropagation();
      return;
    }
    // Evidence sub-rows have their own direct addEventListener listeners in
    // renderMemoryEvidence, so clicks inside .memory-evidence are already
    // handled. Guard here so they don't also fire kb:openMemory.
    if (e.target.closest && e.target.closest('.memory-evidence, .memory-evidence-loading')) {
      return;
    }
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
  // Squash is an explicit, transient selection mode (mockup): the user clicks
  // "Squash" to reveal per-memory checkboxes + a confirm bar, picks 2+, then
  // confirms or cancels. Not persisted — a reload starts out of squash mode.
  // Replaces the old always-on checkbox clutter that keyed off commitsMode.
  let squashMode = false;
  // Pinned items from Task B2 protocol. Populated by branch:pinsData.
  // PinEntry shape: { kind: 'conversation'|'plan'|'note'|'memory', id, title, pinnedAt }
  let pinsData = [];
  // First branch:pinsData push is the initial hydration; later pushes are live
  // updates. We only auto-expand the Pinned section on an empty -> non-empty
  // transition AFTER hydration, so the persisted collapse state is honored on
  // load but a re-pin into a (stale) collapsed-and-empty section is not hidden.
  let pinsHydrated = false;

  function isCollapsed(section) {
    return !!state.sectionsCollapsed[section];
  }

  // Renders a single row in the Pinned section. Each pin has a kind-specific
  // icon and an inline Unpin (x) button. Click on the row body opens the
  // pinned item via the existing per-kind open messages. Hidden in foreign-
  // readonly mode: the pinned-section placeholder is dropped above by the
  // !foreign guard in renderBranch, so individual row checks are not needed.
  function renderPinnedRow(pin) {
    const kindIconMap = {
      memory:       'markdown',
      plan:         'file-text',
      note:         'note',
      conversation: 'comment-discussion',
      reference:    'link-external',
    };
    const iconCodicon = kindIconMap[pin.kind] || 'pin';
    // Per-kind leading glyph, kept in lockstep with the committed-memory section
    // so Pinned reads identically (mockup parity):
    //  - conversation → per-source brand glyph (pin.source from PinEntry), like
    //    the live CONVERSATIONS rows; falls back to comment-discussion below.
    //  - plan / note / reference → the colored square letter badge (ctxBadge),
    //    matching the committed-memory evidence "Context" rows. Reference pins
    //    carry no source field, but pin.id IS the "source:nativeId" mapKey, so
    //    the provider is the segment before the first colon.
    //  - memory → blue tinted markdown glyph (kb-icon-memory), matching the
    //    committed-memory rows (was an untinted gray markdown before).
    //  - anything else → its kindIconMap codicon (or the 'pin' fallback).
    let iconNode;
    if (pin.kind === 'conversation' && pin.source) {
      iconNode = attachTextTip(
        el('span', { className: 'icon conv-source-icon' }, [convSourceIcon(pin.source)]),
        providerLabel(pin.source),
      );
    } else if (pin.kind === 'plan' || pin.kind === 'note' || pin.kind === 'reference') {
      const refSource = pin.kind === 'reference' ? String(pin.id || '').split(':')[0] : '';
      iconNode = ctxBadge(pin.kind, refSource);
    } else if (pin.kind === 'memory') {
      iconNode = el('span', { className: 'icon kb-icon-memory' }, [
        el('i', { className: 'codicon codicon-markdown' }),
      ]);
    } else {
      iconNode = el('span', { className: 'icon' }, [
        el('i', { className: 'codicon codicon-' + iconCodicon }),
      ]);
    }
    const row = el('div', {
      className: 'tree-node pinned-row',
      'data-context': 'pinned-' + pin.kind,
      'data-pin-kind': pin.kind,
      'data-pin-id':   pin.id,
    }, [
      el('span', { className: 'twirl' }),
      iconNode,
      el('span', { className: 'label', text: pin.title || pin.id }),
      el('span', { className: 'inline-actions' }, [
        attachTextTip(
          el('button', {
            type: 'button',
            className: 'iconbtn iconbtn--sm',
            'data-inline': 'unpin',
            'data-pin-kind': pin.kind,
            'data-pin-id':   pin.id,
            'aria-label': 'Unpin',
          }, [el('i', { className: 'codicon codicon-close' })]),
          'Unpin',
        ),
      ]),
    ]);
    row.addEventListener('click', function(e) {
      if (e.target && e.target.closest && e.target.closest('[data-inline="unpin"]')) return;
      switch (pin.kind) {
        case 'memory':
          vscode.postMessage({ type: 'branch:openCommit', hash: pin.id });
          break;
        case 'plan':
          vscode.postMessage({ type: 'branch:openPlan', planId: pin.id });
          break;
        case 'note':
          vscode.postMessage({ type: 'branch:openNote', noteId: pin.id });
          break;
        case 'conversation':
          vscode.postMessage({ type: 'branch:openConversation', sessionId: pin.id, source: pin.source, transcriptPath: pin.transcriptPath, title: pin.title });
          break;
        case 'reference':
          // pin.id is the reference mapKey; reopen its rendered preview,
          // matching the Context-row click (branch:openReferencePreview).
          vscode.postMessage({ type: 'branch:openReferencePreview', mapKey: pin.id });
          break;
      }
    });
    return row;
  }

  // Returns the DOM nodes for the Pinned section body. Each pin gets a row via
  // renderPinnedRow. Returns [] when pinsData is empty (caller hides the section).
  function renderPinned() {
    return pinsData.map(renderPinnedRow);
  }

  // Renders the "Current Memory" group header + three sub-sections
  // (Conversations / Context / Files) under a shared .memory-group container
  // so they read as one block representing the next memory being built.
  function renderMemoryGroup(subSections) {
    // Current Memory is now a collapsible block in its own right: its header
    // carries the unified chevron (folds all three sub-sections at once), a
    // single Select/Deselect-All that spans Conversations + Context + Files,
    // and the Branch tab's only "draft" refresh. The heading text is rendered
    // verbatim; uppercasing is a CSS concern (.memory-group-header) so the
    // string stays readable in tests and DOM. Collapse state keys off the
    // 'current-memory' section id (shares state.sectionsCollapsed).
    const collapsed = isCollapsed('current-memory');
    const header = el('div', { className: 'memory-group-header', 'data-cm-header': '1' }, [
      chevron(!collapsed),
      el('span', { className: 'section-title', text: 'Working Memory' }),
      el('span', { className: 'section-actions', 'data-section-actions': 'current-memory' }, [
        // Select-All removed (mockup): inclusion is per-row via the ✕/+ exclude
        // toggle under the included-by-default model. Refresh stays, always-on.
        iconButton('current-memory-refresh', 'Refresh Current Memory', 'refresh'),
      ]),
    ]);
    // The blocking AI summary's "Summarizing <hash>…" progress row leads the
    // group body (above Conversations). It belongs to Working Memory because
    // the summary being generated is what the next committed memory will hold;
    // the Committed Memories header carries only the compact "● AI" pill.
    const bodyKids = [];
    const summarizing = renderSummarizingRow();
    if (summarizing) bodyKids.push(summarizing);
    for (let i = 0; i < subSections.length; i++) bodyKids.push(renderSection(subSections[i]));
    const body = el('div', {
      className: 'memory-group-body' + (collapsed ? ' hidden' : ''),
    }, bodyKids);
    return el('div', {
      className: 'memory-group' + (collapsed ? ' collapsed' : ''),
      'data-group': 'current-memory',
    }, [header, body]);
  }

  // Read-only summarizing-indicator row shown at the top of Working Memory while
  // the blocking post-commit worker runs (workerBusy && no ingest phase —
  // ingest:wiki/graph keep their own header label and add no row).
  //
  // Per the redesign mockup this row reads "Summarizing <hash>…" (matching the
  // .summarizing-row class name and every surrounding reference). worker:busy and
  // worker:phase are independent channels (busy is lock-file-driven; phase only
  // ever stores 'ingest'-prefixed values, else null), so "busy && no phase" is
  // overwhelmingly the blocking summary — a Memory Bank ingest run can briefly
  // land here before its phase signal arrives, but that transient window is rare
  // and the mockup accepts the summarize wording over a vaguer neutral label.
  // The short hash is the workspace HEAD the host attaches to worker:busy;
  // absent (older host / detached edge) it degrades to a bare "Summarizing…".
  function renderSummarizingRow() {
    if (!state.workerBusy || state.workerPhase) return null;
    const hash = state.summarizingHash;
    const label = hash ? ('Summarizing ' + hash + '…') : 'Summarizing…';
    return el('div', { className: 'tree-node summarizing-row', title: label }, [
      el('span', { className: 'icon summarizing-icon' }, [
        el('i', { className: 'codicon codicon-loading codicon-modifier-spin', 'aria-hidden': 'true' }),
      ]),
      el('span', { className: 'label', text: label }),
    ]);
  }

  // Humanize a raw token count to "1.8M" / "118k" / "999" format.
  // Added for the token-bar label; reused by renderTokenBar legend items.
  // Must mirror formatTokensCompact in SummaryUtils.ts (the Commit Memory
  // panel's token meter uses that TS version server-side; this is the
  // client-side JS equivalent for the sidebar webview). The 999500 threshold
  // (not 1000000) must match formatTokensCompact: at 999500 the k-branch would
  // round up to "1000k", so promote to "1M" first.
  function formatTokens(n) {
    if (n >= 999500) return (n / 1000000).toFixed(1).replace(/[.]0$/, '') + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
  }

  // Builds the horizontal token-usage bar shown at the top of Committed
  // Memories (non-foreign). Returns null when stats are absent or total is 0.
  // Uses bucketed CSS width classes on the input segment (no inline style).
  function renderTokenBar(stats) {
    if (!stats || !stats.total) return null;
    var cached = stats.cached || 0;
    // Bucket input + cached to a 10% width class (no inline style — CSP). Output
    // fills the remainder via flex. The two bucketed widths are FIXED-width
    // classes, so their sum must stay strictly below 100% or the output segment
    // (flex remainder) collapses to 0 and the bar can overflow. We FLOOR each to
    // the nearest 10% (round-up on both could push the sum past 100 even when the
    // real values sum below it) and clamp the cached segment to whatever width is
    // left under 100% minus the input segment, guaranteeing output always has room.
    function bucket(n) {
      var pct = Math.floor((n / stats.total) * 100 / 10) * 10;
      return pct < 0 ? 0 : (pct > 100 ? 100 : pct);
    }
    var inputW = bucket(stats.input);
    var segs = [
      el('span', { className: 'token-seg token-seg--input token-seg--w' + inputW }),
    ];
    if (cached > 0) {
      // Leave at least one 10% slot for output: cap the input + cached sum at 90%.
      var cachedW = Math.min(bucket(cached), 90 - inputW);
      if (cachedW < 0) cachedW = 0;
      segs.push(el('span', { className: 'token-seg token-seg--cached token-seg--w' + cachedW }));
    }
    segs.push(el('span', { className: 'token-seg token-seg--output' }));
    var bar = el('div', { className: 'token-bar' }, segs);
    // 'total' is the scalar floor (includes legacy memories that carry
    // conversationTokens but no per-segment breakdown); the segments/cost derive
    // from the breakdown. When NO memory on the branch reports a breakdown the
    // segments are all zero, so a $ estimate and an "0 input · 0 output" legend
    // would contradict the non-zero total — suppress both and show the total
    // alone (the help tooltip already explains the partial reporting).
    var hasBreakdown = stats.input > 0 || stats.output > 0 || cached > 0;
    // Cost estimate (Sonnet 4.6 pricing, per the mockup tooltip's "assumes
    // Sonnet pricing"). The per-token rates below are baked in from
    // SummaryUtils.ts's SONNET_INPUT_PER_TOKEN / SONNET_OUTPUT_PER_TOKEN /
    // SONNET_CACHE_WRITE_PER_TOKEN — the same constants the Commit Memory
    // panel's token meter uses — so a pricing update only has to be made once.
    // The cached segment now carries cache_CREATION tokens (billed at 1.25x the
    // input rate) — cache_READ is excluded upstream because it is cumulative per
    // turn and would inflate the total. So this is a floor (a session's re-read of
    // an already-cached prefix is real spend we deliberately do not count), which
    // is why the tooltip says "actual spend may be higher".
    var costUsd = stats.input * ${SONNET_INPUT_PER_TOKEN} + stats.output * ${SONNET_OUTPUT_PER_TOKEN} + cached * ${SONNET_CACHE_WRITE_PER_TOKEN};
    var costLabel = costUsd >= 0.01 ? '≈$' + costUsd.toFixed(2) : '<$0.01';
    var label = el('div', {
      className: 'token-bar-label',
      text: hasBreakdown
        ? formatTokens(stats.total) + ' tokens \xB7 ' + costLabel + ' \xB7 this branch'
        : formatTokens(stats.total) + ' tokens \xB7 this branch',
    });
    // "?" help affordance — explains the partial-reporting total and the cost
    // estimate (both non-obvious). Wording tracks the mockup. The first sentence
    // is dynamic on reporting/memories; if the host didn't send those counts
    // (older host → memories 0) it degrades to a generic total explanation.
    var reporting = stats.reporting || 0;
    var memories = stats.memories || 0;
    var costSentence = hasBreakdown
      ? ' The ≈$ cost is a cache-aware estimate; it assumes Sonnet pricing and counts reporting memories only, so actual spend may be higher.'
      : '';
    var helpText;
    if (memories > 0 && reporting < memories) {
      helpText =
        reporting + ' of ' + memories + ' memories on this branch report token usage. ' +
        'The others came from sources that don’t report it — so the real total is at least this.' +
        costSentence;
    } else if (memories > 0) {
      helpText =
        'All ' + memories + ' memories on this branch report token usage.' + costSentence;
    } else {
      helpText =
        'Tokens your AI coding sessions spent on this branch — not the tokens Jolli spent summarizing them.' +
        costSentence;
    }
    var help = attachTextTip(
      el('span', { className: 'token-bar-help', 'aria-label': 'About these token counts' }, [
        el('i', { className: 'codicon codicon-question', 'aria-hidden': 'true' }),
      ]),
      helpText,
    );
    var labelRow = el('div', { className: 'token-bar-label-row' }, [label, help]);
    // No per-segment legend when the breakdown is all zero — a "0 input · 0 output"
    // row is noise next to the non-zero total.
    if (!hasBreakdown) {
      return el('div', { className: 'token-bar-wrap' }, [labelRow, bar]);
    }
    var legendKids = [
      el('span', { className: 'tk-leg tk-leg--input', text: formatTokens(stats.input) + ' input' }),
      el('span', { className: 'tk-leg tk-leg--output', text: formatTokens(stats.output) + ' output' }),
    ];
    if (cached > 0) {
      legendKids.push(el('span', { className: 'tk-leg tk-leg--cached', text: formatTokens(cached) + ' cached' }));
    }
    var legend = el('div', { className: 'token-bar-legend' }, legendKids);
    return el('div', { className: 'token-bar-wrap' }, [labelRow, bar, legend]);
  }

  function renderBranch() {
    hideTextTip();
    const container = tabContents.branch;
    // Plans & Notes and Changes are workspace-local — they have no meaningful
    // representation for a foreign repo/branch selection. Drop them entirely
    // in foreign-readonly mode so the panel reduces to Committed Memories.
    const foreign = isViewingForeign();

    // Section id stays 'commits' (back-compat: section-toggle state and CSS
    // selectors key off it). Title is now "Committed Memories" to reflect that
    // every row is — or will become — a committed Jolli memory.
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
    // Foreign-mode banner — placed at the top of the Committed Memories section
    // body so the user sees an explicit in-panel signal that they are viewing
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
    const committedMemoriesSection = { id: 'commits', title: 'Committed Memories', items: commitsItems, emptyText: STRINGS.commitsEmpty || 'No memories yet.', sectionBanner: memoriesBanner };

    // Pinned, Current Memory group, and Committed Memories are shown in
    // workspace (non-foreign) mode. In foreign mode only Committed Memories
    // is shown — the workspace-local sections have no meaningful representation
    // for another repo/branch.
    const nodesToMount = [];
    if (!foreign) {
      // failedSources is the list of TranscriptSource keys whose discoverer
      // failed (threw or returned r.error) during the most recent aggregator
      // pass. When non-empty, the section renders a small banner above the
      // rows so the user understands "list incomplete", not "list truly empty".
      const failedSources = branchData.conversationsFailedSources || [];
      const conversationsWarning = failedSources.length > 0
        ? 'Some sources unavailable (' + failedSources.join(', ') + '). List may be incomplete.'
        : null;

      // Three sub-sections grouped under the "Current Memory" heading.
      // Sub-section ids (conversations / plans / changes) are unchanged —
      // section-toggle state and CSS selectors key off them.
      const subSections = [
        { id: 'conversations', title: 'Conversations', subsection: true, items: branchData.conversations, emptyText: 'No active AI conversations in the last 2 days.', warning: conversationsWarning },
        { id: 'plans', title: 'Context', subsection: true, items: branchData.plans, emptyText: STRINGS.plansEmpty || 'No plans or notes yet.' },
        { id: 'changes', title: 'Files', subsection: true, items: branchData.changes, emptyText: STRINGS.changesEmpty || 'No changes.' },
      ];

      // Pinned section — always shown (mockup), with an empty-state when
      // nothing is pinned so the affordance stays discoverable across sessions.
      const pinnedRows = pinsData.length > 0
        ? renderPinned()
        : [el('div', { className: 'empty-state' }, [
            el('div', { text: 'Nothing pinned.' }),
            el('div', {
              className: 'empty-hint',
              text: 'Pin any conversation, context item, file or memory to keep it at the top of this branch — pinned items survive across sessions.',
            }),
          ])];
      const pinnedHeader = el('div', { className: 'section-header' }, [
        chevron(!isCollapsed('pinned')),
        el('i', { className: 'codicon codicon-pinned pinned-glyph' }),
        el('span', { className: 'section-title', text: 'Pinned' }),
        el('span', { className: 'section-actions', 'data-section-actions': 'pinned' }),
      ]);
      const pinnedBody = el('div', { className: 'section-body' }, isCollapsed('pinned') ? [] : pinnedRows);
      nodesToMount.push(el('div', {
        className: 'collapsible-section' + (isCollapsed('pinned') ? ' collapsed' : ''),
        'data-section': 'pinned',
      }, [pinnedHeader, pinnedBody]));
      nodesToMount.push(renderMemoryGroup(subSections));
      nodesToMount.push(renderCommitReviewBar());
    }
    var committedSection = renderSection(committedMemoriesSection);
    // Token bar: only in workspace (non-foreign) view. Prepend to the section
    // body so it appears above the commit rows and below the section header.
    if (!foreign && state.tokenStats) {
      var tokenBar = renderTokenBar(state.tokenStats);
      var sectionBody = committedSection.querySelector('.section-body');
      if (tokenBar && sectionBody) sectionBody.insertBefore(tokenBar, sectionBody.firstChild);
    }
    // Squash confirm bar sits at the very top of the section body while in
    // squash mode (above the token bar) so the count + actions lead.
    if (!foreign) {
      var squashBar = renderSquashBar();
      var sbody = committedSection.querySelector('.section-body');
      if (squashBar && sbody) sbody.insertBefore(squashBar, sbody.firstChild);
    }
    nodesToMount.push(committedSection);
    mountIn(container, nodesToMount);
    if (!foreign) {
      // Footer is a sticky sibling of the scrolling sections; appended last so it
      // pins to the bottom of the branch view. Hidden in foreign read-only mode.
      container.appendChild(renderBranchFooter());
    }
    // The cold-start card is the first child of the branch content (above PINNED);
    // mountIn above detached it, so re-place it now (no-op when not shown).
    applyBackfillCard();
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

  // Bottom-of-list toggle for a sub-section that has more rows than the preview
  // cap. Collapsed shows "Show N more" with a down chevron; expanded shows
  // "Show less" with an up chevron. Click is handled by the data-show-more
  // delegation branch, which flips state.subsectionShowAll and re-renders.
  function renderShowMoreRow(sectionId, showAll, hiddenCount) {
    return el('div', { className: 'show-more-row', 'data-show-more': sectionId }, [
      el('i', {
        className: 'codicon ' + (showAll ? 'codicon-chevron-up' : 'codicon-chevron-down') + ' section-twirl',
        'aria-hidden': 'true',
      }),
      el('span', {
        className: 'show-more-label',
        text: showAll ? 'Show less' : ('Show ' + hiddenCount + ' more'),
      }),
    ]);
  }

  // Inline post-commit worker signal for the Committed Memories header. The
  // global toolbar that used to host "AI summary in progress…" was removed, so
  // the signal moved next to the section it describes (a committed memory's
  // summary is what the Worker is generating). Returns null when idle so the
  // header stays clean. The phase is the ingest:* family ('ingest:wiki' /
  // 'ingest:graph', or legacy bare 'ingest') during the non-blocking Memory
  // Bank build; null/anything else means the blocking AI summary run. Match the
  // sub-phase via prefix (the host only ever emits the prefixed form — exact
  // '=== ingest' would never hit) and mirror the worker:phase label contract in
  // SidebarMessages.ts. The label truncates on narrow sidebars (CSS); the
  // spinner alone still reads as "working".
  function renderWorkerSignal() {
    if (!state.workerBusy) return null;
    const isIngest = state.workerPhase && state.workerPhase.indexOf('ingest') === 0;
    // Blocking AI summary run: the header carries only a compact "● AI" pill
    // (the visible text stays short so it never crowds the narrow header). The
    // hover title names the commit being summarized — "Summarizing <hash>…",
    // matching the Working Memory row — degrading to a bare "Summarizing…" when
    // the host attached no hash (older host / detached edge).
    if (!isIngest) {
      const hash = state.summarizingHash;
      const aiTitle = hash ? ('Summarizing ' + hash + '…') : 'Summarizing…';
      return el('span', { className: 'section-ai-pill', title: aiTitle }, [
        el('span', { className: 'section-ai-dot', 'aria-hidden': 'true' }),
        el('span', { className: 'section-ai-text', text: 'AI' }),
      ]);
    }
    // Non-blocking Memory Bank build → a compact pill mirroring the "● AI" pill:
    // a small spinner + a short phase word (Wiki / Graph) so it never truncates
    // in a narrow header. The verbose "Building knowledge …" phrasing survives
    // only as the pill's hover title. graph is the more specific prefix → test
    // it before the wiki fallback, else 'ingest:graph' would match the bare
    // 'ingest' branch and mislabel.
    const isGraph = state.workerPhase.indexOf('ingest:graph') === 0;
    const label = isGraph ? 'Building knowledge graph…' : 'Building knowledge wiki…';
    const short = isGraph ? 'Graph' : 'Wiki';
    return el('span', { className: 'section-build-pill', title: label }, [
      el('i', { className: 'codicon codicon-loading codicon-modifier-spin section-build-spin', 'aria-hidden': 'true' }),
      el('span', { className: 'section-build-text', text: short }),
    ]);
  }

  function renderSection(s) {
    // Sub-sections (Conversations / Context / Files) no longer collapse on
    // their own — the Working Memory group header owns the one chevron that
    // folds all three at once. So they carry no chevron and always render
    // expanded (forcing false also rescues any sub-section left collapsed in
    // persisted state, which would otherwise be stranded with no affordance to
    // reopen). Only top-level blocks (Pinned / Committed Memories) collapse.
    const collapsed = s.subsection ? false : isCollapsed(s.id);
    // Sub-section titles show a count of their items right after the label
    // (Conversations 7, Context 2, …). Top-level sections (Committed Memories)
    // keep a bare title. The count lives inside the flex:1 .section-title so it
    // hugs the label text rather than floating next to the right-edge actions.
    const titleKids = [document.createTextNode(s.title)];
    if (s.subsection) {
      titleKids.push(el('span', { className: 'section-count', text: String(s.items.length) }));
    }
    const headerKids = [];
    if (!s.subsection) headerKids.push(chevron(!collapsed));
    headerKids.push(el('span', { className: 'section-title' }, titleKids));
    // Committed Memories carries the post-commit AI-summary indicator (sits
    // between the title and the right-edge actions; null/idle adds nothing).
    if (s.id === 'commits') {
      const workerIndicator = renderWorkerSignal();
      if (workerIndicator) headerKids.push(workerIndicator);
    }
    headerKids.push(
      el('span', { className: 'section-actions', 'data-section-actions': s.id }, renderSectionActions(s.id)),
    );
    const rowFn =
      s.id === 'conversations' ? renderConversationRow :
      s.id === 'plans'   ? renderPlanRow :
      s.id === 'changes' ? renderChangeRow :
      s.id === 'commits' ? renderCommitRow :
      function(it, depth) { return renderTreeItem(it, depth); };
    // Sub-sections preview at most SUBSECTION_PREVIEW rows; the rest hide
    // behind a "Show N more" toggle (state.subsectionShowAll[s.id]). Top-level
    // sections render every row. overLimit gates whether the toggle row appears
    // at all.
    const overLimit = s.subsection && s.items.length > SUBSECTION_PREVIEW;
    // Reset the persisted "show all" flag once a sub-section shrinks back to (or
    // below) the preview cap. Without this, a sub-section that later regrows past
    // the cap would render fully expanded with a "Show less" toggle instead of
    // the collapsed preview, because the stale flag survived the shrink. The
    // toggle row is gated on overLimit, so the flag is meaningless while small —
    // clearing it keeps render and persisted state honest.
    if (s.subsection && !overLimit && state.subsectionShowAll[s.id]) {
      delete state.subsectionShowAll[s.id];
    }
    const showAll = !!state.subsectionShowAll[s.id];
    const visibleItems = (overLimit && !showAll) ? s.items.slice(0, SUBSECTION_PREVIEW) : s.items;
    // rowFn may return either a single node OR an array (commit rows fan
    // out into commit + nested file children when expanded). Flatten one
    // level so the result is a flat list of DOM nodes the section body
    // can append directly.
    const bodyKids = collapsed
      ? null
      : (s.items.length === 0
          ? [el('div', { className: 'empty-state', text: s.emptyText })]
          : visibleItems.reduce(function(acc, it) {
              const out = rowFn(it, 0);
              if (Array.isArray(out)) {
                for (let i = 0; i < out.length; i++) acc.push(out[i]);
              } else {
                acc.push(out);
              }
              return acc;
            }, []));
    // "Show N more" / "Show less" toggle — appended after the rows (so it sits
    // at the bottom of the list) but before the banners below, which unshift to
    // the top. Only when the sub-section actually has more than the preview cap.
    if (bodyKids && overLimit) {
      bodyKids.push(renderShowMoreRow(s.id, showAll, s.items.length - SUBSECTION_PREVIEW));
    }
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
    const sectionKids = [
      el('div', { className: 'section-header' }, headerKids),
      el('div', { className: 'section-body' }, bodyKids),
    ];
    return el('div', {
      className: 'collapsible-section' + (collapsed ? ' collapsed' : '') + (s.subsection ? ' subsection' : ''),
      'data-section': s.id,
    }, sectionKids);
  }

  function isWorkerBlocking() {
    // Busy with a phase that must disable commit actions. The ingest family
    // (Memory Bank wiki update + graph build, ~80s+) is exempt: it never touches
    // the commit pipeline, so commits landed during it are simply queued for the
    // next worker. Prefix match so every 'ingest:*' sub-phase stays exempt.
    // Mirrors isWorkerBlockingBusy in util/LockUtils.ts.
    return state.workerBusy && !(state.workerPhase && state.workerPhase.indexOf('ingest') === 0);
  }

  function renderCommitReviewBar() {
    var changes = branchData.changes || [];
    var selectedCount = changes.filter(function (c) { return !!c.isSelected; }).length;
    var disabled = selectedCount === 0 || isWorkerBlocking();
    var commitBtn = el('button', {
      className: 'cmd-btn primary', 'data-action': 'body-commit', 'aria-label': 'Commit Memory',
    }, [el('i', { className: 'codicon codicon-sparkle' }), el('span', { text: 'Commit Memory' })]);
    if (disabled) commitBtn.disabled = true;
    var reviewBtn = el('button', {
      className: 'cmd-btn', 'data-action': 'body-review', 'aria-label': 'Review next memory',
    }, [el('i', { className: 'codicon codicon-eye' }), el('span', { text: 'Review' })]);
    if (disabled) reviewBtn.disabled = true;
    return el('div', { className: 'commit-review-bar' }, [commitBtn, reviewBtn]);
  }

  // Squash confirm bar — shown at the top of the Committed Memories body while
  // in the explicit squash selection mode. Mirrors the mockup .squash-bar:
  // a live count, Select-all/none, Squash (gated on 2+ selected) and Cancel.
  // The count keys off branchData.commits selection, which round-trips through
  // the host (branch:toggleCommitSelection) and re-renders, so it stays live.
  function renderSquashBar() {
    if (!squashMode || isViewingForeign()) return null;
    var selected = (branchData.commits || []).filter(function(c) { return !!c.isSelected; }).length;
    var countText = selected < 2 ? 'Select 2+ memories to squash' : selected + ' memories selected';
    var countEl = el('span', { className: 'squash-count', role: 'status', 'aria-live': 'polite', text: countText });
    var selAll = el('button', {
      className: 'squash-select-all linklike', type: 'button',
      'data-action': 'squash-select-all', text: 'Select all / none',
    });
    var confirmBtn = el('button', {
      className: 'cmd-btn primary squash-confirm', type: 'button',
      'data-action': 'squash-confirm', 'aria-label': 'Squash selected memories',
    }, [el('span', { text: 'Squash' })]);
    if (selected < 2 || isWorkerBlocking()) confirmBtn.disabled = true;
    var cancelBtn = el('button', {
      className: 'cmd-btn squash-cancel', type: 'button',
      'data-action': 'squash-cancel',
    }, [el('span', { text: 'Cancel' })]);
    return el('div', { className: 'squash-bar' }, [countEl, selAll, confirmBtn, cancelBtn]);
  }

  function renderBranchFooter() {
    var prDisabled = (branchData.commits || []).length === 0;
    var prBtn = el('button', {
      className: 'cmd-btn', 'data-action': 'footer-create-pr', 'aria-label': 'Create PR',
    }, [el('i', { className: 'codicon codicon-git-pull-request' }), el('span', { text: 'Create PR' })]);
    if (prDisabled) prBtn.disabled = true;
    var shareBtn = el('button', {
      className: 'cmd-btn', 'data-action': 'footer-share', 'aria-label': 'Share',
    }, [el('i', { className: 'codicon codicon-export' }), el('span', { text: 'Share' })]);
    var moreBtn = el('button', {
      className: 'cmd-btn aa-more', 'data-action': 'footer-more', 'aria-label': 'More branch actions',
    }, [el('i', { className: 'codicon codicon-ellipsis' })]);
    return el('div', { className: 'branch-footer' }, [prBtn, shareBtn, moreBtn]);
  }

  function renderSectionActions(sectionId) {
    // Codicons mirror the legacy native TreeView action icons declared in
    // package.json contributes.commands — keeping a single source of truth so
    // webview UI matches command palette / keybindings.
    if (sectionId === 'conversations') {
      // Per the mockup, the Conversations header carries no action icons —
      // include/exclude is per-row (the ✕/+ toggle), and Select-All is retired
      // by the included-by-default model.
      return [];
    }
    if (sectionId === 'plans') {
      // Context header keeps only the always-visible Add (+) menu; Select-All is
      // retired (included-by-default + per-row exclude toggle).
      return [
        iconButton('plans-add-menu', 'Add Plan / Note / Snippet', 'add'),
      ];
    }
    if (sectionId === 'changes') {
      // Per the mockup, the Files header carries no action icons. Commit moved
      // to the Working Memory Commit Memory button; Discard is per-row; Select-
      // All is retired by the included-by-default + per-row exclude model.
      return [];
    }
    if (sectionId === 'commits') {
      // Refresh lives on the Committed Memories header (the global toolbar
      // refresh was removed). Available in every mode — including foreign-
      // readonly, where it re-fetches the cross-repo memory cache — so it's
      // built up-front and appended to whatever write-actions the mode allows.
      const commitsRefresh = iconButton('commits-refresh', 'Refresh Committed Memories', 'refresh');
      // Foreign-readonly: hide every write-action on the Memories section
      // (Squash, Push Branch). The user can still open and read individual
      // memories via the row's inline View Memory icon, and refresh.
      if (isViewingForeign()) return [commitsRefresh];
      // In the explicit squash selection mode the confirm bar (rendered at the
      // top of the section body) owns Squash / Cancel / Select-all, so the
      // header stays minimal — just refresh.
      if (squashMode) return [commitsRefresh];
      // Otherwise: a "Squash memories…" entry (only with 2+ memories) that
      // ENTERS the selection mode, Push Branch (with 1+), and Refresh. Squash
      // no longer keys off the host's commitsMode — selection is explicit.
      const commitCount = (branchData.commits || []).length;
      const actions = [];
      if (commitCount >= 2) {
        actions.push(iconButton('commits-enter-squash', 'Squash memories…', 'git-merge', { disabled: isWorkerBlocking() }));
      }
      if (commitCount >= 1) {
        actions.push(iconButton('commits-push-branch', 'Push Branch', 'cloud-upload'));
      }
      actions.push(commitsRefresh);
      return actions;
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
    // Leading glyph is the colored square letter badge (P plan / N note /
    // per-source reference letter), via the shared ctxBadge helper, so the live
    // CONTEXT rows match the committed-memory evidence "Context" rows and the
    // Pinned rows 1:1 (mockup parity). References take their provider from the
    // forwarded referenceHover.source; plan / note ignore it.
    const badgeKind = isReference ? 'reference' : isNote ? 'note' : 'plan';
    const badgeSource = isReference && item.referenceHover ? item.referenceHover.source : '';
    const iconEl = ctxBadge(badgeKind, badgeSource);
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
      iconEl,
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
    const planActions = [];
    // Pin (plan / note / reference) is suppressed only in foreign-readonly
    // mode. Leftmost so it reads as the row's primary "save for later" action
    // ahead of edit/remove. References pin by their mapKey (item.id).
    if (!isViewingForeign()) {
      planActions.push(attachTextTip(
        el('button', {
          type: 'button',
          className: 'iconbtn iconbtn--sm',
          'data-inline': 'pin',
          'data-id': item.id,
          'aria-label': 'Pin',
        }, [el('i', { className: 'codicon codicon-pin' })]),
        'Pin',
      ));
    }
    planActions.push(attachTextTip(
      el('button', {
        type: 'button',
        className: 'iconbtn iconbtn--sm',
        'data-inline': 'edit',
        'data-id': item.id,
        'aria-label': editLabel,
      }, [el('i', { className: 'codicon codicon-edit' })]),
      editLabel,
    ));
    planActions.push(attachTextTip(
      el('button', {
        type: 'button',
        className: 'iconbtn iconbtn--sm',
        'data-inline': 'remove',
        'data-id': item.id,
        'aria-label': 'Remove',
      }, [el('i', { className: 'codicon codicon-trash' })]),
      'Remove',
    ));
    // Strikethrough-exclude toggle joins the hover action cluster (after the
    // trash Remove). Distinct from Remove: exclude just leaves the item out of
    // the next memory (reversible), Remove deletes the note/plan/reference.
    planActions.push(excludeToggle(!!item.isSelected));
    kids.push(el('span', { className: 'inline-actions' }, planActions));
    // Suppress the native title= on every row type that drives the .hover-card
    // popover (plan / note / reference — see the tabContents.branch mouseover
    // handler). A title= would surface a duplicate native tooltip showing the
    // MarkdownString-source plain text, and worse it would trigger on a
    // different timer than the card so the two tooltips would compete.
    return el('div', {
      className: 'tree-node tree-node--hover-actions' + (item.isSelected ? '' : ' excluded'),
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
  // Working Memory rows are "included by default" — leaving an item out of the
  // next memory strikes the row through (reversible) rather than unchecking a
  // visible box (the mockup's strikethrough-exclude model). The include
  // checkbox stays in the DOM as the state-holder for the existing per-kind
  // change handlers; CSS hides the raw box and this ✕/+ button flips it +
  // redispatches a 'change' event (see the [data-exclude-toggle] handler), so
  // the host roundtrip is unchanged. 'selected' true → row is included → the
  // button offers "leave out" (close glyph); false → "add back" (add glyph).
  function excludeToggle(selected) {
    // Rendered as an iconbtn INSIDE the row's hover-revealed .inline-actions
    // cluster (alongside Pin / Edit / Discard) so it lays out in that flex row
    // and never overlaps the absolutely-positioned action overlay. The .excluded
    // strikethrough stays always-visible; the toggle itself is hover-revealed,
    // matching the mockup where view-diff / discard / ✕ appear on hover.
    return attachTextTip(
      el('button', {
        type: 'button',
        className: 'iconbtn iconbtn--sm row-excl',
        'data-exclude-toggle': '1',
        'aria-label': selected ? 'Leave out of this memory' : 'Add back to this memory',
      }, [
        el('i', { className: 'codicon ' + (selected ? 'codicon-close' : 'codicon-add') }),
      ]),
      selected ? 'Leave out of this memory' : 'Add back to this memory',
    );
  }

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
      // Leading glyph IS the conversation-type indicator now: a per-source
      // brand icon (replacing the old generic comment glyph + trailing colored
      // source-dot). Hover shows the provider name via the shared text-tip.
      attachTextTip(
        el('span', { className: 'icon conv-source-icon' }, [convSourceIcon(item.source)]),
        providerLabel(item.source),
      ),
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
    kids.push(el('span', { className: 'msgs', text: String(item.messageCount) + ' msgs' }));
    // No per-conversation token usage is available (ActiveConversationItem
    // carries none), so we render nothing here rather than stamping a static
    // not-reported placeholder on every row — that was noise (and misleading
    // for sources that DO report, like Claude). When real usage is wired,
    // render it conditionally on the figure being present.
    // Pin is a hover-revealed inline affordance (replaces the old right-click
    // Pin entry). A conversation reopens only via source + transcriptPath, so
    // a pin missing either field would persist a row that does nothing on
    // click — gate the button on both, plus the foreign-readonly check the
    // context-menu path used.
    const canPinConv = !isViewingForeign() && !!item.source && !!item.transcriptPath;
    // Hover-revealed action cluster: Pin (when pinnable) + the ✕/+ exclude
    // toggle. Both live in one .inline-actions overlay so they never collide.
    const convActions = [];
    if (canPinConv) {
      convActions.push(attachTextTip(
        el('button', {
          type: 'button',
          className: 'iconbtn iconbtn--sm',
          'data-inline': 'pin',
          'data-id': item.sessionId,
          'aria-label': 'Pin',
        }, [el('i', { className: 'codicon codicon-pin' })]),
        'Pin',
      ));
    }
    convActions.push(excludeToggle(!!item.isSelected));
    kids.push(el('span', { className: 'inline-actions' }, convActions));
    const root = attachTextTip(el('div', {
      // Always hover-actions now: the exclude toggle lives in the overlay, so
      // every conversation row reveals its actions on hover. !isSelected →
      // struck-through via .excluded (always visible).
      className: 'tree-node conversation-row tree-node--hover-actions' + (item.isSelected ? '' : ' excluded'),
      // data-context is PRESENT so the contextmenu listener's
      // closest('.tree-node[data-context]') presence selector matches (an
      // absent attribute would not), letting the handler dismiss the native
      // menu. The value 'conversation' is not claimed by any ctx === ...
      // branch, so no custom menu is shown — Pin moved to the inline button.
      'data-context': 'conversation',
      'data-indent': String(depth),
      'data-session-id': item.sessionId,
      'data-source': item.source,
      'data-transcript-path': item.transcriptPath || '',
    }, kids), displayTitle);
    root.addEventListener('click', function(e) {
      // Guard: clicking the checkbox should not also open the conversation
      // panel. 'data-checkbox="1"' is enough for the delegated click handler
      // at the tabContents.branch level, but this direct listener fires on
      // the same click event, so we need to bail out here too.
      if (e.target && e.target.closest && e.target.closest('[data-checkbox="1"]')) return;
      // Same reasoning for the inline Pin button: its own delegated handler
      // posts branch:pin, so the row must not also open the panel.
      if (e.target && e.target.closest && e.target.closest('.inline-actions')) return;
      // Same for the ✕/+ exclude toggle: its own delegated handler flips the
      // include state, so the row must not also open the panel.
      if (e.target && e.target.closest && e.target.closest('[data-exclude-toggle]')) return;
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

  // Per-source brand glyphs for conversation rows — ported verbatim from the
  // IntelliJ plugin's source-*.svg set (the product's existing agent marks) so
  // the three surfaces stay visually identical. Brand-colored sources (Claude
  // #D97757, Codex #10A37F, Gemini gradient) keep their hex; the otherwise
  // mid-gray neutrals (Cursor / Copilot / OpenCode, which IntelliJ ships a
  // _dark variant for) use currentColor so they follow --vscode-icon-foreground
  // and stay legible on either sidebar theme. copilot-chat reuses the Copilot
  // mark. Each is a fixed first-party constant, not user content.
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
      '<defs><linearGradient id="jm-gem" x1="2" y1="2" x2="14" y2="14" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0" stop-color="#4796E3"/><stop offset="1" stop-color="#9177C7"/></linearGradient></defs>' +
      '<path fill="url(#jm-gem)" d="M8 1c.3 4.2 2.8 6.7 7 7-4.2.3-6.7 2.8-7 7-.3-4.2-2.8-6.7-7-7 4.2-.3 6.7-2.8 7-7Z"/></svg>',
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
  };
  SOURCE_ICON_SVG['copilot-chat'] = SOURCE_ICON_SVG.copilot;

  // Build the leading source glyph for a conversation row. Parses the trusted
  // constant via DOMParser (NOT innerHTML-for-content; CSP also forbids <img>
  // / data-URI backgrounds, so an inline <svg> DOM node is the only path that
  // renders). Unknown sources fall back to the generic comment glyph.
  function convSourceIcon(source) {
    var markup = SOURCE_ICON_SVG[source];
    if (markup) {
      var parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
      var svg = parsed.documentElement;
      if (svg && svg.nodeName !== 'parsererror' && !svg.querySelector('parsererror')) {
        var imported = document.importNode(svg, true);
        imported.setAttribute('class', 'conv-source-svg');
        imported.setAttribute('aria-hidden', 'true');
        return imported;
      }
    }
    return el('i', { className: 'codicon codicon-comment-discussion' });
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
    // Visual parity with the committed-memory evidence "Files" rows
    // (renderMemoryEvidence's fileGroup): NO leading file-type codicon — the
    // filename tint via .gs-{code} plus the trailing status letter carry the
    // git state on their own. The .row-leading slot still holds the (hidden)
    // include checkbox as the state-holder for the exclude toggle; CSS
    // collapses both it and the .twirl so the filename column-aligns with the
    // sub-section title. Functional differences (checkbox, discard) live
    // alongside the shared visual language.
    // dirname-only, stacked under the filename (matching committed-memory
    // "Files" rows / .mef-text) rather than inline on the same line.
    let descDir = '';
    if (item.description) {
      const slash = item.description.lastIndexOf('/');
      descDir = slash > 0 ? item.description.slice(0, slash) : '';
    }
    const kids = [
      el('span', { className: 'twirl' }),
      el('span', { className: 'row-leading' }, [cb]),
      el('span', { className: 'change-text' }, [
        el('span', { className: 'label' + (gs ? ' ' + 'gs-' + gs : ''), text: item.label }),
        descDir ? el('span', { className: 'change-dir', text: descDir }) : null,
      ]),
    ];
    // Trailing layout: [discard (hover-only)] [gs-letter (always)].
    // Order matters — inline-actions is pushed first so the gs-letter
    // sits at the row's right edge; CSS gives inline-actions the
    // margin-left:auto that pushes the whole pair to the right (letter
    // alone gets margin:0 here, overriding the commit-file default).
    // codicon-discard mirrors package.json contributes.commands
    // ["jollimemory.discardFileChanges"], matching the legacy native
    // TreeView affordance 1:1.
    // Hover action cluster: Discard (destructive) + the ✕/+ exclude toggle.
    // Both in one overlay so they don't stack on top of each other. Discard
    // deletes the working-tree change; exclude only leaves the file out of the
    // next memory (reversible) — the file itself stays on disk.
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
        excludeToggle(!!item.isSelected),
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
      className: 'tree-node tree-node--changes' + (item.isSelected ? '' : ' excluded'),
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

  // Builds the SHIPPED group for an expanded committed-memory row: three
  // conditional rows. Row order: 1) PR row (lazily resolved via
  // kb:requestPrStatus), 2) E2E row (gated on e2eCount > 0), 3) Synced row
  // (jolliDocUrl present = synced; absent = Push-to-Jolli action). All three
  // preserve their fallback actions so no affordance is lost.
  //
  // Extracted so the in-place kb:prStatus updater (updatePrStatusInPlace) can
  // rebuild a single group identically without re-rendering the whole tree.
  // data-pr-branch / data-pr-hash / data-e2e-count / data-jolli-doc-url on the
  // group element carry the inputs the updater needs to reconstruct it.
  function buildShippedGroup(hash, memBranch, e2eCount, jolliDocUrl) {
    const shippedRows = [];

    // Row 1 — PR row (lazy).
    if (memBranch) {
      const hasPrStatus = Object.prototype.hasOwnProperty.call(prStatusCache, memBranch);
      if (!hasPrStatus && !prStatusPending[memBranch]) {
        prStatusPending[memBranch] = true;
        vscode.postMessage({ type: 'kb:requestPrStatus', branch: memBranch });
      }
      if (hasPrStatus) {
        const pr = prStatusCache[memBranch];
        if (pr) {
          // PR exists — show number, codicon, and OPEN badge. Clickable via .shipped-link.
          shippedRows.push(el('div', { className: 'shipped-row shipped-row--synced' }, [
            el('i', { className: 'codicon codicon-git-pull-request' }),
            el('a', {
              className: 'shipped-link shipped-label',
              href: pr.url,
              text: 'PR #' + pr.number + ' — open',
            }),
            el('span', { className: 'ship-badge ship-badge--open', text: 'OPEN' }),
          ]));
        } else {
          // No open PR — fall back to the create-PR action so the affordance is not lost.
          shippedRows.push(el('div', {
            className: 'shipped-row shipped-row--action',
            'data-action': 'ship-create-pr',
            'data-hash': hash,
          }, [
            el('i', { className: 'codicon codicon-git-pull-request' }),
            el('span', { className: 'shipped-label', text: 'create PR from this memory' }),
          ]));
        }
      }
      // While the request is in flight (hasPrStatus=false) we intentionally render
      // nothing — no flash, and the create-PR fallback will appear once the null
      // response arrives. This matches the "omit until response" spec option.
    } else {
      // No branch resolvable — always show the create-PR fallback.
      shippedRows.push(el('div', {
        className: 'shipped-row shipped-row--action',
        'data-action': 'ship-create-pr',
        'data-hash': hash,
      }, [
        el('i', { className: 'codicon codicon-git-pull-request' }),
        el('span', { className: 'shipped-label', text: 'create PR from this memory' }),
      ]));
    }

    // Row 2 — E2E test guide (only when e2eCount > 0).
    if (e2eCount && e2eCount > 0) {
      shippedRows.push(el('div', { className: 'shipped-row' }, [
        el('i', { className: 'codicon codicon-check-all' }),
        el('span', {
          className: 'shipped-label',
          text: 'E2E test guide — ' + e2eCount + ' scenarios',
        }),
      ]));
    }

    // Row 3 — Synced / Push-to-Jolli row.
    let syncRow;
    if (jolliDocUrl) {
      syncRow = el('div', { className: 'shipped-row shipped-row--synced' }, [
        el('i', { className: 'codicon codicon-sync' }),
        el('a', {
          className: 'shipped-link shipped-label',
          href: jolliDocUrl,
          text: 'Synced to Jolli — open article',
        }),
        el('span', { className: 'ship-badge ship-badge--synced', text: 'SYNCED' }),
      ]);
    } else {
      syncRow = el('div', {
        className: 'shipped-row shipped-row--action',
        'data-action': 'ship-push-jolli',
        'data-hash': hash,
      }, [
        el('i', { className: 'codicon codicon-cloud-upload' }),
        el('span', { className: 'shipped-label', text: 'Not synced — Push to Jolli' }),
      ]);
    }
    shippedRows.push(syncRow);

    // data-* on the group carry everything updatePrStatusInPlace needs to
    // rebuild this exact group when a trickling kb:prStatus response lands,
    // so a single response touches one group instead of resetting the tree.
    return el('div', {
      className: 'shipped-group',
      'data-pr-branch': memBranch || '',
      'data-pr-hash': hash,
      'data-e2e-count': e2eCount != null ? String(e2eCount) : '',
      'data-jolli-doc-url': jolliDocUrl || '',
    }, shippedRows);
  }

  // In-place updater for a trickling kb:prStatus response. Finds every expanded
  // memory row's shipped-group whose data-pr-branch matches and replaces just
  // that group, so multiple expanded rows don't each trigger a full renderBranch
  // (which collapses scroll/hover/expand state). Mirrors the precise-message
  // pattern used by setFileDivergedFlag for the folder tree.
  function updatePrStatusInPlace(branch) {
    const groups = document.querySelectorAll('.shipped-group[data-pr-branch]');
    let updatedAny = false;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.getAttribute('data-pr-branch') !== branch) continue;
      const hash = g.getAttribute('data-pr-hash') || '';
      const e2eRaw = g.getAttribute('data-e2e-count');
      const e2eCount = e2eRaw ? Number(e2eRaw) : 0;
      const jolliDocUrl = g.getAttribute('data-jolli-doc-url') || '';
      const fresh = buildShippedGroup(hash, branch, e2eCount, jolliDocUrl);
      g.replaceWith(fresh);
      updatedAny = true;
    }
    return updatedAny;
  }

  // In-place updater for a trickling kb:memoryEvidence response. Locates the
  // expanded row for 'hash' (a .tree-node[data-id] on the Branch tab or a
  // .memory-row[data-hash] on the KB Memories tab) and swaps the associated
  // loading placeholder for the rendered evidence — touching one row instead of
  // re-rendering the whole tree. The evidence node is not always the row's
  // immediate sibling (Branch tab inserts subline + shipped-group between), so
  // we scan forward siblings until the next row boundary.
  function updateMemoryEvidenceInPlace(hash, evidence) {
    const selector = '.memory-row[data-hash="' + cssAttrEscape(hash) +
      '"], .tree-node[data-id="' + cssAttrEscape(hash) + '"]';
    const rows = document.querySelectorAll(selector);
    let updatedAny = false;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // Scan forward siblings for this row's evidence/loading node, stopping at
      // the next row boundary so we never reach into an adjacent memory's block.
      let sib = row.nextElementSibling;
      let target = null;
      while (sib) {
        if (sib.classList.contains('memory-row') || sib.classList.contains('tree-node') ||
            sib.classList.contains('tl-group-label')) {
          break;
        }
        if (sib.classList.contains('memory-evidence') || sib.classList.contains('memory-evidence-loading')) {
          target = sib;
          break;
        }
        sib = sib.nextElementSibling;
      }
      if (target) {
        target.replaceWith(renderMemoryEvidence(hash, evidence));
        updatedAny = true;
      }
    }
    return updatedAny;
  }

  // Escapes a value for safe interpolation into a CSS attribute selector. Commit
  // hashes are hex so this is belt-and-suspenders, but keeps the selector robust
  // if a non-hex id ever flows through (and silences a CSS injection smell).
  function cssAttrEscape(v) {
    return String(v).replace(/["\\\\]/g, '\\\\$&');
  }

  function renderCommitRow(item, depth) {
    const hasMem = item.contextValue === 'commitWithMemory';
    // Children are pre-serialized by HistoryTreeProvider when CommitItem
    // collapsibleState !== None, so an empty array means "no files in this
    // commit" (rare but possible — empty merge commits) and we suppress the
    // chevron to avoid a no-op expand.
    // Memory rows are always expandable — their content is the evidence groups,
    // not file children, so item.children may be null yet expansion is valid.
    const expandable = hasMem || !!(item.children && item.children.length > 0);
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
    // Squash-selection mode renders a checkbox in the leading slot. Outside
    // squash mode the slot is dropped entirely (leading = null) for EVERY row —
    // memory rows (M glyph) and code-only / mid-summary commits (the </> glyph)
    // alike. The leading icon column already carried a git-commit dot here, but
    // it was redundant: the M vs </> glyph already conveys "memory" vs "code
    // commit", and a code commit mid-AI-summary read as a memory row that
    // confusingly still showed the dot. el() skips a null child, so the glyph
    // sits flush after the chevron with no empty gap.
    // Foreign-readonly suppresses the checkbox even in multi mode — squash
    // wouldn't be meaningful against a foreign repo's history.
    // Squash checkbox shows only while in the explicit squash selection mode
    // (was: commitsMode === 'multi', which showed boxes permanently).
    const isMulti = squashMode && !isViewingForeign();
    let leading = null;
    if (isMulti) {
      const cb = el('input', {
        type: 'checkbox',
        'data-checkbox': '1',
        'data-checkbox-kind': 'commit',
        'data-id': item.id,
      });
      cb.checked = !!item.isSelected;
      leading = el('span', { className: 'row-leading' }, [cb]);
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
    // Plain commit rows show the short date (item.description) inline — it's
    // their only time cue. Committed-memory rows omit it: the relative date
    // already lives in the .mem-subline below the title, so the MM-DD here is
    // redundant clutter next to it.
    if (item.description && !hasMem) {
      kids.push(el('span', { className: 'desc', text: item.description }));
    }
    if (hasMem) {
      // Inline actions for committed-memory rows are: Pin + Copy Recall + Share
      // for workspace rows; Copy Recall + Share for foreign rows (Pin stays
      // suppressed in foreign mode, matching every other pin gate). The View
      // Memory (eye) action has been moved to the contextmenu — the row subline
      // and expandable memory-details panel replace the need for an inline
      // eye button.
      // isViewingForeign() returns true for both flavors (see its definition:
      // not (repoMatch and branchMatch)). Inline actions are hover-revealed
      // (tree-node--hover-actions on the row) — no always-on icon.
      // The always-visible inline sync chip (the old local/synced pill) was
      // removed: the collapsed row reads cleaner without it, and the sync state
      // is still surfaced in the expanded memory-details SHIPPED group's Synced
      // / Push-to-Jolli row below (gated on the same item.jolliDocUrl field).
      const memActions = [];
      if (!isViewingForeign()) {
        // Workspace rows: Pin sits left (lighter 'save' action ahead of the
        // heavier copy/share actions). Pin is suppressed in foreign mode as
        // before — the cross-repo pin flow is not available.
        memActions.push(attachTextTip(
          el('button', {
            type: 'button',
            className: 'iconbtn',
            'data-inline': 'pin',
            'data-id': item.id,
            'aria-label': 'Pin',
          }, [el('i', { className: 'codicon codicon-pin' })]),
          'Pin',
        ));
      }
      // Copy Recall Prompt is now present on BOTH workspace and foreign rows.
      // It matches the KB-tab timeline view idiom and is the fastest way to
      // pull a memory into the AI context regardless of which repo/branch the
      // user is browsing.
      memActions.push(attachTextTip(
        el('button', {
          type: 'button',
          className: 'iconbtn',
          'data-inline': 'copy-recall',
          'data-id': item.id,
          'aria-label': 'Copy Recall Prompt',
        }, [el('i', { className: 'codicon codicon-copy' })]),
        'Copy Recall Prompt',
      ));
      // Share this memory — opens the memory's summary panel with the
      // commit-kind share modal (see the 'share' case in the inline-action
      // dispatcher below).
      memActions.push(attachTextTip(
        el('button', {
          type: 'button',
          className: 'iconbtn',
          'data-inline': 'share',
          'data-id': item.id,
          'aria-label': 'Share this memory',
        }, [el('i', { className: 'codicon codicon-export' })]),
        'Share this memory',
      ));
      kids.push(el('span', { className: 'inline-actions' }, memActions));
      // The "Show memory details" expander is NOT a child of the title row — it
      // renders on its own line below the row (collapsed state only); see the
      // return paths below. This keeps the title line uncramped and avoids the
      // expander colliding with the hover inline-actions overlay.
    } else {
      kids.push(el('span', { className: 'inline-actions' }));
    }
    // No title= attribute — hover content is rendered by the custom
    // .hover-card popup (renderHoverCard / showHoverCard) so the legacy
    // MarkdownString tooltip experience (codicons + command links) can be
    // reproduced. A title= would surface a duplicate native tooltip.
    // tree-node--hover-actions: the Pin / Copy Recall / Share icons surface
    // only on hover instead of riding the row permanently.
    const row = el('div', {
      className: 'tree-node tree-node--hover-actions',
      'data-indent': String(depth),
      'data-context': item.contextValue || '',
      'data-id': item.id,
    }, kids);
    // Subline shown on committed-memory rows: "2h ago · 269d1089 · 1.4M tokens".
    // Built as an array of segments separated by .mem-sub-sep spans so each
    // piece can be styled independently (monospace hash, muted separators).
    // The token segment is FORWARD-ONLY — only rendered when conversationTokens
    // is a number (undefined = pre-feature memory, segment absent entirely).
    var subline = null;
    if (hasMem) {
      var subSegs = [];
      var sep = function() { return el('span', { className: 'mem-sub-sep', text: '\xB7' }); };
      if (item.hover && item.hover.relativeDate) {
        subSegs.push(el('span', { className: 'mem-sub-date', text: item.hover.relativeDate }));
      }
      if (item.hover && item.hover.shortHash) {
        if (subSegs.length > 0) subSegs.push(sep());
        subSegs.push(el('span', { className: 'mem-sub-hash', text: item.hover.shortHash }));
      }
      if (typeof item.conversationTokens === 'number') {
        if (subSegs.length > 0) subSegs.push(sep());
        subSegs.push(el('span', { className: 'mem-sub-tokens', text: formatTokens(item.conversationTokens) + ' tokens' }));
      }
      subline = el('div', { className: 'mem-subline', 'data-indent': String(depth) }, subSegs);
    }
    if (!expanded) {
      if (hasMem) {
        // Collapsed committed memory: the "Show memory details" expander sits on
        // its own right-aligned line below the row (mockup's .mem-evd), wired to
        // the same data-commit-toggle channel as the chevron.
        const detailsLine = el('div', { className: 'mem-details-line' }, [
          el('span', {
            className: 'commit-memory-details-toggle',
            'data-commit-toggle': item.id,
          }, [
            'Show memory details',
            el('i', { className: 'codicon codicon-chevron-down memory-details-chevron' }),
          ]),
        ]);
        return [row, subline, detailsLine];
      }
      return row;
    }
    if (hasMem) {
      const hash = item.id;
      // Branch is item.hover.branch when present, otherwise fall back to the
      // active branch (selectedBranchName > branchName).
      const memBranch = (item.hover && item.hover.branch) || state.selectedBranchName || state.branchName || '';
      const shippedGroup = buildShippedGroup(hash, memBranch, item.e2eCount, item.jolliDocUrl);

      // Memory evidence groups (Conversations / Context / Files)
      // via the same lazy channel the KB-tab Timeline uses: request once on cache
      // miss, render a Loading placeholder until the response arrives.
      let evidenceNode;
      const cached = evidenceCache[hash];
      if (cached) {
        evidenceNode = renderMemoryEvidence(hash, cached);
      } else {
        if (!evidencePending[hash]) {
          evidencePending[hash] = true;
          vscode.postMessage({ type: 'kb:expandMemory', commitHash: hash });
        }
        evidenceNode = el('div', { className: 'memory-evidence-loading' }, [
          el('span', { className: 'memory-evidence-loading-text', text: 'Loading…' }),
        ]);
      }
      return [row, subline, shippedGroup, evidenceNode];
    }
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
    var bodyCommit = e.target.closest('.cmd-btn[data-action="body-commit"]');
    if (bodyCommit && !bodyCommit.disabled) {
      vscode.postMessage({ type: 'command', command: 'jollimemory.commitAI' });
      e.stopPropagation(); return;
    }
    var bodyReview = e.target.closest('.cmd-btn[data-action="body-review"]');
    if (bodyReview && !bodyReview.disabled) {
      vscode.postMessage({ type: 'command', command: 'jollimemory.reviewNextMemory' });
      e.stopPropagation(); return;
    }
    var footerPr = e.target.closest('.cmd-btn[data-action="footer-create-pr"]');
    if (footerPr && !footerPr.disabled) {
      vscode.postMessage({ type: 'command', command: 'jollimemory.createPrForBranch' });
      e.stopPropagation(); return;
    }
    var footerShare = e.target.closest('.cmd-btn[data-action="footer-share"]');
    if (footerShare) {
      // Opens the newest branch memory's panel with the "Share this branch"
      // modal — the modal lives in the summary panel's webview, not here.
      vscode.postMessage({ type: 'command', command: 'jollimemory.shareBranch' });
      e.stopPropagation(); return;
    }
    var footerMore = e.target.closest('.cmd-btn[data-action="footer-more"]');
    if (footerMore) {
      var r = footerMore.getBoundingClientRect();
      // Open upward: showContextMenu clamps to viewport, so passing the button top
      // lets the menu sit above the footer rather than off-screen below it.
      showContextMenu(r.left, Math.max(0, r.top - 4), [
        { label: 'Recall in Claude Code', command: 'jollimemory.recallBranchInClaudeCode', args: [] },
        { label: 'Copy recall prompt for other tools', command: 'jollimemory.copyBranchRecallPrompt', args: [] },
      ]);
      e.stopPropagation(); return;
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
      // Scoped refresh buttons post a refresh message (not a command): the
      // Current Memory header refreshes the next-memory draft, the Committed
      // Memories header refreshes git history. Handled before cmdMap since
      // they have no command equivalent.
      if (a === 'current-memory-refresh') {
        vscode.postMessage({ type: 'refresh', scope: 'branch-current' });
        e.stopPropagation();
        return;
      }
      if (a === 'commits-refresh') {
        vscode.postMessage({ type: 'refresh', scope: 'branch-commits' });
        e.stopPropagation();
        return;
      }
      // Enter the explicit squash selection mode (reveals per-memory checkboxes
      // + the confirm bar). Clear any host-side commit selection first: squashMode
      // is a webview-local flag, but checkbox toggles round-trip to the host
      // (branch:toggleCommitSelection) and persist as isSelected on the store,
      // so a prior session's checks would surface as stale pre-checked boxes.
      if (a === 'commits-enter-squash') {
        squashMode = true;
        vscode.postMessage({ type: 'branch:deselectAllCommits' });
        renderBranch();
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
        // Unified Current Memory select-all — flips conversations + context +
        // files together (see selectAllCurrentMemoryCommand).
        'current-memory-select-all': 'jollimemory.selectAllCurrentMemory',
      };
      if (cmdMap[a]) {
        vscode.postMessage({ type: 'command', command: cmdMap[a] });
        e.stopPropagation();
        return;
      }
    }

    // "Show N more" / "Show less" toggle on a Current Memory sub-section.
    // Flips the per-section show-all flag and re-renders. Sits before the
    // section-header branch so a click on the row inside .section-body never
    // bubbles into a collapse toggle.
    const showMore = e.target.closest('[data-show-more]');
    if (showMore) {
      const sid = showMore.getAttribute('data-show-more');
      state.subsectionShowAll[sid] = !state.subsectionShowAll[sid];
      persist();
      renderBranch();
      e.stopPropagation();
      return;
    }

    // Current Memory group header: folds/unfolds all three sub-sections at
    // once. Action buttons inside its .section-actions are caught above and
    // return early, so reaching here means the chevron / title / empty header
    // area was clicked. Uses the 'current-memory' collapse key.
    const cmHeader = e.target.closest('[data-cm-header]');
    if (cmHeader) {
      state.sectionsCollapsed['current-memory'] = !state.sectionsCollapsed['current-memory'];
      persist();
      renderBranch();
      vscode.postMessage({ type: 'section:toggle', section: 'current-memory', open: !state.sectionsCollapsed['current-memory'] });
      return;
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
      const sectionEl = header.parentElement;
      // Sub-sections (Conversations / Context / Files) don't collapse on their
      // own — the Working Memory group header owns the collapse. Ignore header
      // clicks there so the now-chevron-less header reads as inert.
      if (sectionEl && sectionEl.classList.contains('subsection')) return;
      const section = sectionEl && sectionEl.getAttribute('data-section');
      if (!section) return;
      state.sectionsCollapsed[section] = !state.sectionsCollapsed[section];
      persist();
      renderBranch();
      vscode.postMessage({ type: 'section:toggle', section: section, open: !state.sectionsCollapsed[section] });
      return;
    }

    // "View on Jolli" anchor in the synced push row. VS Code webviews do not
    // follow <a href> navigation, so we intercept the click and forward it
    // as a vscode.open command (handled by SidebarWebviewProvider handleOutbound
    // case "command" → deps.executeCommand → vscode.commands.executeCommand).
    const syncedLink = e.target.closest('.shipped-link[href]');
    if (syncedLink) {
      const url = syncedLink.getAttribute('href');
      if (url) vscode.postMessage({ type: 'command', command: 'vscode.open', args: [url] });
      e.stopPropagation();
      return;
    }

    // SHIPPED group actions: ship-push-jolli opens the memory's SummaryWebviewPanel
    // so the user can push from there. ship-create-pr opens the same panel where
    // the per-memory create-PR flow lives. Both use jollimemory.viewSummary (or
    // viewMemorySummary in foreign mode) with the commit hash.
    const shipAction = e.target.closest('[data-action="ship-push-jolli"],[data-action="ship-create-pr"]');
    if (shipAction) {
      const shipHash = shipAction.getAttribute('data-hash');
      if (shipHash) {
        const cmd = isViewingForeign() ? 'jollimemory.viewMemorySummary' : 'jollimemory.viewSummary';
        vscode.postMessage({ type: 'command', command: cmd, args: [shipHash] });
      }
      e.stopPropagation();
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
      if (action === 'pin') {
        // Inline Pin (replaces the old right-click Pin). Title comes off the
        // row label, matching the context-menu path it supersedes. Conversation
        // pins additionally carry source + transcriptPath (read from the row's
        // data-* attrs) so the persisted PinEntry can reopen the transcript;
        // plan / note pins are keyed by id alone.
        const labelEl = row ? row.querySelector('.label') : null;
        const pinTitle = labelEl ? (labelEl.textContent || id) : id;
        if (ctx === 'conversation') {
          const convSource = row ? (row.getAttribute('data-source') || '') : '';
          const convTranscriptPath = row ? (row.getAttribute('data-transcript-path') || '') : '';
          vscode.postMessage({ type: 'branch:pin', kind: 'conversation', id: id, title: pinTitle, source: convSource, transcriptPath: convTranscriptPath });
        } else if (ctx === 'commitWithMemory' || ctx === 'commit') {
          vscode.postMessage({ type: 'branch:pin', kind: 'memory', id: id, title: pinTitle });
        } else if (ctx === 'reference') {
          // References are addressed by mapKey, which is the row's data-id.
          vscode.postMessage({ type: 'branch:pin', kind: 'reference', id: id, title: pinTitle });
        } else {
          vscode.postMessage({ type: 'branch:pin', kind: ctx === 'note' ? 'note' : 'plan', id: id, title: pinTitle });
        }
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
        // Copy Recall Prompt — available on both workspace and foreign
        // committed-memory rows. copyRecallPrompt resolves the commit hash
        // through the multi-repo summary index so it works for both.
        vscode.postMessage({ type: 'command', command: 'jollimemory.copyRecallPrompt', args: [id] });
      }
      if (action === 'share') {
        // Opens this memory's panel with the "Share this memory" (commit-kind)
        // modal. Foreign rows resolve no summary in this workspace's storage —
        // the command replies with a pointer to the memory's own repo.
        vscode.postMessage({ type: 'command', command: 'jollimemory.shareMemory', args: [id] });
        e.stopPropagation();
        return;
      }
      if (action === 'unpin') {
        // Unpin inline button on a pinned row — reads kind+id off the button's
        // own data-* attrs (not the parent .tree-node) because the row is
        // .pinned-row, not a standard plan/note/commit row.
        const kind = inline.getAttribute('data-pin-kind');
        const pinId = inline.getAttribute('data-pin-id');
        if (kind && pinId) {
          vscode.postMessage({ type: 'branch:unpin', kind: kind, id: pinId });
        }
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
  // Strikethrough-exclude (Working Memory): the ✕/+ toggle flips the row's
  // hidden include checkbox and redispatches a 'change' event so the existing
  // per-kind change handler below posts the same toggle*Selection message —
  // no new host message type, no new state. The .excluded class + icon/label
  // swap are reflected client-side immediately; the authoritative isSelected
  // comes back on the next render.
  tabContents.branch.addEventListener('click', function(e) {
    const toggle = e.target.closest && e.target.closest('[data-exclude-toggle]');
    if (!toggle) return;
    e.stopPropagation();
    const row = toggle.closest('.tree-node');
    if (!row) return;
    const nowExcluded = row.classList.toggle('excluded');
    const cb = row.querySelector('input[data-checkbox="1"]');
    if (cb) {
      cb.checked = !nowExcluded;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const ic = toggle.querySelector('.codicon');
    if (ic) {
      ic.classList.toggle('codicon-close', !nowExcluded);
      ic.classList.toggle('codicon-add', nowExcluded);
    }
    toggle.setAttribute('aria-label', nowExcluded ? 'Add back to this memory' : 'Leave out of this memory');
  });

  // Squash confirm-bar actions (Select-all / Squash / Cancel). The bar lives in
  // the section body, not in .section-actions, so it needs its own delegate.
  tabContents.branch.addEventListener('click', function(e) {
    const sq = e.target.closest && e.target.closest('[data-action^="squash-"]');
    if (!sq) return;
    e.stopPropagation();
    const act = sq.getAttribute('data-action');
    if (act === 'squash-cancel') {
      squashMode = false;
      // Clear host-side selection on exit so the next squash session starts
      // clean (the checkbox toggles persisted isSelected on the store).
      vscode.postMessage({ type: 'branch:deselectAllCommits' });
      renderBranch();
    } else if (act === 'squash-select-all') {
      // Reuse the existing host toggle that flips every commit's selection.
      vscode.postMessage({ type: 'command', command: 'jollimemory.selectAllCommits' });
    } else if (act === 'squash-confirm') {
      squashMode = false;
      // No deselect here: a deselect message could race ahead of the squash
      // command's async selection read. Re-entering squash re-clears via the
      // commits-enter-squash path, so the stale-selection bug stays covered.
      vscode.postMessage({ type: 'command', command: 'jollimemory.squash' });
      renderBranch();
    }
  });

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
    // Committed-memory rows ('commitWithMemory') replace the hover card with
    // the inline row subline + expandable memory-details panel; suppress the
    // popover so both never show simultaneously. Plain 'commit' rows keep it.
    if (row.getAttribute('data-context') === 'commitWithMemory') return;
    // While the blocking AI summary runs, the HEAD commit being summarized is
    // still a plain 'commit' row (no memory yet) and would otherwise show the
    // commit hover card — but it flips to a hover-less 'commitWithMemory' row
    // the instant the summary lands. Suppress the popover for that one row so
    // it reads consistently before/after, and so no stale/incomplete card
    // shows for a memory that is still being generated. summarizingHash is the
    // workspace HEAD SHORT hash; the row id is the full hash → prefix match.
    const sid = row.getAttribute('data-id');
    if (isWorkerBlocking() && state.summarizingHash && sid && sid.indexOf(state.summarizingHash) === 0) return;
    scheduleShowHoverCard(sid, e.clientX, e.clientY);
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
      // Pin is suppressed in foreign-readonly mode (isViewingForeign).
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
      if (!isViewingForeign()) {
        // Pin uses the commit label (row text) as the title. We read it off
        // the row DOM since commit items don't carry a separate title field.
        const labelEl = row.querySelector('.label');
        const pinTitle = labelEl ? (labelEl.textContent || id) : id;
        items.push({ separator: true });
        items.push({ label: 'Pin', rawMessage: { type: 'branch:pin', kind: 'memory', id: id, title: pinTitle } });
      }
      showContextMenu(e.clientX, e.clientY, items);
      return;
    }
    if (ctx === 'plan' || ctx === 'note') {
      const isNote = ctx === 'note';
      // Pin moved to a hover-revealed inline button on the row; the context
      // menu now only carries Preview / Edit / Remove.
      const planNoteItems = [
        { label: 'Preview',
          rawMessage: isNote
            ? { type: 'branch:openNote', noteId: id }
            : { type: 'branch:openPlan', planId: id } },
        { label: isNote ? 'Edit Note' : 'Edit Plan',
          command: isNote ? 'jollimemory.editNote' : 'jollimemory.editPlan', args: [id] },
        { separator: true },
        { label: 'Remove',
          command: isNote ? 'jollimemory.removeNote' : 'jollimemory.removePlan', args: [id] },
      ];
      showContextMenu(e.clientX, e.clientY, planNoteItems);
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
    // Conversation rows (data-context 'conversation') intentionally show no
    // custom context menu: Pin moved to the hover-revealed inline button on the
    // row. The native menu is still suppressed by the e.preventDefault() above.
  });

  // ---- Boot ----
  switchTab(state.activeTab);
  vscode.postMessage({ type: 'ready' });
  `;
}
