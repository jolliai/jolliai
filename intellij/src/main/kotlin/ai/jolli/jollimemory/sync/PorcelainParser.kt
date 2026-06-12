package ai.jolli.jollimemory.sync

/**
 * Parses `git status --porcelain -z` output into structured per-entry records.
 *
 * Port of `cli/src/sync/PorcelainParser.ts`.
 */

/**
 * Status codes from `git status --porcelain`. Maps each character to a
 * semantic label; unknown characters fall through to [OTHER] so a future
 * git version doesn't crash the sync round.
 */
enum class PorcelainStatus {
	A, M, D, R, C,
	UNTRACKED,    // '?'
	IGNORED,      // '!'
	UNMERGED,     // 'U'
	TYPE_CHANGED, // 'T'
	UNCHANGED,    // ' '
	OTHER,
}

/**
 * One entry from `git status --porcelain -z`.
 *
 * @property indexStatus   First status character — staged state vs HEAD.
 * @property worktreeStatus Second status character — worktree state vs index.
 * @property path          The file path (destination path for renames).
 * @property oldPath       Source path for R/C entries; null otherwise.
 */
data class PorcelainEntry(
	val indexStatus: PorcelainStatus,
	val worktreeStatus: PorcelainStatus,
	val path: String,
	val oldPath: String? = null,
)

/**
 * Parses raw stdout of `git status --porcelain -z` into structured entries.
 *
 * The `-z` flag uses NUL separators. Rename entries (`R  new\0old\0`)
 * span two records: the first has the status + destination path, the
 * second is a raw source path with no status prefix.
 *
 * Malformed records (length < 3) are silently dropped.
 */
fun parsePorcelainZ(stdout: String): List<PorcelainEntry> {
	if (stdout.isEmpty()) return emptyList()

	val records = stdout.split("\u0000").filter { it.isNotEmpty() }
	val out = mutableListOf<PorcelainEntry>()
	var renameSourcePending = false

	for (rec in records) {
		if (renameSourcePending) {
			// This whole record is the source path of the most recently
			// pushed rename/copy entry.
			val last = out.lastOrNull()
			if (last != null) {
				out[out.lastIndex] = last.copy(oldPath = rec)
			}
			renameSourcePending = false
			continue
		}
		if (rec.length < 3) continue
		val indexStatus = coerceStatus(rec[0])
		val worktreeStatus = coerceStatus(rec[1])
		val path = rec.substring(3)
		out.add(PorcelainEntry(indexStatus, worktreeStatus, path))
		if (indexStatus == PorcelainStatus.R || indexStatus == PorcelainStatus.C ||
			worktreeStatus == PorcelainStatus.R || worktreeStatus == PorcelainStatus.C
		) {
			renameSourcePending = true
		}
	}
	return out
}

/**
 * True when the entry represents a deletion from the working tree's
 * perspective — `stageVault` should map it to `git rm` rather than `git add`.
 */
fun isDeletion(entry: PorcelainEntry): Boolean {
	return entry.indexStatus == PorcelainStatus.D || entry.worktreeStatus == PorcelainStatus.D
}

private fun coerceStatus(ch: Char): PorcelainStatus = when (ch) {
	'A' -> PorcelainStatus.A
	'M' -> PorcelainStatus.M
	'D' -> PorcelainStatus.D
	'R' -> PorcelainStatus.R
	'C' -> PorcelainStatus.C
	'?' -> PorcelainStatus.UNTRACKED
	'!' -> PorcelainStatus.IGNORED
	'U' -> PorcelainStatus.UNMERGED
	'T' -> PorcelainStatus.TYPE_CHANGED
	' ' -> PorcelainStatus.UNCHANGED
	else -> PorcelainStatus.OTHER
}
