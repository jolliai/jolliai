/**
 * Path derivation for `vault-write.lock` — the per-vault writer lock.
 *
 * Why this file is separate from `VaultWriteLock.ts`: the canonicalisation is
 * also useful for diagnostics ("which lock file would this localFolder map
 * to?") and is exercised by its own unit test independently of the lock's
 * acquire/release semantics. Path = data; lock = behaviour.
 *
 * Lock location: `~/.jolli/jollimemory/locks/vault-<sha256(canonical)>.lock`.
 *
 *   - **Outside the vault** because the vault's `.git/` doesn't exist before
 *     clone/init. QueueWorker has to acquire the lock BEFORE any storage
 *     construction (which would call `resolveKBPath` and write a stub
 *     `.jolli/config.json` — racing if two workers entered concurrently).
 *     A lock inside the vault would not be reachable in that pre-init window.
 *   - **Per-user**, under the same `~/.jolli/jollimemory/` parent that already
 *     hosts `sync.lock` — keeps all jollimemory locks in one place.
 *   - **Hashed**, not stored as a literal path, so the lock filename stays
 *     fixed-length and printable regardless of how exotic the user's
 *     `localFolder` is (spaces, non-ASCII, very long).
 *
 * Canonicalisation MUST match byte-for-byte between sync and QueueWorker.
 * If they disagree by one character, they acquire different locks and the
 * whole point of the exclusion is defeated. The six-step contract is
 * documented inline on `canonicaliseLocalFolder` below; both callers
 * (`SyncEngine.runRound` and `QueueWorker.runWorker`) import this single
 * helper rather than reimplementing.
 */

import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * Canonicalises a `localFolder` path string into a stable identifier suitable
 * for hashing into the lock filename.
 *
 * Steps (all must match between sync and worker — they run in different
 * processes that compute this independently and must agree):
 *
 *   1. Expand a leading `~` to the user's home directory.
 *   2. Resolve to a lexical absolute path (handles `..`, `.`, relative inputs).
 *   3. Walk up to the nearest existing ancestor and `realpathSync.native()`
 *      THAT, then re-append the non-existent tail segments lexically. This
 *      handles the cold-start case where `<localFolder>` doesn't exist yet
 *      (about to be cloned into). Pure `realpath` would throw ENOENT.
 *   4. Case-fold on filesystems that are case-insensitive at the kernel
 *      level (`win32`, `darwin`). On Linux this is a no-op — preserving case
 *      is correct on case-sensitive filesystems.
 *   5. Trim trailing separators and collapse duplicates.
 *   6. (Hashing happens in `getVaultWriteLockPath` — this function returns
 *      the canonical string itself for tests + diagnostics.)
 *
 * Throws on empty input — the caller has a bug if it passes "".
 */
export function canonicaliseLocalFolder(s: string): string {
	if (s.length === 0) {
		throw new Error("canonicaliseLocalFolder: empty input");
	}

	// Step 1 — leading `~` expansion. Node's `path` does not expand `~`.
	let p = s;
	if (p === "~") {
		p = homedir();
	} else if (p.startsWith("~/") || p.startsWith("~\\")) {
		p = homedir() + p.slice(1);
	}

	// Step 2 — lexical absolute resolve. `path.resolve` normalises `.`, `..`,
	// duplicate separators, and turns relative inputs absolute against
	// `process.cwd()`. It does NOT touch the filesystem.
	p = resolve(p);

	// Step 3 — realpath the nearest existing ancestor, re-append the tail.
	p = resolvePartialRealpath(p);

	// Step 4 — case-fold on case-insensitive filesystems.
	if (process.platform === "win32" || process.platform === "darwin") {
		p = p.toLowerCase();
	}

	// Step 5 — collapse duplicate separators + trim trailing separator. The
	// regex replaces ANY run of `/` or `\` with the platform's native `sep`.
	// On Windows that converts forward slashes to backslashes for
	// consistency; on POSIX the platform sep is already `/` so this is a
	// no-op for already-normalised paths.
	p = p.replace(/[/\\]+/g, sep);
	if (p.length > 1 && p.endsWith(sep)) {
		p = p.slice(0, -1);
	}

	return p;
}

/**
 * Walks up `p` to the nearest path segment that exists on disk, realpaths
 * THAT segment (resolving any symlinks in the parent chain), and re-appends
 * the non-existent tail lexically.
 *
 * Why not pure `realpathSync`: it throws ENOENT when ANY segment in the path
 * doesn't exist. The hotfix has to compute a stable lock path for a
 * localFolder that's about to be cloned but doesn't exist yet. The
 * ancestor-realpath approach gives the same canonical hash before AND after
 * the vault materialises.
 *
 * The fallback to the input `p` only triggers if even `/` (or `C:\`) can't
 * be statted — which shouldn't happen on a healthy system. If it does, the
 * lock acquisition further downstream will throw on `mkdir`, so callers
 * still see a clear error.
 */
function resolvePartialRealpath(p: string): string {
	const tail: string[] = [];
	let cur = p;
	while (true) {
		try {
			statSync(cur);
			// Found an existing segment. realpath it (resolves symlinks in
			// the parent chain) and re-attach the non-existent tail.
			const real = realpathSync.native(cur);
			return tail.length === 0 ? real : join(real, ...tail);
		} catch {
			const parent = dirname(cur);
			if (parent === cur) {
				// Hit filesystem root with no existing ancestor. Return the
				// lexical resolution (step 2's output) unchanged — better
				// than crashing here.
				return p;
			}
			tail.unshift(basename(cur));
			cur = parent;
		}
	}
}

/**
 * Returns the absolute path to the vault-write lock file for the given
 * `localFolder`. The same `localFolder` always maps to the same path,
 * regardless of whether the vault has been initialised on disk.
 *
 * `JOLLI_VAULT_LOCK_DIR` env override mirrors the existing `JOLLI_SYNC_LOCK_DIR`
 * convention used by `SyncLock.getSyncLockPath` — lets the acceptance suite
 * isolate vault-lock state from a developer's real Jolli install.
 */
export function getVaultWriteLockPath(localFolder: string): string {
	const override = process.env.JOLLI_VAULT_LOCK_DIR;
	const dir =
		override !== undefined && override !== "" ? override : join(homedir(), ".jolli", "jollimemory", "locks");
	const canonical = canonicaliseLocalFolder(localFolder);
	const hash = createHash("sha256").update(canonical).digest("hex");
	return join(dir, `vault-${hash}.lock`);
}

/**
 * Test-only: derive the canonical form without hashing. Useful for assertions
 * that don't want to compare SHA-256 hex digests. Not exported from any other
 * production code path.
 */
export function __vaultLockCanonicalForTesting(localFolder: string): string {
	return canonicaliseLocalFolder(localFolder);
}
