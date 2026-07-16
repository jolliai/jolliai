#!/usr/bin/env node
/**
 * Post-Merge Hook
 *
 * Runs after `git pull` completes. Detects merge commits in the pulled
 * range and, when any are found, **enqueues a single repo-wide ingest
 * operation** onto the unified `git-op-queue/`. The QueueWorker picks it up
 * under the same lock as commit summaries.
 *
 * SP3 — collapses N per-branch compile enqueues to ONE repo-wide ingest op.
 * A single `git pull` with N merge commits enqueues a single ingest operation.
 * The enqueue is `force`d past IngestTrigger's per-cwd cooldown: a merge brings
 * in genuinely new content (commits authored elsewhere), so it must not be
 * suppressed by a cooldown a local commit just set. The repo-wide ingest op is
 * idempotent, so the occasional duplicate drain is benign.
 */

import { execGit } from "../core/GitOps.js";
import { enqueueIngestOperation } from "../core/IngestTrigger.js";
import { resolveLlmCredentialSource } from "../core/LlmClient.js";
import { loadConfig } from "../core/SessionTracker.js";
import { runWithTrace, traceIdFromEnv } from "../core/TraceContext.js";
import { createLogger, setLogDir } from "../Logger.js";
import { launchWorker } from "./QueueWorker.js";

const log = createLogger("PostMergeHook");

/**
 * Extracts branch names from merge commit messages.
 * Handles:
 * - "Merge branch 'feature/xxx' into main"
 * - "Merge pull request #N from user/feature/xxx"
 */
export function extractMergedBranches(logOutput: string): ReadonlyArray<string> {
	if (!logOutput.trim()) return [];

	const branches: string[] = [];
	const lines = logOutput.split("\n");

	for (const line of lines) {
		// "Merge branch 'feature/xxx'" pattern
		const branchMatch = line.match(/Merge branch '([^']+)'/);
		if (branchMatch) {
			branches.push(branchMatch[1]);
			continue;
		}

		// "Merge pull request #N from user/feature/xxx" pattern
		const prMatch = line.match(/Merge pull request #\d+ from [^/]+\/(.+)/);
		if (prMatch) {
			branches.push(prMatch[1]);
		}
	}

	return branches;
}

/**
 * Reflog-independent merge detection: returns HEAD's subject when HEAD is a
 * merge commit (≥2 parents), else "". Used when `HEAD@{1}` is unavailable
 * (fresh linked worktree / reflog disabled) so a real merge isn't dropped.
 */
async function detectMergeAtHead(cwd: string): Promise<string> {
	const parents = await execGit(["show", "-s", "--pretty=%P", "HEAD"], cwd);
	if (parents.exitCode !== 0) return "";
	const isMerge = parents.stdout.trim().split(/\s+/).filter(Boolean).length >= 2;
	if (!isMerge) return "";
	const subject = await execGit(["show", "-s", "--pretty=%s", "HEAD"], cwd);
	return subject.exitCode === 0 ? subject.stdout : "";
}

/**
 * Main post-merge hook handler.
 * Called by the git post-merge hook script.
 */
export async function handlePostMerge(cwd: string): Promise<void> {
	setLogDir(cwd);
	log.info("Post-merge hook triggered");

	// Detect merge commits in the pulled range via the HEAD reflog.
	const result = await execGit(["log", "--merges", "--pretty=format:%s", "HEAD@{1}..HEAD"], cwd);

	let mergeSubjects: string;
	if (result.exitCode === 0) {
		mergeSubjects = result.stdout;
	} else {
		// `HEAD@{1}` does not resolve in a freshly-added linked worktree (its HEAD
		// reflog has only one entry) or when core.logAllRefUpdates is off. A
		// non-fast-forward pull leaves the merge commit at HEAD, so fall back to
		// inspecting HEAD itself rather than silently skipping a real merge.
		mergeSubjects = await detectMergeAtHead(cwd);
	}

	if (!mergeSubjects.trim()) {
		log.info("No merge commits in pull range -- fast-forward or error, skipping");
		return;
	}

	// Branch names are now purely diagnostic: SP3 collapsed the old per-branch
	// compile enqueues into ONE repo-wide ingest op, so the enqueue below does not
	// need a parsed branch. A merge whose subject doesn't match our two patterns
	// (customized message, "Merge remote-tracking branch …", future git-host
	// variants) must still enqueue — gating on branch extraction here silently
	// dropped real merges and left the KB stale until the next manual trigger.
	const branches = extractMergedBranches(mergeSubjects);
	if (branches.length > 0) {
		log.info("Detected merged branches: %s", branches.join(", "));
	} else {
		log.info("Merge detected but no branch names parsed -- enqueuing repo-wide ingest anyway");
	}

	// Skip the whole pass when no API key is available — the queue worker
	// would just no-op each entry anyway, and we'd rather not spin up the
	// worker (or burn an enqueue file) when there's nothing to do.
	const config = await loadConfig();
	if (resolveLlmCredentialSource(config) === null) {
		log.info("No API key configured -- skipping compile enqueue");
		return;
	}

	// SP3: collapse N per-branch compile enqueues to ONE repo-wide ingest op.
	// `force` past the cooldown — a merge brings in new commits that a recent
	// local-commit cooldown must not suppress (the merged content would stay
	// un-ingested until the window expired and some later trigger fired).
	const enqueued = await enqueueIngestOperation(cwd, "post-merge", { force: true });
	if (!enqueued) {
		log.info("Ingest enqueue failed — worker not started");
		return;
	}

	// Spawn a single worker to drain whatever's on the queue. The worker
	// itself acquires the file lock and exits if another is already running.
	launchWorker(cwd);
}

// Auto-execute when run as a script
/* v8 ignore start */
if (!process.env.VITEST) {
	const cwd = process.cwd();
	// Adopt a parent-supplied trace id (JOLLI_TRACE_ID) if present, else mint one,
	// so the hook's logs and the worker it spawns share one id (same as the
	// post-commit / post-rewrite entries).
	runWithTrace(traceIdFromEnv(), () =>
		handlePostMerge(cwd).catch((error: unknown) => {
			const errorLog = createLogger("PostMergeHook");
			errorLog.error("Post-merge hook failed: %s", error instanceof Error ? error.message : String(error));
		}),
	);
}
/* v8 ignore stop */
