/**
 * Git Operations Module
 *
 * Wraps git commands using child_process.execFile.
 * Includes orphan branch operations using git plumbing commands
 * (hash-object, mktree, commit-tree, update-ref) to avoid checkout.
 *
 * Pattern adapted from: tools/jolliagent/src/tools/tools/git_shared.ts
 */

import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createLogger, errMsg } from "../Logger.js";
import type { CommitInfo, DiffStats, FileWrite, GitCommandResult } from "../Types.js";
import { execFileAsyncHidden, execFileSyncHidden, spawnHidden } from "../util/Subprocess.js";
import { resolveGitFsLayout } from "./GitFsLayout.js";
import { normalizePathForCompare, toForwardSlash } from "./PathUtils.js";

const MAX_GIT_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB
/** NUL byte — used as entry separator in `git ls-tree -z` output. */
const NUL = "\x00";

const log = createLogger("GitOps");

/**
 * Memoized git-worktree-root cache, keyed by the candidate directory. A `null`
 * value is a real cached result — "this directory is not inside any git
 * worktree" — distinct from `undefined` ("not resolved yet").
 */
const _stateRootCache = new Map<string, string | null>();

/** Test-only: clears the memo so cases don't leak resolved roots into each other. */
export function resetStateRootCache(): void {
	_stateRootCache.clear();
}

/**
 * The location env vars git exports to hook processes so every child `git`
 * invocation targets the CURRENT repo. A detached process spawned from a hook
 * (e.g. the queue worker) inherits them, and a child `git` that forwards
 * `process.env` would then answer for the ambient (hook) repo for EVERY path
 * regardless of its cwd — so they must be stripped whenever we ask which repo
 * SOME OTHER directory belongs to. Measured on git 2.50.1 in a linked worktree:
 * with `GIT_DIR` inherited, `git -C <dir> rev-parse --show-toplevel` resolves
 * `<dir>` to itself (even a non-repo dir), instead of to its real worktree root.
 */
const GIT_LOCATION_ENV_VARS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_PREFIX",
	"GIT_OBJECT_DIRECTORY",
	"GIT_NAMESPACE",
] as const;

/**
 * A copy of the process environment with the git-location vars above removed, so
 * a `git` child spawned from inside a hook discovers the repo from its `cwd`
 * rather than from the inherited redirect. Shared by every resolver that asks
 * "which repo contains this directory".
 */
function gitEnvWithoutLocationVars(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
	for (const v of GIT_LOCATION_ENV_VARS) delete env[v];
	return env;
}

/**
 * Anchors a project working directory to its git worktree root via
 * `git rev-parse --show-toplevel`, memoized per input. Falls back to `cwd` on
 * any failure (not a git repo, git missing).
 *
 * ONLY for project-cwd entry points whose cwd is implicit and may be a
 * subdirectory — AI session hooks (payload cwd), CLI telemetry, the MCP server
 * (`process.cwd()`). Without this, a session started from a subdirectory forks a
 * second, independent `.jolli/` store there and its memory silently never joins
 * the main one. NEVER call this on an explicit Memory Bank root (`kbRoot`): that
 * path is already the exact target and must be used verbatim (see
 * SearchIndex.resolveIndexDir / MultiRepoCompile), and rooting it would collapse
 * multiple Memory Bank entries into an enclosing repo's `.jolli/`.
 *
 * `--show-toplevel` returns the *current worktree* root, so a `.claude/worktrees/*`
 * checkout still resolves to its own root (no regression).
 *
 * Silent by design: successfully anchoring a subdir to its root is the correct
 * path, and this runs (memoized) once per hook process, so a user-visible
 * warning would repeat every process and pollute stderr (warn is never
 * suppressed). Surfacing pre-existing stray stores to the user is a separate,
 * marker-gated concern, not this function's job.
 */
export function resolveStateRoot(cwd: string): string {
	// A directory outside any git worktree still needs *some* project dir, so
	// echo the input back — see this function's contract above.
	return resolveWorktreeRootOrNull(cwd) ?? cwd;
}

/**
 * Like {@link resolveStateRoot}, but returns `null` for a directory that is not
 * inside any git worktree instead of echoing the input path back.
 *
 * `resolveStateRoot` falls back to `cwd` so its caller always has a usable
 * project dir; a caller that only wants a REAL worktree root — the Claude
 * ownership ledger, whose keys must be roots a future commit can actually look
 * up, never a scratch directory a session merely `cd`-ed through — needs the
 * failure distinguishable from success, which the echoed cwd silently hides.
 * Shares {@link resolveStateRoot}'s memo, so the two never disagree on a path.
 */
