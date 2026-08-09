/**
 * AtomicJsonFile — the one temp-then-rename writer for small JSON state files.
 *
 * Every file this is for has the same failure mode: it is read back with a
 * fail-open parser, so a torn or truncated write does not surface as an error,
 * it surfaces as "the file says nothing" — a dropped opt-out (`profile.json`)
 * or, worse, a registry whose next read-modify-write cements the loss
 * (`dashboard-repos.json`, the file the `repos` table is a projection of).
 * `writeFile` truncates and then writes, so a crash, a kill, or ENOSPC in that
 * window produces exactly that state.
 *
 * The temp name carries the PID so two writers that ever race WITHOUT the lock
 * cannot land in each other's partial file — the rename is what is atomic, not
 * the copy into the temp.
 */

import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Writes `contents` to `path` via a PID-scoped temp + rename. */
export async function writeFileAtomic(
	path: string,
	contents: string,
	opts: { readonly mode?: number } = {},
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmpPath = `${path}.${process.pid}.tmp`;
	// The mode goes on the temp: rename preserves it, and creating the temp
	// world-readable first would leak the very contents the mode is protecting.
	await writeFile(tmpPath, contents, opts.mode !== undefined ? { encoding: "utf-8", mode: opts.mode } : "utf-8");
	try {
		// Atomic on the same volume; replaces the target on Windows too.
		await rename(tmpPath, path);
	} catch (err) {
		await unlink(tmpPath).catch(() => {});
		throw err;
	}
}
