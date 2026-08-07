/**
 * FileDiscardService
 *
 * Reverts working-tree changes for a set of files — the single owner of "what
 * discarding THIS file actually does".
 *
 * SHARED BY BOTH IDE HOSTS. That is the whole point of the module: the dispatch
 * below is a data-model rule ("does removing this row also unlink its backing
 * file?"), and a host-side restatement of it cannot be checked against this one
 * — nothing on the JSON wire fails when the two disagree. The IntelliJ port that
 * this replaced handled three of the six cases: it matched untracked as the raw
 * `"??"` while every producer in that host collapses a status to one character,
 * so untracked files fell through to `git checkout HEAD -- <path>` and silently
 * did nothing; and it had no case at all for renames or copies, which cannot be
 * discarded correctly without the original path — a field its file model never
 * carried.
 *
 * **Callers pass PATHS, not statuses.** Resolving each path's status here, from
 * one authoritative `git status` read, is what makes that class of bug
 * impossible: a host never has to understand porcelain columns, cannot collapse
 * them lossily on the way in, and cannot go stale between rendering a row and
 * the user clicking it.
 *
 * **Nothing fails silently.** Every outcome is reported per path. The behaviour
 * being replaced swallowed both halves — a failed `git` exit code was discarded
 * and `File.delete()`'s false return was ignored — which is exactly how "the
 * confirmation dialog appears, you click through, and the file is still there"
 * became the user-visible symptom with nothing in any log. The status read is
 * held to the same standard: a `git status` that could not run is reported as
 * `status-unavailable` on every requested path, NEVER as `not-found`. Collapsing
 * the two reproduces the exact symptom this module exists to remove — `execGit`
 * turns a missing `git` binary into `exitCode: 127` rather than throwing, and a
 * daemon spawned by a GUI-launched IDE gets a stripped PATH, so "git is not
 * reachable" is a real deployment, not a hypothetical one.
 *
 * **Paths reach git as `:(literal)` pathspecs.** A bare path is matched as a
 * GLOB: asking to restore `a[1].txt` silently reverts `a1.txt` instead and exits
 * 0, so the outcome claims success for a file it never touched while destroying
 * a different file's edits. `:(literal)` is what makes "nothing outside the
 * requested set is touched" true rather than merely intended.
 *
 * **Every path in here is relative to the WORKTREE ROOT, not to the caller's
 * `cwd`.** `resolveWorktreeRoot` anchors it once on the way in, because the three
 * things this module does with a path disagree otherwise — see that function for
 * the measurement.
 *
 * **A removal is never the last word on a path git still has content for.** The
 * two ways that went wrong both ended in a deleted file and `ok: true`, and both
 * are guarded below rather than left to the caller: a capitalisation-only rename
 * is a single directory entry on a case-insensitive filesystem, so removing the
 * new path deletes the file the revert just restored; and a conflicted `AA` /
 * `AU` row puts an `A` in the index column, which used to route it into the
 * staged-addition group and delete a file HEAD still had.
 */

