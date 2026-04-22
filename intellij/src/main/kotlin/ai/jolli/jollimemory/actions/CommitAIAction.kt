package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.core.CommitMessageParams
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.Summarizer
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
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
 *   4. Stage selected, unstage unselected tracked files
 *   5. Generate AI commit message from staged diff
 *   6. Show dialog with Commit / Amend / Amend (keep message) options
 *   7. Re-stage selected files (captures edits during dialog)
 *   8. Execute chosen commit action
 *   9. Preserve prior staging for files not in this commit
 *  10. Refresh panels
 */
class CommitAIAction : AnAction() {

    /** User's chosen commit action from the dialog. */
    private enum class CommitAction { COMMIT, AMEND, AMEND_KEEP_MESSAGE }

    /** Result from the commit dialog. */
    private data class CommitDialogResult(val action: CommitAction, val message: String)

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = project.getService(JolliMemoryService::class.java)
        val cwd = service.mainRepoRoot ?: project.basePath ?: return

        // Step 1: Guard — block while post-commit worker holds the lock
        if (SessionTracker.isWorkerBusy(cwd)) {
            Messages.showWarningDialog(project,
                "AI summary is being generated. Please wait a moment.",
                "Jolli Memory")
            return
        }

        val config = SessionTracker.loadConfig(cwd)
        if (config.apiKey.isNullOrBlank() && config.jolliApiKey.isNullOrBlank() && System.getenv("ANTHROPIC_API_KEY").isNullOrBlank()) {
            Messages.showErrorDialog(project,
                "No LLM credentials available.\nSign in to Jolli or configure an Anthropic API key in Settings > Tools > Jolli Memory.",
                "Jolli Memory")
            return
        }

        // Step 2: Get selected files from ChangesPanel
        val changesPanel = service.panelRegistry?.changesPanel
        val selectedFiles = changesPanel?.getSelectedFiles()?.takeIf { it.isNotEmpty() }
            ?: service.getChangedFiles()
        if (selectedFiles.isEmpty()) {
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

        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Jolli Memory: Generating commit message...", true) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    val git = service.getGitOps() ?: return

                    // Step 3: Snapshot the original index for safe restore
                    indicator.text = "Snapshotting index..."
                    val originalIndexTree = git.writeTree()
                    if (originalIndexTree == null) {
                        ApplicationManager.getApplication().invokeLater {
                            Messages.showErrorDialog(project,
                                "Could not read the current git index. Commit aborted to avoid data loss.",
                                "Jolli Memory")
                        }
                        return
                    }
                    val originalStagedPaths = git.getStagedFilePaths()

                    // Step 4: Stage selected, unstage unselected
                    indicator.text = "Staging files..."
                    git.stageFiles(selectedPaths)
                    if (unselectedTrackedPaths.isNotEmpty()) {
                        git.unstageFiles(unselectedTrackedPaths)
                    }

                    // Get staged diff and branch
                    indicator.text = "Reading staged diff..."
                    val diff = git.exec("diff", "--cached") ?: ""
                    val branch = git.getCurrentBranch() ?: "unknown"

                    // Step 5: Generate AI message
                    indicator.text = "Generating AI commit message..."
                    val message = Summarizer.generateCommitMessage(CommitMessageParams(
                        stagedDiff = diff,
                        branch = branch,
                        stagedFiles = selectedPaths,
                        apiKey = config.apiKey,
                        model = config.model,
                        jolliApiKey = config.jolliApiKey,
                    ))

                    // Step 6: Show dialog on EDT
                    ApplicationManager.getApplication().invokeLater {
                        val result = showCommitDialog(project, message)

                        if (result != null) {
                            // Steps 7-9 on background thread
                            ApplicationManager.getApplication().executeOnPooledThread {
                                try {
                                    // Step 7: Re-stage selected files (captures edits during dialog)
                                    git.stageFiles(selectedPaths)

                                    // Step 8: Execute the chosen commit action
                                    SessionTracker.savePluginSource(cwd)

                                    when (result.action) {
                                        CommitAction.COMMIT -> {
                                            val commitResult = git.exec("commit", "-m", result.message)
                                            if (commitResult == null) throw RuntimeException("git commit failed or timed out")
                                        }
                                        CommitAction.AMEND -> {
                                            val wasPushed = git.isHeadPushed()
                                            val commitResult = git.exec("commit", "--amend", "-m", result.message)
                                            if (commitResult == null) throw RuntimeException("git commit --amend failed or timed out")
                                            if (wasPushed) {
                                                ApplicationManager.getApplication().invokeLater {
                                                    Messages.showInfoMessage(project,
                                                        "Commit amended. The original was already pushed — " +
                                                            "you'll need to force push to update the remote.",
                                                        "Jolli Memory")
                                                }
                                            }
                                        }
                                        CommitAction.AMEND_KEEP_MESSAGE -> {
                                            val wasPushed = git.isHeadPushed()
                                            val commitResult = git.exec("commit", "--amend", "--no-edit")
                                            if (commitResult == null) throw RuntimeException("git commit --amend failed or timed out")
                                            if (wasPushed) {
                                                ApplicationManager.getApplication().invokeLater {
                                                    Messages.showInfoMessage(project,
                                                        "Commit amended. The original was already pushed — " +
                                                            "you'll need to force push to update the remote.",
                                                        "Jolli Memory")
                                                }
                                            }
                                        }
                                    }

                                    // Step 9: Preserve prior staging — re-stage files that were
                                    // staged before the flow but not part of this commit
                                    val remainingStagedPaths = originalStagedPaths.filter { it !in selectedPathSet }
                                    if (remainingStagedPaths.isNotEmpty()) {
                                        git.stageFiles(remainingStagedPaths)
                                    }

                                    ApplicationManager.getApplication().invokeLater {
                                        Messages.showInfoMessage(project,
                                            "Committed! Post-commit hook is generating a summary in the background.",
                                            "Jolli Memory")
                                        service.refreshStatus()
                                    }
                                } catch (ex: Exception) {
                                    // Restore index on commit failure
                                    git.readTree(originalIndexTree)
                                    ApplicationManager.getApplication().invokeLater {
                                        Messages.showErrorDialog(project, "Commit failed: ${ex.message}", "Jolli Memory")
                                    }
                                }
                            }
                        } else {
                            // User cancelled — restore original index state
                            ApplicationManager.getApplication().executeOnPooledThread {
                                git.readTree(originalIndexTree)
                            }
                        }
                    }
                } catch (ex: Exception) {
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

    override fun update(e: AnActionEvent) {
        val service = e.project?.getService(JolliMemoryService::class.java)
        val status = service?.getStatus()
        val cwd = service?.mainRepoRoot ?: e.project?.basePath
        val workerBusy = cwd != null && SessionTracker.isWorkerBusy(cwd)
        e.presentation.isEnabled = status != null && status.enabled && !workerBusy
    }
}
