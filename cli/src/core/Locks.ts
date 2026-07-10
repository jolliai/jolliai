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

import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { createLogger, getJolliMemoryDir } from "../Logger.js";
import * as Subprocess from "../util/Subprocess.js";
import {
	acquireWithPoll,
	isLockStale,
	LOCK_TIMEOUT_MS,
	refreshLockMtime,
	releaseIfOwned,
	tryAcquireOnce,
} from "./LockPrimitives.js";

// Re-export so existing callers (Locks.test.ts, QueueWorker.ts, etc.) that
// imported it from this module keep compiling.
export { LOCK_TIMEOUT_MS };

const log = createLogger("Locks");

/**
 * Calls through `Subprocess` (rather than capturing a local reference) so
 * tests can `vi.spyOn(Subprocess, "execFileAsyncHidden")` and have the
 * resolver pick up the mock without us pre-binding the function.
 */
function gitRevParseCommonDir(cwd: string): Promise<{ stdout: string; stderr: string }> {
	return Subprocess.execFileAsyncHidden("git", ["rev-parse", "--git-common-dir"], { cwd });
}

export const WORKER_LOCK_FILE = "worker.lock";

/**
 * Fail-fast per-worktree lock the QueueWorker holds for the duration of a
 * topic-KB ingest (wiki render + graph build). Split out from `worker.lock`
 * so a long ingest (minutes, mostly graph build) no longer blocks summary
 * generation: summary drain keeps `worker.lock`, ingest runs concurrently
 * under `ingest.lock`. Lives next to `worker.lock` at
 * `<cwd>/.jolli/jollimemory/ingest.lock`. Heartbeated the same way (an ingest
 * can outlast `LOCK_TIMEOUT_MS`, so its mtime must be bumped to avoid a
 * stale-reclaim by the next worker).
 */
export const INGEST_LOCK_FILE = "ingest.lock";

/**
 * Purely-cosmetic phase file the QueueWorker writes while running an ingest so
 * the VS Code sidebar can show a "Building knowledge wiki/graph…" pill. Lives
 * next to `worker.lock` in `<cwd>/.jolli/jollimemory/`. It is NOT a lock and
 * carries **no gate role**: since ingest no longer holds `worker.lock`, the
 * commit/squash gates
 * (which key off `worker.lock` alone) are already open during ingest, so this
 * file only drives display. It holds the full sub-phase value (`ingest:wiki`
 * while ingesting + rendering the wiki, `ingest:graph` while building the
 * graph), is heartbeated for its lifetime, and is removed when ingest ends. A
 * surviving file only leaves the pill up a little longer (bounded by its own
 * mtime staleness + `ingest.lock` liveness on the reader side).
 */
export const INGEST_PHASE_FILE = "ingest-phase";
export const ORPHAN_WRITE_LOCK_FILE = "orphan-write.lock";
export const SYNC_LOCK_FILE = "sync.lock";
export const PLANS_LOCK_FILE = "plans.lock";
export const COMMIT_SELECTION_LOCK_FILE = "commit-selection.lock";
export const PUSH_PENDING_LOCK_FILE = "push-pending.lock";

/** Default wait budget for `acquireOrphanWriteLock` (background callers). */
export const DEFAULT_ORPHAN_WRITE_TIMEOUT_MS = 1000;

/** Default poll interval while waiting for `orphan-write.lock`. */
export const DEFAULT_ORPHAN_WRITE_POLL_MS = 50;

/**
 * Default wait budget for `withPlansLock`. The protected critical section is a
 * sub-millisecond read-modify-write of `plans.json`, so a peer holder clears
 * almost instantly; 5 s is generous headroom before we fall back to best-effort.
 */
export const DEFAULT_PLANS_LOCK_TIMEOUT_MS = 5000;

/** Default poll interval while waiting for `plans.lock`. */
export const DEFAULT_PLANS_LOCK_POLL_MS = 25;

/**
 * Default wait budget for `withPushPendingLock`. Same rationale as
 * `withPlansLock`: the guarded section is a sub-millisecond read-modify-write of
 * `push-pending.json`, so a peer holder clears almost instantly.
 */
export const DEFAULT_PUSH_PENDING_LOCK_TIMEOUT_MS = 5000;

/** Default poll interval while waiting for `push-pending.lock`. */
export const DEFAULT_PUSH_PENDING_LOCK_POLL_MS = 25;

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
	return isLockStale(join(dir, WORKER_LOCK_FILE));
}

