import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const packageRequire = createRequire(resolve(packageRoot, "package.json"));

function resolvePackageModule(specifier: string): string {
	return packageRequire.resolve(specifier);
}

export default {
	root: packageRoot,
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		coverage: {
			provider: "custom",
			customProviderModule: resolvePackageModule("@vitest/coverage-v8/dist/index.js"),
			reporter: ["text", "json-summary", "html"],
			exclude: ["vite.config.ts", "vitest.config.ts", "esbuild.config.mjs", "scripts/**", "dist/**", "assets/**", "src/Types.ts"],
			thresholds: {
				statements: 97,
				branches: 97,
				functions: 97,
				lines: 97,
			},
		},
	},
};
