/**
 * NextMemoryScriptBuilder
 *
 * Client-side script for the Next Memory review panel. A standalone JS
 * scope (no bundler inside a webview), so small leaf helpers (el, ctxBadge,
 * providerLabel) are duplicated here rather than imported from
 * SidebarScriptBuilder.ts's template-literal string — there is no runtime
 * module boundary to share across two separate <script> tags.
 *
 * Data model: this panel renders from the exact same branch:conversationsData
 * / branch:plansData / branch:changesData payloads the sidebar's Working
 * Memory card renders from (see SidebarWebviewProvider's broadcast fan-out),
 * so toggling a row here and toggling the same row in the sidebar always
 * agree — there is no second, panel-only selection state.
 *
 * Token-meter segment widths are exact percentages set via a JS property write
 * (el.style.width) — the webview CSP forbids an inline style attribute but allows
 * the property write. Matches the memory-detail bar (SummaryHtmlBuilder
 * buildTokenMeter) and the sidebar's renderTokenBar; all three share this
 * exact-width, no-bucket approach so sub-10% segments never disappear.
 */
import { SOURCE_META } from "./SourceLabels.js";

export function buildNextMemoryScript(): string {
	return `
  const vscode = acquireVsCodeApi();

  // Per-source badge letter, injected from the single ./SourceLabels.ts
  // SOURCE_META table (mirrors SidebarScriptBuilder's own injection) so this
  // standalone panel script never hardcodes a per-source letter switch. A
  // source id missing from this table falls back to its own first letter
  // uppercased at the lookup site below.
  const SOURCE_META = ${JSON.stringify(SOURCE_META)};
  let conversations = [];
  let contextItems = [];
  let files = [];
  let commitBtn = null;
  // Blocking-worker flag (worker:busy). Combined with the included-file count in
  // updateCommitEnabled — the Commit button needs BOTH: not busy AND at least
  // one included file (an empty / all-excluded / all-discarded list has nothing
  // to commit). Mirrors renderCommitReviewBar in SidebarScriptBuilder, whose
  // disabled expression is 'selectedCount === 0 || isWorkerBlocking()'.
  let isBusy = false;
  // Last rendered preview:title payload. The detected ticket arrives on its own
  // preview:ticket message (a reference toggle recomputes the ticket without an
  // LLM title regen), so we merge it into this and re-render the title panel.
  let lastTitleMsg = null;

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'className') n.className = String(v);
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

  function mount(id, node) {
    const host = document.getElementById(id);
    if (!host) return;
    // replaceChildren() clears then inserts — no innerHTML, no injection
    // surface (all content is built via el() with textContent/DOM nodes).
    host.replaceChildren(node);
  }

  // ---- Anchored context menu (ported 1:1 from SidebarScriptBuilder so the
  // Context "+" opens the same in-webview dropdown as the sidebar, not a native
  // QuickPick). Items dispatch { type:'command' } → handleOutbound on the host.
  const ctxMenu = document.getElementById('context-menu');
  function showContextMenu(x, y, items) {
    const kids = items.map(function(i) {
      if (i.separator) return el('div', { className: 'menu-separator' });
      return el('div', { className: 'menu-item', 'data-cmd': i.command }, i.label);
    });
    ctxMenu.replaceChildren.apply(ctxMenu, kids);
    ctxMenu.classList.remove('hidden');
    // Position via CSSStyleDeclaration writes (CSP allows JS-driven style, not
    // inline style attributes); clamp inside the viewport.
    const rect = ctxMenu.getBoundingClientRect();
    ctxMenu.style.left = Math.min(x, Math.max(0, window.innerWidth - rect.width)) + 'px';
    ctxMenu.style.top = Math.min(y, Math.max(0, window.innerHeight - rect.height)) + 'px';
  }
  ctxMenu.addEventListener('click', function(e) {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    vscode.postMessage({ type: 'command', command: item.getAttribute('data-cmd') });
    ctxMenu.classList.add('hidden');
  });
  // Dismiss on any outside click.
  document.addEventListener('click', function(e) {
    if (!ctxMenu.contains(e.target)) ctxMenu.classList.add('hidden');
  });

  // Humanize a raw token count to "1.4M" / "379k" / "999". Mirrors
  // formatTokens in SidebarScriptBuilder (and formatTokensCompact in
  // SummaryUtils.ts) so the panel's meter reads the same as the sidebar's.
  // The 999500 threshold (not 1000000) must match formatTokensCompact: at
  // 999500 the k-branch would round up to "1000k", so promote to "1M" first.
  function formatTokens(n) {
    if (n >= 999500) return (n / 1000000).toFixed(1).replace(/[.]0$/, '') + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
  }

  function providerLabel(source) {
    switch (source) {
      case 'claude': return 'Claude';
      case 'cursor': return 'Cursor';
      case 'codex': return 'Codex';
      case 'gemini': return 'Gemini';
      case 'opencode': return 'OpenCode';
      case 'copilot': return 'Copilot';
      case 'copilot-chat': return 'Copilot Chat';
      default: return source;
    }
  }

  // Per-source brand glyphs — kept in lockstep with SidebarScriptBuilder's
  // SOURCE_ICON_SVG / convSourceIcon so a conversation row here shows the SAME
  // icon the sidebar's Working Memory card shows (not a text badge). Unknown
  // sources fall back to the generic comment-discussion codicon.
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

  // Exclude toggle: hover-revealed control mirroring the sidebar's row-excl
  // pattern. Posts the SAME branch:toggle*Selection message shape the
  // sidebar posts (see SidebarWebviewProvider.handleOutbound) — no new
  // selection state, one host handler for both surfaces.
  function excludeToggle(onToggle, selected) {
    const btn = el('button', {
      type: 'button',
      className: 'row-excl',
      title: selected ? 'Leave out of this memory' : 'Add back to this memory',
    }, [el('i', { className: 'codicon ' + (selected ? 'codicon-close' : 'codicon-add') })]);
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      onToggle(!selected);
    });
    return btn;
  }

  // A secondary/destructive row action button (Discard on files, Remove on
  // context) sharing the exclude toggle's .row-act-btn look. It sits to the
  // LEFT of the ✕/+ toggle in the .row-actions overlay, mirroring the sidebar
  // Working Memory card's [discard/remove] [✕] cluster order. stopPropagation
  // keeps the click off the row-open handler (belt-and-suspenders with the
  // .row-actions guard in attachRowOpen).
  function rowIconButton(icon, title, onClick) {
    const btn = el('button', {
      type: 'button',
      className: 'row-act-btn',
      title: title,
    }, [el('i', { className: 'codicon ' + icon })]);
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  // Wrap a row's hover actions (the ✕/+ toggle plus, for files/context, a
  // destructive discard/remove button) in a .row-actions overlay so they sit
  // absolutely at the row's right edge and never reflow the row content.
  // Mirrors the sidebar Working Memory card's .inline-actions overlay.
  function rowActions(children) {
    return el('span', { className: 'row-actions' }, children);
  }

  // Make a whole row click-to-open, mirroring the sidebar's Working Memory
  // rows: clicking the row opens the item in a new panel/editor, but a click
  // that lands on the hover actions (the ✕/+ toggle) must NOT also open it —
  // the toggle stops propagation, and this guard is the belt-and-suspenders.
  function attachRowOpen(row, open) {
    row.addEventListener('click', function(e) {
      if (e.target && e.target.closest && e.target.closest('.row-actions')) return;
      open();
    });
  }

  function ctxBadge(kind, source) {
    let letter = 'C';
    let badgeKind = kind || '';
    if (kind === 'plan') letter = 'P';
    else if (kind === 'note') letter = 'N';
    else if (kind === 'reference') {
      const s = source || '';
      badgeKind = s || 'reference';
      const meta = SOURCE_META[s];
      letter = s ? (meta ? meta.letter : s.slice(0, 1).toUpperCase()) : 'R';
    }
    return el('span', { className: 'kb-tag mem-ctx-badge mem-ctx-badge--' + badgeKind, text: letter });
  }

  function renderConversationRow(item) {
    const row = el('div', {
      className: 'row' + (item.isSelected ? '' : ' excluded'),
      'data-session-id': item.sessionId,
    }, [
      // Per-source brand icon (matches the sidebar's Working Memory card), with
      // the provider name on the title attribute for accessibility.
      el('span', { className: 'conv-source-icon', title: providerLabel(item.source) }, [convSourceIcon(item.source)]),
      el('div', { className: 'r-main' }, [el('div', { className: 'r-title', text: item.title || '(untitled)' })]),
      // hide-on-hover: the ✕ exclude toggle in the .row-actions overlay sits at
      // the row's right edge over this count, so hide the "N msgs" text on hover
      // to let the ✕ take its place (mirrors the Summary panel's conversation rows).
      el('span', { className: 'r-meta hide-on-hover', text: String(item.messageCount) + ' msgs' }),
    ]);
    row.appendChild(rowActions([excludeToggle(function(selected) {
      vscode.postMessage({
        type: 'branch:toggleConversationSelection',
        source: item.source,
        sessionId: item.sessionId,
        selected: selected,
      });
    }, !!item.isSelected)]));
    // Row click opens the conversation transcript in a new panel — the SAME
    // branch:openConversation message the sidebar's Working Memory row posts.
    // Skip rows with no messages (they'd open an empty panel; the host also
    // rejects an empty transcriptPath/title, so degraded rows simply no-op).
    attachRowOpen(row, function() {
      if (!item.messageCount || item.messageCount <= 0) return;
      vscode.postMessage({
        type: 'branch:openConversation',
        sessionId: item.sessionId,
        source: item.source,
        transcriptPath: item.transcriptPath,
        title: item.title || '(untitled)',
      });
    });
    return row;
  }

  function renderContextRow(item) {
    const row = el('div', { className: 'row' + (item.isSelected ? '' : ' excluded'), 'data-id': item.id });
    row.appendChild(ctxBadge(item.contextValue, item.iconKey));
    row.appendChild(el('div', { className: 'r-main' }, [el('div', { className: 'r-title', text: item.label })]));
    let toggleMsg;
    let removeCmd;
    if (item.contextValue === 'plan') {
      toggleMsg = { type: 'branch:togglePlanSelection', planId: item.id };
      removeCmd = 'jollimemory.removePlan';
    } else if (item.contextValue === 'note') {
      toggleMsg = { type: 'branch:toggleNoteSelection', noteId: item.id };
      removeCmd = 'jollimemory.removeNote';
    } else {
      toggleMsg = { type: 'branch:toggleReferenceSelection', mapKey: item.id };
      // References aren't deleted, they're ignored (dropped from this memory);
      // matches the sidebar's inline trash routing for reference rows.
      removeCmd = 'jollimemory.ignoreReference';
    }
    // Destructive Remove (trash) + the reversible ✕/+ exclude toggle, in that
    // order — the same [remove] [✕] cluster the sidebar's Context rows show.
    // Remove dispatches the SAME jollimemory.remove* / ignoreReference command
    // the sidebar's inline trash button dispatches (its own confirm dialog runs
    // host-side), so there's one delete path, not a panel-specific one.
    row.appendChild(rowActions([
      rowIconButton('codicon-trash', 'Remove', function() {
        vscode.postMessage({ type: 'command', command: removeCmd, args: [item.id] });
      }),
      excludeToggle(function(selected) {
        vscode.postMessage(Object.assign({}, toggleMsg, { selected: selected }));
      }, !!item.isSelected),
    ]));
    // Row click previews the item — plan/note open their markdown preview, a
    // reference opens its rendered-markdown preview. Same branch:open* messages
    // the sidebar's Working Memory Context rows post.
    attachRowOpen(row, function() {
      if (item.contextValue === 'plan') vscode.postMessage({ type: 'branch:openPlan', planId: item.id });
      else if (item.contextValue === 'note') vscode.postMessage({ type: 'branch:openNote', noteId: item.id });
      else vscode.postMessage({ type: 'branch:openReferencePreview', mapKey: item.id });
    });
    return row;
  }

  function renderFileRow(item) {
    const row = el('div', { className: 'row' + (item.isSelected ? '' : ' excluded'), 'data-id': item.id });
    // Filename tinted by git-status (fname-<code>), matching the mockup + the
    // sidebar's memory-evidence file rows; the trailing gs letter carries the
    // same hue in its own monospace column.
    const titleCls = 'r-title' + (item.gitStatus ? ' fname-' + item.gitStatus : '');
    row.appendChild(el('div', { className: 'r-main' }, [el('div', { className: titleCls, text: item.label })]));
    if (item.gitStatus) {
      row.appendChild(el('span', { className: 'gs gs-' + item.gitStatus, text: item.gitStatus }));
    }
    // Destructive Discard (↺) + the reversible ✕/+ exclude toggle, in that
    // order — the same [discard] [✕] cluster the sidebar's file rows show.
    // Discard posts branch:discardFile carrying the raw porcelain columns
    // (indexStatus / worktreeStatus) bridge.discardFiles dispatches on — the
    // collapsed gitStatus letter alone silently breaks untracked / added /
    // renamed discards. filePath is the ABSOLUTE path (item.id); relativePath
    // rides on item.description — same field split the sidebar's row uses.
    row.appendChild(rowActions([
      rowIconButton('codicon-discard', 'Discard Changes', function() {
        vscode.postMessage({
          type: 'branch:discardFile',
          filePath: item.id,
          relativePath: item.description || '',
          statusCode: item.gitStatus || '',
          indexStatus: item.indexStatus || '',
          worktreeStatus: item.worktreeStatus || '',
          originalPath: item.originalPath || '',
        });
      }),
      excludeToggle(function(selected) {
        // FilesStore.selectedPaths is keyed by RELATIVE path, so the toggle must
        // send item.description (relativePath), NOT item.id (absolutePath) — the
        // latter never matches, so the file's isSelected round-trips unchanged
        // and the ✕ click appears to do nothing. Mirrors the sidebar's
        // data-rel-path||data-id fallback in its file checkbox handler.
        vscode.postMessage({
          type: 'branch:toggleFileSelection',
          filePath: item.description || item.id,
          selected: selected,
        });
      }, !!item.isSelected),
    ]));
    // Row click opens the file's working-tree diff — the SAME branch:openChange
    // message the sidebar's Working Memory file row posts. relativePath rides on
    // item.description (as the sidebar's data-rel-path does), statusCode on the
    // git-status letter; both are optional and default to '' when absent.
    attachRowOpen(row, function() {
      vscode.postMessage({
        type: 'branch:openChange',
        filePath: item.id,
        relativePath: item.description || '',
        statusCode: item.gitStatus || '',
      });
    });
    return row;
  }

  function panel(title, count, rows, headerExtra, emptyText) {
    const header = el('div', { className: 'panel-header' }, [
      el('span', { className: 'panel-title', text: title }),
      el('span', { className: 'sec-count', text: String(count) }),
    ]);
    if (headerExtra) header.appendChild(headerExtra);
    const body = rows.length
      ? rows
      : [el('div', { className: 'empty', text: emptyText || 'Nothing here yet.' })];
    return el('div', { className: 'panel' }, [header].concat(body));
  }

  // Context "+" — opens the SAME anchored Add Plan / Note / Snippet dropdown the
  // sidebar's add menu uses (showContextMenu), not a native QuickPick.
  function addMenuButton() {
    const btn = el('button', {
      className: 'panel-add',
      type: 'button',
      title: 'Add plan, note, or snippet',
    }, [el('i', { className: 'codicon codicon-add' })]);
    btn.addEventListener('click', function(e) {
      // stopPropagation so the document dismiss handler doesn't close the menu
      // in the same click that opened it.
      e.stopPropagation();
      const r = btn.getBoundingClientRect();
      showContextMenu(r.left, r.bottom + 2, [
        { label: 'Add Plan', command: 'jollimemory.addPlan' },
        { label: 'Add Markdown Note', command: 'jollimemory.addMarkdownNote' },
        { label: 'Add Text Snippet', command: 'jollimemory.addTextSnippet' },
      ]);
    });
    return btn;
  }

  function renderConversations() {
    mount('conversations-panel', panel('Conversations', conversations.length, conversations.map(renderConversationRow)));
  }
  function renderContext() {
    // Empty copy mirrors SidebarEmptyMessages.plansEmpty (the sidebar's Context
    // section) rather than the generic "Nothing here yet.".
    mount('context-panel', panel('Context', contextItems.length, contextItems.map(renderContextRow), addMenuButton(), 'No plans or notes yet. Click + to add a plan or note.'));
  }
  function renderFiles() {
    mount('files-panel', panel('Files', files.length, files.map(renderFileRow)));
  }

  function renderTitlePanel(msg) {
    if (msg.error) {
      mount('title-panel', el('div', { className: 'panel env-panel-body' }, [
        el('div', { className: 'muted', text: "Couldn't generate a title — " + msg.error }),
        (function() {
          const btn = el('button', { className: 'btn secondary', type: 'button', text: 'Regenerate' });
          btn.addEventListener('click', function() {
            vscode.postMessage({ type: 'command', command: 'jollimemory.regenerateNextMemoryTitle' });
          });
          return btn;
        })(),
      ]));
      return;
    }
    const kids = [
      el('div', { className: 'env-label' }, [el('span', { text: 'Proposed title' }), el('span', { className: 'env-ai', text: 'AI' })]),
      el('div', { className: 'env-title-text', text: msg.title || '' }),
    ];
    // Mockup env-grid: always a "Target commit" line, plus a detected-ticket
    // line only when a matching Context reference is selected.
    const gridKids = [
      el('span', {}, ['Target commit ', el('b', { text: msg.branch ? ('next on ' + msg.branch) : 'next on this branch' })]),
    ];
    if (msg.ticket) {
      gridKids.push(el('span', {}, ['Detected ticket ', el('b', { text: msg.ticket })]));
    }
    kids.push(el('div', { className: 'env-grid' }, gridKids));
    // No Regenerate button in the success state — the mockup's #pane-working has
    // none, and the title auto-regenerates on panel open / selection changes via
    // the host. (The degraded-title state above keeps a Regenerate as its only
    // retry affordance.)
    mount('title-panel', el('div', { className: 'panel env-panel-body' }, kids));
  }

  // Build one bar segment at an EXACT width. The webview CSP does not exempt
  // inline styles, so we can't emit an inline style attribute — but a JS property
  // write (el.style.width) is allowed, so we set it here. Mirrors the
  // memory-detail bar (SummaryHtmlBuilder buildTokenMeter): exact percentages, no
  // 10%-bucket rounding, so sub-10% segments stay visible.
  function seg(cls, pct) {
    const s = el('span', { className: cls });
    s.style.width = pct + '%';
    return s;
  }

  function renderTokenMeter(msg) {
    if (!msg.total && msg.reportingCount === 0) {
      mount('token-meter', el('div', { className: 'muted', text: msg.totalCount > 0 ? 'Token usage not reported for this selection.' : '' }));
      return;
    }
    // Denominator is the breakdown sum (NOT msg.total, which can exceed it when
    // sessions report a scalar count with no per-segment usage), so the three
    // segments fill the bar exactly. wCache absorbs the rounding remainder so
    // the widths always sum to 100. Segment order matches the legend: in·out·cache.
    const segTotal = (msg.input || 0) + (msg.output || 0) + (msg.cached || 0);
    let bar;
    if (segTotal > 0) {
      const wIn = Math.round((msg.input / segTotal) * 100);
      const wOut = Math.round((msg.output / segTotal) * 100);
      const wCache = Math.max(0, 100 - wIn - wOut);
      bar = el('div', { className: 'tmeter-bar' }, [
        seg('seg-in', wIn),
        seg('seg-out', wOut),
        seg('seg-cache', wCache),
      ]);
    } else {
      // Total-only degrade: a total with no breakdown fills the bar with a single
      // input segment rather than fabricating a split we don't have.
      bar = el('div', { className: 'tmeter-bar' }, [seg('seg-in', 100)]);
    }
    mount('token-meter', el('div', { className: 'tmeter' }, [
      el('div', { className: 'tmeter-head' }, [el('span', { className: 'tmeter-total', text: formatTokens(msg.total) + ' tokens' }), el('span', { className: 'tmeter-sub', text: ' · captured by this memory' })]),
      bar,
      el('div', { className: 'tmeter-legend' }, [
        el('span', {}, [el('i', { className: 'lg-dot seg-in' }), formatTokens(msg.input) + ' input']),
        el('span', {}, [el('i', { className: 'lg-dot seg-out' }), formatTokens(msg.output) + ' output']),
        el('span', {}, [el('i', { className: 'lg-dot seg-cache' }), formatTokens(msg.cached) + ' cached']),
      ]),
    ]));
  }

  function renderMetaStrip(msg) {
    const kids = [];
    if (msg.branch) {
      kids.push(el('span', { className: 'meta-branch', text: msg.branch }));
      kids.push(el('span', { className: 'meta-sep', text: '·' }));
    }
    kids.push(el('span', { className: 'local-chip' }, [el('span', { className: 'led' }), 'NOT COMMITTED']));
    if (msg.filesChanged) {
      kids.push(el('span', { className: 'meta-sep', text: '·' }));
      kids.push(el('span', { text: '+' + msg.insertions + ' −' + msg.deletions + ' · ' + msg.filesChanged + ' files' }));
    }
    mount('meta-strip', el('div', { className: 'meta-row' }, kids));
  }

  // Footer: privacy note + full-width Commit Memory button. The button
  // dispatches the SAME jollimemory.commitAI command the sidebar's body
  // Commit Memory button dispatches (SidebarScriptBuilder body-commit) — one
  // commit path, no panel-specific commit logic. It disables while a blocking
  // worker run is in progress (worker:busy), mirroring the sidebar body bar.
  // Enable the Commit button only when there's something to commit AND no
  // blocking worker run. "Something to commit" = at least one INCLUDED file
  // (isSelected) — discarding or excluding every file empties that set, so the
  // button must go disabled. Called from every path that can change either
  // input: initial renderFooter, worker:busy, and branch:changesData.
  function updateCommitEnabled() {
    if (!commitBtn) return;
    const selectedCount = files.filter(function(f) { return !!f.isSelected; }).length;
    commitBtn.disabled = selectedCount === 0 || isBusy;
  }

  function renderFooter() {
    commitBtn = el('button', { className: 'btn', type: 'button' }, [
      el('i', { className: 'codicon codicon-sparkle' }),
      el('span', { text: 'Commit Memory' }),
    ]);
    commitBtn.addEventListener('click', function() {
      vscode.postMessage({ type: 'command', command: 'jollimemory.commitAI' });
    });
    updateCommitEnabled();
    mount('footer', el('div', {}, [
      el('p', { className: 'privacy-note', text: '🔒 Full conversation transcripts stay in your repo — never included in shared exports.' }),
      el('div', { className: 'cc-body' }, [
        'Commits the ', el('b', { text: 'included files' }),
        ' with an AI-written message, then saves a memory linking the included ',
        el('b', { text: 'conversations' }), ' + ', el('b', { text: 'context' }),
        " items. Conversations & context aren't added to your commit.",
      ]),
      el('div', { className: 'cc-note' }, [
        el('i', { className: 'codicon codicon-database' }),
        el('span', { text: 'Local-first: your transcripts stay in your repo; nothing leaves unless you Share or Sync.' }),
      ]),
      commitBtn,
    ]));
  }
  renderFooter();

  window.addEventListener('message', function(event) {
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'worker:busy':
        isBusy = !!msg.busy;
        updateCommitEnabled();
        return;
      case 'branch:conversationsData':
        conversations = msg.items || [];
        renderConversations();
        return;
      case 'branch:plansData':
        contextItems = msg.items || [];
        renderContext();
        return;
      case 'branch:changesData':
        files = msg.items || [];
        renderFiles();
        updateCommitEnabled();
        return;
      case 'preview:title':
        lastTitleMsg = msg;
        renderTitlePanel(msg);
        return;
      case 'preview:ticket':
        // Merge the freshly-computed ticket into the last title and re-render.
        // Before any title has arrived there's nothing to render onto, so drop it
        // (the next preview:title will carry the current ticket inline). Omitting
        // msg.ticket clears the "Detected ticket" line (renderTitlePanel gates on
        // truthiness), so a deselected reference removes it.
        if (lastTitleMsg && !lastTitleMsg.error) {
          lastTitleMsg = Object.assign({}, lastTitleMsg, { ticket: msg.ticket });
          renderTitlePanel(lastTitleMsg);
        }
        return;
      case 'preview:tokenStats':
        renderTokenMeter(msg);
        return;
      case 'preview:diffstat':
        renderMetaStrip(msg);
        return;
      default:
        return;
    }
  });

  vscode.postMessage({ type: 'ready' });
`;
}
