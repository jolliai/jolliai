/**
 * Bundles the jolli CLI + every hook script into this plugin's dist/, so the
 * plugin is FULLY self-contained (no global @jolli.ai/cli install required) —
 * the product goal is "install only the Claude Code plugin".
 *
 * Mirrors vscode/esbuild.config.mjs (CJS, node target, import.meta.url shim).
 * The dist must carry not just the entry points the plugin launches directly
 * (Cli.js, StopHook.js, SessionStartHook.js) but ALSO the git-hook scripts and
 * their workers — because PluginBootstrapHook installs repo hooks that
 * resolve, at commit time, back through `dist-paths/` to THIS dist. A dist
 * missing e.g. PrepareMsgHook.js does not merely no-op: the prepare-commit-msg
 * hook would `node <dist>/PrepareMsgHook.js` a nonexistent file and BLOCK the
 * commit. QueueWorker.js / PrePushWorker.js must be present as their own files
 * too: PostCommitHook / PostRewriteHook / PrePushHook spawn them by
 * `dirname(import.meta.url) + "/<Worker>.js"` (see QueueWorker.launchWorker),
 * so "dist contains the worker" is a hard requirement, not an optimization.
 *
 * Emitted entry points (mirrors the vscode CLI bundle, minus Extension.js which
 * is vscode-only, and GeminiAfterAgentHook.js which the Claude plugin never
 * installs). Kept in lockstep with _publish-lib.sh's PUBLISH_REQUIRED_DIST and
 * publish-zip.sh's REQUIRED_DIST:
 *   - Cli.js               → MCP server (`node dist/Cli.js mcp`) + the
 *                            SessionStart git-hooks bootstrap (`... enable`)
 *   - StopHook.js          → Claude Stop hook (session metadata + discovery)
 *   - SessionStartHook.js  → Claude SessionStart briefing
 *   - PostCommitHook.js / PostMergeHook.js / PostRewriteHook.js /
 *     PrepareMsgHook.js / PrePushHook.js → the git shell hooks
 *   - QueueWorker.js / PrePushWorker.js  → detached background workers spawned
 *                                          by the git hooks above
 *
 * The CLI code is shipped *as part of* this plugin, so it self-identifies on the
 * wire as `claude-plugin/<version>` via __JOLLI_CLIENT_KIND__ (add this kind to
 * the server's allowlist before release, the same way `vscode-plugin` is handled).
 */

import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginDir, "..", "..", "..");
const cliDir = resolve(repoRoot, "cli");
const jmSrc = resolve(cliDir, "src");

const pluginPkg = JSON.parse(readFileSync(resolve(pluginDir, ".claude-plugin", "plugin.json"), "utf-8"));
const cliPkg = JSON.parse(readFileSync(resolve(cliDir, "package.json"), "utf-8"));
const hooksManifest = JSON.parse(readFileSync(resolve(pluginDir, "hooks", "hooks.json"), "utf-8"));
const manifestHooks = hooksManifest.hooks ?? {};
const sessionStartCommands = (manifestHooks.SessionStart ?? []).flatMap((group) =>
	(group.hooks ?? []).map((hook) => hook.command),
);
if (
	Object.keys(manifestHooks).length !== 1 ||
	sessionStartCommands.length !== 1 ||
	!sessionStartCommands[0]?.includes("PluginBootstrapHook.js")
) {
	throw new Error("hooks.json must register exactly one SessionStart PluginBootstrapHook and no business hooks");
}

const options = {
	bundle: true,
	platform: "node",
	format: "cjs",
	// node22 matches the CLI's `engines` floor (>=22.13 — the flag-free
	// `node:sqlite` line). The hooks in this dist write the dashboard DB, and the
	// git-hook dispatchers deliberately exec `node <Hook>.js` with NO flags, so a
	// lower target would only advertise support this dist cannot deliver.
	// node:sqlite stays lazy-imported + feature-gated, so a hook running on an
	// older Node degrades (skips the stats write) instead of throwing.
	target: "node22",
	minify: true,
	logLevel: "info",
	entryPoints: [
		{ in: resolve(jmSrc, "Cli.ts"), out: "Cli" },
		{ in: resolve(jmSrc, "hooks", "PluginBootstrapHook.ts"), out: "PluginBootstrapHook" },
		{ in: resolve(jmSrc, "hooks", "StopHook.ts"), out: "StopHook" },
		{ in: resolve(jmSrc, "hooks", "SessionStartHook.ts"), out: "SessionStartHook" },
		// Git shell hooks — installed by the bootstrap reconciler, resolved back
		// to this dist at commit time via dist-paths/. Omitting any of these turns
		// the corresponding git hook into a "node <missing file>" that BLOCKS the
		// git operation (see header).
		{ in: resolve(jmSrc, "hooks", "PostCommitHook.ts"), out: "PostCommitHook" },
		{ in: resolve(jmSrc, "hooks", "PostMergeHook.ts"), out: "PostMergeHook" },
		{ in: resolve(jmSrc, "hooks", "PostRewriteHook.ts"), out: "PostRewriteHook" },
		{ in: resolve(jmSrc, "hooks", "PrepareMsgHook.ts"), out: "PrepareMsgHook" },
		{ in: resolve(jmSrc, "hooks", "PrePushHook.ts"), out: "PrePushHook" },
		// Detached workers spawned by the hooks above via dirname(import.meta.url)
		// + "/<Worker>.js" — must exist as their own files in this dist.
		{ in: resolve(jmSrc, "hooks", "QueueWorker.ts"), out: "QueueWorker" },
		{ in: resolve(jmSrc, "hooks", "PrePushWorker.ts"), out: "PrePushWorker" },
		// Hermes' `on_session_end` hook — dispatched through `run-hook`, resolved
		// back to this dist by dist-paths at end-of-turn, so a registered dist that
		// omits it turns Hermes' hook into a "node <missing file>" that silently
		// drops the capture. Its detached discovery worker is a fixed sibling
		// filename, same shape as CursorDiscoveryWorker.
		{ in: resolve(jmSrc, "hooks", "HermesStopHook.ts"), out: "HermesStopHook" },
		{ in: resolve(jmSrc, "hooks", "HermesDiscoveryWorker.ts"), out: "HermesDiscoveryWorker" },
		// No dashboard server entry: `jolli dashboard` serves in its own process,
		// so the server rides in Cli.js. Its ASSETS are still copied below, and
		// still for the dist-paths reason — this dist can win arbitration, and
		// `run-cli` would then launch THIS Cli.js, which reads the page runtime
		// from `dashboard-assets/` beside itself.
	],
	outdir: resolve(pluginDir, "dist"),
	// Entry points resolve their imports from cli/src, so start module resolution
	// at the CLI's node_modules (fall back to the repo root's).
	nodePaths: [resolve(cliDir, "node_modules"), resolve(repoRoot, "node_modules")],
	banner: {
		js: `const __jmImportMetaUrl = require("node:url").pathToFileURL(__filename).href;`,
	},
	define: {
		"import.meta.url": "__jmImportMetaUrl",
		__PKG_VERSION__: JSON.stringify(pluginPkg.version),
		__CLI_PKG_VERSION__: JSON.stringify(cliPkg.version),
		__JOLLI_CLIENT_KIND__: JSON.stringify("claude-plugin"),
	},
};

