/**
 * PushCompensation — detached retry entry point shared by the TypeScript
 * surfaces that activate Jolli Memory:
 *   - VS Code   activation and successful sign-in
 *   - CLI       `jolli enable`, `jolli auth login`, and the guided front door
 *
 * The caller only checks local state and starts PrePushWorker as a detached
 * child. Network work and push-pending processing never run in the caller's
 * process, so CLI commands and VS Code activation do not wait for compensation.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUSH_PENDING_FILE } from "../core/PushPendingStore.js";
import { getCurrentTraceId, TRACE_ID_ENV } from "../core/TraceContext.js";
import { createLogger, errMsg, getJolliMemoryDir } from "../Logger.js";
import { spawnHidden } from "../util/Subprocess.js";

const log = createLogger("PushCompensation");

interface WorkerInvocation {
	readonly scriptPath: string;
	readonly nodeArgs: ReadonlyArray<string>;
}

/** Resolves the built worker, with a tsx-compatible source fallback for development. */
function resolveWorkerInvocation(): WorkerInvocation | undefined {
	const dir = dirname(fileURLToPath(import.meta.url));
	const builtWorker = join(dir, "PrePushWorker.js");
	if (existsSync(builtWorker)) {
		return { scriptPath: builtWorker, nodeArgs: [] };
	}

	// `npm run cli` executes the source through tsx. Reuse that process's Node
	// loader arguments so development also keeps the compensation process
	// boundary instead of falling back to in-process work.
	const sourceWorker = join(dir, "PrePushWorker.ts");
	if (existsSync(sourceWorker)) {
		return { scriptPath: sourceWorker, nodeArgs: process.execArgv };
	}

	return undefined;
}

/**
 * Starts an independent compensation drain when push-pending.json exists.
 * The detached child owns every network request and never inherits stdio.
 * Spawn failures are logged and left for the next trigger.
 */
export function triggerPendingPushRetry(cwd: string, trigger = "activation"): void {
	try {
		const projectDir = resolve(cwd);
		const pendingPath = join(getJolliMemoryDir(projectDir), PUSH_PENDING_FILE);
		if (!existsSync(pendingPath)) {
			log.debug("Push compensation (%s): no push-pending backlog", trigger);
			return;
		}

		const invocation = resolveWorkerInvocation();
		if (!invocation) {
			log.error("Push compensation (%s): PrePushWorker entry not found", trigger);
			return;
		}

		const traceId = getCurrentTraceId();
		const child = spawnHidden(
			process.execPath,
			[...invocation.nodeArgs, invocation.scriptPath, "--cwd", projectDir, "--trigger", trigger],
			{
				detached: true,
				stdio: "ignore",
				cwd: projectDir,
				...(traceId ? { env: { ...process.env, [TRACE_ID_ENV]: traceId } } : {}),
			},
		);
		child.once("error", (error) => {
			log.debug("Push compensation (%s) worker failed to start: %s", trigger, errMsg(error));
		});
		child.unref();
	} catch (error) {
		log.debug("Push compensation (%s) trigger failed: %s", trigger, errMsg(error));
	}
}
