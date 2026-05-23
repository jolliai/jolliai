/**
 * Pre-stage corrupt-JSON quarantine (plan §I9).
 *
 * **Why this exists.** `SyncEngine.runRound` auto-reconciles a dirty
 * working tree via `stageAll` + `commit` before `pullRebase`, so a manual
 * `rm`/edit by the user doesn't trip rebase. The hazard: if FolderStorage
 * crashed mid-write, or an editor flushed only half of a file, the dirty
 * tree contains a TRUNCATED / SYNTACTICALLY-INVALID `.jolli/**\/*.json`.
 * Pre-fix, that file got staged + committed into the orphan history.
 * Every peer device then pulled the corrupt blob and downstream code
 * (`FolderStorage.read*`, `SummaryStore.merge*`, index loaders) crashed
 * trying to parse it. Once on orphan history, the corruption is replicated
 * across the fleet and is expensive to expunge.
 *
 * The fix is to validate every dirty `.jolli/**\/*.json` BEFORE staging.
 * Files that `JSON.parse` rejects are renamed to
 * `<memoryBankRoot>/.jolli-quarantine-corrupt/<safe-name>` (engine-owned,
 * dot-prefixed, denied by the `.gitignore` `**\/.*` rule so it never
 * stages). The caller then `stageAll`-s and commits a CLEAN tree;
 * downstream peers never see the broken blob.
 *
 * **Mirroring `SymlinkSweep`.** Same directory-placement rationale: a
 * single vault-root quarantine dir avoids per-repo `mkdir(recursive)`
 * following a hostile intermediate symlink. Same name-encoding (slashes
 * replaced by dashes) so the quarantined file's origin is recoverable.
 * Same idempotency: a JSON written cleanly on the next round passes
 * validation; the corrupt copy stays in the quarantine dir for forensic
 * inspection until the user deletes it.
 *
 * **Scope decisions.**
 *   - Only `.json` files under `.jolli/` are validated. User-authored
 *     `.md` notes and arbitrary non-JSON files are passed through —
 *     they're either trivially valid plaintext or the user's own
 *     responsibility. Validating user content would be a privacy /
 *     surprise risk.
 *   - Empty files (`""`) are quarantined: `JSON.parse("")` throws and the
 *     storage layer treats zero-byte aggregate files as corruption
 *     equally with malformed ones. A FolderStorage write that truncated
 *     to zero bytes is exactly the mid-write hazard we're guarding.
 *   - Missing files (uncommitted deletions) are silently skipped — no
 *     content to validate.
 *
 * **What we DON'T do.**
 *   - Schema validation. `JSON.parse`-ability is the failure boundary;
 *     a file that parses to an unexpected shape is the storage layer's
 *     problem and would not be caught here even if we tried (no schema
 *     registry at this layer). Strict shape-checks belong adjacent to
 *     the read paths, not here.
 *   - Repair. We never attempt to fix a corrupt JSON; quarantine +
 *     forensic preservation is the conservative move.
 */