export function resolveWorktreeRootOrNull(cwd: string): string | null {
	const cached = _stateRootCache.get(cwd);
	if (cached !== undefined) return cached;
	// Filesystem first: this is the SessionStart hook's very first call, where a
	// `rev-parse` is ~10 ms of pure process creation before any work begins.
	//
	// Two conversions are what make the fast path answer the SAME string as
	// `--show-toplevel`, and this value anchors `.jolli/`, so the two spellings
	// must never disagree or a repo grows a second state directory: `realpath:
	// true` resolves symlinks (git reports the real path), and `toForwardSlash`
	// matches git's separator — `/` on every platform, where a filesystem walk
	// yields `\` on Windows. `node:fs` accepts either spelling, so the second one
	// would be invisible at runtime and show up only as a split state directory.
	const fromFs = resolveGitFsLayout(cwd, { realpath: true })?.worktreeRoot;
	if (fromFs) {
		const fsRoot = toForwardSlash(fromFs);
		_stateRootCache.set(cwd, fsRoot);
		return fsRoot;
	}
	let root: string | null = null;
	try {
		const out = execFileSyncHidden("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf-8",
			// Strip the git-location redirect a hook exports, or in a LINKED worktree
			// the inherited GIT_DIR makes `rev-parse` resolve `cwd` to itself (or to
			// the hook's own repo) instead of to `cwd`'s real worktree root — which
			// silently breaks the ownership ledger's keys and its cross-checkout
			// backfill (see gitEnvWithoutLocationVars).
			env: gitEnvWithoutLocationVars(),
			// Capture git's stderr so a non-git cwd doesn't leak "fatal: not a git
			// repository …" to the terminal; the throw is handled below.
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		if (out) root = out; // git prints the toplevel in forward-slash form on every platform
	} catch {
		// Not a git repo / git missing — no worktree root.
	}
	_stateRootCache.set(cwd, root);
	return root;
}

/**
 * Wraps a repo-relative path as a LITERAL git pathspec.
 *
 * Git matches a bare pathspec as a GLOB, so `*`, `?` and `[…]` inside a real
 * filename act as wildcards rather than characters. Measured: with `a1.txt`
 * modified, `git restore -- 'a[1].txt'` reverts `a1.txt`, leaves `a[1].txt`
 * untouched, and exits 0 — an operation that reports success for a file it never
 * touched while changing a DIFFERENT file. `git add` and `git rm --cached` glob
 * the same way.
 *
 * Use it wherever a path came from git itself (`git status`, `git diff --name-only`)
 * or from a UI row built out of one: such a path is already an exact filename, so
 * literal matching is always what is meant, and glob matching can only be wrong.
 *
 * NOT for a caller-authored pattern — a user typing `src/*.ts` wants the glob.
 */
export function literalPathspec(relativePath: string): string {
	return `:(literal)${relativePath}`;
}

/**
 * Executes a git command and returns the result.
 * Logs the command being executed and its outcome.
 *
 * `cwd` is passed via Node's `child_process` `cwd` option (sets the child
 * process's working directory at spawn time) rather than git's `-C <path>`
 * flag. The two are functionally equivalent for our use cases but routing
 * through `spawn`'s option keeps untrusted-looking path strings out of the
 * argv array, sidestepping CodeQL's `js/shell-command-constructed-from-input`
 * static-analysis alert (`spawn` with an args array never invokes a shell,
 * but CodeQL tracks taint conservatively).
 *
 * `LC_ALL=C` pins git's messages to English. git is gettext-localized, so on a
 * host with translations installed (`git-l10n` on most Linux distros; Apple git
 * ships none, which is why this is invisible on macOS) a non-English `LANG`
 * makes git emit translated stderr. Every consumer that classifies git output by
 * text — {@link GIT_ABSENT_STDERR_FRAGMENTS} most sharply, since a missed match
 * there turns a routine absence into a logged failure — would then silently
 * misread it for exactly the users least able to report why. `LC_ALL` (rather
 * than `LANG`/`LC_MESSAGES`) because it outranks both, so one variable is
 * enough. Set here, at the single choke point for our message-parsing git
 * calls; the `spawnHidden` paths below parse plumbing protocol output
 * (`cat-file --batch` headers, fast-import), which git does not translate.
 */
export async function execGit(args: ReadonlyArray<string>, cwd?: string): Promise<GitCommandResult> {
	log.debug("git %s%s", cwd ? `[cwd=${cwd}] ` : "", args.join(" "));

	try {
		const { stdout, stderr } = await execFileAsyncHidden("git", args, {
			maxBuffer: MAX_GIT_BUFFER_BYTES,
			env: { ...process.env, LC_ALL: "C" },
			...(cwd !== undefined && { cwd }),
		});
		const result: GitCommandResult = {
			stdout: stdout.trimEnd(),
			stderr: stderr.trim(),
			exitCode: 0,
		};
		return result;
	} catch (error: unknown) {
		const err = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
		const exitCode = typeof err.code === "number" ? err.code : err.code === "ENOENT" ? 127 : 1;
		/* v8 ignore start - defensive: null-coalescing for error properties that may be missing */
		const result: GitCommandResult = {
			stdout: (err.stdout ?? "").trimEnd(),
			stderr: (err.stderr ?? err.message ?? "").trim(),
			exitCode,
		};
		/* v8 ignore stop */
		log.debug("git command failed (exit: %d, stderr: %s)", exitCode, result.stderr.substring(0, 200));
		return result;
	}
}

/**
 * Gets information about the HEAD commit.
 */
export async function getHeadCommitInfo(cwd?: string): Promise<CommitInfo> {
	const hashResult = await execGit(["rev-parse", "HEAD"], cwd);
	if (hashResult.exitCode !== 0) {
		throw new Error(`Failed to get HEAD hash: ${hashResult.stderr}`);
	}

	// Use %x00 as delimiter for safe parsing
	const logResult = await execGit(["log", "-1", "--pretty=format:%H%x00%s%x00%an%x00%aI"], cwd);
	if (logResult.exitCode !== 0) {
		throw new Error(`Failed to get commit info: ${logResult.stderr}`);
	}

	const parts = logResult.stdout.split("\0");
	if (parts.length < 4) {
		throw new Error(`Unexpected git log format: ${logResult.stdout}`);
	}

	const info: CommitInfo = {
		hash: parts[0],
		message: parts[1],
		author: parts[2],
		date: parts[3],
	};
	log.info("HEAD commit: %s - %s", info.hash.substring(0, 8), info.message.substring(0, 60));
	return info;
}

/**
 * Returns the current HEAD commit hash (git rev-parse HEAD).
 * Used by PrepareMsgHook to record the expected parent for squash-pending validation.
 */
export async function getHeadHash(cwd?: string): Promise<string> {
	const result = await execGit(["rev-parse", "HEAD"], cwd);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to get HEAD hash: ${result.stderr}`);
	}
	return result.stdout.trim();
}

/**
 * Returns the parent hash of HEAD (git rev-parse HEAD~1).
 * Used by PostCommitHook Worker to validate squash-pending.expectedParentHash.
 * Returns null when HEAD has no parent (first commit in repo).
 */
export async function getParentHash(cwd?: string): Promise<string | null> {
	const result = await execGit(["rev-parse", "HEAD~1"], cwd);
	if (result.exitCode !== 0) {
		return null;
	}
	const hash = result.stdout.trim();
	return hash || null;
}

/**
 * Returns the description of the most recent reflog entry (git reflog -1 --format=%gs).
 * Examples: "reset: moving to HEAD~3", "commit: Fix bug", "rebase (squash): ..."
 * Returns empty string if reflog is empty or inaccessible.
 */
export async function getLastReflogAction(cwd?: string): Promise<string> {
	const result = await execGit(["reflog", "-1", "--format=%gs"], cwd);
	if (result.exitCode !== 0) {
		return "";
	}
	return result.stdout.trim();
}

/**
 * Returns the contents of ORIG_HEAD (set by git reset, merge, rebase).
 * Returns null if ORIG_HEAD does not exist (e.g. no reset has happened).
 */
export async function readOrigHead(cwd?: string): Promise<string | null> {
	const result = await execGit(["rev-parse", "ORIG_HEAD"], cwd);
	if (result.exitCode !== 0) {
		return null;
	}
	const hash = result.stdout.trim();
	return hash || null;
}

/**
 * Checks whether `ancestor` is an ancestor of `descendant` in the commit graph.
 * Uses `git merge-base --is-ancestor` (exit code 0 = yes, 1 = no).
 * Returns false if either ref is invalid.
 */
export async function isAncestor(ancestor: string, descendant: string, cwd?: string): Promise<boolean> {
	const result = await execGit(["merge-base", "--is-ancestor", ancestor, descendant], cwd);
	return result.exitCode === 0;
}

/**
 * Returns the list of commit hashes in the range (fromExclude, toInclude].
 * Uses `git rev-list fromExclude..toInclude`.
 * Returns empty array if the range is empty or either ref is invalid.
 */
export async function getCommitRange(
	fromExclude: string,
	toInclude: string,
	cwd?: string,
): Promise<ReadonlyArray<string>> {
	const result = await execGit(["rev-list", `${fromExclude}..${toInclude}`], cwd);
	if (result.exitCode !== 0 || !result.stdout.trim()) {
		return [];
	}
	return result.stdout
		.trim()
		.split("\n")
		.filter((h) => h.length > 0);
}

/**
 * Returns every commit hash reachable from a local branch tip (`git rev-list
 * --branches`), the set a rebase/reset/squash can drop a commit out of. Not
 * `--all`: tags and remote-tracking refs would keep a rewritten-away commit
 * looking "live" long after no local branch points anywhere near it.
 * Returns null on a git failure (missing repo, corrupt refs) so a caller can
 * fail open — treating "we could not ask git" as "everything is reachable"
 * is safer than hiding real data because of a transient error.
 */
export async function listReachableCommits(cwd?: string): Promise<ReadonlyArray<string> | null> {
	const result = await execGit(["rev-list", "--branches"], cwd);
	if (result.exitCode !== 0) return null;
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((h) => h.length > 0);
}

/**
 * The object id at every local branch tip (`refs/heads/*`), sorted, or null on a
 * git failure. This is the exact INPUT that {@link listReachableCommits} walks —
 * `rev-list --branches` starts from these same tips — but read with a cheap
 * O(branches) ref read instead of an O(history) object walk. So a caller can ask
 * "could the reachable set have changed since last time?" (identical tips ⇒
 * identical reachable set) before paying for the full walk. Sorted so a bare
 * reordering of refs is not seen as a change.
 */
export async function listBranchTips(cwd?: string): Promise<ReadonlyArray<string> | null> {
	const result = await execGit(["for-each-ref", "--format=%(objectname)", "refs/heads"], cwd);
	if (result.exitCode !== 0) return null;
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((h) => h.length > 0)
		.sort();
}

/**
 * The git identity commits made here are attributed to (`user.email` /
 * `user.name`), each field null when unset or unreadable.
 *
 * Read from `git config`, not from HEAD's author: a repo whose last commit came
 * from a teammate (a fresh clone, a shared branch) would otherwise report the
 * teammate as the local user. Both fields are returned because the two can
 * disagree — a machine configured with a work email pushing to a remote that
 * rewrites it to a noreply address still authored the commit — so callers match
 * on EITHER, mirroring the backfill author filter.
 */
export async function readLocalGitIdentity(cwd?: string): Promise<{ email: string | null; name: string | null }> {
	const read = async (key: string): Promise<string | null> => {
		const result = await execGit(["config", key], cwd);
		const value = result.exitCode === 0 ? result.stdout.trim() : "";
		return value.length > 0 ? value : null;
	};
	return { email: await read("user.email"), name: await read("user.name") };
}

/**
 * Gets information about a specific commit by hash.
 * Unlike getHeadCommitInfo, this queries a specific hash rather than HEAD.
 *
 * `%ae` is appended LAST so the four historical field positions are untouched:
 * a caller (or a test) that still sees a 4-field line keeps working and simply
 * reports no email.
 */
export async function getCommitInfo(hash: string, cwd?: string): Promise<CommitInfo> {
	const logResult = await execGit(["log", "-1", "--pretty=format:%H%x00%s%x00%an%x00%aI%x00%ae", hash], cwd);
	if (logResult.exitCode !== 0) {
		throw new Error(`Failed to get commit info for ${hash}: ${logResult.stderr}`);
	}

	const parts = logResult.stdout.split("\0");
	if (parts.length < 4) {
		throw new Error(`Unexpected git log format for ${hash}: ${logResult.stdout}`);
	}

	const authorEmail = parts[4]?.trim();
	const info: CommitInfo = {
		hash: parts[0],
		message: parts[1],
		author: parts[2],
		date: parts[3],
		...(authorEmail ? { authorEmail } : {}),
	};
	log.info("Commit %s: %s", info.hash.substring(0, 8), info.message.substring(0, 60));
	return info;
}

/**
 * Gets the diff content between two refs for prompt assembly.
 *
 * The budget defaults to 150_000 chars — sized for the summarizer's model
 * (sonnet-class, ~200K-token window) while leaving room for the conversation +
 * plans and keeping the assembled prompt inside the LLM wall-clock budget. It
 * is deliberately capped below a full ~200K window: a whole-tree squash
 * regenerate (≈200K diff + ≈200K conversation) overran the timeout and aborted
 * mid-flight, so the diff share is held to 150K. When
 * the raw diff still exceeds `maxChars` it is NOT silently cut to the first few
 * (alphabetically-ordered) files — that let a large commit be summarised as if
 * only its first files had changed. Instead the complete `git diff --stat` file
 * list is prepended (so every changed file stays visible) and the remaining
 * budget is filled with the head of the diff body. Truncation is logged so it
 * is visible in debug.log.
 */
export async function getDiffContent(fromRef: string, toRef: string, cwd?: string, maxChars = 150000): Promise<string> {
	const result = await execGit(["diff", `${fromRef}..${toRef}`], cwd);
	if (result.exitCode !== 0) {
		// For first commit, there's no parent — diff against the empty tree.
		log.warn("Diff failed, trying diff of HEAD against empty tree");
		const emptyTree = await execGit(["hash-object", "-t", "tree", "/dev/null"], cwd);
		const tree = emptyTree.stdout.trim();
		const fallback = await execGit(["diff", tree, toRef], cwd);
		return capDiffToBudget(fallback.stdout, ["diff", "--stat", tree, toRef], cwd, maxChars);
	}

	return capDiffToBudget(result.stdout, ["diff", "--stat", `${fromRef}..${toRef}`], cwd, maxChars);
}

/**
 * Caps a raw diff body to `maxChars`. Under budget → returned as-is (no extra
 * git call). Over budget → fetch the full `--stat` file list via `statArgs`,
 * prepend it plus a truncation marker, then fill the remaining budget with the
 * head of the body. This keeps every changed file visible to the model even
 * when the per-file bodies don't all fit. Total output stays within `maxChars`
 * (unless the file list alone exceeds it, in which case the full list wins —
 * the file list is the more valuable signal).
 */
async function capDiffToBudget(
	body: string,
	statArgs: ReadonlyArray<string>,
	cwd: string | undefined,
	maxChars: number,
): Promise<string> {
	if (body.length <= maxChars) {
		return body;
	}
	const statResult = await execGit([...statArgs], cwd);
	const stat = statResult.exitCode === 0 ? statResult.stdout.trimEnd() : "";
	const marker = `\n--- diff body truncated (${body.length} chars total); full file list above, head of diff within the ${maxChars}-char budget below ---\n`;
	const header = `${stat}${marker}`;
	log.warn(
		"Diff exceeds %d-char budget (%d chars) — prepending --stat file list and truncating body",
		maxChars,
		body.length,
	);
	const bodyBudget = Math.max(0, maxChars - header.length);
	return `${header}${body.substring(0, bodyBudget)}`;
}

/**
 * Parses the summary line of `git diff --stat` output, e.g.
 * "3 files changed, 45 insertions(+), 12 deletions(-)". Empty diffs (no
 * matching summary line) yield all-zero stats. Shared by every get*DiffStats
 * helper so the three call sites can never drift in their parsing.
 */
function parseDiffStatSummary(stdout: string): DiffStats {
	const lastLine =
		stdout
			.split("\n")
			.filter((l) => l.trim().length > 0)
			.pop() ?? "";
	const filesMatch = lastLine.match(/(\d+)\s+files?\s+changed/);
	const insertMatch = lastLine.match(/(\d+)\s+insertions?/);
	const deleteMatch = lastLine.match(/(\d+)\s+deletions?/);
	return {
		filesChanged: filesMatch ? Number.parseInt(filesMatch[1], 10) : 0,
		insertions: insertMatch ? Number.parseInt(insertMatch[1], 10) : 0,
		deletions: deleteMatch ? Number.parseInt(deleteMatch[1], 10) : 0,
	};
}

/**
 * Gets diff statistics (files changed, insertions, deletions).
 */
export async function getDiffStats(fromRef: string, toRef: string, cwd?: string): Promise<DiffStats> {
	const result = await execGit(["diff", "--stat", `${fromRef}..${toRef}`], cwd);
	return parseDiffStatSummary(result.stdout);
}

/**
 * Gets diff statistics for the currently staged (index) changes.
 * Same parsing as {@link getDiffStats}, against `git diff --stat --cached`
 * instead of two refs — there is no second ref for a not-yet-committed diff.
 */
export async function getStagedDiffStats(cwd?: string): Promise<DiffStats> {
	const result = await execGit(["diff", "--stat", "--cached"], cwd);
	return parseDiffStatSummary(result.stdout);
}

/**
 * Gets working-tree diff statistics for a specific set of paths, against HEAD
 * (`git diff --stat HEAD -- <paths>`). This captures staged *and* unstaged
 * changes to those paths — i.e. what a commit of exactly those files would
 * record — without touching the index, so it is safe to call for a read-only
 * preview. An empty path list short-circuits to all-zero stats (a bare
 * `git diff` would otherwise report the whole working tree).
 *
 * `git diff HEAD` silently omits untracked files, but a `Commit Memory` of the
 * selection *stages* them, so their additions must count too — otherwise a
 * selection of only new files reports "0 files changed" while the title preview
 * (JolliMemoryBridge.diffForSelection, which diffs untracked files against
 * /dev/null) shows their content. We add the untracked subset back via
 * `ls-files --others` + a per-file `diff --no-index --numstat` so both surfaces
 * agree. Still entirely read-only — the index is never touched.
 */
export async function getWorkingTreeDiffStats(relativePaths: ReadonlyArray<string>, cwd?: string): Promise<DiffStats> {
	if (relativePaths.length === 0) {
		return { filesChanged: 0, insertions: 0, deletions: 0 };
	}
	const [trackedResult, untrackedRaw] = await Promise.all([
		execGit(["diff", "--stat", "HEAD", "--", ...relativePaths], cwd),
		execGit(["ls-files", "--others", "--exclude-standard", "--", ...relativePaths], cwd),
	]);
	const tracked = parseDiffStatSummary(trackedResult.stdout);
	const untrackedPaths = untrackedRaw.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (untrackedPaths.length === 0) {
		return tracked;
	}
	let untrackedInsertions = 0;
	for (const p of untrackedPaths) {
		// `--no-index` exits 1 whenever there is a diff (always, here); execGit
		// captures stdout regardless of exit code, so read the numstat off it.
		// numstat first column = added lines ("-" for binary → NaN → skip count).
		const numstat = await execGit(["diff", "--no-index", "--numstat", "--", "/dev/null", p], cwd);
		const added = Number.parseInt(numstat.stdout.split("\t")[0] ?? "", 10);
		if (Number.isFinite(added)) {
			untrackedInsertions += added;
		}
	}
	return {
		filesChanged: tracked.filesChanged + untrackedPaths.length,
		insertions: tracked.insertions + untrackedInsertions,
		deletions: tracked.deletions,
	};
}

/**
 * Gets the current branch name.
 */
export async function getCurrentBranch(cwd?: string): Promise<string> {
	const result = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to get current branch: ${result.stderr}`);
	}
	const branch = result.stdout.trim();
	return branch;
}

/**
 * Resolves the repository's default branch from `origin/HEAD` (the symbolic ref
 * `git clone` / `git remote set-head` records), e.g. `main`, `master`,
 * `develop`. Falls back to `"main"` when origin/HEAD is unset (bare local repo,
 * no remote, or never fetched). Used as the PR commit-range base default so a
 * repo whose default branch isn't `main` doesn't spuriously report "no memory".
 */
export async function getDefaultBranch(cwd?: string): Promise<string> {
	const result = await execGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
	if (result.exitCode === 0) {
		const ref = result.stdout.trim().replace(/^origin\//, "");
		if (ref) return ref;
	}
	return "main";
}

/** A distinct commit author of the repo, with how many commits they authored. */
export interface RepoContributor {
	readonly name: string;
	readonly email: string;
	readonly commitCount: number;
}

/**
 * Whether an email looks deliverable — i.e. worth offering as a share recipient.
 * Drops the placeholder addresses git history is full of (GitHub's privacy
 * `noreply` addresses and the like), which a `mailto:` could never reach.
 */
function isDeliverableEmail(email: string): boolean {
	const e = email.trim().toLowerCase();
	if (!e.includes("@")) return false;
	if (e.endsWith(".noreply.github.com") || e === "noreply@github.com") return false;
	if (e.startsWith("noreply@") || e.startsWith("no-reply@")) return false;
	return true;
}

/**
 * Distinct commit authors of the repo (HEAD's history), most-commits-first — the
 * people who participated in this repo, as candidate share recipients.
 *
 * Read-only and checkout-free; used only as a *source of candidate emails* for the
 * share "send link to" picker — it never gates access. Deduped by lowercased
 * email, with non-deliverable placeholder addresses (GitHub `noreply` etc.)
 * filtered out so we never offer an address a `mailto:` can't reach. `max` caps the
 * result. Returns `[]` when the repo has no commits or `git log` fails (e.g.
 * outside a work tree).
 */
export async function getRepoContributors(cwd?: string, max = 200): Promise<RepoContributor[]> {
	const result = await execGit(["log", "--no-merges", "--format=%an%x00%aE"], cwd);
	if (result.exitCode !== 0) return [];
	const byEmail = new Map<string, RepoContributor>();
	for (const line of result.stdout.split("\n")) {
		const [name, email] = line.split(NUL);
		if (!email || !isDeliverableEmail(email)) continue;
		const key = email.trim().toLowerCase();
		const prev = byEmail.get(key);
		byEmail.set(key, {
			// `git log` streams newest-first, so keep the first (most recent) non-empty
			// name we see — a contributor who has since renamed shows their current name.
			name: prev?.name || (name?.trim() ?? ""),
			email: email.trim(),
			commitCount: (prev?.commitCount ?? 0) + 1,
		});
	}
	return [...byEmail.values()].sort((a, b) => b.commitCount - a.commitCount).slice(0, max);
}

/**
 * Checks if an orphan branch exists.
 */
export async function orphanBranchExists(branch: string, cwd?: string): Promise<boolean> {
	const result = await execGit(["rev-parse", "--verify", `refs/heads/${branch}`], cwd);
	const exists = result.exitCode === 0;
	return exists;
}

/**
 * Creates an orphan branch using git plumbing commands.
 * This does NOT checkout the branch — it only creates the ref.
 *
 * Plumbing flow:
 *   1. Write initial content as a blob (hash-object)
 *   2. Create a tree from the blob (mktree)
 *   3. Create a commit from the tree (commit-tree)
 *   4. Point the branch ref at the commit (update-ref)
 */
export async function ensureOrphanBranch(branch: string, cwd?: string): Promise<void> {
	if (await orphanBranchExists(branch, cwd)) {
		return;
	}

	log.info("Creating orphan branch '%s' using plumbing commands", branch);

	// Step 1: Write initial index.json as a blob (via stdin pipe)
	const initialIndex = JSON.stringify({ version: 1, entries: [] }, null, "\t");
	const blobHash = await writeBlob(initialIndex, cwd);
	log.debug("Created blob: %s", blobHash);

	// Step 2: Create a tree containing the index.json file
	const treeInput = `100644 blob ${blobHash}\tindex.json\n`;
	const treeHash = await writeTree(treeInput, cwd);
	log.debug("Created tree: %s", treeHash);

	// Step 3: Create a commit with no parents (orphan)
	const commitResult = await execGit(["commit-tree", treeHash, "-m", "Initialize Jolli Memory summaries"], cwd);
	if (commitResult.exitCode !== 0) {
		throw new Error(`Failed to create commit: ${commitResult.stderr}`);
	}
	const commitHash = commitResult.stdout.trim();
	log.debug("Created commit: %s", commitHash);

	// Step 4: Point the branch at the commit
	const refResult = await execGit(["update-ref", `refs/heads/${branch}`, commitHash], cwd);
	if (refResult.exitCode !== 0) {
		throw new Error(`Failed to update ref: ${refResult.stderr}`);
	}

	log.info("Orphan branch '%s' created successfully", branch);
}

/**
 * stderr fragments git emits when the requested object is simply not there —
 * a normal, expected outcome (fresh repo with no orphan branch yet, a path that
 * predates a summary, a cross-repo probe).
 *
 * Matching is on stderr text rather than exit code because git returns **128**
 * for both absence and genuine breakage alike (measured: missing path, missing
 * ref, and "not a git repository" all exit 128). Each entry below is verbatim
 * from real `git show` output:
 *
 *     fatal: path 'x.json' does not exist in '<branch>'
 *     fatal: path 'x.json' does not exist (neither on disk nor in the index)
 *     fatal: invalid object name '<branch>'.
 *     fatal: path 'AGENTS.md' exists on disk, but not in '<branch>'
 *     fatal: ambiguous argument 'x': unknown revision or path not in the working tree.
 *
 * The polarity is deliberate: this is an allowlist of *absence*, so anything
 * unrecognized — a corrupt object database, `detected dubious ownership`,
 * `not a git repository`, EACCES on `.git`, git missing from PATH — falls
 * through to the failure branch and is reported. A denylist of failures would
 * silently swallow every error phrasing we failed to anticipate.
 *
 * Note the fragments stay specific rather than collapsing to a bare
 * "does not exist": a corrupt object database reports `object file … does not
 * exist`, which is a real failure that the loose form would swallow.
 */
const GIT_ABSENT_STDERR_FRAGMENTS = [
	"does not exist in",
	"does not exist (neither on disk nor in the index)",
	"invalid object name",
	"exists on disk, but not in",
	"unknown revision or path not in the working tree",
] as const;

/** True when git's stderr says the object is absent, as opposed to unreadable. */
function isAbsentFromBranch(stderr: string): boolean {
	const lower = stderr.toLowerCase();
	return GIT_ABSENT_STDERR_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/**
 * Reads a file from a branch without checking it out.
 *
 * Returns null when the file doesn't exist. A null is ALSO returned when the
 * read fails outright, because callers have no third state to receive — but that
 * case is logged as a warning here rather than passed up silently, since this is
 * the last point where git's stderr is available to name the cause. Callers must
 * therefore treat null as "nothing to read", not "nothing went wrong".
 */
export async function readFileFromBranch(branch: string, filePath: string, cwd?: string): Promise<string | null> {
	log.debug("Reading file from branch: %s:%s", branch, filePath);
	const result = await execGit(["show", `${branch}:${filePath}`], cwd);
	if (result.exitCode !== 0) {
		if (isAbsentFromBranch(result.stderr)) {
			log.debug("File not found: %s:%s", branch, filePath);
		} else {
			// Not an absence — the read itself broke. Callers only ever see the
			// `null` below and cannot tell the two apart, so this is the only
			// place the cause can be named. See JOLLI-2066.
			log.warn(
				"Read failed for %s:%s (git exit %d): %s",
				branch,
				filePath,
				result.exitCode,
				result.stderr || "(no stderr)",
			);
		}
		return null;
	}
	return result.stdout;
}

/**
 * Bulk read of N files from `branch`, all served by a single
 * `git cat-file --batch` subprocess. Returns a `Map<path, content | null>`
 * with one entry per input path; `null` means the file was missing on the
 * branch at lookup time (cat-file printed `<request> missing`).
 *
 * Why this exists: the obvious `for (...) await readFileFromBranch()` is
 * O(n × spawn-cost). On Windows that's ~80 ms per spawn, so 336 summaries
 * during a v5 migration cost ~27 s of pure subprocess overhead — even after
 * the write side switched to fast-import. cat-file's `--batch` mode reads
 * one request per stdin line and emits the response on stdout, all within
 * one long-running process; the same 336 reads then take a couple of
 * seconds total.
 *
 * Protocol (see `git-cat-file(1)`):
 *
 *     <request>\n              -- on stdin, e.g. "<branch>:<path>"
 *     <sha> <type> <size>\n    -- on stdout (header line)
 *     <size bytes of body>\n   -- body, exactly `size` bytes + a trailing LF
 *
 * Missing entries are signalled by a single `<request> missing\n` line with
 * no body. Responses arrive in the exact order requests were written, so the
 * parser pops them off positionally.
 *
 * The parser is a small streaming state machine because TCP-style chunking
 * applies to subprocess pipes too: a single `data` event may span the
 * boundary between header and body, multiple responses, or a partial body.
 * We accumulate bytes in a `pending` buffer and consume them in two phases
 * (header line vs. fixed-size body + trailing LF) until all expected
 * responses are accounted for.
 */
export async function batchReadFilesFromBranch(
	branch: string,
	paths: ReadonlyArray<string>,
	cwd?: string,
): Promise<Map<string, string | null>> {
	const result = new Map<string, string | null>();
	if (paths.length === 0) return result;

	const args = ["cat-file", "--batch"];
	log.debug(
		"git (cat-file --batch stream) %s%s for %d paths",
		cwd ? `[cwd=${cwd}] ` : "",
		args.join(" "),
		paths.length,
	);

	return new Promise<Map<string, string | null>>((resolve, reject) => {
		// `cwd` flows through `spawn`'s options bag, not `git -C`. See
		// `execGit` for the CodeQL rationale.
		const proc = spawnHidden("git", args, {
			stdio: ["pipe", "pipe", "pipe"],
			...(cwd !== undefined && { cwd }),
		});
		let stderr = "";
		let pending = Buffer.alloc(0);
		let inHeader = true;
		let bytesRemaining = 0;
		let bodyChunks: Buffer[] = [];
		let needsTrailingNewline = false;
		let pathIdx = 0;
		let settled = false;

		/* v8 ignore start -- idempotency guard: only fires if multiple error paths race (e.g. both `close` and `error` events). Single-event paths are exercised; double-fire isn't reachable without a hostile mock. */
		const settle = (err: Error | null): void => {
			if (settled) return;
			settled = true;
			if (err) reject(err);
			else resolve(result);
		};
		/* v8 ignore stop */

		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		proc.stdout.on("data", (chunk: Buffer) => {
			// Always `Buffer.concat` (instead of `pending = chunk` on the first
			// event) so `pending` keeps a `Buffer<ArrayBuffer>` type — `chunk`
			// from a pipe is `Buffer<ArrayBufferLike>` and direct assignment
			// would narrow the variable's type through the loop. Allocation
			// cost is negligible vs. the cat-file pipe overhead we're paying
			// anyway.
			pending = Buffer.concat([pending, chunk]);

			while (!settled) {
				if (inHeader) {
					const nlIdx = pending.indexOf(0x0a);
					if (nlIdx < 0) return; // need more bytes
					const header = pending.subarray(0, nlIdx).toString("utf8");
					pending = pending.subarray(nlIdx + 1);

					/* v8 ignore start -- defensive: git only emits more responses than requests if our request/response accounting drifts, which would be a bug */
					if (pathIdx >= paths.length) {
						settle(new Error(`git cat-file --batch returned extra response: ${header}`));
						return;
					}
					/* v8 ignore stop */
					const requestPath = paths[pathIdx];
					pathIdx++;

					if (header.endsWith(" missing")) {
						result.set(requestPath, null);
						continue;
					}

					// Header: "<sha> <type> <size>"
					const sizeStr = header.substring(header.lastIndexOf(" ") + 1);
					const size = Number.parseInt(sizeStr, 10);
					/* v8 ignore start -- defensive: malformed header would indicate a git protocol break, not a recoverable runtime condition */
					if (!Number.isFinite(size) || size < 0) {
						settle(new Error(`Unexpected cat-file --batch header for ${requestPath}: ${header}`));
						return;
					}
					/* v8 ignore stop */
					bytesRemaining = size;
					bodyChunks = [];
					inHeader = false;
					needsTrailingNewline = true;
					// fall through into the body branch
				}

				if (bytesRemaining > 0) {
					if (pending.length === 0) return; // need more bytes
					const take = Math.min(bytesRemaining, pending.length);
					bodyChunks.push(pending.subarray(0, take));
					pending = pending.subarray(take);
					bytesRemaining -= take;
					if (bytesRemaining > 0) return; // body not fully drained yet
				}

				/* v8 ignore next -- false-arm only reachable if state-machine invariants drift: this block always runs after the body branch transitions out of header. The early-return inside is what tests exercise. */
				if (needsTrailingNewline) {
					if (pending.length < 1) return; // need the trailing LF
					pending = pending.subarray(1);
					needsTrailingNewline = false;

					const requestPath = paths[pathIdx - 1];
					result.set(requestPath, Buffer.concat(bodyChunks).toString("utf8"));
					bodyChunks = [];
					inHeader = true;
				}
			}
		});

		proc.on("close", (code) => {
			/* v8 ignore start -- spawn error / non-zero exit / under-response are protocol-failure paths exercised via mocks but exact branch ordering varies by platform */
			if (code !== 0) {
				settle(new Error(`git cat-file --batch failed (exit ${code}): ${stderr.trim()}`));
				return;
			}
			if (pathIdx < paths.length) {
				settle(
					new Error(
						`git cat-file --batch returned ${pathIdx} of ${paths.length} expected responses; stderr=${stderr.trim()}`,
					),
				);
				return;
			}
			/* v8 ignore stop */
			settle(null);
		});

		/* v8 ignore start -- spawn error only triggers when git is not on PATH */
		proc.on("error", (err) => {
			settle(err);
		});
		/* v8 ignore stop */

		// stdin EPIPE handler — mirrors `runFastImport`. If cat-file exits
		// early (malformed input, OOM, signal), the in-flight write loop
		// below can throw EPIPE asynchronously; without this listener Node
		// would terminate the process on the unhandled stream error.
		proc.stdin.on("error", (err) => {
			settle(err);
		});

		// Write every request in one go. cat-file flushes responses as it
		// resolves each one, so it's safe (and faster) to feed everything
		// upfront and close stdin; git will continue draining responses to
		// stdout even though no more requests are coming.
		for (const path of paths) {
			proc.stdin.write(`${branch}:${path}\n`);
		}
		proc.stdin.end();
	});
}

/**
 * Writes a file to a branch using git plumbing commands.
 * Does NOT checkout the branch — works entirely through object database.
 *
 * Strategy: Read current tree → update with new file → create new commit → update ref
 */
export async function writeFileToBranch(
	branch: string,
	filePath: string,
	content: string,
	commitMessage: string,
	cwd?: string,
): Promise<void> {
	// Ensure branch exists
	await ensureOrphanBranch(branch, cwd);

	// Get the current commit hash of the branch
	const tipResult = await execGit(["rev-parse", `refs/heads/${branch}`], cwd);
	if (tipResult.exitCode !== 0) {
		throw new Error(`Failed to get branch tip: ${tipResult.stderr}`);
	}
	const parentCommit = tipResult.stdout.trim();

	// Get the current tree
	const treeResult = await execGit(["rev-parse", `${parentCommit}^{tree}`], cwd);
	if (treeResult.exitCode !== 0) {
		throw new Error(`Failed to get tree: ${treeResult.stderr}`);
	}
	const currentTree = treeResult.stdout.trim();

	// Write the new file content as a blob
	const blobHash = await writeBlob(content, cwd);

	// Read the current tree entries and build new tree
	const newTree = await updateTreeWithFile(currentTree, filePath, blobHash, cwd);

	// Create a new commit
	const commitResult = await execGit(["commit-tree", newTree, "-p", parentCommit, "-m", commitMessage], cwd);
	if (commitResult.exitCode !== 0) {
		throw new Error(`Failed to create commit: ${commitResult.stderr}`);
	}
	const newCommit = commitResult.stdout.trim();

	// Update the branch ref
	const refResult = await execGit(["update-ref", `refs/heads/${branch}`, newCommit], cwd);
	if (refResult.exitCode !== 0) {
		throw new Error(`Failed to update ref: ${refResult.stderr}`);
	}

	log.info("File written to branch '%s' successfully (commit: %s)", branch, newCommit.substring(0, 8));
}

/**
 * Writes multiple files to a branch in a single atomic commit, streaming the
 * entire batch through one `git fast-import` subprocess.
 *
 * Why fast-import: the older per-file `hash-object` + `mktree` + `ls-tree`
 * pipeline spawned roughly 4 git subprocesses per file. On Windows that meant
 * a v5 schema migration touching 337 summaries took ~3 minutes; switching to
 * fast-import collapses it to two subprocess spawns total (fast-import itself,
 * plus one `rev-parse` to learn the parent commit) and finishes in seconds.
 *
 * Atomicity: fast-import writes the new commit and updates `refs/heads/<branch>`
 * in a single transaction. Either the whole batch lands or nothing does — same
 * guarantee the old plumbing path provided. The `from <parent>` directive ties
 * the new commit to the tip we observed at entry, so a concurrent writer
 * advancing the ref between our rev-parse and fast-import would cause the
 * import to abort rather than overwrite their commit. (Concurrent writers are
 * already serialized via `orphan-write.lock` upstream of this function; the
 * `from` check is the belt-and-braces backup.)
 *
 * Behavior preserved from the prior implementation:
 *   - Empty `files` array still produces a commit (same tree as parent).
 *   - Mixed writes and deletes in any order; deletes use the fast-import `D`
 *     directive.
 *   - Author/committer identity is whatever `git var` resolves for the caller,
 *     so the commit looks exactly like one `commit-tree` would have produced.
 */
export async function writeMultipleFilesToBranch(
	branch: string,
	files: ReadonlyArray<FileWrite>,
	commitMessage: string,
	cwd?: string,
): Promise<void> {
	await ensureOrphanBranch(branch, cwd);

	const tipResult = await execGit(["rev-parse", `refs/heads/${branch}`], cwd);
	if (tipResult.exitCode !== 0) {
		throw new Error(`Failed to get branch tip: ${tipResult.stderr}`);
	}
	const parentCommit = tipResult.stdout.trim();

	await runFastImport(branch, parentCommit, commitMessage, files, cwd);

	const writeCount = files.filter((f) => !f.delete).length;
	const deleteCount = files.filter((f) => f.delete).length;
	log.info("Updated branch '%s': %d written, %d deleted (via fast-import)", branch, writeCount, deleteCount);
}

/**
 * Returns the git tree hash for a given commit hash.
 * Two commits with identical code content have the same tree hash, enabling
 * cross-branch summary matching (e.g. GitHub squash merge vs feature branch).
 *
 * Uses `git cat-file -p <hash>` and parses the `tree <hash>` line.
 * Returns null if the commit doesn't exist or the command fails.
 */
export async function getTreeHash(commitHash: string, cwd?: string): Promise<string | null> {
	const result = await execGit(["cat-file", "-p", commitHash], cwd);
	if (result.exitCode !== 0) {
		return null;
	}
	const match = result.stdout.match(/^tree ([a-f0-9]+)/m);
	return match ? match[1] : null;
}

/**
 * Lists files in a branch under a given path prefix.
 */
export async function listFilesInBranch(branch: string, prefix: string, cwd?: string): Promise<ReadonlyArray<string>> {
	log.debug("Listing files in branch %s under prefix '%s'", branch, prefix);
	// Use -z so git outputs raw filenames (no quoting/escaping for non-ASCII names)
	const result = await execGit(["ls-tree", "-z", "-r", "--name-only", branch, prefix], cwd);
	if (result.exitCode !== 0) {
		log.debug("Failed to list files (branch may not exist): %s", result.stderr);
		return [];
	}
	const files = result.stdout.split(NUL).filter((f) => f.length > 0);
	log.debug("Found %d files", files.length);
	return files;
}

/**
 * Returns the resolved absolute path to the common git directory.
 * In a regular repo this is the `.git` folder; in a worktree it resolves to
 * the shared `.git` directory of the main repo.
 *
 * Runs `git rev-parse --git-common-dir` and resolves the result against `cwd`
 * so that relative paths (as returned inside worktrees) become absolute.
 */
export async function getGitCommonDir(cwd: string): Promise<string> {
	const result = await execGit(["rev-parse", "--git-common-dir"], cwd);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to get git common dir: ${result.stderr}`);
	}
	const dir = result.stdout.trim();
	return resolve(cwd, dir);
}

