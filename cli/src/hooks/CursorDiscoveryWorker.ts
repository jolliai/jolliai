#!/usr/bin/env node
/**
 * Detached skill-discovery pass launched by the Cursor plugin's synchronous stop hook.
 *
 * The stop hook has already saved the session and dashboard row before it starts this
 * process. Keeping discovery here gives Cursor the same immediate SKILLS-panel update
 * without making the hook wait for transcript I/O or a contended plans lock.
 *
 * Consent and disablement are deliberately rechecked in this process. The repository
 * may be disabled, uninstalled, or have its Cursor integration switched off between
 * the parent check and child startup; a detached worker must not rely on stale authority
 * inherited from its launcher.
 */

import { basename, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverCursorConversations } from "../core/CursorDiscovery.js";
import { resolveStateRoot } from "../core/GitOps.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { loadConfig } from "../core/SessionTracker.js";
import { isGitHookInstalled } from "../install/GitHookInstaller.js";
import { createLogger, setLogDir } from "../Logger.js";

const log = createLogger("CursorDiscoveryWorker");

/** Runs one idempotent discovery pass for an opted-in Cursor repository. */
export async function runCursorDiscoveryWorker(cwd: string): Promise<void> {
	const worktreeRoot = resolveStateRoot(cwd);
	// Before the first log line: an independently-launched worker must not fall back to
	// a plugin-bundle cwd if its caller supplied an unusable path.
	setLogDir(worktreeRoot);

	if (!(await isGitHookInstalled(worktreeRoot))) {
		log.debug("Cursor discovery skipped — repository is no longer set up");
		return;
	}
	if (await readManualDisableFlag(worktreeRoot)) {
		log.info("Cursor discovery skipped — repository manually disabled");
		return;
	}
	if ((await loadConfig()).cursorEnabled === false) {
		log.info("Cursor discovery skipped — Cursor integration disabled");
		return;
	}

	await discoverCursorConversations(worktreeRoot);
}

/** True only when this standalone worker file is the process entry point. */
/* v8 ignore start */
function isMainScript(): boolean {
	const argv1 = process.argv[1];
	if (process.env.VITEST || !argv1) return false;
	if (pathResolve(argv1) !== pathResolve(fileURLToPath(import.meta.url))) return false;
	const entryName = basename(argv1).toLowerCase();
	return entryName === "cursordiscoveryworker.js" || entryName === "cursordiscoveryworker.ts";
}

if (isMainScript()) {
	const args = process.argv.slice(2);
	const cwdIndex = args.indexOf("--cwd");
	const cwd = cwdIndex >= 0 && args[cwdIndex + 1] ? args[cwdIndex + 1] : process.cwd();
	void runCursorDiscoveryWorker(cwd).catch((error: unknown) => {
		// Background discovery is opportunistic: leave the durable session capture intact
		// and let the post-commit / periodic scan paths retry it.
		log.error("Cursor discovery worker failed: %s", error instanceof Error ? error.message : String(error));
	});
}
/* v8 ignore stop */
