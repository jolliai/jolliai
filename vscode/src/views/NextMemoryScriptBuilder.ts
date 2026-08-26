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
import { CONTEXT_ROW_KINDS } from "./ContextRowKinds.js";
import { SOURCE_META } from "../../../cli/src/core/references/SourceLabels.js";

export function buildNextMemoryScript(): string {
	return `
  const vscode = acquireVsCodeApi();

  // Per-source badge letter, injected from the single core/references/SourceLabels.ts
  // SOURCE_META table (mirrors SidebarScriptBuilder's own injection) so this
  // standalone panel script never hardcodes a per-source letter switch. A
  // source id missing from this table falls back to its own first letter
  // uppercased at the lookup site below.
  const SOURCE_META = ${JSON.stringify(SOURCE_META)};

  // Per-kind Context-row behaviour, injected from ./ContextRowKinds.ts — the SAME
  // table the sidebar's renderPlanRow resolves against. This panel used to key the
  // badge, the toggle message, the remove command and the open message off four
  // separate ternary chains that all ended in a 'reference' default, so the skills
  // aggregate row (which this panel receives, because branch:plansData is
  // broadcast to it verbatim) rendered as a reference and posted
  // branch:toggleReferenceSelection carrying the __skills__ sentinel as a mapKey.
  const CONTEXT_ROW_KINDS = ${JSON.stringify(CONTEXT_ROW_KINDS)};
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
  // AI relevance overlay (context:relevance): id -> {tier, reason, autoExclude}.
  // Additive display data layered on top of the user's own selection.
  let relevanceById = {};
  // context:analyzing — pre-commit relevance ranking in flight; disables Commit
  // and shows a spinner (like isBusy for the post-commit worker).
  let isAnalyzing = false;
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
      case 'cline': return 'Cline (VS Code)';
      case 'cline-cli': return 'Cline CLI';
      case 'devin': return 'Devin';
      case 'cursor-cli': return 'Cursor CLI';
      case 'antigravity': return 'Antigravity';
      case 'kimi': return 'Kimi Code';
      case 'hermes': return 'Hermes';
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
    cline:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
      '<circle cx="8" cy="2.1" r="1.05" fill="currentColor"/>' +
      '<g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round">' +
      '<line x1="8" y1="3.15" x2="8" y2="4.7"/>' +
      '<path d="M5.1 4.7h5.8a2.9 2.9 0 0 1 2.9 2.9v.5l1 1.7-1 1.7v.5a2.9 2.9 0 0 1-2.9 2.9H5.1a2.9 2.9 0 0 1-2.9-2.9v-.5l-1-1.7 1-1.7v-.5A2.9 2.9 0 0 1 5.1 4.7Z"/></g>' +
      '<g fill="currentColor"><rect x="5.5" y="7.6" width="1.5" height="3.5" rx="0.75"/><rect x="9" y="7.6" width="1.5" height="3.5" rx="0.75"/></g></svg>',
    // Devin's official brand mark — the three-piece cluster from the devin.ai
    // header ('#logo' symbol, viewBox 0 0 30 34); currentColor follows the theme.
    devin:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 30 34">' +
      '<path fill="currentColor" d="M20.556 15c.715-.41 1.6-.41 2.314 0l1.849 1.067a.9.9 0 0 0 .229.087q.096.022.193.026h.01q.01 0 .02-.003a.8.8 0 0 0 .389-.105l.018-.008 3.694-2.133a.85.85 0 0 0 .427-.739V8.93a.85.85 0 0 0-.427-.74l-3.694-2.132a.86.86 0 0 0-.856 0l-3.695 2.132s-.01.008-.015.01a.8.8 0 0 0-.157.121l-.02.023a1 1 0 0 0-.11.144l-.016.026a.86.86 0 0 0-.11.422v2.132a2.312 2.312 0 0 1-3.472 2l-1.848-1.066a.9.9 0 0 0-.23-.087 1 1 0 0 0-.192-.026h-.028a.8.8 0 0 0-.392.103L14.42 12l-3.694 2.132a.85.85 0 0 0-.427.74v4.263a.85.85 0 0 0 .427.74l3.694 2.132.018.008a1 1 0 0 0 .184.075l.03.008a1 1 0 0 0 .178.023q.01.002.02.003h.01a.8.8 0 0 0 .194-.026q.02-.006.04-.01a1 1 0 0 0 .189-.077l1.848-1.066c.715-.41 1.599-.41 2.313 0a2.32 2.32 0 0 1 1.157 2.001v2.132q.001.105.026.2.003.02.01.041a1 1 0 0 0 .074.18l.016.026q.046.077.111.144l.021.023q.07.068.157.12.008.007.015.01l3.695 2.133a.85.85 0 0 0 .854 0l3.694-2.132a.85.85 0 0 0 .427-.74V20.82a.85.85 0 0 0-.427-.74l-3.694-2.132-.018-.008a1 1 0 0 0-.182-.075q-.014-.002-.028-.005a.7.7 0 0 0-.18-.023h-.028a.8.8 0 0 0-.193.026q-.02.006-.038.01a1 1 0 0 0-.188.077l-1.849 1.066c-.712.411-1.599.411-2.313 0a2.32 2.32 0 0 1-1.157-2.001c0-.822.442-1.59 1.157-2.001l-.003-.01zM.428 13.936l3.694 2.132a.85.85 0 0 0 .855 0l3.694-2.133s.01-.008.015-.01a.8.8 0 0 0 .157-.12l.02-.023q.062-.067.112-.144.008-.01.015-.026a.86.86 0 0 0 .111-.42v-2.133a2.312 2.312 0 0 1 3.471-2l1.849 1.066a.9.9 0 0 0 .229.087q.093.022.193.026h.01q.01-.002.02-.003a.8.8 0 0 0 .392-.106l.018-.008 3.694-2.133a.85.85 0 0 0 .427-.739V2.986a.85.85 0 0 0-.427-.74L15.283.114a.86.86 0 0 0-.856 0l-3.695 2.132s-.01.008-.015.01a.8.8 0 0 0-.157.121l-.02.023a1 1 0 0 0-.112.144q-.008.01-.015.026a.86.86 0 0 0-.11.422v2.132A2.315 2.315 0 0 1 6.83 7.125L4.983 6.06a.9.9 0 0 0-.23-.087 1 1 0 0 0-.193-.026h-.028a.8.8 0 0 0-.39.103l-.019.008L.43 8.189a.85.85 0 0 0-.427.74v4.263a.85.85 0 0 0 .427.74v.005zM18.972 26.008l-3.694-2.133-.018-.008a1 1 0 0 0-.183-.074l-.031-.008a1 1 0 0 0-.18-.023h-.028a.8.8 0 0 0-.193.026q-.02.006-.04.01a1 1 0 0 0-.187.077l-1.849 1.067a2.314 2.314 0 0 1-3.468-2.001v-2.133a.8.8 0 0 0-.036-.242 1 1 0 0 0-.075-.18q-.008-.01-.015-.026a.8.8 0 0 0-.111-.144l-.02-.023a1 1 0 0 0-.157-.12q-.008-.007-.015-.01L4.978 17.93a.86.86 0 0 0-.857 0L.427 20.063a.85.85 0 0 0-.427.739v4.263a.85.85 0 0 0 .427.74l3.694 2.132.018.008a1 1 0 0 0 .18.074l.031.008a1 1 0 0 0 .177.023l.021.002h.01q.098-.001.19-.026.021-.006.042-.01a1 1 0 0 0 .188-.077l1.848-1.066c.715-.41 1.599-.41 2.314 0a2.32 2.32 0 0 1 1.157 2.001v2.133q.001.102.026.2.004.02.01.041a1 1 0 0 0 .075.18q.008.01.015.026.046.077.111.144l.02.023q.07.068.157.12.007.007.016.01l3.694 2.133a.85.85 0 0 0 .855 0l3.694-2.132a.85.85 0 0 0 .427-.74V26.75a.85.85 0 0 0-.427-.74z"/></svg>',
    antigravity:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">' +
      '<defs><linearGradient id="jm-agy" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#EA4335"/><stop offset="0.13" stop-color="#F2942C"/>' +
      '<stop offset="0.3" stop-color="#A6C24E"/><stop offset="0.47" stop-color="#4EAE83"/>' +
      '<stop offset="0.65" stop-color="#3597CE"/><stop offset="1" stop-color="#3286FF"/></linearGradient></defs>' +
      '<path fill="url(#jm-agy)" d="M1.33 22.06 Q1.44 20.51 2.1 19.73 Q2.77 18.96 3.21 18.19 Q3.65 17.42 4.04 16.64 ' +
      'Q4.43 15.87 4.71 15.09 Q4.98 14.32 5.2 13.54 Q5.42 12.77 5.64 12 Q5.86 11.23 6.08 10.46 Q6.31 9.68 6.53 8.91 ' +
      'Q6.75 8.13 7.03 7.36 Q7.3 6.58 7.57 5.81 Q7.85 5.04 8.35 4.27 Q8.85 3.49 9.84 2.71 Q10.84 1.94 11.06 1.89 ' +
      'Q11.28 1.83 12.05 1.83 Q12.83 1.83 13.99 2.6 Q15.15 3.38 15.65 4.15 Q16.15 4.92 16.48 5.7 Q16.81 6.47 17.03 7.24 ' +
      'Q17.25 8.02 17.47 8.79 Q17.69 9.57 17.91 10.34 Q18.14 11.12 18.36 11.89 Q18.58 12.66 18.85 13.44 ' +
      'Q19.13 14.21 19.41 14.98 Q19.68 15.76 20.02 16.54 Q20.35 17.31 20.79 18.08 Q21.23 18.85 21.84 19.62 ' +
      'Q22.45 20.4 22.62 21.17 Q22.78 21.95 22.67 22 Q22.56 22.06 22.12 22.06 Q21.67 22.06 20.57 21.29 ' +
      'Q19.46 20.51 18.8 19.73 Q18.14 18.96 17.64 18.19 Q17.14 17.42 16.7 16.64 Q16.26 15.87 15.71 15.09 ' +
      'Q15.15 14.32 13.82 13.54 Q12.5 12.77 12 12.77 Q11.5 12.77 10.18 13.54 Q8.85 14.32 8.35 15.09 Q7.85 15.87 7.36 16.64 ' +
      'Q6.86 17.42 6.36 18.19 Q5.86 18.96 5.2 19.73 Q4.54 20.51 3.44 21.29 Q2.33 22.06 1.83 22.06 Z"/></svg>',
    // Hermes Agent's official brand mark — the "nous-girl" avatar (a black-
    // and-white illustration of a girl with heavy dark hair and headphones,
    // looking to the side). Sourced from Hermes' own icon set (k-icon-hermes.
    // svg) and normalised to VS Code icon convention: the original 1024-unit
    // viewBox is expanded to -100..1124 (~10% padding on each side) so the
    // artwork's visual weight at 16px matches Cursor/Copilot/Cline, and
    // every fill becomes currentColor so it follows --vscode-icon-foreground
    // on either sidebar theme.
    hermes:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="-100 -100 1224 1224">' +
      '<g fill="currentColor">' +
      '<path d="M232.885477 590.794626c8.573257 0 20.28151 5.246321 39.219449 17.722329 8.573257 5.630198 15.227127 8.957134 20.34549 10.044785 12.667946 2.75112 12.15611 4.03071-7.229687 16.18682-27.895074 17.274472-47.664747 18.682022-55.022392 3.454895-2.175304-4.670505-2.75112-15.227127-0.767755-18.234165 0.831734-1.279591-0.127959-3.710813-2.943058-7.741523-4.670505-6.653871-5.758157-15.355086-2.559181-19.193858 1.215611-1.535509 4.09469-2.239283 8.957134-2.239283zM346.577095 400.263596c18.93794-4.478567 43.122201 3.262956 67.62636 21.689059 5.886116 4.542546 12.987844 9.213052 15.419066 10.492643 2.367242 1.279591 4.478567 3.198976 4.478567 4.158669a27.06334 27.06334 0 0 1-5.43826 8.701215c-18.362124 22.904671-38.131798 33.71721-62.1881 33.717211-13.49968 0.127959-18.106206-0.831734-34.357006-7.485605-10.108765-4.03071-11.196417-4.798464-9.277031-6.461932 1.791427-1.535509 3.966731-1.279591 13.56366 1.919386 27.575176 8.957134 50.543826 6.397953 66.410748-7.741523 6.78183-5.758157 12.987844-15.866923 10.940499-17.722329a412.987844 412.987844 0 0 0-20.601407-14.203455c-1.087652-0.639795-1.535509 2.047345-1.663468 8.573257-0.127959 19.321817-12.15611 31.349968-28.726807 28.790787-11.516315-1.983365-20.601408-14.267434-20.601408-27.959053a29.302623 29.302623 0 0 1 2.623161-12.859885c4.862444-9.277031-1.535509-7.293666-13.243762 4.03071l-8.701216 8.1254-9.660909-9.660909 2.75112-4.990403c4.670505-8.829175 18.362124-18.234165 30.710173-21.113243z"/>' +
      '<path d="M478.822777 0.711452c18.298145-1.471529 53.742802-0.511836 72.168906 2.111325 101.40755 14.203455 186.692258 68.777991 237.8119 152.271273 15.035189 24.568138 24.440179 44.913628 40.626999 87.651951 16.634677 44.145873 23.480486 71.017274 34.420985 133.461293 5.950096 34.676903 8.317338 45.873321 20.729367 100.575815 10.620601 46.449136 22.392834 93.154191 35.892514 141.650672l12.028151 43.953935 6.397953 23.800384 7.677543 4.222649c4.478567 2.559181 13.56366 10.108765 21.177224 17.850287 11.196417 11.516315 14.395393 15.611004 19.641714 26.551504 9.532949 19.193858 12.15611 30.774152 12.795906 57.069738 1.023672 33.013436-3.390915 54.574536-16.506718 80.166346-16.314779 31.349968-41.778631 54.830454-81.253999 74.728087-25.207933 12.603967-28.534869 19.193858-26.679463 54.190659l1.279591 22.392835h-15.291107l-1.919386-8.061421c-4.158669-17.786308-13.435701-35.18874-29.814459-56.238003-40.49904-51.695457-67.050544-67.434421-114.011516-67.434421-29.302623 0-52.527191 7.741523-75.623801 25.143953-12.795905 9.660909-47.536788 45.361484-63.403711 65.131159a148.560461 148.560461 0 0 0-17.274472 27.319257l-6.909789 14.075496H472.488804l8.701215-9.916826c4.862444-5.502239 15.994882-17.658349 24.760077-27.191299 8.829175-9.724888 25.143954-28.34293 36.212412-41.586692 22.200896-26.551504 30.070377-34.996801 44.59373-48.112604l9.660909-8.829175-20.729367 10.620601c-36.46833 18.809981-130.134357 73.256558-143.698017 83.749201a278.630838 278.630838 0 0 0-33.141394 33.397312l-6.909789 8.061421-212.284069-0.831734 9.40499-6.206014c22.392834-14.715291 42.866283-40.49904 53.103007-66.922585 5.118362-13.243762 10.87652-35.380678 10.87652-41.458733-0.127959-3.966731-0.255918-3.710813-4.414588 3.838771-12.028151 22.008957-32.757518 35.18874-59.117082 37.492003-35.252719 3.071017-62.1881-16.314779-66.794626-48.240563l-1.471529-10.236724-11.388356-3.007038a144.721689 144.721689 0 0 1-47.664747-24.056302 111.132438 111.132438 0 0 1-35.18874-53.99872c-3.646833-11.644274-3.902751-14.267434-3.902751-36.660269 0-21.817019 0.383877-25.591811 3.710813-38.003839 5.822137-21.5611 17.018554-42.674344 27.639155-52.079334 4.606526-4.158669 5.118362-2.75112 1.791427 4.03071-12.284069 24.824056-7.293666 61.740243 10.556622 78.694817 8.381318 8.06142 16.826615 11.516315 27.895073 11.516315 12.987844 0 21.241203-3.838772 30.838132-14.395393 16.826615-18.362124 21.944978-39.091491 31.989763-131.413948 4.862444-43.506078 14.011516-140.626999 14.011517-148.560461 0-4.798464-0.447857-5.502239-3.774792-6.333973-31.925784-6.909789-52.463212-17.850288-71.65707-38.131797C73.320537 414.59501 63.659629 387.083813 63.659629 346.136916c0-68.522073 31.797825-144.65771 82.213692-197.440819C180.422265 112.803583 246.129239 69.105566 291.106846 52.470889c80.422265-29.814459 162.380038-8.1254 221.241203 58.605247 32.757518 37.044146 56.110045 87.651951 70.761356 153.550863 3.454894 15.611004 4.862444 19.065899 7.869482 21.68906 1.919386 1.791427 4.734485 3.198976 6.078055 3.198976 3.838772 0 5.694178 2.879079 5.694178 8.957134 0 5.118362-0.831734 6.461932-8.445298 13.819578-21.433141 21.113244-35.18874 49.904031-42.162508 88.163787-3.198976 17.274472-3.198976 52.399232 0 70.057582 9.277031 52.079335 34.293026 89.699296 66.346769 99.808061a55.662188 55.662188 0 0 0 39.795266-2.815099c24.568138-12.15611 45.297505-42.546385 55.022393-80.934101 7.677543-30.582214 8.1254-62.763916 1.215611-96.481126-9.596929-47.152911-35.18874-82.533589-66.858606-92.322457-3.071017-0.959693-6.397953-2.559181-7.229686-3.838771-2.047345-2.559181-2.303263-9.980806-0.511836-9.980807 0.639795 0 3.198976-1.663468 5.502239-3.582853 3.710813-3.071017 4.286628-4.542546 4.286628-10.108765 0-6.397953-8.701216-39.091491-16.18682-60.90851-28.150992-82.40563-78.31094-147.152911-134.868842-174.024312C470.24952 22.016635 445.425464 16.898273 410.87652 17.602047c-12.987844 0.255918-22.840691 0-22.008958-0.447856 0.959693-0.511836 11.068458-3.198976 22.392835-5.758158 21.5611-5.118362 43.825976-8.701216 67.56238-10.684581z m-258.477288 334.996801c-1.727447-3.071017-3.071017-4.478567-3.071017-3.326935-0.127959 4.158669 12.284069 32.501599 19.833653 45.041587 4.158669 7.037748 7.677543 13.115803 7.677544 13.563659 0 0.383877-1.151631 0.831734-2.559181 0.831734-3.262956 0-34.612924 7.677543-35.764556 8.829175-0.511836 0.575816 1.40755 2.75112 4.158669 5.118362 2.75112 2.367242 5.118362 4.670505 5.118363 5.37428 0 0.575816-5.118362 0.703775-11.516315 0.447857-9.596929-0.703775-12.539987-0.319898-17.914268 2.047345-3.582853 1.663468-6.909789 3.710813-7.357645 4.862444-0.831734 2.047345 8.317338 23.03263 10.108765 23.032629a19.513756 19.513756 0 0 0 5.246321-2.431222c10.492642-6.525912 23.224568-4.478567 34.420985 5.37428 10.492642 9.213052 11.516315 19.193858 3.582854 35.18874-9.40499 19.129878-15.483045 24.248241-25.71977 21.305182-3.454894-0.959693-6.078055-2.559181-6.078055-3.582853 0-1.087652-0.959693-1.919386-2.047345-1.919386s-2.047345 0.383877-2.111324 0.959693c0 0.383877-1.215611 12.987844-2.879079 27.895074-4.990403 46.577095-3.007038 63.595649 11.900192 99.93602 11.324376 27.511196 46.129239 91.490723 55.534229 101.983365 7.485605 8.317338 19.193858 13.691619 31.989764 14.715292 6.269994 0.447857 19.705694-0.639795 42.354446-3.646833 57.773512-7.485605 54.190659-7.677543 66.090851 1.087651 11.004479 7.997441 29.430582 32.181702 41.266795 54.190659 2.623161 4.926424 5.118362 8.957134 5.566218 8.957134 0.255918 0 6.461932-5.37428 13.56366-12.15611l12.795905-12.028151-1.599488-7.997441c-4.158669-21.113244-3.198976-55.598209 2.75112-96.225208 1.471529-10.492642 8.573257-51.183621 15.738963-90.46705 7.037748-39.283429 13.947537-79.78247 15.227128-89.955214 2.431222-21.113244 4.414587-80.998081 2.879078-92.770314l-0.959692-7.869482-12.731926-2.175304a449.904031 449.904031 0 0 0-97.696737-5.246321l-15.866923 1.215611-5.822137-6.525912c-5.694178-6.333973-5.950096-6.461932-11.772233-5.502239-19.833653 3.326935-29.814459 7.613564-52.079334 22.776712a142.930262 142.930262 0 0 1-16.634677 10.364683c-2.431222 0-2.879079-4.414587-0.639795-8.509277 1.279591-2.367242 5.118362-7.357646 8.445297-11.068458 3.454894-3.582853 5.758157-6.653871 5.118362-6.653871-0.703775 0-10.556622 1.663468-21.753039 3.710813-18.490083 3.326935-20.857326 3.454894-23.864363 1.663467-6.78183-4.158669-23.672425-21.817019-31.669866-33.397313a320.857326 320.857326 0 0 1-11.324376-17.018554zM205.886116 449.783749c-4.734485 0-8.189379 6.653871-8.189379 15.738964 0.127959 22.96865 10.108765 35.956494 20.857326 27.255278l3.326935-2.623161-3.582853-2.943058c-5.950096-4.478567-9.980806-15.738964-9.980807-27.511196 0-8.509277-0.383877-9.916827-2.431222-9.916827z m108.317339-200.383877c-1.087652 0 0.639795 13.819578 3.710812 28.790787 5.566219 26.615483 15.994882 58.15739 26.103647 78.886756l5.118362 10.492643 7.677544-0.575816a26.935381 26.935381 0 0 0 8.125399-1.087652c0.383877-0.255918-0.831734-3.198976-2.62316-6.397953-24.31222-43.058221-34.293026-65.898912-44.401792-100.127959a37.555982 37.555982 0 0 0-3.710812-9.980806z"/>' +
      '<path d="M630.582214 424.959693c15.227127-3.198976 37.108125 1.279591 45.617402 9.277031 4.670505 4.478567 4.798464 6.461932 0.831734 9.277032-3.774792 2.559181-8.893154 2.75112-21.5611 0.511836a67.242482 67.242482 0 0 0-23.480487 0.319897c-12.028151 1.471529-14.715291 1.471529-19.193858-0.191938-4.03071-1.471529-5.310301-2.75112-5.3103-5.37428 0-2.495202 1.791427-4.158669 8.573256-7.869482a61.932182 61.932182 0 0 1 14.523353-5.950096zM612.284069 259.316699c20.21753-3.774792 25.591811-3.774792 28.214971 0.127959a14.715291 14.715291 0 0 1 2.239284 7.421625c0 6.909789-4.478567 9.40499-21.753039 12.348048-8.1254 1.215611-16.506718 2.559181-18.554063 3.007038-7.933461 1.535509-13.179782-12.284069-6.973768-17.914267a61.100448 61.100448 0 0 1 16.890595-4.990403z"/>' +
      '</g></svg>',
  };
  SOURCE_ICON_SVG['copilot-chat'] = SOURCE_ICON_SVG.copilot;
  // Cline's VS Code extension + terminal CLI share the same robot-head mark,
  // as copilot / copilot-chat do above.
  SOURCE_ICON_SVG['cline-cli'] = SOURCE_ICON_SVG.cline;
  // Cursor CLI (cursor-agent) reuses Cursor's brand mark, same pattern as above.
  SOURCE_ICON_SVG['cursor-cli'] = SOURCE_ICON_SVG.cursor;

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

  // Like rowIconButton but with a visible text label beside the icon. Used for the
  // context Dismiss action, where a bare "+" glyph isn't self-explanatory — the
  // label ("Include") makes the outcome clear at a glance.
  function rowLabeledButton(icon, label, title, onClick) {
    const btn = el('button', { type: 'button', className: 'row-act-labeled', title: title }, [
      el('i', { className: 'codicon ' + icon }),
      el('span', { text: label }),
    ]);
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
    else if (kind === 'skill') letter = 'S';
    else if (kind === 'reference') {
      const s = source || '';
      const meta = SOURCE_META[s];
      // Mirrors SidebarScriptBuilder's ctxBadge: a source NOT in SOURCE_META has
      // no generated .mem-ctx-badge--<id> rule, so without this the badge falls
      // through to the .kb-tag base's theme-derived descriptionForeground rather
      // than the neutral grey getSourceMeta reports for that same id. Route it to
      // the 'reference' rule, which is pinned to NEUTRAL_SOURCE_COLOR.
      badgeKind = s && meta ? s : 'reference';
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
    const rel = relevanceById[item.id];
    const aiExcluded = !!(rel && rel.autoExclude);
    // Main row: identity (badge + title) + hover-overlay actions only.
    const row = el('div', { className: 'row', 'data-id': item.id });
    // A reference badge's letter/hue keys off the SOURCE id (forwarded via
    // referenceHover.source), NOT item.iconKey. iconKey is the codicon id (e.g.
    // 'device-camera-video' for zoom-meeting), which misses SOURCE_META and
    // falls back to a neutral 'D' badge. Mirrors the sidebar's renderPlanRow so
    // both surfaces show the identical per-source square (e.g. 'Z' for Zoom).
    const badgeSource = item.contextValue === 'reference' && item.referenceHover ? item.referenceHover.source : '';
    // An unknown contextValue resolves to null and the row degrades to
    // identity-only: badge, title, no checkbox, no actions, no click. Visibly
    // inert beats the old 'reference' default, which silently wrote a foreign key
    // into the reference exclusion set.
    const kindSpec = CONTEXT_ROW_KINDS[item.contextValue] || null;
    row.appendChild(ctxBadge(kindSpec ? kindSpec.badge : item.contextValue, badgeSource));
    row.appendChild(el('div', { className: 'r-main' }, [el('div', { className: 'r-title', text: item.label })]));
    // The toggle message carries the row's id under a per-kind field name — except
    // for the skills aggregate, whose idKey is null because it stands for the whole
    // set and the host reads no id from it.
    let toggleMsg = null;
    if (kindSpec) {
      toggleMsg = { type: kindSpec.msg };
      if (kindSpec.idKey) toggleMsg[kindSpec.idKey] = item.id;
    }
    const removeCmd = kindSpec ? kindSpec.removeCmd : null;
    // Action set differs by state. An AI-excluded row shows ONLY a labeled
    // "+ Include" button — no 🗑 (removing an item the AI already dropped is
    // pointless) and no ✕ (the item is already out of the summary, so toggling it
    // changes nothing). Clicking Include dismisses the AI's exclude suggestion and
    // brings the item back to its original tier + note. A normal row keeps 🗑 + the
    // ✕ exclude toggle. All sit in the hover overlay.
    let actions;
    if (aiExcluded) {
      actions = [
        rowLabeledButton('codicon-add', 'Include', "Dismiss the AI's exclude suggestion", function() {
          vscode.postMessage({ type: 'branch:dismissAiExclude', kind: item.contextValue, key: item.id });
          // Optimistic: a dismiss vetoes only the EXCLUDE ACTION, not the AI's
          // judgment — the row falls back to its original tier + ✨ note (nothing
          // the AI concluded is lost). The host persists the same veto as a
          // dismissed-flag (dismissAiExclusion), keeps the verdict, and
          // re-pushes context:relevance to both surfaces.
          relevanceById[item.id] = Object.assign({}, rel, { autoExclude: false });
          renderContext();
        }),
      ];
    } else {
      actions = [];
      // The skills aggregate has no 'remove' in its action list: it stands for a
      // set, so there is no single artifact to drop from this memory. The checkbox
      // below is still offered — excluding skips the whole set, which is meaningful.
      if (removeCmd && kindSpec.actions.indexOf('remove') !== -1) {
        actions.push(rowIconButton('codicon-trash', 'Remove', function() {
          vscode.postMessage({ type: 'command', command: removeCmd, args: [item.id] });
        }));
      }
      if (toggleMsg) {
        actions.push(excludeToggle(function(selected) {
          vscode.postMessage(Object.assign({}, toggleMsg, { selected: selected }));
        }, !!item.isSelected));
      }
    }
    row.appendChild(rowActions(actions));
    attachRowOpen(row, function() {
      if (!kindSpec) return;
      const openMsg = { type: kindSpec.openMsg };
      if (kindSpec.openIdKey) openMsg[kindSpec.openIdKey] = item.id;
      vscode.postMessage(openMsg);
    });
    // Wrapper: main row + a SECOND meta row for the AI overlay. Keeping the tier /
    // Excluded chip and the ✨ note OFF the hover-overlay .row-actions means they stay
    // visible (tags no longer vanish on hover) and the note gets room for two lines.
    const wrap = el('div', {
      className: 'ctx-item' + (item.isSelected ? '' : ' user-excluded') + (aiExcluded ? ' ai-excluded' : ''),
    }, [row]);
    // Only render the tier/reason meta line when there is a REAL verdict — a
    // non-empty reason, or an AI soft-exclude. A fail-open keepAll result (LLM
    // 404 / timeout / parse error) carries a tier but an EMPTY reason; painting
    // its chip would stamp a bogus "Med" (formerly "High") on every row for any
    // ranking failure. Mirrors SummaryHtmlBuilder.buildRelevanceLine (reason===""
    // → renders nothing) so all surfaces fail-open identically: keep everything,
    // label nothing.
    if (rel && (rel.reason || aiExcluded)) {
      const meta = el('div', { className: 'ctx-meta' });
      if (aiExcluded) {
        meta.appendChild(el('span', { className: 'ctx-tier ctx-tier--ex', title: 'AI marked unrelated — excluded from the summary', text: 'Excluded' }));
      } else if (rel.tier) {
        const tierLabel = rel.tier === 'high' ? 'High' : rel.tier === 'mid' ? 'Med' : 'Low';
        const tierTip = rel.tier === 'high'
          ? 'High relevance to this change'
          : rel.tier === 'mid' ? 'Medium relevance to this change' : 'Low relevance to this change';
        meta.appendChild(el('span', { className: 'ctx-tier ctx-tier--' + rel.tier, title: tierTip, text: tierLabel }));
      }
      if (rel.reason) meta.appendChild(el('div', { className: 'ai-say', text: '\\u2728 ' + rel.reason }));
      wrap.appendChild(meta);
    }
    return wrap;
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
    // Discard posts branch:discardFile; relativePath is what actually performs
    // it, since the CLI's FileDiscardService resolves the real status from the
    // path. The raw porcelain columns still ride along, but nothing reads them
    // — the dispatch they existed for is gone. filePath is the ABSOLUTE path
    // (item.id); relativePath rides on item.description — same field split the
    // sidebar's row uses.
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

  function panel(title, count, rows, headerExtra, emptyText, headerBadge) {
    const header = el('div', { className: 'panel-header' }, [
      el('span', { className: 'panel-title', text: title }),
      el('span', { className: 'sec-count', text: String(count) }),
    ]);
    if (headerBadge) header.appendChild(headerBadge);
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
  // Sort rank: High → Med → Low/unscored → Excluded, so the most relevant read
  // first and excluded items sink to the bottom. Stable within a rank (JS sort).
  function ctxTierRank(item) {
    const r = relevanceById[item.id];
    if (!r) return 2;
    if (r.autoExclude) return 3;
    return r.tier === 'high' ? 0 : r.tier === 'mid' ? 1 : 2;
  }
  function renderContext() {
    const ordered = contextItems.slice().sort(function(a, b) { return ctxTierRank(a) - ctxTierRank(b); });
    const rows = ordered.map(renderContextRow);
    // Analyzing indicator lives in the panel HEADER (not a list row) so it doesn't
    // push the list down or read like an item.
    const badge = isAnalyzing ? el('span', { className: 'ph-analyzing', text: '\\u2728 Analyzing\\u2026' }) : null;
    mount('context-panel', panel('Context', contextItems.length, rows, addMenuButton(), 'No plans or notes yet. Click + to add a plan or note.', badge));
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
    // The pre-commit relevance ranking (isAnalyzing) is a NON-authoritative,
    // display-only overlay — the authoritative ranking runs post-commit in the
    // QueueWorker. It must NOT gate Commit (gating blocked commits for up to the
    // rank timeout on a purely decorative preview). Only worker-busy + file count.
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
      case 'context:relevance':
        relevanceById = {};
        (msg.items || []).forEach(function(r) { relevanceById[r.id] = r; });
        isAnalyzing = false;
        renderContext();
        updateCommitEnabled();
        return;
      case 'context:analyzing':
        isAnalyzing = !!msg.analyzing;
        renderContext();
        updateCommitEnabled();
        return;
      default:
        return;
    }
  });

  vscode.postMessage({ type: 'ready' });
`;
}
