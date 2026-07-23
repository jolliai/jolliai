package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.bridge.CliIntegrations
import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vcs.changes.VcsDirtyScopeManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import git4idea.repo.GitRepositoryManager
import java.awt.BorderLayout
import java.awt.Dimension
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane

/**
 * AI Commit action — generates a commit message using Anthropic API
 * and commits selected files. Matches VS Code CommitCommand.ts flow.
 *
 * Flow:
 *   1. Guard: check worker busy
 *   2. Get selected files from ChangesPanel
 *   3. Snapshot git index (write-tree) for safe restore on cancel/error
 *   4. Stage selected, unstage unselected tracked files, abort early when the
 *      resulting staging area is empty (typically a stale IDE change cache after
 *      an external commit — continuing would end in a confusing git error)
 *   5. Generate AI commit message from staged diff
 *   6. Show dialog with Commit / Amend / Amend (keep message) options
 *   7. Re-stage selected files (captures edits during dialog)
 *   8. Execute chosen commit action (with a race-safe fallback when the working
 *      tree became clean while the dialog was open)
 *   9. Preserve prior staging for files not in this commit
 *  10. Nudge the IDE to re-read git state — the external `git` process bypasses
 *      the platform's own change tracker
 */
class CommitAIAction : AnAction() {

    private val log = JmLogger.create("CommitAIAction")

    /** User's chosen commit action from the dialog. */
    private enum class CommitAction { COMMIT, AMEND, AMEND_KEEP_MESSAGE }

    /** Result from the commit dialog. */
    private data class CommitDialogResult(val action: CommitAction, val message: String)

    override fun actionPerformed(e: AnActionEvent) {
        performCommit(e.project ?: return)
    }

    /**
     * Runs the AI commit for [project]. Exposed so callers with an explicit project
     * (e.g. the Working Memory webview, whose JCEF data context doesn't reliably
     * carry the project) can invoke it directly, instead of going through the
     * action-invocation API — `ActionUtil.invokeAction`'s overloads are deprecated
     * inconsistently across IDE versions, so calling the logic directly is stable.
     */
    fun performCommit(project: Project) {
        // Re-entrancy guard: ignore a second trigger while a flow is already active
        // (staging → AI message → dialog → commit). Multiple UI entry points can
        // fire in quick succession (sidebar button, webview button, action shortcut)
        // and each would otherwise open its own dialog and race on the same files.
        // Released on every terminal path below.
        //
        // Per-project keying: two open project windows commit independently, so a
        // leaked flag in project A must never lock project B. See [inProgressFor].
        val guard = inProgressFor(project)
        if (!guard.compareAndSet(false, true)) {
            log.info("performCommit ignored: a commit flow is already in progress")
            return
        }

        val service = project.getService(JolliMemoryService::class.java)
        // cwd is the worktree root (project.basePath): the CLI must read this
        // worktree's staged index and write squash/plugin-source markers here.
        // `mainRepoRoot` points at the shared main repo and is only right for
        // reads of shared state (e.g. RepoProfile); mixing the two shifted the
        // staged diff and post-commit markers to the wrong tree.
        val cwd = project.basePath ?: run {
            guard.set(false)
            return
        }

        // Step 1: Guard — block while post-commit worker holds the lock
        if (SessionTracker.isWorkerBusy(cwd)) {
            guard.set(false)
            Messages.showWarningDialog(project,
                "AI summary is being generated. Please wait a moment.",
                "Jolli Memory")
            return
        }

        // Credential gating is delegated to the CLI: `resolveLlmCredentialSource`
        // accepts `aiProvider: "local-agent"` with no API key, plus the Anthropic /
        // Jolli-proxy sources. A CLI-side failure surfaces as a classified error
        // envelope which `friendlyLlmMessage` turns into user guidance — an
        // env-var pre-check in the plugin would also miss local-agent, so we
        // don't run one here.

        // Step 2: Get selected files from ChangesPanel
        val changesPanel = service.panelRegistry?.changesPanel
        val selectedFiles = changesPanel?.getSelectedFiles()?.takeIf { it.isNotEmpty() }
            ?: service.getChangedFiles()
        if (selectedFiles.isEmpty()) {
            guard.set(false)
            Messages.showWarningDialog(project, "No changed files to commit.", "Jolli Memory")
            return
        }

        val selectedPaths = selectedFiles.map { it.relativePath }

        // Compute unselected tracked files (exclude untracked "?" files — git restore --staged
        // would error on files never in the index)
        val allFiles = changesPanel?.getFiles() ?: service.getChangedFiles()
        val selectedPathSet = selectedPaths.toSet()
        val unselectedTrackedPaths = allFiles
            .filter { it.relativePath !in selectedPathSet && it.statusCode != "?" }
            .map { it.relativePath }

        log.info("performCommit start: cwd=%s selectedPaths=%s unselectedTrackedPaths=%s",
            cwd, selectedPaths, unselectedTrackedPaths)

        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Jolli Memory: Generating commit message...", true) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    val git = service.getGitOps() ?: run {
                        guard.set(false)
                        return
                    }

