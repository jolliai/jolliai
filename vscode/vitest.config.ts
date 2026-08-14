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
		// Neutralize the developer's git configuration for every test file, the
		// same way the CLI and acceptance suites do — the file is at the repo
		// root because all three share it. 15 files in this suite shell out to
		// real git, and `JolliMemoryBridge.integration.test.ts` runs a real
		// `git commit`: without this, a `commit.gpgsign=true` + gitsign or a
		// `core.hooksPath` pointing at husky/lefthook makes that commit block on
		// an external process, which surfaces as a hook timeout and reads as a
		// flaky test rather than as the machine-config problem it is. Read the
		// file's header before adding a git env var — in particular it explains
		// why an author identity is deliberately NOT injected.
		setupFiles: [resolve(packageRoot, "../test/gitEnv.ts")],
		// Pairs with the line above — see `test/scratchHome.ts`.
		globalSetup: [resolve(packageRoot, "../test/scratchHome.ts")],
		// This suite is not pure-unit: `ManualDisableFlag` / `BackfillDismissFlag`
		// read and write real flag files through `RepoProfile`, which resolves the
		// main worktree by spawning `git rev-parse --git-common-dir`, and
		// `JolliMemoryBridge.integration.test.ts` drives the bridge end-to-end.
		// Under `--coverage` those tests skim vitest's 5s default on a busy
		// machine and fail as `Test timed out in 5000ms` — a load signal that
		// reads like a regression in flag handling. They pass in isolation, which
		// is the tell.
		//
		// 60s, up from 30s: `JolliMemoryBridge.integration.test.ts`'s `beforeEach`
		// (four sequential `git` spawns — `init`, two `config`, `commit`) blew the
		// 30s hook budget as `Hook timed out in 30000ms` on a machine running
		// several suites at once, even though the same sequence takes ~70ms
		// unloaded and the whole 107-file suite passes in ~33s on its own. That
		// matches the CLI budget, raised to 60s for the same reason (see
		// `cli/vite.config.ts`). Raising the ceiling costs nothing on a green run;
		// a genuinely stuck test still fails within the minute.
		//
		// This budget and the `setupFiles` isolation above fix two different
		// things: the budget absorbs CPU contention (the observed failure — the
		// same file is green in 1.7s alone), the isolation prevents a blocked git
		// child, which no timeout can rescue. Don't collapse one into the other.
		//
		// Tune here, not per-file: `vi.setConfig` in a test file REPLACES this
		// value rather than widening it, and a `--testTimeout` flag cannot
		// override such a file-local clamp.
		testTimeout: 60_000,
		hookTimeout: 60_000,
		coverage: {
			provider: "custom",
			customProviderModule: resolvePackageModule("@vitest/coverage-v8/dist/index.js"),
			reporter: ["text", "json-summary", "html"],
			exclude: [
				"vite.config.ts",
				"vitest.config.ts",
				"esbuild.config.mjs",
				"scripts/**",
				"dist/**",
				"assets/**",
			],
			thresholds: {
				statements: 97,
				branches: 97,
				functions: 97,
				lines: 97,
			},
		},
	},
};
