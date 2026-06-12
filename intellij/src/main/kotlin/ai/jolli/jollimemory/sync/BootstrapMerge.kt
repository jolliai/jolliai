package ai.jolli.jollimemory.sync

import ai.jolli.jollimemory.core.JmLogger
import java.io.IOException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes

/**
 * Bootstrap merge — handles the "fresh local vault + populated remote" sync
 * case where `git pull --rebase` would otherwise hard-fail with
 * "untracked working tree files would be overwritten by checkout".
 *
 * Port of `cli/src/sync/BootstrapMerge.ts`.
 */

private val log = JmLogger.create("BootstrapMerge")

const val BOOTSTRAP_STASH_DIRNAME = ".jolli-bootstrap-stash"

sealed class ShouldRunResult {
	data object Ok : ShouldRunResult()
	data class No(val reason: String) : ShouldRunResult()
}

data class BootstrapPathReport(
	val path: String,
	val disposition: String, // "added-from-local" | "no-op" | "remote-wins-local-stashed" | "aggregate-merged"
)

data class BootstrapMergeResult(
	val ok: Boolean,
	val commitSha: String? = null,
	val reports: List<BootstrapPathReport> = emptyList(),
	val stashedSurvivors: List<String> = emptyList(),
	val code: String? = null, // "race-detected" | "checkout-failed" | "commit-failed"
	val message: String? = null,
)

/**
 * Strict trigger check — all of C1-C5 must hold.
 *
 *   C1: HEAD is unborn
 *   C2: Remote default branch exists
 *   C3: Working tree has files (not empty after `.git`)
 *   C4: No local branches
 *   C5: No stash entries
 */
fun shouldRunBootstrapMerge(client: SyncGitClient, defaultBranch: String): ShouldRunResult {
	if (client.hasHead()) return ShouldRunResult.No("HEAD is born (C1 failed)")
	if (!client.refExists("refs/remotes/origin/$defaultBranch")) {
		return ShouldRunResult.No("origin/$defaultBranch missing (C2 failed)")
	}
	if (!client.hasUncommittedChanges(includeIgnored = true)) {
		return ShouldRunResult.No("working tree empty (C3 failed)")
	}
	val branches = client.listLocalBranches()
	if (branches.isNotEmpty()) {
		return ShouldRunResult.No("local branches present: ${branches.joinToString(",")} (C4 failed)")
	}
	if (client.refExists("refs/stash")) {
		return ShouldRunResult.No("git stash present (C5 failed)")
	}
	return ShouldRunResult.Ok
}

/**
 * Run the bootstrap merge. Caller MUST have verified [shouldRunBootstrapMerge] first.
 */