/**
 * Resolves the absolute git-common-dir of the repository that CONTAINS `dir`,
 * using cwd-based discovery even when running inside a git hook. Unlike
 * {@link getGitCommonDir} it strips the ambient `GIT_DIR`/`GIT_WORK_TREE`/… that
 * git sets for hooks — with those present, `rev-parse` would pin every lookup to
 * the hook's own repo (measured: a sibling repo resolved to the current repo's
 * `.git`, defeating foreign-repo detection). Returns null when `dir` is not
 * inside any git repository (or cannot be resolved).
 */
export async function resolveContainingRepoCommonDir(dir: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsyncHidden("git", ["rev-parse", "--git-common-dir"], {
			cwd: dir,
			maxBuffer: MAX_GIT_BUFFER_BYTES,
			env: gitEnvWithoutLocationVars(),
		});
		return resolve(dir, stdout.trim());
	} catch {
		return null;
	}
}

/**
 * Returns the root directory of the main repository from the git common directory.
 * For regular repos: resolves `.git` → parent directory.
 * For worktrees: resolves the shared `.git` → main repo root.
 *
 * This is the canonical location for project-scoped config files
 * (e.g., `.jolli/jollimemory/config.json`).
 */
export async function getProjectRootDir(cwd: string): Promise<string> {
	const gitCommonDir = await getGitCommonDir(cwd);
	return dirname(gitCommonDir);
}

