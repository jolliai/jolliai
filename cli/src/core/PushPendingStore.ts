/**
 * PushPendingStore — persistent record of commits whose Memory Bank summaries
 * need to be synced to Jolli Space by the pre-push hook flow.
 *
 * File shape (`<projectDir>/.jolli/jollimemory/push-pending.json`):
 *
 *   {
 *     "version": 1,
 *     "entries": {
 *       "<full 40-char commit hash>": {
 *         "branch": "feature/xxx",
 *         "enqueuedAt": "ISO-8601",
 *         "lastAttemptAt": "ISO-8601"?,   // set on every push attempt (success or fail)
 *         "retryCount": number,           // increments only on "operational" failure
 *         "lastError": "string"?,         // truncated to PUSH_ERROR_MSG_MAX_LEN chars
 *         "pushedDocId": number?,         // article id minted by a push whose local write-back failed
 *         "pushedUrl": "string"?,         // article url matching pushedDocId (carries the tenant gate)
 *         "pushTargets": [{                // remote refs that can confirm the push succeeded
 *           "remote": "origin",
 *           "remoteRef": "refs/heads/feature/xxx",
 *           "localSha": "<full 40-char commit hash>"
 *         }]?
 *       }
 *     }
 *   }
 *
 * Read-time stale prune (mirrors `SessionTracker.pruneStale`): each `load()`
 * drops entries whose `lastAttemptAt ?? enqueuedAt` is older than
 * PUSH_PENDING_STALE_MS. When the resulting entries object is empty the file
 * is unlinked so the directory stays clean between pushes.
 *
 * Concurrency: three writers can race — the pre-push hook, the pre-push
 * worker's success/failure accounting, and QueueWorker's post-drain follow-up.
 * All mutation goes through `withPushPendingLock` (see Locks.ts) + re-read
 * inside the lock so lost-update is avoided.
 */

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, errMsg, getJolliMemoryDir, isEnoent } from "../Logger.js";
import { atomicWriteFile } from "./AtomicWrite.js";
import { withPushPendingLock } from "./Locks.js";
import { ensureJolliMemoryDir } from "./SessionTracker.js";

const log = createLogger("PushPendingStore");

// ─── Constants ──────────────────────────────────────────────────────────────

/** File name under `.jolli/jollimemory/`. */
export const PUSH_PENDING_FILE = "push-pending.json";

/**
 * Entries whose `lastAttemptAt ?? enqueuedAt` is older than this are dropped
 * on read. Aligned with `GIT_OP_QUEUE_STALE_MS` (7 days) — long enough for
 * offline/rest-of-week workflows to catch up, short enough that abandoned
 * failed entries don't accumulate forever. Retry-exhausted entries
 * (`retryCount >= MAX_RETRY_COUNT`) rely on this to eventually clear.
 */
export const PUSH_PENDING_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Max concurrent per-commit push calls inside `PushExecutor.processPushPending`.
 * Chosen to match the small, IO-bound nature of `pushSummary` and stay well
 * under any reasonable server rate limit.
 */
export const PUSH_CONCURRENCY = 3;

/**
 * Retry ceiling for "operational" failures (network / 5xx / 4xx / unknown).
 * Configuration failures (`NotAuthenticatedError`, `BindingRequiredError`,
 * `ClientOutdatedError`) do NOT increment `retryCount` — see PushExecutor.
 */
export const MAX_RETRY_COUNT = 3;

/** Truncation length for `entry.lastError` — keep the file compact. */
export const PUSH_ERROR_MSG_MAX_LEN = 200;

const SCHEMA_VERSION = 1 as const;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PushTarget {
	readonly remote: string;
	readonly remoteRef: string;
	readonly localSha: string;
}

export interface PushPendingEntry {
	readonly branch: string;
	readonly enqueuedAt: string;
	readonly lastAttemptAt?: string;
	readonly retryCount: number;
	readonly lastError?: string;
	/**
	 * Article docId/url minted by a successful push whose local write-back
	 * failed. The next drain reuses them as the update target, so the retry
	 * UPDATEs the already-created article instead of CREATEing a duplicate,
	 * and the write-back gets another chance. Cleared implicitly — a
	 * successful write-back deletes the whole entry.
	 */
	readonly pushedDocId?: number;
	/** Article url matching {@link pushedDocId}; carries the tenant gate (`canReuseDocId`). */
	readonly pushedUrl?: string;
	/** Successful confirmation of any target proves this commit reached the remote. */
	readonly pushTargets?: ReadonlyArray<PushTarget>;
	/**
	 * ISO-8601 timestamp set by `claimForPush` when a process begins pushing
	 * this entry. Prevents concurrent processes from double-pushing the same
	 * commit. Cleared on completion (delete or patch). Treated as stale after
	 * `CLAIM_STALE_MS` so a crashed process doesn't lock an entry forever.
	 */
	readonly claimedAt?: string;
}

