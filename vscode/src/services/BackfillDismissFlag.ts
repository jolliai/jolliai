/**
 * BackfillDismissFlag — repo-wide "user dismissed the back-fill cold-start card".
 *
 * Thin forwarder over the shared {@link RepoProfile} (`profile.json`), which is the
 * single source of truth used by BOTH surfaces (this VS Code card and the CLI
 * guided front door). The dismiss state moved out of the `.git` common dir and into
 * `<main-worktree-root>/.jolli/jollimemory/profile.json`; RepoProfile keeps the
 * repo-wide (not per-worktree) semantics and transparently migrates the old
 * `<git-common-dir>/jollimemory/backfill-card-dismissed` marker.
 *
 * Semantics change (aligned with the CLI front door's three-way prompt): dismiss is
 * now STICKY — it is an explicit, permanent opt-out and is never auto-cleared after
 * a generation. The former "clear the marker once a back-fill produced a memory"
 * behavior has been removed at the call site.
 *
 * These wrappers are kept (rather than inlining RepoProfile) so the existing
 * Extension.ts call sites and their tests stay unchanged.
 */

import { readRepoProfile, updateRepoProfile } from "../../../cli/src/core/RepoProfile.js";

/** Returns true iff the user has dismissed the cold-start card for this repo. */
export async function readBackfillDismissFlag(cwd: string): Promise<boolean> {
	return (await readRepoProfile(cwd)).backfillDismissed === true;
}

/** Sets (`true`) or clears (`false`) the repo-wide dismiss flag. */
export async function writeBackfillDismissFlag(cwd: string, dismissed: boolean): Promise<void> {
	await updateRepoProfile(cwd, { backfillDismissed: dismissed });
}
