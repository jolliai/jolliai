/**
 * Cross-repo wakeup registry for queue workers that hit the
 * `vault-write.lock` 60 s timeout.
 *
 * The problem: one vault hosts content from many source repos as sibling
 * `<repoFolder>/` subtrees, but `vault-write.lock` is per-vault. When
 * repo A's sync round or worker holds the lock for long enough that
 * repo B's worker times out waiting (`QueueWorker.runWorker` →
 * `acquireVaultWriteLock({ wait: 60_000 })` miss), repo B's worker
 * process exits and the queue entry sits on disk in
 * `<repoB-cwd>/.jolli/jollimemory/git-op-queue/`. Nothing wakes it up
 * until repo B's next post-commit hook fires — which may be hours away
 * if the user isn't actively committing in repo B.
 *
 * Pre-existing `onRoundComplete` chain-spawn (SyncBootstrap.ts) only
 * spawns a worker for the round's OWN cwd. The pre-existing
 * QueueWorker chain-spawn at the end of `runWorker` only re-checks the
 * SAME cwd. Neither covers the cross-repo case.
 *
 * The fix: timeout victims record their cwd in a per-vault registry.
 * Lock releasers (sync round complete, worker drain finished) consume
 * the registry and `launchWorker(cwd)` for each entry.
 *
 * Storage layout — sibling of the vault lock file so producer and
 * consumer agree without extra plumbing. Path:
 *
 *   ~/.jolli/jollimemory/locks/vault-<sha256(canonical)>-pending/
 *     <sha256(cwd)>
 *
 * One file per pending cwd, contents = absolute cwd. SHA-256 of cwd as
 * the filename naturally collapses duplicate writes (two timeouts for
 * the same cwd produce the same filename → the second writer's
 * `writeFile` overwrites the first; consumer still sees one entry).
 *
 * Concurrency: producer and consumer never see torn state because each
 * entry is its own file (same idea as `git-op-queue/`). Producer races
 * with consumer on a single filename are benign — consumer's `rm`
 * after a `readFile` may race with a producer's overwrite, but
 * `launchWorker` is idempotent (spawn against an empty queue is a
 * cheap no-op), so the worst case is a redundant spawn or a missed
 * spawn that the next round picks up.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import { canonicaliseLocalFolder } from "./VaultLockPath.js";

const log = createLogger("Sync:PendingWorkers");

/**
 * Returns the absolute directory holding pending-worker entries for the
 * given **already-resolved** `memoryBankRoot`. Callers must pass the
 * output of `deriveMemoryBankRoot(localFolder)` (which falls back to
 * `~/Documents/jolli/` when `localFolder` is unset) so the default-config
 * case still has a stable per-vault registry key.
 *
 * Pre-fix this function took the raw `localFolder` and no-op'd on
 * `undefined` — which silently disabled the cross-repo wakeup for every
 * user on the default folder (the majority). Hashing the resolved root
 * here keeps the producer/consumer key derivation symmetric with
 * `getVaultWriteLockPath` (which also hashes a resolved path) and
 * removes the dormant-config no-op.
 *
 * `JOLLI_VAULT_LOCK_DIR` overrides the parent dir for tests, same as the
 * vault lock helper.
 */
export function getPendingWorkersDir(memoryBankRoot: string): string {
	const override = process.env.JOLLI_VAULT_LOCK_DIR;
	const dir =
		override !== undefined && override !== "" ? override : join(homedir(), ".jolli", "jollimemory", "locks");
	const canonical = canonicaliseLocalFolder(memoryBankRoot);
	const hash = createHash("sha256").update(canonical).digest("hex");
	return join(dir, `vault-${hash}-pending`);
}

/**
 * Records `cwd` as a worker that timed out waiting for `vault-write.lock`
 * and needs to be re-spawned the next time the lock is released. Safe to
 * call multiple times for the same cwd (idempotent — overwrites the same
 * filename).
 *
 * Best-effort: filesystem errors are logged and swallowed. The worst
 * outcome is that this particular timeout victim won't be auto-woken,
 * but its queue entry remains on disk and the repo's next post-commit
 * hook will pick it up.
 */
export async function recordPendingWorker(memoryBankRoot: string, cwd: string): Promise<void> {
	try {
		const dir = getPendingWorkersDir(memoryBankRoot);
		await mkdir(dir, { recursive: true });
		const fileName = createHash("sha256").update(cwd).digest("hex");
		await writeFile(join(dir, fileName), cwd, "utf-8");
		log.info("Recorded pending worker for cwd=%s", cwd);
	} catch (e) {
		log.warn("recordPendingWorker(%s) failed (non-fatal): %s", cwd, (e as Error).message);
	}
}

/**
 * Reads + clears the pending-worker registry. Returns the list of cwds
 * the caller should `launchWorker` against. The caller (not this module)
 * does the spawn so the producer/consumer separation stays clean and the
 * spawn helper can vary by host (CLI vs VS Code bundle).
 *
 * Each entry is deleted BEFORE its cwd is returned to the caller, so a
 * concurrent producer can race-add a NEW entry without it being lost on
 * the next consume. Worst case: a cwd recorded during the consume loop
 * survives to the next round (the missed-spawn-this-round path is the
 * same as having no registry at all, so this is no regression).
 *
 * Best-effort: a per-entry read or unlink failure is logged and skipped;
 * the function returns whatever cwds it managed to read.
 */
export async function consumePendingWorkers(memoryBankRoot: string): Promise<ReadonlyArray<string>> {
	const dir = getPendingWorkersDir(memoryBankRoot);
	let files: string[];
	try {
		files = await readdir(dir);
	} catch {
		return []; // No registry yet — nothing pending.
	}
	const cwds: string[] = [];
	for (const file of files) {
		const filePath = join(dir, file);
		try {
			// Do NOT `.trim()` — POSIX permits paths with leading/trailing
			// whitespace, and `recordPendingWorker` writes the cwd verbatim
			// (no surrounding newline). Trimming would corrupt those rare
			// but legal cwds. Empty content is still skipped as a corruption
			// guard.
			const cwd = await readFile(filePath, "utf-8");
			await rm(filePath, { force: true });
			if (cwd.length > 0) cwds.push(cwd);
		} catch (e) {
			log.warn("consumePendingWorkers: skipping %s: %s", file, (e as Error).message);
		}
	}
	// Tidy up the now-empty dir so a `ls ~/.jolli/jollimemory/locks/` stays
	// readable. Best-effort — failure is fine (rmdir refuses on non-empty,
	// which means a concurrent producer just landed an entry; that's
	// exactly the case we want to leave alone).
	try {
		await rm(dir, { recursive: false });
	} catch {
		// ignore — dir not empty (concurrent producer) or already gone.
	}
	return cwds;
}
