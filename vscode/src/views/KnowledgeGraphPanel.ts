/**
 * KnowledgeGraphPanel — opens the knowledge-graph viz for a repo in a webview.
 *
 * The viz runtime (panzoom + elkjs + marked + the WikiGraph scripts) ships under
 * `assets/graph/` and is loaded via `asWebviewUri` (CSP host-source), so the
 * 2.3 MB payload is NOT inlined into the activation bundle. Only the repo's graph
 * data is inlined, as a nonce'd `window.__EMBEDDED_GRAPH__` script — matching the
 * standalone bundle's data convention so `data.js` skips its fetch fallback.
 *
 * One panel per repo, keyed by repo name (mirroring SummaryWebviewPanel's
 * per-commit tabs): opening a graph for a different repo creates a new tab,
 * re-opening the same repo reveals (and re-renders) its existing tab instead
 * of replacing another repo's.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

const VENDOR_FILES = ["panzoom.min.js", "elk.bundled.js", "marked.min.js"];
const SCRIPT_FILES = ["data.js", "state.js", "edges.js", "camera.js", "drag.js", "views.js", "panel.js", "main.js"];

/** Resolved asset URIs + nonce for one render. */
export interface GraphHtmlAssets {
	readonly cspSource: string;
	readonly nonce: string;
	readonly cssUri: string;
	readonly vendorUris: ReadonlyArray<string>;
	readonly scriptUris: ReadonlyArray<string>;
	readonly graphJson: string;
}

/**
 * Pure rewrite of the viz `index.html` template for the webview: inject the CSP,
 * swap the stylesheet + relative script refs for webview URIs, and inline the
 * graph data behind a nonce. No fs / vscode access.
 */
export function renderGraphHtml(template: string, a: GraphHtmlAssets): string {
	const safeGraph = escapeForInlineScript(a.graphJson);
	// style-src allows 'unsafe-inline': the viz applies per-category colors via
	// inline `style="--tcolor:..."` ATTRIBUTES (views.js), which a nonce can't
	// authorize. script-src stays strict (host-source + nonce) — no inline JS.
	const csp =
		`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
		`style-src ${a.cspSource} 'unsafe-inline'; script-src ${a.cspSource} 'nonce-${a.nonce}'; ` +
		`font-src ${a.cspSource}; img-src ${a.cspSource} data:;" />`;
	const vendorTags = a.vendorUris.map((u) => `<script src="${u}"></script>`).join("\n  ");
	const scriptTags = a.scriptUris.map((u) => `<script src="${u}"></script>`).join("\n  ");
	const scriptsBlock =
		`${vendorTags}\n  ` +
		`<script nonce="${a.nonce}">window.__EMBEDDED_GRAPH__ = ${safeGraph};</script>\n  ` +
		scriptTags;

	// Fail loudly if the vendored template (refreshed from upstream) ever drops a
	// marker — a silent no-op here would ship a CSP-less webview / unresolved assets.
	let html = replaceMarker(template, /<meta charset="utf-8" \/>/, `<meta charset="utf-8" />\n  ${csp}`, "charset meta");
	html = replaceMarker(
		html,
		/<link rel="stylesheet" href="styles\/main\.css" \/>/,
		`<link rel="stylesheet" href="${a.cssUri}" />`,
		"stylesheet link",
	);
	html = replaceMarker(html, /<!-- scripts:start -->[\s\S]*?<!-- scripts:end -->/, scriptsBlock, "scripts block");
	return html;
}

/**
 * Neutralizes inline-script breakout in the embedded graph JSON: the `</script`
 * close sequence (any case) plus the two legacy JS line terminators U+2028/U+2029
 * that JSON.stringify leaves raw (inert on ES2019+ engines, cheap defense in depth).
 */
function escapeForInlineScript(json: string): string {
	return json
		.replace(/<\/script/gi, "<\\/script")
		.replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
		.replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
}

