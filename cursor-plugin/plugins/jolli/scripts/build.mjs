/**
 * Bundles the jolli CLI + every hook script into this plugin's dist/, so the
 * plugin is FULLY self-contained (no global @jolli.ai/cli install required) —
 * the product goal is "install only the Cursor plugin".
 *
 * Sibling of codex-plugin/plugins/jolli/scripts/build.mjs. Same shape, four
 * differences: the manifest path, the bootstrap entry point, the client kind, and the
 * ABSENCE of the `McpLauncher` entry — Codex ships that because it registers MCP into
 * the global `~/.codex/config.toml` and needs the runtime resolved per launch, while
 * Cursor's MCP config is repo-scoped (`.cursor/mcp.json`) and written by the ordinary
 * registrar with the same command every other surface writes.
 *
 * WHY THIS DIST SHIPS StopHook.js AND SessionStartHook.js even though the Cursor
 * bootstrap never installs Claude's agent hooks: dist completeness is a
 * machine-global contract, not a per-host one. `DistPathWriter.isCompleteRuntimeDist`
 * requires all ten REQUIRED_RUNTIME_FILES before it will register a dist at all, so
 * omitting them would leave `dist-paths/cursor-plugin` unwritten and this plugin's own
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
 * as `cursor-plugin/<version>` via __JOLLI_CLIENT_KIND__ (add this kind to the
 * server's allowlist before release, the same way `claude-plugin` and `codex-plugin`
 * are).
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

const pluginPkg = JSON.parse(readFileSync(resolve(pluginDir, ".cursor-plugin", "plugin.json"), "utf-8"));
const cliPkg = JSON.parse(readFileSync(resolve(cliDir, "package.json"), "utf-8"));
const hooksManifest = JSON.parse(readFileSync(resolve(pluginDir, "hooks", "hooks.json"), "utf-8"));
const manifestHooks = hooksManifest.hooks ?? {};
// Cursor's hooks.json is FLATTER than Claude's and Codex's: each event maps straight
// to an array of `{ command, … }`, with no intermediate `{ hooks: [...] }` group.
// The events this manifest may register, each mapped to the single entry it must launch.
//
// Still an exact set rather than a shape check, and still for the reason the old
// one-entry assertion encoded: GIT capture hooks belong in the repo (installed by the
// bootstrap, dispatched through run-hook), and a manifest-registered post-commit would
// double-run against the repo one. `stop` is not in that category — it is an
// AGENT-level event with no repo-installed counterpart on this host, so it duplicates
// nothing, and scanning cannot see a conversation that is still running.
const MANIFEST_HOOKS = {
	sessionStart: "CursorPluginBootstrapHook.js",
	stop: "CursorStopHook.js",
};
const declaredEvents = Object.keys(manifestHooks).sort();
if (declaredEvents.join(",") !== Object.keys(MANIFEST_HOOKS).sort().join(",")) {
	throw new Error(
		`hooks.json must register exactly [${Object.keys(MANIFEST_HOOKS).sort().join(", ")}] — found [${declaredEvents.join(", ")}]`,
	);
}
for (const [event, entry] of Object.entries(MANIFEST_HOOKS)) {
	const commands = (manifestHooks[event] ?? []).map((hook) => hook.command);
	if (commands.length !== 1 || !commands[0]?.includes(entry)) {
		throw new Error(`hooks.json must register exactly one ${event} hook launching ${entry}`);
	}
	// `${CURSOR_PLUGIN_ROOT}` is Cursor's own plugin-root variable — NOT Claude's
	// `${CLAUDE_PLUGIN_ROOT}` nor Codex's `${PLUGIN_ROOT}`. An unexpanded variable
	// produces a command that silently fails on every session, so pin it here rather
	// than discovering it in a marketplace build.
	if (!commands[0].includes("${CURSOR_PLUGIN_ROOT}")) {
		throw new Error(`hooks.json must locate the ${event} hook through \${CURSOR_PLUGIN_ROOT}`);
	}
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
		{ in: resolve(jmSrc, "hooks", "CursorPluginBootstrapHook.ts"), out: "CursorPluginBootstrapHook" },
		// The second manifest-launched entry. Like the bootstrap it is reached through
		// ${CURSOR_PLUGIN_ROOT} and never through dist-paths/, so it stays OUT of
		// DistPathWriter's REQUIRED_RUNTIME_FILES — see EXPECTED_ENTRY_OUTS below.
		{ in: resolve(jmSrc, "hooks", "CursorStopHook.ts"), out: "CursorStopHook" },
		// CursorStopHook launches this optional pass by a fixed sibling filename. It is
		// Cursor-only and never resolves through the machine-global dist registry.
		{ in: resolve(jmSrc, "hooks", "CursorDiscoveryWorker.ts"), out: "CursorDiscoveryWorker" },
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
		__JOLLI_CLIENT_KIND__: JSON.stringify("cursor-plugin"),
	},
};

// Guard the dist against a silently-dropped entry point. esbuild only fails on a
// missing *source* file, not on a removed `entryPoints` line. Asserting here means
// `build:cursor-plugin` — and therefore CI — catches the drift. Kept in lockstep with
// cli/src/install/DistPathWriter.ts REQUIRED_RUNTIME_FILES (those 10, plus the three
// Cursor-only entries that never resolve through dist-paths/: CursorPluginBootstrapHook
// and CursorStopHook, which the manifest launches directly via ${CURSOR_PLUGIN_ROOT},
// and CursorDiscoveryWorker, which the latter launches by fixed sibling filename).
//
// Those three must STAY out of REQUIRED_RUNTIME_FILES. That list is a machine-global
// contract — an incomplete dist is refused registration — so promoting a
// Cursor-only entry would make every already-installed dist of every other surface
// fail the completeness check and de-register itself. Same reason McpLauncher.js is
// deliberately excluded on the Codex side. The blocked-commit hazard that motivates
// the list does not reach these three either: a missing file here means Cursor's own
// capture or discovery path does not run, while the ten in REQUIRED_RUNTIME_FILES are
// exec'd by run-hook, where a missing file aborts the git operation.
const EXPECTED_ENTRY_OUTS = [
	"Cli",
	"CursorPluginBootstrapHook",
	"CursorStopHook",
	"CursorDiscoveryWorker",
	"StopHook",
	"SessionStartHook",
	"PostCommitHook",
	"PostMergeHook",
	"PostRewriteHook",
	"PrepareMsgHook",
	"PrePushHook",
	"QueueWorker",
	"PrePushWorker",
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
		`Built Cursor plugin dist/ v${pluginPkg.version} — ${options.entryPoints.length} entries ` +
			"(Cli.js, the 2 Cursor manifest hooks, their discovery worker, Stop/SessionStart hooks, the 5 git hooks, both shared workers) " +
			"plus the dashboard assets",
	);
}

/**
 * Mirrors the CLI's compiled dashboard page runtime into this dist.
 *
 * The assets are minified ONCE by the CLI's vite build (cli/dist/dashboard-assets)
 * and copied verbatim here — same DRY arrangement as the other plugins' build.mjs and
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
