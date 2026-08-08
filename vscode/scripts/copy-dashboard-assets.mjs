import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The dashboard page runtime (HTML/CSS/JS) is compiled ONCE by the CLI build
// into cli/dist/dashboard-assets/ — same DRY arrangement as copy-graph-assets.
// Unlike the graph viz (webview, shipped under assets/), the dashboard server
// reads its assets from DISK relative to its own bundle
// (resolveDashboardAssetsDir), so the copy lands in dist/dashboard-assets/
// beside DashboardServerEntry.js.
//
// ORDER: the CLI must be built before this runs (the extension build depends
// on the CLI). If cli/dist/dashboard-assets is missing, build the CLI first.
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "cli", "dist", "dashboard-assets");
const dest = join(here, "..", "dist", "dashboard-assets");

if (!existsSync(src)) {
	console.error(
		`[copy-dashboard-assets] ${src} not found — build the CLI first (npm run build in cli/) so its compiled dashboard assets exist.`,
	);
	process.exit(1);
}

try {
	rmSync(dest, { recursive: true, force: true });
	cpSync(src, dest, { recursive: true });
	console.log(`[copy-dashboard-assets] copied compiled CLI dashboard assets from ${src} → ${dest}`);
} catch (err) {
	console.error("[copy-dashboard-assets] failed:", err);
	process.exit(1);
}
