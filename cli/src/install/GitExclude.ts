/**
 * Manages the per-repo `.git/info/exclude` file so generated Jolli skill
 * directories (`.agents/skills/jolli-*`, `.claude/skills/jolli-*`) don't show
 * up in `git status` for user repositories.
 *
 * We intentionally do **not** touch `.gitignore` — that file is shared with
 * collaborators via git and modifying it on the user's behalf would push a
 * Jolli-specific concern into their VCS history. `.git/info/exclude` is git's
 * own escape hatch for local-only ignore rules; it isn't tracked or shared.
 *
 * Path resolution goes through `git rev-parse --git-path info/exclude` so the
 * exclude file is found even when `.git` is a file (linked worktree) or lives
 * elsewhere (submodule). Pure path joins under `<projectDir>/.git/info/exclude`
 * silently miss those cases.
 *
 * Failure mode: if git is unavailable or the project isn't a git repo, the
 * function logs a warning and returns without throwing. The skill files
 * themselves still get written; the user just may see them in `git status`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix as posixPath, win32 as win32Path } from "node:path";
import { createLogger } from "../Logger.js";
import { execFileAsyncHidden } from "../util/Subprocess.js";

const log = createLogger("GitExclude");

/**
 * Marker pair bracketing Jolli's managed block in `.git/info/exclude`. Lines
 * between the start and end markers belong to Jolli and may be rewritten on
 * future installs. Anything outside the markers is untouched.
 */
const BLOCK_START = "# >>> jolli skill exclude >>>";
const BLOCK_END = "# <<< jolli skill exclude <<<";

/**
 * Resolves the absolute path to `.git/info/exclude` for `projectDir`.
 *
 * Uses `git rev-parse --git-path info/exclude` because:
 *   - In a linked worktree, `.git` is a file pointing at the real gitdir, and
 *     `info/` lives under the **common** dir, not the per-worktree one.
 *   - Submodules store `.git` outside the repo working tree entirely.
 * A naive `join(projectDir, ".git/info/exclude")` silently writes to the
 * wrong place (or fails) in either case.
 *
 * Returns `null` when git isn't installed, the project isn't a repo, or any
 * other invocation error — callers treat that as "fail soft, log only".
 */
/**
 * Normalizes the output of `git rev-parse --git-path info/exclude`.
 *
 * Returns the input unchanged when it's an absolute path; otherwise joins it
 * under `projectDir`. Accepts both win32-style (`C:\...`) and POSIX-style
 * (`/c/Users/...`) absolute forms — Git Bash on Windows emits the latter,
 * native Windows git emits the former, and we don't want to assume which.
 *
 * Important: we explicitly call `win32.isAbsolute` AND `posix.isAbsolute`
 * rather than the platform-default `isAbsolute`. The form `git rev-parse`
 * emits depends on git's own behavior (not on the platform running this
 * code), so on a Linux CI runner a Windows-style path must still be
 * recognized as absolute — otherwise it'd be wrongly join()'d under
 * projectDir.
 *
 * Pure function for ease of unit testing — `resolveGitExcludePath` shells out
 * to git, this helper handles the path normalization alone.
 */
export function normalizeGitPathOutput(relOrAbs: string, projectDir: string): string {
	const absolute = win32Path.isAbsolute(relOrAbs) || posixPath.isAbsolute(relOrAbs);
	return absolute ? relOrAbs : join(projectDir, relOrAbs);
}

export async function resolveGitExcludePath(projectDir: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsyncHidden("git", ["rev-parse", "--git-path", "info/exclude"], {
			cwd: projectDir,
		});
		const relOrAbs = stdout.trim();
		/* v8 ignore start -- defensive: git rev-parse always emits a non-empty path on success */
		if (relOrAbs.length === 0) return null;
		/* v8 ignore stop */
		return normalizeGitPathOutput(relOrAbs, projectDir);
	} catch {
		return null;
	}
}

