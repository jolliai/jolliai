package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.StorageFactory
import ai.jolli.jollimemory.core.SummaryStore
import ai.jolli.jollimemory.core.TraceContext
import ai.jolli.jollimemory.services.BranchShareModal
import ai.jolli.jollimemory.services.BranchShareModal.ShareModalState
import ai.jolli.jollimemory.services.JolliApiClient
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.services.JolliPushOrchestrator
import ai.jolli.jollimemory.services.ShareMessage
import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Toolkit
import java.awt.datatransfer.StringSelection
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import javax.swing.Action
import javax.swing.BoxLayout
import javax.swing.ButtonGroup
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JRadioButton

/**
 * Native Swing share UI, driven by the UI-agnostic [BranchShareModal] state machine.
 *
 * The dialog implements [BranchShareModal.ShareModalIO]: it renders the modal state into
 * Swing panes and maps user actions back to the state machine on a pooled thread. Network
 * work (push, create/patch, revoke) never runs on the EDT. Launched from the Swing sidebar
 * and from the "Share" button in the JCEF summary view (see [ShareLauncher]).
 */
class ShareDialog(
    project: Project,
    private val baseCtx: BranchShareModal.ShareModalContext,
) : DialogWrapper(project, false), BranchShareModal.ShareModalIO {

    private val project = project
    private val body = JPanel(BorderLayout())

    // Audience / expiry chosen in the UI; folded into the context on each action.
    private var visibility: String = baseCtx.visibility
    private var recipients: List<String> = baseCtx.recipients
    private var expiryDays: Int? = baseCtx.expiryDays

    init {
        title = if (baseCtx.commitHash != null) "Share memory" else "Share branch"
        setModal(true)
        init()
        openAsync()
    }

    override fun createCenterPanel(): JComponent {
        body.preferredSize = Dimension(480, 380)
        body.border = JBUI.Borders.empty(12)
        return body
    }

    // Actions are rendered inside the body; keep only a Close button in the button bar.
    override fun createActions(): Array<Action> = arrayOf(cancelAction.also { it.putValue(Action.NAME, "Close") })

    private fun ctx(): BranchShareModal.ShareModalContext =
        baseCtx.copy(
            visibility = visibility,
            recipients = recipients,
            expiryDays = expiryDays,
            nowMs = System.currentTimeMillis(),
        )

    private fun onPool(work: () -> Unit) {
        ApplicationManager.getApplication().executeOnPooledThread {
            TraceContext.withTrace { work() }
        }
    }

    private fun openAsync() = onPool { BranchShareModal.openShareModal(this, ctx()) }

    // ── ShareModalIO ─────────────────────────────────────────────────────────

    override fun postState(state: ShareModalState) {
        ApplicationManager.getApplication().invokeLater { render(state) }
    }

    override fun openUrl(url: String) = BrowserUtil.browse(url)

    override fun composeEmail(branch: String, url: String, decisionCount: Int, titles: List<String>, recipients: List<String>) {
        val email = ShareMessage.buildShareEmail(
            ShareMessage.ShareMessageInput(branch, url, decisionCount, titles, shareKind()),
        )
        val to = recipients.joinToString(",") { enc(it) }
        val mailto = "mailto:$to?subject=${enc(email.subject)}&body=${enc(email.body)}"
        BrowserUtil.browse(mailto)
    }

    override fun copyMessage(branch: String, url: String, decisionCount: Int, titles: List<String>) {
        val msg = ShareMessage.buildShareCopyMessage(
            ShareMessage.ShareMessageInput(branch, url, decisionCount, titles, shareKind()),
        )
        Toolkit.getDefaultToolkit().systemClipboard.setContents(StringSelection(msg), null)
        notify("Share message copied to clipboard.", NotificationType.INFORMATION)
    }

    override fun openSocial(platform: ShareMessage.SocialPlatform, branch: String, url: String, decisionCount: Int, titles: List<String>) {
        val intent = ShareMessage.buildSocialShareUrl(
            platform,
            ShareMessage.SocialShareInput(branch, url, decisionCount, titles, shareKind()),
        )
        BrowserUtil.browse(intent)
    }

    override fun formatExpiry(iso: String): String {
        return try {
            val date = Instant.parse(iso).atZone(ZoneId.systemDefault()).toLocalDate()
            "expires ${date.format(EXPIRY_FMT)}"
        } catch (_: Exception) {
            ""
        }
    }

    override fun notifyError(message: String) = notify(message, NotificationType.ERROR)
    override fun notifyInfo(message: String) = notify(message, NotificationType.INFORMATION)

    // ── Rendering ─────────────────────────────────────────────────────────────

    private fun render(state: ShareModalState) {
        body.removeAll()
        when (state) {
            is ShareModalState.NeedsApiKey -> body.add(
                message("Sign in to Jolli (Settings ▸ Tools ▸ Jolli Memory) to create a share link."),
                BorderLayout.NORTH,
            )
            is ShareModalState.Loading -> body.add(message(state.label), BorderLayout.NORTH)
            is ShareModalState.Error -> {
                val panel = column()
                panel.add(message(state.message))
                panel.add(JButton("Back").apply { addActionListener { openAsync() } })
                body.add(panel, BorderLayout.NORTH)
            }
            is ShareModalState.Revoked -> close(OK_EXIT_CODE)
            is ShareModalState.NeedsCreate -> renderNeedsCreate(state)
            is ShareModalState.Ready -> renderReady(state)
        }
        body.revalidate()
        body.repaint()
    }

    private fun renderNeedsCreate(state: ShareModalState.NeedsCreate) {
        visibility = state.visibility
        recipients = state.recipients
        val panel = column()
        panel.add(heading(state.subjectTitle.ifEmpty { state.subject }))
        panel.add(subtle("Create a read-only link to this ${if (baseCtx.commitHash != null) "memory" else "branch"}. Conversations never leave your machine."))
        panel.add(visibilityChooser(state.canOrg) { /* pre-create: just track selection */ })
        panel.add(expiryChooser(null) { /* pre-create: track selection */ })
        val create = JButton("Create share link").apply {
            addActionListener {
                onPool { BranchShareModal.createShareModal(this@ShareDialog, ctx()) }
            }
        }
        panel.add(create)
        body.add(panel, BorderLayout.NORTH)
    }

    private fun renderReady(state: ShareModalState.Ready) {
        visibility = state.visibility
        recipients = state.recipients
        val panel = column()
        panel.add(heading(state.subjectTitle.ifEmpty { state.subject }))
        panel.add(subtle("${state.decisionCount} decision${if (state.decisionCount == 1) "" else "s"} • ${state.expiresLabel}"))

        val urlField = JBTextField(state.shareUrl).apply { isEditable = false }
        panel.add(urlField)

        panel.add(visibilityChooser(state.canOrg) { newVis ->
            visibility = newVis
            onPool {
                BranchShareModal.setShareVisibilityModal(
                    this@ShareDialog, ctx(), newVis,
                    if (newVis == "people") recipients else null,
                )
            }
        })

        if (state.visibility == "people") {
            val field = JBTextField(state.recipients.joinToString(", "))
            val apply = JButton("Update people").apply {
                addActionListener {
                    recipients = field.text.split(",").map { it.trim() }.filter { it.isNotEmpty() }
                    onPool { BranchShareModal.setShareVisibilityModal(this@ShareDialog, ctx(), "people", recipients) }
                }
            }
            panel.add(labeled("People (emails, comma-separated):", field))
            panel.add(apply)
        }

        panel.add(expiryChooser(state.expiryDays) { days ->
            expiryDays = days
            val end = System.currentTimeMillis() + days.toLong() * 24L * 60L * 60L * 1000L
            val expiresAt = Instant.ofEpochMilli(end).toString()
            onPool { BranchShareModal.setShareExpiryModal(this@ShareDialog, ctx(), expiresAt) }
        })

        // Primary share actions.
        val actions = JPanel(FlowLayout(FlowLayout.LEFT, 6, 6))
        actions.add(JButton("Open page").apply { addActionListener { target(BranchShareModal.ShareTarget.Page) } })
        actions.add(JButton("Copy message").apply { addActionListener { target(BranchShareModal.ShareTarget.Copy) } })
        actions.add(JButton("Email").apply { addActionListener { target(BranchShareModal.ShareTarget.Email) } })
        panel.add(actions)

        // Social share row.
        val social = JPanel(FlowLayout(FlowLayout.LEFT, 6, 6))
        for ((label, platform) in SOCIALS) {
            social.add(JButton(label).apply {
                addActionListener { target(BranchShareModal.ShareTarget.Social(platform)) }
            })
        }
        panel.add(social)

        panel.add(JButton("Stop sharing").apply {
            addActionListener { onPool { BranchShareModal.revokeShareModal(this@ShareDialog, ctx()) } }
        })
        body.add(panel, BorderLayout.NORTH)
    }

    private fun target(t: BranchShareModal.ShareTarget) =
        onPool { BranchShareModal.shareModalTarget(this@ShareDialog, ctx(), t) }

    // ── Small Swing builders ───────────────────────────────────────────────────

    private fun column(): JPanel = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
    }

    private fun heading(text: String): JComponent = JBLabel("<html><b>${escapeHtml(text)}</b></html>")
    private fun subtle(text: String): JComponent = JBLabel(text).apply { foreground = JBUI.CurrentTheme.Label.disabledForeground() }
    private fun message(text: String): JComponent = JBLabel(text).apply { border = JBUI.Borders.emptyBottom(8) }

    private fun labeled(label: String, field: JComponent): JComponent {
        val p = JPanel(BorderLayout())
        p.add(JBLabel(label), BorderLayout.NORTH)
        p.add(field, BorderLayout.CENTER)
        return p
    }

    private fun visibilityChooser(canOrg: Boolean, onChange: (String) -> Unit): JComponent {
        val p = JPanel(FlowLayout(FlowLayout.LEFT, 6, 2))
        p.add(JBLabel("Who can open:"))
        val group = ButtonGroup()
        val options = buildList {
            add("public" to "Anyone with link")
            if (canOrg) add("org" to "Your org")
            add("people" to "Specific people")
        }
        for ((value, label) in options) {
            val radio = JRadioButton(label, visibility == value)
            radio.addActionListener { if (radio.isSelected) { visibility = value; onChange(value) } }
            group.add(radio)
            p.add(radio)
        }
        return p
    }

    private fun expiryChooser(currentDays: Int?, onChange: (Int) -> Unit): JComponent {
        val p = JPanel(FlowLayout(FlowLayout.LEFT, 6, 2))
        p.add(JBLabel("Expires in:"))
        val combo = JComboBox(EXPIRY_OPTIONS.map { it.first }.toTypedArray())
        val preselect = currentDays ?: expiryDays
        if (preselect != null) {
            val idx = EXPIRY_OPTIONS.indexOfFirst { it.second == preselect }
            if (idx >= 0) combo.selectedIndex = idx
        }
        combo.addActionListener {
            val days = EXPIRY_OPTIONS[combo.selectedIndex].second
            expiryDays = days
            onChange(days)
        }
        p.add(combo)
        return p
    }

    private fun shareKind(): ShareMessage.ShareKind =
        if (baseCtx.commitHash != null) ShareMessage.ShareKind.COMMIT else ShareMessage.ShareKind.BRANCH

    private fun notify(message: String, type: NotificationType) {
        ApplicationManager.getApplication().invokeLater {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("JolliMemory")
                .createNotification("Jolli Share", message, type)
                .notify(project)
        }
    }

    private fun enc(s: String): String = URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20")

    private fun escapeHtml(s: String): String =
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    companion object {
        private val EXPIRY_FMT = DateTimeFormatter.ofPattern("MMM d, yyyy")
        private val EXPIRY_OPTIONS = listOf("7 days" to 7, "30 days" to 30, "90 days" to 90, "1 year" to 365)
        private val SOCIALS = listOf(
            "X" to ShareMessage.SocialPlatform.X,
            "LinkedIn" to ShareMessage.SocialPlatform.LINKEDIN,
            "Reddit" to ShareMessage.SocialPlatform.REDDIT,
            "WhatsApp" to ShareMessage.SocialPlatform.WHATSAPP,
            "Telegram" to ShareMessage.SocialPlatform.TELEGRAM,
        )
    }
}

