/**
 * Vitest config for the acceptance suite under `test/sync-acceptance/`.
 *
 * These tests spin up real `git init --bare` fixtures + worktree clones and
 * exercise the full `SyncEngine.runRound` loop against a mocked backend.
 * They take longer than unit tests (1-3 seconds each) so they're isolated
 * to their own runner — `npm run test:acceptance`.
 */

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
	test: {
		include: ["test/sync-acceptance/**/*.acceptance.test.ts"],
		// Same git isolation as the unit suite (`vite.config.ts`) and the vscode
		// suite. `test/sync-acceptance/_helpers.ts` already hardens every git
		// command the FIXTURES issue via `SAFE_GIT_OPTS`, but that cannot reach
		// the git subprocesses spawned by the production code under test — e.g.
		// `GitClient.commit()` passes an identity and no `commit.gpgsign=false`,
		// so on a machine with `commit.gpgsign=true` + a gitsign signer that
		// child blocks on an external process and the round dies as a timeout.
		// Env vars are inherited by those children; `-c` flags are not.
		setupFiles: ["../test/gitEnv.ts"],
		// Pairs with the line above — see `test/scratchHome.ts`.
		globalSetup: ["../test/scratchHome.ts"],
		// Real git + filesystem fixtures need a healthy timeout per test, and
		// `fileParallelism: false` below does NOT make them immune to load: these
		// rounds are git-subprocess-bound, so pressure from anything else on the
		// box lands on them directly. Measured on this suite: §1's idempotence
		// case runs the whole file in 11.8s alone, and blew a 30s budget when the
		// run started while the unit tier's forks were still winding down. 60s
		// matches `vite.config.ts` for the same reason — a ceiling costs nothing
		// on a green run, and a genuinely stuck round still fails inside a minute.
		// `hookTimeout` covers the `beforeEach` that builds each world (bare repo
		// + clone + seed commits).
		testTimeout: 60_000,
		hookTimeout: 60_000,
		// Each test gets its own bare repo + worktrees; running in parallel
		// risks port-free git-daemon races. Pin to sequential for now.
		fileParallelism: false,
	},
});