/**
 * Reads the worker-busy state. `worker.lock` is held ONLY during summary
 * generation (ingest has its own `ingest.lock`), so "blocking" (a summary is in
 * flight, callers should wait) is exactly "held" — ingest can never make this
 * report blocking. Kept as a single atomic read (rather than inlining
 * `isWorkerLockHeld` at call sites) so the `held`/`blocking` pair is always
 * self-consistent.
 */
export async function getWorkerBusyState(cwd?: string): Promise<{ held: boolean; blocking: boolean }> {
	const held = await isWorkerLockHeld(cwd);
	return { held, blocking: held };
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
	await refreshLockMtime(join(dir, WORKER_LOCK_FILE));
}

/**
 * Acquires `ingest.lock`. Fail-fast: returns false immediately when another
 * worker already holds it, so only one ingest runs per worktree at a time.
 * Mirrors `acquireWorkerLock` — per-worktree, since ingest is a worktree-local
 * operation (same rationale as `worker.lock`).
 */
export async function acquireIngestLock(cwd?: string): Promise<boolean> {
	const dir = await ensureWorktreeLockDir(cwd);
	return tryAcquireOnce(join(dir, INGEST_LOCK_FILE));
}

/**
 * Releases `ingest.lock` — only if the lock file's PID matches us (see
 * `releaseWorkerLock` for the stale-reclaim rationale).
 */
export async function releaseIngestLock(cwd?: string): Promise<void> {
	const dir = getJolliMemoryDir(cwd);
	await releaseIfOwned(join(dir, INGEST_LOCK_FILE), INGEST_LOCK_FILE);
}

/**
 * Bumps `ingest.lock`'s mtime so a long ingest (wiki + graph build can run for
 * minutes) is not stolen by the stale-lock reclaimer. The worker calls this on
 * a periodic timer for the duration of the ingest. Skips the bump when a
 * different PID owns the lock (same guard as `refreshWorkerLockMtime`).
 */
export async function refreshIngestLockMtime(cwd?: string): Promise<void> {
	const dir = getJolliMemoryDir(cwd);
	await refreshLockMtime(join(dir, INGEST_LOCK_FILE));
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
	return acquireWithPoll(join(dir, ORPHAN_WRITE_LOCK_FILE), { timeoutMs, pollMs });
}

/**
 * Releases `orphan-write.lock` — only if the lock file's PID matches us. See
 * `releaseWorkerLock` for the rationale; both releases share `releaseIfOwned`.
 */
export async function releaseOrphanWriteLock(cwd?: string): Promise<void> {
	const dir = await resolveSharedLockDir(cwd);
	await releaseIfOwned(join(dir, ORPHAN_WRITE_LOCK_FILE), "orphan-write.lock");
}

/**
 * Runs `fn` while holding `plans.lock`, serialising the read-modify-write of
 * `plans.json` (plans, notes, and references) across processes.
 *
 * **Why it's needed.** `plans.json` has several concurrent writers, both in
 * separate OS processes and inside one process:
 *   - Claude StopHook (spawned at agent stop) — plans + references.
 *   - QueueWorker (spawned post-commit) — plan/note archival, reference finalize.
 *   - Codex reference-discovery tick (IDE extension host) — references.
 *   - The IDE extension-host services — `ReferenceService`, `PlanService`,
 *     `NoteService`, and the summary webview's plan-title sync — on user actions.
 * Each does a load → mutate → `savePlansRegistry` (whole-file write). The
 * in-function "near-write reread + per-key merge" only narrows the SAME-flow
 * window; two loaders that each miss the other's row let the later
 * `savePlansRegistry` clobber it. A shared lock around the RMW closes that
 * window. It only works if EVERY writer takes it — partial coverage serialises
 * nothing; all the writers above call through here.
 *
 * **Cross-process AND intra-process.** This is a PID-tagged file lock, but it
 * serialises both ways: across processes via the PID/mtime staleness protocol,
 * and between two SEPARATE async flows in one process (e.g. the discovery tick
 * vs. a sidebar edit, both in the extension host) because the second contender
 * poll-waits until the first releases. The ONE thing it cannot do is re-entrancy
 * (a single flow that already holds it calling `withPlansLock` again) — that
 * polls to timeout then runs best-effort. Hence the "MUST NOT be nested" rule.
 *
 * **Per-worktree.** The lock lives in `<cwd>/.jolli/jollimemory/` next to the
 * `plans.json` it guards, so two git worktrees (each with their own
 * `plans.json`) never contend with each other.
 *
 * **Best-effort fallback.** If the lock can't be acquired within `timeoutMs`
 * (a peer holding it pathologically long — a fast RMW never does, and a crashed
 * holder is reclaimed automatically once stale), `fn` still runs so writes that
 * MUST land (StopHook / QueueWorker archival) are never silently dropped; the
 * pre-existing per-key merge remains as residual mitigation. MUST NOT be nested:
 * wrap leaf RMW functions only, never a caller that already holds it.
 */
