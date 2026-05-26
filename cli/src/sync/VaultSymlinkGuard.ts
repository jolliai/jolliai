/**
 * Symlink-safety guard for vault writes.
 *
 * The threat: a hostile (or accidental) symlink anywhere in the directory
 * chain from `vaultRoot` to a target path lets `mkdirSync(parent,
 * recursive)` / `writeFileSync(target.tmp, …)` / `renameSync(…, target)`
 * traverse the link and clobber a file OUTSIDE the vault. The most
 * dangerous form is **intermediate-segment** symlinks:
 *
 *     <vaultRoot>/<repoFolder>/.jolli/  →  /etc/         (symlink)
 *     mkdirSync('<vaultRoot>/<repoFolder>/.jolli/summaries', recursive)
 *       → follows the link, creates /etc/summaries/
 *     writeFileSync('<vaultRoot>/<repoFolder>/.jolli/summaries/abc.json.tmp', …)
 *       → writes /etc/summaries/abc.json.tmp
 *     renameSync(…, target)
 *       → produces /etc/summaries/abc.json
 *
 * Leaf-level `O_NOFOLLOW` (on the eventual `openSync` of `target.tmp`)
 * doesn't help with this — the parent chain has already been traversed.
 * `assertNoSymlinksInPath` covers the parent chain; the leaf-level
 * `O_NOFOLLOW` (added separately in the FolderStorage writes) is
 * complementary defence for the rare case where `target.tmp` itself is
 * a pre-placed symlink.
 *
 * Replaces the deleted `SymlinkSweep` quarantine pass. `SymlinkSweep`
 * scanned the whole tree and renamed every symlink it found; this guard
 * shifts the check to write time and refuses unsafe writes, which:
 *
 *   - Doesn't move user files (the UX complaint that retired
 *     `SymlinkSweep`).
 *   - Doesn't depend on a tree-walk pass before each round.
 *   - Surfaces the rogue link in a per-write warn log so the operator
 *     sees the exact path that needs attention.
 *
 * Together with `core.symlinks=false` (already enforced by `GitClient` per
 * `-c core.symlinks=false` on every invocation + `persistCoreSymlinks`
 * after clone/init — incoming hostile mode-120000 entries materialise as
 * plain text files, not real symlinks), the two layers cover both
 * directions of the symlink threat surface.
 */

import { closeSync, constants as fsConstants, lstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { createLogger } from "../Logger.js";

const log = createLogger("Sync:VaultSymlinkGuard");

/**
 * Walks the path chain from `vaultRoot` to `absTargetPath` (exclusive of
 * the final basename) and verifies every existing segment is a real
 * directory — NOT a symlink. ENOENT segments are tolerated (those will
 * be created by the caller's `mkdirSync(..., recursive: true)`).
 *
 * Throws an Error if:
 *
 *   - Any existing intermediate segment is a symbolic link. The error
 *     names the exact path so the operator can `unlink` it manually.
 *   - `absTargetPath` is not inside `vaultRoot` (path escape — caller
 *     bug, but defence-in-depth against a future caller that forgets
 *     to normalise).
 *
 * Returns normally (no throw) when the chain is clean. Caller proceeds
 * to mkdir / write.
 *
 * Async because `fs.promises.lstat` is the idiomatic Node API; sync
 * callers (atomicWrite is sync today) await this from an async wrapper.
 */
export async function assertNoSymlinksInPath(vaultRoot: string, absTargetPath: string): Promise<void> {
	if (!isAbsolute(absTargetPath)) {
		throw new Error(`assertNoSymlinksInPath: absTargetPath must be absolute, got ${absTargetPath}`);
	}
	if (!isAbsolute(vaultRoot)) {
		throw new Error(`assertNoSymlinksInPath: vaultRoot must be absolute, got ${vaultRoot}`);
	}

	const rel = relative(vaultRoot, absTargetPath);
	// `relative` returns `..` (or `..\sub`, etc.) when the target is OUTSIDE
	// the vault — that's the path-escape signature. Also reject the exact
	// boundary case where `relative` returns "" (target IS the vault root,
	// which would only happen if a caller asked us to verify the chain to
	// the vault itself — meaningless and almost certainly a bug).
	if (rel === "" || rel.startsWith("..")) {
		throw new Error(`assertNoSymlinksInPath: target ${absTargetPath} is not inside vault ${vaultRoot}`);
	}

	// Walk down the path one segment at a time, lstating each intermediate
	// directory. The FINAL segment (the file we're about to write) is
	// excluded — the caller's `O_NOFOLLOW` handles that one.
	const segments = rel.split(sep);
	let cur = vaultRoot;
	for (let i = 0; i < segments.length - 1; i++) {
		const seg = segments[i];
		if (seg === undefined || seg.length === 0) continue;
		cur = `${cur}${sep}${seg}`;
		let stat: Awaited<ReturnType<typeof lstat>>;
		try {
			stat = await lstat(cur);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				// Segment doesn't exist yet — fine, mkdir will create it
				// fresh (not following any link, because nothing's there).
				// Skip the rest of the chain since deeper segments are
				// guaranteed to not exist either.
				return;
			}
			// Permission denied / other I/O error — surface so the caller
			// doesn't write into an unverified path.
			throw e;
		}
		if (stat.isSymbolicLink()) {
			log.warn("Refusing vault write — symlink in path chain: %s", cur);
			throw new Error(
				`Refused vault write: path segment is a symlink at ${cur} (target ${absTargetPath}). Inspect and unlink before retrying.`,
			);
		}
		if (!stat.isDirectory()) {
			// A regular file or socket where we expect a directory ahead
			// of the target. Treat as a hard refuse — `mkdirSync` would
			// fail anyway, but the error from this helper is clearer.
			throw new Error(
				`Refused vault write: path segment is not a directory at ${cur} (target ${absTargetPath}).`,
			);
		}
	}
}

