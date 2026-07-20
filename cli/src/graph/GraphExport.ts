/**
 * GraphExport — assemble a single self-contained HTML for a repo's knowledge
 * graph and write it to disk. Inlines the stylesheet, every viz script
 * (vendor + app), and the repo's `graph.json` (as `window.__EMBEDDED_GRAPH__`),
 * so the file opens directly from `file://` — no server, no `fetch` (CORS-safe).
 *
 * The full `_wiki` pages need no external files: each topic's markdown is
 * embedded as `fullBody` inside graph.json and rendered in-panel by `panel.js`.
 *
 * Mirrors the VS Code webview's `KnowledgeGraphPanel.renderGraphHtml`, with one
 * shared hazard to respect: replacements are passed as FUNCTIONS, never strings.
 * A string replacement interprets `$$`, `$&`, `$'`, `$1`… specially, which would
 * corrupt the elk bundle (full of `$`/`$$` GWT names) and any `$` in the JSON.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStorage } from "../core/StorageFactory.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Vendor + app scripts, in the same order as the viz `index.html` loads them. */
const VENDOR_FILES = ["panzoom.min.js", "elk.bundled.js", "marked.min.js"] as const;
const SCRIPT_FILES = [
	"data.js",
	"state.js",
	"edges.js",
	"camera.js",
	"drag.js",
	"views.js",
	"panel.js",
	"main.js",
] as const;

/** The raw file contents needed to assemble one standalone HTML. */
export interface GraphHtmlParts {
	readonly template: string; // viz index.html
	readonly css: string; // styles/main.css
	readonly vendorJs: ReadonlyArray<string>; // vendor/*.js, in load order
	readonly appJs: ReadonlyArray<string>; // js/*.js, in load order
	readonly graphJson: string; // the repo's graph.json (verbatim)
}

/**
 * Neutralize an inline-script breakout in the embedded JSON: the `</script`
 * close sequence (any case) plus the two raw JS line terminators U+2028/U+2029
 * that JSON leaves unescaped (inert on ES2019+, cheap defense in depth).
 */
export function escapeForInlineScript(json: string): string {
	return json
		.replace(/<\/script/gi, "<\\/script")
		.replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
		.replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
}

/** Replace a single template marker, throwing if it is absent (no silent no-op). */
function replaceMarker(html: string, marker: RegExp, replacement: () => string, label: string): string {
	if (!marker.test(html)) throw new Error(`knowledge graph template missing expected marker: ${label}`);
	return html.replace(marker, replacement);
}

/**
 * Pure assembly: inline the stylesheet and all scripts into the template, with
 * the graph data behind `window.__EMBEDDED_GRAPH__`. No fs access — fully
 * testable. Throws if the template is missing an expected marker.
 */
export function assembleGraphHtml(parts: GraphHtmlParts): string {
	const safeGraph = escapeForInlineScript(parts.graphJson);
	const scriptTag = (js: string) => `<script>\n${js}\n</script>`;
	// Vendor first, then the embedded data (data.js reads it), then app scripts.
	const scripts =
		`${parts.vendorJs.map(scriptTag).join("\n")}\n` +
		`<script>window.__EMBEDDED_GRAPH__ = ${safeGraph};</script>\n` +
		parts.appJs.map(scriptTag).join("\n");

	let html = replaceMarker(
		parts.template,
		/<link rel="stylesheet" href="styles\/main\.css" \/>/,
		() => `<style>\n${parts.css}\n</style>`,
		"stylesheet link",
	);
	html = replaceMarker(html, /<!-- scripts:start -->[\s\S]*?<!-- scripts:end -->/, () => scripts, "scripts block");
	return html;
}

/**
 * Locate the shipped viz assets. In the built CLI they are copied to
 * `<dist>/graph-assets/`; running from source (tsx) they sit beside this module
 * at `./assets/`. `baseDir` is injectable for tests.
 */
export function resolveAssetsDir(baseDir: string = HERE): string {
	for (const candidate of ["graph-assets", "assets", join("graph", "assets")]) {
		const dir = join(baseDir, candidate);
		if (existsSync(join(dir, "index.html"))) return dir;
	}
	throw new Error(
		"Knowledge graph viz assets not found — reinstall @jolli.ai/cli (the export needs the bundled assets).",
	);
}

/** Read the viz assets from `assetsDir` and assemble the standalone HTML. */
export function buildStandaloneHtml(assetsDir: string, graphJson: string): string {
	const read = (...p: string[]) => readFileSync(join(assetsDir, ...p), "utf8");
	return assembleGraphHtml({
		template: read("index.html"),
		css: read("styles", "main.css"),
		vendorJs: VENDOR_FILES.map((f) => read("vendor", f)),
		appJs: SCRIPT_FILES.map((f) => read("js", f)),
		graphJson,
	});
}

export interface ExportGraphOptions {
	/** Repo directory whose graph to export. */
	readonly cwd: string;
	/** Output target: a directory (gets `<repo>-graph.html`) or an explicit `*.html`
	 *  path. When omitted, defaults to the user's Documents folder (`~/Documents`)
	 *  — NOT the repo cwd, which would dirty the git working tree. */
	readonly out?: string;
}

/**
 * Export the repo at `cwd` to a self-contained HTML and return the written path.
 * Throws a clear error if the repo has no graph yet, or the viz assets are
 * missing from this install.
 */
export async function exportGraphHtml(opts: ExportGraphOptions): Promise<string> {
	const storage = await createStorage(opts.cwd, opts.cwd);
	const kbRoot = storage.kbRoot ?? opts.cwd;
	const graphPath = join(kbRoot, ".jolli", "graph", "graph.json");
	if (!existsSync(graphPath)) {
		throw new Error(`No knowledge graph found at ${graphPath}. Run "jolli compile --cwd ${opts.cwd}" first.`);
	}
	const html = buildStandaloneHtml(resolveAssetsDir(), readFileSync(graphPath, "utf8"));

	// No explicit target → the user's Documents folder (keeps the repo clean).
	const outDir = opts.out && opts.out.trim() !== "" ? opts.out : join(homedir(), "Documents");
	const outFile = outDir.toLowerCase().endsWith(".html") ? outDir : join(outDir, `${basename(kbRoot)}-graph.html`);
	mkdirSync(dirname(outFile), { recursive: true });
	writeFileSync(outFile, html, "utf8");
	return outFile;
}
