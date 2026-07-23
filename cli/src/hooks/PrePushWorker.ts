#!/usr/bin/env node
/**
 * PrePushWorker — standalone drain of `push-pending.json` to Jolli Space.
 *
 * The pre-push hook itself syncs inline (`processPrePushInline`, one
 * budget-bound batch request scoped to the current push). This entry point is
 * the cross-process compensation drain used by CLI and VS Code activation /
 * sign-in triggers, as well as the IntelliJ plugin's Kotlin integration.
 * External orchestrators can use it the same way:
 * `node PrePushWorker.js --cwd <repo>`.
 *
 * Behavior matches the activation compensation path: eligible entries use the
 * batch endpoint first and fall back to per-commit `pushSummary` calls when an
 * item exceeds batch limits or the server predates batch support. Publishing
 * starts only after the remote ref confirms the git push actually landed.
 */

import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { processPushPending } from "../core/PushExecutor.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { runWithTrace, traceIdFromEnv } from "../core/TraceContext.js";
import { createLogger } from "../Logger.js";

const log = createLogger("PrePushWorker");

/** Drains push-pending.json to Jolli Space. Entry point for the standalone run. */
export async function runPushWorker(cwd: string, trigger = "activation"): Promise<void> {
	if (await readManualDisableFlag(cwd)) {
		log.info("PrePushWorker(%s): skipped — repository manually disabled", trigger);
		return;
	}
	log.info("PrePushWorker(%s): spawned compensation drain starting", trigger);
	const result = await processPushPending(cwd, { source: "activation" });
	log.info(
		"PrePushWorker(%s): drain done — attempted=%d pushed=%d failed=%d%s",
		trigger,
		result.attempted,
		result.pushed,
		result.failed,
		result.note ? ` (${result.note})` : "",
	);
}

// --- Script entry point (only when run directly, not when imported) ---
/* v8 ignore start */
function isMainScript(): boolean {
	const argv1 = process.argv[1];
	if (process.env.VITEST || !argv1) return false;

	const resolvedArgv = resolve(argv1);
	const resolvedScript = resolve(fileURLToPath(import.meta.url));
	if (resolvedArgv !== resolvedScript) return false;

	// Only auto-run when the entrypoint itself is PrePushWorker. esbuild (CJS,
	// no code splitting) can inline this module into sibling bundles, where
	// import.meta.url is aliased to the same __jmImportMetaUrl — without the
	// basename check the guard would fire inside those bundles too. Same
	// pattern as QueueWorker/PostCommitHook.
	const entryName = basename(resolvedArgv).toLowerCase();
	return entryName === "prepushworker.js" || entryName === "prepushworker.ts";
}

if (isMainScript()) {
	const args = process.argv.slice(2);
	const cwdIndex = args.indexOf("--cwd");
	const cwd = cwdIndex >= 0 && args[cwdIndex + 1] ? args[cwdIndex + 1] : process.cwd();
	const triggerIndex = args.indexOf("--trigger");
	const trigger = triggerIndex >= 0 && args[triggerIndex + 1] ? args[triggerIndex + 1] : "activation";

	runWithTrace(traceIdFromEnv(), () =>
		runPushWorker(cwd, trigger).catch((error: unknown) => {
			log.error("PrePushWorker fatal error: %s", error instanceof Error ? error.message : String(error));
			process.exit(0); // never signal failure — this is a background sync
		}),
	);
}
/* v8 ignore stop */
