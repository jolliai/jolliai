package ai.jolli.jollimemory.backfill

import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.core.JmLogger
import java.io.File

/**
 * BackfillDismissFlag — repo-wide marker for "user dismissed the back-fill cold-start
 * card in this repository." Kotlin port of vscode/src/services/BackfillDismissFlag.ts;
 * both surfaces MUST use the same path so a dismiss in one is honored in the other.
 *
 * Stored under the **shared git common dir** (`git rev-parse --git-common-dir`, the one
 * `.git` every worktree of a repo points at) at
 * `<git-common-dir>/jollimemory/backfill-card-dismissed`. Deliberately REPO-WIDE, not
 * per-worktree: the cold-start decision itself is repo-wide (`repoHasAnyMemory` reads the
 * shared orphan branch), so dismissing in one worktree must suppress the card in every
 * worktree of the same repo. It is inherently local + untracked (nothing under `.git` is
 * committed).
 *
 * Marker semantics: the file's *existence* is the boolean. The body holds a millisecond
 * timestamp for human debugging. Once a back-fill generates a memory the marker is cleared
 * (see the cold-start panel's done handling) so a future fresh-empty transition re-shows it.
 */
object BackfillDismissFlag {

	private const val FILE_NAME = "backfill-card-dismissed"
	private val log = JmLogger.create("BackfillDismissFlag")

	/**
	 * `<git-common-dir>/jollimemory/backfill-card-dismissed`, or null when the common dir
	 * can't be resolved (not a git repo) — the card never shows there anyway.
	 */
	private fun markerFile(projectDir: String): File? {
		val common = GitOps(projectDir).exec("rev-parse", "--git-common-dir")?.trim()
		if (common.isNullOrBlank()) return null
		val base = File(common)
		val dir = if (base.isAbsolute) base else File(projectDir, common)
		return File(File(dir, "jollimemory"), FILE_NAME)
	}

	/** True iff the dismiss marker exists for this repo. */
	fun isDismissed(projectDir: String): Boolean =
		try {
			markerFile(projectDir)?.exists() ?: false
		} catch (e: Exception) {
			log.warn("isDismissed failed: %s", e.message)
			false
		}

	/**
	 * Sets the marker. `dismissed=true` writes the file (creating the directory if needed);
	 * `dismissed=false` removes it (no-op if already absent).
	 */
	fun setDismissed(projectDir: String, dismissed: Boolean) {
		try {
			val file = markerFile(projectDir) ?: return
			if (dismissed) {
				file.parentFile?.mkdirs()
				file.writeText(System.currentTimeMillis().toString())
			} else if (file.exists()) {
				file.delete()
			}
		} catch (e: Exception) {
			log.warn("setDismissed failed: %s", e.message)
		}
	}
}
