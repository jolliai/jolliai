import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: ["**/node_modules/**", "**/dist/**"],
		clearMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary"],
			// Only instrument source files. Default v8 instruments anything
			// loaded by Node, which sweeps in the workspace's own `dist/` as a
			// side effect of `npm run all` rebuilding right before testing.
			include: ["src/**/*.ts"],
			exclude: ["src/index.ts", "vite.config.ts", "**/*.test.ts", "**/dist/**"],
			thresholds: {
				statements: 97,
				branches: 96,
				functions: 97,
				lines: 97,
			},
		},
	},
});