/**
 * Synchronous twin of `assertNoSymlinksInPath`. Same contract, same error
 * messages — used by `FolderStorage.atomicWrite` and `markDirty` which are
 * sync APIs today and not worth refactoring to async just for the guard.
 */
export function assertNoSymlinksInPathSync(vaultRoot: string, absTargetPath: string): void {
	if (!isAbsolute(absTargetPath)) {
		throw new Error(`assertNoSymlinksInPathSync: absTargetPath must be absolute, got ${absTargetPath}`);
	}
	if (!isAbsolute(vaultRoot)) {
		throw new Error(`assertNoSymlinksInPathSync: vaultRoot must be absolute, got ${vaultRoot}`);
	}

	const rel = relative(vaultRoot, absTargetPath);
	if (rel === "" || rel.startsWith("..")) {
		throw new Error(`assertNoSymlinksInPathSync: target ${absTargetPath} is not inside vault ${vaultRoot}`);
	}

	const segments = rel.split(sep);
	let cur = vaultRoot;
	for (let i = 0; i < segments.length - 1; i++) {
		const seg = segments[i];
		if (seg === undefined || seg.length === 0) continue;
		cur = `${cur}${sep}${seg}`;
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(cur);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			throw e;
		}
		if (stat.isSymbolicLink()) {
			log.warn("Refusing vault write — symlink in path chain: %s", cur);
			throw new Error(
				`Refused vault write: path segment is a symlink at ${cur} (target ${absTargetPath}). Inspect and unlink before retrying.`,
			);
		}
		if (!stat.isDirectory()) {
			throw new Error(
				`Refused vault write: path segment is not a directory at ${cur} (target ${absTargetPath}).`,
			);
		}
	}
}

/**
 * Drop-in replacement for the legacy `atomicWrite` pattern (`mkdirSync` +
 * `writeFileSync(tmp)` + `renameSync`) that also:
 *
 *   - Verifies no intermediate path segment under `vaultRoot` is a
 *     symlink (`assertNoSymlinksInPathSync`).
 *   - Opens the `<target>.tmp` write with `O_NOFOLLOW` so a pre-placed
 *     symlink at the leaf can't be followed either. On platforms where
 *     `O_NOFOLLOW` is unavailable (Windows: `fs.constants.O_NOFOLLOW`
 *     is `0`), the flag is a no-op and only the path-chain check applies.
 *     That's acceptable because Windows doesn't have the same
 *     symlink-traversal exploit surface in practice.
 *
 * Used by `FolderStorage.atomicWrite` and `MemoryBankBootstrap`'s
 * `.gitignore` / sentinel writes. Callers that need async semantics use
 * the underlying `assertNoSymlinksInPath` (promise-flavored) directly.
 */
export function safeAtomicWriteSync(vaultRoot: string, targetPath: string, content: string | Buffer): void {
	assertNoSymlinksInPathSync(vaultRoot, targetPath);
	mkdirSync(dirname(targetPath), { recursive: true });
	const tmp = `${targetPath}.tmp`;
	// O_NOFOLLOW on the leaf — defence in depth against a pre-placed
	// `<target>.tmp` symlink. `0o644` matches the prior writeFileSync
	// behavior (Node's default mode for missing files).
	const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
	const fd = openSync(tmp, flags, 0o644);
	try {
		if (typeof content === "string") {
			// `writeSync(fd, string)` is its own overload — encoded as utf-8
			// to match the pre-refactor `writeFileSync(path, content, "utf-8")`
			// default.
			writeSync(fd, content, undefined, "utf-8");
		} else {
			writeSync(fd, content);
		}
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, targetPath);
}
