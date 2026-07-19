// biome-ignore-all lint/style/useTemplate: webview HTML/JS builder must stay
// backtick-free — template literals here are silently truncated by the CSP-strict
// webview pipeline (see CLAUDE.md "Builder template-literal backtick trap").

import { buildConversationDetailsScript } from "./ConversationDetailsScriptBuilder.js";

export interface BuildHtmlOptions {
	readonly nonce: string;
	readonly sessionId: string;
	readonly source: string;
	readonly transcriptPath: string;
	/**
	 * The label string from the CONVERSATIONS row — already fallback-resolved
	 * webview-side. Rendered into the header verbatim (HTML-escaped) so the
	 * panel never re-derives the fallback.
	 */
	readonly title: string;
	/**
	 * When true the panel hides the delete buttons + Save / Cancel footer
	 * (no workspace open → nowhere to persist overrides).
	 */
	readonly readOnly: boolean;
	/**
	 * `webview.cspSource` of the panel. Required because the edited-notice
	 * banner uses a codicon glyph, which loads a stylesheet + font file from
	 * the extension's bundled asset URI — both have to be allowlisted in CSP.
	 */
	readonly cspSource: string;
	/**
	 * Result of `webview.asWebviewUri(extensionUri/assets/codicons/codicon.css)`.
	 * Linked into <head> so `<i class="codicon codicon-edit">` renders the
	 * pencil glyph in the edited-notice banner.
	 */
	readonly codiconCssUri: string;
}

