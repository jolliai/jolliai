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

  /* Header bar — was the tab-bar in the previous tab-UI design; now a flex
     row with breadcrumb on the left and a fixed icon strip on the right.
     The old .tab class names (data-tab="kb" / data-tab="status") are kept on
     the icon buttons so the script's existing switchTab dispatch keeps
     working — only the visual treatment changed. */
  .tab-bar {
    display: flex;
    align-items: center;
    background: var(--vscode-sideBarSectionHeader-background, transparent);
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    flex-shrink: 0;
    gap: 4px;
    padding: 2px 4px 2px 6px;
    min-height: 28px;
  }

  /* Breadcrumb: <repo-seg> / <branch-seg>. Each segment is a button so the
     dropdown affordance is keyboard-reachable; when there's only one repo
     (the workspace's own) the chevron is removed by toggling .hidden on
     .breadcrumb-seg-chevron and the segment behaves like static text. */
  .breadcrumb {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .breadcrumb-seg {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 6px;
    border: none;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 11px;
    border-radius: 3px;
    min-width: 0;
  }
  .breadcrumb-seg:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  .breadcrumb-seg[aria-expanded="true"] { background: var(--vscode-toolbar-activeBackground, rgba(0,122,204,0.2)); }
  .breadcrumb-seg-icon { flex: 0 0 auto; font-size: 13px; opacity: 0.8; }
  .breadcrumb-seg-label {
    min-width: 0;
    max-width: 140px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .breadcrumb-seg-chevron { flex: 0 0 auto; font-size: 11px; opacity: 0.6; }
  .breadcrumb-sep {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    flex: 0 0 auto;
    user-select: none;
  }
  /* Right-side icon strip — Memory Bank / Settings / Status. \`margin-left: auto\`
     pins it to the right when the breadcrumb collapses; \`flex-shrink: 0\` stops
     it from being elided when the sidebar is narrow (the breadcrumb truncates
     instead via text-overflow on .breadcrumb-seg-label). */
  .tab-bar-right { display: flex; align-items: center; gap: 2px; margin-left: auto; flex-shrink: 0; }

  /* Header-bar icon button — square button hosting a single codicon. The
     legacy .tab class is preserved so the existing switchTab dispatch
     (document.querySelectorAll('.tab[data-tab]')) still finds these buttons.
     The .active marker means the corresponding overlay panel is currently
     open; clicking the active icon again collapses back to the Branch view. */
  .tab {
    flex: 0 0 auto;
    padding: 4px 6px;
    border: none;
    background: transparent;
    color: var(--vscode-icon-foreground, var(--vscode-foreground));
    cursor: pointer;
    border-radius: 3px;
    min-width: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .tab.tab-icon { /* explicit modifier preserved for selector specificity in legacy hover/active rules */ }
  .tab:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  .tab.active { background: var(--vscode-toolbar-activeBackground, rgba(0,122,204,0.2)); color: var(--vscode-foreground); }

  /* Dropdown menu for the breadcrumb repo / branch pickers. Anchored to the
     triggering segment via inline left/top set by the script (we can't
     position it with CSS alone because the segment widths vary with their
     labels). */
  .dropdown-menu {
    position: absolute;
    z-index: 10;
    min-width: 160px;
    max-width: 280px;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, rgba(128,128,128,0.3)));
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    padding: 4px 0;
    border-radius: 3px;
    display: flex;
    flex-direction: column;
    max-height: 50vh;
  }
  /* Search box stays pinned at the top; only the list scrolls. The host
     also sets an inline max-height on the menu when the available viewport
     space is tighter than 50vh — see showBreadcrumbMenu. */
  .dropdown-search {
    flex: 0 0 auto;
    padding: 4px 6px;
    border-bottom: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border, rgba(128,128,128,0.3)));
  }
  .dropdown-search input {
    width: 100%;
    padding: 3px 6px;
    font-size: 12px;
    font-family: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    outline: none;
  }
  .dropdown-search input:focus {
    border-color: var(--vscode-focusBorder);
  }
  .dropdown-list {
    flex: 1 1 auto;
    overflow-y: auto;
    min-height: 0;
  }
  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    cursor: pointer;
    font-size: 12px;
    white-space: nowrap;
  }
  .dropdown-item:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }
  .dropdown-item .dropdown-item-check { width: 14px; flex: 0 0 14px; font-size: 12px; }
  /* .current = the row currently selected for viewing (drives the check icon).
     .workspace = the IDE's workspace repo/branch, pinned to the top of the
     dropdown by pinWorkspaceFirst() and bolded here so the user can always
     spot the way back home — even when viewing a foreign repo or a sibling
     branch. Same font-weight on both so two simultaneously-true rows look
     uniform; the check icon alone distinguishes them. */
  .dropdown-item.current,
  .dropdown-item.workspace { font-weight: 600; }
  /* Divider below the pinned workspace row groups it as its own section at
     the top of the dropdown, mirroring VS Code's native branch picker which
     separates the active branch from the alphabetical list. Applied as a
     border-top on the *next* .dropdown-item via the adjacent-sibling
     combinator (rather than border-bottom on the workspace row itself) so
     the rule only matches when there genuinely is a next data row to
     separate from — no orphan line when the workspace row is the only item
     in the list, and the empty-state div (which is not a .dropdown-item)
     never triggers it. */
  .dropdown-item.workspace + .dropdown-item {
    border-top: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border, rgba(128,128,128,0.3)));
    margin-top: 2px;
    padding-top: 4px;
  }
  .dropdown-empty {
    padding: 6px 10px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  /* Status indicator color classes — applied to the codicon-circle-filled inside #status-icon-btn. */
  .status-icon-ok { color: var(--vscode-testing-iconPassed, #89d185); }
  .status-icon-warn { color: var(--vscode-testing-iconQueued, #cca700); }
  .status-icon-error { color: var(--vscode-testing-iconFailed, #f48771); }

  /* Foreign-readonly chrome on the Branch panel. Mirrors the
     SummaryWebviewPanel.foreign-readonly default-deny: when the user is
     viewing a non-workspace repo or non-current branch, the writable surfaces
     collapse so a click can't trigger a write against a foreign repo.
     - Plans & Notes and Changes sections vanish entirely (their data is
       inherently workspace-local; rendering them with a "n/a" placeholder
       would just be noise). The script also skips pushing these sections in
       foreign mode (see renderBranch), so the CSS rule is defense in depth
       against a future code path that forgets to gate.
     - Memory checkboxes hidden via visibility (not display:none, which would
       collapse the row-leading slot and break commit-row alignment with
       commit-file child rows).
     - The Memories-section header actions (Squash / Push) are suppressed at
       the script level (renderSectionActions returns []), so no CSS rule is
       needed there — and adding display:none to .section-actions reflows
       the section-header (legacy bug, guarded by the test "never uses
       display:none for .section-actions"). */
  .sidebar-root.foreign-readonly .collapsible-section[data-section="plans"],
  .sidebar-root.foreign-readonly .collapsible-section[data-section="changes"] {
    display: none;
  }
  .sidebar-root.foreign-readonly .collapsible-section[data-section="commits"] input[type="checkbox"][data-checkbox-kind="commit"] {
    visibility: hidden;
  }

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

  /* Partial-data banner shown above a section's rows when some upstream
     loaders failed (e.g. one SQLite-backed source locked / schema-drifted).
     Lower-prominence than an error toast — the list is still useful, the
     hint just keeps the user from misreading missing rows as "truly empty". */
  .conversations-warning {
    margin: 4px 8px;
    padding: 6px 8px;
    font-size: 11px;
    color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-warningBackground, transparent);
    border-left: 2px solid var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground, #cca700));
    border-radius: 2px;
  }

  .collapsible-section { display: flex; flex-direction: column; }
  .collapsible-section .section-header {
    display: flex;
    align-items: center;
    /* Mirror .tree-node's gap:4px so the section title starts at the same
       x-coordinate as the row's row-leading slot — i.e. the section title
       text left edge column-aligns with the row's checkbox / leading icon. */
    gap: 4px;
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
    /* 4px here + 4px from the section-header flex gap above = 8px of breathing
       room to the right of the section title (the value before the header gap
       existed). Keep these two numbers in lockstep if either changes. */
    margin-left: 4px;
    visibility: hidden;
  }
  .collapsible-section .section-header:hover .section-actions { visibility: visible; }
  .collapsible-section.collapsed .section-body { display: none; }

  /* Divider that separates the Changes file list from the Commit Memory CTA
     below. Lives on the section body's bottom edge (not on the CTA wrapper)
     so it inherits the section-body's collapse behaviour — when CHANGES is
     collapsed, .section-body { display: none } hides both the file list and
     this border in one go, while the CTA itself (a sibling of section-body)
     stays visible and tucks directly under the header. Scoped to the Changes
     section because that's the only section that mounts a CTA below it.
     padding-bottom gives the line breathing room above the last file row so
     the divider reads as intentional rather than cramped against content. */
  .collapsible-section[data-section="changes"] .section-body {
    padding-bottom: 12px;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, var(--vscode-panel-border)));
  }

  /* Bottom-of-section "Commit Memory" CTA — sits below the Changes section
     body. Button aligns right (SCM-view convention) and the wrapper carries
     vertical breathing room above (gap from the divider that lives on the
     section body) and below (gap to the next section header). Button reuses
     VS Code's primary-button tokens so it adapts to theme. Disabled state
     matches .iconbtn:disabled (opacity-only, no hover background change) so
     the visual semantics are consistent with the header sparkle iconbtn that
     points at the same command. */
  .commit-memory-action {
    margin: 12px 0 0 0;
    padding: 0 8px 12px 8px;
    display: flex;
    justify-content: flex-end;
  }
  .commit-memory-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: 1px solid transparent;
    border-radius: 3px;
    font-size: 13px;
    cursor: pointer;
  }
  .commit-memory-btn:hover {
    background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
  }
  .commit-memory-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .commit-memory-btn:disabled:hover {
    background: var(--vscode-button-background);
  }
  .commit-memory-btn .codicon {
    font-size: 14px;
  }

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
  /* Per-level indent step is 20px (matching VS Code's default tree). The
     row's leading column is chevron(12) + gap(4) + icon(16) = 32px+; with a
     12px step a child's chevron landed between the parent's chevron and icon
     and the hierarchy looked "aligned, not nested" — see Memory Bank tree
     report. 20px ensures the child chevron is clearly past the parent
     chevron column. */
  .tree-node[data-indent="1"] { padding-left: 28px; }
  .tree-node[data-indent="2"] { padding-left: 48px; }
  .tree-node[data-indent="3"] { padding-left: 68px; }
  .tree-node[data-indent="4"] { padding-left: 88px; }
  .tree-node[data-indent="5"] { padding-left: 108px; }
  .tree-node[data-indent="6"] { padding-left: 128px; }
  .tree-node[data-indent="7"] { padding-left: 148px; }
  .tree-node[data-indent="8"] { padding-left: 168px; }
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
  /* Repo nodes inside the Memory Bank tree — one per discovered repo under
     <localFolder>. Bold label marks repos as a primary grouping in the now
     flat top-level listing. */
  .tree-node[data-kind="repo"] > .label {
    font-weight: 600;
  }
  /* Current-repo cue: a 2px left accent bar (the same visual language
     VSCode uses for "this is your active context") plus a quiet "(current)"
     suffix. Mirrors IntelliJ's KBExplorerPanel isCurrentRepo highlight
     without competing with the row's hover / selected background.
     box-sizing here is content-box (the default), so a 2px border-left
     pushes content 2px to the right. To keep this row's chevron column-
     aligned with sibling repos (which have no border) we subtract those
     2px from the depth-0 base padding (8px) — giving 6px padding here.
     Total content offset stays 8px on every row. A hardcoded 18px once
     lived here from when the base was different; the resulting +12px drift
     made the (current) repo's chevron look like it belonged to a deeper
     hierarchy level than its siblings.
     Note: this override is depth-0 only — repo-root nodes never nest. */
  .tree-node.current-repo-node {
    border-left: 2px solid var(--vscode-focusBorder);
    padding-left: 6px;
  }
  .tree-node.current-repo-node > .label::after {
    content: " (current)";
    color: var(--vscode-descriptionForeground);
    font-weight: 400;
  }
  .tree-node .label { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  /* Hierarchical truncation for changes / commit-file rows. The dirname
     (.desc) gets flex-shrink:9999 vs the filename's :1, so dirname absorbs
     essentially all overflow first and only after it collapses to 0 does
     the filename begin to ellipsize. Result: reads filename-first like
     native VSCode SCM, but recovers gracefully when even a fully-collapsed
     dirname can't make the row fit (e.g. very long *.integration.test.ts
     names in the Changes panel with the discard icon shown on hover).
     min-width:0 on both is load-bearing — flex items default to
     min-width:auto (content-based), which would prevent text-overflow:
     ellipsis from ever firing. Layout per row:
       <icon> <label> <dirname-or-…>  …spacer…  <letter> [<discard>] */
  .tree-node[data-context="commitFile"] .label,
  .tree-node.tree-node--changes .label {
    flex: 0 1 auto;
    min-width: 0;
    max-width: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tree-node[data-context="commitFile"] .desc,
  .tree-node.tree-node--changes .desc {
    flex: 0 9999 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
       the commit-file default rule below — letter sits flush against
       the inline-actions group (its own padding-left:4px supplies the
       breathing room from the discard button's internal right padding). */
  .tree-node.tree-node--changes .inline-actions {
    visibility: hidden;
    margin-left: auto;
  }
  .tree-node.tree-node--changes:hover .inline-actions { visibility: visible; }
  .tree-node.tree-node--changes .gs-letter { margin-left: 0; }

  /* CONVERSATIONS section rows: one active AI session per row. Inherits the
     base .tree-node flex layout (gap: 4px) so the leading checkbox / icon
     column-aligns with plan, note, and change rows in the sibling sections.
     The wider 8px breathing room around the trailing metadata chips
     (badge / count / time) is restored via per-chip margin-left below —
     overriding the row-level gap would also widen twirl → row-leading and
     break section column alignment. */
  .tree-node.conversation-row .badge,
  .tree-node.conversation-row .count,
  .tree-node.conversation-row .time {
    /* 4px here + 4px from the base .tree-node flex gap = 8px total spacing
       to the left neighbor. Keep these two numbers paired if either moves. */
    margin-left: 4px;
  }
  /* Source badge — outline pill. Default to descriptionForeground for unknown
     sources; per-source rules below override fg/bg/border with the brand hue.
     Why outline + half-transparent fill (rgba *, 0.12): the row sits over
     sidebar bg, hover bg, and selected bg; a solid fill would either fight
     one of those backgrounds or need three hover overrides per source. */
  .tree-node.conversation-row .badge {
    font-size: 11px;
    line-height: 16px;
    padding: 0 6px;
    border-radius: 4px;
    border: 1px solid var(--vscode-descriptionForeground);
    background: transparent;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
    font-weight: 500;
  }
  /* Per-source brand hues. Chosen to be readable on both light and dark
     VSCode themes (mid-lightness OKLCH-equivalent hex). Claude purple +
     Cursor teal match the UI mockup; other five fill out the rainbow so
     every transcript source has its own identity.

     Selector must include '.tree-node.conversation-row .badge' so the
     specificity (0,4,0) beats the neutral fallback above (0,3,0); a bare
     '.transcript-source-X' rule (0,1,0) is silently overridden and the
     badge stays descriptionForeground-gray. */
  .tree-node.conversation-row .badge.transcript-source-claude       { color: #a78bfa; border-color: #a78bfa; background: rgba(167,139,250,0.12); }
  .tree-node.conversation-row .badge.transcript-source-cursor       { color: #2dd4bf; border-color: #2dd4bf; background: rgba(45,212,191,0.12); }
  .tree-node.conversation-row .badge.transcript-source-codex        { color: #4ade80; border-color: #4ade80; background: rgba(74,222,128,0.12); }
  .tree-node.conversation-row .badge.transcript-source-gemini       { color: #60a5fa; border-color: #60a5fa; background: rgba(96,165,250,0.12); }
  .tree-node.conversation-row .badge.transcript-source-opencode     { color: #fb923c; border-color: #fb923c; background: rgba(251,146,60,0.12); }
  .tree-node.conversation-row .badge.transcript-source-copilot      { color: #94a3b8; border-color: #94a3b8; background: rgba(148,163,184,0.12); }
  .tree-node.conversation-row .badge.transcript-source-copilot-chat { color: #fbbf24; border-color: #fbbf24; background: rgba(251,191,36,0.12); }

  .tree-node.conversation-row .count,
  .tree-node.conversation-row .time {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
  }

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
  /* Description preview (Linear issue body / future plan-note preview).
     pre-wrap keeps paragraph breaks visible — without it the default
     'normal' whitespace handling collapses '\n\n' into a single space
     and the preview reads as one run-on line. word-break ensures very
     long unbroken tokens (URLs, slugs) wrap inside the card. */
  .hover-card .hc-description {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 8em;
    overflow: hidden;
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
    min-width: 0;
  }
  .status-entry:hover { background: var(--vscode-list-hoverBackground); cursor: pointer; }
  .status-entry .label {
    flex-shrink: 0;
    white-space: nowrap;
  }
  .status-entry .desc {
    color: var(--vscode-descriptionForeground);
    flex: 1 1 auto;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

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
    /* Left-align so the checkbox / leading icon's left edge column-aligns with
       the .section-header's title text (both sit at padding 8 + twirl 12 +
       gap 4 = 24px from the row's left edge). Centering instead would push
       the checkbox right by ~2.5px and break the alignment with the header. */
    justify-content: flex-start;
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
    padding-left: 4px;
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
  .disabled-panel,
  .apikey-panel {
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
  .ob-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .ob-btn:disabled:hover { background: var(--vscode-button-background); }
  /* ── API key entry panel ──────────────────────────────────────────
     Reuses .ob-header / .ob-btn from the onboarding panel. The label +
     input pair sits between the header and the Save/Back buttons. The
     inline error span is hidden via .hidden by default and surfaces
     only after the host posts an apikey:saveError back. */
  .apikey-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    margin: 12px 0 6px 0;
    color: var(--vscode-foreground);
  }
  .apikey-input {
    display: block;
    width: 100%;
    padding: 6px 8px;
    box-sizing: border-box;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
    border-radius: 4px;
    font-size: 12px;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .apikey-input:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .apikey-error {
    margin: 8px 0 0 0;
    font-size: 12px;
    color: var(--vscode-errorForeground);
    line-height: 1.4;
  }
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
