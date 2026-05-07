/**
 * ManualDisableFlag — file-backed opt-out marker for "user explicitly disabled
 * Jolli Memory in this project."
 *
 * Stored at `<projectDir>/.jolli/jollimemory/disabled-by-user` (already
 * gitignored via the project's `.jolli/` rule), making it project-scoped (per
 * worktree, follows the project directory) instead of bound to VS Code's
 * per-machine `workspaceState`. Sibling files in the same directory:
 * `git-op-queue/`, `notes/`, `debug.log` (see `cli/src/Logger.ts`).
 *
 * Marker semantics: the file's *existence* is the boolean. The body holds an
 * ISO timestamp purely for human debugging — readers don't parse it.
 */

import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getJolliMemoryDir } from "../../../cli/src/Logger.js";

const FILE_NAME = "disabled-by-user";

function flagPath(cwd: string): string {
	return join(getJolliMemoryDir(cwd), FILE_NAME);
}

/** Returns true iff the marker file exists in this project. */
export async function readManualDisableFlag(cwd: string): Promise<boolean> {
	try {
		await stat(flagPath(cwd));
		return true;
	} catch {
		return false;
	}
}

/**
 * Sets the marker. `disabled=true` writes the file (creating the directory if
 * needed); `disabled=false` removes it (no-op if already absent).
 */
export async function writeManualDisableFlag(
	cwd: string,
	disabled: boolean,
): Promise<void> {
	const path = flagPath(cwd);
	if (disabled) {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${new Date().toISOString()}\n`);
		return;
	}
	try {
		await unlink(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw err;
		}
	}
}