/**
 * Whether `cwd` is inside any git repository (`git rev-parse --git-dir` exits 0).
 * Cheap guard for operations that only make sense in a repo (hook install,
 * worktree enumeration): lets callers bail with a clear reason instead of
 * failing deep inside a git subcommand. Never throws — a non-repo `cwd` (or a
 * missing `git`) resolves to `false`. Intentionally returns `true` for any git
 * context — including a bare repo that hosts linked worktrees — so it only
 * blocks genuinely-non-git directories and never a valid `git worktree` setup.
 */
export async function isInsideGitRepo(cwd: string): Promise<boolean> {
	// A resolved filesystem layout is proof on its own because `resolveGitFsLayout`
	// applies git's own repository test (HEAD + `objects/` + `refs/`) rather than
	// just finding a `.git` — a bare `.git` directory, which an interrupted clone
	// leaves behind, is answered null there precisely so this guard cannot report
	// "inside a repo" for a directory `--git-dir` exits 128 on.
	//
	// The converse does NOT hold, which is why only `true` short-circuits: a bare
	// repo resolves to null while git says yes. Two more asymmetries are worth
	// stating because they are easy to assume away. A cwd INSIDE `.git/` is a hit,
	// not a null — the walk finds the enclosing `.git` from `.git/hooks` just as it
	// would from a source subdirectory (measured) — so it agrees with `--git-dir`
	// here and disagrees with `--show-toplevel`, which refuses. And a misconfigured
	// `core.worktree` is a hit while `--git-dir` fails. Neither is a problem for
	// THIS guard, whose answer is the same as git's in both cases; they matter to a
	// caller that reads a layout as "a worktree `--show-toplevel` would accept".
	//
	// Worth the three lines because the callers are latency-critical and already
	// know the answer: the Claude plugin bootstrap resolves the worktree root off
	// the filesystem and then hands it to `install`, which asked git again.
	if (resolveGitFsLayout(cwd) !== null) return true;
	const result = await execGit(["rev-parse", "--git-dir"], cwd);
	return result.exitCode === 0;
}