export interface PushPendingFile {
	readonly version: typeof SCHEMA_VERSION;
	readonly entries: Readonly<Record<string, PushPendingEntry>>;
}

/**
 * Patch applied to a single entry by `updateBatch`. `lastError: null` clears the
 * field; a string overwrites (and is truncated); omitting a key leaves it
 * unchanged.
 */
export interface PushPendingEntryPatch {
	readonly lastAttemptAt?: string;
	readonly retryCount?: number;
	readonly lastError?: string | null;
	readonly pushedDocId?: number;
	readonly pushedUrl?: string;
}

export type BatchUpdate =
	| { readonly kind: "delete" }
	| { readonly kind: "patch"; readonly patch: PushPendingEntryPatch };

/**
 * How long a claim is considered valid before another process can reclaim the
 * entry. Sized for the worst-case push round: PUSH_CONCURRENCY * per-push
 * timeout (30 s default) plus headroom for push-confirmation polling (60 s).
 * A crashed process's claims expire after this, so entries are not stuck
 * forever.
 */
const CLAIM_STALE_MS = 5 * 60 * 1000;

// ─── Path helpers ───────────────────────────────────────────────────────────

function pendingPath(cwd?: string): string {
	return join(getJolliMemoryDir(cwd), PUSH_PENDING_FILE);
}

function emptyFile(): PushPendingFile {
	return { version: SCHEMA_VERSION, entries: {} };
}

/** Truncate helper exported for PushExecutor + tests. */
export function truncateError(msg: string): string {
	if (msg.length <= PUSH_ERROR_MSG_MAX_LEN) return msg;
	return `${msg.substring(0, PUSH_ERROR_MSG_MAX_LEN - 1)}…`;
}

// ─── Load (with locked stale prune) ─────────────────────────────────────────

interface PushPendingSnapshot {
	readonly file: PushPendingFile;
	readonly prunedCount: number;
}

/**
 * Reads and validates `push-pending.json`, then computes the surviving entries
 * without writing. Callers that mutate the file use this inside
 * `withPushPendingLock`; the public load path takes the same lock only when a
 * stale-prune write is actually needed. Keeping the raw read side-effect free
 * avoids a lock-free read→write race with `mergeEntries` / `updateBatch`.
 */
async function readPushPendingSnapshot(cwd?: string): Promise<PushPendingSnapshot> {
	const path = pendingPath(cwd);
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (err: unknown) {
		if (isEnoent(err)) return { file: emptyFile(), prunedCount: 0 };
		log.warn("Failed to read %s: %s", PUSH_PENDING_FILE, errMsg(err));
		return { file: emptyFile(), prunedCount: 0 };
	}

	let parsed: PushPendingFile;
	try {
		const data = JSON.parse(raw) as unknown;
		if (!isValidFile(data)) {
			log.warn("push-pending.json has unexpected shape — treating as empty");
			return { file: emptyFile(), prunedCount: 0 };
		}
		parsed = data;
	} catch (err) {
		log.warn("Failed to parse push-pending.json: %s — treating as empty", errMsg(err));
		return { file: emptyFile(), prunedCount: 0 };
	}

	const now = Date.now();
	const surviving: Record<string, PushPendingEntry> = {};
	let prunedCount = 0;
	for (const [hash, entry] of Object.entries(parsed.entries)) {
		const anchor = entry.lastAttemptAt ?? entry.enqueuedAt;
		const anchorMs = Date.parse(anchor);
		// A malformed / missing anchor (NaN) is treated as fresh (keep it) —
		// discarding entries on a parse error would silently drop legit work.
		if (Number.isFinite(anchorMs) && now - anchorMs > PUSH_PENDING_STALE_MS) {
			prunedCount++;
			continue;
		}
		surviving[hash] = entry;
	}

	return { file: { version: SCHEMA_VERSION, entries: surviving }, prunedCount };
}

