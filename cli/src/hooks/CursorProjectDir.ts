/**
 * Which workspace a Cursor hook is acting for — one decision, shared by every hook on
 * this host.
 *
 * ## Why this is its own module
 *
 * Two hooks need the answer and they need slightly different amounts of it: the
 * `sessionStart` bootstrap needs the directory, and the `stop` probe needs the
 * directory AND which channel supplied it (that is the question it exists to answer).
 * Spelling the candidate order twice is how the two drift — reorder the bootstrap's
 * list and the probe starts naming a channel that was never consulted. So
 * {@link pickCursorProjectDir} decides once and {@link resolveCursorProjectDir} is a
 * projection of it, the same way `PluginBundlePaths` was extracted so the MCP cwd guard
 * and this host's bootstrap could share one predicate instead of two copies.
 *
 * It is also a LEAF — `isPluginBundleCwd` is its only import — which is what lets a
 * hook test exercise the real screening instead of mocking it. Importing the bootstrap
 * for this would drag in `Installer`, `SkillInstaller` and the whole session-start
 * stack.
 *
 * ## `process.cwd()` is NOT a usable fallback here, and that is measured
 *
 * Cursor runs a plugin hook with the PLUGIN INSTALL DIRECTORY as its cwd — captured
 * live on Cursor 3.15.6, where a `sessionStart` probe reported
 * `pwd=~/.cursor/plugins/local/<plugin>` while `workspace_roots` named the real
 * workspace. (`_getHookCwd` in Cursor's bundle returns `file(installPath)` for every
 * plugin-sourced hook; only `stop` and `subagentStop` get `workspace.folders[0]`.) So
 * trusting cwd would hand a bootstrap the bundle it was launched from — and because a
 * marketplace served over git leaves its cache as a REAL checkout, `rev-parse
 * --show-toplevel` would succeed there and jolli would install git hooks into the
 * plugin cache repository. Same class of failure as a plugin-launched MCP server
 * answering for its own cache directory.
 *
 * Order, therefore:
 *   1. `workspace_roots[0]` — the documented common field, present on every event the
 *      bootstrap sees (verified in the capture above).
 *   2. `CURSOR_PROJECT_DIR` — documented as always present, and confirmed set to the
 *      workspace even while cwd was the bundle. Covers a build that drops the array.
 *   3. `cwd` — kept so a future Cursor that runs hooks in the workspace still works,
 *      and because `stop` is one of the two events Cursor's own bundle hands a real
 *      workspace cwd to. Screened like every other candidate.
 *
 * **Every candidate is screened, not just cwd.** The harm being prevented is installing
 * a repo's git hooks into a marketplace cache — which is itself a real checkout, so
 * `rev-parse` would happily accept it — and that harm is identical whichever channel
 * supplied the path. The screen is a pure string compare, so applying it uniformly
 * costs nothing and removes the need to trust each source separately. A screened-out
 * candidate falls through to the next one rather than aborting: a bundle-valued
 * `workspace_roots` should not suppress a perfectly good `CURSOR_PROJECT_DIR`.
 *
 * Answering `none` when all three are unusable is deliberate: no bootstrap is a safe
 * no-op, whereas bootstrapping the wrong directory is not.
 *
 * A multi-root workspace yields several roots; the first is taken and the rest ignored,
 * matching every other surface's "one repository per install" model.
 */

import { isPluginBundleCwd } from "../core/PluginBundlePaths.js";

/** Which channel supplied the directory. `"none"` means every candidate was unusable. */
export type CursorProjectDirChannel = "workspace_roots" | "CURSOR_PROJECT_DIR" | "cwd" | "none";

/** The common fields a Cursor hook payload may carry. Everything else is host detail. */
export interface CursorHookInput {
	readonly workspace_roots?: unknown;
}

export interface CursorProjectDirPick {
	/** The chosen directory, or null when nothing survived screening. */
	readonly dir: string | null;
	/** Which candidate won. `"none"` exactly when {@link dir} is null. */
	readonly channel: CursorProjectDirChannel;
}

/**
 * The one decision. See the module header for the order and why each candidate is
 * screened.
 *
 * `cwd` is a parameter rather than a `process.cwd()` call so a test can drive the
 * bundle-cwd case without changing the process's working directory — the caller in
 * production passes `process.cwd()`.
 */
export function pickCursorProjectDir(
	input: CursorHookInput,
	env: NodeJS.ProcessEnv,
	cwd: string,
): CursorProjectDirPick {
	const roots = input.workspace_roots;
	const fromRoots = Array.isArray(roots)
		? roots.find((root): root is string => typeof root === "string" && root.trim().length > 0)
		: undefined;
	const ordered: ReadonlyArray<[CursorProjectDirChannel, string | undefined]> = [
		["workspace_roots", fromRoots],
		// Note the empty STRING: Cursor's chat-first Agents Window sets this to "" rather
		// than leaving it unset, so a `??` here would pass "" through as a real answer.
		["CURSOR_PROJECT_DIR", env.CURSOR_PROJECT_DIR],
		["cwd", cwd],
	];
	for (const [channel, candidate] of ordered) {
		if (candidate === undefined || candidate.trim().length === 0) continue;
		if (isPluginBundleCwd(candidate)) continue;
		return { dir: candidate, channel };
	}
	return { dir: null, channel: "none" };
}

/**
 * The directory alone, for callers that do not care which channel supplied it.
 *
 * A projection of {@link pickCursorProjectDir}, never a second implementation of the
 * order — see the module header.
 */
export function resolveCursorProjectDir(
	input: CursorHookInput,
	env: NodeJS.ProcessEnv,
	cwd: string = process.cwd(),
): string | null {
	return pickCursorProjectDir(input, env, cwd).dir;
}
