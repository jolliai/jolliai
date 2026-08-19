import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { transform } from "esbuild";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));

// The knowledge-graph viz runtime (HTML/CSS/JS/vendor) is read at runtime by
// `jolli graph --export`, relative to the bundle. Copy it next to dist/ as
// graph-assets/ — this is the CANONICAL, compressed source of the viz: authored
// JS/CSS are esbuild-minified here; vendor/ + index.html are copied verbatim
// (index.html keeps its `<!-- scripts:start -->` / charset / stylesheet markers;
// vendor is already in distributed form — elk is GWT-compiled and barely
// minifies). Both this CLI (for `graph --export`) and downstream consumers (the
// VS Code extension and the Jolli web app) copy FROM this output — no one
// re-minifies, so compression lives in exactly one place (DRY).
const graphAssetsSrc = resolve(__dirname, "src/graph/assets");
const graphAssetsDest = resolve(__dirname, "dist/graph-assets");

function walkGraphAssets(dir: string): Array<string> {
	const out: Array<string> = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkGraphAssets(abs));
		} else {
			out.push(abs);
		}
	}
	return out;
}

/** Minify the code we author (js/ + css); ship vendor/ + html verbatim. */
function shouldMinifyGraphAsset(file: string): boolean {
	if (file.replaceAll("\\", "/").includes("/vendor/")) {
		return false;
	}
	const ext = extname(file);
	return ext === ".css" || ext === ".js";
}

const copyGraphAssets = {
	name: "copy-graph-assets",
	async closeBundle() {
		rmSync(graphAssetsDest, { recursive: true, force: true });
		for (const abs of walkGraphAssets(graphAssetsSrc)) {
			const out = join(graphAssetsDest, relative(graphAssetsSrc, abs));
			mkdirSync(dirname(out), { recursive: true });
			if (shouldMinifyGraphAsset(abs)) {
				const { code } = await transform(readFileSync(abs, "utf8"), {
					minify: true,
					loader: extname(abs) === ".css" ? "css" : "js",
					legalComments: "inline", // preserve @license / @preserve banners
				});
				writeFileSync(out, code, "utf8");
			} else {
				cpSync(abs, out);
			}
		}
	},
};

// The dashboard runtime (HTML/CSS/JS) follows the exact same model as the
// graph viz above: authored assets under src/dashboard/assets/ are minified
// into dist/dashboard-assets/, read at runtime by DashboardServer relative to
// the bundle (resolveDashboardAssetsDir).
const dashboardAssetsSrc = resolve(__dirname, "src/dashboard/assets");
const dashboardAssetsDest = resolve(__dirname, "dist/dashboard-assets");

// One vendored file joins them at build time: `marked`, for /context-viewer.
// It is NOT duplicated in git — the graph viz's copy stays the only one in the
// tree, and this step places it where every downstream surface can reach it.
//
// That indirection is the whole point. Only the CLI's own dist ships
// `graph-assets/`; `vscode/dist` and the three plugin bundles copy
// `dashboard-assets/` alone, so a viewer that resolved `marked` from the graph
// tree would 500 on four surfaces out of five — exactly as /wiki-viewer and
// /graph-viewer already do there. Copying it here means the existing
// copy-dashboard-assets step downstream carries it for free.
//
// Not minified: it is already a minified vendor bundle, and re-minifying an
// unfamiliar one only risks changing it. Same reason `shouldMinifyGraphAsset`
// skips everything under `vendor/`.
const markedVendorSrc = resolve(__dirname, "src/graph/assets/vendor/marked.min.js");

const copyDashboardAssets = {
	name: "copy-dashboard-assets",
	async closeBundle() {
		rmSync(dashboardAssetsDest, { recursive: true, force: true });
		for (const abs of walkGraphAssets(dashboardAssetsSrc)) {
			const out = join(dashboardAssetsDest, relative(dashboardAssetsSrc, abs));
			mkdirSync(dirname(out), { recursive: true });
			if (shouldMinifyGraphAsset(abs)) {
				const { code } = await transform(readFileSync(abs, "utf8"), {
					minify: true,
					loader: extname(abs) === ".css" ? "css" : "js",
				});
				writeFileSync(out, code, "utf8");
			} else {
				cpSync(abs, out);
			}
		}
		const markedOut = join(dashboardAssetsDest, "vendor", "marked.min.js");
		mkdirSync(dirname(markedOut), { recursive: true });
		cpSync(markedVendorSrc, markedOut);
	},
};

