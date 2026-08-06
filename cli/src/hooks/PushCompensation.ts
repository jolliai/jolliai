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
 * Starts an independent drain as a detached child. The child owns every network
 * request and never inherits stdio.
 *
 * Two callers, two shapes:
 *   - compensation (default): drains whatever `push-pending.json` holds, and
 *     skips entirely when there is no backlog file.
 *   - pre-push (`extraArgs` carries `--push-id`): drains THIS push's commits and
 *     publishes a result file. The backlog check is skipped — the hook has just
 *     written those entries, and a stat race must not silently drop the spawn.
 *
 * The boolean return only reports SYNCHRONOUS failures (no worker script, or
 * spawn throwing outright). The common ones — ENOENT on the node binary, EACCES
 * — surface asynchronously on the child's `error` event, which is what
 * `onSpawnError` is for: the pre-push hook uses it to publish a terminal result
 * so its poll loop exits on the next tick instead of waiting out the budget.
 */
export function triggerPendingPushRetry(
	cwd: string,
	trigger = "activation",
	extraArgs: ReadonlyArray<string> = [],
	onSpawnError?: (error: Error) => void,
): boolean {
	try {
		const projectDir = resolve(cwd);
		if (extraArgs.length === 0) {
			const pendingPath = join(getJolliMemoryDir(projectDir), PUSH_PENDING_FILE);
			if (!existsSync(pendingPath)) {
				log.debug("Push compensation (%s): no push-pending backlog", trigger);
				return false;
			}
		}

		const invocation = resolveWorkerInvocation();
		if (!invocation) {
			log.error("Push compensation (%s): PrePushWorker entry not found", trigger);
			return false;
		}

		const traceId = getCurrentTraceId();
		const child = spawnHidden(
			process.execPath,
			[...invocation.nodeArgs, invocation.scriptPath, "--cwd", projectDir, "--trigger", trigger, ...extraArgs],
			{
				detached: true,
				stdio: "ignore",
				cwd: projectDir,
				...(traceId ? { env: { ...process.env, [TRACE_ID_ENV]: traceId } } : {}),
			},
		);
		child.once("error", (error) => {
			log.debug("Push compensation (%s) worker failed to start: %s", trigger, errMsg(error));
			onSpawnError?.(error);
		});
		child.unref();
		return true;
	} catch (error) {
		log.debug("Push compensation (%s) trigger failed: %s", trigger, errMsg(error));
		return false;
	}
}
