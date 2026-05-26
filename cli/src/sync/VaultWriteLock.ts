/**
 * Per-vault writer lock.
 *
 * Held by callers that mutate the vault working tree, but with **asymmetric
 * scope** between the two acquirers — sync and worker hold the lock for
 * different windows by design, not by oversight:
 *
 *   - **QueueWorker** acquires the lock for the ENTIRE drain — from
 *     `runWorker` entry through the last `writeFiles` and queue-entry
 *     deletion (see `cli/src/hooks/QueueWorker.ts` — `vaultLock` acquire
 *     at the top of the function, release in the outer `finally`). The
 *     worker's writes span N files per summary (canonical JSON + visible
 *     Markdown + aggregate index updates), so it cannot release between
 *     files without exposing the tear-across-files window the lock exists
 *     to close.
 *
 *   - **SyncEngine** acquires the lock only across the `pullRebase` +
 *     `ConflictResolver.resolveAll` window (see `SyncEngine.withPullLock`).
 *     The pre-pull and post-pull phases (auto-reconcile, stageVault,
 *     commit, push) run WITHOUT the lock. This is a deliberate UX
 *     tradeoff: holding the lock around the whole round (30-90 s in
 *     practice) would make a user-initiated `git commit` in the source
 *     repo wait the full round before its summary appears in the sidebar.
 *     Releasing between pullRebase and commit accepts that a concurrent
 *     worker drain CAN observe sync mid-write, producing a partial commit
 *     that captures some files of an in-progress worker multi-file write
 *     but not others. This is documented as the R8 "benign /
 *     eventually-consistent" tradeoff: the next sync round picks up the
 *     missing files in its own stage/commit pass; no data is lost on disk,
 *     only the granularity of one git commit. The R9 race the lock
 *     definitively closes is "worker writes land in the paused-rebase
 *     window" — that window is fully inside `withPullLock`, so it cannot
 *     happen.
 *
 * If you are tempted to extend sync's lock to cover the whole round to
 * "fix" R8, talk to the sync owner first — the UX cost was the gating
 * reason for the current scope (see Phase 4 of the sync-allowlist-staging
 * plan), and the eventually-consistent property is what makes that scope
 * acceptable.
 *
 * Why this is NOT `worker.lock` (existing): `worker.lock` is per-worktree (one
 * per source repo). The vault at `<localFolder>/` hosts content from many
 * source repos as sibling `<repoFolder>/` subtrees. A second-repo worker
 * writing into `<localFolder>/<repoB>/.jolli/…` while sync is reading
 * `git status` against the vault would tear the multi-file write across the
 * `git status` snapshot — exactly the R8 / R9 risk this lock closes. Per-vault
 * scope is what's needed.
 *
 * Why this is NOT `sync.lock` (existing): `sync.lock` is machine-wide per-user
 * and only serialises sync-vs-sync. Workers don't touch it. The new
 * `vault-write.lock` serialises sync-vs-worker (and worker-vs-worker across
 * source repos sharing a vault).
 *
 * Lock file location is derived in `VaultLockPath.ts` — outside the vault, at
 * `~/.jolli/jollimemory/locks/vault-<sha256(canonical)>.lock`, so QueueWorker
 * can acquire it BEFORE constructing storage (which would otherwise trigger
 * `resolveKBPath`'s side effects — creating `.jolli/config.json` and racing
 * with concurrent acquirers).
 *
 * PID + mtime mechanics inherit from `LockPrimitives.ts` — same stale-reclaim
 * + PID-checked release as `worker.lock` / `orphan-write.lock` / `sync.lock`.
 * Both acquirers refresh the lock's mtime via `setInterval` for the duration
 * of their hold window (60 s cadence vs. the 5 min reclaim threshold) so
 * long-running LLM calls or Tier 2/3 conflict resolves don't lose the lock
 * mid-flight.
 *
 * Acquisition modes:
 *   - **`"fail-fast"`** — single-shot attempt; returns immediately on miss.
 *     Used by callers that have an "exit, try again later" path (the queue
 *     entry will be retried by the next worker spawn).
 *   - **`{ wait: ms }`** — poll until acquired or `ms` elapsed. Used by
 *     sync (waits up to 10 s in `withPullLock` so a busy worker bumps the
 *     round into transient `network` rather than blocking the UI) AND by
 *     workers (waits up to 60 s for sync to finish; aligns with the plan's
 *     wait-mode decision so a hook-triggered worker doesn't drop its queue
 *     entry just because sync happened to be running).
 *
 * Invariant: the lock MUST be acquired around `pullRebase` +
 * `ConflictResolver.resolveAll` (sync) and around the ENTIRE worker drain
 * (worker). Skipping either of these re-opens R9 (sync) or R8-as-tear
 * (worker) respectively.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
	acquireWithPoll,
	isLockHeld,
	refreshLockMtime,
	releaseIfOwned,
	tryAcquireOnce,
} from "../core/LockPrimitives.js";
import { createLogger } from "../Logger.js";
import { getVaultWriteLockPath } from "./VaultLockPath.js";

const log = createLogger("Sync:VaultWriteLock");

/**
 * Default wait budget when the caller picks blocking-with-timeout mode.
 * Matches the chain-spawn-on-release decision: 60 s covers the 95th-percentile
 * sync round AND typical LLM-bearing worker drain, so a polite worker (post-
 * commit hook) waiting on a busy sync is overwhelmingly likely to succeed
 * within budget.
 */
