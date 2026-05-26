/**
 * `git status --porcelain -z` parser shared by `listDirtyPaths` (existing
 * flat-paths API) and `stageVault` (needs structured per-entry status +
 * rename source path).
 *
 * Extracted from the original `GitClient.listDirtyPaths` body so the two
 * callers stay aligned on the same NUL-record-aware parsing — the format's
 * quirks (rename source paths span a second record without a status prefix,
 * paths can contain spaces, the third byte after `XY` is a space normally
 * but raw bytes in a rename trailer) are subtle enough that a second parser
 * would inevitably drift.
 *
 * Format reference (verbatim from `git status` documentation):
 *
 *   Each NUL-terminated record either starts with `XY pathspec` (X = index
 *   status vs HEAD, Y = worktree status vs index) OR is a raw path
 *   continuation of a preceding rename / copy entry. Renames look like
 *
 *       "R  new-path\0old-path\0"
 *
 *   where the FIRST record is `R<space><space>new-path` (the `R` in either
 *   X or Y slot) and the SECOND record is `old-path` with no status prefix.
 *
 * The parser walks records one at a time. When it sees an `R`/`C` in either
 * status slot, it marks the next record as a rename source trailer and
 * pairs it with the preceding destination entry.
 */

/**
 * Status codes the parser recognises. Mirrors `git status --porcelain`
 * documentation; we treat any other character as falling into the catch-all
 * `"other"` bucket so a future git version's new status code doesn't crash
 * the round.
 */
export type PorcelainStatus =
	| "A" // added
	| "M" // modified
	| "D" // deleted
	| "R" // renamed
	| "C" // copied
	| "?" // untracked
	| "!" // ignored (only surfaces with `git status --ignored`)
	| "U" // unmerged (conflict)
	| "T" // type changed
	| " " // unchanged on this side (combined codes like ` M`, `M `, etc.)
	| "other";

export interface PorcelainEntry {
	/**
	 * Index-side status (`X` byte). For an untracked file this is `?`; for
	 * a worktree-only modification it's a space (` `).
	 */
	readonly indexStatus: PorcelainStatus;
	/**
	 * Worktree-side status (`Y` byte). Mirrors `indexStatus`'s semantics on
	 * the other side of the staging boundary.
	 */
	readonly worktreeStatus: PorcelainStatus;
	/**
	 * The path being reported. For renames / copies this is the NEW (or
	 * destination) path; the SOURCE path is in `oldPath`.
	 */
	readonly path: string;
	/**
	 * Source path for `R` / `C` entries. `undefined` for everything else.
	 * The parser sets this by pairing the rename-destination record with
	 * the immediately-following raw-path record.
	 */
	readonly oldPath?: string;
}

/**
 * Parse the raw stdout of `git status --porcelain -z` into structured
 * per-entry records. Returns an empty array for empty input (a clean tree).
 *
 * The parser tolerates malformed records (length < 3, missing status
 * bytes) by silently dropping them. This matches the existing
 * `listDirtyPaths` behavior and avoids hard-failing a sync round on a git
 * version that emits a record shape we don't recognise — the round
 * continues with whatever entries WERE parseable and the canary picks up
 * any dropped state on the next round.
 */
export function parsePorcelainZ(stdout: string): PorcelainEntry[] {
	if (stdout.length === 0) return [];
	// `-z` emits NUL terminators between records (and at the end). Splitting
	// on NUL leaves an empty trailing record we filter out.
	const records = stdout.split("\0").filter((r) => r.length > 0);
	const out: PorcelainEntry[] = [];
	let renameSourcePending = false;
	for (const rec of records) {
		if (renameSourcePending) {
			// This whole record is the source path of the most recently
			// pushed rename/copy entry. Attach it and clear the flag.
			const last = out[out.length - 1];
			if (last !== undefined) {
				// Re-emit the entry with oldPath populated. PorcelainEntry's
				// `oldPath` is readonly — we replace the last element rather
				// than mutating it.
				out[out.length - 1] = { ...last, oldPath: rec };
			}
			renameSourcePending = false;
			continue;
		}
		if (rec.length < 3) continue;
		const indexStatus = coerceStatus(rec.charAt(0));
		const worktreeStatus = coerceStatus(rec.charAt(1));
		// Standard records have a space at index 2, then the path. We
		// take everything from index 3 onward as the path — for the
		// rename-destination case the path string can itself contain
		// spaces and there's no further structure inside this record.
		const path = rec.substring(3);
		out.push({ indexStatus, worktreeStatus, path });
		// If either side is R or C, the NEXT record carries the source
		// path as a raw byte stream — flag for the next iteration.
		if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
			renameSourcePending = true;
		}
	}
	return out;
}

/**
 * Coerces a single status character into the `PorcelainStatus` enum.
 * Unknown characters fall through to `"other"` — a defensive surface so
 * a future git addition (or an unexpected line we haven't seen) doesn't
 * crash the sync round.
 */
function coerceStatus(ch: string): PorcelainStatus {
	switch (ch) {
		case "A":
		case "M":
		case "D":
		case "R":
		case "C":
		case "?":
		case "!":
		case "U":
		case "T":
		case " ":
			return ch;
		default:
			return "other";
	}
}

/**
 * True when the entry represents a deletion FROM the working tree's
 * perspective — meaning `stageVault` should map it to `git rm` rather than
 * `git add`. Covers both `D ` (already-staged delete) and ` D` (worktree
 * delete that needs staging). Excludes renames whose old path is the
 * "from" side — those are handled separately by decomposing the entry.
 */
export function isDeletion(entry: PorcelainEntry): boolean {
	return entry.indexStatus === "D" || entry.worktreeStatus === "D";
}
