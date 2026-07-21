/**
 * ManualDisableFlag — "user explicitly disabled Jolli Memory in this repo."
 *
 * The flag is CLI-owned and repo-wide: it lives in
 * `<main-worktree-root>/.jolli/jollimemory/profile.json` (`manuallyDisabled`),
 * shared by every worktree and by `jolli enable` / `jolli disable`. This module
 * is a thin re-export of the canonical {@link RepoProfile} implementation so the
 * VS Code command and the CLI write the SAME intent. RepoProfile owns storage,
 * repo-wide anchoring (via `git rev-parse --git-common-dir`), and the one-time
 * migration from the old per-worktree `disabled-by-user` marker.
 *
 * Kept as a wrapper (rather than importing RepoProfile directly at each call
 * site) so existing Extension.ts imports and their test mocks stay unchanged.
 */

export { readManualDisableFlag, writeManualDisableFlag } from "../../../cli/src/core/RepoProfile.js";
