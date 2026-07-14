#!/usr/bin/env node
/**
 * PrePushHook — Git pre-push Event Handler.
 *
 * Invoked by git's pre-push hook before objects are transferred. Records the
 * commits being pushed into `push-pending.json`, then SYNCHRONOUSLY pushes the
 * batch-eligible memories that fit one request to Jolli Space
 * (`processPrePushInline`) — deliberately blocking the push, but never for
 * longer than {@link PRE_PUSH_SYNC_BUDGET_MS}. Commits without memory, items
 * beyond batch limits, and failed pushes stay in `push-pending.json` for the
 * compensation channels (QueueWorker post-drain, activation retry, the next
 * push).
 *
 * Publishing here is optimistic: it happens BEFORE git transfers objects, so a
 * subsequently rejected push can briefly leave Space articles for commits that
 * never reached the remote — accepted by design (the retry converges via docId
 * reuse). Waiting for push confirmation inside the hook would deadlock: git
 * waits for the hook to exit before transferring.
 *
 * Failure policy: every error is caught, the exit code is always 0, and a
 * hard-exit timer (budget + grace) guarantees the hook can never hold
 * `git push` hostage even if something wedges.
 *
 * stdin format (one line per ref being pushed):
 *   <local-ref> <local-sha> <remote-ref> <remote-sha>
 */

import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type InlineCommitStatus,
	type ProcessPrePushInlineResult,
	processPrePushInline,
} from "../core/PushExecutor.js";
import { mergeEntries, type PushTarget } from "../core/PushPendingStore.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createStorage } from "../core/StorageFactory.js";
import { getIndexEntryMap, getSummary } from "../core/SummaryStore.js";
import { runWithTrace, traceIdFromEnv } from "../core/TraceContext.js";
import { createLogger, errMsg } from "../Logger.js";
import { execFileAsyncHidden } from "../util/Subprocess.js";
import { readStdin } from "./HookUtils.js";

const log = createLogger("PrePushHook");

/**
 * Total wall-clock budget for the synchronous portion of the hook — local git
 * reads, the pending-file write, and the single batch HTTP request all share
 * it. Anchored at process start.
 */
export const PRE_PUSH_SYNC_BUDGET_MS = 3_000;

/**
 * Grace on top of the budget before the hard-exit timer force-terminates the
 * process. Last-resort guard: cooperative deadline checks and the HTTP abort
 * normally end the hook well before this fires.
 */
export const PRE_PUSH_HARD_EXIT_GRACE_MS = 1_000;

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

/** Display width for the commit-subject column of the result list. */
const COMMIT_SUBJECT_DISPLAY_WIDTH = 50;

/** Truncates a commit subject and pads it so the result column aligns. */
function formatSubject(subject: string): string {
	const clean = subject.trim();
	const truncated =
		clean.length > COMMIT_SUBJECT_DISPLAY_WIDTH
			? `${clean.substring(0, COMMIT_SUBJECT_DISPLAY_WIDTH - 1)}…`
			: clean;
	return truncated.padEnd(COMMIT_SUBJECT_DISPLAY_WIDTH);
}

/**
 * Best-effort commit-subject lookup for the result list (one `git show -s`
 * over all hashes). Failures just leave subjects blank — the list still
 * renders with hashes.
 */
async function loadCommitSubjects(cwd: string, hashes: ReadonlyArray<string>): Promise<Map<string, string>> {
	const subjects = new Map<string, string>();
	if (hashes.length === 0) return subjects;
	try {
		const { stdout } = await execFileAsyncHidden("git", ["show", "-s", "--format=%H%x09%s", ...hashes], { cwd });
		for (const line of stdout.split("\n")) {
			const tab = line.indexOf("\t");
			if (tab > 0) subjects.set(line.substring(0, tab).trim(), line.substring(tab + 1).trim());
		}
	} catch (err) {
		log.debug("Could not resolve commit subjects for the result list: %s", errMsg(err));
	}
	return subjects;
}

