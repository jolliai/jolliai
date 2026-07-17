import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The knowledge-graph viz runtime is compiled ONCE by the CLI build into
// cli/dist/graph-assets/ (authored JS/CSS minified there via esbuild; vendor/ +
// index.html copied verbatim). The extension ships a copy under assets/graph/ so
// the webview can load it via asWebviewUri — assets/ ships in the VSIX (not in
// .vscodeignore) and is gitignored / regenerated each build, mirroring
// assets/codicons/. We copy the CLI's compiled output VERBATIM (no re-minify),
// so compression lives in exactly one place — the CLI build (DRY). index.html's
// `<!-- scripts:start -->` / charset / stylesheet markers are preserved because
// the CLI ships index.html verbatim; they survive for KnowledgeGraphPanel.renderGraphHtml.
//
// ORDER: the CLI must be built before this runs (the extension build depends on
// the CLI). If cli/dist/graph-assets is missing, build the CLI first.
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "cli", "dist", "graph-assets");
const dest = join(here, "..", "assets", "graph");

if (!existsSync(src)) {
	console.error(
		`[copy-graph-assets] ${src} not found — build the CLI first (npm run build in cli/) so its compiled graph assets exist.`,
	);
	process.exit(1);
}

try {
	rmSync(dest, { recursive: true, force: true });
	cpSync(src, dest, { recursive: true });
	console.log(`[copy-graph-assets] copied compiled CLI graph assets from ${src} → ${dest}`);
} catch (err) {
	console.error("[copy-graph-assets] failed:", err);
	process.exit(1);
}
