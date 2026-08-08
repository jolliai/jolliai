/**
 * DbDetection — "is the database still there, and if not, what happened?"
 *
 * The files live in the user's home directory; any process can delete them.
 * The goal is not prevention but recoverability without silent swallowing —
 * and, symmetrically, never jamming a genuinely fresh install. Three pieces:
 *
 * - **Liveness is an inode question, not a file-listing question.** A process
 *   holding an open handle keeps writing into a nameless inode after the file
 *   is deleted; every self-check passes until restart. So compare
 *   `fstat(fd)` with `stat(path)`: path gone, inode changed, or nlink == 0
 *   means the handle is detached from what the path now names.
 * - **File combinations define the legal states.** A cleanly-closed database
 *   legitimately has NO `-wal`/`-shm` (measured on this machine), so
 *   "triplet incomplete" must not be an alarm. The ONE alarming combination
 *   is sidecars without the `.db` — the main file was deleted out from under
 *   a live database. All three files absent falls through to identity.
 * - **Identity matching, not "registry non-empty".** Registry and mirror
 *   remnants survive independently (moved folders, restored configs), so
 *   "something exists ⇒ refuse to create" would jam every new machine. The
 *   instance id minted into schema_meta (see Backup.ensureInstanceId) is also
 *   stamped into the registry and mirror artifacts; matching ids prove the
 *   database was deleted, mismatched ids prove only that SOMETHING is stale —
 *   which is `doctor --recover`'s question, never grounds to silently build
 *   an empty database OR to permanently refuse.
 */

import { closeSync, fstatSync, openSync, statSync } from "node:fs";
import { createLogger } from "../Logger.js";

const log = createLogger("DbDetection");

/** The file-combination table, one row per legal or alarming state. */
export type DbFileState =
	| "healthy-clean" //       only .db — clean shutdown
	| "healthy-active" //      .db + -wal + -shm — live connections
	| "healthy-recoverable" // .db + -wal, no -shm — crashed, next open replays
	| "alarm-sidecars-only" // -wal/-shm present but .db GONE — the one alarm
	| "absent"; //             nothing — go ask the identity table

export function classifyDbFiles(dbPath: string): DbFileState {
	const present = (suffix: string): boolean => {
		try {
			statSync(`${dbPath}${suffix}`);
			return true;
		} catch {
			return false;
		}
	};
	const db = present("");
	const wal = present("-wal");
	const shm = present("-shm");
	if (db) {
		if (wal && shm) return "healthy-active";
		if (wal) return "healthy-recoverable";
		// .db + -shm alone also reads as clean enough: the -shm is inert
		// without a -wal and the next open ignores it.
		return "healthy-clean";
	}
	if (wal || shm) return "alarm-sidecars-only";
	return "absent";
}

/**
 * True when an OPEN handle no longer matches what `path` names — the file
 * was deleted or swapped underneath a live process. `fd` must be a handle
 * the caller obtained on the database file itself.
 */
export function isHandleDetached(fd: number, path: string): boolean {
	const live = fstatSync(fd);
	if (live.nlink === 0) return true; // deleted; we write into a ghost
	try {
		const named = statSync(path);
		return named.ino !== live.ino || named.dev !== live.dev;
	} catch {
		return true; // the path no longer exists at all
	}
}

/** Convenience wrapper: opens, checks, closes. For probes without a handle. */
export function isDbFileDetachedAt(path: string): boolean {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return true;
	}
	try {
		return isHandleDetached(fd, path);
	} finally {
		closeSync(fd);
	}
}

/** The identity-matching table for an ABSENT database. */
export type IdentityVerdict =
	| "fresh-install" //  no id recorded anywhere — build normally
	| "deleted" //        registry/mirror carry the SAME id — alarm, offer recovery
	| "ambiguous-residue"; // ids exist but disagree — doctor --recover decides

export function classifyIdentity(registryId: string | null, mirrorId: string | null): IdentityVerdict {
	if (registryId === null && mirrorId === null) return "fresh-install";
	if (registryId !== null && mirrorId !== null && registryId !== mirrorId) {
		// Two artifacts each claiming a different database: neither proves
		// deletion, so neither silently rebuilding nor permanent refusal is
		// right — surface it and point at doctor --recover.
		log.warn("registry and mirror carry different instance ids (%s vs %s)", registryId, mirrorId);
		return "ambiguous-residue";
	}
	// One or both sides carry an id, and every id present agrees: the database
	// these artifacts belonged to existed here and is gone.
	return "deleted";
}
