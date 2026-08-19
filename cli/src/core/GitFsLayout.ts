/**
 * GitFsLayout — the handful of git facts a latency-critical path needs, read
 * straight off the filesystem instead of through `git`.
 *
 * ## Why this exists
 *
 * A `git rev-parse` costs ~10-15 ms, and that is almost entirely process
 * creation, not git. The SessionStart hook is the surface where that bill is
 * visible to a human: Claude Code blocks on it before showing a prompt, and the
 * hook used to spend ~90% of its in-process time in six to eight sequential
 * `git` spawns — three of which were the SAME `rev-parse --git-common-dir`,
 * because {@link file://./Locks.ts}, {@link file://./RepoProfile.ts} and
 * {@link file://./GitOps.ts} each memoized it privately. Worse, on macOS every
 * additional spawn also inflates the NEXT process launch (measured: ~210 ms of
 * pre-runtime time on the process that follows a hook run), so the spawns cost
 * more than the sum of their own durations.
 *
 * Three facts cover that hot path — the worktree root, the current branch, and
 * HEAD's hash — and all three are plain files with a documented layout. Reading
 * them is ~0.1 ms.
 *
 * ## What this is NOT
 *
 * It is not a git implementation and must never grow into one. Every function
 * here answers `null` rather than guessing, and every caller MUST keep its
 * existing `git`-backed path as the fallback. The layouts below are the ones
 * git guarantees; anything else (bare repos, `.git` pointing somewhere
 * unexpected, a ref format we do not recognise) is deliberately a `null`.
 *
 * "Deliberately null" includes a `.git` that exists but is not a repository —
 * see {@link isRepositoryGitDir}. The point of this module is to answer the same
 * question `git` would, and a caller that reads a non-null layout as "this is a
 * repo" is entitled to that; a shape check alone would not earn it.
 *
 * ## The one env-var rule
 *
 * When git exports `GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR` — which it
 * does for every hook process, and which a detached child then inherits — the
 * repository a `git` command resolves is NOT the one containing `cwd`. Since the
 * whole point of this module is to agree with the `git` call it replaces, it
 * refuses to answer at all when any of them is set, and the caller falls back to
 * the subprocess that honours them. See `GIT_LOCATION_ENV_VARS` in
 * {@link file://./GitOps.ts} for the same hazard from the other direction.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { normalizePathForCompare } from "./PathUtils.js";

/** Resolved absolute paths for one worktree. */
export interface GitFsLayout {
	/** The directory that holds `.git` — the CURRENT worktree, not the main one. */
	readonly worktreeRoot: string;
	/** This worktree's own git directory (holds `HEAD`, and for a linked worktree only that). */
	readonly gitDir: string;
	/** The shared git directory (holds `refs/`, `packed-refs`); equal to `gitDir` in a plain repo. */
	readonly commonDir: string;
}

/**
 * Env vars that redirect where `git` looks. Their presence means a subprocess
 * would answer for a different repository than a filesystem walk from `cwd`
 * would, so this module declines. See the module docstring.
 */
const GIT_LOCATION_ENV_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"] as const;

/** True when the ambient environment redirects git away from `cwd`'s repository. */
function gitLocationIsOverridden(env: NodeJS.ProcessEnv): boolean {
	return GIT_LOCATION_ENV_VARS.some((name) => (env[name] ?? "") !== "");
}

/**
 * An env carrying none of the location vars, for the one question that must be
 * answered about `cwd` itself rather than about whatever git was pointed at. Used
 * by {@link readRepositoryKey}; see its docstring for why that is correct there
 * and nowhere else so far.
 */
const LOCATION_FREE_ENV: NodeJS.ProcessEnv = {};

function readTextOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

