import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));

export default defineConfig({
	define: {
		__PKG_VERSION__: JSON.stringify(pkg.version),
		__CLI_PKG_VERSION__: JSON.stringify(pkg.version),
		__JOLLI_CLIENT_KIND__: JSON.stringify("cli"),
	},
	build: {
		lib: {
			entry: {
				Cli: resolve(__dirname, "src/Cli.ts"),
				PostInstall: resolve(__dirname, "src/PostInstall.ts"),
				StopHook: resolve(__dirname, "src/hooks/StopHook.ts"),
				PostCommitHook: resolve(__dirname, "src/hooks/PostCommitHook.ts"),
				PostRewriteHook: resolve(__dirname, "src/hooks/PostRewriteHook.ts"),
				PrepareMsgHook: resolve(__dirname, "src/hooks/PrepareMsgHook.ts"),
				GeminiAfterAgentHook: resolve(__dirname, "src/hooks/GeminiAfterAgentHook.ts"),
				SessionStartHook: resolve(__dirname, "src/hooks/SessionStartHook.ts"),
			},
			formats: ["es"],
		},
		rollupOptions: {
			external: ["@anthropic-ai/sdk", "@mdx-js/mdx", "chokidar", "commander", "open", "yaml", /^node:.*/],
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
		// these otherwise-fine tests skim the 5s default — see install/* and
		// core/{Locks,KBPathResolver}.test.ts. 15s leaves headroom for hot
		// laptops + CI without hiding a genuinely stuck test for much longer.
		testTimeout: 15000,
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary"],
			exclude: ["src/Types.ts", "src/commands/StartCommand.ts", "src/commands/ReverseCommand.ts", "src/commands/ThemeCommand.ts", "src/site/ContentPlanner.ts", "src/site/themes/ThemeRegistry.ts", "vite.config.ts"],
			thresholds: {
				statements: 97,
				branches: 96,
				functions: 97,
				lines: 97,
			},
		},
	},
});