import { lstat, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import { execGit, literalPathspec } from "./GitOps.js";

const log = createLogger("FileDiscardService");

/**
 * Which operation this path needed. Reported per path so a caller can explain a
 * partial failure.
 *
 * Read it together with `ok`: on success it is what the discard DID, and on
 * failure it is what was ATTEMPTED — a `unstaged-and-deleted` that failed while
 * unstaging never reached the delete. The pair is what a caller renders, never
 * the action alone.
 */
export type DiscardAction =
	/**
	 * `git restore` — worktree only, or worktree + index when the change was
	 * staged. Also the answer for a conflicted path HEAD has a version of, where
	 * going back to HEAD resolves the conflict in favour of ours.
	 */
	| "restored"
	/**
	 * Unstaged, then removed from disk because HEAD has no version to come back
	 * to: a staged addition or copy, or a conflicted path that exists only on the
	 * incoming side.
	 */
	| "unstaged-and-deleted"
	/** Untracked: removed from disk. */
	| "deleted"
	/** Rename: both paths unstaged, the original restored, the new path removed. */
	| "rename-reverted"
	/** The path had no pending change — already clean, or discarded by someone else. */
	| "not-found"
	/** `git status` could not run, so nothing was classified and nothing was touched. */
	| "status-unavailable"
	/** The caller sent an empty or blank path, which names no file. Always `ok: false`. */
	| "invalid-path"
	/** Internal: the path reached no group and no group recorded it. Always `ok: false`. */
	| "unclassified";

export interface DiscardOutcome {
	relativePath: string;
	ok: boolean;
	action: DiscardAction;
	/** Populated when `ok` is false: the git stderr or filesystem error that stopped it. */
	error?: string;
	/**
	 * OTHER repo-relative paths this discard changed on disk, beyond
	 * `relativePath`. Present only for a rename revert, which restores the
	 * original path as well as removing the new one.
	 *
	 * A host that mirrors the working tree MUST refresh these too. IntelliJ's
	 * file list is built from the VFS, so a restored original that the IDE was
	 * never told about stays invisible — and the panel keeps rendering the row
	 * for a rename it just successfully reverted. Populated even when `ok` is
	 * false: the revert is two git calls, and the first may have landed.
	 */
	additionalPaths?: Array<string>;
}

/** What discarding one path WOULD do, without doing it. See {@link previewDiscard}. */
export interface DiscardPreview {
	relativePath: string;
	/**
	 * True when discarding removes the file at this path rather than restoring it
	 * in place — the one thing a confirmation prompt has to get right, since the
	 * user cannot undo either outcome.
	 *
	 * `false` is also the answer for a path with nothing pending, a blank path,
	 * and a `git status` that could not run: none of those deletes anything, and
	 * the discard itself reports the real reason afterwards.
	 */
	deletesFile: boolean;
}

/** One row of `git status -z --porcelain=v1`, with the columns kept UNcollapsed. */
interface PorcelainEntry {
	relativePath: string;
	/** Index column: a single character, `" "` when clean. */
	indexStatus: string;
	/** Worktree column: a single character, `" "` when clean. */
	worktreeStatus: string;
	/** Present for renames and copies only — the path the file came from. */
	originalPath?: string;
}

/** Outcome of the status read: the entries, or the reason there are none. */
interface StatusRead {
	entries: Map<string, PorcelainEntry>;
	/**
	 * Set when `git status` itself failed. Distinguishing this from "the tree is
	 * clean" is load-bearing: an empty map otherwise makes every requested path
	 * look already-discarded, which both hosts render as a silent success.
	 */
	error?: string;
}

/**
 * Anchors the caller's `cwd` to its worktree root, so every path below has ONE
 * meaning.
 *
 * `git status --porcelain` reports paths relative to the repository root wherever
 * it ran, while a pathspec and a `join(cwd, …)` are both relative to `cwd`. Left
 * unnormalised those three disagree the moment `cwd` is a subdirectory, and the
 * halves fail differently: the status lookup still matches (both sides come from
 * git), `git restore` fails loudly on a pathspec it cannot find — and the DELETE
 * lands on `<cwd>/<subdir>/<file>`, which does not exist, so `removeFromDisk`
 * swallows the ENOENT and the outcome reports `ok: true` for a file that is still
 * on disk (measured). That is the silent success this module exists to remove, so
 * it is closed here instead of being trusted to every caller — each of which
 * carries a fallback to an unresolved directory for the case where git could not
 * be asked (IntelliJ's `WorktreeRoot.of`, VS Code's workspace folder).
 *
 * It does NOT rescue a caller whose PATHS are relative to something else: the
 * status lookup then finds nothing for them and every one comes back `not-found`
 * with `ok: true`. Both hosts send paths relative to this same root for that
 * reason.
 *
 * Falls back to `cwd` when git cannot answer (not a repo, git missing): the
 * `git status` immediately after fails for the same reason, and every requested
 * path is then reported as `status-unavailable`.
 */
async function resolveWorktreeRoot(cwd: string): Promise<string> {
	const result = await execGit(["rev-parse", "--show-toplevel"], cwd);
	const root = result.stdout.trim();
	/* v8 ignore next -- the no-repo case takes this branch through the nonzero
	   exit, so the empty-stdout half never evaluates: it is the same failure
	   reported a second way, kept because trusting one of git's two signals is how
	   an empty root would reach `join` and produce absolute-looking nonsense */
	if (result.exitCode !== 0 || root === "") {
		return cwd;
	}
	return root;
}

/**
 * Reads every pending change, keyed by path.
 *
 * `-uall` expands untracked directories into their individual files, matching
 * what both sidebars list — without it a new folder is one `?? dir/` row, and a
 * caller asking to discard a file inside it would find no entry.
 */
async function readStatus(cwd: string): Promise<StatusRead> {
	const result = await execGit(["status", "-z", "--porcelain=v1", "-uall"], cwd);
	const entries = new Map<string, PorcelainEntry>();
	if (result.exitCode !== 0) {
		log.warn("git status failed (exit %d): %s", result.exitCode, result.stderr);
		return { entries, error: gitError(result.stderr, result.exitCode) };
	}

	// -z format: NUL-separated. Normal entry "XY PATH\0";
	// rename/copy "XY NEWPATH\0OLDPATH\0" — the original path is its OWN segment.
	const segments = result.stdout.split("\0");
	let i = 0;
	while (i < segments.length) {
		const segment = segments[i];
		if (segment === undefined || segment.length < 3) {
			i++;
			continue;
		}
		const indexStatus = segment[0] as string;
		const worktreeStatus = segment[1] as string;
		const relativePath = segment.substring(3);
		let originalPath: string | undefined;
		if (indexStatus === "R" || indexStatus === "C") {
			i++;
			originalPath = segments[i];
		}
		// ONE path can produce TWO rows, and the later one must not displace the
		// tracked one. `git rm --cached foo.txt` leaves a staged deletion in the
		// index while the file stays on disk, so status reports BOTH
		// `D  foo.txt` and `?? foo.txt` (measured): the index diff and the
		// untracked scan are separate walks, and a path the index no longer has
		// is reachable by the second one. Last-write-wins let `??` win, the path
		// was classified untracked, and the discard DELETED the file while the
		// staged deletion stayed in the index — reported `ok: true`, with the row
		// still on screen afterwards because the `D ` half survived.
		//
		// The tracked row is the right answer: `restore --staged --worktree`
		// brings the index entry and the file back, leaving a clean tree
		// (measured), which is what VS Code did before the rule moved here.
		//
		// Written as PRECEDENCE rather than "keep whichever came first". Git emits
		// the index rows ahead of the untracked ones today, but that ordering is
		// not part of the porcelain contract, and a rule leaning on it would break
		// the same silent way if it ever changed. Only an untracked row can lose:
		// a tracked path has exactly one index state and one worktree state, so
		// two tracked rows for one path cannot happen, and neither can two
		// untracked ones.
		const isUntrackedRow = indexStatus === "?" && worktreeStatus === "?";
		if (!(isUntrackedRow && entries.has(relativePath))) {
			entries.set(relativePath, {
				relativePath,
				indexStatus,
				worktreeStatus,
				...(originalPath !== undefined && originalPath !== "" && { originalPath }),
			});
		}
		i++;
	}
	return { entries };
}

/**
 * Removes a file or directory. ENOENT is success, not failure — the path being
 * gone is the outcome we wanted, and something else deleting it between the
 * status read and here is a race we should not report as an error.
 */
async function removeFromDisk(absolutePath: string): Promise<void> {
	try {
		const stat = await lstat(absolutePath);
		/* v8 ignore next 3 -- defensive: `-uall` expands untracked directories into
		   their files, so every path we classify is a file. Kept because a caller
		   supplies the path and an unexpanded directory (an uninitialised submodule)
		   must not fall through to `unlink`, which cannot remove one. */
		if (stat.isDirectory()) {
			await rm(absolutePath, { recursive: true });
		} else {
			await unlink(absolutePath);
		}
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw error;
	}
}

/**
 * Human-readable reason from a failed git call. The exit-code fallback is for a
 * git that fails while saying nothing on stderr — rare, but reporting a bare
 * "it failed" still beats reporting success, which is the failure mode this
 * module was written to eliminate.
 */
function gitError(stderr: string, exitCode: number): string {
	/* v8 ignore next -- the empty-stderr half is not reproducible against real git */
	return stderr.trim() !== "" ? stderr.trim() : `git exited with code ${exitCode}`;
}

/**
 * True for a conflicted (unmerged) entry — git's own seven shapes: `DD`, `AU`,
 * `UD`, `UA`, `DU`, `AA`, `UU`. Every one carries a `U` in a column, except the
 * two that repeat the same letter.
 *
 * This MUST be tested before the `A` / `C` dispatch. `AA` and `AU` both put an
 * `A` in the index column, so they used to land in the staged-addition group and
 * be unstaged and DELETED — measured on a real `AA` conflict whose file HEAD
 * still had, reported as `ok: true`, leaving ` D <path>`. `UU` was unaffected only
 * by luck: its `U` fell through to the staged-worktree group, which happens to be
 * the right answer for it.
 */
function isUnmerged(indexStatus: string, worktreeStatus: string): boolean {
	if (indexStatus === "U" || worktreeStatus === "U") {
		return true;
	}
	return indexStatus === worktreeStatus && (indexStatus === "A" || indexStatus === "D");
}

/** Which of the six operations a row needs. */
type DiscardGroup = "unmerged" | "renamed" | "added" | "untracked" | "staged-worktree" | "worktree-only";

/**
 * The single dispatch table, shared by {@link discardFiles} and
 * {@link previewDiscard}.
 *
 * Extracted rather than written twice on purpose: the sentence the user reads
 * before clicking ("this will discard changes to X" vs "this will permanently
 * delete X") and the code that decides which of those actually happens have to
 * be the same rule. Two copies of it is precisely how the rename/copy wording
 * bug reached production in BOTH hosts at once, each omitting a different
 * letter, telling the user the file would stay while the button removed it.
 */
function classifyEntry(entry: PorcelainEntry): DiscardGroup {
	const { indexStatus, worktreeStatus } = entry;
	// MUST stay first: `AA` and `AU` also carry an `A` in the index column, and
	// would otherwise be treated as staged additions and deleted.
	if (isUnmerged(indexStatus, worktreeStatus)) {
		return "unmerged";
	}
	if (indexStatus === "R") {
		return "renamed";
	}
	if (indexStatus === "A" || indexStatus === "C") {
		return "added";
	}
	if (indexStatus === "?" && worktreeStatus === "?") {
		return "untracked";
	}
	if (indexStatus !== " " && indexStatus !== "?") {
		return "staged-worktree";
	}
	return "worktree-only";
}

/**
 * The command that drops the index entries for staged ADDITIONS — chosen by
 * asking git whether HEAD resolves to a commit at all.
 *
 * `git restore --staged` restores the index FROM a tree, so before the first
 * commit there is nothing to restore from and it refuses the whole batch with
 * `fatal: could not resolve HEAD` (exit 128, measured). Every staged file in a
 * fresh `git init` is an addition, so without this branch the FILES panel's
 * Discard cannot work at all in a repo the user has not committed to yet — it
 * fails loudly, which is at least honest, but it fails for every file.
 *
 * `git rm --cached` needs no HEAD, and for an addition the two are the same
 * operation: the index entry goes away and the path becomes untracked. `--force`
 * is required rather than defensive — git refuses an unforced `rm --cached` when
 * the staged content differs from BOTH the worktree and HEAD (an `AM` row,
 * measured), and the file is about to be deleted regardless. It stays scoped to
 * the unborn-HEAD case: with a HEAD present, `restore --staged` is the narrower
 * command and needs no force.
 *
 * Probed once per call rather than per path — `--verify --quiet` exits 1 on an
 * unborn HEAD and prints nothing.
 */
async function unstageAdditionsArgs(cwd: string, pathspecs: ReadonlyArray<string>): Promise<Array<string>> {
	const head = await execGit(["rev-parse", "--verify", "--quiet", "HEAD"], cwd);
	return head.exitCode === 0
		? ["restore", "--staged", "--", ...pathspecs]
		: ["rm", "--cached", "--force", "--quiet", "--", ...pathspecs];
}

/**
 * Whether HEAD has a version of [relativePath] — which is what decides between
 * restoring a conflicted path and removing it.
 *
 * Asked of git rather than derived from the porcelain columns, because the
 * unmerged shapes do not encode it consistently: `UA` ("added by them") shows a
 * `U` in the index column while HEAD has nothing at all, so the obvious
 * column-based rule is wrong for exactly the shape whose file must be removed. A
 * hand-written table of which of the seven shapes HEAD covers is the kind of
 * restatement that is wrong silently.
 *
 * `ls-tree` exits 0 whether or not the path matched, so PRESENCE is the non-empty
 * stdout, never the exit code. A git that cannot run answers "absent", which
 * routes to the unstage-and-remove half — where the unstage fails loudly before
 * anything is deleted, so a broken git cannot turn into data loss.
 */
async function headHasPath(cwd: string, relativePath: string): Promise<boolean> {
	const result = await execGit(["ls-tree", "-r", "HEAD", "--", literalPathspec(relativePath)], cwd);
	/* v8 ignore next -- `ls-tree` exits 0 for a matched and an unmatched path
	   alike, so the nonzero half only happens when git itself cannot run — which
	   the status read one step earlier has already turned into status-unavailable */
	return result.exitCode === 0 && result.stdout.trim() !== "";
}

/**
 * Discards the working-tree changes for [relativePaths], returning one outcome
 * per requested path in the order given.
 *
 * Paths are grouped by the operation they need so each git command runs once per
 * group rather than once per file — N separate invocations contend on
 * `index.lock` and turn a multi-file discard into a partial one.
 *
 * A path with no pending change yields `not-found` with `ok: true`: the caller
 * asked for a state that already holds. A path outside the repo is not special
 * cased — git reports it as untracked or absent, and either way nothing outside
 * the requested set is touched.
 *
 * When the status read itself fails, EVERY path comes back `ok: false` with
 * `status-unavailable`. That is not the same answer as `not-found`, and a caller
 * must not treat it as one: nothing was classified, so nothing was discarded.
 *
 * An empty or blank path is rejected per path with `invalid-path` rather than
 * falling into `not-found` — see the loop below for why that distinction is the
 * whole point.
 */
export async function discardFiles(cwd: string, relativePaths: ReadonlyArray<string>): Promise<Array<DiscardOutcome>> {
	if (relativePaths.length === 0) {
		return [];
	}

	// Every path below is worktree-root relative, so every git call and every
	// `join` uses the root rather than the cwd the caller happened to pass.
	const root = await resolveWorktreeRoot(cwd);
	const status = await readStatus(root);
	const statusError = status.error;
	if (statusError !== undefined) {
		return relativePaths.map((relativePath) => ({
			relativePath,
			ok: false,
			action: "status-unavailable" as const,
			error: statusError,
		}));
	}
	const outcomes = new Map<string, DiscardOutcome>();

	// Group by required operation, mirroring git's own semantics:
	//   conflicted (unmerged)          → back to HEAD, or unstage + delete when HEAD has no version
	//   staged (index column set)      → restore index AND worktree
	//   worktree-only                  → restore worktree, leave the index alone
	//   added / copied                 → unstage, then delete (HEAD has no version)
	//   untracked                      → delete
	//   renamed                        → unstage both paths, restore the original, delete the new one
	const unmerged: Array<PorcelainEntry> = [];
	const stagedWorktree: Array<string> = [];
	const worktreeOnly: Array<string> = [];
	const added: Array<PorcelainEntry> = [];
	const untracked: Array<PorcelainEntry> = [];
	const renamed: Array<PorcelainEntry> = [];

	for (const relativePath of relativePaths) {
		// An empty or blank path names no file, so it can only be a caller bug —
		// and it must NOT reach the `not-found` line below, which reports `ok: true`
		// on the premise that the caller asked for a state that already holds. A
		// blank path holds no state; answering "already clean" makes a malformed
		// request indistinguishable from a working button, which is the exact
		// symptom this module exists to remove. It is reachable: every webview
		// producer falls back to `''` when the row element cannot be resolved, and
		// the host-side guard that used to reject that shape was removed once the
		// porcelain columns stopped being an input.
		if (relativePath.trim() === "") {
			outcomes.set(relativePath, {
				relativePath,
				ok: false,
				action: "invalid-path",
				error: "no file path was provided",
			});
			continue;
		}
		const entry = status.entries.get(relativePath);
		if (entry === undefined) {
			outcomes.set(relativePath, { relativePath, ok: true, action: "not-found" });
			continue;
		}
		switch (classifyEntry(entry)) {
			case "unmerged":
				unmerged.push(entry);
				break;
			case "renamed":
				renamed.push(entry);
				break;
			case "added":
				added.push(entry);
				break;
			case "untracked":
				untracked.push(entry);
				break;
			case "staged-worktree":
				stagedWorktree.push(relativePath);
				break;
			default:
				worktreeOnly.push(relativePath);
				break;
		}
	}

	// `additionalPaths` is either absent or non-empty — callers pass `undefined`
	// rather than `[]`, so there is no empty-array case to test for here.
	const record = (
		relativePath: string,
		action: DiscardAction,
		error?: string,
		additionalPaths?: ReadonlyArray<string>,
	): void => {
		outcomes.set(relativePath, {
			relativePath,
			ok: error === undefined,
			action,
			...(error !== undefined && { error }),
			...(additionalPaths !== undefined && { additionalPaths: [...additionalPaths] }),
		});
	};

	// 1. Staged changes — index and worktree both go back to HEAD.
	if (stagedWorktree.length > 0) {
		const args = ["restore", "--staged", "--worktree", "--", ...stagedWorktree.map(literalPathspec)];
		const result = await execGit(args, root);
		const error = result.exitCode === 0 ? undefined : gitError(result.stderr, result.exitCode);
		for (const relativePath of stagedWorktree) {
			record(relativePath, "restored", error);
		}
	}

	// 2. Worktree-only changes — the index keeps whatever the user staged.
	if (worktreeOnly.length > 0) {
		const result = await execGit(["restore", "--", ...worktreeOnly.map(literalPathspec)], root);
		const error = result.exitCode === 0 ? undefined : gitError(result.stderr, result.exitCode);
		for (const relativePath of worktreeOnly) {
			record(relativePath, "restored", error);
		}
	}

	// 3. Staged additions and copies — unstage as one batch, then delete each file.
	if (added.length > 0) {
		const paths = added.map((entry) => literalPathspec(entry.relativePath));
		const result = await execGit(await unstageAdditionsArgs(root, paths), root);
		const unstageError = result.exitCode === 0 ? undefined : gitError(result.stderr, result.exitCode);
		for (const entry of added) {
			if (unstageError !== undefined) {
				// The delete never ran — `unstaged-and-deleted` here is the operation
				// this path NEEDED, not one that completed. That is the documented
				// reading of `action` whenever `ok` is false; the alternative (a
				// separate action per failure point) multiplies the vocabulary
				// hosts have to know without telling them anything `error` does not.
				record(entry.relativePath, "unstaged-and-deleted", unstageError);
				continue;
			}
			record(entry.relativePath, "unstaged-and-deleted", await tryRemove(root, entry.relativePath));
		}
	}

	// 4. Renames — one file at a time: each carries its own original path.
	// The original path is reported unconditionally: the revert is two git calls
	// and the first may have landed, so a host must refresh it either way.
	for (const entry of renamed) {
		const error = await revertRename(root, entry);
		/* v8 ignore next -- the no-originalPath half is unreachable for a real `R` row */
		const alsoChanged = entry.originalPath !== undefined ? [entry.originalPath] : undefined;
		record(entry.relativePath, "rename-reverted", error, alsoChanged);
	}

	// 5. Untracked — nothing in git to restore, so this is purely a delete.
	for (const entry of untracked) {
		record(entry.relativePath, "deleted", await tryRemove(root, entry.relativePath));
	}

	// 6. Conflicted paths — one at a time, because which operation each needs
	// depends on whether HEAD has a version and only git can answer that per path.
	// Batching is pointless here anyway: a tree mid-merge has a handful of these,
	// not the hundreds the groups above are batched for.
	for (const entry of unmerged) {
		const resolved = await discardUnmerged(root, entry.relativePath);
		record(entry.relativePath, resolved.action, resolved.error);
	}

	// Every requested path was recorded above — either classified into a group and
	// recorded by it, or short-circuited to not-found / invalid-path. The fallback
	// exists so the return type needs no assertion, and it reports FAILURE rather
	// than a clean not-found: a future group added without a matching `record`
	// means the path was never acted on, and saying "already clean" about it is the
	// same silent success this module was written to remove. It carries its OWN
	// action rather than borrowing `not-found` — that value is documented as "the
	// state you asked for already holds", and spelling two opposite meanings with
	// one string leaves `ok` as the only thing telling them apart.
	return relativePaths.map(
		(relativePath) =>
			/* v8 ignore next 6 -- unreachable today; see above */
			outcomes.get(relativePath) ?? {
				relativePath,
				ok: false,
				action: "unclassified" as const,
				error: "internal error: path was never classified",
			},
	);
}

/**
 * Answers "would discarding these paths DELETE the files?" without touching
 * anything. Callers use it to word their confirmation prompt.
 *
 * This lives here, and not in either host, because the answer is not derivable
 * from what a host holds. Both collapse git's two porcelain columns to one
 * character before a row reaches the UI, and that character is ambiguous in
 * exactly the cases that matter: `D ` (a staged deletion, which discard
 * RESTORES) and `DU` / `DD` (conflicts whose file discard REMOVES) all collapse
 * to `"D"`, while `UU` / `UD` (restored) and `UA` (removed) all collapse to
 * `"U"`. IntelliJ cannot even recover the columns — its list comes from
 * `ChangeListManager`, whose `Change.Type` has no conflicted case at all.
 *
 * The conflicted split is asked of git per path for the same reason
 * {@link discardFiles} asks it: `UA` shows a `U` in the index column while HEAD
 * has nothing, so a column-based table is wrong for precisely the shape whose
 * file gets deleted.
 *
 * Read-only — no index, worktree or ref is written. Safe to call before the
 * user has confirmed anything.
 */
export async function previewDiscard(
	cwd: string,
	relativePaths: ReadonlyArray<string>,
): Promise<Array<DiscardPreview>> {
	if (relativePaths.length === 0) {
		return [];
	}
	const root = await resolveWorktreeRoot(cwd);
	const status = await readStatus(root);
	const previews: Array<DiscardPreview> = [];
	for (const relativePath of relativePaths) {
		// A failed status read means we know nothing, and the milder verb is the
		// honest one: nothing has been deleted, and the discard the user is about
		// to confirm will report `status-unavailable` rather than quietly
		// succeeding. Promising a deletion we cannot substantiate would push them
		// to cancel a discard that would have worked.
		const entry = status.error !== undefined ? undefined : status.entries.get(relativePath);
		previews.push({
			relativePath,
			deletesFile: entry === undefined ? false : await previewDeletesFile(root, entry),
		});
	}
	return previews;
}

/** Whether the group {@link classifyEntry} picked ends with the file gone. */
async function previewDeletesFile(root: string, entry: PorcelainEntry): Promise<boolean> {
	switch (classifyEntry(entry)) {
		// Untracked has no HEAD version; a staged addition or copy has none for
		// THIS path; a rename revert brings the content back under the ORIGINAL
		// name and removes the new one.
		case "untracked":
		case "added":
		case "renamed":
			return true;
		case "unmerged":
			return !(await headHasPath(root, entry.relativePath));
		default:
			return false;
	}
}

/** Deletes one repo-relative path; returns an error string, or undefined on success. */
async function tryRemove(cwd: string, relativePath: string): Promise<string | undefined> {
	try {
		await removeFromDisk(join(cwd, relativePath));
		return undefined;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		log.warn("failed to remove %s: %s", relativePath, message);
		return message;
	}
}

/**
 * Undoes a staged rename: unstage both paths so the index forgets the move,
 * restore the original path's content, then remove the file at the new path.
 *
 * A rename row always carries `originalPath` — git emits it as the segment right
 * after the path. The undefined guards below are for a malformed stream only; the
 * degradation is the added-file treatment (unstage + delete) rather than a guess
 * at which file the rename came from.
 */
async function revertRename(cwd: string, entry: PorcelainEntry): Promise<string | undefined> {
	const { relativePath, originalPath } = entry;
	/* v8 ignore next -- the no-originalPath half is unreachable for a real `R` row */
	const unstagePaths = originalPath !== undefined ? [relativePath, originalPath] : [relativePath];
	const unstage = await execGit(["restore", "--staged", "--", ...unstagePaths.map(literalPathspec)], cwd);
	if (unstage.exitCode !== 0) {
		return gitError(unstage.stderr, unstage.exitCode);
	}
	if (originalPath !== undefined) {
		const restore = await execGit(["restore", "--", literalPathspec(originalPath)], cwd);
		/* v8 ignore next 3 -- unstage above succeeded, so this restore cannot fail
		   for lock reasons, and no other reproducible cause exists */
		if (restore.exitCode !== 0) {
			return gitError(restore.stderr, restore.exitCode);
		}
		// A rename that changed only capitalisation is ONE directory entry on a
		// case-insensitive filesystem — macOS and Windows, i.e. most of this
		// product's users — so the restore above wrote the content back into the
		// very file the removal below would delete. Measured: `git mv Foo.txt
		// foo.txt` then discarding `foo.txt` left NEITHER path on disk (` D
		// Foo.txt`) and still answered `ok: true` — the user confirmed "undo the
		// rename" and got the file deleted.
		//
		// The revert is already complete at this point: the content is back under
		// the original name and the index has forgotten the move, so returning here
		// skips a removal, not a step.
		if (await isSameFileOnDisk(join(cwd, relativePath), join(cwd, originalPath))) {
			return undefined;
		}
	}
	return await tryRemove(cwd, relativePath);
}

/**
 * Whether two paths name the same file on disk, by device + inode.
 *
 * Deliberately NOT a case-insensitive string compare: on a genuinely
 * case-sensitive filesystem `Foo.txt` and `foo.txt` are two real files and the
 * new one still has to be removed, which is exactly what comparing identity
 * rather than spelling gets right on both platforms.
 *
 * Any stat failure answers false, so the caller falls through to the removal it
 * performs for every other rename — a stat that could not run can never skip a
 * removal that was needed.
 */
async function isSameFileOnDisk(a: string, b: string): Promise<boolean> {
	try {
		const [statA, statB] = await Promise.all([lstat(a), lstat(b)]);
		return statA.dev === statB.dev && statA.ino === statB.ino;
		/* v8 ignore next 3 -- both paths exist whenever this runs: the restore just
		   wrote one and the rename left the other, so only a filesystem-level fault
		   reaches here. The false it answers is the pre-existing behaviour. */
	} catch {
		return false;
	}
}

/**
 * Discards one conflicted (unmerged) path, returning the action taken and the
 * reason it failed, if it did.
 *
 * Two shapes, split by whether HEAD has a version:
 *
 * - HEAD HAS it (`UU`, `AA`, `AU`, `UD`): discard means what it means everywhere
 *   else — put the path back to its HEAD content. That also resolves the conflict
 *   in favour of ours, which is the same thing `UU` has always done here.
 * - HEAD has NO version (`DD`, `DU`, `UA`): there is nothing to restore, so the
 *   index entry is dropped and the file the incoming side brought in is removed.
 *
 * The unstage uses `git reset`, not `git restore --staged`, and that is not
 * interchangeable: `restore --staged` REFUSES an unmerged path outright
 * (`error: path '…' is unmerged`, exit 1) while `reset` drops the conflict
 * entry — both measured. Getting this wrong is not a silent failure at least, but
 * it is a discard that reports an error and does nothing.
 */
async function discardUnmerged(cwd: string, relativePath: string): Promise<{ action: DiscardAction; error?: string }> {
	if (await headHasPath(cwd, relativePath)) {
		const result = await execGit(["restore", "--staged", "--worktree", "--", literalPathspec(relativePath)], cwd);
		if (result.exitCode !== 0) {
			return { action: "restored", error: gitError(result.stderr, result.exitCode) };
		}
		return { action: "restored" };
	}
	const reset = await execGit(["reset", "-q", "--", literalPathspec(relativePath)], cwd);
	if (reset.exitCode !== 0) {
		return { action: "unstaged-and-deleted", error: gitError(reset.stderr, reset.exitCode) };
	}
	const removeError = await tryRemove(cwd, relativePath);
	return removeError === undefined
		? { action: "unstaged-and-deleted" }
		: { action: "unstaged-and-deleted", error: removeError };
}
