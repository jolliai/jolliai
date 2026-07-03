/**
 * BackfillDismissFlag — repo-wide marker for "user dismissed the back-fill
 * cold-start card in this repository."
 *
 * Stored under the **shared git common dir** (`git rev-parse --git-common-dir`,
 * i.e. the one `.git` every worktree of a repo points at) at
 * `<git-common-dir>/jollimemory/backfill-card-dismissed`. This is deliberately
 * REPO-WIDE, not per-worktree: the cold-start decision itself is repo-wide
 * (`repoHasAnyMemory` reads the shared orphan branch), so dismissing the card in
 * one worktree must suppress it in every worktree of the same repo. It is also
 * inherently local + untracked (nothing under `.git` is committed).
 *
 * (Note: the sibling `disabled-by-user` marker (ManualDisableFlag) is still
 * per-worktree — a pre-existing storage choice with migration implications, left
 * as-is. The two markers mean different things: disable is a per-workspace
 * on/off switch; dismiss acknowledges a repo-wide backlog.)
 *
 * Marker semantics: the file's *existence* is the boolean. The card only ever
 * shows in cold start (repo has zero memories or a recent-month backlog), so
 * once a back-fill generates a memory the marker is cleared (either entry point,
 * via `runBackfillJob`). The body holds an ISO timestamp for human debugging.
 */

import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { execGit } from "../../../cli/src/core/GitOps.js";
import { getJolliMemoryDir } from "../../../cli/src/Logger.js";

const FILE_NAME = "backfill-card-dismissed";

/**
 * Directory holding the marker: `<git-common-dir>/jollimemory`. The common dir
 * is shared by all worktrees of a repo, so the marker is repo-wide. Falls back
 * to the per-project `.jolli/jollimemory/` only when the common dir can't be
 * resolved (not a git repo) — the card never shows there anyway, so it's inert.
 */
async function markerDir(cwd: string): Promise<string> {
	const res = await execGit(["rev-parse", "--git-common-dir"], cwd);
	const raw = res.exitCode === 0 ? res.stdout.trim() : "";
	if (raw) return join(isAbsolute(raw) ? raw : join(cwd, raw), "jollimemory");
	return getJolliMemoryDir(cwd);
}

/** Returns true iff the dismiss marker exists for this repo. */
export async function readBackfillDismissFlag(cwd: string): Promise<boolean> {
	try {
		await stat(join(await markerDir(cwd), FILE_NAME));
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
	const path = join(await markerDir(cwd), FILE_NAME);
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
