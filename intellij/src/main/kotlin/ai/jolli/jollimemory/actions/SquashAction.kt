package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.Summarizer
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.Toolkit
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JTextArea
import javax.swing.Action
import javax.swing.ScrollPaneConstants
import javax.swing.UIManager

/**
 * Squash selected commits with AI-generated combined message.
 * Matches VS Code SquashCommand.ts.
 *
 * Flow:
 *   1. Get selected commits from CommitsPanel (oldest-first order)
 *   2. Warn if any selected commits are already pushed to remote
 *   3. Generate combined squash message via AI
 *   4. Show dialog with editable message and two actions:
 *      - "Squash" → git reset --soft + git commit
 *      - "Squash & Push" → git reset --soft + git commit + git push --force-with-lease
 *   5. Execute the selected action
 *   6. Post-commit hook merges summaries via squash-pending.json
 */
class SquashAction : AnAction() {
    private val log = JmLogger.create("SquashAction")

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = project.getService(JolliMemoryService::class.java)
        val git = service.getGitOps() ?: return
        val cwd = service.mainRepoRoot ?: project.basePath ?: return

        if (SessionTracker.isWorkerBusy(cwd)) {
            Messages.showWarningDialog(project,
                "AI summary is being generated. Please wait a moment.",
                "Jolli Memory")
            return
        }

        val config = SessionTracker.loadConfig(cwd)

        // Get selected commits from CommitsPanel if available, otherwise use all branch commits
        val commitsPanel = service.panelRegistry?.commitsPanel
        val selectedCommits = commitsPanel?.getSelectedCommits()?.takeIf { it.isNotEmpty() }
        val commits = selectedCommits ?: service.getBranchCommits()
        if (commits.size < 2) {
            Messages.showWarningDialog(project, "Need at least 2 commits to squash.", "Jolli Memory")
            return
        }

        // Warn about already-pushed commits (matches VS Code force-push warning)
        val pushedCommits = commits.filter { it.isPushed }
        if (pushedCommits.isNotEmpty()) {
            val commitList = pushedCommits.joinToString("\n") { "\u2022 ${it.shortHash} ${it.message.take(60)}" }
            val warningText =
                "${pushedCommits.size} of the selected commit(s) have already been pushed to remote:\n\n" +
                    "$commitList\n\n" +
                    "Squashing will rewrite history. You will need to force push afterwards.\n" +
                    "This may affect collaborators on the same branch."
            val dialog = ForcePushWarningDialog(project, warningText)
            if (!dialog.showAndGet()) return
        }

        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Jolli Memory: Squashing...", false) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    // Get summaries for each commit to generate a good squash message
                    indicator.text = "Reading commit summaries..."
                    var ticketId: String? = null
                    val commitData = commits.map { c ->
                        val summary = service.getSummary(c.hash)
                        val topics = summary?.topics ?: emptyList()
                        // Take the first non-empty ticketId (matching VS Code behavior)
                        if (ticketId == null && !summary?.ticketId.isNullOrBlank()) {
                            ticketId = summary?.ticketId
                        }
                        c.message to topics
                    }

                    // Determine full vs partial squash (matching VS Code behavior)
                    val allBranchCommits = service.getBranchCommits()
                    val isFullSquash = commits.size >= allBranchCommits.size

                    // Generate squash message via AI (matching VS Code: abort on failure)
                    indicator.text = "Generating squash message..."
                    val message: String
                    if (config.apiKey.isNullOrBlank()) {
                        log.warn("No API key configured — cannot generate AI squash message")
                        ApplicationManager.getApplication().invokeLater {
                            Messages.showErrorDialog(project,
                                "No API key configured. Please set your Anthropic API key in the Jolli Memory settings.",
                                "Jolli Memory")
                        }
                        return
                    }
                    try {
                        log.info("Generating squash message via AI…")
                        message = Summarizer.generateSquashMessage(commitData, ticketId, isFullSquash, config.apiKey, config.model)
                        log.info("Squash message generated: %s", message)
                    } catch (ex: Exception) {
                        log.error("Failed to generate squash message: %s", ex.message)
                        ApplicationManager.getApplication().invokeLater {
                            Messages.showErrorDialog(project,
                                "Failed to generate squash message: ${ex.message}",
                                "Jolli Memory")
                        }
                        return
                    }

