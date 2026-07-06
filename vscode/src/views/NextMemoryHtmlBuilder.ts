/**
 * NextMemoryHtmlBuilder
 *
 * Document shell for the Next Memory review panel. Mount points are filled
 * in by NextMemoryScriptBuilder's client-side render calls (same pattern as
 * SidebarHtmlBuilder / SummaryHtmlBuilder: server renders an empty shell,
 * client fills it once data arrives over postMessage).
 */
import { buildNextMemoryCss } from "./NextMemoryCssBuilder.js";
import { buildNextMemoryScript } from "./NextMemoryScriptBuilder.js";

export function buildNextMemoryHtml(nonce: string, cspSource: string, codiconCssUri: string): string {
	const csp =
		`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
		`style-src 'nonce-${nonce}' ${cspSource}; script-src 'nonce-${nonce}'; font-src ${cspSource}; img-src data:;" />`;

	return [
		"<!doctype html>",
		"<html><head>",
		'<meta charset="utf-8">',
		csp,
		`<link rel="stylesheet" href="${codiconCssUri}">`,
		`<style nonce="${nonce}">${buildNextMemoryCss()}</style>`,
		"</head><body>",
		'<div id="root">',
		"<h1>Working Memory</h1>",
		'<div class="meta-strip" id="meta-strip"></div>',
		'<p class="muted">The full memory your next commit will save: your final review. Everything here is included; leave out an item with the ✕ on hover, or add one back with +. Nothing is committed until you choose Commit Memory below.</p>',
		'<div id="title-panel"></div>',
		'<div id="token-meter"></div>',
		'<div id="conversations-panel"></div>',
		'<div id="context-panel"></div>',
		'<div id="files-panel"></div>',
		'<div id="footer"></div>',
		"</div>",
		// Anchored add-context dropdown (same in-webview menu the sidebar uses),
		// positioned under the Context "+" via JS. Starts hidden.
		'<div class="context-menu hidden" id="context-menu"></div>',
		`<script nonce="${nonce}">${buildNextMemoryScript()}</script>`,
		"</body></html>",
	].join("");
}
