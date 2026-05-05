import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));

export default defineConfig({
	define: {
		__PKG_VERSION__: JSON.stringify(pkg.version),
		__CLI_PKG_VERSION__: JSON.stringify(pkg.version),
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
			external: ["@anthropic-ai/sdk", "@mdx-js/mdx", "chokidar", "commander", "open", /^node:.*/],
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
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary"],
			exclude: ["src/Types.ts", "vite.config.ts"],
			thresholds: {
				statements: 97,
				branches: 96,
				functions: 97,
				lines: 97,
			},
		},
	},
});