export async function withPlansLock<T>(
	cwd: string | undefined,
	fn: () => Promise<T>,
	opts: OrphanWriteLockOpts = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_PLANS_LOCK_TIMEOUT_MS;
	const pollMs = opts.pollMs ?? DEFAULT_PLANS_LOCK_POLL_MS;
	const dir = await ensureWorktreeLockDir(cwd);
	const lockPath = join(dir, PLANS_LOCK_FILE);
	const acquired = await acquireWithPoll(lockPath, { timeoutMs, pollMs });
	if (!acquired) {
		log.warn(
			"withPlansLock: could not acquire %s within %d ms — proceeding best-effort (per-key merge still mitigates)",
			PLANS_LOCK_FILE,
			timeoutMs,
		);
	}
	try {
		return await fn();
	} finally {
		if (acquired) await releaseIfOwned(lockPath, PLANS_LOCK_FILE);
	}
}

/**
 * Cross-process lock for `commit-selection.json` writes. Both the pre-commit panel
 * (persists the AI ranking) and the post-commit QueueWorker (clears it after consuming,
 * so a stale fingerprint can't be reused by a later commit touching the same file set)
 * write this file, so they must not lose-update each other. Mirrors `withPlansLock`:
 * worktree-scoped, best-effort (fn still runs if the lock can't be acquired within
 * `timeoutMs`; the atomic tmp+rename write keeps the file from ever being corrupted).
 * MUST NOT be nested — wrap leaf RMW functions only.
 */
export async function withCommitSelectionLock<T>(
	cwd: string | undefined,
	fn: () => Promise<T>,
	opts: OrphanWriteLockOpts = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_PLANS_LOCK_TIMEOUT_MS;
	const pollMs = opts.pollMs ?? DEFAULT_PLANS_LOCK_POLL_MS;
	const dir = await ensureWorktreeLockDir(cwd);
	const lockPath = join(dir, COMMIT_SELECTION_LOCK_FILE);
	const acquired = await acquireWithPoll(lockPath, { timeoutMs, pollMs });
	if (!acquired) {
		log.warn(
			"withCommitSelectionLock: could not acquire %s within %d ms — proceeding best-effort",
			COMMIT_SELECTION_LOCK_FILE,
			timeoutMs,
		);
	}
	try {
		return await fn();
	} finally {
		if (acquired) await releaseIfOwned(lockPath, COMMIT_SELECTION_LOCK_FILE);
	}
}

/**
 * Guards a read-modify-write of `push-pending.json`. Same shape as
 * `withPlansLock`: per-worktree; best-effort fallback so writes that MUST land
 * (pre-push enqueue, worker success/failure accounting) are never silently
 * dropped. Callers re-read inside `fn` so a lost-update is avoided even under
 * the best-effort fallback. MUST NOT be nested.
 */
export async function withPushPendingLock<T>(
	cwd: string | undefined,
	fn: () => Promise<T>,
	opts: OrphanWriteLockOpts = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_PUSH_PENDING_LOCK_TIMEOUT_MS;
	const pollMs = opts.pollMs ?? DEFAULT_PUSH_PENDING_LOCK_POLL_MS;
	const dir = await ensureWorktreeLockDir(cwd);
	const lockPath = join(dir, PUSH_PENDING_LOCK_FILE);
	const acquired = await acquireWithPoll(lockPath, { timeoutMs, pollMs });
	if (!acquired) {
		log.warn(
			"withPushPendingLock: could not acquire %s within %d ms — proceeding best-effort",
			PUSH_PENDING_LOCK_FILE,
			timeoutMs,
		);
	}
	try {
		return await fn();
	} finally {
		if (acquired) await releaseIfOwned(lockPath, PUSH_PENDING_LOCK_FILE);
	}
}