function logPrunedEntries(prunedCount: number): void {
	if (prunedCount === 0) return;
	log.info("Pruned %d stale push-pending entries (>%dh old)", prunedCount, PUSH_PENDING_STALE_MS / 3600000);
}

/**
 * Reads `push-pending.json`, pruning stale entries in place when necessary, and
 * returns the surviving entries. Missing file → empty result. Never throws on
 * read/parse errors: a corrupt file is logged and treated as empty so a bad
 * state file never blocks the pre-push flow.
 */
export async function loadPushPending(cwd?: string): Promise<PushPendingFile> {
	const initial = await readPushPendingSnapshot(cwd);
	if (initial.prunedCount === 0) return initial.file;

	const path = pendingPath(cwd);
	return withPushPendingLock(cwd, async () => {
		// Re-read after acquiring the lock. A concurrent enqueue may have refreshed
		// or replaced entries since the optimistic read above.
		const current = await readPushPendingSnapshot(cwd);
		if (current.prunedCount > 0) {
			await writeOrUnlink(path, { ...current.file.entries });
			logPrunedEntries(current.prunedCount);
		}
		return current.file;
	});
}

function isValidFile(value: unknown): value is PushPendingFile {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as { version?: unknown; entries?: unknown };
	if (obj.version !== SCHEMA_VERSION) return false;
	if (typeof obj.entries !== "object" || obj.entries === null) return false;
	return true;
}

// ─── Write helpers ──────────────────────────────────────────────────────────

async function writeOrUnlink(path: string, entries: Record<string, PushPendingEntry>): Promise<void> {
	if (Object.keys(entries).length === 0) {
		try {
			await rm(path, { force: true });
		} catch (err) {
			log.warn("Failed to unlink %s: %s", PUSH_PENDING_FILE, errMsg(err));
		}
		return;
	}
	await atomicWriteFile(path, JSON.stringify({ version: SCHEMA_VERSION, entries }, null, "\t"));
}

// ─── Public mutation API (all locked) ───────────────────────────────────────

/**
 * Merges a batch of commit hashes into the pending file. Preserves existing
 * entries' retry state (retryCount / lastError / lastAttemptAt) — only fills
 * new keys. Called by the pre-push hook.
 */
export async function mergeEntries(
	cwd: string,
	hashes: ReadonlyArray<string>,
	branch: string,
	pushTarget?: PushTarget,
): Promise<void> {
	if (hashes.length === 0) return;
	await ensureJolliMemoryDir(cwd);
	const path = pendingPath(cwd);
	const now = new Date().toISOString();
	await withPushPendingLock(cwd, async () => {
		// Re-read inside the lock: another writer may have modified the file
		// between the caller's earlier read and this write.
		const current = await readPushPendingSnapshot(cwd);
		const next: Record<string, PushPendingEntry> = { ...current.file.entries };
		let added = 0;
		let targetsAdded = 0;
		for (const hash of hashes) {
			const existing = next[hash];
			if (existing) {
				if (!pushTarget) continue;
				const targets = existing.pushTargets ?? [];
				const alreadyTracked = targets.some(
					(target) =>
						target.remote === pushTarget.remote &&
						target.remoteRef === pushTarget.remoteRef &&
						target.localSha === pushTarget.localSha,
				);
				if (alreadyTracked) continue;
				next[hash] = { ...existing, pushTargets: [...targets, pushTarget] };
				targetsAdded++;
				continue;
			}
			next[hash] = {
				branch,
				enqueuedAt: now,
				retryCount: 0,
				...(pushTarget && { pushTargets: [pushTarget] }),
			};
			added++;
		}
		if (added === 0 && targetsAdded === 0 && current.prunedCount === 0) return;
		await writeOrUnlink(path, next);
		logPrunedEntries(current.prunedCount);
		if (added > 0) log.info("Enqueued %d new push-pending entries (branch=%s)", added, branch);
		if (targetsAdded > 0) log.debug("Added push confirmation targets to %d existing entries", targetsAdded);
	});
}

/**
 * Atomically claims a set of hashes for push processing. Inside the file lock,
 * reads the current entries and stamps `claimedAt` on every unclaimed (or
 * stale-claimed) hash from `candidates`. Returns only the hashes that were
 * successfully claimed — concurrent callers that lose the race get an empty set
 * for the contested hashes.
 *
 * This closes the TOCTOU gap in `processPushPending`: previously the unlocked
 * `loadPushPending` read let two processes both see the same entries and both
 * push them, creating duplicate Space articles.
 */