/**
 * Where a directory sits relative to a git WORKING TREE, distinguishing the two
 * reasons a caller can get "no".
 *
 * Deliberately not {@link isInsideGitRepo}, whose "any git context" answer is
 * correct for its own callers and too loose here. Measured on git 2.x:
 *
 * | cwd            | `rev-parse --git-dir` | `--is-inside-work-tree` |
 * |----------------|-----------------------|-------------------------|
 * | bare repo      | exit 0                | `false`                 |
 * | a worktree     | exit 0                | `true`                  |
 * | inside `.git/` | exit 0                | `false`                 |
 *
 * So an exit-code check calls a bare repo and the `.git` directory itself a
 * working tree. That matters wherever the answer gates something that will later
 * be re-decided by a stricter predicate — `StorageFactory`'s claimable-project
 * check, for one — because the looser gate lets a caller through into a path that
 * then degrades silently. Tests STDOUT, like `CliUtils.isInsideWorkTree` does.
 *
 * `git-unavailable` is split out because it is not a statement about `cwd` at all:
 * `execGit` turns a missing binary into `exitCode: 127` rather than throwing, and a
 * daemon spawned by a GUI-launched IDE really does get a PATH with no `git` on it.
 * Collapsing that into "not a repo" produces a diagnostic that sends the user to
 * check the wrong thing. Callers that only need a boolean can treat both non-`inside`
 * answers alike; callers that report a reason must not.
 */
