/**
 * File-based lock primitives for Jolli Memory.
 *
 * Two locks live in two distinct directories:
 *
 *   - `worker.lock`        — held by QueueWorker for the duration of a queue drain
 *                            (typically 30-60 s while the LLM runs). Fail-fast: a
 *                            second worker that tries to acquire it returns false
 *                            immediately so only one drain runs at a time.
 *                            **Per-worktree** because the queue itself is
 *                            per-worktree (`<cwd>/.jolli/jollimemory/git-op-queue/`):
 *                            two worktrees correctly run their own workers in
 *                            parallel against their own queues. Lives at
 *                            `<cwd>/.jolli/jollimemory/worker.lock`.
 *
 *   - `orphan-write.lock`  — held by anyone writing to the orphan summary branch,
 *                            including the worker itself (briefly, around each
 *                            `writeFiles` critical section). Acquired with a poll
 *                            loop and a caller-chosen timeout because contention is
 *                            millisecond-scale. **Shared across worktrees** because
 *                            the orphan ref is repo-level, not worktree-level: a
 *                            per-worktree path would let two worktrees race on the
 *                            same ref. Lives at `<git-common-dir>/jollimemory/
 *                            orphan-write.lock`, with a fallback to the per-worktree
 *                            path when not in a git repository.
 *
 * Splitting the two roles is the fix for the orphan-queue-entry race: previously a
 * single `lock` file served both purposes, so a non-worker holder (e.g.
 * `scanTreeHashAliases`) made `isLockHeld` return true and PostRewriteHook
 * incorrectly assumed a Worker was running.
 *
 * **Ownership-checked release.** Both release functions read the lock file and
 * compare its PID against `process.pid` before removing. Without the check, a
 * stale-reclaim race could let process A delete process B's freshly-acquired
 * lock and re-open the concurrent-write window:
 *   1. A holds lock, lock becomes stale (≥ `LOCK_TIMEOUT_MS`)
 *   2. B's `tryAcquireOnce` removes A's lock and writes its own PID
 *   3. A's finally block runs `releaseLock` — without the PID check, A would rm B's lock
 *   4. C now sees no lock and acquires concurrently with B → corrupt writes
 * The PID check turns step 3 into a no-op.
 *
 * **Residual stale-reclaim window we don't close.** The symmetric race in
 * `tryAcquireOnce`'s stale branch is open: between B's `stat` (sees age ≥
 * TIMEOUT) and B's `rm`, A can fire one `refreshWorkerLockMtime` and bump
 * mtime fresh — B then deletes a now-fresh lock, A keeps running, and both
 * believe they hold it. A second PID read before `rm` would NOT close this:
 * the PID is still A's at every checkpoint, only mtime moved. Closing it
 * properly needs an atomic "rm-iff-mtime-unchanged" primitive (e.g.
 * link/rename pattern), out of scope here. The window requires A to call
 * `utimes` in the sub-millisecond gap between B's `stat` and `rm`, at the one
 * boundary tick inside a 60 s refresh cycle — vanishingly unlikely.
 *
 * **Why PID, not a UUID token.** PID-reuse collision inside one lock lifetime
 * would require: OS restart within `LOCK_TIMEOUT_MS` AND the lock file
 * surviving the restart AND the new PID matching the dead holder's exact
 * value AND that recycled-PID process happening to acquire the same lock. We
 * accept this as an intentional simplification — a token file would close it
 * but the collision probability doesn't justify the extra read on every
 * release path.
 */

import * as childProcess from "node:child_process";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { createLogger, getJolliMemoryDir } from "../Logger.js";

const log = createLogger("Locks");

/**
 * Lazily promisify so tests that swap out `childProcess.execFile` after module
 * load (via `vi.spyOn`) actually pick up the mock — eager promisification at
 * module load would close over the original function.
 */
function gitRevParseCommonDir(cwd: string): Promise<{ stdout: string }> {
	return promisify(childProcess.execFile)("git", ["rev-parse", "--git-common-dir"], { cwd }) as Promise<{
		stdout: string;
	}>;
}

