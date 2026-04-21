#!/usr/bin/env node
/**
 * PostRewriteHook — Git post-rewrite Event Handler
 *
 * Handles two types of git rewrite operations by enqueuing them for Worker processing:
 *
 * 1. **amend** (command="amend"):
 *    Enqueues a {type:"amend"} entry with the old→new hash mapping from stdin.
 *    If the Worker lock is free, spawns a Worker to process it.
 *    This is the sole authority for amend operations — postCommitEntry() detects
 *    amend via reflog and defers to this hook.
 *
 * 2. **rebase** (command="rebase"):
 *    Enqueues {type:"rebase-pick"} or {type:"rebase-squash"} entries for each mapping.
 *    If the Worker lock is free, spawns a Worker to process them.
 *    postCommitEntry() skips during rebase (prevents N Workers), so this hook
 *    is the sole entry point for rebase summary migration.
 *
 * Git invokes this hook with:
 *   process.argv[2] — "amend" or "rebase"
 *   stdin — lines of "<old-hash> <new-hash>" mappings
 */

import { existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { enqueueGitOperation, isLockHeld } from "../core/SessionTracker.js";
import { createLogger, getJolliMemoryDir, setLogDir } from "../Logger.js";
import type { CommitSource, GitOperation } from "../Types.js";
import { launchWorker } from "./QueueWorker.js";

const log = createLogger("PostRewriteHook");

/** A parsed old→new hash mapping from stdin. */
interface HashMapping {
	readonly oldHash: string;
	readonly newHash: string;
}

/**
 * Main handler for the post-rewrite hook.
 *
 * @param command - "amend" or "rebase" (passed as process.argv[2] by git)
 * @param cwd - Working directory (git repo root)
 */
export async function handlePostRewriteHook(command: string, cwd: string): Promise<void> {
	setLogDir(cwd);
	log.info("=== Post-rewrite hook started (command: %s) ===", command);

	const mappings = await readStdinMappings();
	if (mappings.length === 0) {
		log.info("No mappings in stdin — nothing to do");
		log.info("=== Post-rewrite hook finished ===");
		return;
	}

	// Detect commit source (plugin vs CLI)
	const commitSource: CommitSource = detectCommitSource(cwd);

	if (command === "amend") {
		await handleAmend(mappings, commitSource, cwd);
	} else if (command === "rebase") {
		await handleRebase(mappings, commitSource, cwd);
	} else {
		log.info("Unknown command '%s', skipping", command);
	}

	// Spawn Worker if lock is free (entries are queued, need someone to process them)
	const lockHeld = await isLockHeld(cwd);
	if (!lockHeld) {
		launchWorker(cwd);
	} else {
		log.info("Worker lock is held — queued entries will be consumed by the running Worker");
	}

	log.info("=== Post-rewrite hook finished ===");
}

/**
 * Handles amend operations: enqueues a single {type:"amend"} entry.
 * The old→new hash mapping comes from git's stdin.
 */
async function handleAmend(
	mappings: ReadonlyArray<HashMapping>,
	commitSource: CommitSource,
	cwd: string,
): Promise<void> {
	const { oldHash, newHash } = mappings[0];
	const op: GitOperation = {
		type: "amend",
		commitHash: newHash,
		sourceHashes: [oldHash],
		commitSource,
		createdAt: new Date().toISOString(),
	};
	await enqueueGitOperation(op, cwd);
	log.info("Amend enqueued: %s → %s", oldHash.substring(0, 8), newHash.substring(0, 8));
}

/**
 * Handles rebase operations: enqueues entries for each old→new mapping group.
 * Groups by new-hash to distinguish pick (1:1) from squash (N:1).
 */
async function handleRebase(
	mappings: ReadonlyArray<HashMapping>,
	commitSource: CommitSource,
	cwd: string,
): Promise<void> {
	// Group by new-hash: pick = {new: [old]}, squash = {new: [old1, old2, ...]}
	const groups = new Map<string, string[]>();
	for (const { oldHash, newHash } of mappings) {
		const existing = groups.get(newHash) ?? [];
		existing.push(oldHash);
		groups.set(newHash, existing);
	}

	let enqueued = 0;
	let failed = 0;
	for (const [newHash, oldHashes] of groups) {
		const type = oldHashes.length === 1 ? "rebase-pick" : "rebase-squash";
		const op: GitOperation = {
			type,
			commitHash: newHash,
			sourceHashes: oldHashes,
			commitSource,
			createdAt: new Date().toISOString(),
		};
		const ok = await enqueueGitOperation(op, cwd);
		if (ok) {
			enqueued++;
			log.info(
				"%s enqueued: [%s] → %s",
				type,
				oldHashes.map((h) => h.substring(0, 8)).join(", "),
				newHash.substring(0, 8),
			);
		} else {
			failed++;
		}
	}
	if (failed > 0) {
		log.warn("Rebase: %d of %d group(s) failed to enqueue — those mappings will be lost", failed, groups.size);
	}
	log.info("Rebase: enqueued %d group(s) from %d mapping(s)", enqueued, mappings.length);
}

/**
 * Reads stdin line by line and parses "<old-hash> <new-hash>" pairs.
 */
async function readStdinMappings(): Promise<ReadonlyArray<HashMapping>> {
	const mappings: HashMapping[] = [];

	const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
	for await (const line of rl) {
		const parts = line.trim().split(/\s+/);
		if (parts.length >= 2 && parts[0] && parts[1]) {
			mappings.push({ oldHash: parts[0], newHash: parts[1] });
		}
	}

	return mappings;
}

/**
 * Detects whether this operation came from the VSCode plugin or CLI.
 * Reads and deletes the plugin-source marker file.
 */
function detectCommitSource(cwd: string): CommitSource {
	const pluginSourcePath = join(getJolliMemoryDir(cwd), "plugin-source");
	if (existsSync(pluginSourcePath)) {
		try {
			unlinkSync(pluginSourcePath);
		} catch {
			/* ignore */
		}
		return "plugin";
	}
	return "cli";
}

// --- Script entry point ---
/* v8 ignore start */
function isMainScript(): boolean {
	const scriptPath = fileURLToPath(import.meta.url);
	const argv1 = process.argv[1];
	return !process.env.VITEST && !!argv1 && resolve(argv1) === resolve(scriptPath);
}

if (isMainScript()) {
	const command = process.argv[2] ?? "";
	const cwd = process.cwd();

	handlePostRewriteHook(command, cwd).catch((error: unknown) => {
		console.error("[PostRewriteHook] Fatal error:", error);
		process.exit(1);
	});
}
/* v8 ignore stop */