                    // Show dialog with editable message and two actions (matching VS Code QuickPick)
                    ApplicationManager.getApplication().invokeLater {
                        val dialog = SquashChoiceDialog(project, commits.size, message)
                        if (!dialog.showAndGet()) return@invokeLater

                        val edited = dialog.getMessage()
                        val shouldPush = dialog.shouldPush()
                        if (edited.isBlank()) return@invokeLater

                        ApplicationManager.getApplication().executeOnPooledThread {
                            indicator.text = "Squashing commits..."

                            // Order oldest-first (matching VS Code SquashCommand behavior).
                            // getBranchCommits() and getSelectedCommits() return newest-first.
                            val orderedCommits = commits.reversed()
                            val oldestHash = orderedCommits.first().hash
                            val newestHash = orderedCommits.last().hash
                            val hashes = orderedCommits.map { it.hash }

                            log.info("Squash: %d commits, oldest=%s newest=%s, push=%s",
                                hashes.size, oldestHash.take(8), newestHash.take(8), shouldPush)

                            // Step 1: Find the parent of the oldest commit (fork point).
                            // This is the correct reset target — NOT merge-base with main,
                            // which would reset ALL branch commits, not just the selected ones.
                            val forkPoint = git.exec("rev-parse", "$oldestHash^")?.trim()
                            if (forkPoint.isNullOrBlank()) {
                                log.error("Failed to resolve parent of oldest commit: %s", oldestHash)
                                ApplicationManager.getApplication().invokeLater {
                                    Messages.showErrorDialog(project,
                                        "Failed to resolve parent of oldest commit ($oldestHash).",
                                        "Jolli Memory")
                                }
                                return@executeOnPooledThread
                            }
                            log.info("Fork point resolved: %s", forkPoint.take(8))

                            // Step 2: Write plugin-source marker and squash-pending.json
                            // so the post-commit hook can merge summaries automatically.
                            SessionTracker.savePluginSource(cwd)
                            SessionTracker.saveSquashPending(hashes, forkPoint, cwd)

                            // Step 3: Soft reset to fork point (stages all changes)
                            val resetResult = git.exec("reset", "--soft", forkPoint)
                            log.info("git reset --soft %s → %s", forkPoint.take(8),
                                if (resetResult != null) "ok" else "FAILED")

                            // Step 4: Create the squash commit
                            val commitResult = git.exec("commit", "-m", edited)
                            if (commitResult == null) {
                                log.error("git commit failed after reset --soft")
                                ApplicationManager.getApplication().invokeLater {
                                    Messages.showErrorDialog(project,
                                        "Squash failed: git commit returned an error after reset. " +
                                            "Your changes are staged — you can commit manually.",
                                        "Jolli Memory")
                                }
                                return@executeOnPooledThread
                            }
                            log.info("Squash commit created successfully")

                            // Step 5: Optional force push (matching VS Code "Squash & Push")
                            if (shouldPush) {
                                indicator.text = "Pushing..."
                                val pushResult = git.exec("push", "--force-with-lease", timeoutSeconds = 30)
                                if (pushResult == null) {
                                    log.error("git push --force-with-lease failed")
                                    ApplicationManager.getApplication().invokeLater {
                                        Messages.showWarningDialog(project,
                                            "Squash succeeded but push failed. You can push manually.",
                                            "Jolli Memory")
                                        service.refreshStatus()
                                    }
                                    return@executeOnPooledThread
                                }
                                log.info("Force push completed successfully")
                            }

                            val actionLabel = if (shouldPush) "squashed and pushed" else "squashed"
                            ApplicationManager.getApplication().invokeLater {
                                Messages.showInfoMessage(project,
                                    "${commits.size} commits $actionLabel. Post-commit hook is merging summaries in the background.",
                                    "Jolli Memory")
                                service.refreshStatus()
                            }
                        }
                    }
                } catch (ex: Exception) {
                    ApplicationManager.getApplication().invokeLater {
                        Messages.showErrorDialog(project, "Squash failed: ${ex.message}", "Jolli Memory")
                    }
                }
            }
        })
    }

    override fun update(e: AnActionEvent) {
        val service = e.project?.getService(JolliMemoryService::class.java)
        val status = service?.getStatus()
        val cwd = service?.mainRepoRoot ?: e.project?.basePath
        val workerBusy = cwd != null && SessionTracker.isWorkerBusy(cwd)
        e.presentation.isEnabled = status != null && status.enabled && !workerBusy
    }
}

