package ai.jolli.jollimemory.toolwindow.sidebar

/**
 * Builds the client-side JavaScript for the JCEF sidebar webview.
 *
 * Port of VS Code's SidebarScriptBuilder.ts. The three mechanical changes
 * from the VS Code original:
 *   1. `acquireVsCodeApi()` → `window.__jbQuery` bridge (injected by JCEFSidebarPanel)
 *   2. `vscode.postMessage(msg)` → `window.__jbQuery(btoa(JSON.stringify(msg)))`
 *   3. `vscode.setState/getState` → `localStorage` keyed by 'jollimemory-sidebar-state'
 *
 * The bridge script (`window.__jbQuery = ...`) is injected by JCEFSidebarPanel
 * before this script runs, so it's available immediately.
 *
 * XSS posture: all renderers build DOM with createElement + textContent +
 * setAttribute via the shared el() helper. We never use innerHTML for content
 * that contains user-supplied strings.
 */
object SidebarScriptBuilder {

	fun buildScript(): String {
		return """
  // ---- Bridge: replaces acquireVsCodeApi() ----
  var vscode = {
    postMessage: function(msg) {
      if (window.__jbQuery) {
        window.__jbQuery(btoa(unescape(encodeURIComponent(JSON.stringify(msg)))));
      }
    },
    setState: function(s) {
      try { localStorage.setItem('jollimemory-sidebar-state', JSON.stringify(s)); } catch(_) {}
    },
    getState: function() {
      try { return JSON.parse(localStorage.getItem('jollimemory-sidebar-state') || 'null'); } catch(_) { return null; }
    }
  };

  // TODO(remove): debug logging plumbing. Kept temporarily for diagnosing
  // webview wiring issues; pair with "debug:log" handler in JCEFSidebarPanel.kt
  // and the jbLog(...) call sites in this file.
  // Debug log helper — also posts to Kotlin so messages land in IntelliJ idea.log.
  function jbLog() {
    try {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        if (a == null) parts.push(String(a));
        else if (typeof a === 'string') parts.push(a);
        else if (a && a.nodeType) parts.push('<' + (a.tagName || a.nodeName) + (a.id ? '#' + a.id : '') + '>');
        else { try { parts.push(JSON.stringify(a)); } catch(_) { parts.push(String(a)); } }
      }
      var msg = parts.join(' ');
      try { console.log(msg); } catch(_) {}
      vscode.postMessage({ type: 'debug:log', message: msg });
    } catch(_) {}
  }

  // Context menu guard: suppress native right-click everywhere
  document.addEventListener('contextmenu', function(e) { e.preventDefault(); });

  // Empty-state strings
  var STRINGS = (function() {
    try {
      var node = document.getElementById('empty-strings');
      return node ? JSON.parse(node.textContent || '{}') : {};
    } catch (_) { return {}; }
  })();

  // ---- DOM helper ----
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
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
      var list = Array.isArray(children) ? children : [children];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c == null) continue;
        if (typeof c === 'string') n.appendChild(document.createTextNode(c));
        else n.appendChild(c);
      }
    }
    return n;
  }
  function mountIn(container, nodes) {
    var arr = Array.isArray(nodes) ? nodes : [nodes];
    container.replaceChildren.apply(container, arr);
  }
  function clear(container) { container.replaceChildren(); }

  // ---- State ----
  var state = Object.assign({
    activeTab: 'branch',
    kbMode: 'folders',
    authenticated: false,
    enabled: true,
    configured: true,
    sectionsCollapsed: {},
    commitsExpanded: {},
    scrollTops: {},
    workerBusy: false
  }, vscode.getState() || {});
  state.workerBusy = false;
  function persist() { vscode.setState(state); }

  // ---- DOM refs ----
  var root = document.getElementById('sidebar-root');
  var loadingPanel = document.getElementById('loading-panel');
  var tabBar = document.getElementById('tab-bar');
  var tabToolbar = document.getElementById('tab-toolbar');
  var tabContents = {
    kb: document.getElementById('tab-content-kb'),
    branch: document.getElementById('tab-content-branch'),
    status: document.getElementById('tab-content-status'),
  };
  var ctxMenu = document.getElementById('context-menu');
  var hoverCardEl = document.getElementById('memory-hover');
  var textTipEl = document.getElementById('text-tip');
  var breadcrumbRepoBtn = document.getElementById('breadcrumb-repo-btn');
  var breadcrumbRepoLabel = document.getElementById('breadcrumb-repo-label');
  var breadcrumbBranchBtn = document.getElementById('breadcrumb-branch-btn');
  var breadcrumbBranchLabel = document.getElementById('breadcrumb-branch-label');
  var breadcrumbMenu = document.getElementById('breadcrumb-menu');
  var disabledBanner = document.getElementById('disabled-banner');
  var statusEntries = document.getElementById('status-entries');
  var kbIconBtn = document.getElementById('kb-icon-btn');
  var settingsIconBtn = document.getElementById('settings-icon-btn');
  var statusIconBtn = document.getElementById('status-icon-btn');

  // ---- Data caches ----
  var branchData = { plans: [], changes: [], commits: [], commitsMode: 'merged' };
  var kbFoldersCache = {};
  var kbMemoriesData = [];
  var kbMemoriesHasMore = false;
  var kbMemoriesQuery = '';
  var kbMemoriesSearchTimer = null;
  var statusData = [];
  var repoChoices = [];
  var branchChoices = [];
  var branchChoicesByRepo = {};
  var branchMemoriesCache = {};
  var hoverDataCache = {};
  var degradedReason = null;

  // ---- Utility functions ----
  function timeAgo(ts) {
    var diff = Date.now() - ts;
    var s = Math.floor(diff / 1000);
    if (s < 60) return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24);
    if (d < 30) return d + 'd ago';
    var mo = Math.floor(d / 30);
    return mo + 'mo ago';
  }

  function branchMemoriesKey(repo, branch) { return repo + '::' + branch; }

  function isViewingForeign() {
    if (state.selectedRepoName && state.selectedRepoName !== state.currentRepoName) return true;
    if (state.selectedBranchName && state.selectedBranchName !== state.branchName) return true;
    return false;
  }

  function isCollapsed(sectionId) {
    return !!state.sectionsCollapsed[sectionId];
  }

  // ---- Icon helpers ----
  function iconButton(action, title, codicon, opts) {
    opts = opts || {};
    var btn = el('button', {
      type: 'button',
      className: 'iconbtn',
      'data-action': action,
      title: title,
      'aria-label': title,
    }, [el('i', { className: 'codicon codicon-' + codicon })]);
    if (opts.disabled) btn.disabled = true;
    return btn;
  }

  function pickIconColorClass(iconColor, iconKey) {
    if (iconColor === 'charts.green' || iconKey === 'lock') return 'icon-green';
    if (iconColor === 'charts.yellow') return 'icon-yellow';
    if (iconColor === 'charts.red') return 'icon-red';
    return '';
  }

  // ---- Tab switching ----
  function switchTab(tab) {
    var current = tabContents[state.activeTab];
    if (current) state.scrollTops[state.activeTab] = current.scrollTop;

    state.activeTab = tab;
    persist();
    for (var k in tabContents) {
      if (tabContents[k]) {
        tabContents[k].classList.toggle('hidden', k !== tab);
      }
    }
    var next = tabContents[tab];
    if (next && state.scrollTops[tab]) {
      next.scrollTop = state.scrollTops[tab];
    }
    renderToolbar();
    if (kbIconBtn) kbIconBtn.classList.toggle('active', tab === 'kb');
    if (statusIconBtn) statusIconBtn.classList.toggle('active', tab === 'status');
  }

  // ---- Toolbar ----
  function renderToolbar() {
    if (!tabToolbar) return;
    var tab = state.activeTab;
    var kids = [];
    if (tab === 'kb') {
      var fActive = state.kbMode === 'folders';
      kids.push(el('button', {
        type: 'button',
        className: 'toolbar-icon-btn' + (fActive ? ' active' : ''),
        'data-kb-mode': 'folders',
        title: 'Tree',
      }, [el('i', { className: 'codicon codicon-list-tree' })]));
      kids.push(el('button', {
        type: 'button',
        className: 'toolbar-icon-btn' + (!fActive ? ' active' : ''),
        'data-kb-mode': 'memories',
        title: 'Timeline',
      }, [el('i', { className: 'codicon codicon-history' })]));
    }
    if (tab === 'branch') {
      var workerLabel = state.workerBusy
        ? el('span', { className: 'worker-busy-indicator', title: 'AI summary in progress' }, [
            el('i', { className: 'codicon codicon-loading codicon-modifier-spin' }),
          ])
        : null;
      if (workerLabel) kids.push(workerLabel);
    }
    if (kids.length > 0) {
      tabToolbar.classList.remove('hidden');
      mountIn(tabToolbar, kids);
    } else {
      tabToolbar.classList.add('hidden');
      clear(tabToolbar);
    }
  }

  // ---- Tab icon buttons ----
  if (kbIconBtn) kbIconBtn.addEventListener('click', function() { switchTab(state.activeTab === 'kb' ? 'branch' : 'kb'); });
  if (statusIconBtn) statusIconBtn.addEventListener('click', function() { switchTab(state.activeTab === 'status' ? 'branch' : 'status'); });
  if (settingsIconBtn) settingsIconBtn.addEventListener('click', function() {
    vscode.postMessage({ type: 'command', command: 'jollimemory.openSettings' });
  });

  // ---- Toolbar mode toggle (KB) ----
  if (tabToolbar) tabToolbar.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-kb-mode]');
    if (!btn) return;
    state.kbMode = btn.getAttribute('data-kb-mode');
    persist();
    renderKB();
    renderToolbar();
  });

  var enableBtn = document.getElementById('enable-btn');

  if (enableBtn) enableBtn.addEventListener('click', function() {
    vscode.postMessage({ type: 'command', command: 'jollimemory.enable' });
  });

  // ---- Breadcrumb ----
  function updateBreadcrumb() {
    var repo = state.selectedRepoName || state.currentRepoName || '(repo)';
    var branch = state.selectedBranchName || state.branchName || '(branch)';
    if (breadcrumbRepoLabel) breadcrumbRepoLabel.textContent = repo;
    if (breadcrumbBranchLabel) breadcrumbBranchLabel.textContent = state.detached ? branch.slice(0, 8) : branch;
    var repoChevron = breadcrumbRepoBtn ? breadcrumbRepoBtn.querySelector('.breadcrumb-seg-chevron') : null;
    var branchChevron = breadcrumbBranchBtn ? breadcrumbBranchBtn.querySelector('.breadcrumb-seg-chevron') : null;
    var repoForBranches = state.selectedRepoName || state.currentRepoName || '';
    var branchList = getEffectiveBranchList(repoForBranches);
    if (repoChevron) repoChevron.classList.toggle('hidden', repoChoices.length < 2);
    if (branchChevron) branchChevron.classList.toggle('hidden', branchList.length < 2);
  }

  function getEffectiveBranchList(repoName) {
    var list = (branchChoicesByRepo[repoName] || branchChoices || []).slice();
    if (repoName === state.currentRepoName && state.branchName) {
      if (list.indexOf(state.branchName) === -1) list.push(state.branchName);
      list.sort();
    }
    return list;
  }

  function hideBreadcrumbMenu() {
    breadcrumbMenu.classList.add('hidden');
    breadcrumbRepoBtn.setAttribute('aria-expanded', 'false');
    breadcrumbBranchBtn.setAttribute('aria-expanded', 'false');
  }

  function pinWorkspaceFirst(items) {
    var idx = -1;
    for (var i = 0; i < items.length; i++) { if (items[i].workspace) { idx = i; break; } }
    if (idx <= 0) return items;
    var head = items[idx];
    return [head].concat(items.slice(0, idx)).concat(items.slice(idx + 1));
  }

  function showBreadcrumbMenu(anchorBtn, items, onPick) {
    if (!items || items.length === 0) return;
    clear(breadcrumbMenu);
    breadcrumbMenu.style.maxHeight = '';

    var SEARCH_THRESHOLD = 8;
    var showSearch = items.length >= SEARCH_THRESHOLD;

    var list = el('div', { className: 'dropdown-list', role: 'none' });
    var rows = [];
    items.forEach(function(it) {
      var isCurrent = !!it.current;
      var isWorkspace = !!it.workspace;
      var row = el('div', {
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
    var emptyMsg = el('div', { className: 'dropdown-empty hidden', text: 'No matches' });
    list.appendChild(emptyMsg);

    var searchInput = null;
    if (showSearch) {
      searchInput = el('input', {
        type: 'text',
        placeholder: 'Filter...',
        'aria-label': 'Filter list',
        autocomplete: 'off',
        spellcheck: 'false',
      });
      searchInput.addEventListener('input', function() {
        var q = String(searchInput.value || '').trim().toLowerCase();
        var visible = 0;
        for (var i = 0; i < rows.length; i++) {
          var match = q === '' || rows[i].label.indexOf(q) !== -1;
          rows[i].el.classList.toggle('hidden', !match);
          if (match) visible++;
        }
        emptyMsg.classList.toggle('hidden', visible !== 0);
      });
      searchInput.addEventListener('click', function(e) { e.stopPropagation(); });
      var searchWrap = el('div', { className: 'dropdown-search' }, [searchInput]);
      breadcrumbMenu.appendChild(searchWrap);
    }
    breadcrumbMenu.appendChild(list);

    var r = anchorBtn.getBoundingClientRect();
    breadcrumbMenu.style.left = String(Math.round(r.left)) + 'px';
    breadcrumbMenu.style.top = String(Math.round(r.bottom + 2)) + 'px';
    var availableBelow = window.innerHeight - r.bottom - 12;
    var cap50vh = Math.round(window.innerHeight * 0.5);
    var cappedMax = Math.max(120, Math.min(cap50vh, availableBelow));
    breadcrumbMenu.style.maxHeight = String(cappedMax) + 'px';
    breadcrumbMenu.classList.remove('hidden');
    anchorBtn.setAttribute('aria-expanded', 'true');
    if (searchInput) searchInput.focus();
  }

  if (breadcrumbRepoBtn) breadcrumbRepoBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    var isOpen = breadcrumbRepoBtn.getAttribute('aria-expanded') === 'true';
    hideBreadcrumbMenu();
    if (isOpen) return;
    var items = repoChoices.map(function(rc) {
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

  if (breadcrumbBranchBtn) breadcrumbBranchBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    var repoForBranches = state.selectedRepoName || state.currentRepoName || '';
    var list = getEffectiveBranchList(repoForBranches);
    if (list.length < 2) return;
    var isOpen = breadcrumbBranchBtn.getAttribute('aria-expanded') === 'true';
    hideBreadcrumbMenu();
    if (isOpen) return;
    var currentBranchInRepo = state.selectedBranchName || state.branchName;
    var isWorkspaceRepo = repoForBranches === state.currentRepoName;
    var items = list.map(function(b) {
      var isWorkspaceBranch = isWorkspaceRepo && b === state.branchName;
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

  // Dismiss dropdowns on outside click
  document.addEventListener('click', function(e) {
    if (breadcrumbMenu && !breadcrumbMenu.classList.contains('hidden')) {
      if (breadcrumbMenu.contains(e.target)) return;
      if (breadcrumbRepoBtn && breadcrumbRepoBtn.contains(e.target)) return;
      if (breadcrumbBranchBtn && breadcrumbBranchBtn.contains(e.target)) return;
      hideBreadcrumbMenu();
    }
    if (ctxMenu && !ctxMenu.classList.contains('hidden') && !ctxMenu.contains(e.target)) {
      ctxMenu.classList.add('hidden');
    }
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && breadcrumbMenu && !breadcrumbMenu.classList.contains('hidden')) {
      hideBreadcrumbMenu();
    }
  });

  // ---- State machines ----
  function applyEnabled(enabled) {
    state.enabled = enabled;
    persist();
    if (disabledBanner) disabledBanner.classList.toggle('hidden', enabled);
  }

  function applyConfigured(configured) {
    state.configured = configured;
    persist();
    if (configured) {
      tabBar.classList.remove('hidden');
      tabContents[state.activeTab].classList.remove('hidden');
    } else {
      tabBar.classList.add('hidden');
      for (var k in tabContents) tabContents[k].classList.add('hidden');
      tabToolbar.classList.add('hidden');
    }
  }

  function applyDegraded(reason) {
    degradedReason = reason;
  }

  // ---- Hover card ----
  var hoverShowTimer = null;
  var hoverHideTimer = null;
  var hoverCurrentId = null;

  function scheduleShowHoverCard(id, x, y) {
    if (hoverCurrentId === id) return;
    cancelHoverShow();
    clearTimeout(hoverHideTimer);
    hoverShowTimer = setTimeout(function() {
      showHoverCard(id, x, y);
    }, 1000);
  }

  function scheduleHideHoverCard() {
    hoverHideTimer = setTimeout(function() {
      dismissHoverCard();
    }, 200);
  }

  function cancelHoverShow() {
    clearTimeout(hoverShowTimer);
    hoverShowTimer = null;
  }

  function dismissHoverCard() {
    clearTimeout(hoverHideTimer);
    hoverHideTimer = null;
    hoverCurrentId = null;
    if (hoverCardEl) hoverCardEl.classList.add('hidden');
  }

  function showHoverCard(id, x, y) {
    var data = hoverDataCache[id];
    if (!data) {
      dismissHoverCard();
      return;
    }
    hoverCurrentId = id;
    var kids = [
      el('div', { className: 'hover-title', text: data.message }),
      el('div', { className: 'hover-meta' }, [
        el('span', { text: data.relativeDate }),
        data.branch ? el('span', { text: ' \u00b7 ' + data.branch }) : null,
        data.commitType ? el('span', { text: ' \u00b7 ' + data.commitType }) : null,
      ]),
    ];
    if (data.statsLine) {
      kids.push(el('div', { className: 'hover-stats', text: data.statsLine }));
    }
    kids.push(el('div', { className: 'hover-hash', text: data.shortHash }));
    mountIn(hoverCardEl, kids);
    hoverCardEl.classList.remove('hidden');
    var rect = hoverCardEl.getBoundingClientRect();
    var maxLeft = window.innerWidth - rect.width - 8;
    var maxTop = window.innerHeight - rect.height - 8;
    hoverCardEl.style.left = Math.min(x + 12, Math.max(0, maxLeft)) + 'px';
    hoverCardEl.style.top = Math.min(y + 12, Math.max(0, maxTop)) + 'px';
  }

  if (hoverCardEl) {
    hoverCardEl.addEventListener('mouseenter', function() {
      clearTimeout(hoverHideTimer);
    });
    hoverCardEl.addEventListener('mouseleave', function() {
      scheduleHideHoverCard();
    });
  }

  // ---- Text tip ----
  var textTipTimer = null;
  function showTextTip(text, x, y) {
    if (!textTipEl) return;
    textTipEl.textContent = text;
    textTipEl.classList.remove('hidden');
    var rect = textTipEl.getBoundingClientRect();
    var maxLeft = window.innerWidth - rect.width - 8;
    textTipEl.style.left = Math.min(x, Math.max(0, maxLeft)) + 'px';
    textTipEl.style.top = (y + 20) + 'px';
    clearTimeout(textTipTimer);
    textTipTimer = setTimeout(function() { textTipEl.classList.add('hidden'); }, 2000);
  }

  // ---- KB tab renderers ----
  function renderKB() {
    if (state.kbMode === 'folders') {
      renderKBFolders();
    } else {
      renderKBMemories();
    }
  }

  function renderKBFolders() {
    var container = tabContents.kb;
    if (!container) return;
    var rootItems = kbFoldersCache['__root__'];
    if (!rootItems || rootItems.length === 0) {
      mountIn(container, [el('p', { className: 'placeholder', text: STRINGS.noMemories || 'No memories yet' })]);
      return;
    }
    var kids = [];
    for (var i = 0; i < rootItems.length; i++) {
      renderFolderNode(rootItems[i], 0, kids);
    }
    mountIn(container, kids);
  }

  function renderFolderNode(node, depth, acc) {
    var isDir = node.isDirectory;
    var expanded = !!kbFoldersCache[node.relPath];
    var iconKey = isDir ? (node.isRepoRoot ? 'repo' : (expanded ? 'folder-opened' : 'folder'))
      : (node.fileKind === 'memory' ? 'markdown' : (node.fileKind === 'plan' ? 'file-text' : 'note'));
    var colorClass = node.fileKind === 'memory' ? 'kb-icon-memory' : '';

    var twirl = isDir
      ? el('i', {
          className: 'codicon ' + (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right') + ' folder-twirl',
          'data-folder-toggle': node.relPath,
        })
      : el('span', { className: 'twirl' });

    var iconEl = el('i', { className: 'codicon codicon-' + iconKey + (colorClass ? ' ' + colorClass : '') });
    var label = node.fileTitle || node.name;

    var kids = [
      twirl,
      el('span', { className: 'icon' + (colorClass ? ' ' + colorClass : '') }, [iconEl]),
      el('span', { className: 'label', text: label }),
    ];

    if (node.fileBranch) {
      kids.push(el('span', { className: 'desc', text: node.fileBranch }));
    }

    var row = el('div', {
      className: 'tree-node' + (node.isCurrentRepo ? ' kb-current-repo' : ''),
      'data-indent': String(depth),
      'data-context': isDir ? 'kbFolder' : ('kb' + (node.fileKind || 'file')),
      'data-id': node.relPath,
      'data-file-key': node.fileKey || '',
      title: node.relPath,
    }, kids);

    acc.push(row);

    if (isDir && expanded) {
      var children = kbFoldersCache[node.relPath] || [];
      for (var c = 0; c < children.length; c++) {
        renderFolderNode(children[c], depth + 1, acc);
      }
    }
  }

  function renderKBMemories() {
    var container = tabContents.kb;
    if (!container) return;

    // Search input — always visible, even when no results
    var searchInput = el('input', {
      type: 'text',
      className: 'kb-memories-search',
      placeholder: 'Search memories...',
      'aria-label': 'Search memories',
      autocomplete: 'off',
      spellcheck: 'false',
      value: kbMemoriesQuery,
    });
    searchInput.addEventListener('input', function() {
      var q = String(searchInput.value || '');
      kbMemoriesQuery = q;
      clearTimeout(kbMemoriesSearchTimer);
      kbMemoriesSearchTimer = setTimeout(function() {
        if (q.trim() === '') {
          vscode.postMessage({ type: 'kb:clearSearch' });
        } else {
          vscode.postMessage({ type: 'kb:search', query: q });
        }
      }, 200);
    });
    var searchWrap = el('div', { className: 'kb-memories-search-wrap' }, [searchInput]);

    if (kbMemoriesData.length === 0) {
      var emptyText = kbMemoriesQuery
        ? 'No memories match "' + kbMemoriesQuery + '"'
        : (STRINGS.noMemories || 'No memories yet');
      mountIn(container, [searchWrap, el('p', { className: 'placeholder', text: emptyText })]);
      return;
    }
    var kids = kbMemoriesData.map(function(m) {
      var iconEl = el('i', { className: 'codicon codicon-markdown kb-icon-memory' });
      var rowKids = [
        el('span', { className: 'twirl' }),
        el('span', { className: 'icon kb-icon-memory' }, [iconEl]),
        el('span', { className: 'label', text: m.title }),
        el('span', { className: 'desc', text: m.timestamp ? timeAgo(m.timestamp) : '' }),
      ];
      if (m.commitHash) {
        rowKids.push(
          el('span', { className: 'inline-actions' }, [
            el('button', {
              type: 'button',
              className: 'iconbtn',
              'data-inline': 'copyRecall',
              'data-id': m.commitHash,
              title: 'Copy Recall Prompt',
              'aria-label': 'Copy Recall Prompt',
            }, [el('i', { className: 'codicon codicon-copy' })]),
          ])
        );
      }
      return el('div', {
        className: 'tree-node',
        'data-indent': '0',
        'data-context': 'kbMemory',
        'data-id': m.id,
        'data-commit-hash': m.commitHash || '',
        title: m.tooltip || '',
      }, rowKids);
    });
    var nodes = [searchWrap].concat(kids);
    if (kbMemoriesHasMore) {
      var loadMoreBtn = el('button', {
        type: 'button',
        className: 'kb-memories-load-more',
        'data-action': 'kb-load-more',
      }, [el('span', { text: 'Load more' })]);
      nodes.push(loadMoreBtn);
    }
    mountIn(container, nodes);
  }

  // KB tab click delegation
  if (tabContents.kb) tabContents.kb.addEventListener('click', function(e) {
    var toggle = e.target.closest('[data-folder-toggle]');
    if (toggle) {
      var path = toggle.getAttribute('data-folder-toggle');
      if (kbFoldersCache[path]) {
        delete kbFoldersCache[path];
        renderKBFolders();
      } else {
        vscode.postMessage({ type: 'kb:expandFolder', path: path });
      }
      e.stopPropagation();
      return;
    }
    var loadMore = e.target.closest('[data-action="kb-load-more"]');
    if (loadMore) {
      vscode.postMessage({ type: 'kb:loadMore' });
      e.stopPropagation();
      return;
    }
    var row = e.target.closest('.tree-node[data-context]');
    if (row) {
      var ctx = row.getAttribute('data-context');
      if (ctx === 'kbMemory') {
        var hash = row.getAttribute('data-commit-hash');
        if (hash) vscode.postMessage({ type: 'kb:openMemory', commitHash: hash });
      } else if (ctx !== 'kbFolder') {
        var fileKey = row.getAttribute('data-file-key');
        if (fileKey) vscode.postMessage({ type: 'kb:openFile', fileKey: fileKey });
      }
    }
  });

  // KB hover
  if (tabContents.kb) {
    tabContents.kb.addEventListener('mouseover', function(e) {
      var row = e.target.closest('.tree-node[data-context="kbMemory"]');
      if (!row) return;
      var id = row.getAttribute('data-id');
      scheduleShowHoverCard(id, e.clientX, e.clientY);
    });
    tabContents.kb.addEventListener('mouseout', function(e) {
      var row = e.target.closest('.tree-node[data-context="kbMemory"]');
      if (!row) return;
      var to = e.relatedTarget;
      if (to && (to === hoverCardEl || hoverCardEl.contains(to) || row.contains(to))) return;
      cancelHoverShow();
      scheduleHideHoverCard();
    });
  }

  // KB context menu
  if (tabContents.kb) tabContents.kb.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    dismissHoverCard();
    var row = e.target.closest('.tree-node[data-context]');
    jbLog('[jolli-debug] kb contextmenu fired; row=', row && row.getAttribute('data-context'), 'target=', e.target);
    if (!row) return;
    var ctx = row.getAttribute('data-context');
    if (ctx === 'kbMemory') {
      var hash = row.getAttribute('data-commit-hash');
      showContextMenu(e.clientX, e.clientY, [
        { label: 'View Memory', command: 'jollimemory.viewMemorySummary', args: [hash] },
        { label: 'Copy Recall Prompt', command: 'jollimemory.copyRecallPrompt', args: [hash] },
        { separator: true },
        { label: 'Copy Commit Hash', command: 'jollimemory.copyCommitHash', args: [hash] },
      ]);
    }
  });

  // ---- Branch tab renderer ----
  function renderBranch() {
    var container = tabContents.branch;
    if (!container) return;
    var foreign = isViewingForeign();

    var sections = [];
    if (!foreign) {
      sections.push({
        id: 'plans',
        title: 'Plans & Notes',
        items: branchData.plans,
        emptyText: STRINGS.noPlans || 'No plans or notes',
      });
      sections.push({
        id: 'changes',
        title: 'Changes',
        items: branchData.changes,
        emptyText: STRINGS.noChanges || 'No changes',
      });
    }

    var commitItems = foreign ? getForeignCommitItems() : branchData.commits;
    sections.push({
      id: 'commits',
      title: 'Memories',
      items: commitItems,
      emptyText: STRINGS.noCommits || 'No commits on this branch',
    });

    var kids = sections.map(function(s) { return renderSection(s); });

    if (root) root.classList.toggle('foreign-readonly', foreign);

    mountIn(container, kids);
  }

  function getForeignCommitItems() {
    var repo = state.selectedRepoName || state.currentRepoName || '';
    var branch = state.selectedBranchName || state.branchName || '';
    if (!repo || !branch) return [];
    var items = branchMemoriesCache[branchMemoriesKey(repo, branch)] || [];
    return items.map(function(m) {
      return {
        id: m.commitHash,
        label: m.title || m.commitHash.slice(0, 8),
        description: m.timestamp ? timeAgo(m.timestamp) : '',
        contextValue: 'commitWithMemory',
        children: null,
        isSelected: false,
      };
    });
  }

  function renderSection(s) {
    var collapsed = isCollapsed(s.id);
    var headerKids = [
      el('span', { className: 'twirl', text: '\u25be' }),
      el('span', { className: 'section-title', text: s.title }),
      el('span', { className: 'section-actions', 'data-section-actions': s.id }, renderSectionActions(s.id)),
    ];
    var rowFn =
      s.id === 'plans'   ? renderPlanRow :
      s.id === 'changes' ? renderChangeRow :
      s.id === 'commits' ? renderCommitRow :
      function(it, depth) { return renderTreeItem(it, depth); };

    var bodyKids = collapsed
      ? null
      : (s.items.length === 0
          ? [el('div', { className: 'empty-state', text: s.emptyText })]
          : s.items.reduce(function(acc, it) {
              var out = rowFn(it, 0);
              if (Array.isArray(out)) {
                for (var i = 0; i < out.length; i++) acc.push(out[i]);
              } else {
                acc.push(out);
              }
              return acc;
            }, []));

    var sectionKids = [
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

  function renderCommitMemoryButton() {
    var selectedCount = branchData.changes.filter(function(c) {
      return !!c.isSelected;
    }).length;
    var disabled = selectedCount === 0 || state.workerBusy;
    var btn = el('button', {
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
    if (sectionId === 'plans') {
      return [
        iconButton('plans-add-menu', 'Add Plan / Note / Snippet', 'add'),
      ];
    }
    if (sectionId === 'changes') {
      var selectedCount = branchData.changes.filter(function(c) {
        return !!c.isSelected;
      }).length;
      var noneSelected = selectedCount === 0;
      return [
        iconButton('changes-select-all', 'Select/Deselect All Files', 'check-all'),
        iconButton('changes-commit-ai',  'Commit (AI message)',       'sparkle',  { disabled: noneSelected || state.workerBusy }),
        iconButton('changes-discard',    'Discard Selected Changes',  'discard',  { disabled: noneSelected }),
      ];
    }
    if (sectionId === 'commits') {
      if (isViewingForeign()) return [];
      var m = branchData.commitsMode;
      if (m === 'multi') {
        var selectedCount2 = branchData.commits.filter(function(c) {
          return !!c.isSelected;
        }).length;
        return [
          iconButton('commits-select-all', 'Select/Deselect All Commits', 'check-all'),
          iconButton('commits-squash',     'Squash Selected',             'git-merge', { disabled: selectedCount2 < 2 }),
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
    var isNote = item.contextValue === 'note';
    var iconKey = item.iconKey || (isNote ? 'note' : 'file-text');
    var colorClass = pickIconColorClass(item.iconColor, iconKey);
    var iconEl = el('i', {
      className: 'codicon codicon-' + iconKey + (colorClass ? ' ' + colorClass : ''),
    });
    var kids = [
      el('span', { className: 'twirl' }),
      el('span', { className: 'icon' }, [iconEl]),
      el('span', { className: 'label', text: item.label }),
    ];
    if (item.description) {
      kids.push(el('span', { className: 'desc', text: item.description }));
    }
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
      ])
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

  function pathToFileCodicon(name) {
    var ix = name.lastIndexOf('.');
    var ext = ix >= 0 ? name.slice(ix + 1).toLowerCase() : '';
    if (ext === 'md' || ext === 'markdown') return 'codicon-markdown';
    if (ext === 'json') return 'codicon-json';
    if (ext === 'yaml' || ext === 'yml') return 'codicon-file-code';
    if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') return 'codicon-file-code';
    if (ext === 'css' || ext === 'scss' || ext === 'less') return 'codicon-file-code';
    if (ext === 'html' || ext === 'htm' || ext === 'xml') return 'codicon-file-code';
    if (ext === 'py' || ext === 'rb' || ext === 'go' || ext === 'rs' || ext === 'java' || ext === 'c' || ext === 'cpp' || ext === 'h') return 'codicon-file-code';
    if (ext === 'kt' || ext === 'kts') return 'codicon-file-code';
    if (ext === 'sh' || ext === 'bash' || ext === 'zsh' || ext === 'fish') return 'codicon-terminal';
    return 'codicon-file';
  }

  function renderChangeRow(item, depth) {
    var gs = item.gitStatus || '';
    var cb = el('input', {
      type: 'checkbox',
      'data-checkbox': '1',
      'data-id': item.id,
    });
    cb.checked = !!item.isSelected;
    var fileCodicon = pathToFileCodicon(item.description || item.label || '');
    var iconEl = el('i', {
      className: 'codicon ' + fileCodicon + (gs ? ' gs-' + gs : ''),
    });
    var kids = [
      el('span', { className: 'twirl' }),
      el('span', { className: 'row-leading' }, [cb]),
      el('span', { className: 'icon' }, [iconEl]),
      el('span', { className: 'label' + (gs ? ' ' + 'gs-' + gs : ''), text: item.label }),
    ];
    if (item.description) {
      var slash = item.description.lastIndexOf('/');
      var descDir = slash > 0 ? item.description.slice(0, slash) : '';
      if (descDir) {
        kids.push(el('span', { className: 'desc', text: descDir }));
      }
    }
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
      ])
    );
    if (gs) {
      kids.push(
        el('span', { className: 'gs-letter gs-' + gs, text: gs })
      );
    }
    return el('div', {
      className: 'tree-node tree-node--changes',
      'data-indent': String(depth),
      'data-context': item.contextValue || '',
      'data-id': item.id,
      'data-rel-path':       item.id || '',
      'data-status-code':    gs,
      'data-index-status':   item.indexStatus    || '',
      'data-worktree-status':item.worktreeStatus || '',
      'data-original-path':  item.originalPath   || '',
      title: item.tooltip || '',
    }, kids);
  }

  function renderCommitRow(item, depth) {
    var hasMem = item.contextValue === 'commitWithMemory';
    var expandable = !!(item.children && item.children.length > 0);
    var expanded = expandable && !!state.commitsExpanded[item.id];
    var twirl = expandable
      ? el('i', {
          className:
            'codicon ' +
            (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right') +
            ' commit-twirl',
          'data-commit-toggle': item.id,
          title: expanded ? 'Collapse' : 'Expand',
        })
      : el('span', { className: 'twirl' });
    var isMulti = branchData.commitsMode === 'multi' && !isViewingForeign();
    var leading;
    if (isMulti) {
      var cb = el('input', {
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
    var memIcon = hasMem
      ? el('span', { className: 'icon kb-icon-memory' }, [
          el('i', { className: 'codicon codicon-markdown' }),
        ])
      : el('span', { className: 'icon' }, [
          el('i', { className: 'codicon codicon-code' }),
        ]);
    var kids = [
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
          el('button', {
            type: 'button',
            className: 'iconbtn',
            'data-inline': 'copyRecall',
            'data-id': item.id,
            title: 'Copy Recall Prompt',
            'aria-label': 'Copy Recall Prompt',
          }, [el('i', { className: 'codicon codicon-copy' })]),
        ])
      );
    } else {
      kids.push(el('span', { className: 'inline-actions' }));
    }
    var row = el('div', {
      className: 'tree-node',
      'data-indent': String(depth),
      'data-context': item.contextValue || '',
      'data-id': item.id,
    }, kids);
    if (!expanded) return row;
    var fileRows = item.children.map(function(c) {
      return renderCommitFileRow(c, depth + 1);
    });
    return [row].concat(fileRows);
  }

  function renderCommitFileRow(item, depth) {
    var cf = item.commitFile || {};
    var gs = item.gitStatus || cf.statusCode || '';
    var fileCodicon = pathToFileCodicon(cf.relativePath || item.label || '');
    var iconEl = el('i', {
      className: 'codicon ' + fileCodicon + (gs ? ' gs-' + gs : ''),
    });
    var kids = [
      el('span', { className: 'twirl' }),
      el('span', { className: 'row-leading' }),
      el('span', { className: 'icon' }, [iconEl]),
      el('span', { className: 'label' + (gs ? ' gs-' + gs : ''), text: item.label }),
    ];
    if (item.description) {
      var slash = item.description.lastIndexOf('/');
      var descDir = slash > 0 ? item.description.slice(0, slash) : '';
      if (descDir) {
        kids.push(el('span', { className: 'desc', text: descDir }));
      }
    }
    if (gs) {
      kids.push(
        el('span', { className: 'gs-letter gs-' + gs, text: gs })
      );
    }
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

  function renderTreeItem(item, depth) {
    var kids = [
      el('span', { className: 'twirl' }),
      el('span', { className: 'icon', text: item.iconKey ? '\u25cf' : '\u00b7' }),
      el('span', { className: 'label', text: item.label }),
    ];
    if (item.description) {
      kids.push(el('span', { className: 'desc', text: item.description }));
    }
    return el('div', {
      className: 'tree-node',
      'data-indent': String(depth),
      'data-context': item.contextValue || '',
      'data-id': item.id,
      title: item.tooltip || '',
    }, kids);
  }

  // ---- Context menu ----
  function showContextMenu(x, y, items) {
    jbLog('[jolli-debug] showContextMenu called; ctxMenu=', ctxMenu, 'items=', items, 'x=', x, 'y=', y);
    var kids = items.map(function(i) {
      if (i.separator) return el('div', { className: 'menu-separator' });
      var attrs = { className: 'menu-item' };
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
    var rect = ctxMenu.getBoundingClientRect();
    var maxLeft = window.innerWidth - rect.width;
    var maxTop = window.innerHeight - rect.height;
    ctxMenu.style.left = Math.min(x, Math.max(0, maxLeft)) + 'px';
    ctxMenu.style.top = Math.min(y, Math.max(0, maxTop)) + 'px';
  }

  ctxMenu.addEventListener('click', function(e) {
    var item = e.target.closest('.menu-item');
    if (!item) return;
    var rawMsg = item.getAttribute('data-raw-msg');
    if (rawMsg) {
      try { vscode.postMessage(JSON.parse(rawMsg)); } catch (_) {}
    } else {
      var cmd = item.getAttribute('data-cmd');
      var args; try { args = JSON.parse(item.getAttribute('data-args') || '[]'); } catch (_) { args = []; }
      vscode.postMessage({ type: 'command', command: cmd, args: args });
    }
    ctxMenu.classList.add('hidden');
  });

  // ---- Branch tab click delegation ----
  tabContents.branch.addEventListener('click', function(e) {
    var commitMemoryBtn = e.target.closest('.commit-memory-btn[data-action="changes-commit-memory"]');
    if (commitMemoryBtn && !commitMemoryBtn.disabled) {
      vscode.postMessage({ type: 'command', command: 'jollimemory.commitAI' });
      e.stopPropagation();
      return;
    }
    var sectionAction = e.target.closest('.section-actions [data-action]');
    if (sectionAction) {
      var a = sectionAction.getAttribute('data-action');
      if (a === 'plans-add-menu') {
        var r = sectionAction.getBoundingClientRect();
        showContextMenu(r.left, r.bottom + 2, [
          { label: 'Add Plan',          command: 'jollimemory.addPlan' },
          { label: 'Add Markdown Note', command: 'jollimemory.addMarkdownNote' },
          { label: 'Add Text Snippet',  command: 'jollimemory.addTextSnippet' },
        ]);
        e.stopPropagation();
        return;
      }
      var cmdMap = {
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

    var commitToggle = e.target.closest('[data-commit-toggle]');
    if (commitToggle) {
      var hash = commitToggle.getAttribute('data-commit-toggle');
      state.commitsExpanded[hash] = !state.commitsExpanded[hash];
      persist();
      renderBranch();
      e.stopPropagation();
      return;
    }

    var header = e.target.closest('.section-header');
    if (header) {
      var section = header.parentElement && header.parentElement.getAttribute('data-section');
      if (!section) return;
      state.sectionsCollapsed[section] = !state.sectionsCollapsed[section];
      persist();
      renderBranch();
      vscode.postMessage({ type: 'section:toggle', section: section, open: !state.sectionsCollapsed[section] });
      return;
    }

    var inline = e.target.closest('[data-inline]');
    if (inline) {
      var action = inline.getAttribute('data-inline');
      var id = inline.getAttribute('data-id');
      var row = inline.closest('.tree-node');
      var ctx = row ? row.getAttribute('data-context') : '';
      if (action === 'edit') {
        var cmd = ctx === 'note' ? 'jollimemory.editNote' : 'jollimemory.editPlan';
        vscode.postMessage({ type: 'command', command: cmd, args: [id] });
      }
      if (action === 'remove') {
        var cmd2 = ctx === 'note' ? 'jollimemory.removeNote' : 'jollimemory.removePlan';
        vscode.postMessage({ type: 'command', command: cmd2, args: [id] });
      }
      if (action === 'discard') {
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
        var cmd3 = isViewingForeign() ? 'jollimemory.viewMemorySummary' : 'jollimemory.viewSummary';
        vscode.postMessage({ type: 'command', command: cmd3, args: [id] });
      }
      if (action === 'copyRecall') {
        vscode.postMessage({ type: 'command', command: 'jollimemory.copyRecallPrompt', args: [id] });
        var btnRect = inline.getBoundingClientRect();
        showTextTip('Recall prompt copied', btnRect.left, btnRect.bottom);
      }
      e.stopPropagation();
      return;
    }

    if (e.target.closest('[data-checkbox="1"]')) {
      return;
    }
    var row2 = e.target.closest('.tree-node[data-context]');
    if (row2) {
      var ctx2 = row2.getAttribute('data-context');
      var id2 = row2.getAttribute('data-id');
      if (ctx2 === 'plan' || ctx2 === 'plansItem') {
        vscode.postMessage({ type: 'branch:openPlan', planId: id2 });
      }
      if (ctx2 === 'note') {
        vscode.postMessage({ type: 'branch:openNote', noteId: id2 });
      }
      if (ctx2 === 'file' || ctx2 === 'fileChange') {
        vscode.postMessage({
          type: 'branch:openChange',
          filePath:     id2,
          relativePath: row2.getAttribute('data-rel-path')    || '',
          statusCode:   row2.getAttribute('data-status-code') || '',
        });
      }
      if (ctx2 === 'commit' || ctx2 === 'commitWithMemory') {
        if (isViewingForeign()) {
          vscode.postMessage({ type: 'kb:openMemory', commitHash: id2 });
        } else {
          vscode.postMessage({ type: 'branch:openCommit', hash: id2 });
        }
      }
      if (ctx2 === 'commitFile') {
        var oldPath = row2.getAttribute('data-old-path');
        var payload = {
          commitHash:   row2.getAttribute('data-commit-hash') || '',
          relativePath: row2.getAttribute('data-rel-path')    || '',
          statusCode:   row2.getAttribute('data-status-code') || '',
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

  // Checkbox toggle
  tabContents.branch.addEventListener('change', function(e) {
    var cb = e.target.closest('[data-checkbox="1"]');
    if (!cb) return;
    e.stopPropagation();
    var kind = cb.getAttribute('data-checkbox-kind') || 'file';
    if (kind === 'commit') {
      vscode.postMessage({
        type: 'branch:toggleCommitSelection',
        hash: cb.getAttribute('data-id'),
        selected: !!cb.checked,
      });
    } else {
      var row = cb.closest('.tree-node');
      var filePath = row ? row.getAttribute('data-rel-path') : cb.getAttribute('data-id');
      vscode.postMessage({
        type: 'branch:toggleFileSelection',
        filePath: filePath,
        selected: !!cb.checked,
      });
    }
  });

  // Branch tab hover card for commit rows
  function isCommitRow(node) {
    if (!node) return false;
    var ctx = node.getAttribute('data-context');
    return ctx === 'commit' || ctx === 'commitWithMemory';
  }
  tabContents.branch.addEventListener('mouseover', function(e) {
    var row = e.target.closest('.tree-node[data-context]');
    if (!isCommitRow(row)) return;
    scheduleShowHoverCard(row.getAttribute('data-id'), e.clientX, e.clientY);
  });
  tabContents.branch.addEventListener('mouseout', function(e) {
    var row = e.target.closest('.tree-node[data-context]');
    if (!isCommitRow(row)) return;
    var to = e.relatedTarget;
    if (to && (to === hoverCardEl || hoverCardEl.contains(to) || row.contains(to))) return;
    cancelHoverShow();
    scheduleHideHoverCard();
  });

  // Branch tab context menu
  tabContents.branch.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    dismissHoverCard();
    var row = e.target.closest('.tree-node[data-context]');
    jbLog('[jolli-debug] branch contextmenu fired; row=', row && row.getAttribute('data-context'), 'target=', e.target);
    if (!row) return;
    var ctx = row.getAttribute('data-context');
    var id = row.getAttribute('data-id');
    if (ctx === 'commit' || ctx === 'commitWithMemory') {
      var items = [];
      if (ctx === 'commitWithMemory') {
        items.push({ label: 'View Memory',         command: 'jollimemory.viewSummary',       args: [id] });
        items.push({ label: 'Copy Recall Prompt',  command: 'jollimemory.copyRecallPrompt',  args: [id] });
        items.push({ separator: true });
      }
      items.push({ label: 'Copy Commit Hash', command: 'jollimemory.copyCommitHash', args: [id] });
      showContextMenu(e.clientX, e.clientY, items);
      return;
    }
    if (ctx === 'plan' || ctx === 'plansItem' || ctx === 'note') {
      var cmd   = ctx === 'note' ? 'jollimemory.editNote' : 'jollimemory.editPlan';
      var label = ctx === 'note' ? 'Edit Note' : 'Edit Plan';
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

  // ---- Status tab renderer ----
  function renderStatus() {
    if (!statusEntries) return;
    if (statusData.length === 0) {
      mountIn(statusEntries, [el('p', { className: 'placeholder', text: 'Loading...' })]);
      return;
    }
    var kids = statusData.map(function(entry) {
      var iconEl = entry.iconKey
        ? el('i', { className: 'codicon codicon-' + entry.iconKey })
        : null;
      return el('div', { className: 'status-entry', title: entry.tooltip || '' }, [
        iconEl ? el('span', { className: 'status-icon' }, [iconEl]) : null,
        el('span', { className: 'status-label', text: entry.label || '' }),
        entry.description ? el('span', { className: 'status-value', text: entry.description }) : null,
      ]);
    });
    mountIn(statusEntries, kids);
  }

  // ---- Message handler ----
  window.addEventListener('jollimemory', function(e) {
    var msg = e.detail;
    if (!msg || !msg.command) return;
    handleMessage(msg);
  });

  function handleMessage(msg) {
    var type = msg.command || msg.type;
    switch (type) {
      case 'init':
        loadingPanel.classList.add('hidden');
        state.enabled = msg.enabled !== false;
        state.authenticated = !!msg.authenticated;
        state.configured = msg.configured !== false;
        state.branchName = msg.branchName || '';
        state.detached = !!msg.detached;
        state.currentRepoName = msg.currentRepoName || '';
        if (msg.selectedRepoName !== undefined) state.selectedRepoName = msg.selectedRepoName;
        if (msg.selectedBranchName !== undefined) state.selectedBranchName = msg.selectedBranchName;
        state.degradedReason = msg.degradedReason || null;
        persist();
        applyEnabled(state.enabled);
        applyConfigured(state.configured);
        applyDegraded(state.degradedReason);
        updateBreadcrumb();
        if (state.configured && state.enabled) {
          switchTab(state.activeTab);
        }
        break;

      case 'status:data':
        statusData = msg.entries || [];
        renderStatus();
        break;

      case 'branch:plansData':
        branchData.plans = msg.items || [];
        renderBranch();
        break;

      case 'branch:changesData':
        branchData.changes = msg.items || [];
        renderBranch();
        break;

      case 'branch:commitsData':
        branchData.commits = msg.items || [];
        branchData.commitsMode = msg.mode || 'merged';
        (msg.items || []).forEach(function(it) {
          if (it.hover) hoverDataCache[it.id] = it.hover;
        });
        renderBranch();
        break;

      case 'kb:foldersData':
        var parent = msg.parentPath || '__root__';
        kbFoldersCache[parent] = msg.items || [];
        renderKBFolders();
        break;

      case 'kb:memoriesData':
        kbMemoriesData = msg.items || [];
        kbMemoriesHasMore = !!msg.hasMore;
        kbMemoriesData.forEach(function(m) {
          if (m.hover) hoverDataCache[m.id] = m.hover;
        });
        renderKBMemories();
        break;

      case 'selection:repos':
        repoChoices = msg.repos || [];
        updateBreadcrumb();
        break;

      case 'selection:branches':
        if (msg.repoName) {
          branchChoicesByRepo = branchChoicesByRepo || {};
          branchChoicesByRepo[msg.repoName] = msg.branches || [];
        }
        branchChoices = msg.branches || [];
        updateBreadcrumb();
        break;

      case 'selection:set':
        if (msg.repoName !== undefined) state.selectedRepoName = msg.repoName;
        if (msg.branchName !== undefined) state.selectedBranchName = msg.branchName;
        persist();
        updateBreadcrumb();
        if (isViewingForeign()) {
          var mk = branchMemoriesKey(
            state.selectedRepoName || state.currentRepoName || '',
            state.selectedBranchName || state.branchName || ''
          );
          if (!branchMemoriesCache[mk]) {
            vscode.postMessage({
              type: 'selection:requestBranchMemories',
              repoName: state.selectedRepoName || state.currentRepoName,
              branchName: state.selectedBranchName || state.branchName,
            });
          }
        }
        renderBranch();
        break;

      case 'selection:branchMemories':
        var key = branchMemoriesKey(msg.repoName || '', msg.branchName || '');
        branchMemoriesCache[key] = msg.items || [];
        if (isViewingForeign()) renderBranch();
        break;

      case 'worker:busy':
        state.workerBusy = !!msg.busy;
        persist();
        renderToolbar();
        renderBranch();
        break;

      case 'enabled:changed':
        applyEnabled(msg.enabled !== false);
        break;

      case 'configured:changed':
        applyConfigured(msg.configured !== false);
        break;

      case 'degraded:changed':
        applyDegraded(msg.reason || null);
        break;

      case 'branch:branchName':
        state.branchName = msg.name || '';
        state.detached = !!msg.detached;
        persist();
        updateBreadcrumb();
        break;

      case 'auth:changed':
        // Re-render status when auth state changes
        break;

      case 'selection:invalidateBranchMemories':
        branchMemoriesCache = {};
        if (isViewingForeign()) renderBranch();
        break;
    }
  }

  // ---- Boot ----
  switchTab(state.activeTab);
  vscode.postMessage({ type: 'ready' });
"""
	}
}