/**
 * The two lists below define the two test tiers, and they MUST be maintained
 * together. Profiling the suite with `--reporter=json` shows a small set of
 * files carrying ~96% of the runtime while the median file takes 14 ms; every
 * one of them drives real `git` subprocesses or real filesystem/lock work.
 *
 * `SLOW_TEST_FILES` is the SINGLE source of truth for the split, and it drives
 * both tiers from opposite directions:
 *
 *   `--mode fast` (npm run test:fast) → EXCLUDES these files. Takes the run
 *       from ~5 min to ~57 s (425 files, 11.2k tests). It must then also drop
 *       the source they are responsible for from the coverage denominator, or
 *       the 97/96/97/97 thresholds fail on a suite that passed — measured twice
 *       now, most recently when the dashboard six were added: 425 files all
 *       green, 94.93% branches, exit 1. That is `SLOW_ONLY_SOURCES`.
 *   `--mode slow` (npm run test:slow) → runs ONLY these files, as `include`
 *       (21 files, 867 tests, no coverage, and its own `maxWorkers` — see below).
 *
 * The counts move. Re-derive them with `npx vitest list --filesOnly [--mode …]`
 * rather than trusting this paragraph; the previous version of it still claimed
 * 12 / 324 long after the lists had grown to 15 / 431.
 *
 * Deriving both tiers from one list is deliberate: the previous arrangement
 * duplicated the 12 paths into an npm script, where adding a 13th slow file and
 * updating only one copy left that file running in BOTH tiers or NEITHER, with
 * nothing to catch it. Entries are exact repo-relative paths rather than
 * `**\/{A,B}.test.ts` brace globs for the same reason — a bare basename like
 * `Locks.test.ts` or `Installer.test.ts` would silently capture a future
 * same-named file somewhere else in the tree.
 *
 * The test-file → source mapping is NOT one-to-one, which is exactly why
 * `SLOW_ONLY_SOURCES` is derived from measurement rather than guessed:
 * `Installer.test.ts` alone is the only meaningful cover for four separate
 * hook-installer modules, and `Locks.ts` / `GitHookInstaller.ts` are partially
 * covered by other tests. Re-derive both lists from a real run rather than
 * editing them by inspection:
 *
 *   npm run test -w @jolli.ai/cli -- --reporter=json --outputFile=/tmp/prof.json
 *       → slowest files, for SLOW_TEST_FILES
 *   npm run test:fast -w @jolli.ai/cli
 *       → cli/coverage/coverage-summary.json, any file under ~80% lines
 *         belongs in SLOW_ONLY_SOURCES
 *
 * Keep the coverage exclusion inside the `fast` branch. It must never apply to
 * the default (gate) mode: that would silently stop the coverage floor from
 * protecting sync/ and install/ at all, which is the one thing the floor exists
 * for. Headroom is thin by design — the fast run lands at 96.74% branches
 * against a 96% threshold — so if `test:fast` goes red on coverage alone, the
 * honest read is "this list needs re-deriving", not "lower the threshold".
 */
