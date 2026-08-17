/**
 * ManualDisableFlag — "user explicitly disabled Jolli Memory in this repo."
 *
 * The flag is CLI-owned and repo-wide: it lives in
 * `<main-worktree-root>/.jolli/jollimemory/profile.json`, shared by every worktree
 * and by `jolli enable` / `jolli disable`. This module is a thin re-export of the
 * canonical {@link RepoProfile} implementation so the VS Code command and the CLI
 * write the SAME intent. RepoProfile owns storage, repo-wide anchoring (via
 * `git rev-parse --git-common-dir`), and the one-time migration from the old
 * per-worktree `disabled-by-user` marker.
 *
 * The field these read and write is `userDisabled`, NOT `manuallyDisabled`. The latter
 * is the DERIVED bit (`userDisabled OR cutoverFence present`) that only old runtimes
 * consume, recomputed on every write and never hand-written — deciding on it here would
 * let a cutover fence read as a user opt-out and stop this repo's SQLite writes too.
 * `RepoProfile` is the place that documents the three-field state; do not restate it.
 *
 * Kept as a wrapper (rather than importing RepoProfile directly at each call
 * site) so existing Extension.ts imports and their test mocks stay unchanged.
 */

export {
	readManualDisableFlag,
	readManualDisableFlagSync,
	writeManualDisableFlag,
} from "../../../cli/src/core/RepoProfile.js";