export const DEFAULT_VAULT_WRITE_WAIT_MS = 60_000;

/**
 * Short wait budget for sync's `pullRebase` site (see `pullRebaseLocked` in
 * SyncEngine). Sync wants to *yield* to a busy worker, not wait through a
 * whole LLM-bearing drain — if 10 s isn't enough, the round skips and the
 * next 90-min poll retries. Distinct from the 60 s worker budget because
 * the worker has queue entries to drain and wants to wait through sync.
 */
export const DEFAULT_PULL_LOCK_WAIT_MS = 10_000;

/** Poll interval while waiting for the lock. */
export const DEFAULT_VAULT_WRITE_POLL_MS = 100;

/**
 * `acquireVaultWriteLock` mode discriminator.
 *
 *   - `"fail-fast"` — return `false` immediately if the lock is held.
 *   - `{ wait: ms }` — poll up to `ms` milliseconds; return `false` on
 *     timeout. Callers that pass `wait: 0` get fail-fast semantics from
 *     `acquireWithPoll` automatically — no special-case here.
 */
export type VaultWriteLockMode = "fail-fast" | { readonly wait: number };

/**
 * Acquires `vault-write.lock` for the vault rooted at `vaultRoot`.
 *
 * `vaultRoot` is the **already-resolved** memory-bank root for the active
 * vault — typically `deriveMemoryBankRoot(config.localFolder)`, i.e.
 * `<localFolder>/<repoFolder>` with `~` expanded. Callers must NOT pass the
 * raw user-configured `localFolder` here; the SHA-256 derived from
 * `vaultRoot` keys the lock file, and two callers passing different
 * pre-canonicalisation forms would compute different lock paths and lose
 * mutual exclusion silently. Both production call sites (SyncEngine's
 * `pullRebaseLocked` and QueueWorker's main entry) pass the post-derive
 * value.
 *
 * Returns a handle with `release()` / `refresh()` methods on success, or
 * `null` on miss (fail-fast) / timeout (wait-mode). The handle MUST be
 * released on every exit path — caller's `try/finally` is the load-bearing
 * cleanup hook. Failure to release leaks the lock for up to `LOCK_TIMEOUT_MS`
 * (5 min) before the next acquirer reclaims it.
 *
 * The handle interface mirrors a Disposable / Resource pattern so callers
 * don't need to remember the right paired release function — they hold the
 * handle and call `handle.release()`. Tests with multiple in-flight handles
 * (e.g. simulating sync + worker on the same vault) get clean isolation
 * without sharing a module-level "current lock" reference.
 */
export interface VaultWriteLockHandle {
	readonly release: () => Promise<void>;
	readonly refresh: () => Promise<void>;
}

export async function acquireVaultWriteLock(
	vaultRoot: string,
	mode: VaultWriteLockMode,
): Promise<VaultWriteLockHandle | null> {
	const lockPath = getVaultWriteLockPath(vaultRoot);
	// Lock parent dir — `~/.jolli/jollimemory/locks/` — may not exist on a
	// brand-new install. `mkdir -p` is a no-op if it already does.
	await mkdir(dirname(lockPath), { recursive: true });

	let acquired: boolean;
	if (mode === "fail-fast") {
		acquired = await tryAcquireOnce(lockPath);
	} else {
		acquired = await acquireWithPoll(lockPath, {
			timeoutMs: mode.wait,
			pollMs: DEFAULT_VAULT_WRITE_POLL_MS,
		});
	}

	if (!acquired) {
		log.debug(
			"acquireVaultWriteLock miss mode=%s vaultRoot=%s",
			typeof mode === "string" ? mode : `wait:${mode.wait}`,
			vaultRoot,
		);
		return null;
	}

	return {
		release: () => releaseIfOwned(lockPath, "vault-write.lock"),
		refresh: () => refreshLockMtime(lockPath),
	};
}

/**
 * Returns true when `vault-write.lock` exists and is younger than
 * `LOCK_TIMEOUT_MS`. Diagnostic-only — callers that want to act on the
 * outcome should `acquireVaultWriteLock` instead, since this read is
 * inherently racy (lock can be released between the check and any
 * follow-up action).
 */
export async function isVaultWriteLockHeld(vaultRoot: string): Promise<boolean> {
	return isLockHeld(getVaultWriteLockPath(vaultRoot));
}