export const WORKER_LOCK_FILE = "worker.lock";
export const ORPHAN_WRITE_LOCK_FILE = "orphan-write.lock";

/**
 * Lock timeout: a lock older than this is considered stale and reclaimable.
 *
 * Invariant: must be greater than 2 × `WORKER_LOCK_REFRESH_INTERVAL_MS` (the
 * worker's heartbeat cadence, 60 s in `QueueWorker.ts`). A live worker bumps
 * mtime on that cadence, so as long as TIMEOUT > 2 × INTERVAL a single missed
 * bump (GC pause, slow scheduler tick) cannot push the lock across the stale
 * boundary. Currently 5 min vs 60 s — ample margin.
 */
export const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Default wait budget for `acquireOrphanWriteLock` (background callers). */
export const DEFAULT_ORPHAN_WRITE_TIMEOUT_MS = 1000;

/** Default poll interval while waiting for `orphan-write.lock`. */
export const DEFAULT_ORPHAN_WRITE_POLL_MS = 50;

/** Optional knobs for `acquireOrphanWriteLock`. */
export interface OrphanWriteLockOpts {
	readonly timeoutMs?: number;
	readonly pollMs?: number;
}

/**
 * Cache of the resolved shared (orphan-write) lock directory keyed by cwd.
 * Resolution invokes `git rev-parse --git-common-dir`, so caching avoids a
 * subprocess spawn on every poll iteration of `acquireOrphanWriteLock`.
 *
 * The cache is keyed by the input cwd, and each unique cwd produces a
 * deterministic resolution (either a real common dir or the worktree
 * fallback), so a stale entry is only possible if the user converts a
 * non-git directory into a git repo mid-process — accept that as a cost
 * paid by the next process restart. Tests can clear the cache via the
 * exported `__resetSharedLockDirCache` helper.
 */
const sharedLockDirCache = new Map<string, string>();

/**
 * Test-only: clears the cached `git rev-parse --git-common-dir` results.
 * Production code should never need this; it exists so unit tests can flip a
 * tempdir from "not a git repo" to "is a git repo" mid-test.
 */
export function __resetSharedLockDirCache(): void {
	sharedLockDirCache.clear();
}

/**
 * Resolves the directory that holds locks shared across all worktrees of the
 * same repository. Returns `<git-common-dir>/jollimemory/` for git
 * worktrees, or falls back to the per-worktree `getJolliMemoryDir(cwd)` path
 * when the resolution fails (cwd is not in a git repo, git is missing, etc.).
 *
 * Why git-common-dir: linked worktrees created by `git worktree add` each
 * have their own working tree but share the main repo's `.git/` (with its
 * single set of refs, including the orphan summary ref). `git rev-parse
 * --git-common-dir` is the documented way to locate that shared `.git/`
 * regardless of which worktree the caller is in. Putting the lock under it
 * means every worktree resolves to the same path → the lock actually
 * serializes concurrent orphan-branch writers.
 *
 * Why a `jollimemory/` subdir under it (rather than `jollimemory-locks/` or
 * similar): keeps the naming consistent with the existing per-worktree
 * `.jolli/jollimemory/` directory used for everything else, just rooted in
 * git-common-dir instead of the worktree.
 */
async function resolveSharedLockDir(cwd?: string): Promise<string> {
	const key = cwd ?? process.cwd();
	const cached = sharedLockDirCache.get(key);
	if (cached !== undefined) return cached;

	let resolved: string;
	try {
		const { stdout } = await gitRevParseCommonDir(key);
		const commonDir = stdout.trim();
		// `git rev-parse` may return either a relative path (e.g. ".git" when
		// cwd IS the repo root) or an absolute path (linked worktrees). Resolve
		// against cwd so callers always get an absolute path.
		const absoluteCommonDir = isAbsolute(commonDir) ? commonDir : resolvePath(key, commonDir);
		resolved = join(absoluteCommonDir, "jollimemory");
		/* v8 ignore start -- fallback path: requires running outside a git repo, not the common case */
	} catch {
		// Not in a git repo, or `git` not on PATH — fall back to the
		// per-worktree dir. Single-worktree behaviour is unchanged from the
		// pre-PR design; multi-worktree environments simply can't benefit from
		// the shared-lock semantics in this fallback.
		log.debug("resolveSharedLockDir: git rev-parse failed for cwd=%s — falling back to per-worktree dir", key);
		resolved = getJolliMemoryDir(key);
	}
	/* v8 ignore stop */
	sharedLockDirCache.set(key, resolved);
	return resolved;
}

