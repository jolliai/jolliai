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
			exclude: ["src/index.ts", "vite.config.ts", "**/*.test.ts"],
			thresholds: {
				statements: 97,
				branches: 96,
				functions: 97,
				lines: 97,
			},
		},
	},
});