/**
 * Assembles a [BranchShareModal.ShareModalContext] (gathering config, owner, org directory
 * off the EDT) and shows a [ShareDialog]. The binding chooser is resolved via the existing
 * [BindingChooserDialog] so the share push self-heals an unbound repo.
 */
object ShareLauncher {

    private val log = JmLogger.create("ShareLauncher")

    /** Opens the share dialog for a single-commit share (the open memory). */
    fun openForCommit(project: Project, summary: CommitSummary) =
        open(project, summary.branch, summary.commitMessage, summary.commitHash, summary)

    /** Opens the share dialog for a whole-branch share. */
    fun openForBranch(project: Project, branch: String) =
        open(project, branch, branch, null, null)

    private fun open(
        project: Project,
        branch: String,
        subjectTitle: String,
        commitHash: String?,
        commitSummary: CommitSummary?,
    ) {
        val service = project.getService(JolliMemoryService::class.java)
        val cwd = service?.mainRepoRoot ?: project.basePath ?: ""
        ApplicationManager.getApplication().executeOnPooledThread {
            TraceContext.withTrace {
                val config = SessionTracker.loadConfig(cwd)
                val apiKey = config.jolliApiKey?.takeIf { it.isNotBlank() }
                val keyMeta = apiKey?.let { JolliApiClient.parseJolliApiKey(it) }
                val git = service?.getGitOps() ?: GitOps(cwd)
                val store = SummaryStore(cwd, git, StorageFactory.create(git, cwd))
                val owner = BranchShareModal.ShareMember(
                    name = git.exec("config", "user.name")?.trim().orEmpty(),
                    email = git.exec("config", "user.email")?.trim().orEmpty(),
                )
                val directory = if (apiKey != null) {
                    JolliApiClient.listOrgMembers(keyMeta?.u, apiKey)
                        .map { BranchShareModal.ShareMember(it.name, it.email) }
                } else {
                    emptyList()
                }

                val ctx = BranchShareModal.ShareModalContext(
                    workspaceRoot = cwd,
                    branch = branch,
                    apiKey = apiKey,
                    commitHash = commitHash,
                    commitSummary = commitSummary,
                    subjectTitle = subjectTitle,
                    visibility = "public",
                    recipients = emptyList(),
                    canOrg = keyMeta?.o != null,
                    owner = owner,
                    directory = directory,
                    loadBranchSummaries = {
                        service?.getBranchCommits()
                            ?.filter { it.hasSummary }
                            ?.mapNotNull { service.getSummary(it.hash) }
                            ?.reversed() // getBranchCommits is newest-first; share wants oldest-first
                            ?: emptyList()
                    },
                    storeSummary = { s, _ -> store.storeSummary(s, force = true) },
                    readPlanFromBranch = { slug -> store.readPlanFromBranch(slug) },
                    readNoteBody = { id -> service?.readArchivedNote(id) },
                    resolveBinding = { repoUrl -> resolveBindingViaChooser(project, repoUrl, keyMeta?.u, apiKey) },
                    nowMs = System.currentTimeMillis(),
                )

                ApplicationManager.getApplication().invokeLater {
                    ShareDialog(project, ctx).show()
                }
            }
        }
    }

