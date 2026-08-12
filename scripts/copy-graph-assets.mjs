import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Unified copier for the knowledge-graph viz runtime.
//
// The viz is compiled ONCE by the CLI build into cli/dist/graph-assets/ (authored
// JS/CSS minified via esbuild; vendor/ + index.html copied verbatim). Downstream
// consumers copy that compiled output VERBATIM (no re-minify), so compression lives
// in exactly one place — the CLI build (DRY). The same bundle serves every delivery
// mode (inline __EMBEDDED_GRAPH__ for VS Code / dashboard, host-bridge postMessage
// for the web frontend), because index.html + data.js carry all three paths.
//
// Destinations:
//   - ALWAYS: vscode/assets/graph  (shipped in the VSIX; gitignored / regenerated)
//   - UNLESS --vscode-only: <base>/frontend/public/graph  (the external web repo)
//
// The web copy is deliberately NOT a side effect of ANY build: both the gate
// (`npm run all` → vscode build) and the VS Code `deploy` pass --vscode-only, so
// neither ever rewrites the external repo. The web copy happens ONLY via an
// explicit `npm run copy-graph-assets` (no flag).
//
// base = <first non-flag arg> || $JOLLI_WEB_BASE || "E:\jolli". If <base>/frontend
// does not exist, the web copy is skipped (not an error).
//
// ORDER: the CLI must be built before this runs. If cli/dist/graph-assets is missing,
// build the CLI first.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const src = join(root, "cli", "dist", "graph-assets");

const args = process.argv.slice(2);
const vscodeOnly = args.includes("--vscode-only");
const base = args.find((a) => !a.startsWith("--")) ?? process.env.JOLLI_WEB_BASE ?? "E:\\jolli";

if (!existsSync(src)) {
	console.error(
		`[copy-graph-assets] ${src} not found — build the CLI first (npm run build:cli) so its compiled graph assets exist.`,
	);
	process.exit(1);
}

/** @type {string[]} */
const dests = [join(root, "vscode", "assets", "graph")];

if (!vscodeOnly) {
	const webParent = join(base, "frontend");
	if (existsSync(webParent)) {
		dests.push(join(webParent, "public", "graph"));
	} else {
		console.log(
			`[copy-graph-assets] skipping web copy — ${webParent} not found (set JOLLI_WEB_BASE or pass a base path to enable).`,
		);
	}
}

try {
	for (const dest of dests) {
		rmSync(dest, { recursive: true, force: true });
		cpSync(src, dest, { recursive: true });
		console.log(`[copy-graph-assets] copied ${src} → ${dest}`);
	}
} catch (err) {
	console.error("[copy-graph-assets] failed:", err);
	process.exit(1);
}