export type WorktreeProbe = "inside" | "outside" | "git-unavailable";

/** Probe whether `cwd` is inside a git working tree. Never throws. */
export async function probeWorktree(cwd: string): Promise<WorktreeProbe> {
	const result = await execGit(["rev-parse", "--is-inside-work-tree"], cwd);
	if (result.exitCode === 127) return "git-unavailable";
	if (result.exitCode !== 0) return "outside";
	return result.stdout.trim() === "true" ? "inside" : "outside";
}

/**
 * Returns the absolute paths of all git worktrees for the repository.
 * Parses the output of `git worktree list --porcelain` and extracts lines
 * starting with "worktree " to collect each worktree path.
 * The main worktree is always first in the returned array.
 */
export async function listWorktrees(cwd: string): Promise<ReadonlyArray<string>> {
	const result = await execGit(["worktree", "list", "--porcelain"], cwd);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to list worktrees: ${result.stderr}`);
	}
	const paths = result.stdout
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trim());
	return paths;
}

/**
 * {@link listWorktrees} that never throws — `dir` plus every sibling checkout of
 * the same repository, deduped, `dir` first.
 *
 * The "one repo, many checkouts" question comes up wherever an artifact records
 * the directory it was produced in and a caller has to decide which repository
 * that is. An agent session is the case that matters most: transcripts are keyed
 * by the cwd the conversation ran in, so a linked worktree's sessions live under
 * ITS path, and a scope built from one checkout alone silently answers for a
 * fraction of the repo's work. Measured while this was still per-checkout: of 94
 * in-window Claude sessions on a repo with six live worktrees, 65 belonged to a
 * sibling and were invisible to the back-fill — and they are exactly the parallel
 * work the agent-concurrency figure exists to show.
 *
 * Returned paths are kept RAW (the caller's / git's own spelling): callers feed
 * them to {@link sessionDirBelongsToRepo}, whose nested-repo `.git` walk needs a
 * real on-disk path, and which folds separators and case itself. The DEDUPE key,
 * however, is `normalizePathForCompare`d — same trade as `dedupeRoots`. Without it
 * the Set keyed on raw strings: `listWorktrees` returns git's own output
 * (forward-slash paths on Windows) while `dir` arrives in the caller's spelling
 * (often backslash), so one checkout would survive as BOTH spellings, and the sole
 * direct consumer that does not re-dedupe (Antigravity's per-repo narrowing, the
 * reason `forRepoSpansWorktrees` exists) pays a streamed title read per duplicate.
 *
 * Falling back to `[dir]` rather than propagating is what makes this usable on a
 * caller's critical path: git being absent, or `dir` not being a checkout at all,
 * degrades to the previous single-root behaviour instead of failing a sweep.
 */
export async function resolveWorktreeRoots(dir: string): Promise<ReadonlyArray<string>> {
	const seen = new Set<string>();
	const roots: string[] = [];
	const add = (root: string): void => {
		const key = normalizePathForCompare(root);
		if (seen.has(key)) return;
		seen.add(key);
		roots.push(root);
	};
	add(dir);
	try {
		for (const worktree of await listWorktrees(dir)) add(worktree);
	} catch (err) {
		log.debug("listWorktrees failed for %s -- using it as the only root: %s", dir, errMsg(err));
	}
	return roots;
}

/**
 * Resolves the git hooks directory, handling both regular repos and worktrees.
 *
 * In a worktree, `.git` is a file containing `gitdir: <path>` pointing to the
 * actual git directory. We need to find the hooks dir in the real git directory.
 */
export async function resolveGitHooksDir(projectDir: string): Promise<string> {
	const dotGit = join(projectDir, ".git");
	const dotGitStat = await stat(dotGit);

	if (dotGitStat.isDirectory()) {
		// Regular repo: .git is a directory
		return join(dotGit, "hooks");
	}

	// Worktree: .git is a file with "gitdir: <path>"
	const content = await readFile(dotGit, "utf-8");
	const match = content.trim().match(/^gitdir:\s*(.+)$/);
	/* v8 ignore start - defensive: malformed .git file */
	if (!match) {
		throw new Error(`Unexpected .git file content: ${content.trim()}`);
	}
	/* v8 ignore stop */

	// The gitdir path may be relative or absolute
	const gitDir = match[1].trim();
	const resolvedGitDir = resolve(projectDir, gitDir);

	// For worktrees, hooks are in the common dir (parent of worktrees/)
	// e.g., gitdir: /repo/.git/worktrees/my-worktree → hooks at /repo/.git/hooks
	const worktreesIndex = resolvedGitDir.replace(/\\/g, "/").lastIndexOf("/worktrees/");
	if (worktreesIndex >= 0) {
		const commonGitDir = resolvedGitDir.substring(0, worktreesIndex);
		return join(commonGitDir, "hooks");
	}

	// Non-worktree gitlink: hooks are directly in the gitdir
	return join(resolvedGitDir, "hooks");
}

// --- Internal helpers ---

/**
 * Executes a git command with data piped to stdin via spawn.
 *
 * NOTE: We cannot use execFileAsync (promisified execFile) for this because
 * the `input` option is only supported by synchronous variants (execFileSync,
 * execSync). Using `input` with execFile silently ignores it, causing the
 * child process to hang waiting for stdin data that never arrives.
 */
function execGitWithStdin(args: ReadonlyArray<string>, input: string, cwd?: string): Promise<string> {
	log.debug("git (stdin) %s%s", cwd ? `[cwd=${cwd}] ` : "", args.join(" "));

	return new Promise((resolve, reject) => {
		// `cwd` flows through `spawn`'s options bag, not `git -C`. See `execGit`.
		const proc = spawnHidden("git", args, {
			stdio: ["pipe", "pipe", "pipe"],
			...(cwd !== undefined && { cwd }),
		});
		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`git ${args[0]} failed (exit ${code}): ${stderr.trim()}`));
			} else {
				resolve(stdout.trim());
			}
		});

		/* v8 ignore start - spawn error only occurs if git binary is not found */
		proc.on("error", (err) => {
			reject(err);
		});
		/* v8 ignore stop */

		proc.stdin.write(input);
		proc.stdin.end();
	});
}

/**
 * Writes content as a git blob object and returns the hash.
 * Uses spawn to pipe content to git hash-object via stdin.
 */
async function writeBlob(content: string, cwd?: string): Promise<string> {
	return execGitWithStdin(["hash-object", "-w", "--stdin"], content, cwd);
}

/**
 * Reads one of `GIT_AUTHOR_IDENT` / `GIT_COMMITTER_IDENT` via `git var`. The
 * returned string is already in the raw `Name <email> <epoch> <tz>` form that
 * fast-import expects in `author` / `committer` directives, so callers can
 * splice it verbatim.
 *
 * Reading via `git var` rather than hard-coding an identity preserves the
 * behavior of the old `commit-tree`-based pipeline, which inherited author /
 * committer from git config too — orphan-branch history therefore continues
 * to attribute commits to the same identity users see on `git log` elsewhere.
 */
async function getGitIdent(varName: "GIT_AUTHOR_IDENT" | "GIT_COMMITTER_IDENT", cwd?: string): Promise<string> {
	const result = await execGit(["var", varName], cwd);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to read ${varName}: ${result.stderr}`);
	}
	return result.stdout.trim();
}

