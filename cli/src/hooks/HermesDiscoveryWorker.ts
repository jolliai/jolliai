#!/usr/bin/env node
/**
 * Detached reference-and-skill discovery pass launched by {@link HermesStopHook}.
 *
 * The stop hook has already saved the session and dashboard row before it starts
 * this process. Keeping discovery here gives Hermes users the same immediate
 * sidebar refresh Claude and Cursor have, without keeping the synchronous hook
 * alive behind SQLite reads or a contended plans lock (Hermes' own default
 * timeout for a shell hook is 5 s — enough for the fast path, not for a large
 * scan).
 *
 * Consent and disablement are deliberately rechecked in this process. The
 * repository may be disabled, uninstalled, or have its Hermes integration
 * switched off between the parent check and child startup; a detached worker
 * must not rely on stale authority inherited from its launcher.
 */

import { basename, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStateRoot } from "../core/GitOps.js";
import { discoverHermesConversations } from "../core/HermesDiscovery.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { loadConfig } from "../core/SessionTracker.js";
import { discoverHermesSkills } from "../core/skills/HermesSkillDiscovery.js";
import { isGitHookInstalled } from "../install/GitHookInstaller.js";
import { createLogger, setLogDir } from "../Logger.js";

const log = createLogger("HermesDiscoveryWorker");

/** Runs one idempotent discovery pass (skills + references) for an opted-in Hermes repository. */
export async function runHermesDiscoveryWorker(cwd: string): Promise<void> {
	const worktreeRoot = resolveStateRoot(cwd);
	setLogDir(worktreeRoot);

	if (!(await isGitHookInstalled(worktreeRoot))) {
		log.debug("Hermes discovery skipped — repository is no longer set up");
		return;
	}
	if (await readManualDisableFlag(worktreeRoot)) {
		log.info("Hermes discovery skipped — repository manually disabled");
		return;
	}
	if ((await loadConfig()).hermesEnabled === false) {
		log.info("Hermes discovery skipped — Hermes integration disabled");
		return;
	}

	// Both passes run in parallel — they own disjoint disk targets (skills write
	// under `plans.json.skills`; references land per-reference files via
	// `upsertReferenceEntry`) so they cannot contend. Individual `.catch` here
	// keeps one failing pass from cancelling the other via `Promise.all`.
	await Promise.all([
		discoverHermesSkills(worktreeRoot).catch((error: unknown) => {
			log.warn("Hermes skill discovery failed (non-fatal): %s", (error as Error).message);
		}),
		discoverHermesConversations(worktreeRoot).catch((error: unknown) => {
			log.warn("Hermes reference discovery failed (non-fatal): %s", (error as Error).message);
		}),
	]);
}

/** True only when this standalone worker file is the process entry point. */
/* v8 ignore start */
function isMainScript(): boolean {
	const argv1 = process.argv[1];
	if (process.env.VITEST || !argv1) return false;
	if (pathResolve(argv1) !== pathResolve(fileURLToPath(import.meta.url))) return false;
	const entryName = basename(argv1).toLowerCase();
	return entryName === "hermesdiscoveryworker.js" || entryName === "hermesdiscoveryworker.ts";
}

if (isMainScript()) {
	const args = process.argv.slice(2);
	const cwdIndex = args.indexOf("--cwd");
	const cwd = cwdIndex >= 0 && args[cwdIndex + 1] ? args[cwdIndex + 1] : process.cwd();
	void runHermesDiscoveryWorker(cwd).catch((error: unknown) => {
		log.error("Hermes discovery worker failed: %s", error instanceof Error ? error.message : String(error));
	});
}
/* v8 ignore stop */