                    // Step 3: Snapshot the original index for safe restore
                    indicator.text = "Snapshotting index..."
                    val originalIndexTree = git.writeTree()
                    if (originalIndexTree == null) {
                        guard.set(false)
                        ApplicationManager.getApplication().invokeLater {
                            Messages.showErrorDialog(project,
                                "Could not read the current git index. Commit aborted to avoid data loss.",
                                "Jolli Memory")
                        }
                        return
                    }
                    val originalStagedPaths = git.getStagedFilePaths()
                    log.info("Step3 snapshot: originalIndexTree=%s originalStagedPaths=%s",
                        originalIndexTree, originalStagedPaths)

                    // Step 4: Stage selected, unstage unselected
                    indicator.text = "Staging files..."
                    git.stageFiles(selectedPaths)
                    if (unselectedTrackedPaths.isNotEmpty()) {
                        git.unstageFiles(unselectedTrackedPaths)
                    }
                    val stagedAfterStep4 = git.getStagedFilePaths()
                    log.info("Step4 after stage/unstage: staged=%s", stagedAfterStep4)

                    // Abort early when staging produced nothing to commit: the panel offered
                    // files with no real modifications (typically a stale IDE change cache
                    // right after an external commit). Continuing would call the LLM on an
                    // empty diff and end in a confusing "nothing to commit" git error.
                    if (stagedAfterStep4.isEmpty()) {
                        log.info("Nothing staged for the selected files — aborting flow and resyncing IDE state")
                        git.readTree(originalIndexTree)
                        notifyIdeOfExternalGitChange(project, cwd)
                        guard.set(false)
                        ApplicationManager.getApplication().invokeLater {
                            Messages.showInfoMessage(project,
                                "No changes to commit — the selected files have no modifications.",
                                "Jolli Memory")
                            service.refreshStatus()
                        }
                        return
                    }

                    // Step 5: Generate AI message via the bundled CLI. The `generate
                    // commit-message` bridge reads the staged diff, branch, and file
                    // list from git itself — the same contract as the VS Code bridge —
                    // so nothing is passed here beyond the project directory.
                    indicator.text = "Generating AI commit message..."
                    val response = CliIntegrations.generate(cwd, "commit-message", null, indicator)
                    val message = response.get("message")?.asString
                        ?: throw RuntimeException("Empty response from the CLI")

