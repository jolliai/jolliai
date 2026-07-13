#!/usr/bin/env node
/**
 * PrePushWorker — detached background process spawned by PrePushHook.
 *
 * Runs the actual network sync (`processPushPending`) so a slow or offline
 * Jolli Space never delays or fails the user's `git push`. Mirrors the
 * QueueWorker launch/spawn pattern: `spawnHidden` + `detached` + `stdio:
 * "ignore"` + `child.unref()`.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { processPushPending } from "../core/PushExecutor.js";
import { getCurrentTraceId, runWithTrace, TRACE_ID_ENV, traceIdFromEnv } from "../core/TraceContext.js";
import { createLogger } from "../Logger.js";
import { spawnHidden } from "../util/Subprocess.js";

const log = createLogger("PrePushWorker");

/** Drains push-pending.json to Jolli Space. Entry point for the detached run. */
export async function runPushWorker(cwd: string): Promise<void> {
	await processPushPending(cwd, { source: "pre-push" });
}

/**
 * Spawns a detached PrePushWorker process. Locates `PrePushWorker.js` by
 * `dirname(import.meta.url) + basename` — NOT by `import.meta.url` alone —
 * because esbuild inlines this function into the PrePushHook bundle, where
 * `import.meta.url` would resolve to PrePushHook.js. Both scripts are siblings
 * in the same dist dir (guaranteed by the vite/esbuild entries), so resolving
 * by directory + explicit filename always finds the right script (same trick as
 * QueueWorker.launchWorker).
 */
/* v8 ignore start -- spawns a real detached child; not exercised in unit tests */
export function launchPrePushWorker(cwd: string): void {
	const dir = dirname(fileURLToPath(import.meta.url));
	const scriptPath = join(dir, "PrePushWorker.js");
	if (!existsSync(scriptPath)) {
		log.error("PrePushWorker.js not found at %s — skipping push sync spawn", scriptPath);
		return;
	}

	// No Node flags before scriptPath (same rationale as launchWorker: the hook
	// runs under a bare `node`, possibly older than our engines floor). Propagate
	// the ambient trace id so the detached worker's logs share it.
	const traceId = getCurrentTraceId();
	const child = spawnHidden(process.execPath, [scriptPath, "--cwd", cwd], {
		detached: true,
		stdio: "ignore",
		cwd,
		...(traceId ? { env: { ...process.env, [TRACE_ID_ENV]: traceId } } : {}),
	});
	child.unref();
	log.info("PrePushWorker spawned (PID: %d)", child.pid ?? -1);
	/* v8 ignore stop */
}

// --- Script entry point (only when run directly, not when imported) ---
/* v8 ignore start */
function isMainScript(): boolean {
	const argv1 = process.argv[1];
	if (process.env.VITEST || !argv1) return false;

	const resolvedArgv = resolve(argv1);
	const resolvedScript = resolve(fileURLToPath(import.meta.url));
	if (resolvedArgv !== resolvedScript) return false;

	// Only auto-run when the entrypoint itself is PrePushWorker.
	// esbuild (CJS, no code splitting) inlines this module into PrePushHook.js,
	// where import.meta.url is aliased to the same __jmImportMetaUrl — without
	// the basename check both guards fire and PushExecutor runs in-process,
	// blocking git push. Same pattern as QueueWorker/PostCommitHook.
	const entryName = basename(resolvedArgv).toLowerCase();
	return entryName === "prepushworker.js" || entryName === "prepushworker.ts";
}

if (isMainScript()) {
	const args = process.argv.slice(2);
	const cwdIndex = args.indexOf("--cwd");
	const cwd = cwdIndex >= 0 && args[cwdIndex + 1] ? args[cwdIndex + 1] : process.cwd();

	runWithTrace(traceIdFromEnv(), () =>
		runPushWorker(cwd).catch((error: unknown) => {
			log.error("PrePushWorker fatal error: %s", error instanceof Error ? error.message : String(error));
			process.exit(0); // never signal failure — this is a background sync
		}),
	);
}
/* v8 ignore stop */
