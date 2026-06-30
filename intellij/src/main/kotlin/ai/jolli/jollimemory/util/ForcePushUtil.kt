package ai.jolli.jollimemory.util

import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.core.JmLogger
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages

/**
 * Shared force-push utilities — Kotlin port of ForcePushPrompt.ts + ForcePushSafety.ts.
 *
 * Single source of truth for NFF detection, divergence inspection, and the
 * force-push confirmation dialog. Used by PushAction and SummaryPanel's
 * Create PR flow. The squash pre-warning in SquashAction is intentionally NOT
 * routed here (different decision, different wording).
 */
object ForcePushUtil {

	private val log = JmLogger.create("ForcePushUtil")

	/** Result of the post-rejection force-push gate. */
	enum class ForcePushOutcome { CONFIRMED, DECLINED, BLOCKED }

	/** How the local branch and its remote-tracking ref diverge. */
	data class ForcePushSafety(
		val branch: String,
		/** Commits on origin/<branch> missing from local HEAD — lost by force-push. */
		val remoteOnly: Int,
		/** Commits on local HEAD missing from origin/<branch>. */
		val localOnly: Int,
		/** True when remote is strictly ahead and local has no unique commits. */
		val behindOnly: Boolean,
	)

	/**
	 * Recognizes git's non-fast-forward push rejection from stderr.
	 * Matches the same four patterns as ForcePushPrompt.ts:isNonFastForwardError.
	 */
	fun isNonFastForwardError(stderr: String): Boolean {
		val lower = stderr.lowercase()
		return lower.contains("non-fast-forward") ||
			lower.contains("fetch first") ||
			lower.contains("[rejected]") ||
			lower.contains("tip of your current branch is behind")
	}

	/**
	 * Inspects divergence between local branch and its remote-tracking ref.
	 * Fetches the remote first so counts reflect the true state.
	 * Returns null when comparison can't be made (detached HEAD, network error).
	 * Mirrors ForcePushSafety.ts:inspectForcePushSafety.
	 */
	fun inspectForcePushSafety(git: GitOps, branch: String): ForcePushSafety? {
		if (branch.isBlank() || branch == "HEAD") return null
		val remoteRef = "origin/$branch"
		return try {
			git.exec("fetch", "origin", branch, timeoutSeconds = 30) ?: return null
			val remoteOnly = git.exec("rev-list", "--count", "HEAD..$remoteRef")?.trim()?.toIntOrNull() ?: return null
			val localOnly = git.exec("rev-list", "--count", "$remoteRef..HEAD")?.trim()?.toIntOrNull() ?: return null
			ForcePushSafety(
				branch = branch,
				remoteOnly = remoteOnly,
				localOnly = localOnly,
				behindOnly = remoteOnly > 0 && localOnly == 0,
			)
		} catch (e: Exception) {
			log.warn("inspectForcePushSafety failed: %s", e.message)
			null
		}
	}

	/**
	 * Post-rejection gate. Inspects divergence, then either:
	 * - blocks when the branch is merely behind (force-push never offered),
	 * - shows the shared force-push confirmation with lost-commit count.
	 *
	 * When divergence can't be measured, falls back to plain confirm so a
	 * legitimate rewrite is never blocked by a transient failure.
	 *
	 * MUST be called from the EDT (shows dialogs).
	 */
	fun gateForcePush(
		project: Project,
		git: GitOps,
		branch: String,
		reason: String = "Remote branch has diverged. Force push will overwrite remote history.",
	): ForcePushOutcome {
		val safety = inspectForcePushSafety(git, branch)

		if (safety?.behindOnly == true) {
			val commits = if (safety.remoteOnly == 1) "commit" else "commits"
			val message = buildString {
				appendLine("Remote branch \"$branch\" has ${safety.remoteOnly} $commits you don't have locally,")
				appendLine("and your branch has no commits the remote is missing.")
				appendLine()
				appendLine("This is not a history rewrite — your branch is simply behind. Pull or")
				appendLine("rebase to integrate the remote commits, then push again. Force-pushing")
				append("here would permanently delete those ${safety.remoteOnly} remote $commits.")
			}
			Messages.showWarningDialog(project, message, "Cannot Force Push")
			return ForcePushOutcome.BLOCKED
		}

		val lostLine = if (safety != null && safety.remoteOnly > 0) {
			val commits = if (safety.remoteOnly == 1) "commit" else "commits"
			"\nWarning: this will permanently delete ${safety.remoteOnly} $commits that exist only on the remote."
		} else {
			""
		}

		val message = buildString {
			appendLine("This operation may rewrite remote history.")
			appendLine()
			append(reason)
			if (lostLine.isNotEmpty()) append(lostLine)
			appendLine()
			append("This may affect collaborators on the same branch.")
		}

		val result = Messages.showYesNoDialog(
			project,
			message,
			"Force Push Required",
			"Force Push (--force-with-lease)",
			"Cancel",
			Messages.getWarningIcon(),
		)
		return if (result == Messages.YES) ForcePushOutcome.CONFIRMED else ForcePushOutcome.DECLINED
	}

	/**
	 * Runs `git push --force-with-lease origin <branch>`.
	 * Returns the ExecResult so callers can check success and surface errors.
	 */
	fun forcePushBranch(git: GitOps, branch: String): GitOps.ExecResult {
		return git.execWithResult("push", "--force-with-lease", "origin", branch, timeoutSeconds = 60)
	}
}