async function ensureWorktreeLockDir(cwd?: string): Promise<string> {
	const dir = getJolliMemoryDir(cwd);
	await mkdir(dir, { recursive: true });
	return dir;
}

async function ensureSharedLockDir(cwd?: string): Promise<string> {
	const dir = await resolveSharedLockDir(cwd);
	await mkdir(dir, { recursive: true });
	return dir;
}

/**
 * Best-effort single attempt at creating `lockPath` exclusively.
 * Returns true on success. Returns false if another process already holds it
 * (and the existing lock is fresh) or if a filesystem error blocked us.
 *
 * Stale locks (older than `LOCK_TIMEOUT_MS`) are removed and the caller will
 * succeed on the retry / next call.
 */
async function tryAcquireOnce(lockPath: string): Promise<boolean> {
	try {
		const lockStat = await stat(lockPath);
		const age = Date.now() - lockStat.mtimeMs;
		if (age < LOCK_TIMEOUT_MS) {
			return false;
		}
		log.warn("Removing stale lock file %s (age: %dms)", lockPath, age);
		await rm(lockPath, { force: true });
	} catch (error: unknown) {
		const err = error as { code?: string };
		/* v8 ignore start -- defensive: non-ENOENT errors from stat are rare filesystem issues */
		if (err.code !== "ENOENT") {
			log.error("Failed to check lock file %s: %s", lockPath, (error as Error).message);
			return false;
		}
		/* v8 ignore stop */
	}

	try {
		await writeFile(lockPath, String(process.pid), { flag: "wx" });
		return true;
		/* v8 ignore start -- race condition: another process grabbed the lock between check and write */
	} catch {
		return false;
	}
	/* v8 ignore stop */
}

/**
 * Reads the PID currently written into `lockPath`. Returns null when the file
 * is missing or unreadable — callers treat that as "not ours".
 */
async function readLockOwnerPid(lockPath: string): Promise<string | null> {
	try {
		const content = await readFile(lockPath, "utf-8");
		const pid = content.trim();
		return pid.length > 0 ? pid : null;
		/* v8 ignore next 3 -- ENOENT / unreadable: caller treats null as "not ours" */
	} catch {
		return null;
	}
}

/**
 * Removes `lockPath` only if its written PID matches the current process.
 * No-op when the file is missing OR owned by another PID — protects against
 * the stale-reclaim race where this process's release would otherwise delete
 * a different process's freshly-acquired lock.
 */
async function releaseIfOwned(lockPath: string, label: string): Promise<void> {
	const ownerPid = await readLockOwnerPid(lockPath);
	if (ownerPid !== null && ownerPid !== String(process.pid)) {
		log.warn(
			"Skipping release of %s: held by pid %s, not us (pid %s) — stale-reclaim race",
			label,
			ownerPid,
			process.pid,
		);
		return;
	}
	try {
		await rm(lockPath, { force: true });
		/* v8 ignore next 3 -- filesystem permission error during lock release */
	} catch (error: unknown) {
		log.error("Failed to release %s: %s", label, (error as Error).message);
	}
}

/**
 * Acquires the worker lock. Fail-fast: returns false immediately when another
 * worker already holds it.
 */
export async function acquireWorkerLock(cwd?: string): Promise<boolean> {
	const dir = await ensureWorktreeLockDir(cwd);
	return tryAcquireOnce(join(dir, WORKER_LOCK_FILE));
}

/**
 * Releases the worker lock — only if the lock file's PID matches us. The PID
 * gate guards the stale-reclaim race; see the module-level comment.
 */
export async function releaseWorkerLock(cwd?: string): Promise<void> {
	const dir = getJolliMemoryDir(cwd);
	await releaseIfOwned(join(dir, WORKER_LOCK_FILE), "worker.lock");
}