export function buildConversationDetailsHtml(opts: BuildHtmlOptions): string {
	// Mirrors SidebarHtmlBuilder's CSP: nonce for inline <script>/<style>,
	// cspSource for the bundled codicon stylesheet + font. CLAUDE.md "VSCode
	// webview CSP forbids inline style/JS" applies — keep style-src and
	// script-src nonce-only (no 'unsafe-inline') so future inline regressions
	// fail loudly here just like everywhere else.
	const csp = [
		"default-src 'none'",
		"img-src 'self' data:",
		"style-src " + opts.cspSource + " 'nonce-" + opts.nonce + "'",
		"font-src " + opts.cspSource,
		"script-src 'nonce-" + opts.nonce + "'",
	].join("; ");

	// JSON.stringify does not escape forward slashes, so a transcriptPath (or
	// any future field) containing the literal "</script>" would close the
	// surrounding <script> tag and inject the remaining JSON as HTML. Pre-
	// escape '<' to its JSON unicode form, which JSON.parse decodes back.
	const initJson = JSON.stringify({
		sessionId: opts.sessionId,
		source: opts.source,
		transcriptPath: opts.transcriptPath,
		readOnly: opts.readOnly,
	}).replace(/</g, "\\u003c");

	return [
		"<!DOCTYPE html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="UTF-8">',
		'<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
		'<link rel="stylesheet" href="' + opts.codiconCssUri + '" />',
		'<style nonce="' + opts.nonce + '">',
		"body { font-family: var(--vscode-font-family); padding: 16px 16px 72px 16px; }",
		".header { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }",
		".header .title { font-size: 1.1em; font-weight: 600; }",
		/* Source badge — outline pill matching the sidebar CONVERSATIONS row.
		   Default falls back to descriptionForeground; per-source rules below
		   override fg/border/bg with the brand hue. Specificity of '.badge'
		   is 0,1,0 and '.badge.transcript-source-X' is 0,2,0 so the brand
		   rule wins the cascade. Brand hex values are kept in sync with
		   SidebarCssBuilder by convention — touch both when adding a source. */
		".badge { font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 4px; border: 1px solid var(--vscode-descriptionForeground); background: transparent; color: var(--vscode-descriptionForeground); font-weight: 500; }",
		".badge.transcript-source-claude       { color: #a78bfa; border-color: #a78bfa; background: rgba(167,139,250,0.12); }",
		".badge.transcript-source-cursor       { color: #2dd4bf; border-color: #2dd4bf; background: rgba(45,212,191,0.12); }",
		".badge.transcript-source-codex        { color: #4ade80; border-color: #4ade80; background: rgba(74,222,128,0.12); }",
		".badge.transcript-source-gemini       { color: #60a5fa; border-color: #60a5fa; background: rgba(96,165,250,0.12); }",
		".badge.transcript-source-opencode     { color: #fb923c; border-color: #fb923c; background: rgba(251,146,60,0.12); }",
		".badge.transcript-source-copilot      { color: #94a3b8; border-color: #94a3b8; background: rgba(148,163,184,0.12); }",
		".badge.transcript-source-copilot-chat { color: #fbbf24; border-color: #fbbf24; background: rgba(251,191,36,0.12); }",
		".badge.transcript-source-devin        { color: #d4d4d8; border-color: #d4d4d8; background: rgba(212,212,216,0.12); }",
		".edited-notice { display: flex; align-items: center; gap: 8px; margin: 0 0 16px 0; padding: 10px 12px; border-radius: 6px; border: 1px solid var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-focusBorder)); background: color-mix(in srgb, var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-focusBorder)) 12%, transparent); color: var(--vscode-foreground); }",
		".edited-notice.hidden { display: none; }",
		/* Leading marker — codicon-edit glyph in modified-file yellow. Matches
		   the sidebar CONVERSATIONS row marker so the same visual vocabulary
		   carries from the entry point into the detail view. */
		".edited-notice .edited-icon { font-size: 14px; color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-focusBorder)); flex-shrink: 0; }",
		".edited-notice .edited-text { font-size: 12px; line-height: 1.45; }",
		".transcript-entry { position: relative; padding: 8px 10px; margin-bottom: 6px; border-radius: 4px; }",
		".transcript-entry[data-role=human] { background: var(--vscode-editor-inactiveSelectionBackground); }",
		".transcript-entry[data-role=assistant] { background: transparent; }",
		".transcript-entry.deleted .entry-content { text-decoration: line-through; opacity: 0.5; }",
		".transcript-entry.editing .entry-content { display: none; }",
		".transcript-entry .entry-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 11px; color: var(--vscode-descriptionForeground); }",
		".transcript-entry .role { font-weight: 600; }",
		".transcript-entry .entry-time { margin-left: auto; }",
		".transcript-entry .entry-content { white-space: pre-wrap; word-break: break-word; cursor: text; }",
		".transcript-entry .entry-delete-btn { background: transparent; color: var(--vscode-descriptionForeground); border: none; cursor: pointer; padding: 2px 6px; border-radius: 3px; font-size: 14px; line-height: 1; }",
		".transcript-entry .entry-delete-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }",
		".transcript-entry .entry-edit-textarea { width: 100%; box-sizing: border-box; min-height: 60px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 6px 8px; border-radius: 3px; resize: vertical; }",
		".footer { position: fixed; left: 0; right: 0; bottom: 0; padding: 10px 16px; background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 12px; }",
		".footer.hidden { display: none; }",
		".footer .summary { color: var(--vscode-descriptionForeground); font-size: 12px; flex: 1; }",
		".footer button { padding: 4px 12px; border-radius: 3px; border: 1px solid var(--vscode-button-border, transparent); cursor: pointer; font: inherit; }",
		".footer .mark-all-btn { background: transparent; color: var(--vscode-errorForeground, #f14c4c); border-color: var(--vscode-errorForeground, #f14c4c); }",
		".footer .mark-all-btn:disabled { opacity: 0.5; cursor: default; }",
		".footer .cancel-btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }",
		".footer .save-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }",
		".footer .save-btn:disabled { opacity: 0.6; cursor: default; }",
		".empty-state { color: var(--vscode-descriptionForeground); padding: 24px 0; text-align: center; }",
		"</style>",
		"</head>",
		"<body>",
		'<div class="header">',
		'<span class="title" id="title">' + escapeHtml(opts.title) + "</span>",
		'<span class="badge transcript-source-' +
			escapeHtml(opts.source) +
			'" id="badge">' +
			escapeHtml(providerLabel(opts.source)) +
			"</span>",
		"</div>",
		'<div class="edited-notice hidden" id="editedNotice"><i class="codicon codicon-edit edited-icon" aria-hidden="true"></i><span class="edited-text">Conversation content has been modified. Future summaries will use this edited version.</span></div>',
		'<div id="entries"><div class="empty-state">Loading conversation…</div></div>',
		'<div class="footer' + (opts.readOnly ? " hidden" : "") + '" id="footer">',
		'<button class="mark-all-btn" id="markAllBtn" type="button">Mark All as Deleted</button>',
		'<span class="summary" id="footerSummary">No changes</span>',
		'<button class="cancel-btn" id="cancelBtn" type="button">Cancel</button>',
		'<button class="save-btn" id="saveBtn" type="button" disabled>Save All</button>',
		"</div>",
		'<script nonce="' + opts.nonce + '">',
		"const INIT = " + initJson + ";",
		buildConversationDetailsScript(),
		"</script>",
		"</body>",
		"</html>",
	].join("\n");
}

/**
 * Mirrors SidebarScriptBuilder's `providerLabel` so the panel title-bar
 * badge reads identically to the CONVERSATIONS row that opened it (e.g.
 * "Claude" / "Copilot Chat", not the raw lowercase enum). The two
 * implementations live apart because one runs in the webview as a string
 * and the other runs host-side in TypeScript; keep them in step when a
 * new TranscriptSource lands.
 */
function providerLabel(source: string): string {
	switch (source) {
		case "claude":
			return "Claude";
		case "cursor":
			return "Cursor";
		case "codex":
			return "Codex";
		case "gemini":
			return "Gemini";
		case "opencode":
			return "OpenCode";
		case "copilot":
			return "Copilot";
		case "copilot-chat":
			return "Copilot Chat";
		case "devin":
			return "Devin";
		default:
			return source;
	}
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
