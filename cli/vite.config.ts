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

export default defineConfig({
	plugins: [copyGraphAssets],
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
		// Acceptance suites live under `test/sync-acceptance/` and use real
		// `git init --bare` + mock backend. They run via the separate
		// `vitest.acceptance.config.ts` (npm run test:acceptance), so the
		// regular unit-test pass excludes them.
		exclude: ["test/sync-acceptance/**", "**/node_modules/**", "**/dist/**"],
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
		testTimeout: 45000,
		hookTimeout: 45000,
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary"],
			exclude: ["src/Types.ts", "vite.config.ts", "test/**", "src/graph/assets/**"],
			thresholds: {
				statements: 97,
				branches: 96,
				functions: 97,
				lines: 97,
			},
		},
	},
});
