/**
 * esbuild configuration for the JolliMemory VSCode extension.
 *
 * Produces two sets of bundles in dist/:
 *
 * 1. Extension.js — the VSCode extension host bundle (CJS, external: vscode)
 *    Inlines jollimemory data/core modules including Installer.ts (for direct
 *    enable/disable/status calls). import.meta.url is replaced with a real
 *    __filename expression so Installer.ts can locate hook scripts at runtime.
 *
 * 2. CLI bundle — Cli.js + the five hook scripts (PostCommitHook.js, etc.)
 *    These run as standalone node scripts (subprocess calls from the extension).
 *    import.meta.url is replaced with a real __filename expression so Installer.ts
 *    can correctly locate hook scripts relative to Cli.js at runtime.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

// Read the jollimemory core version — this is the version used for version-aware
// dist-path resolution, NOT the VSCode extension version.
const jmPkg = JSON.parse(readFileSync("./package.json", "utf-8"));

// Read the @jolli.ai/cli package version separately. Inlined into the bundled
// `Cli.js` as `__CLI_PKG_VERSION__` so consumers that want "the CLI's npm
// package version" (e.g. `jolli export-prompt --output` manifest) get the
// right number when this Cli.js is shipped inside the VSCode plugin (where
// vscode-version and cli-version may diverge).
const cliPkg = JSON.parse(readFileSync(resolve("..", "cli", "package.json"), "utf-8"));

// ── Shared base options ────────────────────────────────────────────────────
const base = {
	bundle: true,
	platform: "node",
	format: "cjs",
	// Target the Node bundled with the oldest supported VS Code — `engines.vscode`
	// is pinned to ^1.101.0, whose Electron ships Node 22.15 (the release where the
	// host first crossed the flag-free `node:sqlite` floor of 22.13; 1.100.0 was
	// still on Node 20.19). See vscode/package.json for why that floor is required:
	// the extension host writes the dashboard DB IN-PROCESS and Electron gives us no
	// way to pass `--experimental-sqlite`.
	target: "node22",
	sourcemap: false,
	minify: true,
	logLevel: "info",
};

// ── Bundle 1: VSCode Extension ─────────────────────────────────────────────
// import.meta.url is replaced with a real __filename expression so Installer.ts
// can correctly locate PrepareMsgHook.js / PostCommitHook.js etc. relative to
// Extension.js at runtime. Both Extension.js and the hook scripts are emitted
// into dist/, so the resolved paths are always correct.
const extensionOptions = {
	...base,
	entryPoints: ["src/Extension.ts"],
	outfile: "dist/Extension.js",
	external: ["vscode"],
	banner: {
		js: `const __jmImportMetaUrl = require("node:url").pathToFileURL(__filename).href;`,
	},
	define: {
		"import.meta.url": "__jmImportMetaUrl",
		__PKG_VERSION__: JSON.stringify(jmPkg.version),
		__CLI_PKG_VERSION__: JSON.stringify(cliPkg.version),
		// `x-jolli-client` kind. The Extension bundle never directly emits this
		// header (it builds its own from ClientInfo.ts), but anything it
		// inlines from cli/src must self-identify as the surface it ships
		// under. The version half is already injected as __PKG_VERSION__.
		__JOLLI_CLIENT_KIND__: JSON.stringify("vscode-plugin"),
	},
};

// ── Bundle 2: jollimemory CLI + hook scripts ───────────────────────────────
// import.meta.url is replaced with a real __filename expression so
// Installer.ts can find StopHook.js / PostCommitHook.js etc. relative to Cli.js.
const jmSrc = "../cli/src";
const cliOptions = {
	...base,
	// Use { in, out } to flatten all hook scripts into dist/ alongside Cli.js.
	// Installer.ts resolves hook scripts relative to Cli.js, so they must share a directory.
	entryPoints: [
		{ in: `${jmSrc}/Cli.ts`,                           out: "Cli" },
		{ in: `${jmSrc}/hooks/StopHook.ts`,                out: "StopHook" },
		{ in: `${jmSrc}/hooks/PostCommitHook.ts`,          out: "PostCommitHook" },
		{ in: `${jmSrc}/hooks/PostMergeHook.ts`,           out: "PostMergeHook" },
		{ in: `${jmSrc}/hooks/QueueWorker.ts`,             out: "QueueWorker" },
		{ in: `${jmSrc}/hooks/PostRewriteHook.ts`,         out: "PostRewriteHook" },
		{ in: `${jmSrc}/hooks/PrepareMsgHook.ts`,          out: "PrepareMsgHook" },
		{ in: `${jmSrc}/hooks/PrePushHook.ts`,             out: "PrePushHook" },
		// Spawned by PrePushHook (detached per-push sync) AND by the CLI / VS Code
		// activation compensation drain. Must exist as its own file in dist/.
		{ in: `${jmSrc}/hooks/PrePushWorker.ts`,           out: "PrePushWorker" },
		{ in: `${jmSrc}/hooks/GeminiAfterAgentHook.ts`,   out: "GeminiAfterAgentHook" },
		{ in: `${jmSrc}/hooks/SessionStartHook.ts`,       out: "SessionStartHook" },
		// Hermes' `on_session_end` hook + its detached discovery worker. Same
		// dist-completeness reason as the plugin bundles: a bundled dist can win
		// arbitration and would then have to serve every registered host's hook.
		{ in: `${jmSrc}/hooks/HermesStopHook.ts`,         out: "HermesStopHook" },
		{ in: `${jmSrc}/hooks/HermesDiscoveryWorker.ts`,  out: "HermesDiscoveryWorker" },
		// No DashboardServerEntry: `jolli dashboard` serves in its own process, so
		// the server rides in Cli.js. dist/dashboard-assets/ is still mirrored from
		// the CLI build by scripts/copy-dashboard-assets.mjs — the page runtime is
		// read from disk at render time, and this dist can win dist-paths
		// arbitration and be the one serving it.
	],
	outdir: "dist",
	// CLI entry points live under ../cli/src/, so esbuild's Node module
	// resolution starts there and never reaches jollimemory-vscode/node_modules/.
	// nodePaths adds our own node_modules as a fallback search path.
	nodePaths: [resolve("node_modules")],
	// esbuild define only accepts identifiers or JSON literals, not expressions.
	// Inject a shim variable via banner, then map import.meta.url to it.
	// At runtime __jmImportMetaUrl resolves to the actual CJS bundle path.
	banner: {
		js: `const __jmImportMetaUrl = require("node:url").pathToFileURL(__filename).href;`,
	},
	define: {
		"import.meta.url": "__jmImportMetaUrl",
		__PKG_VERSION__: JSON.stringify(jmPkg.version),
		__CLI_PKG_VERSION__: JSON.stringify(cliPkg.version),
		// `x-jolli-client` kind for hook scripts and the bundled CLI: this CLI
		// code is shipped *as part of* the VSCode plugin, so it must
		// self-identify as `vscode-plugin/<vscode-version>` on the wire — not
		// `cli/<vscode-version>` (kind would be wrong) and not
		// `cli/<cli-package-version>` (server would gate it as native CLI).
		// The version half pairs with __PKG_VERSION__ above (= jmPkg.version).
		__JOLLI_CLIENT_KIND__: JSON.stringify("vscode-plugin"),
	},
};

if (isWatch) {
	const [extCtx, cliCtx] = await Promise.all([
		esbuild.context(extensionOptions),
		esbuild.context(cliOptions),
	]);
	await Promise.all([extCtx.watch(), cliCtx.watch()]);
	console.log("Watching for changes...");
} else {
	const [extResult, cliResult] = await Promise.all([
		esbuild.build(extensionOptions),
		esbuild.build(cliOptions),
	]);
	if (extResult.errors.length > 0 || cliResult.errors.length > 0) {
		process.exit(1);
	}
}