                    // Step 6: Show dialog on EDT.
                    //
                    // The outer Task's try/catch has already returned by the time this
                    // lambda runs (invokeLater only schedules), so any throw from
                    // showCommitDialog would otherwise skip both the pooled-thread
                    // finally blocks below AND miss the outer catch — the guard would
                    // leak forever, silently blocking every future AI Commit in this
                    // project. Bracket the whole EDT step in its own try/catch to
                    // release the guard + restore the index on that path too.
                    ApplicationManager.getApplication().invokeLater {
                        val result = try {
                            showCommitDialog(project, message)
                        } catch (ex: Throwable) {
                            log.warn("Commit dialog failed on EDT: %s", ex.message ?: ex.toString())
                            ApplicationManager.getApplication().executeOnPooledThread {
                                try { git.readTree(originalIndexTree) } catch (_: Exception) {}
                                guard.set(false)
                            }
                            Messages.showErrorDialog(project,
                                "AI commit dialog failed: ${ex.message}",
                                "Jolli Memory")
                            return@invokeLater
                        }

                        if (result != null) {
                            // Steps 7-10 on background thread
                            ApplicationManager.getApplication().executeOnPooledThread {
                                try {
                                    // Step 7: Re-stage selected files (captures edits during dialog)
                                    git.stageFiles(selectedPaths)
                                    log.info("Step7 after re-stage: staged=%s", git.getStagedFilePaths())

                                    // Step 8: Execute the chosen commit action.
                                    SessionTracker.savePluginSource(cwd)

                                    // `isHeadPushed` must run BEFORE the amend, otherwise the
                                    // fresh HEAD gets checked against origin/HEAD and always
                                    // reads as unpushed.
                                    val wasPushed = result.action != CommitAction.COMMIT && git.isHeadPushed()

                                    val cr = when (result.action) {
                                        CommitAction.COMMIT ->
                                            runGitCommit(git, "COMMIT", "commit", "-m", result.message)
                                        CommitAction.AMEND ->
                                            runGitCommit(git, "AMEND", "commit", "--amend", "-m", result.message)
                                        CommitAction.AMEND_KEEP_MESSAGE ->
                                            runGitCommit(git, "AMEND_KEEP", "commit", "--amend", "--no-edit")
                                    }

                                    if (cr.exitCode != 0) {
                                        // Race safety: the plain COMMIT path can still race with an
                                        // external process that cleaned the working tree between
                                        // Step 4 and here (dialog is open on the EDT). Downgrade
                                        // that specific case to a friendly resync instead of a
                                        // scary error dialog.
                                        if (result.action == CommitAction.COMMIT && isNothingToCommit(cr)) {
                                            log.info("Step8 race: working tree cleaned during dialog, resyncing")
                                            git.readTree(originalIndexTree)
                                            notifyIdeOfExternalGitChange(project, cwd)
                                            ApplicationManager.getApplication().invokeLater {
                                                Messages.showInfoMessage(project,
                                                    "No changes to commit — the working tree is clean.",
                                                    "Jolli Memory")
                                                service.refreshStatus()
                                            }
                                            return@executeOnPooledThread
                                        }
                                        val detail = cr.stderr.ifBlank { cr.stdout }.ifBlank { "no output" }
                                        val reason = if (cr.exitCode == -1) "aborted or timed out" else "exit=${cr.exitCode}"
                                        throw RuntimeException("git commit $reason: $detail")
                                    }

                                    if (wasPushed) {
                                        ApplicationManager.getApplication().invokeLater {
                                            Messages.showInfoMessage(project,
                                                "Commit amended. The original was already pushed — " +
                                                    "you'll need to force push to update the remote.",
                                                "Jolli Memory")
                                        }
                                    }

                                    // Step 9: Preserve prior staging — re-stage files that were
                                    // staged before the flow but not part of this commit
                                    val remainingStagedPaths = originalStagedPaths.filter { it !in selectedPathSet }
                                    if (remainingStagedPaths.isNotEmpty()) {
                                        git.stageFiles(remainingStagedPaths)
                                    }

                                    // Step 10: The commit ran in an external git process the IDE
                                    // cannot observe — tell the platform, or ChangeListManager
                                    // keeps offering the just-committed files for a second,
                                    // doomed commit ("nothing to commit").
                                    notifyIdeOfExternalGitChange(project, cwd)

                                    ApplicationManager.getApplication().invokeLater {
                                        Messages.showInfoMessage(project,
                                            "Committed! Post-commit hook is generating a summary in the background.",
                                            "Jolli Memory")
                                        service.refreshStatus()
                                    }
                                } catch (ex: Exception) {
                                    log.warn("Commit flow failed, restoring index to %s: %s",
                                        originalIndexTree, ex.message ?: ex.toString())
                                    // Restore index on commit failure
                                    git.readTree(originalIndexTree)
                                    ApplicationManager.getApplication().invokeLater {
                                        Messages.showErrorDialog(project, "Commit failed: ${ex.message}", "Jolli Memory")
                                    }
                                } finally {
                                    guard.set(false)
                                }
                            }
                        } else {
                            // User cancelled — restore original index state
                            ApplicationManager.getApplication().executeOnPooledThread {
                                try {
                                    git.readTree(originalIndexTree)
                                } finally {
                                    guard.set(false)
                                }
                            }
                        }
                    }
                } catch (ex: Exception) {
                    // The pooled-thread commit block owns its own CAS release in
                    // finally, so only clear here for failures that never reached
                    // the dialog (Steps 3–5).
                    guard.set(false)
                    log.warn("Commit setup failed before dialog: %s", ex.message ?: ex.toString())
                    ApplicationManager.getApplication().invokeLater {
                        Messages.showErrorDialog(project, "Failed: ${ex.message}", "Jolli Memory")
                    }
                }
            }
        })
    }

    /**
     * Shows a commit dialog with an editable message field and three action buttons:
     * Commit, Amend, and Amend (keep message). Matches VS Code's QuickPick UX.
     *
     * @return the user's choice and edited message, or null if cancelled
     */
    private fun showCommitDialog(project: com.intellij.openapi.project.Project, generatedMessage: String): CommitDialogResult? {
        var result: CommitDialogResult? = null

        val dialog = object : DialogWrapper(project, true) {
            private val textArea = JBTextArea(generatedMessage).apply {
                lineWrap = true
                wrapStyleWord = true
                rows = 5
                columns = 60
            }

            init {
                title = "AI Commit"
                setOKButtonText("Commit")
                init()
            }

            override fun createCenterPanel(): JComponent {
                val panel = JPanel(BorderLayout(0, JBUI.scale(8)))
                panel.add(JLabel("Edit commit message:"), BorderLayout.NORTH)
                val scrollPane = JScrollPane(textArea).apply {
                    preferredSize = Dimension(JBUI.scale(500), JBUI.scale(120))
                }
                panel.add(scrollPane, BorderLayout.CENTER)
                return panel
            }

            override fun createActions(): Array<javax.swing.Action> {
                val commitAction = okAction
                val amendAction = object : DialogWrapperAction("Amend") {
                    override fun doAction(e: java.awt.event.ActionEvent?) {
                        val msg = textArea.text.trim()
                        if (msg.isNotBlank()) {
                            result = CommitDialogResult(CommitAction.AMEND, msg)
                            close(OK_EXIT_CODE)
                        }
                    }
                }
                val amendKeepAction = object : DialogWrapperAction("Amend (keep message)") {
                    override fun doAction(e: java.awt.event.ActionEvent?) {
                        result = CommitDialogResult(CommitAction.AMEND_KEEP_MESSAGE, "")
                        close(OK_EXIT_CODE)
                    }
                }
                return arrayOf(commitAction, amendAction, amendKeepAction, cancelAction)
            }

            override fun doOKAction() {
                val msg = textArea.text.trim()
                if (msg.isNotBlank()) {
                    result = CommitDialogResult(CommitAction.COMMIT, msg)
                    super.doOKAction()
                }
            }

            fun getMessage(): String = textArea.text.trim()
        }

        dialog.show()
        return result
    }

    /**
     * Runs one `git commit …` variant, logging staged-file state and the raw
     * [GitOps.ExecResult] (exit code, stdout, stderr). Returns the result so the
     * caller can classify — the plain COMMIT path treats "nothing to commit" as
     * a race, while the AMEND paths surface every failure.
     */
    private fun runGitCommit(git: GitOps, label: String, vararg args: String): GitOps.ExecResult {
        log.info("Step8 %s: staged=%s args=%s",
            label, git.getStagedFilePaths(), args.toList())
        val cr = git.execWithResult(*args)
        log.info("Step8 %s result: exit=%d stdout=[%s] stderr=[%s]",
            label, cr.exitCode, cr.stdout.take(500), cr.stderr.take(500))
        return cr
    }

    /** Recognizes git's "clean tree" refusal from `git commit`. */
    private fun isNothingToCommit(cr: GitOps.ExecResult): Boolean =
        cr.stdout.contains("nothing to commit") ||
            cr.stdout.contains("nothing added to commit")

    /**
     * Tells IntelliJ that git state changed outside the IDE. Commits here run through
     * an external `git` process the platform cannot observe — without this nudge,
     * ChangeListManager keeps reporting already-committed files and the Changes panel
     * re-offers them for a second, doomed commit. Call from a background thread
     * ([git4idea.repo.GitRepository.update] re-reads .git synchronously). Failures
     * only log — a missed refresh degrades to the old stale-panel behavior.
     */
    private fun notifyIdeOfExternalGitChange(project: Project, cwd: String) {
        try {
            LocalFileSystem.getInstance()
                .findFileByPath(FileUtil.toSystemIndependentName(cwd))
                ?.refresh(true, true)
            GitRepositoryManager.getInstance(project).repositories.forEach { it.update() }
            VcsDirtyScopeManager.getInstance(project).markEverythingDirty()
        } catch (e: Exception) {
            log.warn("IDE VCS refresh after external git change failed: %s", e.message)
        }
    }

    override fun update(e: AnActionEvent) {
        val service = e.project?.getService(JolliMemoryService::class.java)
        val status = service?.getStatus()
        // Worker locks are per-worktree, and [actionPerformed] runs against
        // `project.basePath` (the current worktree). The button-enabled state
        // must reflect the SAME tree, otherwise a busy worker in the main
        // checkout would grey out this worktree's button (and vice versa).
        val cwd = e.project?.basePath
        val workerBusy = cwd != null && SessionTracker.isWorkerBusy(cwd)
        val hasSelectedFiles = service?.panelRegistry?.changesPanel?.getSelectedFiles()?.isNotEmpty() ?: false
        e.presentation.isEnabled = status != null && status.enabled && !workerBusy && hasSelectedFiles
    }

    // [update] queries the JolliMemoryService and the post-commit worker lock —
    // both are I/O-shaped, and running them on the EDT was flagged by newer
    // IntelliJ platform versions. BGT is the correct thread for this workload.
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    companion object {
        /**
         * Per-project re-entrancy guards. True while a commit flow is active
         * (staging → AI message → dialog → commit) in that specific project.
         *
         * Shared across every entry point WITHIN a project (sidebar button,
         * webview button, action invocation — each may construct its own
         * [CommitAIAction] via IntelliJ's ActionManager), so rapid double
         * triggers cannot spawn parallel flows that would commit the same
         * files twice.
         *
         * Keyed by [Project] instead of a single static: two open windows must
         * never lock each other, and a leaked flag in project A must not
         * silently block project B — a plain companion static (per-classloader)
         * did exactly that and turned any dialog-EDT throw into a fleet-wide
         * "AI commit stuck until restart".
         */
        private val inProgressByProject = ConcurrentHashMap<Project, AtomicBoolean>()

        /**
         * Returns the guard for [project], creating one on first use. Callers
         * must always release with `.set(false)` on every terminal path — the
         * map itself is never cleaned up (the entry survives project close so a
         * mid-close re-entry can still land on the same flag; the entry is a
         * cheap AtomicBoolean and the number of projects opened per IDE session
         * is small).
         */
        private fun inProgressFor(project: Project): AtomicBoolean =
            inProgressByProject.computeIfAbsent(project) { AtomicBoolean(false) }
    }
}
