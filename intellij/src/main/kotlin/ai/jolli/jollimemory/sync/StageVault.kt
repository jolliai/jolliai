package ai.jolli.jollimemory.sync

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path

/**
 * Allowlist-staging entry point — replaces `git add --all` for vault staging.
 *
 * Port of `cli/src/sync/StageVault.ts`.
 *
 * Flow:
 *   1. Snapshot `git status --porcelain -z` via [SyncGitClient.statusPorcelainZ].
 *   2. Decompose renames into discrete `(add new, del old)` operations.
 *   3. Classify each path via [classifyVaultPath].
 *   4. Symlink-check adds via [assertNoSymlinksInPath] + leaf lstat.
 *   5. Stage survivors via `git add -f` / `git rm` / `git reset HEAD --`.
 */

data class StageReport(
	val added: Int,
	val removed: Int,
	val skipped: Int,
	val unowned: List<String>,
	val symlinked: List<String>,
	val byKind: Map<String, Int>,
)

data class StageVaultOpts(val syncTranscripts: Boolean)

/**
 * Per-op intermediate used by the staging loop.
 */
private data class Op(
	val kind: String, // "add" or "del"
	val path: String,
	val staged: Boolean,
)

/**
 * Stages the vault's owned-path changes via `git add -f` / `git rm`.
 */
fun stageVault(client: SyncGitClient, vaultRoot: String, opts: StageVaultOpts): StageReport {
	val entries = client.statusPorcelainZ()
	val ops = decomposeOps(entries)

	val byKind = mutableMapOf<String, Int>()
	val toAdd = mutableListOf<String>()
	val toRm = mutableListOf<String>()
	val toReset = mutableListOf<String>()
	val unowned = mutableListOf<String>()
	val symlinked = mutableListOf<String>()
	var skipped = 0

	for (op in ops) {
		val kind = classifyVaultPath(op.path)
		if (kind == null) {
			unowned.add(op.path)
			bump(byKind, "unowned")
			if (op.staged) toReset.add(op.path)
			continue
		}
		if (kind == OwnedPathKind.TRANSCRIPT && !opts.syncTranscripts) {
			skipped++
			bump(byKind, "skipped")
			if (op.staged) toReset.add(op.path)
			continue
		}
		if (op.kind == "del") {
			toRm.add(op.path)
			bump(byKind, kind.name)
			continue
		}
		// Add path — verify symlink safety.
		val absPath = Path.of(vaultRoot, op.path).toString()
		val isOk = isSymlinkSafeForStaging(vaultRoot, absPath)
		if (!isOk) {
			symlinked.add(op.path)
			bump(byKind, "symlink-blocked")
			if (op.staged) toReset.add(op.path)
			continue
		}
		toAdd.add(op.path)
		bump(byKind, kind.name)
	}

	if (toAdd.isNotEmpty()) client.stageAddPaths(toAdd)
	if (toRm.isNotEmpty()) client.stageRemovePaths(toRm)
	if (toReset.isNotEmpty()) client.resetPathsToHead(toReset)

	return StageReport(
		added = toAdd.size,
		removed = toRm.size,
		skipped = skipped,
		unowned = unowned,
		symlinked = symlinked,
		byKind = byKind,
	)
}

/**
 * Flattens [PorcelainEntry] list into per-op stream. Renames become
 * del(old) + add(new); copies become add(new) only.
 */
private fun decomposeOps(entries: List<PorcelainEntry>): List<Op> {
	val ops = mutableListOf<Op>()
	for (e in entries) {
		// Skip unmerged entries.
		if (e.indexStatus == PorcelainStatus.UNMERGED || e.worktreeStatus == PorcelainStatus.UNMERGED) {
			continue
		}
		val staged = e.indexStatus == PorcelainStatus.A ||
			e.indexStatus == PorcelainStatus.M ||
			e.indexStatus == PorcelainStatus.D ||
			e.indexStatus == PorcelainStatus.R ||
			e.indexStatus == PorcelainStatus.C

		if (e.oldPath != null) {
			val isRename = e.indexStatus == PorcelainStatus.R || e.worktreeStatus == PorcelainStatus.R
			if (isRename) {
				ops.add(Op(kind = "del", path = e.oldPath, staged = true))
			}
			ops.add(Op(kind = "add", path = e.path, staged = staged))
			continue
		}
		if (isDeletion(e)) {
			ops.add(Op(kind = "del", path = e.path, staged = staged))
			continue
		}
		ops.add(Op(kind = "add", path = e.path, staged = staged))
	}
	return ops
}

/**
 * Returns true if the path is safe to stage from a symlink standpoint.
 */
private fun isSymlinkSafeForStaging(vaultRoot: String, absPath: String): Boolean {
	return try {
		// Leaf check.
		val attrs = Files.readAttributes(
			Path.of(absPath),
			java.nio.file.attribute.BasicFileAttributes::class.java,
			LinkOption.NOFOLLOW_LINKS,
		)
		if (attrs.isSymbolicLink) return false
		// Path-chain check.
		assertNoSymlinksInPath(vaultRoot, absPath)
		true
	} catch (_: java.nio.file.NoSuchFileException) {
		false
	} catch (_: Exception) {
		false
	}
}

private fun bump(map: MutableMap<String, Int>, key: String) {
	map[key] = (map[key] ?: 0) + 1
}
