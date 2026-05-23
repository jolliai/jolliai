/**
 * Pre-stage symlink sweeper (plan §P2).
 *
 * **Why this exists.** Steady-state sync ends in `git add --all`. Git treats
 * symlinks as first-class objects (mode 120000) — the resulting commit and
 * push leak the symlink's *target path* string to the personal-space repo
 * on GitHub. A peer device that re-clones the vault then materialises a
 * symlink in its own working tree pointing at the same path on ITS disk;
 * any viewer, indexer, or storage code that opens the file then follows
 * the link and reads whatever happens to live there. Worse, FolderStorage
 * can overwrite a symlink with new content, which traverses the link and
 * overwrites whatever the target points at (e.g. `~/.aws/credentials`).
 *
 * The fix is to refuse to track symlinks at all. We walk the vault working
 * tree with `lstat`, quarantine every symlink (rename into
 * `<vault>/.jolli-quarantine-symlinks/`), and let the next `git add --all`
 * see a symlink-free tree. The quarantine name preserves the relative path
 * (path-separators replaced by `-`) so users can audit what was rejected.
 *
 * **Why a SINGLE vault-root quarantine and NOT a per-repo one.** The pre-
 * §P2-revision implementation routed each symlink to `<repo>/.jolli/
 * quarantine-symlinks/`. That looks tidier but is itself an exploit
 * vector: if `<repo>` or `<repo>/.jolli` is a symlink (the very threat we
 * sweep against), `mkdir(quarantineDir, recursive: true)` would follow
 * the link and create the quarantine folder OUTSIDE the vault — then
 * `rename` would land the original symlink in a host-system directory.
 * Anchoring the quarantine at one fixed path under `<memoryBankRoot>`,
 * with an explicit `lstat`-and-replace guard for that path, eliminates
 * the traversal entirely: there are no untrusted intermediate segments
 * to follow.
 *
 * **Errors are non-fatal.** A single permission glitch or transient race
 * shouldn't drop the whole round to offline — the worst case under a
 * sweep error is the same as the pre-§P2 behaviour. We log warnings and
 * move on. A second sweep next round will catch what the first missed.
 *
 * **What we don't sweep.** `.git/` is excluded — git's internal symlinks
 * (notably `.git/HEAD` on some platforms, packed-refs, etc.) must not be
 * touched. The quarantine directory itself is also skipped so we don't
 * re-process our own output. The legacy `.jolli/quarantine-symlinks/`
 * and `.jolli/quarantine-summaries/` directories are likewise skipped so
 * pre-existing per-repo quarantine output from older versions doesn't
 * get re-walked.
 */

