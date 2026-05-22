import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Mirrors cli/vite.config.ts — auto-reset framework state between every
		// `it()` so tests can't lean on pollution from earlier tests in the
		// same file. `restoreMocks` intentionally omitted (would break module-
		// top-level `vi.spyOn`s reused across `it()` calls).
		clearMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
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