/** `realpathSync`, degrading to a plain resolve for a path that does not exist. */
function realpathOrResolve(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** A HEAD that points at a ref, which is the only symref target git accepts there. */
const HEAD_SYMREF = /^ref:\s*refs\//;

/**
 * Whether `gitDir` + `commonDir` are a repository GIT would accept, mirroring
 * its own `is_git_directory()`: a HEAD shaped like a symref or an object id,
 * plus `objects/` and `refs/`.
 *
 * A `.git` DIRECTORY is not on its own proof of a repository — an interrupted
 * clone, a half-synced tree and a partly-deleted `.git` all leave the shape
 * behind while `git rev-parse --git-dir` exits 128. Measured for every
 * combination: HEAD alone, HEAD+refs, HEAD+objects, refs+objects and a garbage
 * HEAD are all refused, all three together are accepted, and a symref to an
 * unborn branch (a repo between `git init` and its first commit) is accepted —
 * so this must not require the branch ref to exist. `GitFsLayout.realgit.test.ts`
 * pins the claim against git itself.
 *
 * The two directories are looked for in the COMMON dir, not `gitDir`: a linked
 * worktree's own git dir holds HEAD, `commondir`, `gitdir`, `index` and `logs`
 * and has no `objects` at all, so checking there would decline every worktree.
 * HEAD, conversely, is per-worktree and only `gitDir` has the right one.
 */
function isRepositoryGitDir(gitDir: string, commonDir: string): boolean {
	const head = readTextOrNull(join(gitDir, "HEAD"))?.trim();
	if (!head || !(OBJECT_ID.test(head) || HEAD_SYMREF.test(head))) return false;
	return isDirectory(join(commonDir, "objects")) && isDirectory(join(commonDir, "refs"));
}

/**
 * Resolves the git directory a `.git` FILE points at.
 *
 * The file's payload is `gitdir: <path>`, and the path is relative to the
 * worktree when git wrote it with a relative pointer (`git worktree add` does,
 * and so does `git submodule`). Returns null on any shape we do not recognise.
 */
function resolveGitDirPointer(worktreeRoot: string, contents: string, realpath: boolean): string | null {
	const match = /^gitdir:\s*(.+)$/m.exec(contents);
	if (!match) return null;
	const target = match[1].trim();
	if (!target) return null;
	const gitDir = isAbsolute(target) ? target : resolve(worktreeRoot, target);
	if (!isDirectory(gitDir)) return null;
	return realpath ? realpathOrResolve(gitDir) : gitDir;
}

/**
 * The shared git directory for `gitDir`.
 *
 * A linked worktree's git dir carries a `commondir` file holding a path (usually
 * the relative `../..`) to the main repository's `.git`. A plain repo and a
 * submodule have no such file, and for both the git dir IS the common dir.
 */
function resolveCommonDir(gitDir: string, realpath: boolean): string {
	const raw = readTextOrNull(join(gitDir, "commondir"))?.trim();
	if (!raw) return gitDir;
	const commonDir = isAbsolute(raw) ? raw : resolve(gitDir, raw);
	return realpath ? realpathOrResolve(commonDir) : commonDir;
}

/** Options for {@link resolveGitFsLayout}. */
export interface GitFsLayoutOptions {
	/** Environment consulted for the git location vars. Defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/**
	 * Whether to resolve symlinks, which decides WHICH git command this matches.
	 *
	 * `git rev-parse --show-toplevel` reports the real path, so a caller replacing
	 * it must pass `true`. `--git-common-dir`, by contrast, is normally consumed as
	 * `resolve(cwd, output)` — it prints a bare `.git` at the repo root — so a
	 * caller replacing THAT must pass `false` (the default) or it will hand back a
	 * different absolute path than the subprocess did whenever the caller's cwd
	 * reaches the repo through a symlink (`/tmp` and `/var` on macOS).
	 *
	 * That distinction is load-bearing, not pedantry: the paths derived from
	 * `--git-common-dir` include `profile.json` (which holds the user's disable
	 * opt-out) and the shared lock directory. Silently relocating either would
	 * re-enable a repo the user disabled, or split one lock into two.
	 */
	readonly realpath?: boolean;
}

/**
 * Walks up from `startDir` looking for a worktree, or null when there is none
 * (or when the environment redirects git — see the module docstring).
 *
 * Mirrors what `git rev-parse --show-toplevel` + `--git-common-dir` would answer
 * for the two layouts git actually produces: `.git` as a directory (plain repo)
 * and `.git` as a pointer file (linked worktree, submodule). See
 * {@link GitFsLayoutOptions.realpath} for which of the two you are matching.
 */
export function resolveGitFsLayout(startDir: string, options: GitFsLayoutOptions = {}): GitFsLayout | null {
	const { env = process.env, realpath = false } = options;
	if (gitLocationIsOverridden(env)) return null;
	let dir = realpath ? realpathOrResolve(startDir) : resolve(startDir);
	for (;;) {
		const dotGit = join(dir, ".git");
		if (isDirectory(dotGit)) {
			const commonDir = resolveCommonDir(dotGit, realpath);
			// A `.git` git would not accept is answered null rather than walked past.
			// Git itself keeps searching upward there, and matching that would mean
			// resolving a broken repository to whatever ENCLOSES it — an answer this
			// module has no way to sanity-check. Declining hands the case to the
			// subprocess, which resolves it correctly either way.
			return isRepositoryGitDir(dotGit, commonDir) ? { worktreeRoot: dir, gitDir: dotGit, commonDir } : null;
		}
		const pointer = readTextOrNull(dotGit);
		if (pointer !== null) {
			const gitDir = resolveGitDirPointer(dir, pointer, realpath);
			// A `.git` file we cannot follow is a repository we do not understand,
			// not a reason to keep walking into the parent directory — that would
			// silently answer for an ENCLOSING repo (the super-project of a
			// submodule, say) instead of this one.
			if (gitDir === null) return null;
			const commonDir = resolveCommonDir(gitDir, realpath);
			return isRepositoryGitDir(gitDir, commonDir) ? { worktreeRoot: dir, gitDir, commonDir } : null;
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * A key identifying the REPOSITORY `dir` belongs to, or null when that cannot be
 * read off the filesystem.
 *
 * The key is the shared git directory, which every worktree of one repository
 * reports identically — so two directories belong to the same repository exactly
 * when their keys are equal. That is the question a path comparison can only
 * approximate, and it approximates it wrong in both directions: a linked worktree
 * normally lives OUTSIDE the main worktree (so containment says no when the answer
 * is yes), while a nested clone or submodule lives INSIDE it (so containment says
 * yes when the answer is no).
 *
 * `realpath: true` is load-bearing, and it is the OPPOSITE of what
 * {@link file://./RepoProfile.ts} passes. That module anchors `profile.json` and
 * needs a path that never moves, so resolving symlinks there would relocate a
 * user's opt-out. This function only ever compares two keys, so leaving symlinks
 * unresolved is what would break it: on macOS `/tmp` and `/private/tmp` are one
 * directory, and two spellings of one repository would compare as different —
 * silently, since "different repositories" is also a valid answer.
 *
 * Null means "ask something else", NEVER "different repositories". The layout
 * reader declines for a `.git` git itself would refuse and for a directory that
 * no longer exists — so every caller keeps its own fallback. See the module
 * docstring.
 *
 * ## Why this passes an EMPTY env, which the module otherwise refuses to do
 *
 * `resolveGitFsLayout` declines outright when `GIT_DIR` / `GIT_WORK_TREE` /
 * `GIT_COMMON_DIR` are set, because its contract is to agree with the `git`
 * command it replaces — and those vars make `git` answer for the repository they
 * name instead of the one containing `cwd`. That contract is right for its other
 * callers and WRONG for this question. Here the whole point is which repository
 * CONTAINS `dir`, so the ambient vars are noise to be ignored, not honoured:
 * `GitOps.resolveContainingRepoCommonDir` reaches the same conclusion from the
 * subprocess side and deletes them before spawning, for the measured reason that
 * a sibling repo otherwise resolves to the current repo's `.git`.
 *
 * Skipping the guard is what makes this work where it matters most. git exports
 * those vars to every hook, and a detached child inherits them — so the
 * QueueWorker and the global daemon both run with `GIT_DIR` set. Honouring the
 * guard there would return null on exactly those paths and leave every caller on
 * its fallback, i.e. fix nothing in the processes that do the collecting.
 *
 * A side effect worth having: the answer no longer depends on `process.env` at
 * all, so it is the same in a hook, in a terminal and under test.
 */
export function readRepositoryKey(dir: string): string | null {
	// A path THIS platform does not read as absolute is refused outright, and that is
	// not defensive tidiness: `resolveGitFsLayout` starts with `resolve(dir)`, which
	// anchors a relative-looking path to the process cwd and then walks UP from
	// there — so it would answer confidently about whichever repository the current
	// process happens to be running in, for a directory that was never named. The
	// real input for this is a foreign-platform absolute path: `E:\project` recorded
	// by a session under WSL or synced from another machine is not absolute on POSIX,
	// and two such paths differing only in drive-letter case would both resolve into
	// the running repository and compare EQUAL. Null hands them to the caller's
	// fallback, where a plain path comparison gets them right.
	if (!dir || !isAbsolute(dir)) return null;
	const commonDir = resolveGitFsLayout(dir, { realpath: true, env: LOCATION_FREE_ENV })?.commonDir;
	return commonDir ? normalizePathForCompare(commonDir) : null;
}

/**
 * The checked-out branch name, or null on a detached HEAD (and on any HEAD
 * shape we do not recognise).
 *
 * Matches `git branch --show-current`, which likewise prints nothing when HEAD
 * is detached. The `refs/heads/` prefix is stripped, so a namespaced branch
 * comes back in the same form git prints (`feature/foo`).
 */
export function readBranchFromFs(layout: GitFsLayout): string | null {
	const head = readTextOrNull(join(layout.gitDir, "HEAD"))?.trim();
	if (!head) return null;
	const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
	return match ? match[1].trim() || null : null;
}

/**
 * A ref name we are willing to turn into a filesystem path.
 *
 * `HEAD`'s payload is joined onto the git dir, so an unconstrained value would
 * be a path traversal (`ref: ../../../etc/passwd`). Git itself rejects such a
 * name, so refusing it here costs nothing and keeps a corrupt or hand-edited
 * HEAD from reaching outside the repository. `..` is excluded by the character
 * class not admitting a bare `.` segment — spelled explicitly for the reader.
 */
const SAFE_REF_NAME = /^refs\/[A-Za-z0-9._\-/]+$/;

function isSafeRefName(refName: string): boolean {
	return SAFE_REF_NAME.test(refName) && !refName.split("/").includes("..");
}

/** Looks a ref up in `<dir>/packed-refs`, or null when absent. */
function readPackedRef(dir: string, refName: string): string | null {
	const packed = readTextOrNull(join(dir, "packed-refs"));
	if (packed === null) return null;
	for (const line of packed.split("\n")) {
		// `^<hash>` continuation lines annotate the PRECEDING tag with its
		// dereferenced commit; they carry no ref name and must not be parsed as one.
		if (!line || line.startsWith("#") || line.startsWith("^")) continue;
		const sep = line.indexOf(" ");
		if (sep <= 0) continue;
		if (line.slice(sep + 1).trim() === refName) {
			const hash = line.slice(0, sep).trim();
			return OBJECT_ID.test(hash) ? hash : null;
		}
	}
	return null;
}

/**
 * The commit hash HEAD resolves to, or null when it cannot be read without git.
 *
 * Matches `git rev-parse HEAD` for the cases that matter to a hook: a detached
 * HEAD (the hash is in the file), a loose ref, and a packed ref. A symref
 * pointing outside `refs/heads/`, a ref that is itself a symref, and a
 * `refs/` replacement are all answered null rather than guessed at.
 *
 * Loose refs are looked up in the worktree's own git dir FIRST and then in the
 * common dir: per-worktree refs (`HEAD`, `bisect`, …) live in the former while
 * branches live in the latter, and only checking one of the two would miss half
 * the layouts.
 */
export function readHeadHashFromFs(layout: GitFsLayout): string | null {
	const head = readTextOrNull(join(layout.gitDir, "HEAD"))?.trim();
	if (!head) return null;
	if (OBJECT_ID.test(head)) return head;
	const match = /^ref:\s*(.+)$/.exec(head);
	if (!match) return null;
	const refName = match[1].trim();
	if (!isSafeRefName(refName)) return null;
	for (const dir of layout.gitDir === layout.commonDir ? [layout.gitDir] : [layout.gitDir, layout.commonDir]) {
		const loose = readTextOrNull(join(dir, refName))?.trim();
		if (loose && OBJECT_ID.test(loose)) return loose;
		const packedHash = readPackedRef(dir, refName);
		if (packedHash) return packedHash;
	}
	return null;
}