/**
 * Atomically writes N blobs and one commit to `branch` via a single
 * `git fast-import` subprocess. Replaces the per-file hash-object + tree-
 * walk pipeline that previously made bulk writes O(n × spawn-cost).
 *
 * fast-import stream layout (see git-fast-import(1) for the full grammar):
 *
 *     blob
 *     mark :1
 *     data <byte-length-of-content>
 *     <raw bytes>
 *     ... (more blob records, one per write) ...
 *     commit refs/heads/<branch>
 *     author <name> <email> <epoch> <tz>
 *     committer <name> <email> <epoch> <tz>
 *     data <byte-length-of-msg>
 *     <message bytes>
 *     from <parent-sha>
 *     M 100644 :<mark> <path>      -- one per write, referencing the mark above
 *     D <path>                     -- one per delete
 *     done
 *
 * `--done` makes fast-import treat a truncated stream as an error rather than
 * silently committing a partial batch; we always emit the matching `done`
 * directive at the end of the stream so a clean shutdown is unambiguous.
 *
 * The `from <parent-sha>` directive is the concurrency guard: fast-import
 * refuses to advance the ref unless its current value matches `<parent-sha>`.
 * The caller passes the SHA observed at entry, so if another writer slips in
 * a commit before fast-import runs, this call fails fast instead of silently
 * clobbering them. (Upstream serialization via `orphan-write.lock` is the
 * primary defense; this is the secondary one.)
 */