import { lstat, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { createLogger } from "../Logger.js";
import { appendLocalExclude } from "./LocalGitExclude.js";

const log = createLogger("Sync:SymlinkSweep");

/**
 * Single quarantine directory, at the vault root. The leading-dot prefix
 * (`.jolli-…`) is denied by `MemoryBankBootstrap`'s `.gitignore` §3
 * (`**\/.*` matches any dot-prefixed segment) so its contents never
 * stage. The dash-name (not `.jolli/quarantine-symlinks/`) keeps it OUT
 * of `.jolli/` proper, which is itself re-allowed by §4 for the
 * aggregate whitelist — we don't want to depend on §4 negation
 * ordering for a security-critical exclusion.
 */
export const QUARANTINE_SYMLINKS_DIR = ".jolli-quarantine-symlinks";

/** Outcome of a sweep — counts populated so callers can log a single line. */
export interface SweepReport {
	/** Number of symlinks successfully moved into quarantine this round. */
	readonly quarantined: number;
	/** Number of symlinks the sweep tried but failed to move (logged warn). */
	readonly failed: number;
	/**
	 * Relative paths (from `memoryBankRoot`) of every symlink we acted on.
	 * Used by tests + diagnostics; production callers just want the counts.
	 */
	readonly paths: ReadonlyArray<string>;
}

/**
 * Walks `<memoryBankRoot>` recursively and quarantines every symbolic
 * link. Idempotent — already-quarantined entries in the quarantine
 * directory are skipped on subsequent rounds because that directory is
 * excluded from the walk.
 */
export async function sweepSymlinks(memoryBankRoot: string): Promise<SweepReport> {
	const found: string[] = [];
	await walk(memoryBankRoot, memoryBankRoot, found);

	if (found.length === 0) {
		return { quarantined: 0, failed: 0, paths: [] };
	}

	// Ensure the quarantine directory exists AND is a real directory
	// (not a hostile symlink someone pre-placed at this path). Done once
	// per sweep — all subsequent renames target this single verified path.
	const quarantineDir = join(memoryBankRoot, QUARANTINE_SYMLINKS_DIR);
	const quarantineOk = await ensureQuarantineDir(quarantineDir);
	// Belt-and-suspenders: write a per-clone exclude line so the
	// directory is invisible to `git add --all` regardless of whether
	// `MemoryBankBootstrap` has written `.gitignore` yet. Without this,
	// the very first round of an init-in-place vault stages the
	// quarantine dir before bootstrap runs. Failure is non-fatal —
	// bootstrap's `.gitignore` covers the same rule on subsequent rounds.
	await appendLocalExclude(memoryBankRoot, `${QUARANTINE_SYMLINKS_DIR}/`);
	if (!quarantineOk) {
		// We can't safely move anything. Report every found symlink as a
		// failure so the engine logs but doesn't crash. The next round
		// will retry once the quarantine path is unblocked.
		return { quarantined: 0, failed: found.length, paths: found };
	}

	let quarantined = 0;
	let failed = 0;
	const paths: string[] = [];
	// Process serially so a future tightening of `ensureQuarantineDir` can
	// rely on no concurrent mkdir/rename racing it. The cost is tiny (mkdir
	// + rename are O(ms)) and the simplicity is worth it.
	for (const rel of found) {
		const src = join(memoryBankRoot, rel);
		// Encode the original relative path in the filename so a user can
		// see where the link came from. Slashes / backslashes both get
		// replaced because tests + production cross platforms. The result
		// has no `/` or `\`, so it can't traverse out of `quarantineDir`.
		const safeName = rel.replace(/[\\/]/g, "-");
		const dst = join(quarantineDir, safeName);
		try {
			await rename(src, dst);
			quarantined += 1;
			paths.push(rel);
			log.warn(
				"Quarantined symlink: %s → %s (plan §P2 — never stage symlinks)",
				rel,
				relative(memoryBankRoot, dst),
			);
		} catch (e) {
			failed += 1;
			paths.push(rel);
			log.warn("Failed to quarantine symlink %s (non-fatal): %s", rel, (e as Error).message);
		}
	}
	return { quarantined, failed, paths };
}

/**
 * Prepares `<memoryBankRoot>/.jolli-quarantine-symlinks/` for use:
 *
 *   - If it exists as a real directory: leave it alone.
 *   - If it exists as a SYMLINK (hostile pre-placement): `unlink` it so
 *     the subsequent `mkdir` produces a real directory inside the vault.
 *     The path is engine-owned — there's no user data at this location
 *     to preserve, so deleting the hostile link is safe.
 *   - If it exists as a regular file or other non-directory: refuse and
 *     return false (caller skips the sweep this round). Refuse rather
 *     than auto-delete: a regular file here is unusual enough that we
 *     don't want to clobber user data we can't explain.
 *   - If it doesn't exist: `mkdir` (non-recursive, since the only
 *     ancestor is `<memoryBankRoot>` itself which the caller trusts).
 */
async function ensureQuarantineDir(quarantineDir: string): Promise<boolean> {
	let s: Awaited<ReturnType<typeof lstat>> | null = null;
	try {
		s = await lstat(quarantineDir);
	} catch {
		s = null; // doesn't exist
	}
	if (s !== null) {
		if (s.isSymbolicLink()) {
			log.warn("Quarantine path %s is a symlink — unlinking (engine-owned, no user data here)", quarantineDir);
			try {
				await unlink(quarantineDir);
			} catch (e) {
				/* v8 ignore start -- defensive: `unlink` on a path whose lstat just succeeded as a symbolic link only fails when permissions change between the lstat and the unlink (race) or the parent directory is read-only — neither reproducible in the test fixture */
				log.warn("Failed to unlink hostile quarantine symlink: %s", (e as Error).message);
				return false;
				/* v8 ignore stop */
			}
			// Fall through to mkdir.
		} else if (s.isDirectory()) {
			return true; // ready to use
		} else {
			log.warn(
				"Quarantine path %s exists but is neither directory nor symlink — refusing to sweep this round",
				quarantineDir,
			);
			return false;
		}
	}
	try {
		// Non-recursive: only `<memoryBankRoot>` is implicit, and the caller
		// (SyncEngine.runSteadyState) only invokes us after `fetchOrClone`
		// has guaranteed `<memoryBankRoot>/.git` exists, which proves the
		// vault root exists.
		await mkdir(quarantineDir);
		return true;
	} catch (e) {
		/* v8 ignore start -- mkdir on `<vault>/.jolli-quarantine-symlinks` only fails under fs corruption (parent missing — but the caller guarantees `<vault>/.git` exists) or disk full / read-only mount, none of which the test fixture can reproduce deterministically */
		log.warn("Failed to create quarantine dir %s: %s", quarantineDir, (e as Error).message);
		return false;
		/* v8 ignore stop */
	}
}

/**
 * Recursive walker. Pushes the RELATIVE path (from `memoryBankRoot`) of
 * every symlink it finds into `out`. Symbolic-link DIRECTORIES are
 * recorded and NOT descended into — the whole point is to not follow
 * symlinks anywhere.
 */
async function walk(rootDir: string, currentDir: string, out: string[]): Promise<void> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(currentDir, { withFileTypes: true });
	} catch (e) {
		// Permission / I/O error — log and stop descending here. We do
		// NOT throw because the caller wants a best-effort sweep.
		log.debug("readdir failed for %s (skipped): %s", currentDir, (e as Error).message);
		return;
	}
	for (const entry of entries) {
		const absPath = join(currentDir, entry.name);
		const relPath = relative(rootDir, absPath);
		if (shouldSkip(relPath)) continue;

		// `Dirent.isSymbolicLink()` already comes from an `lstat`-style
		// scan when withFileTypes is set, so we can avoid the extra
		// syscall. On filesystems that don't populate dirent types (some
		// network mounts), fall back to a real `lstat`.
		let isLink = entry.isSymbolicLink();
		/* v8 ignore start -- this fallback only fires on filesystems whose readdir withFileTypes leaves Dirent type accessors all returning false (some NFS/SMB mounts on niche kernels). Standard tmpfs / ext4 used by the test fixture populate the type bits, so this branch is unreachable from any platform we test on */
		if (!isLink && entry.isFile() === false && entry.isDirectory() === false) {
			try {
				const s = await lstat(absPath);
				isLink = s.isSymbolicLink();
			} catch {
				continue;
			}
		}
		/* v8 ignore stop */
		if (isLink) {
			out.push(relPath);
			continue; // never descend into a symlink dir
		}
		if (entry.isDirectory()) {
			await walk(rootDir, absPath, out);
		}
	}
}

/**
 * Paths the sweep deliberately does not enter. Anything under `.git/` is
 * git's own business (git stores e.g. `.git/HEAD` as a file, but git
 * worktree layouts can introduce symlinks under there); the quarantine
 * directory is skipped so we don't re-process our own output. The legacy
 * `.jolli/quarantine-symlinks` and `.jolli/quarantine-summaries` paths
 * are also skipped because older sweep revisions or `MemoryBankBootstrap`
 * still write there.
 *
 * The check compares each path segment so nested entries are correctly
 * routed (`<repo>/.git/objects/...`, `<repo>/.jolli/quarantine-summaries/leak.md`).
 */
function shouldSkip(relPath: string): boolean {
	if (relPath === "" || relPath === ".") return false;
	const segments = relPath.split(/[\\/]+/).filter((s) => s.length > 0);
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (seg === ".git") return true;
		if (seg === QUARANTINE_SYMLINKS_DIR) return true;
		if (seg === ".jolli" && i + 1 < segments.length) {
			const next = segments[i + 1];
			if (next === "quarantine-symlinks" || next === "quarantine-summaries") return true;
		}
	}
	return false;
}
