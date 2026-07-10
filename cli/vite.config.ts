import { cpSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));

// The knowledge-graph viz runtime (HTML/CSS/JS/vendor) is read at runtime by
// `jolli graph --export`, relative to the bundle. Copy it next to dist/ as
// graph-assets/ so it ships in the published package. (The VS Code extension
// has its own copy step; this one is CLI-only.)
const copyGraphAssets = {
	name: "copy-graph-assets",
	closeBundle() {
		cpSync(resolve(__dirname, "src/graph/assets"), resolve(__dirname, "dist/graph-assets"), { recursive: true });
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
