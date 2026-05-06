#!/usr/bin/env node
/**
 * PostCommitHook — Git post-commit Event Handler
 *
 * This script is invoked by git's post-commit hook. It detects the operation type
 * (commit, amend, squash, rebase, cherry-pick, revert), enqueues a GitOperation
 * entry, and spawns a QueueWorker to process it.
 *
 * Amend and rebase operations are detected and deferred to the post-rewrite hook,
 * which has the authoritative old-to-new hash mapping from git's stdin.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../Logger.js";
import type { CommitSource, GitOperation } from "../Types.js";
import { detectCommitOperation, isRebaseInProgress, resolveGitDir } from "./GitOperationDetector.js";
import { launchWorker } from "./QueueWorker.js";

// Re-export runWorker so existing consumers that import from PostCommitHook.js continue to work.
export { runWorker } from "./QueueWorker.js";

const log = createLogger("PostCommitHook");

/* v8 ignore start - postCommitEntry reads git state and spawns a child process */
export function postCommitEntry(cwd: string): void {
	const detected = detectCommitOperation(cwd);
	log.info("Detected operation: %s", detected.type);

	// Rebase and amend are handled by post-rewrite hook — skip here
	if (detected.type === "rebase") {
		log.info("Rebase in progress — skipping (post-rewrite will handle)");
		return;
	}
	if (detected.type === "amend") {
		log.info("Amend detected — skipping (post-rewrite will handle)");
		return;
	}

	// Read commit hash (HEAD is the just-created commit)
	let commitHash: string;
	try {
		commitHash = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
	} catch (err: unknown) {
		log.error("Failed to read HEAD hash: %s", (err as Error).message);
		return;
	}

	// Detect commit source (plugin vs CLI)
	const commitSource: CommitSource = existsSync(join(cwd, ".jolli", "jollimemory", "plugin-source"))
		? "plugin"
		: "cli";

	// Read squash-pending.json if detectCommitOperation found it
	let opType: GitOperation["type"] = detected.type;
	let sourceHashes: string[] | undefined;
	if (detected.type === "squash" && detected.squashPendingPath) {
		try {
			const content = readFileSync(detected.squashPendingPath, "utf-8");
			const pending = JSON.parse(content) as { sourceHashes: string[]; expectedParentHash: string };
			// Validate expectedParentHash to detect stale squash-pending files.
			// In the new queue-based design, squash-pending is deleted immediately after reading,
			// so stale files should not occur. This validation is retained as a defensive fallback.
			// !pending.expectedParentHash is intentional backward compatibility: older squash-pending
			// files may lack this field, and should still be treated as valid.
			const parentHash = execSync("git rev-parse HEAD~1", { cwd, encoding: "utf-8" }).trim();
			if (!pending.expectedParentHash || parentHash === pending.expectedParentHash) {
				sourceHashes = pending.sourceHashes;
				log.info("Squash-pending validated: %d source hashes", pending.sourceHashes.length);
			} else {
				log.warn(
					"squash-pending parent mismatch (got %s, expected %s) — discarding stale file, treating as commit",
					parentHash.substring(0, 8),
					pending.expectedParentHash.substring(0, 8),
				);
				opType = "commit"; // Fall back to normal commit
			}
			// Delete squash-pending.json regardless (consumed or stale)
			try {
				unlinkSync(detected.squashPendingPath);
			} catch {
				/* ignore */
			}
		} catch (err: unknown) {
			log.debug("Squash-pending read failed: %s — treating as commit", (err as Error).message);
			opType = "commit";
		}
	}

	// Enqueue the operation
	const op: GitOperation = {
		type: opType,
		commitHash,
		...(sourceHashes && { sourceHashes }),
		commitSource,
		createdAt: new Date().toISOString(),
	};

	// Write queue entry synchronously (post-commit hook must return quickly)
	try {
		const queueDir = join(cwd, ".jolli", "jollimemory", "git-op-queue");
		mkdirSync(queueDir, { recursive: true });
		const timestamp = Date.now();
		const fileName = `${timestamp}-${commitHash.substring(0, 8)}.json`;
		writeFileSync(join(queueDir, fileName), JSON.stringify(op, null, "\t"), "utf-8");
		log.info("Enqueued: type=%s hash=%s", opType, commitHash.substring(0, 8));
	} catch (err: unknown) {
		log.error("Failed to enqueue git operation: %s", (err as Error).message);
		return;
	}

	// Delete plugin-source marker (consumed by queue entry's commitSource field)
	try {
		const pluginSourcePath = join(cwd, ".jolli", "jollimemory", "plugin-source");
		if (existsSync(pluginSourcePath)) {
			unlinkSync(pluginSourcePath);
		}
	} catch {
		/* ignore */
	}

	// Spawn Worker
	launchWorker(cwd);
}

/* v8 ignore stop */

// Re-export QueueWorker's __test__ helpers alongside our own so that existing
// tests importing __test__ from PostCommitHook.js continue to work.
import { __test__ as workerTestHelpers } from "./QueueWorker.js";

const _testHelpers = {
	resolveGitDir,
	isRebaseInProgress,
	...workerTestHelpers,
};

// Cast through unknown to defuse a "cannot be named" diagnostic — the merged
// helpers reference private QueueWorker types (PlanAssociationResult etc.)
// that don't have stable exported names. The cast preserves call-site typing
// because consumers go through `typeof workerTestHelpers` re-exports below.
export const __test__ = _testHelpers as typeof _testHelpers;

// --- Script entry point (only when run directly, not when imported) ---
/* v8 ignore start */
function isMainScript(): boolean {
	const scriptPath = fileURLToPath(import.meta.url);
	const argv1 = process.argv[1];
	if (process.env.VITEST || !argv1) return false;

	const resolvedArgv = resolve(argv1);
	const resolvedScript = resolve(scriptPath);
	if (resolvedArgv !== resolvedScript) return false;

	// Only auto-run when the entrypoint itself is PostCommitHook.
	const entryName = basename(resolvedArgv).toLowerCase();
	return entryName === "postcommithook.js" || entryName === "postcommithook.ts";
}

if (isMainScript()) {
	// Post-commit hook entry: detect operation type, enqueue, and spawn Worker
	postCommitEntry(process.cwd());
}
/* v8 ignore stop */