export async function claimForPush(
	cwd: string,
	candidates: ReadonlyArray<string>,
): Promise<{ claimed: ReadonlySet<string>; entries: Readonly<Record<string, PushPendingEntry>> }> {
	if (candidates.length === 0) return { claimed: new Set(), entries: {} };
	const path = pendingPath(cwd);
	const candidateSet = new Set(candidates);
	return withPushPendingLock(cwd, async () => {
		const current = await readPushPendingSnapshot(cwd);
		const next: Record<string, PushPendingEntry> = { ...current.file.entries };
		const nowMs = Date.now();
		const nowIso = new Date(nowMs).toISOString();
		const claimed = new Set<string>();

		for (const hash of candidateSet) {
			const entry = next[hash];
			if (!entry) continue;
			if (entry.claimedAt) {
				const claimAge = nowMs - Date.parse(entry.claimedAt);
				if (Number.isFinite(claimAge) && claimAge < CLAIM_STALE_MS) continue;
			}
			next[hash] = { ...entry, claimedAt: nowIso };
			claimed.add(hash);
		}

		if (claimed.size > 0 || current.prunedCount > 0) {
			await writeOrUnlink(path, next);
			logPrunedEntries(current.prunedCount);
		}
		return { claimed, entries: current.file.entries };
	});
}

/**
 * Applies a batch of updates atomically. Used by PushExecutor after a round of
 * push attempts to persist per-commit success/failure state in one write.
 * Silently ignores updates for hashes no longer present (pruned or updated by a
 * concurrent worker).
 */
export async function updateBatch(cwd: string, updates: ReadonlyMap<string, BatchUpdate>): Promise<void> {
	if (updates.size === 0) return;
	const path = pendingPath(cwd);
	await withPushPendingLock(cwd, async () => {
		const current = await readPushPendingSnapshot(cwd);
		const next: Record<string, PushPendingEntry> = { ...current.file.entries };
		let changed = 0;
		for (const [hash, update] of updates) {
			const existing = next[hash];
			if (!existing) continue;
			if (update.kind === "delete") {
				delete next[hash];
				changed++;
				continue;
			}
			const patch = update.patch;
			const merged: PushPendingEntry = {
				branch: existing.branch,
				enqueuedAt: existing.enqueuedAt,
				pushTargets: existing.pushTargets,
				lastAttemptAt: patch.lastAttemptAt ?? existing.lastAttemptAt,
				retryCount: patch.retryCount ?? existing.retryCount,
				lastError:
					patch.lastError === null
						? undefined
						: patch.lastError !== undefined
							? truncateError(patch.lastError)
							: existing.lastError,
				pushedDocId: patch.pushedDocId ?? existing.pushedDocId,
				pushedUrl: patch.pushedUrl ?? existing.pushedUrl,
				// Explicit: clear the claim on every patch so the entry can be
				// retried by any process. Written as `undefined` (not omitted) so
				// this stays load-bearing under future field additions — a new
				// PushPendingEntry field would trip TypeScript's exactOptional /
				// exhaustive-check rather than silently inheriting `existing`'s
				// value alongside `claimedAt`.
				claimedAt: undefined,
			};
			next[hash] = merged;
			changed++;
		}
		if (changed === 0 && current.prunedCount === 0) return;
		await writeOrUnlink(path, next);
		logPrunedEntries(current.prunedCount);
	});
}

/**
 * Convenience: apply a single patch. Prefer `updateBatch` when applying more
 * than one update to avoid taking the lock repeatedly.
 */
export async function updateEntry(cwd: string, hash: string, patch: PushPendingEntryPatch): Promise<void> {
	await updateBatch(cwd, new Map<string, BatchUpdate>([[hash, { kind: "patch", patch }]]));
}

/** Convenience: delete a single entry. */
export async function deleteEntry(cwd: string, hash: string): Promise<void> {
	await updateBatch(cwd, new Map<string, BatchUpdate>([[hash, { kind: "delete" }]]));
}

/** Test-only helper: overwrite the file (bypasses the lock/merge path). */
export async function __writeForTest(cwd: string, file: PushPendingFile): Promise<void> {
	await ensureJolliMemoryDir(cwd);
	await writeOrUnlink(pendingPath(cwd), { ...file.entries });
}
