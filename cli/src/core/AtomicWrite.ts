/**
 * Atomic file write shared across the local-state stores (SessionTracker,
 * IngestRunStore, IngestTrigger, …). Previously each kept its own private copy,
 * so the Windows fallback below had to be patched in three places and the
 * coverage-ignore pragmas drifted apart. One implementation now.
 */

import { randomUUID } from "node:crypto";
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
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
	const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(tmpPath, content, "utf-8");
	try {
		await rename(tmpPath, filePath);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES") {
			await writeFile(filePath, content, "utf-8");
			await rm(tmpPath, { force: true });
		} else {
			throw error;
		}
	}
}
