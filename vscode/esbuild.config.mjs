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
	// Target the Node bundled with the oldest supported VS Code (Electron 25 / Node 18).
	// node:sqlite (Node 22.5+) is lazy-imported and gated by hasNodeSqliteSupport(), so
	// this bundle loads fine on older hosts — OpenCode scanning just stays disabled.
	target: "node18",
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
		{ in: `${jmSrc}/hooks/QueueWorker.ts`,             out: "QueueWorker" },
		{ in: `${jmSrc}/hooks/PostRewriteHook.ts`,         out: "PostRewriteHook" },
		{ in: `${jmSrc}/hooks/PrepareMsgHook.ts`,          out: "PrepareMsgHook" },
		{ in: `${jmSrc}/hooks/GeminiAfterAgentHook.ts`,   out: "GeminiAfterAgentHook" },
		{ in: `${jmSrc}/hooks/SessionStartHook.ts`,       out: "SessionStartHook" },
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