/** One marker per status: pushed / still coming / merged away / failed. */
const STATUS_MARKERS: Record<InlineCommitStatus, string> = {
	pushed: "✓",
	generating: "…",
	deferred: "…",
	merged: "–",
	failed: "✗",
};

/**
 * Prints the per-commit sync results to stderr — git forwards hook stderr, so
 * the list shows up inline in the user's `git push` output. One line per
 * commit of this push: marker, short hash, truncated subject, then the article
 * URL (pushed) or a short reason (everything else).
 */
async function printSyncResults(cwd: string, result: ProcessPrePushInlineResult): Promise<void> {
	if (result.commits.length === 0) return;
	const subjects = await loadCommitSubjects(
		cwd,
		result.commits.map((commit) => commit.hash),
	);
	const lines = ["jollimemory: push to Jolli Space"];
	for (const commit of result.commits) {
		const marker = STATUS_MARKERS[commit.status];
		const shortHash = commit.hash.substring(0, 8);
		const subject = formatSubject(subjects.get(commit.hash) ?? "");
		const tail = commit.status === "pushed" ? (commit.url ?? "") : (commit.reason ?? "");
		lines.push(`  ${marker} ${shortHash} ${subject} ${tail}`);
	}
	process.stderr.write(`${lines.join("\n")}\n`);
}

/** Maximum number of already-generated memories shown while signed out. */
const SIGNED_OUT_MEMORY_DISPLAY_LIMIT = 3;

interface SignedOutMemoryPreview {
	readonly hashes: ReadonlyArray<string>;
	readonly hasMore: boolean;
}

/**
 * Finds the first independently pushable memories from this push using local
 * storage only. The same eligibility rules as the real push path apply:
 * merged children are excluded, and the summary must belong to the exact hash
 * rather than resolving through an alias or equal-tree fallback.
 *
 * Deadline-bound like the signed-in path: each root costs a storage read, and
 * a first push of a large branch can carry thousands of memory-less hashes —
 * without the check the scan would grind on until the hard-exit timer kills
 * the process. On deadline the preview returns what it has, flagged hasMore.
 */
async function loadSignedOutMemoryPreview(
	cwd: string,
	hashes: ReadonlyArray<string>,
	deadlineAt: number,
): Promise<SignedOutMemoryPreview> {
	const storage = await createStorage(cwd, cwd);
	const indexEntries = await getIndexEntryMap(cwd, storage);
	const preview: string[] = [];

	for (const hash of hashes) {
		if (Date.now() >= deadlineAt) {
			log.debug("Signed-out memory preview stopped at the deadline (%d shown)", preview.length);
			return { hashes: preview, hasMore: true };
		}
		const indexEntry = indexEntries.get(hash);
		if (!indexEntry || indexEntry.parentCommitHash != null) continue;
		const summary = await getSummary(hash, cwd, storage);
		if (!summary || summary.commitHash !== hash) continue;
		if (preview.length >= SIGNED_OUT_MEMORY_DISPLAY_LIMIT) {
			return { hashes: preview, hasMore: true };
		}
		preview.push(hash);
	}

	return { hashes: preview, hasMore: false };
}

/**
 * Prints a best-effort signed-out notice without ever affecting the Git push.
 * Any local storage or display failure is kept in debug.log and swallowed.
 */
async function printSignedOutMemoryNotice(
	cwd: string,
	hashes: ReadonlyArray<string>,
	deadlineAt: number,
): Promise<void> {
	try {
		const preview = await loadSignedOutMemoryPreview(cwd, hashes, deadlineAt);
		if (preview.hashes.length === 0) return;
		const subjects = await loadCommitSubjects(cwd, preview.hashes);
		const lines = ["jollimemory: not signed in — these memories were not pushed to Jolli"];
		for (const hash of preview.hashes) {
			lines.push(`  ${hash.substring(0, 8)} ${formatSubject(subjects.get(hash) ?? "")}`);
		}
		if (preview.hasMore) lines.push("  ...");
		lines.push(
			"",
			"Run `jolli auth login` to sign in. Pending memories will be pushed automatically after sign-in.",
		);
		process.stderr.write(`${lines.join("\n")}\n`);
	} catch (error) {
		log.debug("Could not render the signed-out memory notice: %s", errMsg(error));
	}
}

