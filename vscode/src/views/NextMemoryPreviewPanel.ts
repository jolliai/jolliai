import * as vscode from "vscode";
import { escAttr as esc } from "./SummaryUtils.js";

export interface NextMemorySelection {
	readonly conversations: ReadonlyArray<{ readonly title: string }>;
	readonly context: ReadonlyArray<{ readonly title: string }>;
	readonly files: ReadonlyArray<{ readonly path: string }>;
}

function group(title: string, items: ReadonlyArray<string>): string {
	if (items.length === 0) return "";
	const lis = items.map((t) => `<li>${esc(t)}</li>`).join("");
	return `<section><h2>${title} (${items.length})</h2><ul>${lis}</ul></section>`;
}

// Strict CSP for a scripts-disabled (`enableScripts: false`) static webview:
// no script source at all (`script-src 'none'`), only the inline `<style>`
// block is allowed. Everything else is denied (`default-src 'none'`). This
// mirrors the strict-CSP convention used by the other webviews while staying
// stricter — there is no nonce because no script ever runs here.
const CSP =
	`<meta http-equiv="Content-Security-Policy" ` +
	`content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none';">`;

// `.empty` styles the no-selection state; the rest keep the projection readable.
const STYLE =
	"<style>" +
	"body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:14px 16px;line-height:1.6;}" +
	"h1{font-size:1.3em;margin:0 0 12px;}" +
	"h2{font-size:0.95em;margin:14px 0 6px;color:var(--vscode-descriptionForeground);}" +
	"ul{margin:0;padding-left:20px;}" +
	"li{margin:2px 0;}" +
	".empty{color:var(--vscode-descriptionForeground);font-style:italic;}" +
	"</style>";

export function buildNextMemoryHtml(sel: NextMemorySelection): string {
	const total = sel.conversations.length + sel.context.length + sel.files.length;
	const head = `<head><meta charset="utf-8">${CSP}${STYLE}</head>`;
	if (total === 0) {
		return `<!doctype html><html>${head}<body><p class="empty">Nothing selected — check items in the Current Branch view to include them in the next memory.</p></body></html>`;
	}
	const body =
		group("Conversations", sel.conversations.map((c) => c.title)) +
		group("Context", sel.context.map((c) => c.title)) +
		group("Files", sel.files.map((f) => f.path));
	return `<!doctype html><html>${head}<body><h1>Next memory preview</h1>${body}</body></html>`;
}

let currentPanel: vscode.WebviewPanel | undefined;

export class NextMemoryPreviewPanel {
	private constructor() {
		// Singleton — use NextMemoryPreviewPanel.show() instead.
	}

	static show(selection: NextMemorySelection): void {
		if (!currentPanel) {
			currentPanel = vscode.window.createWebviewPanel(
				"jollimemory.nextMemoryPreview",
				"Next memory preview",
				vscode.ViewColumn.Active,
				{ enableScripts: false },
			);
			currentPanel.onDidDispose(() => {
				currentPanel = undefined;
			});
		}
		currentPanel.webview.html = buildNextMemoryHtml(selection);
		currentPanel.reveal(vscode.ViewColumn.Active);
	}
}
