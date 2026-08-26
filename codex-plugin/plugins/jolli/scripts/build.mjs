/**
 * Bundles the jolli CLI + every hook script into this plugin's dist/, so the
 * plugin is FULLY self-contained (no global @jolli.ai/cli install required) —
 * the product goal is "install only the Codex plugin".
 *
 * Sibling of claude-plugin/plugins/jolli/scripts/build.mjs. Same shape, four
 * differences: the manifest path, the bootstrap entry point, the client kind, and the
 * extra `McpLauncher` entry (this plugin registers MCP globally rather than shipping
 * a `.mcp.json`; see the entry's own comment).
 *
 * WHY THIS DIST SHIPS StopHook.js AND SessionStartHook.js even though the Codex
 * bootstrap never installs Claude's agent hooks: dist completeness is a
 * machine-global contract, not a per-host one. `DistPathWriter.isCompleteRuntimeDist`
 * requires all ten REQUIRED_RUNTIME_FILES before it will register a dist at all, so
 * omitting them would leave `dist-paths/codex-plugin` unwritten and this plugin's own
 * git hooks with nothing to resolve through. Worse, if it did register and then won
 * the version race, the repo-installed Claude Stop hook would dispatch into this dist
 * and hit a missing file. The shared repo hooks are source-neutral by design; every
 * dist that competes to serve them must be able to serve all of them.
 *
 * The same reasoning covers the git-hook scripts and workers. A dist missing e.g.
 * PrepareMsgHook.js does not merely no-op: the prepare-commit-msg hook would
 * `node <dist>/PrepareMsgHook.js` a nonexistent file and BLOCK the commit.
 * QueueWorker.js / PrePushWorker.js must be present as their own files too —
 * PostCommitHook / PostRewriteHook / PrePushHook spawn them by
 * `dirname(import.meta.url) + "/<Worker>.js"` (see QueueWorker.launchWorker).
 *
 * The CLI code is shipped *as part of* this plugin, so it self-identifies on the wire
 * as `codex-plugin/<version>` via __JOLLI_CLIENT_KIND__ (add this kind to the server's
 * allowlist before release, the same way `vscode-plugin` and `claude-plugin` are).
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

const pluginPkg = JSON.parse(readFileSync(resolve(pluginDir, ".codex-plugin", "plugin.json"), "utf-8"));
const cliPkg = JSON.parse(readFileSync(resolve(cliDir, "package.json"), "utf-8"));
const hooksManifest = JSON.parse(readFileSync(resolve(pluginDir, "hooks", "hooks.json"), "utf-8"));
const manifestHooks = hooksManifest.hooks ?? {};
const sessionStartCommands = (manifestHooks.SessionStart ?? []).flatMap((group) =>
	(group.hooks ?? []).map((hook) => hook.command),
);
// Exactly one SessionStart bootstrap and no business hooks. Capture hooks belong in
// the repo (installed by the bootstrap, dispatched through run-hook), not in the
// manifest — a manifest-registered Stop hook would double-run against the repo one,
// and Codex would silently skip it anyway until the user trusts the definition.
if (
	Object.keys(manifestHooks).length !== 1 ||
	sessionStartCommands.length !== 1 ||
	!sessionStartCommands[0]?.includes("CodexPluginBootstrapHook.js")
) {
	throw new Error("hooks.json must register exactly one SessionStart CodexPluginBootstrapHook and no business hooks");
}

const options = {
	bundle: true,
	platform: "node",
	format: "cjs",
	// Node 22.13 is the product floor (see AGENTS.md — node:sqlite throws on
	// import below it unless given --experimental-sqlite, which neither the
	// extension host nor the git-hook dispatchers can supply). This dist ships
	// the same QueueWorker/StopHook that write the dashboard DB, so it must not
	// advertise a lower target than its siblings. Pinned by
	// cli/src/core/NodeFloorLockstep.test.ts.
	target: "node22",
	minify: true,
	logLevel: "info",
	entryPoints: [
		{ in: resolve(jmSrc, "Cli.ts"), out: "Cli" },
		{ in: resolve(jmSrc, "hooks", "CodexPluginBootstrapHook.ts"), out: "CodexPluginBootstrapHook" },
		// The win32 MCP entry point. This plugin ships NO `.mcp.json` (a plugin MCP
		// entry must pin cwd to the plugin root, which makes the server serve the wrong
		// repository); MCP is registered into the global ~/.codex/config.toml instead,
		// and on win32 that entry spawns this launcher so the runtime version is
		// resolved per launch rather than frozen at registration. See the module header.
		{ in: resolve(jmSrc, "McpLauncher.ts"), out: "McpLauncher" },
		// Not used by this host, but required for dist completeness — see header.
		{ in: resolve(jmSrc, "hooks", "StopHook.ts"), out: "StopHook" },
		{ in: resolve(jmSrc, "hooks", "SessionStartHook.ts"), out: "SessionStartHook" },
		// Git shell hooks — installed by the bootstrap reconciler, resolved back to
		// this dist at commit time via dist-paths/. Omitting any of these turns the
		// corresponding git hook into a "node <missing file>" that BLOCKS the git
		// operation (see header).
		{ in: resolve(jmSrc, "hooks", "PostCommitHook.ts"), out: "PostCommitHook" },
		{ in: resolve(jmSrc, "hooks", "PostMergeHook.ts"), out: "PostMergeHook" },
		{ in: resolve(jmSrc, "hooks", "PostRewriteHook.ts"), out: "PostRewriteHook" },
		{ in: resolve(jmSrc, "hooks", "PrepareMsgHook.ts"), out: "PrepareMsgHook" },
		{ in: resolve(jmSrc, "hooks", "PrePushHook.ts"), out: "PrePushHook" },
		// Detached workers spawned by the hooks above via dirname(import.meta.url)
		// + "/<Worker>.js" — must exist as their own files in this dist.
		{ in: resolve(jmSrc, "hooks", "QueueWorker.ts"), out: "QueueWorker" },
		{ in: resolve(jmSrc, "hooks", "PrePushWorker.ts"), out: "PrePushWorker" },
		// Hermes' on_session_end hook + its detached worker. Not used by this host,
		// but required for dist completeness — see header.
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
		__JOLLI_CLIENT_KIND__: JSON.stringify("codex-plugin"),
	},
};

// Guard the dist against a silently-dropped entry point. esbuild only fails on a
// missing *source* file, not on a removed `entryPoints` line. Asserting here means
// `build:codex-plugin` — and therefore CI — catches the drift. Kept in lockstep with
// cli/src/install/DistPathWriter.ts REQUIRED_RUNTIME_FILES (those 10, plus two
// entries that never resolve through dist-paths/: CodexPluginBootstrapHook, which
// the manifest launches directly; and McpLauncher).
const EXPECTED_ENTRY_OUTS = [
	"Cli",
	"CodexPluginBootstrapHook",
	"McpLauncher",
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
	// that the packaging path would silently ship.
	rmSync(resolve(pluginDir, "dist"), { recursive: true, force: true });
	const result = await esbuild.build(options);
	if (result.errors.length > 0) process.exit(1);
	copyDashboardAssets();
	console.log(
		`Built Codex plugin dist/ v${pluginPkg.version} — ${options.entryPoints.length} entries ` +
			"(Cli.js, CodexPluginBootstrapHook.js, McpLauncher.js, Stop/SessionStart hooks, the 5 git hooks, " +
			"both workers) plus the dashboard assets",
	);
}

/**
 * Mirrors the CLI's compiled dashboard page runtime into this dist.
 *
 * The assets are minified ONCE by the CLI's vite build (cli/dist/dashboard-assets)
 * and copied verbatim here — same DRY arrangement as claude-plugin's build.mjs and
 * vscode's scripts/copy-dashboard-assets.mjs. The server reads them from disk
 * relative to its own bundle (resolveDashboardAssetsDir), so they must sit beside
 * Cli.js — which is the bundle the server rides in now.
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
