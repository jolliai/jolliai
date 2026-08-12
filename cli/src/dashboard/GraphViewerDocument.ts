/**
 * GraphViewerDocument — the dashboard's per-request transform of the shared,
 * self-contained knowledge-graph viz into what `/graph-viewer` serves inside the
 * Graph page's sandboxed iframe. Two things the framed viz needs that the CLI
 * export / VS Code webview get from their host:
 *
 *   1. **A repo switcher inside the graph's own header.** The Graph page is just
 *      this iframe (no dashboard chrome), so the "which repo" control lives in
 *      the viz topbar as a `<select>`. It self-navigates the iframe to another
 *      repo's `/graph-viewer` (carrying the current theme) — a sandboxed frame
 *      may navigate itself, and keeping repo state in the URL avoids any
 *      parent↔iframe sync.
 *
 *   2. **A light palette.** The viz is dark-only outside a VS Code webview: its
 *      `:root` derives bg/text/borders from `--vscode-*` tokens (dark fallbacks
 *      when unset), and `body.vscode-light` alone only recolors the translucent
 *      overlays / edge / kind hues — NOT the background or text. So for light we
 *      both add the `vscode-light` class (via `buildStandaloneHtml`'s bodyClass)
 *      AND inject light values for those `--vscode-*` tokens here.
 *
 * The shared `cli/src/graph/assets` are untouched — this is a string wrap of the
 * assembled output, anchored on markers that appear exactly once (`</head>`,
 * `</body>`, the header's brand `<div>`; the graph JSON is `<`-escaped, so none
 * of them collide with embedded data).
 */

import { buildStandaloneHtml } from "../graph/GraphExport.js";

export interface GraphViewerRepo {
	/** Memory Bank folder dir name — the `/graph-viewer?kb=` key. */
	readonly kb: string;
	readonly repoName: string;
}

export interface GraphViewerOptions {
	/** The repo currently shown (selected in the switcher). */
	readonly kb: string;
	/** All repos with a compiled graph, for the switcher. */
	readonly repos: ReadonlyArray<GraphViewerRepo>;
	/** Whether to render the light palette (matches the dashboard theme). */
	readonly light: boolean;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, "&quot;");

/**
 * Light values for the `--vscode-*` tokens the viz's `:root` reads (dark
 * fallbacks otherwise). Injected AFTER the viz's own inlined stylesheet so its
 * later `:root` wins. Paired with `body.vscode-light` for the overlay/edge hues.
 */
const LIGHT_HEAD =
	"<style>:root{" +
	"--vscode-editor-background:#eef1f5;--vscode-sideBar-background:#ffffff;" +
	"--vscode-editorWidget-background:#ffffff;--vscode-list-hoverBackground:#e4e9f0;" +
	"--vscode-foreground:#1c2024;--vscode-descriptionForeground:#5c6472;" +
	"--vscode-textLink-foreground:#2563eb;--vscode-focusBorder:rgba(37,99,235,.28);" +
	"--vscode-widget-border:#d7dce3;--vscode-editorWidget-border:#e4e9f0;" +
	"}</style>";

/** Switcher styling — themed via the viz's own tokens so it follows light/dark. */
const SWITCHER_HEAD =
	"<style>.jolli-repo-switcher{margin-left:12px;background:var(--card);color:var(--ink);" +
	"border:1px solid var(--line);border-radius:8px;padding:4px 8px;font:inherit;font-size:13px;cursor:pointer;}</style>";

/** On change, self-navigate the iframe to the chosen repo, preserving the theme. */
const SWITCHER_SCRIPT =
	'<script>(function(){var s=document.getElementById("jolli-repo-switcher");if(!s)return;' +
	's.addEventListener("change",function(){var t=new URLSearchParams(location.search).get("theme")||"dark";' +
	'location.href="/graph-viewer?kb="+encodeURIComponent(s.value)+"&theme="+encodeURIComponent(t);});})();</script>';

/** The viz header's brand block — the anchor the switcher is inserted after. */
const BRAND = '<div class="brand"><span class="brand-name">Graph</span></div>';

/** Assemble the framed graph document: viz + repo switcher (+ light palette). */
export function buildGraphViewerDocument(assetsDir: string, graphJson: string, opts: GraphViewerOptions): string {
	let html = buildStandaloneHtml(assetsDir, graphJson, opts.light ? "vscode-light" : undefined);
	html = html.replace("</head>", `${opts.light ? LIGHT_HEAD : ""}${SWITCHER_HEAD}</head>`);

	const options = opts.repos
		.map(
			(r) =>
				`<option value="${escapeAttr(r.kb)}"${r.kb === opts.kb ? " selected" : ""}>${escapeHtml(r.repoName)}</option>`,
		)
		.join("");
	const select = `<select class="jolli-repo-switcher" id="jolli-repo-switcher" aria-label="Repository">${options}</select>`;
	html = html.replace(BRAND, `${BRAND}${select}`);
	html = html.replace("</body>", `${SWITCHER_SCRIPT}</body>`);
	return html;
}