async function runFastImport(
	branch: string,
	parent: string,
	commitMessage: string,
	files: ReadonlyArray<FileWrite>,
	cwd?: string,
): Promise<void> {
	const authorIdent = await getGitIdent("GIT_AUTHOR_IDENT", cwd);
	const committerIdent = await getGitIdent("GIT_COMMITTER_IDENT", cwd);

	const args = ["fast-import", "--quiet", "--done"];
	log.debug("git (fast-import stream) %s%s", cwd ? `[cwd=${cwd}] ` : "", args.join(" "));

	const writes = files.filter((f) => !f.delete);
	const deletes = files.filter((f) => f.delete);

	return new Promise<void>((resolve, reject) => {
		// `cwd` flows through `spawn`'s options bag, not `git -C`. See `execGit`.
		const proc = spawnHidden("git", args, {
			stdio: ["pipe", "pipe", "pipe"],
			...(cwd !== undefined && { cwd }),
		});
		let stderr = "";

		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		proc.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`git fast-import failed (exit ${code}): ${stderr.trim()}`));
			} else {
				resolve();
			}
		});
		/* v8 ignore start -- spawn error only triggers when git is not on PATH */
		proc.on("error", (err) => {
			reject(err);
		});
		/* v8 ignore stop */

		const stdin = proc.stdin;

		// stdin can emit async errors (EPIPE) if fast-import exits early —
		// e.g. malformed `from <parent>` or OOM. Without this handler the
		// EPIPE becomes an unhandled stream-error event and Node terminates
		// the process. The `close` handler's reject is idempotent vs this
		// one (whichever fires first wins; Promises swallow the second).
		stdin.on("error", (err) => {
			reject(err);
		});

		// Build the fast-import stream as one ordered list of chunks, then
		// write it with backpressure handling (see writeChunksWithBackpressure).
		// Blobs come first; marks are sequential integers — only need to be
		// unique within this stream, so 1..N is the simplest scheme.
		// Buffer.from(..., "utf8") + buf.length gives the BYTE count fast-import
		// requires (string.length would undercount any multi-byte UTF-8 sequence
		// and produce a malformed `data` directive).
		const chunks: Array<string | Buffer> = [];
		writes.forEach((f, idx) => {
			const mark = idx + 1;
			const body = Buffer.from(f.content, "utf8");
			chunks.push(`blob\nmark :${mark}\ndata ${body.length}\n`, body, "\n");
		});

		// The single commit record that references the marks above.
		const msg = Buffer.from(commitMessage, "utf8");
		chunks.push(
			`commit refs/heads/${branch}\n`,
			`author ${authorIdent}\n`,
			`committer ${committerIdent}\n`,
			`data ${msg.length}\n`,
			msg,
			"\n",
			`from ${parent}\n`,
		);
		writes.forEach((f, idx) => {
			chunks.push(`M 100644 :${idx + 1} ${quoteFastImportPath(f.path)}\n`);
		});
		for (const f of deletes) {
			chunks.push(`D ${quoteFastImportPath(f.path)}\n`);
		}
		chunks.push("done\n");

		// Stream the chunks honoring backpressure: when `write()` returns false
		// the kernel buffer is full, so wait for `drain` before the next chunk
		// rather than letting every blob body queue in Node's memory at once —
		// the 336-file migration this path optimizes is exactly where an
		// ignore-the-return-value loop would balloon. A write failure mid-stream
		// (EPIPE) rejects via `once`'s error handling, mirroring the persistent
		// `stdin.on("error")` above; either path's reject is idempotent.
		writeChunksWithBackpressure(stdin, chunks).then(
			() => {
				stdin.end();
			},
			(err) => {
				reject(err);
			},
		);
	});
}

/**
 * Writes `chunks` to `stream` in order, pausing on backpressure: when
 * `stream.write()` returns false (the internal/kernel buffer is full) it awaits
 * the next `drain` event before continuing, so a large batch can't pile every
 * chunk into memory at once. Rejects if the stream errors while draining
 * (`once` rejects on an `error` event), letting the caller surface an EPIPE
 * from an early fast-import exit instead of hanging.
 */
async function writeChunksWithBackpressure(
	stream: NodeJS.WritableStream,
	chunks: ReadonlyArray<string | Buffer>,
): Promise<void> {
	for (const chunk of chunks) {
		if (!stream.write(chunk)) {
			await once(stream, "drain");
		}
	}
}

/**
 * Renders a path for a fast-import `M`/`D` directive. fast-import accepts a
 * C-style-quoted path in all cases and REQUIRES it when the path contains a
 * newline or begins with a double-quote (an unquoted such path corrupts the
 * stream or splits the directive). Today every orphan-branch path is a
 * program-generated hash / UUID / fixed name that never needs quoting, so this
 * is a hardening / no-regression guard versus the byte-safe `mktree` path it
 * replaced — but it makes the writer correct for arbitrary paths.
 *
 * Quotes whenever the path contains a backslash, double-quote, CR, or LF, and
 * C-escapes those characters. (The `\\` replacement here escapes a literal
 * backslash for fast-import quoting — it is NOT path separator normalization,
 * so the `toForwardSlash` rule does not apply.)
 */
function quoteFastImportPath(path: string): string {
	if (!/["\\\n\r]/.test(path)) return path;
	const escaped = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
	return `"${escaped}"`;
}

/**
 * Creates a git tree from the provided tree-format input string.
 * Uses spawn to pipe tree entries to git mktree via stdin.
 */
async function writeTree(treeInput: string, cwd?: string): Promise<string> {
	return execGitWithStdin(["mktree"], treeInput, cwd);
}

/**
 * Updates a tree by adding/replacing a file at the given path.
 * Handles nested directories (e.g., "summaries/abc123.json").
 *
 * For a simple flat file (no '/'), modifies the tree directly.
 * For a nested path, creates subtrees recursively.
 */
async function updateTreeWithFile(
	currentTree: string,
	filePath: string,
	blobHash: string,
	cwd?: string,
): Promise<string> {
	const parts = filePath.split("/");

	if (parts.length === 1) {
		// Simple case: file in root of tree
		return await replaceInTree(currentTree, parts[0], "100644", "blob", blobHash, cwd);
	}

	// Nested case: need to handle subdirectories
	const dirName = parts[0];
	const remainingPath = parts.slice(1).join("/");

	// Get the current subtree for this directory (if it exists).
	// NOTE: Do NOT append "/" — `git ls-tree <tree> dir/` lists CONTENTS of
	// the directory (blob entries), while `git ls-tree <tree> dir` returns the
	// directory entry itself (040000 tree <hash>).
	const lsResult = await execGit(["ls-tree", currentTree, dirName], cwd);
	let subTreeHash: string;

	if (lsResult.exitCode === 0 && lsResult.stdout.trim()) {
		// Directory exists — extract its tree hash
		const match = lsResult.stdout.match(/^(\d+)\s+tree\s+([a-f0-9]+)\t/);
		/* v8 ignore start - defensive: git ls-tree should always produce a valid tree line */
		if (!match) {
			throw new Error(`Unexpected ls-tree output: ${lsResult.stdout}`);
		}
		/* v8 ignore stop */
		subTreeHash = match[2];
	} else {
		// Directory doesn't exist — create an empty tree
		subTreeHash = await writeTree("", cwd);
	}

	// Recursively update the subtree
	const newSubTree = await updateTreeWithFile(subTreeHash, remainingPath, blobHash, cwd);

	// Replace the directory entry in the parent tree
	return await replaceInTree(currentTree, dirName, "040000", "tree", newSubTree, cwd);
}

/**
 * Replaces or adds an entry in a tree object.
 * Reads the current tree, filters out the old entry, adds the new one, writes a new tree.
 */
async function replaceInTree(
	treeHash: string,
	name: string,
	mode: string,
	type: string,
	objectHash: string,
	cwd?: string,
): Promise<string> {
	// Use -z so git outputs raw filenames (no quoting/escaping for non-ASCII names)
	const lsResult = await execGit(["ls-tree", "-z", treeHash], cwd);
	const existingEntries = lsResult.stdout
		.split(NUL)
		.filter((line) => line.length > 0)
		.filter((line) => {
			// Filter out the entry we're replacing
			const entryName = line.split("\t")[1];
			return entryName !== name;
		});

	// Add the new/updated entry
	existingEntries.push(`${mode} ${type} ${objectHash}\t${name}`);

	// mktree accepts entries in any order and produces a deterministic tree hash,
	// so no explicit sorting is needed.
	const treeInput = `${existingEntries.join("\n")}\n`;
	return await writeTree(treeInput, cwd);
}