// Guard the dist against a silently-dropped entry point. esbuild only fails on a
// missing *source* file, not on a removed `entryPoints` line — and the REQUIRED_DIST
// completeness loops live in the publish scripts, which are NOT in `npm run all`/CI.
// So assert the canonical entry set here, where `build:claude-plugin` (and thus CI)
// catches drift. Kept in lockstep with cli/src/install/DistPathWriter.ts
// REQUIRED_RUNTIME_FILES (those 10 + PluginBootstrapHook, which the manifest launches
// directly and so never resolves through dist-paths/).
const EXPECTED_ENTRY_OUTS = [
	"Cli",
	"PluginBootstrapHook",
	"StopHook",
	"SessionStartHook",
	"PostCommitHook",
	"PostMergeHook",
	"PostRewriteHook",
	"PrepareMsgHook",
	"PrePushHook",
	"QueueWorker",
	"PrePushWorker",
	"HermesStopHook",
	"HermesDiscoveryWorker",
];
const actualOuts = options.entryPoints.map((e) => e.out).sort();
const expectedOuts = [...EXPECTED_ENTRY_OUTS].sort();
if (actualOuts.length !== expectedOuts.length || actualOuts.some((out, i) => out !== expectedOuts[i])) {
	throw new Error(
		`build.mjs entryPoints drifted from the canonical ${EXPECTED_ENTRY_OUTS.length}-entry plugin dist set.\n` +
			`  expected: ${expectedOuts.join(", ")}\n` +
			`  actual:   ${actualOuts.join(", ")}`,
	);
}

if (isWatch) {
	// Assets first: esbuild's watch never returns, so anything after `ctx.watch()`
	// is unreachable. Without this a `--watch` dist had every hook but no
	// dashboard-assets/, and the server threw "assets not found" the whole session.
	copyDashboardAssets();
	const ctx = await esbuild.context(options);
	await ctx.watch();
	console.log("Watching for changes...");
} else {
	// Pre-clean dist/ so a renamed/removed entry point can't leave a stale file
	// that the zip path would silently ship.
	rmSync(resolve(pluginDir, "dist"), { recursive: true, force: true });
	const result = await esbuild.build(options);
	if (result.errors.length > 0) process.exit(1);
	copyDashboardAssets();
	console.log(
		`Built plugin dist/ v${pluginPkg.version} — ${options.entryPoints.length} entries ` +
			"(Cli.js, PluginBootstrapHook.js, Stop/SessionStart hooks, the 5 git hooks, both workers) " +
			"plus the dashboard assets",
	);
}

/**
 * Mirrors the CLI's compiled dashboard page runtime into this dist.
 *
 * The assets are minified ONCE by the CLI's vite build (cli/dist/dashboard-assets)
 * and copied verbatim here — same DRY arrangement as vscode's
 * scripts/copy-dashboard-assets.mjs. The server reads them from disk relative to
 * its own bundle (resolveDashboardAssetsDir), so they must sit beside Cli.js —
 * which is the bundle the server rides in now.
 *
 * Hard-fails rather than shipping a server with no pages: a silently asset-less
 * dist would only surface as a 500 the first time a user ran `jolli dashboard`.
 */
function copyDashboardAssets() {
	const src = resolve(cliDir, "dist", "dashboard-assets");
	if (!existsSync(src)) {
		throw new Error(
			`Dashboard assets not found at ${src} — build the CLI first (npm run build -w @jolli.ai/cli), ` +
				"then rebuild this plugin.",
		);
	}
	cpSync(src, resolve(pluginDir, "dist", "dashboard-assets"), { recursive: true });
}
