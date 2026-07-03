/**
 * BackfillDismissFlag — file-backed marker for "user dismissed the back-fill
 * cold-start card in this project."
 *
 * Stored at `<projectDir>/.jolli/jollimemory/backfill-card-dismissed` (already
 * gitignored via the project's `.jolli/` rule), so it is project-scoped (per
 * worktree, follows the project directory) — the same convention as
 * {@link ManualDisableFlag}'s `disabled-by-user` sibling.
 *
 * Marker semantics: the file's *existence* is the boolean. The card only ever
 * shows in cold start (repo has zero memories), so once memories exist the card
 * is gone regardless of this marker. The marker is cleared when a back-fill
 * generates a memory (either entry point — the cold-start card or the Settings
 * button — via `runBackfillJob`). Note the caveat: if the repo instead fills up
 * through normal post-commit summaries (never a back-fill), the marker lingers,
 * so a later wipe-to-empty would NOT re-show the card until the marker is
 * cleared. That path is rare and benign (a dismissed user opted out anyway). The
 * body holds an ISO timestamp purely for human debugging — readers don't parse it.
 */

import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getJolliMemoryDir } from "../../../cli/src/Logger.js";

const FILE_NAME = "backfill-card-dismissed";

function flagPath(cwd: string): string {
	return join(getJolliMemoryDir(cwd), FILE_NAME);
}

/** Returns true iff the dismiss marker exists in this project. */
export async function readBackfillDismissFlag(cwd: string): Promise<boolean> {
	try {
		await stat(flagPath(cwd));
		return true;
	} catch {
		return false;
	}
}

/**
 * Sets the marker. `dismissed=true` writes the file (creating the directory if
 * needed); `dismissed=false` removes it (no-op if already absent).
 */
export async function writeBackfillDismissFlag(cwd: string, dismissed: boolean): Promise<void> {
	const path = flagPath(cwd);
	if (dismissed) {
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