fun runBootstrapMerge(
	client: SyncGitClient,
	vaultRoot: String,
	defaultBranch: String,
	author: CommitAuthor,
): BootstrapMergeResult {
	val vaultPath = Path.of(vaultRoot)
	val stashRoot = Path.of(vaultRoot, BOOTSTRAP_STASH_DIRNAME)

	// Pre-flight race reassertion (C1 + C4).
	if (client.hasHead()) {
		return BootstrapMergeResult(ok = false, code = "race-detected", message = "HEAD appeared between trigger check and stash")
	}
	val branchesNow = client.listLocalBranches()
	if (branchesNow.isNotEmpty()) {
		return BootstrapMergeResult(ok = false, code = "race-detected", message = "local branch appeared mid-flight: ${branchesNow.joinToString(",")}")
	}

	// Step 1: stash every local file.
	val localFiles = collectLocalFiles(vaultPath, stashRoot)
	log.info("bootstrap-merge: stashing ${localFiles.size} local files into $BOOTSTRAP_STASH_DIRNAME")
	for (rel in localFiles) {
		val src = vaultPath.resolve(rel)
		val dst = stashRoot.resolve(rel)
		Files.createDirectories(dst.parent)
		try {
			Files.move(src, dst)
		} catch (_: Exception) {
			Files.copy(src, dst)
			Files.delete(src)
		}
	}

	// Step 2: adopt remote.
	try {
		client.checkoutTrackingBranch(defaultBranch)
	} catch (e: Exception) {
		val msg = e.message ?: e.toString()
		log.warn("bootstrap-merge: checkout failed: $msg — rolling back stash")
		restoreStashedFiles(localFiles, vaultPath, stashRoot)
		return BootstrapMergeResult(ok = false, code = "checkout-failed", message = msg)
	}

	// Step 3: walk stash, decide per-path disposition.
	val reports = mutableListOf<BootstrapPathReport>()
	val stashedFiles = collectStashFiles(stashRoot)
	for (rel in stashedFiles) {
		val stashPath = stashRoot.resolve(rel)
		val workingPath = vaultPath.resolve(rel)
		val workingExists = Files.exists(workingPath)

		if (!workingExists) {
			// Pure local addition — restore.
			Files.createDirectories(workingPath.parent)
			Files.move(stashPath, workingPath)
			reports.add(BootstrapPathReport(rel, "added-from-local"))
			continue
		}

		// Both sides have it.
		val stashBytes = Files.readAllBytes(stashPath)
		val workingBytes = Files.readAllBytes(workingPath)
		if (stashBytes.contentEquals(workingBytes)) {
			Files.delete(stashPath)
			reports.add(BootstrapPathReport(rel, "no-op"))
			continue
		}

		// Conflicting path — try aggregate merge for JSON aggregates.
		if (isAggregatePath(rel)) {
			val oursText = String(stashBytes, Charsets.UTF_8)
			val theirsText = String(workingBytes, Charsets.UTF_8)
			val merged = tryAggregateMerge(rel, oursText, theirsText)
			if (merged != null) {
				Files.writeString(workingPath, merged)
				Files.delete(stashPath)
				reports.add(BootstrapPathReport(rel, "aggregate-merged"))
				continue
			}
			log.warn("bootstrap-merge: aggregate merge returned null for $rel — falling back to remote-wins")
		}

		// Remote wins, local stays in stash.
		reports.add(BootstrapPathReport(rel, "remote-wins-local-stashed"))
	}

	// Sweep empty stash dirs.
	pruneEmptyDirs(stashRoot)
	val stashedSurvivors = collectStashFiles(stashRoot)

	// Step 4: stage + commit.
	client.stageAll()
	val commitSha: String
	try {
		commitSha = client.commit(
			"[jolli-mb] reconcile: bootstrap merge of fresh local into populated remote",
			author,
		)
	} catch (e: Exception) {
		val msg = e.message ?: ""
		if (msg.contains("nothing to commit", ignoreCase = true) || msg.contains("no changes added", ignoreCase = true)) {
			val head = client.revParse("HEAD")
				?: return BootstrapMergeResult(ok = false, code = "commit-failed", message = "HEAD missing after empty merge")
			return BootstrapMergeResult(ok = true, commitSha = head, reports = reports, stashedSurvivors = stashedSurvivors)
		}
		log.warn("bootstrap-merge: commit failed: $msg")
		return BootstrapMergeResult(ok = false, code = "commit-failed", message = msg)
	}

	log.info("bootstrap-merge: done commit=$commitSha reports=${reports.size} stashedSurvivors=${stashedSurvivors.size}")
	return BootstrapMergeResult(ok = true, commitSha = commitSha, reports = reports, stashedSurvivors = stashedSurvivors)
}

// ── File collection helpers ─────────────────────────────────────────

private fun collectLocalFiles(root: Path, stashRoot: Path): List<String> {
	val out = mutableListOf<String>()
	if (!Files.isDirectory(root)) return out
	Files.walkFileTree(root, object : SimpleFileVisitor<Path>() {
		override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult {
			if (dir.fileName?.toString() == ".git") return FileVisitResult.SKIP_SUBTREE
			if (dir == stashRoot) return FileVisitResult.SKIP_SUBTREE
			return FileVisitResult.CONTINUE
		}
		override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
			out.add(root.relativize(file).toString().replace('\\', '/'))
			return FileVisitResult.CONTINUE
		}
	})
	return out
}

private fun collectStashFiles(stashRoot: Path): List<String> {
	val out = mutableListOf<String>()
	if (!Files.isDirectory(stashRoot)) return out
	Files.walkFileTree(stashRoot, object : SimpleFileVisitor<Path>() {
		override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
			out.add(stashRoot.relativize(file).toString().replace('\\', '/'))
			return FileVisitResult.CONTINUE
		}
	})
	return out
}

private fun restoreStashedFiles(rels: List<String>, vaultRoot: Path, stashRoot: Path) {
	for (rel in rels) {
		val src = stashRoot.resolve(rel)
		val dst = vaultRoot.resolve(rel)
		if (!Files.exists(src)) continue
		Files.createDirectories(dst.parent)
		try {
			Files.move(src, dst)
		} catch (_: Exception) {
			Files.copy(src, dst)
			Files.delete(src)
		}
	}
	pruneEmptyDirs(stashRoot)
}

private fun pruneEmptyDirs(root: Path) {
	if (!Files.isDirectory(root)) return
	Files.walkFileTree(root, object : SimpleFileVisitor<Path>() {
		override fun postVisitDirectory(dir: Path, exc: IOException?): FileVisitResult {
			try {
				Files.newDirectoryStream(dir).use { stream ->
					if (!stream.iterator().hasNext()) {
						Files.delete(dir)
					}
				}
			} catch (_: Exception) {}
			return FileVisitResult.CONTINUE
		}
	})
}