    /**
     * Resolves an unbound repo by showing [BindingChooserDialog] on the EDT and blocking the
     * calling (pooled) thread until the user finishes. Mirrors SummaryPanel.handleBindingRequired.
     */
    private fun resolveBindingViaChooser(
        project: Project,
        repoUrl: String,
        baseUrl: String?,
        apiKey: String?,
    ): JolliPushOrchestrator.BindingOutcome {
        if (apiKey == null || baseUrl == null) return JolliPushOrchestrator.BindingOutcome.FAILED
        val spacesResult = try {
            JolliApiClient.listSpaces(baseUrl, apiKey)
        } catch (e: Exception) {
            log.warn("resolveBinding: listSpaces failed: ${e.message}")
            return JolliPushOrchestrator.BindingOutcome.FAILED
        }
        val suggestedRepoName = ai.jolli.jollimemory.bridge.GitRemoteUtils.deriveRepoNameFromUrl(repoUrl).ifEmpty { "repo" }
        var outcome = JolliPushOrchestrator.BindingOutcome.FAILED
        ApplicationManager.getApplication().invokeAndWait {
            if (BindingChooserDialog.isAlreadyOpen(repoUrl)) {
                outcome = JolliPushOrchestrator.BindingOutcome.ANOTHER_OPEN
                return@invokeAndWait
            }
            val dialog = BindingChooserDialog.open(
                project, repoUrl, suggestedRepoName,
                spacesResult.spaces, spacesResult.defaultSpaceId, baseUrl, apiKey,
            )
            dialog.show()
            outcome = when (dialog.getOutcome()) {
                is BindingChooserOutcome.Selected -> JolliPushOrchestrator.BindingOutcome.BOUND
                is BindingChooserOutcome.Cancelled -> JolliPushOrchestrator.BindingOutcome.CANCELLED
                is BindingChooserOutcome.AnotherOpen -> JolliPushOrchestrator.BindingOutcome.ANOTHER_OPEN
            }
        }
        return outcome
    }
}
