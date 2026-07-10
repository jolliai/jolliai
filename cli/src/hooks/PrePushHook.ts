#!/usr/bin/env node
/**
 * PrePushHook — Git pre-push Event Handler.
 *
 * Invoked by git's pre-push hook before objects are transferred. Records the
 * commits being pushed into `push-pending.json` and spawns a detached
 * PrePushWorker to sync their Memory Bank summaries to Jolli Space. The
 * synchronous portion is minimal (config read, stdin parse, `git rev-list`,
 * one JSON write, spawn) so the push is never blocked; the network sync happens
 * in the background worker.
 *
 * stdin format (one line per ref being pushed):
 *   <local-ref> <local-sha> <remote-ref> <remote-sha>
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeEntries, type PushTarget } from "../core/PushPendingStore.js";
import { loadConfig } from "../core/SessionTracker.js";
import { runWithTrace, traceIdFromEnv } from "../core/TraceContext.js";
import { createLogger, errMsg } from "../Logger.js";
import { execFileAsyncHidden } from "../util/Subprocess.js";
import { readStdin } from "./HookUtils.js";
import { launchPrePushWorker } from "./PrePushWorker.js";

const log = createLogger("PrePushHook");

/** Git's all-zero SHA — signals a branch deletion (local side) or a new ref (remote side). */
const ZERO_SHA = "0000000000000000000000000000000000000000";

interface PushRef {
	readonly localRef: string;
	readonly localSha: string;
	readonly remoteRef: string;
	readonly remoteSha: string;
}

/** Parses the pre-push stdin block into structured refs. */
export function parsePushRefs(stdin: string): PushRef[] {
	const refs: PushRef[] = [];
	for (const line of stdin.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parts = trimmed.split(/\s+/);
		if (parts.length < 4) continue;
		const [localRef, localSha, remoteRef, remoteSha] = parts;
		refs.push({ localRef, localSha, remoteRef, remoteSha });
	}
	return refs;
}

/** `refs/heads/feature/x` → `feature/x`; leaves other ref shapes untouched. */
function branchFromRef(ref: string): string {
	return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/**
 * Lists the commits this ref update introduces, oldest-first. For a brand-new
 * remote branch (`remote-sha` all-zero) there is no remote tip to diff against,
 * so we take everything reachable from the local tip that isn't already on any
 * remote (`--not --remotes`) — otherwise `rev-list <zero>..<local>` would error.
 */
async function listCommitsForRef(cwd: string, ref: PushRef): Promise<string[]> {
	const args =
		ref.remoteSha === ZERO_SHA
			? ["rev-list", "--reverse", ref.localSha, "--not", "--remotes"]
			: ["rev-list", "--reverse", `${ref.remoteSha}..${ref.localSha}`];
	try {
		const { stdout } = await execFileAsyncHidden("git", args, { cwd });
		return stdout
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
	} catch (err) {
		log.warn("git rev-list failed for %s: %s", ref.localRef, errMsg(err));
		return [];
	}
}

/**
 * Core pre-push logic. Records pushed commits into push-pending.json and (when
 * signed in) spawns the background sync worker.
 */
export async function prePushEntry(cwd: string, stdin: string, remote?: string): Promise<void> {
	const config = await loadConfig();

	// Explicit opt-out: do nothing at all (no file write, no worker).
	if (config.syncOnPush === false) {
		log.debug("syncOnPush is disabled — skipping");
		return;
	}

	// Not signed in: still record intent (so a later login can catch up) but
	// don't spawn the worker — there's nowhere to push to yet.
	const skipWorker = !config.jolliApiKey;

	const refs = parsePushRefs(stdin);
	const allHashes = new Set<string>();
	for (const ref of refs) {
		if (ref.localSha === ZERO_SHA) continue; // branch deletion — nothing to sync
		const branch = branchFromRef(ref.localRef);
		const hashes = await listCommitsForRef(cwd, ref);
		if (hashes.length === 0) continue;
		for (const hash of hashes) allHashes.add(hash);
		const pushTarget: PushTarget | undefined = remote
			? { remote, remoteRef: ref.remoteRef, localSha: ref.localSha }
			: undefined;
		await mergeEntries(cwd, hashes, branch, pushTarget);
	}

	const total = allHashes.size;
	if (total === 0) {
		log.debug("No commits to sync on this push");
		return;
	}

	if (skipWorker) {
		log.info("Recorded %d commit(s) for later sync — not signed in to Jolli", total);
		return;
	}

	launchPrePushWorker(cwd);
}

// --- Script entry point (only when run directly, not when imported) ---
/* v8 ignore start */
function isMainScript(): boolean {
	const argv1 = process.argv[1];
	if (process.env.VITEST || !argv1) return false;
	return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
}

if (isMainScript()) {
	const cwd = process.cwd();
	// Adopt a parent-supplied trace id if present, else mint one.
	runWithTrace(traceIdFromEnv(), () =>
		readStdin()
			.then((stdin) => prePushEntry(cwd, stdin, process.argv[2]))
			.catch((error: unknown) => {
				// Never block or fail the push on our account — exit 0 always.
				log.error("PrePushHook error: %s", error instanceof Error ? error.message : String(error));
			}),
	);
}
/* v8 ignore stop */