/**
 * Returns true when `worker.lock` exists and is younger than `LOCK_TIMEOUT_MS`.
 * Used by PostRewriteHook and PostCommitHook to decide whether a worker is
 * already running. The check intentionally ignores `orphan-write.lock` so a
 * brief background writer (scanTreeHashAliases, getCatalogWithLazyBuild) does
 * not falsely advertise "worker is running".
 */
export async function isWorkerLockHeld(cwd?: string): Promise<boolean> {
	const dir = getJolliMemoryDir(cwd);
	const lockPath = join(dir, WORKER_LOCK_FILE);
	try {
		const lockStat = await stat(lockPath);
		return Date.now() - lockStat.mtimeMs < LOCK_TIMEOUT_MS;
	} catch {
		return false;
	}
}

/**
 * Returns true when `worker.lock` exists but is older than `LOCK_TIMEOUT_MS`.
 * Used by `doctor` to detect a crashed worker that left its lock behind.
 */
export async function isWorkerLockStale(cwd?: string): Promise<boolean> {
	const dir = getJolliMemoryDir(cwd);
	const lockPath = join(dir, WORKER_LOCK_FILE);
	try {
		const lockStat = await stat(lockPath);
		return Date.now() - lockStat.mtimeMs >= LOCK_TIMEOUT_MS;
	} catch {
		return false;
	}
}

/**
 * Bumps the mtime on `worker.lock` so a long-running worker (e.g. an LLM call
 * that exceeds `LOCK_TIMEOUT_MS`) cannot be stolen by the stale-lock reclaimer.
 * The worker calls this on a periodic timer for the duration of its run.
 *
 * Skips the bump when the lock is owned by a different PID — refreshing
 * someone else's lock would extend the lifetime of a lock the holder already
 * lost (after a stale-reclaim) and let the original holder believe it still
 * owns the lock when it doesn't.
 */
export async function refreshWorkerLockMtime(cwd?: string): Promise<void> {
	const dir = getJolliMemoryDir(cwd);
	const lockPath = join(dir, WORKER_LOCK_FILE);
	const ownerPid = await readLockOwnerPid(lockPath);
	if (ownerPid !== null && ownerPid !== String(process.pid)) {
		// Lock was reclaimed by another process — stop refreshing.
		return;
	}
	try {
		const now = new Date();
		await utimes(lockPath, now, now);
		/* v8 ignore next 3 -- transient utimes failure on a lock file is intentionally swallowed */
	} catch {
		// Lock file gone or filesystem hiccup — refresh is best-effort.
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquires `orphan-write.lock`, waiting up to `timeoutMs` for an existing
 * holder to release it. Returns true on success, false on timeout.
 *
 * `orphan-write.lock` is held only for the brief window of a single
 * `StorageProvider.writeFiles` call (read-modify-write of index/catalog),
 * so even a 1 s poll budget is enough to ride out almost all real contention.
 * The worker uses 30 s — its writes are post-LLM and must land.
 */
export async function acquireOrphanWriteLock(cwd?: string, opts: OrphanWriteLockOpts = {}): Promise<boolean> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_ORPHAN_WRITE_TIMEOUT_MS;
	const pollMs = opts.pollMs ?? DEFAULT_ORPHAN_WRITE_POLL_MS;
	const dir = await ensureSharedLockDir(cwd);
	const lockPath = join(dir, ORPHAN_WRITE_LOCK_FILE);
	const deadline = Date.now() + timeoutMs;

	while (true) {
		if (await tryAcquireOnce(lockPath)) return true;
		if (Date.now() >= deadline) return false;
		await sleep(pollMs);
	}
}

/**
 * Releases `orphan-write.lock` — only if the lock file's PID matches us. See
 * `releaseWorkerLock` for the rationale; both releases share `releaseIfOwned`.
 */
export async function releaseOrphanWriteLock(cwd?: string): Promise<void> {
	const dir = await resolveSharedLockDir(cwd);
	await releaseIfOwned(join(dir, ORPHAN_WRITE_LOCK_FILE), "orphan-write.lock");
}
