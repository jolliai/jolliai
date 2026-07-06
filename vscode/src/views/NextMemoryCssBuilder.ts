/**
 * NextMemoryCssBuilder
 *
 * Styles for the Next Memory review panel — the editor-column mirror of the
 * sidebar's Working Memory card, mocked up as jollimemory-design's
 * `#pane-working`. Uses the same VS Code theme CSS variables as the other
 * webviews (SummaryCssBuilder / SidebarCssBuilder) for light/dark parity.
 *
 * Token-meter segment widths use bucketed `.seg--wN` classes (N = 0..100 step
 * 10) rather than an inline `style="width"` — the webview CSP has no
 * `unsafe-inline` for styles. This mirrors the sidebar's own token bar
 * (`token-seg--wN`); the output segment takes the flex remainder.
 */
export function buildNextMemoryCss(): string {
	const widthBuckets = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
		.map((n) => `.seg--w${n} { width: ${n}%; }`)
		.join("\n");
	return [
		// Design tokens shared with the committed-memory panel (SummaryCssBuilder):
		// subtle pill/chip surfaces + status hues that VS Code doesn't expose as
		// theme variables. Light defaults in :root; dark overrides on body.
		// Branch pill is blue-tinted per the mockup (mock-kit.css .meta-branch);
		// the rest are neutral surface/status tokens shared with the CreatePr panel.
		":root { --surface-hover: rgba(0,0,0,0.028); --text-secondary: rgba(0,0,0,0.45); --text-tertiary: rgba(0,0,0,0.32); --pill-bg: rgba(63,133,245,0.12); --pill-text: #2b73ee; --ship-ok: #1b8a4f; --ship-warn: #96680e; }",
		"body.vscode-dark, body.vscode-high-contrast { --surface-hover: rgba(255,255,255,0.035); --text-secondary: rgba(255,255,255,0.45); --text-tertiary: rgba(255,255,255,0.30); --pill-bg: rgba(107,165,248,0.16); --pill-text: #8ab9fa; --ship-ok: #4ece8d; --ship-warn: #e0ac2b; }",
		"body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 14px 16px 24px; line-height: 1.5; }",
		"h1 { font-size: 1.3em; margin: 0 0 8px; }",
		".meta-strip { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; }",
		// The script mounts one .meta-row wrapper into #meta-strip; make it the
		// flex row so the branch pill / chip / diffstat get the mockup's gap.
		".meta-row { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 9px; }",
		".meta-sep { color: var(--text-tertiary); opacity: 0.55; }",
		// Branch pill + NOT-COMMITTED chip + status dot, mirroring SummaryCssBuilder
		// (subtle pill/chip surfaces, amber warn hue for the uncommitted state) —
		// not the heavy solid --vscode-badge-background.
		".meta-branch { display: inline-block; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px 8px; border-radius: 5px; background: var(--pill-bg); color: var(--pill-text); font-size: 11px; }",
		".local-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 11px; background: var(--surface-hover); color: var(--ship-warn); font-size: 10px; font-weight: 650; letter-spacing: 0.02em; }",
		".led { width: 7px; height: 7px; border-radius: 50%; background: var(--text-tertiary); flex-shrink: 0; }",
		".local-chip .led { background: var(--ship-warn); }",
		".muted { font-size: 12.5px; color: var(--vscode-descriptionForeground); margin: 4px 0 12px; }",
		".panel { border: 1px solid var(--vscode-widget-border); border-radius: 6px; margin: 0 0 12px; overflow: hidden; }",
		".panel-header { display: flex; align-items: center; gap: 6px; padding: 6px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-widget-border); }",
		// The count sits immediately after the title (left-aligned), matching the
		// sidebar Working Memory sub-section headers (\"Conversations 7\"). The title
		// is NOT flex:1 — flexing it would shove the count to the far right. The
		// Context \"+\" (.panel-add) keeps its own margin-left:auto to stay at the edge.
		".sec-count { opacity: 0.6; font-variant-numeric: tabular-nums; }",
		// Rows are click-to-open (like the sidebar's Working Memory rows), so they
		// carry a pointer cursor and a subtle hover tint. position:relative is the
		// containing block for the absolutely-positioned .row-actions overlay.
		".row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; position: relative; cursor: pointer; }",
		".row + .row { border-top: 1px solid var(--vscode-widget-border); }",
		".row:hover { background: var(--surface-hover); }",
		".row.excluded .r-title { text-decoration: line-through; }",
		".row.excluded { opacity: 0.55; }",
		".row.excluded:hover { opacity: 1; }",
		".r-main { flex: 1; min-width: 0; }",
		".r-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
		".r-meta { flex-shrink: 0; font-size: 11.5px; color: var(--vscode-descriptionForeground); }",
		// Conversation source icon — the per-source brand glyph (convSourceIcon),
		// matching the sidebar's Working Memory card rather than a text badge.
		".conv-source-icon { flex-shrink: 0; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; color: var(--vscode-icon-foreground); }",
		".conv-source-svg { width: 16px; height: 16px; display: block; }",
		".kb-tag { flex-shrink: 0; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; border-radius: 3px; font-size: 9px; font-weight: 700; line-height: 1; background: var(--vscode-descriptionForeground); color: #fff; }",
		// Context badge hue keyed by kind/source, mirroring SidebarCssBuilder's
		// .mem-ctx-badge--* palette. Placed AFTER .kb-tag so these single-class
		// rules win the background on the shared 'kb-tag mem-ctx-badge' element.
		".mem-ctx-badge--plan      { background: #3fb950; }",
		".mem-ctx-badge--note      { background: #d29922; }",
		".mem-ctx-badge--linear    { background: #5e6ad2; }",
		".mem-ctx-badge--jira      { background: #0052cc; }",
		".mem-ctx-badge--github    { background: #6e7681; }",
		".mem-ctx-badge--notion    { background: #787774; }",
		".mem-ctx-badge--reference { background: #6e7681; }",
		// Git-status letter, tinted by VS Code's own git-decoration theme colors.
		".gs { flex-shrink: 0; font-family: ui-monospace, monospace; font-size: 11px; font-weight: 700; width: 12px; text-align: center; }",
		".gs-M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }",
		".gs-A { color: var(--vscode-gitDecoration-addedResourceForeground); }",
		".gs-D { color: var(--vscode-gitDecoration-deletedResourceForeground); }",
		".gs-U { color: var(--vscode-gitDecoration-untrackedResourceForeground); }",
		".gs-R { color: var(--vscode-gitDecoration-renamedResourceForeground); }",
		".gs-C { color: var(--vscode-gitDecoration-conflictingResourceForeground); }",
		".gs-I { color: var(--vscode-gitDecoration-ignoredResourceForeground); }",
		// Filename tint (color-only — no monospace/width, unlike .gs-*), keyed by
		// the same git-status letter so the name and its trailing letter agree.
		".fname-M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }",
		".fname-A { color: var(--vscode-gitDecoration-addedResourceForeground); }",
		".fname-D { color: var(--vscode-gitDecoration-deletedResourceForeground); }",
		".fname-U { color: var(--vscode-gitDecoration-untrackedResourceForeground); }",
		".fname-R { color: var(--vscode-gitDecoration-renamedResourceForeground); }",
		// C (conflicted) and I (ignored) complete the set: renderFileRow builds
		// `fname-<code>` for any gs letter, so without these a conflicted file's
		// name renders in the default color while its trailing gs letter is tinted
		// — the name and letter would visibly disagree.
		".fname-C { color: var(--vscode-gitDecoration-conflictingResourceForeground); }",
		".fname-I { color: var(--vscode-gitDecoration-ignoredResourceForeground); }",
		// Hover-revealed action overlay — absolutely positioned at the row's right
		// edge so it overlays trailing content (the msgs count / gs letter) rather
		// than reserving a slot or reflowing the row. Mirrors the sidebar Working
		// Memory card's .inline-actions overlay. Opaque backing (editor bg + the
		// row-hover tint) keeps the covered text from bleeding through.
		".row-actions { position: absolute; top: 0; bottom: 0; right: 8px; display: inline-flex; align-items: center; gap: 2px; padding-left: 8px; background-color: var(--vscode-editor-background); background-image: linear-gradient(var(--surface-hover), var(--surface-hover)); visibility: hidden; }",
		".row:hover .row-actions { visibility: visible; }",
		// Conversation rows carry a "N msgs" count (.r-meta.hide-on-hover) at the
		// right edge, exactly where the ✕ exclude toggle overlay lands on hover.
		// Hide it on hover so the ✕ takes its place instead of peeking out beside
		// the overlay. visibility (not display) so the row content never reflows.
		".row:hover .hide-on-hover { visibility: hidden; }",
		// The ✕/+ exclude toggle and the destructive Discard/Remove buttons
		// (.row-act-btn) share the sidebar's .iconbtn--sm look (transparent square,
		// icon-foreground glyph, toolbar-hover background) so they read identically
		// to the Working Memory card's row actions.
		".row-excl, .row-act-btn { width: 20px; height: 18px; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: 1px solid transparent; border-radius: 4px; color: var(--vscode-icon-foreground, var(--vscode-foreground)); cursor: pointer; padding: 0; }",
		".row-excl:hover, .row-act-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }",
		".row-excl .codicon, .row-act-btn .codicon { font-size: 12px; }",
		// Context "+" — neutral icon color (matching the sidebar's .iconbtn add
		// button), NOT the link-blue that read as an accent color here.
		".panel-add { margin-left: auto; background: none; border: none; color: var(--vscode-icon-foreground, var(--vscode-foreground)); cursor: pointer; font-size: 11.5px; }",
		".env-label { font-size: 11px; text-transform: uppercase; color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }",
		".env-ai { padding: 0 4px; border-radius: 3px; background: var(--vscode-charts-blue); color: #fff; font-size: 10px; }",
		".env-title-text { font-size: 13px; margin-bottom: 6px; }",
		".env-grid { display: flex; gap: 14px; font-size: 11.5px; color: var(--vscode-descriptionForeground); }",
		".env-panel-body { padding: 8px 10px; }",
		".tmeter { padding: 8px 10px; }",
		".tmeter-head { font-size: 12px; margin-bottom: 4px; }",
		".tmeter-total { font-weight: 600; }",
		".tmeter-sub { color: var(--vscode-descriptionForeground); }",
		".tmeter-bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: var(--vscode-widget-border); }",
		".seg-in { background: var(--vscode-charts-green); }",
		".seg-out { background: var(--vscode-charts-blue); flex: 1; }",
		".seg-cache { background: var(--vscode-charts-gray); }",
		widthBuckets,
		".tmeter-legend { display: flex; gap: 12px; font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }",
		".lg-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 3px; }",
		".privacy-note { font-size: 11.5px; display: flex; gap: 6px; color: var(--vscode-descriptionForeground); margin: 10px 0; }",
		".footer-note { font-size: 11.5px; color: var(--vscode-descriptionForeground); margin: 8px 0; }",
		// Commit-explainer copy above the Commit Memory button (mockup .cc-body /
		// .cc-note): what gets committed vs. only linked, plus the local-first note.
		".cc-body { font-size: 11.5px; color: var(--vscode-descriptionForeground); line-height: 1.5; margin: 8px 0 6px; }",
		".cc-note { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--ship-ok); margin: 0 0 9px; }",
		".btn { width: 100%; padding: 7px 10px; border: none; border-radius: 4px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 6px; }",
		".btn:disabled { opacity: 0.5; cursor: default; }",
		".btn.secondary { background: none; color: var(--vscode-textLink-foreground); width: auto; padding: 4px 6px; }",
		".empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 6px 10px; }",
		// Anchored add-context dropdown — mirrors SidebarCssBuilder's .context-menu
		// so the panel's Context "+" opens the same menu the sidebar does.
		".context-menu { position: fixed; background: var(--vscode-menu-background); color: var(--vscode-menu-foreground); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); box-shadow: 0 2px 8px rgba(0,0,0,0.4); padding: 2px 0; z-index: 100; min-width: 160px; font-size: 12px; }",
		".context-menu .menu-item { padding: 4px 16px; cursor: pointer; white-space: nowrap; }",
		".context-menu .menu-item:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }",
		".context-menu .menu-separator { height: 1px; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); margin: 2px 0; }",
		".hidden { display: none; }",
	].join("\n");
}