const SLOW_TEST_FILES = [
	"src/backfill/CommitTargetIndex.test.ts",
	"src/core/BranchCommitLister.test.ts",
	"src/core/FileDiscardService.test.ts",
	"src/core/GitFsLayout.realgit.test.ts",
	"src/core/GitOps.stateRoot.realgit.test.ts",
	"src/core/KBPathResolver.test.ts",
	"src/core/Locks.test.ts",
	"src/core/repair/GitReachability.realgit.test.ts",
	"src/core/repair/ReflogPairing.realgit.test.ts",
	"src/core/RepoProfile.test.ts",
	"src/core/SessionDirMatch.realgit.test.ts",
	"src/core/SpaceBindingCache.test.ts",
	"src/daemon/DaemonServer.test.ts",
	// The dashboard/cutover six. Added later than the rest and easy to miss why
	// they belong: they are not "SQLite tests" — each one seeds a REAL repo and
	// drives `git` subprocesses through cutover, so they carry the same
	// whole-machine load profile as sync/ and install/. Profiled together they
	// are 411 s of the directory's 419 s, with a 15x cliff to the next file
	// (Backup 23.4 s → SotImport 1.5 s), and `CutoverEngine` at 177 s is now the
	// single heaviest file in the suite — past `GitClient` (167 s).
	//
	// Leaving them in the fast tier is what made `npm run all` red on three
	// consecutive runs while every one of them passed in isolation
	// (`Recovery.test.ts`: 9.4 s alone, >60 s timeout under fan-out).
	"src/dashboard/AutoCutover.test.ts",
	"src/dashboard/Backup.test.ts",
	"src/dashboard/CutoverEngine.test.ts",
	"src/dashboard/CutoverRouter.test.ts",
	"src/dashboard/ImportState.test.ts",
	"src/dashboard/Recovery.test.ts",
	"src/install/DispatchScripts.test.ts",
	"src/install/GitExclude.test.ts",
	"src/install/Installer.test.ts",
	"src/sync/BootstrapMerge.test.ts",
	"src/sync/GitClient.test.ts",
	"src/sync/SyncBootstrap.test.ts",
];

const SLOW_ONLY_SOURCES = [
	"src/backfill/CommitTargetIndex.ts",
	"src/core/BranchCommitLister.ts",
	"src/core/FileDiscardService.ts",
	"src/core/KBPathResolver.ts",
	"src/core/Locks.ts",
	"src/core/repair/GitReachability.ts",
	"src/core/repair/ReflogPairing.ts",
	"src/core/RepoProfile.ts",
	"src/core/SpaceBindingCache.ts",
	"src/daemon/DaemonServer.ts",
	// The six dashboard/cutover sources, and ONLY those six — re-derived from a
	// real `--mode fast` run rather than by pairing test files with same-named
	// modules. The cliff is unambiguous: these land at 1.9-57.1% lines while the
	// next dashboard source is at 90.1%, because the rest of the directory is
	// covered by tests that stay in the fast tier. `DashboardDb` / `RepoRegistry`
	// / `SotWrite` are imported by all six and are deliberately absent here.
	"src/dashboard/AutoCutover.ts",
	"src/dashboard/Backup.ts",
	"src/dashboard/CutoverEngine.ts",
	"src/dashboard/CutoverRouter.ts",
	"src/dashboard/ImportState.ts",
	"src/dashboard/Recovery.ts",
	"src/install/ClaudeHookInstaller.ts",
	"src/install/DispatchScripts.ts",
	"src/install/GeminiHookInstaller.ts",
	"src/install/GitExclude.ts",
	"src/install/GitHookInstaller.ts",
	"src/install/HookSettingsHelper.ts",
	"src/install/Installer.ts",
	"src/sync/BootstrapMerge.ts",
	"src/sync/GitClient.ts",
	"src/sync/SyncBootstrap.ts",
];