/**
 * Appends or refreshes Jolli's managed block in `<projectDir>/.git/info/exclude`
 * with the given `paths`. Idempotent — running it twice in a row is a no-op.
 *
 * Block format:
 * ```
 * # >>> jolli skill exclude >>>
 * /.agents/skills/jolli-recall/
 * /.agents/skills/jolli-search/
 * /.claude/skills/jolli-recall/
 * /.claude/skills/jolli-search/
 * # <<< jolli skill exclude <<<
 * ```
 *
 * If the markers already exist, the block between them is replaced with the
 * current `paths` (so removing a skill from {@link SKILL_GIT_EXCLUDE_PATHS}
 * later removes its exclude line on the next install). If the markers don't
 * exist, the block is appended.
 *
 * **Never throws.** Logs and returns false on any I/O / git error so a broken
 * `.git/info/exclude` setup doesn't break `jolli enable` for the whole user.
 */
export async function updateGitExclude(projectDir: string, paths: ReadonlyArray<string>): Promise<boolean> {
	const excludePath = await resolveGitExcludePath(projectDir);
	if (!excludePath) {
		log.warn("Skipping .git/info/exclude update for %s: not a git repo or git unavailable", projectDir);
		return false;
	}

	let existing = "";
	try {
		existing = await readFile(excludePath, "utf-8");
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		/* v8 ignore start -- defensive: non-ENOENT read errors (perm denied, EISDIR) */
		if (code !== "ENOENT") {
			log.warn("Failed to read %s: %s — skipping update", excludePath, (err as Error).message);
			return false;
		}
		/* v8 ignore stop */
	}

	const managedBlock = renderBlock(paths);
	const updated = applyBlock(existing, managedBlock);

	if (updated === existing) {
		return true; // No change needed.
	}

	try {
		await mkdir(dirname(excludePath), { recursive: true });
		await writeFile(excludePath, updated, "utf-8");
		log.info("Updated %s with %d Jolli skill exclude paths", excludePath, paths.length);
		return true;
		/* v8 ignore start -- defensive: write failure on read-only fs / EPERM */
	} catch (err: unknown) {
		log.warn("Failed to write %s: %s", excludePath, (err as Error).message);
		return false;
	}
	/* v8 ignore stop */
}

/**
 * Renders the managed block including marker lines and a trailing newline.
 * Lines are joined with `\n` (git is happy with LF on every platform; using
 * the platform EOL here would diverge between developers on a team).
 */
function renderBlock(paths: ReadonlyArray<string>): string {
	const lines = [BLOCK_START, ...paths, BLOCK_END];
	return `${lines.join("\n")}\n`;
}

/**
 * Replaces an existing managed block in `existing`, or appends one if no
 * block is found. Preserves all other content verbatim.
 *
 * The scan is line-oriented and matches the marker lines exactly so a stray
 * `# >>> jolli skill exclude >>>` substring inside a comment elsewhere in the
 * file doesn't confuse the parser. The first matching marker pair wins —
 * duplicate blocks (which shouldn't happen but might after manual edits) are
 * left in place; only the first is rewritten.
 */
function applyBlock(existing: string, managedBlock: string): string {
	const lines = existing.split("\n");
	const startIdx = lines.indexOf(BLOCK_START);
	const endIdx = lines.indexOf(BLOCK_END);

	// `renderBlock` always appends a trailing `\n`; strip it before splitting so
	// the spliced lines don't carry an empty trailing element.
	const newBlockLines = managedBlock.slice(0, -1).split("\n");

	if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
		const next = [...lines.slice(0, startIdx), ...newBlockLines, ...lines.slice(endIdx + 1)];
		return next.join("\n");
	}

	if (existing.length === 0) {
		return managedBlock;
	}
	const sep = existing.endsWith("\n") ? "" : "\n";
	return `${existing}${sep}${managedBlock}`;
}
