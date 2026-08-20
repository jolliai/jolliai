/**
 * Atomic file write shared across the local-state stores (SessionTracker,
 * IngestRunStore, IngestTrigger, …). Previously each kept its own private copy,
 * so the Windows fallback below had to be patched in three places and the
 * coverage-ignore pragmas drifted apart. One implementation now.
 */

import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";

/**
 * Writes `content` to `filePath` atomically via a sibling tmpfile + rename.
 *
 * On Windows, rename() can fail with EPERM/EACCES when the target is held open
 * by another process (antivirus, file watchers, etc.). In that case it falls
 * back to a direct overwrite and removes the tmpfile. Any other error rethrows.
 *
 * The tmpfile name is per-call unique (`pid` + random) so two concurrent writers
 * of the same target — e.g. the post-commit worker and the VS Code 60s tick over
 * one worktree's telemetry buffer — never share a tmpfile and tear each other's
 * partial write before the rename.
 *
 * `mode` is for targets whose permissions matter. It is applied to the TMPFILE,
 * which the rename then carries onto the target — so unlike a bare
 * `writeFile(..., { mode })`, it takes effect even when the target already exists.
 * That is the opposite default from `writeFile`, so a caller that wants to preserve
 * an existing file's permissions must read them and pass them back in; see
 * `CodexTomlWriter`, which does exactly that because the file belongs to another
 * tool. Omit `mode` to keep node's default (umask-derived on creation, unchanged on
 * overwrite) — every pre-existing caller does.
 */
export async function atomicWriteFile(filePath: string, content: string, mode?: number): Promise<void> {
	const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(tmpPath, content, mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
	try {
		await rename(tmpPath, filePath);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES") {
			// Windows fallback: a direct overwrite cannot carry `mode` onto an existing
			// target (node ignores it there), which is acceptable — this branch exists
			// because the target is held open by another process, and the permissions it
			// already has are the ones its owner chose.
			await writeFile(filePath, content, mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
			await rm(tmpPath, { force: true });
		} else {
			throw error;
		}
	}
}

/**
 * Synchronous sibling of {@link atomicWriteFile}, for the sync-only state writers
 * (e.g. the session-statistics channel's cursor file, written from hook and
 * daemon paths that are not async). Same tmpfile + rename guarantee and the same
 * Windows EPERM/EACCES fallback — a torn/partial write can never be observed even
 * though this channel deliberately holds no lock and lets writers overlap, so the
 * only residual is a last-writer-wins on the whole file, never a corrupt one.
 */
export function atomicWriteFileSync(filePath: string, content: string, mode?: number): void {
	const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tmpPath, content, mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
	try {
		renameSync(tmpPath, filePath);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES") {
			// Windows fallback (mirrors {@link atomicWriteFile}): a direct overwrite cannot
			// carry `mode` onto an existing target (node ignores it there), which is
			// acceptable — this branch exists because the target is held open by another
			// process, and the permissions it already has are the ones its owner chose.
			writeFileSync(filePath, content, mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
			rmSync(tmpPath, { force: true });
		} else {
			throw error;
		}
	}
}