export default defineConfig(({ mode }) => {
	// `vitest run --mode fast` / `--mode slow` — set by `npm run test:fast` and
	// `npm run test:slow`. Using vite's own `mode` rather than an env var keeps
	// the switch cross-platform: an `FOO=1 vitest` prefix in an npm script does
	// not work under Windows cmd.
	const fast = mode === "fast";
	const slow = mode === "slow";

	return {
		plugins: [copyGraphAssets, copyDashboardAssets],
		define: {
			__PKG_VERSION__: JSON.stringify(pkg.version),
			__CLI_PKG_VERSION__: JSON.stringify(pkg.version),
			__JOLLI_CLIENT_KIND__: JSON.stringify("cli"),
		},
		build: {
			lib: {
				entry: {
					Cli: resolve(__dirname, "src/Cli.ts"),
					Api: resolve(__dirname, "src/Api.ts"),
					PostInstall: resolve(__dirname, "src/PostInstall.ts"),
					StopHook: resolve(__dirname, "src/hooks/StopHook.ts"),
					PostCommitHook: resolve(__dirname, "src/hooks/PostCommitHook.ts"),
					PostRewriteHook: resolve(__dirname, "src/hooks/PostRewriteHook.ts"),
					PrepareMsgHook: resolve(__dirname, "src/hooks/PrepareMsgHook.ts"),
					GeminiAfterAgentHook: resolve(__dirname, "src/hooks/GeminiAfterAgentHook.ts"),
					SessionStartHook: resolve(__dirname, "src/hooks/SessionStartHook.ts"),
					PostMergeHook: resolve(__dirname, "src/hooks/PostMergeHook.ts"),
					PrePushHook: resolve(__dirname, "src/hooks/PrePushHook.ts"),
					PrePushWorker: resolve(__dirname, "src/hooks/PrePushWorker.ts"),
					QueueWorker: resolve(__dirname, "src/hooks/QueueWorker.ts"),
					// No DashboardServerEntry: `jolli dashboard` serves in its own
					// process now, so the server is part of Cli.js. `dist/dashboard-assets/`
					// is still emitted (see the copy plugin above) — the page runtime is
					// read from disk at render time, not bundled.
				},
				formats: ["es"],
			},
			rollupOptions: {
				external: ["@anthropic-ai/sdk", "commander", "open", "semver", /^node:.*/],
				output: {
					chunkFileNames: "[name].js",
				},
			},
			outDir: "dist",
			sourcemap: false,
			minify: "esbuild",
			ssr: true,
		},
		test: {
			// Pin the pool explicitly. vitest 4.x's implicit default-pool resolution
			// fails to inject the worker context on this toolchain (node 24.10 /
			// Windows) — every `describe()` then throws "Cannot read properties of
			// undefined (reading 'config')" at collection time. Naming any pool
			// restores worker init; `forks` matches vitest's historical default and
			// suits this suite's real `git init` / file-lock / fs tests.
			pool: "forks",
			// Trim the fan-out slightly below vitest's default (cpus - 1). ~13 test
			// files spawn real `git` subprocesses (clone/commit/push/rebase) and a
			// handful acquire real file locks; at full fan-out those subprocesses
			// compete with v8 coverage instrumentation for CPU and get starved,
			// which surfaces as `Test timed out in NNNNms` in sync/* and install/*
			// — contention noise indistinguishable at a glance from a regression,
			// and worthless besides: vitest emits NO coverage report at all when
			// any test fails, so a flaky round is a round paid for and discarded.
			//
			// This is `maxWorkers`, NOT `poolOptions.forks.maxForks`: vitest 4
			// REMOVED `poolOptions` and only prints a one-line DEPRECATED notice
			// when it sees one, so the nested form silently runs at full fan-out.
			// Measured on a 12-core box at full fan-out with a 45s budget: `tests
			// 1919s / wall 308s` (workers pinned the whole run) and one timeout —
			// the heaviest case in GitClient.test.ts (clone, commit, push, second
			// clone, pullRebase), which takes well under a second unloaded.
			//
			// Keep the trim mild — wall-clock here is paid on every pre-commit
			// gate run. It also applies to `--mode fast`, which does still run
			// `--coverage` (only `test:changed` drops it): the 12 real-`git` files
			// that motivated the cap are excluded there, but 324 instrumented
			// files remain and some of them touch the real filesystem, so lifting
			// the cap for `fast` is a measurement question rather than a free win.
			// Do NOT reach for `--testTimeout` — see the `testTimeout` note below
			// for why the CLI flag cannot help.
			//
			// ONE value for every mode, and `--mode slow` deliberately does NOT get
			// a tighter one — measured, because the obvious fix does not work.
			// `CutoverEngine.test.ts` (122.8 s and green when run alone) pushes one
			// case past the 60 s budget under the slow tier's own fan-out, and
			// halving the workers neither fixed it nor was cheap: 6 workers took
			// 448 s and still failed, on a DIFFERENT case in the same file, against
			// 357 s at 9. 4 workers ran past 20 minutes without finishing.
			//
			// The give-away is that total test CPU is unchanged across those runs
			// (2339 s at 6 workers vs 2328 s at 9). Whatever these files are waiting
			// on, it is not the CPU the worker count rations — the tier is 21 files
			// all driving `git`, and git's cost here is fsync. Fewer workers barely
			// reduces concurrent fsync pressure, so the only thing bought was
			// wall-clock. Do not re-litigate this without measuring an I/O lever.
			maxWorkers: "75%",
			// Neutralize the developer's git configuration for every test file —
			// see `test/gitEnv.ts` (repo root, shared with the acceptance and
			// vscode suites) for what is neutralized and why an author identity is
			// deliberately NOT injected.
			setupFiles: ["../test/gitEnv.ts"],
			// Makes (and afterwards removes) the one root the per-file scratch homes
			// above go into. Must be paired with that `setupFiles` entry wherever it
			// appears: without it the homes are still isolated, they just accumulate
			// in `os.tmpdir()` forever — see `test/scratchHome.ts`.
			globalSetup: ["../test/scratchHome.ts"],
			// `--mode slow` inverts the split: run ONLY the heavy files. Coverage
			// thresholds would obviously fail on 12 files, which is why
			// `npm run test:slow` does not pass `--coverage`.
			...(slow ? { include: SLOW_TEST_FILES } : {}),
			// Acceptance suites live under `test/sync-acceptance/` and use real
			// `git init --bare` + mock backend. They run via the separate
			// `vitest.acceptance.config.ts` (npm run test:acceptance), so the
			// regular unit-test pass excludes them.
			exclude: ["test/sync-acceptance/**", "**/node_modules/**", "**/dist/**", ...(fast ? SLOW_TEST_FILES : [])],
			// Auto-reset framework state between every `it()` so tests can't lean on
			// pollution left behind by an earlier test in the same file. Surfaces
			// hidden order dependencies instead of letting them stay green by luck.
			// NOTE: `restoreMocks` intentionally OMITTED — flipping it on breaks
			// ~175 tests in this suite that depend on module-top-level `vi.spyOn`s
			// surviving across `it()` calls. Cleaning that up is its own project.
			clearMocks: true,
			unstubEnvs: true,
			unstubGlobals: true,
			// A handful of tests really do `git init` / write files / acquire file
			// locks. Under `--coverage` the v8 instrumentation competes for CPU and
			// these otherwise-fine tests skim the 15s budget on busy laptops — see
			// install/*, sync/*, core/{Locks,KBPathResolver}.test.ts. Bumped to
			// 45s under spec 110 after consistent timeouts on `git init / clone`
			// when the full test suite + coverage runs hot. `hookTimeout` covers
			// `beforeAll` blocks (sync/GitClient.test.ts seeds a bare repo there).
			// Both are still bounded so a genuinely stuck test fails within a
			// minute, not minutes.
			//
			// This budget is the ONLY place to tune it. Two consequences that have
			// each cost a debugging session:
			//   1. A per-file `vi.setConfig({ testTimeout })` REPLACES this value
			//      rather than taking the larger of the two, so it can quietly
			//      shrink the budget for exactly the files that need it most.
			//      `sync/GitClient.test.ts` and `sync/BootstrapMerge.test.ts` both
			//      pinned themselves to 30s back when this global was 15s, and kept
			//      that clamp after the global rose to 45s — 33% less headroom than
			//      every pure-unit file, in the two heaviest real-git suites. Don't
			//      reintroduce a per-file override; raise this instead.
			//   2. `vitest --testTimeout=…` on the command line does NOT override a
			//      per-file `vi.setConfig`, so a run that looks like it was granted
			//      more time may not have been. If a serial/low-concurrency round
			//      goes green, credit the reduced load, not the flag.
			//
			// 60s (up from 45s) because the heaviest GitClient case still timed out
			// at 45s under a full-fan-out coverage run. Raising the ceiling is the
			// cheaper half of the fix — it costs nothing on a green run, whereas
			// throttling workers costs wall-clock on every run.
			testTimeout: 60000,
			hookTimeout: 60000,
			coverage: {
				provider: "v8",
				reporter: ["text", "json-summary"],
				exclude: [
					"src/Types.ts",
					"vite.config.ts",
					"test/**",
					"src/graph/assets/**",
					"src/dashboard/assets/**",
					// Only in `--mode fast`; never in the gate. See SLOW_ONLY_SOURCES.
					...(fast ? SLOW_ONLY_SOURCES : []),
				],
				thresholds: {
					statements: 97,
					branches: 96,
					functions: 97,
					lines: 97,
				},
			},
		},
	};
});
