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
		// Real git + filesystem fixtures need a healthy timeout per test.
		testTimeout: 30_000,
		// Each test gets its own bare repo + worktrees; running in parallel
		// risks port-free git-daemon races. Pin to sequential for now.
		fileParallelism: false,
	},
});
