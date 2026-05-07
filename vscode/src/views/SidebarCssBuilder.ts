/**
 * SidebarCssBuilder
 *
 * Returns the full CSS for the sidebar webview.
 * Uses VSCode theme variables for automatic light/dark theming.
 * Pure string template — no logic dependencies on other view modules.
 */
export function buildSidebarCss(): string {
	return `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  /* Global hide convention: every togglable element here gets the .hidden class
     instead of the HTML hidden attribute. UA-stylesheet display:none for [hidden]
     loses to author rules like display:flex on .tab-bar / .tab-toolbar, which
     silently breaks the toggle. !important locks display:none in regardless of
     whatever display the element's class otherwise sets. */
  .hidden { display: none !important; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    overflow: hidden;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .sidebar-root { display: flex; flex-direction: column; height: 100%; }
  .sidebar-root .disabled-banner {
    padding: 20px 16px 16px;
    color: var(--vscode-foreground);
    flex-shrink: 0;
  }
  .sidebar-root .disabled-banner .disabled-intro {
    margin: 0 0 12px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.4;
  }
  .sidebar-root .disabled-banner .enable-btn {
    padding: 6px 14px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    cursor: pointer;
    border-radius: 2px;
  }
  .sidebar-root .disabled-banner .enable-btn:hover {
    background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
  }

  .tab-bar {
    display: flex;
    background: var(--vscode-sideBarSectionHeader-background, transparent);
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    flex-shrink: 0;
  }
  .tab {
    flex: 1;
    padding: 6px 6px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    border: none;
    background: transparent;
    border-bottom: 2px solid transparent;
    /* inline-flex centers icon+label horizontally; min-width:0 lets the
       label span shrink with text-overflow inside the flex item. */
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-width: 0;
  }
  .tab .tab-icon-leading {
    flex: 0 0 auto;
    font-size: 14px;
    line-height: 1;
  }
  .tab .tab-label {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tab.active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder, #007acc);
  }
  .tab:hover { color: var(--vscode-foreground); }

  /* Right-side icon area in the tab bar — holds status indicator + settings + future icons.
     \`margin-left: auto\` keeps it pinned to the right when the labeled KB / Branch tabs are
     present (their \`flex: 1\` already consumes free space, so the auto margin is a no-op) AND
     when those tabs are .hidden in disabled mode (auto margin then pushes this block right). */
  .tab-bar-right { display: flex; align-items: center; gap: 4px; padding: 0 6px; margin-left: auto; flex-shrink: 0; }

  /* Icon-style "tab" — used for the status indicator. Visually distinct from labeled tabs. */
  .tab.tab-icon { flex: 0 0 auto; padding: 4px 6px; border-bottom: none; min-width: 24px; }
  .tab.tab-icon.active { border-bottom: none; background: var(--vscode-toolbar-activeBackground, rgba(0,122,204,0.2)); }
  .tab.tab-icon:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }

  /* Status indicator color classes — applied to the codicon-circle-filled inside #status-icon-btn. */
  .status-icon-ok { color: var(--vscode-testing-iconPassed, #89d185); }
  .status-icon-warn { color: var(--vscode-testing-iconQueued, #cca700); }
  .status-icon-error { color: var(--vscode-testing-iconFailed, #f48771); }

  .tab-toolbar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
    flex-shrink: 0;
  }
  /* Inline search input that lives in the toolbar (memories mode). The
     leading codicon is positioned absolutely inside the wrapper so the
     placeholder/text starts after it. The wrapper takes the leftover flex
     space pushed against the action buttons. */
  .kb-search-box {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    margin-right: 4px;
    display: flex;
    align-items: center;
  }
  .kb-search-box .kb-search-icon {
    position: absolute;
    left: 6px;
    pointer-events: none;
    color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground));
    font-size: 13px;
  }
  .kb-search-box input {
    flex: 1 1 auto;
    width: 100%;
    padding: 3px 6px 3px 22px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    font-size: 12px;
    height: 22px;
    line-height: 1;
  }
  .kb-search-box input:focus {
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
  }
  /* Worker-busy indicator on the Branch tab toolbar. flex:1 1 auto pushes the
     refresh button to the right edge — same packing trick as .kb-search-box.
     min-width:0 lets the label truncate gracefully on narrow sidebars. */
  .toolbar-worker-status {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    padding-left: 2px;
  }
  .toolbar-worker-status-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .iconbtn {
    width: 24px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    color: var(--vscode-icon-foreground, var(--vscode-foreground));
    cursor: pointer;
    font-size: 14px;
  }
  .iconbtn:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15));
  }
  .iconbtn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  /* Specificity ties with .iconbtn:hover above; without this override the
     disabled button would still grow a hover background on cursor enter. */
  .iconbtn:disabled:hover {
    background: transparent;
  }
  .iconbtn.toggled {
    background: var(--vscode-inputOption-activeBackground, rgba(0,122,204,0.3));
    color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground));
    border-color: var(--vscode-inputOption-activeBorder, transparent);
  }

  .tab-content {
    flex: 1;
    overflow: auto;
    overflow-x: hidden;
  }
  .placeholder { padding: 16px; color: var(--vscode-descriptionForeground); font-style: italic; }
  .empty-state {
    padding: 24px 16px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    line-height: 1.5;
  }

  .collapsible-section { display: flex; flex-direction: column; }
  .collapsible-section .section-header {
    display: flex;
    align-items: center;
    background: var(--vscode-sideBarSectionHeader-background, transparent);
    color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    padding: 4px 8px;
    font-size: 11px;
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.5px;
    cursor: pointer;
    user-select: none;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
  }
  .collapsible-section .section-header .twirl {
    width: 12px;
    transition: transform 0.1s;
  }
  .collapsible-section.collapsed .section-header .twirl { transform: rotate(-90deg); }
  .collapsible-section .section-title { flex: 1; }
  /* Hover-only actions on the section header. Uses visibility (not display)
     so the slot is always reserved — no header-height flicker on mouse-enter
     (the layout-shift trap that earlier display:none attempts hit). Mirrors
     the same pattern used by .memory-row .inline-actions below. */
  .collapsible-section .section-actions {
    display: inline-flex;
    gap: 2px;
    margin-left: 8px;
    visibility: hidden;
  }
  .collapsible-section .section-header:hover .section-actions { visibility: visible; }
  .collapsible-section.collapsed .section-body { display: none; }

  .tree-node {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    padding-left: 8px;
    cursor: pointer;
    white-space: nowrap;
    user-select: none;
  }
  .tree-node[data-indent="1"] { padding-left: 20px; }
  .tree-node[data-indent="2"] { padding-left: 32px; }
  .tree-node[data-indent="3"] { padding-left: 44px; }
  .tree-node[data-indent="4"] { padding-left: 56px; }
  .tree-node[data-indent="5"] { padding-left: 68px; }
  .tree-node[data-indent="6"] { padding-left: 80px; }
  .tree-node[data-indent="7"] { padding-left: 92px; }
  .tree-node[data-indent="8"] { padding-left: 104px; }
  /* KB tab folder-mode rows carry data-kind="dir|file" (set by the
     folder renderer) — branch tab rows use data-context instead, so this
     selector cleanly scopes the spacing bump to folder mode. We match
     .memory-row's vertical padding (6px top/bottom) so the breathing
     room around each row reads identically; absolute row height stays
     content-driven (memories rows naturally taller because of their
     hash/branch/time meta line). */
  .tree-node[data-kind] {
    padding-top: 6px;
    padding-bottom: 6px;
  }
  .tree-node:hover { background: var(--vscode-list-hoverBackground); }
  .tree-node.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .tree-node .twirl {
    width: 12px;
    flex-shrink: 0;
    color: var(--vscode-foreground);
    transition: transform 0.1s;
  }
  .tree-node.expanded > .twirl { transform: rotate(90deg); }
  /* Commit-row chevron: replaces the silent .twirl placeholder with a real
     codicon affordance so the user sees there is something to expand. The
     codicon class drives the glyph (chevron-right ↔ chevron-down) so we
     don't need any rotation transform here. */
  .tree-node .commit-twirl {
    width: 12px;
    flex-shrink: 0;
    cursor: pointer;
    color: var(--vscode-foreground);
    font-size: 12px;
    line-height: 1;
  }
  .tree-node .icon { width: 16px; flex-shrink: 0; text-align: center; }
  /* KB folder-mode icon column renders codicons (repo / folder / markdown /
     file). Tint memory / plan / note markdown glyphs so kind reads at a
     glance; "other" files keep the default foreground color. */
  .tree-node .icon .codicon { font-size: 14px; line-height: 1; }
  .tree-node .icon.kb-icon-memory .codicon { color: var(--vscode-charts-blue,  #2f7adc); }
  .tree-node .icon.kb-icon-plan   .codicon { color: var(--vscode-charts-green, #388a34); }
  .tree-node .icon.kb-icon-note   .codicon { color: var(--vscode-charts-orange, #d18616); }
  /* Repo-root header — bold label + non-interactive cursor mirror the
     IntelliJ KBExplorerPanel renderer, which marks the current repo node
     with REGULAR_BOLD_ATTRIBUTES. Hover background is suppressed because
     the header is decorative (clicks no-op) and the hover affordance
     would otherwise suggest folding the whole tree. */
  .tree-node[data-kind="repo-root"] {
    cursor: default;
  }
  .tree-node[data-kind="repo-root"] > .label {
    font-weight: 600;
  }
  .tree-node[data-kind="repo-root"]:hover {
    background: transparent;
  }
  .tree-node .label { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  /* commit-file rows AND changes rows: label hugs its own width so the
     .desc (dirname) can sit immediately to the right. The trailing
     .gs-letter still gets pushed to the row edge by its own
     margin-left:auto. Layout becomes:
       <icon> <label> <dirname>  …spacer…  <letter> [<discard>]
     Changes rows additionally show a hover-only discard button after
     the letter (CSS for that lives in tree-node--changes rules above);
     letter coexists with discard because inline-actions has its own
     flex-shrink:0 and only toggles visibility, not layout. */
  .tree-node[data-context="commitFile"] .label,
  .tree-node.tree-node--changes .label {
    flex: 0 1 auto;
    max-width: 60%;
  }
  /* Trailing kind tag for plan / note files. Memory has no tag — the
     tinted markdown icon already conveys it. P / N are 14×14 chips with
     the same color tokens used by the icon, so the kind signal stays
     visually consistent across the icon and the tag. */
  .tree-node .kb-tag {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    margin-left: 4px;
    border-radius: 3px;
    font-size: 9px;
    font-weight: 600;
    line-height: 1;
    flex-shrink: 0;
    color: var(--vscode-button-foreground, #ffffff);
  }
  .tree-node .kb-tag-plan { background: var(--vscode-charts-green,  #388a34); }
  .tree-node .kb-tag-note { background: var(--vscode-charts-orange, #d18616); }
  .tree-node .desc {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    margin-left: 4px;
    flex-shrink: 0;
  }
  /* Inline actions on tree nodes default to always visible (plans rows keep
     edit/remove visible for fast access; commit rows keep View Memory). */
  .tree-node .inline-actions { display: inline-flex; gap: 2px; flex-shrink: 0; }
  /* Changes rows trailing pair: [discard (hover-only)] [letter (always)].
     - margin-left:auto on inline-actions pushes the whole pair to the
       right edge (gs-letter rides along just after it in DOM order).
     - visibility (not display) toggle keeps the row from reflowing on
       hover; the slot stays reserved.
     - gs-letter override drops the margin-left:auto it'd inherit from
       the commit-file default rule below — letter just sits 4px after
       the inline-actions group. */
  .tree-node.tree-node--changes .inline-actions {
    visibility: hidden;
    margin-left: auto;
  }
  .tree-node.tree-node--changes:hover .inline-actions { visibility: visible; }
  .tree-node.tree-node--changes .gs-letter { margin-left: 4px; }

  .memory-row {
    padding: 6px 12px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.1));
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .memory-row:hover { background: var(--vscode-list-hoverBackground); }
  .memory-row-icon { width: 16px; flex-shrink: 0; text-align: center; }
  .memory-row-icon .codicon { font-size: 14px; line-height: 1; }
  .memory-row-icon.kb-icon-memory .codicon { color: var(--vscode-charts-blue, #2f7adc); }
  .memory-row-main { flex: 1; min-width: 0; }
  .memory-row .title {
    color: var(--vscode-foreground);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-bottom: 2px;
  }
  .memory-row .meta { color: var(--vscode-descriptionForeground); font-size: 10px; }
  .memory-row .meta .hash { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); }
  /* Hover-only buttons matching the legacy native TreeView UX. Uses
     visibility (not display) so the row reserves the slot at all times —
     no reflow on hover, no flicker. The "always-visible" guard in
     SidebarCssBuilder.test.ts is scoped to .tree-node + .section-header
     where layout-shift problems originally surfaced. */
  .memory-row .inline-actions { display: inline-flex; gap: 2px; flex-shrink: 0; visibility: hidden; }
  .memory-row:hover .inline-actions { visibility: visible; }

  /* Custom hover popup that replaces the native title= tooltip. Mirrors the
     legacy MarkdownString tooltip 1:1 (codicons + command links). Positioned
     by JS via top/left properties to avoid CSP-blocked inline styles. */
  /* Plain-text tooltip (status rows + toolbar buttons). Replaces native title=
     because Chromium webview tooltip is unreliable across focus transitions
     and DOM rebuilds. Kept deliberately minimal — no codicons, no command
     links, no grace window across rows. pointer-events:none is critical:
     without it, the cursor entering the tooltip box would fire mouseleave on
     the underlying element and snap the tooltip back hidden. */
  .text-tip {
    position: fixed;
    z-index: 1100;
    /* width:max-content makes the box size itself to the longest line of
       content (or longest unbreakable run for pre-wrap), capped by max-width.
       Without it, the box's width would be constrained by viewport-left, so
       a stale "left" near the right edge from a previous show can squeeze
       short single-line tips into multi-line wraps. max-content decouples
       width from position; the position clamp later only moves the box. */
    width: max-content;
    max-width: 320px;
    padding: 4px 8px;
    background: var(--vscode-editorHoverWidget-background);
    color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border, rgba(128,128,128,0.2)));
    border-radius: 2px;
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.3));
    font-size: 12px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
    pointer-events: none;
  }

  .hover-card {
    position: fixed;
    z-index: 1000;
    max-width: 480px;
    min-width: 280px;
    padding: 8px 12px;
    background: var(--vscode-editorHoverWidget-background);
    color: var(--vscode-editorHoverWidget-foreground);
    border: 1px solid var(--vscode-editorHoverWidget-border);
    border-radius: 3px;
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.4));
    font-size: 12px;
    line-height: 1.5;
    pointer-events: auto;
  }
  .hover-card .hc-title {
    font-weight: 600;
    color: var(--vscode-editorHoverWidget-foreground);
    margin-bottom: 6px;
    word-break: break-word;
  }
  .hover-card .hc-row { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
  .hover-card .hc-row .codicon { color: var(--vscode-icon-foreground); flex-shrink: 0; }
  .hover-card hr {
    border: none;
    border-top: 1px solid var(--vscode-editorHoverWidget-border);
    margin: 6px 0;
  }
  .hover-card .hc-stats {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
  .hover-card .hc-actions { display: flex; gap: 12px; align-items: center; }
  .hover-card .hc-link {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    user-select: none;
  }
  .hover-card .hc-link:hover { color: var(--vscode-textLink-activeForeground); }
  .hover-card .hc-hash {
    font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
  }
  .hover-card .hc-sep { color: var(--vscode-descriptionForeground); }

  .status-entry {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
  }
  .status-entry:hover { background: var(--vscode-list-hoverBackground); cursor: pointer; }
  .status-entry .label { flex-shrink: 0; }
  .status-entry .desc { color: var(--vscode-descriptionForeground); }

  /* Codicon color classes — applied via className because CSP style-src has
     no 'unsafe-inline', so dynamic style="color:..." attributes are blocked.
     Using --vscode-testing-icon* tokens (reliably injected into webviews)
     with hex backups via the var() fallback syntax. */
  .codicon.icon-color-green  { color: var(--vscode-testing-iconPassed, #89d185); }
  .codicon.icon-color-red    { color: var(--vscode-testing-iconFailed, #f48771); }
  .codicon.icon-color-yellow { color: var(--vscode-testing-iconQueued, #cca700); }

  .context-menu {
    position: fixed;
    background: var(--vscode-menu-background);
    color: var(--vscode-menu-foreground);
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
    box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    padding: 2px 0;
    z-index: 100;
    min-width: 160px;
    font-size: 12px;
  }
  .context-menu .menu-item {
    padding: 4px 16px;
    cursor: pointer;
    white-space: nowrap;
  }
  .context-menu .menu-item:hover {
    background: var(--vscode-menu-selectionBackground);
    color: var(--vscode-menu-selectionForeground);
  }
  .context-menu .menu-separator {
    height: 1px;
    background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
    margin: 2px 0;
  }

  .row-leading {
    width: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .row-leading input[type="checkbox"] {
    margin: 0;
    accent-color: var(--vscode-checkbox-background);
    cursor: pointer;
  }
  .gs-M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .gs-A { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .gs-D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .gs-U { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
  .gs-R { color: var(--vscode-gitDecoration-renamedResourceForeground); }
  .gs-C { color: var(--vscode-gitDecoration-conflictingResourceForeground); }
  .gs-I { color: var(--vscode-gitDecoration-ignoredResourceForeground); }
  /* Trailing status letter on commit-file rows ("M", "A", "D", "R", ...).
     margin-left:auto pushes it to the right edge of the row, mirroring
     the legacy native TreeView's status letter column. Color comes from
     the .gs-{code} class composed alongside .gs-letter. */
  .tree-node .gs-letter {
    margin-left: auto;
    padding-left: 8px;
    font-size: 11px;
    flex-shrink: 0;
  }

  /* ── Loading panel ────────────────────────────────────────────────
     First-paint placeholder shown until the host's 'init' message
     arrives. Centered spinner + label using --vscode-descriptionForeground
     so it adapts to all themes. The .codicon-modifier-spin class is
     provided by codicon.css (already linked from the HTML head). */
  .loading-panel {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 16px;
    height: 100%;
    box-sizing: border-box;
    color: var(--vscode-descriptionForeground);
  }
  .loading-icon {
    font-size: 20px;
  }
  .loading-text {
    font-size: 12px;
  }

  /* ── Onboarding panel ─────────────────────────────────────────────
     Shown when state.configured === false. Sibling of .tab-bar inside
     .sidebar-root; toggled via the .hidden class by SidebarScriptBuilder.
     Theme accents (border, badge, primary button) all come from
     --vscode-focusBorder / --vscode-button-* so the panel adapts to
     Light / Dark / High-Contrast without hard-coded hex values.

     .disabled-panel is the user-disabled (state.enabled === false)
     counterpart. It reuses the same container shell + .ob-* header /
     button styles but renders a stripped-down body (header + Enable
     button only — no option cards, no OR divider). Sharing the
     container rule keeps padding/scroll behavior in lockstep. */
  .onboarding-panel,
  .disabled-panel {
    padding: 16px;
    overflow-y: auto;
    height: 100%;
    box-sizing: border-box;
  }
  .ob-header { margin-bottom: 12px; }
  .ob-title-row { display: flex; align-items: center; gap: 8px; }
  .ob-title-icon {
    font-size: 18px;
    color: var(--vscode-textLink-foreground);
  }
  .ob-title { font-size: 14px; font-weight: 600; margin: 0; }
  .ob-subtitle {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    margin: 6px 0 0 0;
    line-height: 1.5;
  }
  .ob-divider {
    border: none;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    margin: 12px 0 14px 0;
  }
  .ob-card {
    position: relative;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 6px;
    padding: 12px;
    background: var(--vscode-editor-background);
  }
  .ob-card--recommended {
    border-color: var(--vscode-focusBorder);
    border-width: 1.5px;
    padding-top: 14px;
  }
  .ob-badge {
    position: absolute;
    top: 10px;
    right: 10px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.5px;
    padding: 3px 8px;
    border-radius: 8px;
    color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
    background: color-mix(in srgb, var(--vscode-focusBorder) 20%, transparent);
  }
  .ob-card-row { display: flex; gap: 10px; align-items: flex-start; }
  .ob-card-icon {
    font-size: 16px;
    margin-top: 2px;
    color: var(--vscode-foreground);
  }
  .ob-card-text { flex: 1; min-width: 0; }
  .ob-card-title { font-size: 12px; font-weight: 600; margin: 0; }
  .ob-card-desc {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    margin: 4px 0 0 0;
    line-height: 1.5;
  }
  .ob-btn {
    display: block;
    width: 100%;
    padding: 8px 12px;
    margin-top: 8px;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
    text-align: center;
    border: 1px solid transparent;
  }
  .ob-btn--primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .ob-btn--primary:hover { background: var(--vscode-button-hoverBackground); }
  .ob-btn--secondary {
    background: transparent;
    color: var(--vscode-foreground);
    border-color: var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  .ob-btn--secondary:hover { background: var(--vscode-list-hoverBackground); }
  .ob-or {
    display: flex; align-items: center; gap: 10px;
    margin: 14px 0;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  .ob-or::before, .ob-or::after {
    content: "";
    flex: 1;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  `;
}