/**
 * Core pre-push logic. Records pushed commits into push-pending.json and (when
 * signed in) synchronously batch-pushes the ones that already have memory,
 * within the remaining wall-clock budget. `startedAtMs` anchors the budget at
 * process start; it defaults to "now" for callers that don't track it.
 */
export async function prePushEntry(cwd: string, stdin: string, remote?: string, startedAtMs?: number): Promise<void> {
	const deadlineAt = (startedAtMs ?? Date.now()) + PRE_PUSH_SYNC_BUDGET_MS;
	log.info("pre-push hook: remote=%s budget=%dms", remote ?? "(none)", PRE_PUSH_SYNC_BUDGET_MS);
	const config = await loadConfig();

	// Explicit opt-out: do nothing at all (no file write, no sync).
	if (config.syncOnPush === false) {
		log.debug("syncOnPush is disabled — skipping");
		return;
	}

	// Not signed in: still record intent (so a later login can catch up) but
	// skip the synchronous sync — there's nowhere to push to yet.
	const skipSync = !config.jolliApiKey;

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
	log.info("pre-push: recorded %d commit(s) across %d pushed ref(s)", total, refs.length);

	if (skipSync) {
		log.info("Recorded %d commit(s) for later sync — not signed in to Jolli", total);
		await printSignedOutMemoryNotice(cwd, [...allHashes], deadlineAt);
		return;
	}

	// Synchronous inline sync — scoped to THIS push's commits only (leftover
	// entries belong to the compensation channels). Entries are already
	// recorded above (write-first), so any failure here just leaves them for
	// those channels — never block or fail the push on sync problems.
	try {
		log.info("pre-push: starting inline sync — %dms of budget remaining", deadlineAt - Date.now());
		const result = await processPrePushInline(cwd, { priorityHashes: [...allHashes], deadlineAt });
		log.info(
			"pre-push: inline sync done — pushed=%d failed=%d noMemory=%d notAttempted=%d children=%d%s",
			result.pushed,
			result.failed,
			result.skippedNoMemory,
			result.notAttempted,
			result.deletedChildren,
			result.note ? ` (${result.note})` : "",
		);
		await printSyncResults(cwd, result);
	} catch (error: unknown) {
		log.error("Inline pre-push sync failed: %s", errMsg(error));
	}
}

// --- Script entry point (only when run directly, not when imported) ---
/* v8 ignore start */
function isMainScript(): boolean {
	const argv1 = process.argv[1];
	if (process.env.VITEST || !argv1) return false;

	const resolvedArgv = resolve(argv1);
	const resolvedScript = resolve(fileURLToPath(import.meta.url));
	if (resolvedArgv !== resolvedScript) return false;

	const entryName = basename(resolvedArgv).toLowerCase();
	return entryName === "prepushhook.js" || entryName === "prepushhook.ts";
}

if (isMainScript()) {
	const cwd = process.cwd();
	const startedAtMs = Date.now();
	// Hard ceiling: whatever happens (hung request, stuck IO), this process must
	// never hold `git push` beyond budget + grace. unref() keeps the timer from
	// holding an otherwise-finished process alive; atomic pending-file writes
	// (temp + rename) make a force-exit lose at most one unrecorded entry.
	setTimeout(() => process.exit(0), PRE_PUSH_SYNC_BUDGET_MS + PRE_PUSH_HARD_EXIT_GRACE_MS).unref();
	// Adopt a parent-supplied trace id if present, else mint one.
	runWithTrace(traceIdFromEnv(), () =>
		readStdin()
			.then((stdin) => prePushEntry(cwd, stdin, process.argv[2], startedAtMs))
			.catch((error: unknown) => {
				// Never block or fail the push on our account — exit 0 always.
				log.error("PrePushHook error: %s", error instanceof Error ? error.message : String(error));
			}),
	);
}
/* v8 ignore stop */