/** Replaces a single template marker, throwing if it is absent (no silent no-op). */
function replaceMarker(html: string, marker: RegExp, replacement: string, label: string): string {
	if (!marker.test(html)) throw new Error(`knowledge graph template missing expected marker: ${label}`);
	return html.replace(marker, () => replacement);
}

function getNonce(): string {
	return randomBytes(16).toString("hex");
}

/** Reads the shipped viz template, resolves webview URIs, and renders the HTML. */
export function buildGraphHtml(webview: vscode.Webview, extensionUri: vscode.Uri, graphJson: string): string {
	const graphDir = vscode.Uri.joinPath(extensionUri, "assets", "graph");
	const templatePath = join(extensionUri.fsPath, "assets", "graph", "index.html");
	if (!existsSync(templatePath)) {
		throw new Error("Knowledge graph assets are missing from this build — reinstall the extension or rebuild.");
	}
	const template = readFileSync(templatePath, "utf8");
	const toUri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(graphDir, ...p)).toString();
	return renderGraphHtml(template, {
		cspSource: webview.cspSource,
		nonce: getNonce(),
		cssUri: toUri("styles", "main.css"),
		vendorUris: VENDOR_FILES.map((f) => toUri("vendor", f)),
		scriptUris: SCRIPT_FILES.map((f) => toUri("js", f)),
		graphJson,
	});
}

export class KnowledgeGraphPanel {
	/**
	 * One panel per repo. Re-opening the same repo reveals its existing tab;
	 * opening a different repo creates a new tab alongside it, so two repos'
	 * graphs never overwrite each other.
	 */
	private static panels: Map<string, KnowledgeGraphPanel> = new Map();
	private readonly panel: vscode.WebviewPanel;
	private disposed = false;

	/** Opens (or re-uses) the graph panel for `repoName`, rendering `graphJson`. */
	static show(extensionUri: vscode.Uri, repoName: string, graphJson: string): void {
		const existing = KnowledgeGraphPanel.panels.get(repoName);
		if (existing && !existing.disposed) {
			existing.panel.webview.html = buildGraphHtml(existing.panel.webview, extensionUri, graphJson);
			existing.panel.reveal(vscode.ViewColumn.One);
			return;
		}
		KnowledgeGraphPanel.panels.set(repoName, new KnowledgeGraphPanel(extensionUri, repoName, graphJson));
	}

	private constructor(extensionUri: vscode.Uri, repoName: string, graphJson: string) {
		this.panel = vscode.window.createWebviewPanel(
			"jollimemory.knowledgeGraph",
			`Knowledge Graph — ${repoName}`,
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [extensionUri],
				retainContextWhenHidden: true,
			},
		);
		this.panel.webview.html = buildGraphHtml(this.panel.webview, extensionUri, graphJson);
		this.panel.onDidDispose(() => {
			this.disposed = true;
			if (KnowledgeGraphPanel.panels.get(repoName) === this) KnowledgeGraphPanel.panels.delete(repoName);
		});
	}
}

/**
 * Command handler for `jollimemory.viewKnowledgeGraph`. Loads a repo's
 * `<kbParent>/<repo>/.jolli/graph/graph.json` and opens it in the webview; tells
 * the user to build first when no graph exists yet, and surfaces a clear message
 * if the shipped viz assets are missing.
 */
export async function openKnowledgeGraph(
	extensionUri: vscode.Uri,
	kbParent: string,
	repoName: string | undefined,
): Promise<void> {
	if (!repoName) return;
	const graphPath = join(kbParent, repoName, ".jolli", "graph", "graph.json");
	if (!existsSync(graphPath)) {
		await vscode.window.showInformationMessage(
			'No knowledge graph yet for this repo. Run "Build Knowledge Wiki" first, then try again.',
		);
		return;
	}
	try {
		KnowledgeGraphPanel.show(extensionUri, repoName, readFileSync(graphPath, "utf8"));
	} catch (err) {
		await vscode.window.showErrorMessage(
			`Could not open the knowledge graph: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