import { lstat, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { createLogger } from "../Logger.js";
import { appendLocalExclude } from "./LocalGitExclude.js";

const log = createLogger("Sync:CorruptJsonQuarantine");

/**
 * Single quarantine directory at the vault root. Dot-prefixed so the
 * `.gitignore` `**\/.*` rule keeps it out of the index, parallel to
 * `.jolli-quarantine-symlinks/`.
 */
export const QUARANTINE_CORRUPT_DIR = ".jolli-quarantine-corrupt";

export interface CorruptJsonReport {
	/** Number of files moved into the quarantine dir this round. */
	readonly quarantined: number;
	/**
	 * Relative paths (from `memoryBankRoot`) of every file we moved.
	 * Diagnostics + tests; production callers just need the count.
	 */
	readonly paths: ReadonlyArray<string>;
}

/**
 * Walks `dirtyPaths` (relative to `memoryBankRoot`), validates each
 * `.jolli/**\/*.json` is parseable, and quarantines the ones that aren't.
 * Non-matching paths (non-JSON, outside `.jolli/`) are ignored verbatim.
 *
 * Idempotent: a missing file is treated as already-handled (uncommitted
 * deletion). A previously-quarantined entry's destination is overwritten
 * on collision so a recurring corrupt write doesn't accumulate stale
 * copies.
 */
export async function quarantineCorruptJson(
	memoryBankRoot: string,
	dirtyPaths: ReadonlyArray<string>,
): Promise<CorruptJsonReport> {
	const candidates = dirtyPaths.filter(isValidatableJson);
	if (candidates.length === 0) {
		return { quarantined: 0, paths: [] };
	}

	const found: string[] = [];
	for (const rel of candidates) {
		const abs = join(memoryBankRoot, rel);
		try {
			const stats = await lstat(abs);
			if (!stats.isFile()) continue; // symlinks (already swept), dirs, sockets
		} catch {
			continue; // missing (uncommitted deletion) — nothing to validate
		}
		let content: string;
		try {
			content = await readFile(abs, "utf-8");
		} catch (e) {
			/* v8 ignore start -- a file whose lstat succeeded as a regular file but readFile fails is an extreme race (perms changed between lstat and read, file unlinked mid-call). Treated like missing — skip rather than throw. */
			log.debug("readFile failed for %s (skipped): %s", rel, (e as Error).message);
			continue;
			/* v8 ignore stop */
		}
		try {
			JSON.parse(content);
		} catch {
			found.push(rel);
		}
	}

	if (found.length === 0) {
		return { quarantined: 0, paths: [] };
	}

	const quarantineDir = join(memoryBankRoot, QUARANTINE_CORRUPT_DIR);
	const dirOk = await ensureQuarantineDir(quarantineDir);
	// Belt-and-suspenders: write a per-clone exclude line so the
	// directory is invisible to `git add --all` even on the first round
	// before `MemoryBankBootstrap` writes `.gitignore`. Failure is
	// non-fatal — same justification as in `SymlinkSweep`.
	await appendLocalExclude(memoryBankRoot, `${QUARANTINE_CORRUPT_DIR}/`);
	if (!dirOk) {
		log.warn(
			"Quarantine dir unusable — %d corrupt JSON file(s) left in place. Auto-reconcile may stage them.",
			found.length,
		);
		return { quarantined: 0, paths: [] };
	}

	let quarantined = 0;
	const moved: string[] = [];
	for (const rel of found) {
		const src = join(memoryBankRoot, rel);
		const safeName = rel.replace(/[\\/]/g, "-");
		const dst = join(quarantineDir, safeName);
		// Best-effort cleanup of a previously-quarantined dup at this name
		// so `rename` doesn't fail on the destination existing (some
		// filesystems / Windows reject rename-over).
		try {
			await unlink(dst);
		} catch {
			// ENOENT or similar — no stale to clean, that's fine.
		}
		try {
			await rename(src, dst);
			quarantined += 1;
			moved.push(rel);
			log.warn(
				"Quarantined corrupt JSON: %s → %s (plan §I9 — never stage unparseable aggregates)",
				rel,
				relative(memoryBankRoot, dst),
			);
		} catch (e) {
			/* v8 ignore start -- rename failure between cleanup + move is the EBUSY/EACCES race window; logged but non-fatal so the round can still continue with whatever it could move */
			log.warn("Failed to quarantine corrupt JSON %s (non-fatal): %s", rel, (e as Error).message);
			/* v8 ignore stop */
		}
	}
	return { quarantined, paths: moved };
}

/**
 * `true` iff this relative path is one we should validate: ends in `.json`
 * AND is under the engine-owned `.jolli/` subtree (recursive). User-
 * authored `.json` files outside `.jolli/` are intentionally left alone.
 *
 * Matches `<repo>/.jolli/...` AND root-level `.jolli/...` (the engine
 * stores both shapes depending on multi-repo layout).
 */
function isValidatableJson(rel: string): boolean {
	if (!rel.endsWith(".json")) return false;
	const segments = rel.split(/[\\/]+/);
	return segments.includes(".jolli");
}

/**
 * Same shape as `SymlinkSweep.ensureQuarantineDir` so the two quarantines
 * behave identically:
 *   - existing real directory: leave alone.
 *   - existing symlink: unlink (engine-owned location, no user data) and
 *     fall through to mkdir.
 *   - existing regular file / other: refuse (return false). Better to
 *     surface as "left in place" than clobber unknown user data.
 *   - nothing: mkdir (non-recursive — caller has already proven
 *     `<memoryBankRoot>/.git` exists, so the parent is sound).
 */
async function ensureQuarantineDir(quarantineDir: string): Promise<boolean> {
	let s: Awaited<ReturnType<typeof lstat>> | null = null;
	try {
		s = await lstat(quarantineDir);
	} catch {
		s = null;
	}
	if (s !== null) {
		if (s.isSymbolicLink()) {
			log.warn("Quarantine path %s is a symlink — unlinking (engine-owned, no user data here)", quarantineDir);
			try {
				await unlink(quarantineDir);
			} catch (e) {
				/* v8 ignore start -- defensive: `unlink` on a path whose lstat just succeeded as a symbolic link only fails when permissions change between the lstat and the unlink (race), not reproducible in the fixture */
				log.warn("Failed to unlink hostile quarantine symlink: %s", (e as Error).message);
				return false;
				/* v8 ignore stop */
			}
		} else if (s.isDirectory()) {
			return true;
		} else {
			log.warn(
				"Quarantine path %s exists but is neither directory nor symlink — refusing to quarantine this round",
				quarantineDir,
			);
			return false;
		}
	}
	try {
		await mkdir(quarantineDir);
		return true;
	} catch (e) {
		/* v8 ignore start -- mkdir only fails under fs corruption or read-only mount; not reproducible in the fixture deterministically */
		log.warn("Failed to create quarantine dir %s: %s", quarantineDir, (e as Error).message);
		return false;
		/* v8 ignore stop */
	}
}
