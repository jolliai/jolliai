import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary"],
			exclude: ["vite.config.ts", "vitest.config.ts", "esbuild.config.mjs", "scripts/**", "dist/**", "assets/**", "src/Types.ts"],
			thresholds: {
				statements: 97,
				branches: 97,
				functions: 97,
				lines: 97,
			},
		},
	},
});
