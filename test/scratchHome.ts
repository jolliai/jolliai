/**
 * One scratch-home ROOT per test RUN — created before the first worker starts,
 * removed after the last one exits. Wired in as `globalSetup` in all three vitest
 * configs, alongside the `setupFiles` entry (`test/gitEnv.ts`) that makes the
 * per-file homes underneath it.
 *
 * ## Why a globalSetup and not more logic in the setup file
 *
 * `gitEnv.ts` used `process.env.JOLLI_TEST_HOME` as its "already made one" flag,
 * on the reading that a setup module re-evaluates inside a REUSED worker process.
 * That is true of `isolate: false`; the CLI config pins `pool: "forks"` and takes
 * vitest's default `isolate: true`, which forks a fresh process per test FILE — so
 * nothing survives to be found, the flag was never once set on entry, and the
 * result was one `mkdtemp` per file rather than per worker. Measured: 4 files → 4
 * directories, and 2708 of them had accumulated in one developer's `%TEMP%`. None
 * were ever removed, since the old comment correctly observed that no worker knows
 * whether it is the last one.
 *
 * A globalSetup is the one place that DOES know: it runs in the vitest main
 * process, its teardown runs after every worker has exited, and `process.env`
 * written here is inherited by each forked worker.
 *
 * ## Why the per-file directory is kept
 *
 * Sharing one home across files would be a behaviour change, not a cleanup:
 * files run concurrently, and `~/.jolli/jollimemory/config.json`,
 * `dashboard-repos.json` and `dist-paths/` are single machine-global paths that
 * two files would then race on. So each file still gets its own `mkdtemp` — it is
 * just made INSIDE this run's root, which turns an unbounded scatter across
 * `os.tmpdir()` into one directory this file can delete wholesale.
 *
 * ## What still leaks
 *
 * A run killed with Ctrl-C never reaches `teardown`, so its root survives — one
 * directory per interrupted run instead of one per test file. `os.tmpdir()` is
 * still the OS's to reap; this only stops the suite from being the thing filling
 * it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Env var carrying this run's root. Read by `gitEnv.ts`; see its fallback. */
export const SCRATCH_HOME_ROOT_VAR = "JOLLI_TEST_HOME_ROOT";

export function setup(): void {
	process.env[SCRATCH_HOME_ROOT_VAR] = mkdtempSync(join(tmpdir(), "jolli-test-homes-"));
}

export function teardown(): void {
	const root = process.env[SCRATCH_HOME_ROOT_VAR];
	if (!root) return;
	// `force` so an already-reaped root is not an error, and `maxRetries` because
	// Windows refuses to unlink a file another process still holds open — a worker
	// that outlived its own exit signal by a few milliseconds would otherwise fail
	// the whole run in teardown, long after every test had passed.
	rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