/**
 * Custom dialog for force-push warning that matches VS Code's modal warning:
 * - Button text: "Continue (I know force push is needed)" matching VS Code
 * - Content auto-sizes without scrollbar unless it exceeds 2/3 of screen height
 * - Warning icon displayed alongside the message
 */
private class ForcePushWarningDialog(
    project: Project,
    private val warningText: String,
) : DialogWrapper(project, false) {

    init {
        title = "Force Push Warning"
        setOKButtonText("Continue (I know force push is needed)")
        init()
    }

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(BorderLayout(12, 0)).apply {
            border = JBUI.Borders.empty(8)
        }

        // Warning icon on the left (matching VS Code's modal warning icon)
        val iconLabel = JLabel(UIManager.getIcon("OptionPane.warningIcon"))
        panel.add(iconLabel, BorderLayout.WEST)

        // Message text area — wraps and auto-sizes
        val textArea = JTextArea(warningText).apply {
            isEditable = false
            lineWrap = true
            wrapStyleWord = true
            isOpaque = false
            font = UIManager.getFont("Label.font")
            border = JBUI.Borders.empty()
        }

        // Compute max height as 2/3 of screen
        val screenHeight = Toolkit.getDefaultToolkit().screenSize.height
        val maxContentHeight = (screenHeight * 2) / 3

        // Wrap in scroll pane — scrollbar only appears if content exceeds 2/3 screen
        val scrollPane = JBScrollPane(textArea).apply {
            border = JBUI.Borders.empty()
            verticalScrollBarPolicy = ScrollPaneConstants.VERTICAL_SCROLLBAR_AS_NEEDED
            horizontalScrollBarPolicy = ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER
            // Set preferred width so text wrapping is calculated correctly
            preferredSize = Dimension(480, 0)
        }

        // Let the text area measure its natural height at the given width, then cap it
        textArea.setSize(460, Short.MAX_VALUE.toInt())
        val naturalHeight = textArea.preferredSize.height + 16
        val clampedHeight = minOf(naturalHeight, maxContentHeight)
        scrollPane.preferredSize = Dimension(480, clampedHeight)

        panel.add(scrollPane, BorderLayout.CENTER)
        return panel
    }
}

/**
 * Dialog with editable commit message and two actions matching VS Code's QuickPick:
 * - OK button: "Squash" (git reset --soft + git commit)
 * - Extra button: "Squash & Push" (git reset --soft + git commit + git push --force-with-lease)
 */
private class SquashChoiceDialog(
    project: Project,
    commitCount: Int,
    private val initialMessage: String,
) : DialogWrapper(project, true) {

    private val textArea = JTextArea(initialMessage, 4, 60).apply {
        lineWrap = true
        wrapStyleWord = true
        font = UIManager.getFont("TextField.font")
    }
    private var pushSelected = false

    init {
        title = "Squash $commitCount Commits"
        setOKButtonText("Squash")
        init()
    }

    fun getMessage(): String = textArea.text.trim()
    fun shouldPush(): Boolean = pushSelected

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(BorderLayout(0, 8)).apply {
            border = JBUI.Borders.empty(4)
        }
        panel.add(JLabel("Edit squash commit message:"), BorderLayout.NORTH)
        panel.add(JBScrollPane(textArea).apply {
            preferredSize = Dimension(500, 120)
        }, BorderLayout.CENTER)
        return panel
    }

    override fun createActions(): Array<Action> {
        val squashPushAction = object : DialogWrapperExitAction("Squash & Push", NEXT_USER_EXIT_CODE) {
            override fun actionPerformed(e: java.awt.event.ActionEvent?) {
                pushSelected = true
                close(OK_EXIT_CODE)
            }
        }
        return arrayOf(okAction, squashPushAction, cancelAction)
    }
}
