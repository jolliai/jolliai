/**
 * SidebarCssBuilder
 *
 * Returns the full CSS for the sidebar webview.
 * Uses VSCode theme variables for automatic light/dark theming.
 * Mostly a pure string template — the one exception is the per-source
 * `.mem-ctx-badge--<source>` color rules, generated from the single
 * ./SourceLabels.ts SOURCE_META table so a new source's color lives in one
 * place. NOTE: buildSidebarCss's return value is a single template literal —
 * no unescaped backtick anywhere in it (including inside comments), or the
 * literal terminates early and breaks the whole file's parsing. The
 * generated-rules expression below uses plain string concatenation for the
 * same reason.
 */
import { SOURCE_META } from "./SourceLabels.js";

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

  /* position:relative makes this the containing block for the absolutely
     positioned .branch-footer so the bar pins to the sidebar's bottom edge. */
  .sidebar-root { display: flex; flex-direction: column; height: 100%; position: relative; }
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

  /* Header bar — the breadcrumb row, sitting directly under the view-switch.
     The Settings (gear) and Status (pulse) actions that used to live in a
     right-side icon strip here are now native view/title contributions in the
     editor's "JOLLI MEMORY" title bar, so this row holds only the breadcrumb. */
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
  /* View switch — the three primary views (Current Branch / Memory Bank /
     Knowledge) as a segmented text-button row. It sits above the breadcrumb
     header, directly under the native "JOLLI MEMORY" title bar. Each button
     carries data-tab so the script switchTab dispatch (and the .active sync,
     broadened to data-tab) drives it. */
  .view-switch {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 2px 6px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    flex-shrink: 0;
  }
  .view-tab {
    flex: 1 1 0;
    padding: 5px 8px;
    border: none;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    border-radius: 3px;
    font-size: 11px;
    font-family: inherit;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .view-tab:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  .view-tab.active {
    background: var(--vscode-toolbar-activeBackground, rgba(0,122,204,0.2));
    color: var(--vscode-foreground);
    font-weight: 600;
  }

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
  /* Shared chrome for the toolbar's left-side status indicator. Used by the
     Branch tab (post-commit "AI summary in progress…" worker signal) and the
     Memory Bank tab (per-phase sync indicator pushed by StatusOrchestrator).
     flex:1 1 auto pushes the refresh button to the right edge — same packing
     trick as .kb-search-box. min-width:0 lets the label truncate gracefully
     on narrow sidebars. */
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
  /* Sticky-error variant: shown when a sync round ends in terminal failure
     so the user keeps seeing *where* it broke until the next round. The
     icon picks up VS Code's errorForeground so it reads as a problem
     rather than ongoing work. */
  .toolbar-worker-icon-error {
    color: var(--vscode-errorForeground, var(--vscode-editorError-foreground, #f48771));
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
  /* Small inline-row variant — Plans & Notes rows carry two trailing buttons
     (✎ + 🗑), so the default 24x22/14px footprint reads heavier than the
     single View Memory eye on Memories rows. 20x18/12px keeps both icons
     visually subordinate to the row label while staying a comfortable click
     target. The .codicon override is required: codicon.css pins font: 16px
     directly on .codicon[class*='codicon-'] with (0,2,0) specificity, so a
     font-size on the button alone never reaches the glyph (same reason
     .tree-node .icon .codicon overrides it explicitly above). */
  .iconbtn--sm {
    width: 20px;
    height: 18px;
    font-size: 12px;
  }
  .iconbtn--sm .codicon {
    font-size: 12px;
  }

  .tab-content {
    flex: 1;
    overflow: auto;
    overflow-x: hidden;
  }
  /* Reserve space for the fixed-height .branch-footer (44px) that overlays the
     bottom of the sidebar in the Current Branch view, so the last rows can
     scroll clear of it rather than hiding behind it. Harmless on other tabs. */
  #tab-content-branch { padding-bottom: 52px; }
  .placeholder { padding: 16px; color: var(--vscode-descriptionForeground); font-style: italic; }
  .empty-state {
    padding: 12px 14px;
    text-align: left;
    color: var(--vscode-descriptionForeground);
    line-height: 1.5;
  }
  /* Secondary hint line under an empty-state's headline (e.g. the Pinned
     section's discoverability copy). Smaller + dimmer than the headline. */
  .empty-hint {
    margin-top: 4px;
    font-size: 11px;
    opacity: 0.8;
  }
  /* Pin glyph in the Pinned section header, left of the title. */
  .pinned-glyph { font-size: 13px; opacity: 0.8; flex-shrink: 0; }

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

  /* Foreign-readonly mode banner ("Viewing memories from <repo> / <branch>
     [(read-only)]") prepended to the Memories section body. Quieter than the
     partial-data warning above — informational, not an alert — so the
     muted descriptionForeground color keeps it from competing with the
     section header for attention. Mirrors IntelliJ CommitsPanel's gray
     JBLabel above the foreign rows. */
  .foreign-banner {
    margin: 4px 8px;
    padding: 2px 4px 6px 4px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
  }

  /* Inline "Switch back to current workspace" affordance trailing the
     foreign-banner text. Rendered as a <button> for CSP/a11y (no inline
     onclick, no javascript: href) but styled as a link so it reads as
     "click me to navigate" rather than "form submit". Inherits the banner's
     11px font-size so the chip and text line up baseline-to-baseline. */
  .foreign-banner-reset {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: var(--vscode-textLink-foreground, var(--vscode-foreground));
    cursor: pointer;
    text-decoration: underline;
  }
  .foreign-banner-reset:hover,
  .foreign-banner-reset:focus-visible {
    color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground, var(--vscode-foreground)));
    outline: none;
  }

  .collapsible-section { display: flex; flex-direction: column; }
  .collapsible-section .section-header {
    display: flex;
    align-items: center;
    /* Positioning context for the absolutely-positioned .section-actions
       overlay below (it pins to this header's right edge on hover). */
    position: relative;
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
  /* Content-width (NOT flex:1) so the inline worker signal ("AI summary in
     progress…" / "Updating Memory Bank…") sits flush against the title rather
     than being pushed to the right edge by a growing title — the slack now
     falls to the right of the worker-status instead. nowrap keeps the title on
     one line; when the row genuinely overflows, the title's min-content (the
     full nowrap text) can't shrink, so the deficit is absorbed by the
     worker-status, which carries min-width:0 + ellipsis and truncates. */
  .collapsible-section .section-title { white-space: nowrap; }
  /* Section-header actions are ALWAYS visible (not hover-revealed) so the
     affordances (Context's +, Committed Memories' squash / push / refresh) stay
     discoverable. In-flow with margin-left:auto pins them to the header's right
     edge; the title (content-width) and the inline worker-status sit flush to
     the left of the auto gap. Since they never toggle in/out, there's no
     reveal-reflow to guard against — the old position:absolute + visibility
     overlay was only needed for the hover model. Mirrors .memory-group-header
     .section-actions below. */
  .collapsible-section .section-actions {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }
  .collapsible-section.collapsed .section-body { display: none; }

  /* Compact build pill (Wiki / Graph) for the non-blocking Memory Bank build in
     the Committed Memories header. Mirrors the .section-ai-pill chrome below but
     carries a spinner instead of the pulsing dot. The short phase word never
     truncates; the verbose "Building knowledge …" label lives in the title
     attribute for hover/accessibility. */
  .collapsible-section .section-build-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 4px;
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: none;
    flex: 0 0 auto;
  }
  .collapsible-section .section-build-pill .section-build-spin { font-size: 11px; }

  /* Compact "● AI" pill that replaces the verbose blocking-summary text in the
     Committed Memories header (the detail now lives in the Working Memory
     "Summarizing <hash>…" row). The dot pulses to read as "working". */
  .collapsible-section .section-ai-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 4px;
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: none;
    flex: 0 0 auto;
  }
  .collapsible-section .section-ai-pill .section-ai-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    animation: jm-ai-pulse 1.4s ease-in-out infinite;
  }
  @keyframes jm-ai-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

  /* Working Memory "Summarizing <hash>…" progress row. Reuses .tree-node
     layout; the spinner sits in the standard 16px .icon column so it aligns
     with conversation rows below it. Muted, non-interactive (read-only). */
  .tree-node.summarizing-row { cursor: default; color: var(--vscode-descriptionForeground); font-style: italic; }
  .tree-node.summarizing-row .icon.summarizing-icon { color: var(--vscode-charts-blue); }
  .tree-node.summarizing-row .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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

  /* Current Memory group — wraps the Conversations / Context / Files
     sub-sections under one heading so they read as the next memory's draft. */
  .memory-group { display: flex; flex-direction: column; }
  /* Current Memory header now reads as a collapsible section header: chevron +
     uppercase title + hover-revealed actions (Select All / Refresh). Mirrors
     .collapsible-section .section-header so the two top-level blocks (Current
     Memory and Committed Memories) share one visual rhythm. */
  .memory-group-header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    cursor: pointer;
    user-select: none;
    color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    background: var(--vscode-sideBarSectionHeader-background, transparent);
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
  }
  .memory-group-header .section-title { flex: 1; }
  /* Always-visible actions, matching .collapsible-section .section-actions. */
  .memory-group-header .section-actions {
    display: inline-flex;
    gap: 2px;
    margin-left: auto;
    flex-shrink: 0;
  }
  .memory-group-body { display: flex; flex-direction: column; }
  .subsection .section-title { font-size: 11px; opacity: 0.8; padding-left: 6px; }
  /* Sub-sections (Conversations / Context / Files) no longer collapse on their
     own — they carry no chevron and the Working Memory group header owns the
     fold. Drop the inherited pointer cursor so the header reads as inert. */
  .subsection .section-header { cursor: default; }
  /* Sub-section rows carry two leading slots that are dead space here:
       1. the empty 12px .twirl placeholder (column-aligns with expandable
          commit rows elsewhere — but conversation / plan / note / reference /
          change rows never expand), and
       2. the 18px .row-leading checkbox slot — in Working Memory the include
          checkbox is hidden (the ✕/+ exclude toggle in the hover actions is the
          real control; the box is just a DOM state-holder), so its slot reserves
          width nobody sees.
     Both pushed the leading icon out to ~36px, far right of the chevron-less
     sub-section title (8px header pad + 6px title pad-left = 14px). Drop both
     placeholders and pull the row in to 14px so the leading icon (or, for the
     icon-less Files rows, the filename) column-aligns with the title text. The
     show-more toggle (sub-section-only) and its chevron follow the same column.
     The empty-state is left-aligned text with its own padding, so it's exempt. */
  .subsection .section-body .tree-node { padding-left: 14px; }
  .subsection .section-body .tree-node > .twirl { display: none; }
  .subsection .section-body .tree-node > .row-leading { display: none; }
  .subsection .section-body .show-more-row { padding-left: 14px; }
  /* Pinned rows are top-level .tree-node (not .subsection), so they'd otherwise
     keep the default 8px padding plus the silent 12px .twirl placeholder — which
     pushed their leading icon ~10px right of the Working Memory sub-section rows
     (Conversations / Context / Files) below, breaking the left-alignment between
     the two blocks. Pinned rows never expand, so the .twirl is dead space here
     too: mirror the sub-section treatment (drop it, pull the row in to 14px) so
     the pinned icon column lands in the same column as the sub-section icons.
     Direct-child combinator scopes this to the Pinned body, matching the
     min-height rule below. */
  .collapsible-section[data-section="pinned"] > .section-body .tree-node { padding-left: 14px; }
  .collapsible-section[data-section="pinned"] > .section-body .tree-node > .twirl { display: none; }
  /* Each Current Memory sub-section (Conversations / Context / Files), plus the
     top-level Pinned and Committed Memories sections, reserves at least ~4 rows
     of height (~22px/row) so the blocks keep a stable rhythm and don't collapse
     to a thin strip when they have few or no items. Pinned and Committed are
     plain .collapsible-section (no .subsection class), so they're matched by
     data-section and use a direct-child combinator to avoid reaching into the
     Current Memory group's nested sub-section bodies. section-body has no
     overflow clip, so this is a floor only — a block with more than 4 rows grows
     past it naturally (up to the SUBSECTION_PREVIEW cap, then "Show N more"). */
  .subsection .section-body,
  .collapsible-section[data-section="pinned"] > .section-body,
  .collapsible-section[data-section="commits"] > .section-body { min-height: 88px; }

  /* Unified expand/collapse chevron for every Branch-tab collapsible block
     (Current Memory + sub-sections + Pinned + Committed Memories). The codicon
     glyph itself encodes direction (chevron-down open / chevron-right closed),
     so — unlike the old text .twirl — there is no rotation transform.
     Selector is .codicon.section-twirl (NOT a bare .section-twirl): codicon.css
     pins font:16px on .codicon[class*='codicon-'] at (0,2,0) specificity, so a
     plain (0,1,0) .section-twirl loses and the glyph renders at 16px — visibly
     larger than the (0,2,0) .tree-node .commit-twirl on committed-memory rows.
     Matching it to (0,2,0) here ties codicon and wins on source order, landing
     the chevron at 12px to mirror .commit-twirl (same fix as .iconbtn--sm
     .codicon above). */
  .codicon.section-twirl {
    width: 12px;
    flex-shrink: 0;
    font-size: 12px;
    line-height: 1;
    color: var(--vscode-foreground);
  }
  /* Item-count after a sub-section title (Conversations 7). Muted + slightly
     smaller so it reads as metadata, not part of the label. */
  .section-count {
    margin-left: 6px;
    font-weight: 400;
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
  }
  /* "Show N more" / "Show less" toggle row at the bottom of a capped
     sub-section. Indented to align with row content; reads as a quiet,
     clickable affordance rather than a data row. */
  .show-more-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px 3px 20px;
    cursor: pointer;
    font-size: 11px;
    color: var(--vscode-textLink-foreground, var(--vscode-descriptionForeground));
    user-select: none;
  }
  .show-more-row:hover { background: var(--vscode-list-hoverBackground, transparent); }
  .show-more-row .section-twirl { color: inherit; }

  .tree-node {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    padding-left: 8px;
    cursor: pointer;
    white-space: nowrap;
    user-select: none;
    /* Containing block for the absolutely-positioned hover .inline-actions
       overlay (Conversations / Context / Changes rows) — see below. */
    position: relative;
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
  /* Per-repo "view knowledge graph" button: right-aligned, revealed on row hover. */
  .tree-node .repo-graph-btn {
    margin-left: auto;
    flex-shrink: 0;
    padding: 0 2px;
    opacity: 0;
    color: var(--vscode-descriptionForeground);
  }
  .tree-node:hover .repo-graph-btn { opacity: 1; }
  .tree-node .repo-graph-btn:hover { color: var(--vscode-foreground); }
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
  /* Changes rows stack filename over directory (matching committed-memory
     .mef-text Files rows) instead of the inline dirname commit-file rows use.
     The column wrapper takes the row's flexible middle; the filename .label
     inside keeps its own ellipsis, the dir line is muted + smaller below. */
  .tree-node.tree-node--changes .change-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .tree-node.tree-node--changes .change-text .label { flex: 0 0 auto; max-width: 100%; }
  .tree-node.tree-node--changes .change-dir {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tree-node[data-context="commitFile"] .desc {
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
  /* Changes rows trailing layout: the always-visible gs-letter (M/A/D) sits at
     the right edge via its inherited margin-left:auto; the hover-only discard
     button overlays the right edge ON TOP of it (absolute, out of flow) so the
     filename/dir content gets the full row width and the discard never reserves
     a slot or reflows the row. Mirrors the .section-actions header overlay. */
  .tree-node.tree-node--changes .inline-actions {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 8px;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    /* Fade gap + opaque backing so the covered text/letter doesn't bleed
       through; the gradient over a solid base reproduces the hovered row
       background exactly (list-hover tint composited over the sidebar bg). */
    padding-left: 8px;
    background-color: var(--vscode-sideBar-background, var(--vscode-editor-background));
    background-image: linear-gradient(var(--vscode-list-hoverBackground), var(--vscode-list-hoverBackground));
    visibility: hidden;
  }
  .tree-node.tree-node--changes:hover .inline-actions { visibility: visible; }

  /* Hover-revealed inline actions (Conversations rows + Context plan/note/
     reference rows + the expanded-commit memory row). The Pin affordance — and,
     for these rows, edit/remove — surfaces only on hover, matching VS Code's
     native tree row behavior. Floated OUT of the flex flow (position:absolute,
     pinned to the right edge) so they claim zero layout width while idle — the
     row content (title + trailing metadata chips) gets the full width instead
     of leaving an icon-buttons' slot reserved — and overlay the right edge on
     hover, riding on an opaque backing so the content underneath doesn't bleed
     through. Mirrors the .section-actions header overlay; visibility (not
     display) keeps the no-reflow guard valid. */
  .tree-node--hover-actions .inline-actions {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 8px;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding-left: 8px;
    background-color: var(--vscode-sideBar-background, var(--vscode-editor-background));
    background-image: linear-gradient(var(--vscode-list-hoverBackground), var(--vscode-list-hoverBackground));
    visibility: hidden;
  }
  .tree-node--hover-actions:hover .inline-actions { visibility: visible; }

  /* CONVERSATIONS section rows: one active AI session per row. Inherits the
     base .tree-node flex layout (gap: 4px) so the leading checkbox / icon
     column-aligns with plan, note, and change rows in the sibling sections.
     The wider 8px breathing room around the trailing metadata chips
     (badge / count / time) is restored via per-chip margin-left below —
     overriding the row-level gap would also widen twirl → row-leading and
     break section column alignment. */
  .tree-node.conversation-row .badge,
  .tree-node.conversation-row .edited-icon,
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

  /* "Edited" marker — codicon-edit pencil glyph rendered inline after the
     row title. Intentionally a thin icon (no pill / border / fill) so it
     reads as a status modifier on the title rather than a second badge
     competing with the AI agent badge for visual weight. Color follows
     VS Code's standard "modified file" hue for cross-product consistency.
     Same visual treatment is reused on KB folders-tree file rows
     (data-kind="file") for the on-disk-divergence ✎ marker — the rule
     below repeats the visual block under that scope rather than relaxing
     to a bare ".edited-icon" so unrelated future ".edited-icon" usages
     don't silently inherit conversation-row spacing. */
  .tree-node.conversation-row .edited-icon {
    font-size: 12px;
    color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-focusBorder));
    flex-shrink: 0;
  }
  .tree-node[data-kind="file"] .edited-icon {
    font-size: 12px;
    color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-focusBorder));
    flex-shrink: 0;
  }

  .tree-node.conversation-row .count,
  .tree-node.conversation-row .time {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
  }

  /* Conversation-type glyph: per-source brand <svg> ported from the IntelliJ
     icon set. The .icon column is already 16px; flex-center the svg so the
     glyph sits on the text mid-line regardless of its internal padding (the
     old trailing source-dot relied on .tree-node align-items:center, but an
     svg needs the box explicitly centered). Neutral marks inherit color via
     currentColor; brand-colored marks (Claude/Codex/Gemini) carry their own. */
  .tree-node .icon.conv-source-icon { display: inline-flex; align-items: center; justify-content: center; color: var(--vscode-icon-foreground); }
  .conv-source-svg { width: 16px; height: 16px; display: block; }
  .conversation-row .msgs { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 0.9em; white-space: nowrap; }
  .conversation-row .usage-note { color: var(--vscode-descriptionForeground); opacity: 0.7; font-size: 0.85em; margin-left: 6px; white-space: nowrap; }

  .memory-row {
    padding: 6px 12px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.1));
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    /* Containing block for the absolutely-positioned hover .inline-actions. */
    position: relative;
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
  /* Hover-only buttons matching the legacy native TreeView UX. Floated OUT of
     the flex flow (position:absolute, pinned to the row's right edge so it
     aligns with the row's 12px right padding) so they claim zero layout width
     while idle — the title/meta column gets the full width — and overlay the
     right edge on hover, riding on an opaque backing so the meta line beneath
     doesn't bleed through. Mirrors the .section-actions header overlay;
     visibility (not display) keeps the no-reflow guard valid. */
  .memory-row .inline-actions {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 12px;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding-left: 8px;
    background-color: var(--vscode-sideBar-background, var(--vscode-editor-background));
    background-image: linear-gradient(var(--vscode-list-hoverBackground), var(--vscode-list-hoverBackground));
    visibility: hidden;
  }
  .memory-row:hover .inline-actions { visibility: visible; }
  /* Strikethrough-exclude (Working Memory). Rows are included by default;
     the ✕/+ .row-excl button leaves an item out (reversible). On rows that
     carry the toggle the raw include checkbox becomes a hidden state-holder —
     scoped via :has() so squash commit checkboxes (no .row-excl) keep theirs. */
  .tree-node:has(.row-excl) input[type="checkbox"][data-checkbox="1"] { display: none; }
  /* .row-excl inherits the .iconbtn look (it lives inside .inline-actions);
     no standalone box styling — that previously sat in normal flow and the
     absolutely-positioned hover overlay landed on top of it (file rows: the
     Discard icon stacked over it, making it unclickable). */
  /* Excluded row: struck through + dimmed so "left out of this memory" reads
     at a glance. The label carries the line-through; the whole row dims. The
     hover action overlay is exempted so its icons stay legible.
     .ai-excluded is the AI soft-exclude axis (Review-panel relevance ranking),
     deliberately identical in look — both mean "won't go into the next memory"
     — but an independent class: it must never flow through isSelected /
     .excluded, whose axis is the user's manual exclude. */
  .tree-node.excluded .label, .tree-node.ai-excluded .label { text-decoration: line-through; }
  .tree-node.excluded, .tree-node.ai-excluded { opacity: 0.6; }
  .tree-node.excluded:hover, .tree-node.ai-excluded:hover { opacity: 1; }
  /* Twirl chevron that toggles evidence expansion — sits at the very left
     of the memory row (before the M icon). Vertically centered; cursor pointer
     since it is a toggle target, not a full-row action. */
  .memory-twirl {
    flex-shrink: 0;
    width: 14px;
    font-size: 12px;
    cursor: pointer;
    color: var(--vscode-foreground);
    opacity: 0.6;
  }
  .memory-row:hover .memory-twirl { opacity: 1; }
  /* Expanded committed-memory evidence (mockup .mem-files): a full-width block
     under the row — no indent rail, padding only. Groups are separated by a
     top-border divider and a plain uppercase label (no leading codicon), and a
     right-aligned "Hide memory details" button closes it. */
  .memory-evidence {
    padding: 2px 10px 4px;
  }
  .memory-evidence-empty,
  .memory-evidence-loading {
    padding: 4px 10px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  /* Groups (Conversations / Context / Files) are separated by whitespace only —
     no divider rule — matching the mockup's .mem-files .mem-group. The label is
     small uppercase tertiary text; the breathing room above each group reads as
     the separation. */
  .memory-evidence-group { margin-top: 0; }
  .memory-evidence-group-label {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--vscode-descriptionForeground);
    padding: 6px 0 1px;
  }
  .memory-evidence-group:first-child .memory-evidence-group-label {
    padding-top: 1px;
  }
  /* Right-aligned bottom collapse (mockup .mem-collapse). */
  .memory-evidence-collapse {
    display: flex;
    align-items: center;
    gap: 4px;
    width: fit-content;
    margin: 6px 0 2px auto;
    padding: 4px 2px;
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    cursor: pointer;
  }
  .memory-evidence-collapse:hover { color: var(--vscode-textLink-foreground); }
  .memory-evidence-collapse .codicon { font-size: 10px; }
  .memory-evidence-rows { display: flex; flex-direction: column; }
  .memory-evidence-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px;
    border-radius: 2px;
    cursor: pointer;
    font-size: 11px;
    color: var(--vscode-foreground);
    overflow: hidden;
  }
  .memory-evidence-row:hover { background: var(--vscode-list-hoverBackground); }
  /* Foreign-repo file rows: shown for context but not openable (the workspace
     git can't diff a foreign commit). Default cursor + no hover affordance. */
  .memory-evidence-row--static { cursor: default; }
  .memory-evidence-row--static:hover { background: transparent; }
  .memory-evidence-row .codicon { font-size: 12px; flex-shrink: 0; }
  .memory-evidence-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* File evidence rows: filename (tinted by git-status .gs-{code}) stacked over
     the muted directory path, with the trailing status letter pushed to the
     right edge. Mirrors the mockup's two-line file treatment — distinct from
     the single-line Branch-tab commit-file rows. */
  .memory-evidence-file { align-items: center; }
  .memory-evidence-file .mef-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .memory-evidence-file .mef-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .memory-evidence-file .mef-dir {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .memory-evidence-row .gs-letter {
    margin-left: auto;
    padding-left: 6px;
    font-size: 11px;
    font-weight: 500;
    flex-shrink: 0;
  }
  /* Context evidence badge: a small solid square with a single white letter,
     hue keyed by kind/source. Replaces the previous monochrome codicon so the
     plan / note / reference provenance reads at a glance (mockup parity). */
  .mem-ctx-badge {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    border-radius: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
    color: #fff;
    background: var(--vscode-descriptionForeground);
  }
  .mem-ctx-badge--plan      { background: #3fb950; }
  .mem-ctx-badge--note      { background: #d29922; }
  ${Object.entries(SOURCE_META)
		// biome-ignore lint/style/useTemplate: must stay backtick-free (see file header re: the backtick trap)
		.map(([id, meta]) => "  .mem-ctx-badge--" + id + " { background: " + meta.color + "; }")
		.join("\n  ")}
  .mem-ctx-badge--reference { background: #6e7681; }
  /* Conversation evidence: trailing "N msgs" count. The leading glyph is the
     shared per-source brand icon (.conv-source-icon), so the agent identity
     reads identically here, on the live CONVERSATIONS rows, and on Pinned. */
  .memory-evidence-row .msgs {
    margin-left: auto;
    padding-left: 6px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* SHIPPED group — Push-to-Jolli status + Create-PR action rows rendered
     above the evidence groups in an expanded committed-memory row. */
  .shipped-group {
    padding: 4px 10px 2px;
  }
  .shipped-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px;
    border-radius: 2px;
    font-size: 11px;
    color: var(--vscode-foreground);
  }
  .shipped-row--action {
    cursor: pointer;
  }
  .shipped-row--action:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .shipped-row--synced {
    color: var(--vscode-charts-green, var(--vscode-testing-iconPassed, #73c991));
  }
  .shipped-row .codicon {
    font-size: 12px;
    flex-shrink: 0;
  }
  .shipped-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .shipped-link {
    font-size: 11px;
    color: var(--vscode-textLink-foreground);
    flex-shrink: 0;
  }
  .shipped-link:hover {
    text-decoration: underline;
  }
  /* Status chips inside the SHIPPED group rows (PR open / Synced). */
  .ship-badge {
    display: inline-flex;
    align-items: center;
    padding: 0 4px;
    border-radius: 2px;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }
  .ship-badge--open {
    background: color-mix(in srgb, var(--vscode-charts-green, var(--vscode-testing-iconPassed, #73c991)) 20%, transparent);
    color: var(--vscode-charts-green, var(--vscode-testing-iconPassed, #73c991));
  }
  .ship-badge--synced {
    background: color-mix(in srgb, var(--vscode-charts-green, var(--vscode-testing-iconPassed, #73c991)) 20%, transparent);
    color: var(--vscode-charts-green, var(--vscode-testing-iconPassed, #73c991));
  }

  /* "Show memory details" affordance for a collapsed committed-memory row.
     Rendered on its OWN line below the row (not crammed onto the title line),
     right-aligned, so the title gets the full row width and the expander reads
     as a distinct control. When expanded the row-level toggle is dropped — the
     evidence block's bottom .memory-evidence-collapse is the sole "Hide" control
     (matching the mockup, which hides the chips line on expand). */
  .mem-details-line {
    display: flex;
    justify-content: flex-end;
    padding: 0 12px 4px;
  }
  /* Mirrors the mockup's .mem-evd: a quiet inline expander (no underline) with a
     trailing disclosure chevron, reading as a control rather than body text or a
     navigation link. */
  .commit-memory-details-toggle {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .commit-memory-details-toggle:hover {
    color: var(--vscode-textLink-foreground);
  }
  .memory-details-chevron { font-size: 10px; }

  /* Row subline under the committed-memory title row: "2h ago · hash · tokens".
     Quiet secondary line — description foreground, smaller text, left-aligned
     to sit naturally under the label. Indented via padding-left to clear the
     leading icon column (twirl + row-leading + icon slot = ~56px). */
  .mem-subline {
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    gap: 3px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 0 8px 3px 56px;
    line-height: 1.3;
  }
  /* Hash segment is monospace so the 8-char hash reads at a glance. */
  .mem-sub-hash {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
    opacity: 0.85;
  }
  /* Middle-dot separators match the muted subline tone. */
  .mem-sub-sep {
    color: var(--vscode-descriptionForeground);
    opacity: 0.6;
    padding: 0 1px;
  }

  /* Memory Bank repo filter ("Showing: <repo>") — replaces the branch
     breadcrumb segment on the Memory Bank / Knowledge views. Hidden by
     default (.hidden in the HTML); the script removes .hidden when
     activeTab === 'kb' and adds it back on other tabs. */
  .repo-filter { display: inline-flex; align-items: center; gap: 5px; padding: 2px 4px 2px 6px; min-width: 0; flex: 1 1 auto; }
  .repo-filter-label { font-size: 11px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }

  /* Memory Bank Timeline — relative-time group headers. */
  .tl-group-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    padding: 8px 14px 2px;
  }

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
  /* The reference card reuses the sidebar's per-source context badge
     (.mem-ctx-badge, coloured by SOURCE_META hue) so the provider chip looks
     identical here and on the context rows. .hc-title stays a plain block (the
     three text-only memory / plan / note cards share it), so nudge the inline
     badge to sit centred against the first title line with a little breathing
     room before the title text. */
  .hover-card .hc-title .mem-ctx-badge {
    margin-right: 6px;
    vertical-align: middle;
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
  /* Actions row pins to the card's bottom edge so the hash + View Memory
     link stays visible even when positionHoverCard falls back to a capped
     maxHeight + overflowY:auto (narrow sidebars where stats wraps to 2+
     lines, or very long commit messages). The background match is what
     prevents text scrolled underneath the sticky row from bleeding through. */
  .hover-card .hc-actions {
    display: flex;
    gap: 12px;
    align-items: center;
    position: sticky;
    bottom: 0;
    background: var(--vscode-editorHoverWidget-background);
  }
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
  /* ── Back-fill cold-start card ────────────────────────────────────────
     Bordered card (mirrors the mockup's .setup-card) rendered at the TOP of
     the Branch tab, above the PINNED section — NOT a full-viewport panel; the
     breadcrumb + all other sections stay visible. The ✓ "you're set up" note
     and the 🔒 honest footer each sit under a top-border divider (mockup
     .sf-auto / .sf-honest). Reuses .ob-title / .ob-btn; all colors are theme
     tokens. Progress bar uses fixed-width classes (no inline style, CSP). */
  .backfill-panel {
    position: relative;
    margin: 10px;
    padding: 14px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 11px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    box-sizing: border-box;
  }
  .bf-header { position: relative; }
  .bf-dismiss {
    position: absolute;
    top: -4px;
    right: -4px;
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    line-height: 1;
  }
  .bf-dismiss:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-foreground); }
  .bf-benefits { display: flex; flex-direction: column; gap: 8px; margin: 10px 0 2px 0; }
  .bf-benefit { display: flex; gap: 9px; align-items: flex-start; font-size: 12px; line-height: 1.45; color: var(--vscode-descriptionForeground); }
  .bf-benefit b { color: var(--vscode-foreground); font-weight: 650; }
  .bf-benefit-icon { color: var(--vscode-textLink-foreground); font-size: 15px; margin-top: 1px; flex-shrink: 0; }
  /* ✓ "You're set up" note — top-border divider + green check (mockup .sf-auto). */
  .bf-note {
    display: flex;
    gap: 7px;
    align-items: flex-start;
    font-size: 11.5px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.4;
    margin: 9px 0 0 0;
    padding-top: 9px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  .bf-note-icon { color: var(--vscode-charts-green, var(--vscode-testing-iconPassed, var(--vscode-terminal-ansiGreen))); font-size: 14px; margin-top: 1px; flex-shrink: 0; }
  .bf-note-icon--err { color: var(--vscode-errorForeground); }
  /* 🔒 honest footer — top-border divider (mockup .sf-honest). */
  .bf-honest {
    font-size: 10.5px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.45;
    margin: 9px 0 0 0;
    padding-top: 9px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  .bf-cta { margin-top: 11px; }
  .bf-cta .codicon, .bf-open .codicon { vertical-align: text-bottom; margin-right: 2px; }
  .bf-prog { display: flex; gap: 8px; align-items: center; font-size: 13px; margin: 4px 0 10px 0; }
  .bf-prog .codicon { color: var(--vscode-textLink-foreground); }
  /* Candidate list */
  .bf-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 6px;
    overflow: hidden;
    margin-bottom: 10px;
  }
  .bf-row {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 8px 10px;
    cursor: pointer;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  .bf-list .bf-row:last-child { border-bottom: none; }
  .bf-row:hover { background: var(--vscode-list-hoverBackground); }
  .bf-row-cb { margin-top: 2px; accent-color: var(--vscode-checkbox-background); flex: none; }
  .bf-row-main { flex: 1; min-width: 0; }
  .bf-row-title {
    font-size: 12px;
    color: var(--vscode-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bf-row-meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .bf-older { margin: 0 0 10px 0; }
  .bf-link {
    background: transparent;
    border: none;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    font-size: 12px;
    padding: 0;
    text-align: left;
  }
  .bf-link:hover { text-decoration: underline; }
  /* Progress bar — width via fixed classes (CSP: no inline style). */
  .bf-bar {
    height: 4px;
    border-radius: 2px;
    background: var(--vscode-progressBar-background, var(--vscode-editorWidget-border));
    overflow: hidden;
    margin: 0 0 6px 0;
  }
  .bf-bar-fill { display: block; height: 100%; background: var(--vscode-progressBar-background, var(--vscode-textLink-foreground)); transition: width 0.2s ease; }
  .bf-bar-fill--w0 { width: 0%; }
  .bf-bar-fill--w10 { width: 10%; }
  .bf-bar-fill--w20 { width: 20%; }
  .bf-bar-fill--w30 { width: 30%; }
  .bf-bar-fill--w40 { width: 40%; }
  .bf-bar-fill--w50 { width: 50%; }
  .bf-bar-fill--w60 { width: 60%; }
  .bf-bar-fill--w70 { width: 70%; }
  .bf-bar-fill--w80 { width: 80%; }
  .bf-bar-fill--w90 { width: 90%; }
  .bf-bar-fill--w100 { width: 100%; }
  /* Result list */
  .bf-result-list { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 12px 0; }
  .bf-result-row { display: flex; gap: 8px; align-items: center; font-size: 12px; }
  .bf-result-icon { color: var(--vscode-textLink-foreground); font-size: 14px; flex: none; }
  .bf-result-row .bf-row-title { flex: 1; }
  .bf-chip {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 8px;
    padding: 1px 7px;
    white-space: nowrap;
    flex: none;
  }
  .bf-chip--err { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
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

  /* Pinned to the bottom of the sidebar (the .sidebar-root box is the
     positioning context — see its position:relative). absolute (not sticky)
     so the bar holds a fixed-height strip at the bottom regardless of how the
     scrollable branch content above it grows or scrolls; #tab-content-branch
     carries a matching padding-bottom so the last rows clear it. */
  .branch-footer {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 44px;
    box-sizing: border-box;
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 0 8px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
  }
  .commit-review-bar { display: flex; gap: 6px; padding: 8px 12px; }
  /* Squash confirm bar — top of the Committed Memories body while in squash
     selection mode. The count takes the flexible slack on the left; Select-all,
     Squash and Cancel stay grouped on the right. nowrap + a shrinkable count
     (flex:1 / min-width:0) means a long count WRAPS ITS OWN TEXT to a second
     line rather than pushing the rigid buttons onto a new row. */
  .squash-bar {
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    gap: 6px;
    padding: 6px 10px;
    margin-bottom: 4px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    border-radius: 4px;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
  }
  .squash-count { flex: 1 1 auto; min-width: 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .squash-select-all {
    flex-shrink: 0;
    background: none;
    border: none;
    padding: 0;
    font-size: 11px;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    white-space: nowrap;
  }
  .squash-select-all:hover { text-decoration: underline; }
  /* Squash/Cancel hug their labels and never shrink, so the count yields space
     first. Select-all sits directly left of Squash (no auto gap between them). */
  .squash-bar .cmd-btn { flex: 0 0 auto; }
  /* Shared command-button look — used by the Working Memory Commit/Review bar
     AND the branch footer. Previously the visual styling lived ONLY under
     .branch-footer .cmd-btn, so the Commit/Review bar buttons rendered as bare
     unstyled buttons (no padding / primary fill). This generic base fixes that;
     per-container rules below only set flex sizing. Surfaces ride the VS Code
     button tokens so themes are respected. */
  .cmd-btn {
    flex: 1;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 5px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cmd-btn.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: transparent;
  }
  .cmd-btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  .cmd-btn.primary:hover { background: var(--vscode-button-hoverBackground); }
  .cmd-btn:disabled { opacity: 0.5; cursor: default; }
  .cmd-btn.aa-more { flex: 0 0 auto; }
  /* Commit Memory leads — the primary gets a bit more width than Review. */
  .commit-review-bar .cmd-btn { flex: 1 1 auto; }
  .commit-review-bar .cmd-btn.primary { flex-grow: 1.7; }
  /* flex:1 — footer action buttons (Create PR / Share) share the bar's width
     equally; min-width:0 + ellipsis lets labels truncate on a narrow sidebar.
     The overflow (...) button hugs its glyph (flex:0 0 auto). */
  .branch-footer .cmd-btn { flex: 1; min-width: 0; }
  .branch-footer .cmd-btn.aa-more { flex: 0 0 auto; }

  /* ── Token-usage bar (Committed Memories, non-foreign only) ──────────────
     .token-bar-wrap  outer container with section-matched padding
     .token-bar-label label line: "1.8M tokens · this branch"
     .token-bar       horizontal pill bar (input=green / output=blue)
     .token-seg       one colored segment inside the bar
     .token-bar-legend two-item row: "<n> input  <n> output"
     Segment widths are exact percentages set as a JS property (el.style.width)
     by renderTokenBar — CSP forbids an inline style attribute but allows the
     property write — so there are no bucketed width classes. Mirrors the
     memory-detail bar (SummaryHtmlBuilder buildTokenMeter). */
  .token-bar-wrap { padding: 4px 12px 8px; }
  /* Label line + trailing "?" help affordance share one row so the icon hugs
     the right edge (margin-left:auto) without an inline style. */
  .token-bar-label-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .token-bar-label { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .token-bar-help { margin-left: auto; display: inline-flex; align-items: center; color: var(--vscode-descriptionForeground); opacity: 0.7; cursor: pointer; flex: 0 0 auto; }
  .token-bar-help:hover { opacity: 1; }
  .token-bar-help .codicon { font-size: 13px; }
  .token-bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: var(--vscode-input-background); }
  .token-seg { display: block; height: 100%; }
  .token-seg--input { background: var(--vscode-charts-green, #4ec9b0); }
  /* Cached sits between input and output as a neutral gray segment. */
  .token-seg--cached { background: var(--vscode-descriptionForeground); opacity: 0.5; }
  .token-seg--output { background: var(--vscode-charts-blue, #4fc1ff); }
  .token-bar-legend { display: flex; gap: 12px; margin-top: 4px; font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  .tk-leg--input::before { content: ''; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-charts-green, #4ec9b0); margin-right: 4px; vertical-align: middle; }
  .tk-leg--output::before { content: ''; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-charts-blue, #4fc1ff); margin-right: 4px; vertical-align: middle; }
  .tk-leg--cached::before { content: ''; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: 0.5; margin-right: 4px; vertical-align: middle; }
  `;
}
