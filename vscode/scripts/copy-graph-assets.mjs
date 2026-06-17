import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

// The knowledge-graph viz runtime (JS/CSS/HTML) lives in the CLI workspace (the
// single, readable source of truth). Copy it into assets/graph/ so the webview
// can load it via asWebviewUri. assets/ ships in the VSIX (not in .vscodeignore)
// and is gitignored (regenerated on every build), mirroring assets/codicons/.
//
// COMPRESSION: minify the code we author (app JS under js/, CSS under styles/);
// copy vendor/ verbatim — it's already in distributed form (marked.min.js /
// panzoom.min.js carry their license banners, and elk.bundled.js is GWT-compiled
// so it barely minifies (~9%) while being the one file we can't easily verify
// post-minify; the VSIX zip compresses it on the wire regardless). index.html is
// copied verbatim so its `<!-- scripts:start -->` / charset / stylesheet markers
// survive for KnowledgeGraphPanel.renderGraphHtml.
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "cli", "src", "graph", "assets");
const dest = join(here, "..", "assets", "graph");

function walk(dir) {
	const out = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p));
		else out.push(p);
	}
	return out;
}

/** Minify the code we author (js/ + styles/); copy vendor/ + html verbatim. */
function shouldMinify(file) {
	if (file.replaceAll("\\", "/").includes("/vendor/")) return false; // ship vendor as distributed
	const ext = extname(file);
	return ext === ".css" || ext === ".js";
}

async function build() {
	rmSync(dest, { recursive: true, force: true });
	let savedBytes = 0;
	for (const abs of walk(src)) {
		const out = join(dest, relative(src, abs));
		mkdirSync(dirname(out), { recursive: true });
		if (shouldMinify(abs)) {
			const original = readFileSync(abs, "utf8");
			const { code } = await transform(original, {
				minify: true,
				loader: extname(abs) === ".css" ? "css" : "js",
				legalComments: "inline", // preserve @license / @preserve banners
			});
			writeFileSync(out, code, "utf8");
			savedBytes += Buffer.byteLength(original) - Buffer.byteLength(code);
		} else {
			cpSync(abs, out);
		}
	}
	console.log(`[copy-graph-assets] minified + copied to ${dest} (saved ${(savedBytes / 1024).toFixed(0)} KB)`);
}

build().catch((err) => {
	console.error("[copy-graph-assets] failed:", err);
	process.exit(1);
});
