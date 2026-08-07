package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.project.Project

/**
 * The root every working-tree path in this host is relative to.
 *
 * It is the OPENED WORKTREE'S GIT ROOT: what
 * [ai.jolli.jollimemory.bridge.GitOps.resolveWorktreeRoot] gets from
 * `git rev-parse --show-toplevel`, cached on `JolliMemoryService.mainRepoRoot`
 * during initialization. Two things it is deliberately NOT, each of which has
 * already shipped as a silent bug:
 *
 * **Not the main repository.** That field used to be `dirname(git-common-dir)`,
 * which on a `git worktree` checkout names the SHARED MAIN repository — a tree
 * that does not contain the user's changes at all. Handing it to the CLI made it
 * read `git status` where none of these paths have a pending change.
 *
 * **Not `project.basePath` either.** A project opened on a monorepo SUBDIRECTORY
 * is an ordinary setup, and there basePath is not the git root. It is easy to miss
 * because the two path spaces look interchangeable and are not:
 * `git status --porcelain` reports paths relative to the REPOSITORY ROOT wherever
 * it ran (so [ai.jolli.jollimemory.services.JolliMemoryService.getChangedFiles]
 * always produced root-relative rows), while `ChangesPanel.readChangesFromClm`
 * relativized against basePath and produced shorter ones for the same files.
 *
 * Getting this wrong is silent in the worst way. The CLI resolves its own worktree
 * root from whatever cwd it is handed and looks each path up in that repository's
 * `git status`; a path from the wrong space is simply absent there, so it answers
 * `not-found` with `ok: true` — the correct answer to the question it was asked —
 * and the host reads it as "already clean": the confirmation dialog appears, the
 * user clicks Discard, and nothing happens anywhere with no error on any surface.
 *
 * The same root is what `File(root, relativePath)` joins must use, so the VFS
 * refresh after a discard and [UnsavedEdits] take it too.
 *
 * `mainRepoRoot` remains right for SHARED state that deliberately lives once per
 * repository rather than once per worktree (`RepoProfile`, Memory Bank migration)
 * — it is the same value; the name is a legacy misnomer documented on
 * [ai.jolli.jollimemory.bridge.GitOps.resolveWorktreeRoot]. The worktree/main split
 * is spelled out at the top of
 * [ai.jolli.jollimemory.actions.CommitAIAction.performCommit], which learned it
 * when mixing the two shifted the staged diff and the post-commit markers into the
 * wrong tree.
 */
object WorktreeRoot {

    /**
     * The opened worktree's git root, or null when the project has no directory.
     *
     * A cached field read, not a git call — the resolution happens once in
     * `JolliMemoryService.initialize`, so this is safe on the EDT.
     *
     * Falls back to `project.basePath` while the service has not initialized yet
     * (and if it is gone entirely, which a `getService` on a disposing project can
     * be): that is the value this returned unconditionally before, so the fallback
     * is never worse than the previous behaviour.
     */
    fun of(project: Project): String? {
        val resolved = try {
            project.getService(JolliMemoryService::class.java)?.mainRepoRoot
        } catch (_: Exception) {
            // A pooled-thread caller can outlive the project (a discard confirmed
            // just before the window closes); the old behaviour never threw here.
            null
        }
        return resolved ?: project.basePath
    }
}
