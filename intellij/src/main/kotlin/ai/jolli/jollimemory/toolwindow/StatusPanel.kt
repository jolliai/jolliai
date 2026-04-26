package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.core.CodexSessionDiscoverer
import ai.jolli.jollimemory.core.GeminiSupport
import ai.jolli.jollimemory.core.JolliMemoryConfig
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.StorageFactory
import ai.jolli.jollimemory.core.SummaryStore
import ai.jolli.jollimemory.services.JolliApiClient
import ai.jolli.jollimemory.services.JolliAuthService
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Cursor
import java.awt.Graphics2D
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.awt.image.BufferedImage
import javax.swing.Box
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.ListCellRenderer
import javax.swing.ListSelectionModel
import javax.swing.SwingUtilities

/**
 * STATUS panel — matches VS Code StatusTreeProvider.
 *
 * Shows:
 *   - Title bar with site name (when connected) and vertical three-dots menu
 *   - Hooks (all installed / not fully installed)
 *   - Claude Code Sessions (count)
 *   - Stored Memories (branch / total)
 *   - Jolli Site (URL from API key, with green dot when connected)
 *   - Codex Integration (if detected)
 *   - Gemini Integration (if detected)
 *
 * The three-dots menu provides: Set Anthropic Key, Select Anthropic Model, Set Jolli API Key.
 * API keys are NOT displayed as status rows — they are managed only via the menu.
 */
class StatusPanel(
    private val project: Project,
    private val service: JolliMemoryService,
) : JPanel(BorderLayout()), Disposable {

    private val listModel = DefaultListModel<StatusRow>()
    private val statusList = JBList(listModel).apply {
        cellRenderer = StatusRowRenderer()
        selectionMode = ListSelectionModel.SINGLE_SELECTION
    }
    private val toggleButton = JButton("Enable Jolli Memory").apply {
        putClientProperty("JButton.buttonType", "default")
    }
    private val disabledLabel = JBLabel(
        "<html>" +
            "Every commit deserves a Memory.<br/><br/>" +
            "Jolli Memory automatically captures your AI conversations " +
            "and generates structured summaries for each commit — so you " +
            "always remember why.<br/><br/>" +
            "Summaries are stored locally alongside your project. The original " +
            "AI conversation is never stored — only the distilled summary." +
            "</html>",
    )
    private val statusListener: () -> Unit = { SwingUtilities.invokeLater { refreshUI() } }

    init {
        border = JBUI.Borders.empty(8)
        toggleButton.addActionListener { onToggle() }

        // Double-click on clickable rows triggers the action (dialog input)
        statusList.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 2) {
                    val idx = statusList.locationToIndex(e.point)
                    if (idx >= 0) {
                        val row = listModel.getElementAt(idx)
                        row.onClick?.invoke()
                    }
                }
            }
        })
        // Hand cursor for clickable items
        statusList.addMouseMotionListener(object : java.awt.event.MouseMotionAdapter() {
            override fun mouseMoved(e: MouseEvent) {
                val idx = statusList.locationToIndex(e.point)
                if (idx >= 0 && listModel.getElementAt(idx).onClick != null) {
                    statusList.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                } else {
                    statusList.cursor = Cursor.getDefaultCursor()
                }
            }
        })

        service.addStatusListener(statusListener)
        refreshUI()
    }

    /** Opens the full settings dialog. */
    private fun openSettingsDialog() {
        val dialog = SettingsDialog(project, service)
        if (dialog.showAndGet()) {
            refreshUI()
        }
    }

    private fun refreshUI() {
        removeAll()

        val status = service.getStatus()

        if (status == null || !status.enabled) {
            val wrapper = Box.createVerticalBox().apply {
                add(disabledLabel.apply {
                    alignmentX = Component.LEFT_ALIGNMENT
                })
                add(Box.createVerticalStrut(12))
                add(toggleButton.apply {
                    text = "Enable Jolli Memory"
                    isEnabled = true
                    alignmentX = Component.LEFT_ALIGNMENT
                    maximumSize = java.awt.Dimension(Int.MAX_VALUE, preferredSize.height)
                })
            }
            add(wrapper, BorderLayout.NORTH)
            // Register as default button so the LAF renders it as blue/primary
            SwingUtilities.invokeLater { toggleButton.rootPane?.defaultButton = toggleButton }
            revalidate(); repaint()
            return
        }

        // Enabled state — build status rows
        // Use main repo root for config (worktrees share config with main repo)
        val cwd = service.mainRepoRoot ?: project.basePath ?: ""
        val config = loadLayeredConfig(cwd)
        val branchSummaryCount = countBranchSummaries()

        listModel.clear()

        // 1. Hooks — detailed breakdown matching VS Code (Git + Claude + Gemini)
        val hookParts = mutableListOf<String>()
        if (status.gitHookInstalled) hookParts.add("3 Git")
        if (status.claudeHookInstalled) hookParts.add("2 Claude")
        if (status.geminiHookInstalled) hookParts.add("1 Gemini CLI")
        val hooksDescription = if (hookParts.isNotEmpty()) hookParts.joinToString(" + ") else "none installed"
        val hooksTooltip = listOf(
            "Git hooks: ${if (status.gitHookInstalled) "3 installed" else "not installed"} (post-commit, post-rewrite, prepare-commit-msg)",
            "Claude Code hooks: ${if (status.claudeHookInstalled) "2 installed" else "not installed"} (Stop, SessionStart)",
            "Gemini CLI hook: ${if (status.geminiHookInstalled) "installed" else "not installed"} (AfterAgent)",
        ).joinToString("\n")
        listModel.addElement(StatusRow(
            icon = if (status.gitHookInstalled) Icon.OK else Icon.ERROR,
            label = "Hooks",
            description = hooksDescription,
            tooltip = hooksTooltip,
        ))

        // 2. Sessions (generic label covering all integrations)
        listModel.addElement(StatusRow(
            icon = Icon.PULSE,
            label = "Sessions",
            description = "${status.activeSessions}",
            tooltip = "${status.activeSessions} active session${if (status.activeSessions != 1) "s" else ""} across all integrations",
        ))

        // 4. Stored Memories
        listModel.addElement(StatusRow(
            icon = Icon.BOOK,
            label = "Stored Memories",
            description = "$branchSummaryCount / ${status.summaryCount}",
            tooltip = "$branchSummaryCount on current branch, ${status.summaryCount} total across all branches",
        ))

        // 5. Jolli Site (from API key) — show site URL when configured
        if (!config.jolliApiKey.isNullOrBlank()) {
            val meta = JolliApiClient.parseJolliApiKey(config.jolliApiKey!!)
            val siteUrl = meta?.u
            if (siteUrl != null) {
                listModel.addElement(StatusRow(
                    icon = Icon.GLOBE,
                    label = "Jolli Site",
                    description = siteUrl.removePrefix("https://").removePrefix("http://"),
                    tooltip = "Resolved from Jolli API Key (tenant: ${meta.t})",
                ))
            }
        }

        // 6. Claude Integration — matches VS Code pushIntegrationItem() descriptions
        val claudeDetected = status.claudeDetected ?: false
        if (claudeDetected) {
            val claudeEnabled = config.claudeEnabled != false
            addIntegrationRow(
                enabled = claudeEnabled,
                hookInstalled = status.claudeHookInstalled,
                label = "Claude Integration",
                enabledTooltip = "Claude Code hooks installed (Stop, SessionStart) — session tracking is enabled",
                disabledTooltip = "Claude Code detected but session tracking is disabled in config",
                hookMissingTooltip = "Claude Code detected but hooks are not installed",
            )
        }

        // 7. Codex Integration (no hooks needed — just detection)
        val codexDetected = status.codexDetected ?: CodexSessionDiscoverer.isCodexInstalled()
        if (codexDetected) {
            val enabled = config.codexEnabled != false
            addIntegrationRow(
                enabled = enabled,
                hookInstalled = null,
                label = "Codex Integration",
                enabledTooltip = "Codex CLI sessions directory found — session discovery is enabled",
                disabledTooltip = "Codex CLI detected but session discovery is disabled in config",
                hookMissingTooltip = null,
            )
        }

        // 8. Gemini Integration
        val geminiDetected = status.geminiDetected ?: GeminiSupport.isGeminiInstalled()
        if (geminiDetected) {
            val enabled = config.geminiEnabled != false
            addIntegrationRow(
                enabled = enabled,
                hookInstalled = status.geminiHookInstalled,
                label = "Gemini Integration",
                enabledTooltip = "Gemini CLI AfterAgent hook installed — session tracking is enabled",
                disabledTooltip = "Gemini CLI detected but session tracking is disabled in config",
                hookMissingTooltip = "Gemini CLI detected but AfterAgent hook is not installed",
            )
        }

        add(JBScrollPane(statusList), BorderLayout.CENTER)

        revalidate(); repaint()
    }

    /** Loads config from the global config directory. */
    private fun loadLayeredConfig(cwd: String): JolliMemoryConfig {
        return SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir())
    }

    /**
     * Appends an integration status row to the list model.
     * Matches VS Code pushIntegrationItem() four-state logic:
     *   - disabled in config → WARN "detected but disabled"
     *   - enabled, no hooks needed (hookInstalled == null) → OK "detected & enabled"
     *   - enabled, hook not installed → WARN "hook not installed"
     *   - enabled, hook installed → OK "hook installed"
     */
    private fun addIntegrationRow(
        enabled: Boolean,
        hookInstalled: Boolean?,
        label: String,
        enabledTooltip: String,
        disabledTooltip: String,
        hookMissingTooltip: String?,
    ) {
        if (!enabled) {
            listModel.addElement(StatusRow(Icon.WARN, label, "detected but disabled", disabledTooltip))
        } else if (hookInstalled == null && hookMissingTooltip == null) {
            listModel.addElement(StatusRow(Icon.OK, label, "detected & enabled", enabledTooltip))
        } else if (hookInstalled == false && hookMissingTooltip != null) {
            listModel.addElement(StatusRow(Icon.WARN, label, "hook not installed", hookMissingTooltip))
        } else {
            listModel.addElement(StatusRow(Icon.OK, label, "hook installed", enabledTooltip))
        }
    }

    /**
     * Count summaries on the current branch using actual git history + index lookup.
     * Matches VS Code's StatusTreeProvider: get commits not-in-main via git log,
     * then check each hash against the summary index (including commit aliases).
     */
    private fun countBranchSummaries(): Int {
        val gitOps = service.getGitOps() ?: return 0
        val cwd = service.mainRepoRoot ?: return 0
        val store = SummaryStore(cwd, gitOps, StorageFactory.create(gitOps, cwd))

        // Get commit hashes on this branch (not in main)
        val logOutput = gitOps.getBranchCommits() ?: return 0
        val hashes = logOutput.lines()
            .filter { it.isNotBlank() }
            .mapNotNull { it.split("|").firstOrNull()?.trim() }
            .filter { it.isNotEmpty() }

        if (hashes.isEmpty()) return 0

        // Check against index + aliases (same as VS Code's indexEntryMap.has(hash))
        return store.filterCommitsWithSummary(hashes).size
    }

    private fun onToggle() {
        val status = service.getStatus()

        // Disabling — no scope dialog needed
        if (status?.enabled == true) {
            toggleButton.isEnabled = false
            toggleButton.text = "Disabling..."
            ApplicationManager.getApplication().executeOnPooledThread {
                service.uninstall()
                SwingUtilities.invokeLater {
                    toggleButton.isEnabled = true
                    refreshUI()
                }
            }
            return
        }

        // Enabling
        toggleButton.isEnabled = false
        toggleButton.text = "Enabling..."

        ApplicationManager.getApplication().executeOnPooledThread {
            // Initialize service if not yet done
            if (status == null) {
                service.initialize()
            }

            service.install()

            // Delay slightly to ensure file writes are visible, then refresh status
            // and force all panels to re-read state. This runs on the pooled thread
            // BEFORE switching to EDT, so the status is fully updated.
            service.refreshStatus()

            SwingUtilities.invokeLater {
                toggleButton.isEnabled = true
                refreshUI()
            }
        }
    }

    override fun dispose() {
        service.removeStatusListener(statusListener)
    }

    // ── Data model ──────────────────────────────────────────────────────────

    enum class Icon { OK, ERROR, WARN, PULSE, BOOK, GLOBE }

    data class StatusRow(
        val icon: Icon,
        val label: String,
        val description: String,
        val tooltip: String? = null,
        val onClick: (() -> Unit)? = null,
    )

    /** Custom renderer for status rows — icon + label + description. */
    private class StatusRowRenderer : ListCellRenderer<StatusRow> {
        private val panel = JPanel(BorderLayout()).apply { border = JBUI.Borders.empty(4, 8) }
        private val iconLabel = JLabel()
        private val textLabel = JLabel()
        private val descLabel = JLabel()

        /** Cache of white-tinted icons for selected state. */
        private val whiteIconCache = mutableMapOf<javax.swing.Icon, javax.swing.Icon>()

        /** Creates a white-tinted copy of the given icon, cached for reuse. */
        private fun whiteIcon(icon: javax.swing.Icon): javax.swing.Icon {
            return whiteIconCache.getOrPut(icon) {
                object : javax.swing.Icon {
                    override fun paintIcon(c: Component?, g: java.awt.Graphics, x: Int, y: Int) {
                        val w = icon.iconWidth
                        val h = icon.iconHeight
                        val image = BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB)
                        val ig = image.createGraphics()
                        icon.paintIcon(c, ig, 0, 0)
                        ig.dispose()
                        // Replace all non-transparent pixels with white, preserving alpha
                        for (py in 0 until h) {
                            for (px in 0 until w) {
                                val argb = image.getRGB(px, py)
                                val alpha = (argb ushr 24) and 0xFF
                                if (alpha > 0) {
                                    image.setRGB(px, py, (alpha shl 24) or 0xFFFFFF)
                                }
                            }
                        }
                        (g as? Graphics2D)?.drawImage(image, x, y, null)
                            ?: g.drawImage(image, x, y, null)
                    }
                    override fun getIconWidth() = icon.iconWidth
                    override fun getIconHeight() = icon.iconHeight
                }
            }
        }

        override fun getListCellRendererComponent(
            list: JList<out StatusRow>, value: StatusRow, index: Int,
            isSelected: Boolean, cellHasFocus: Boolean,
        ): Component {
            val baseIcon = when (value.icon) {
                StatusPanel.Icon.OK -> JolliMemoryIcons.Check
                StatusPanel.Icon.ERROR -> JolliMemoryIcons.X
                StatusPanel.Icon.WARN -> JolliMemoryIcons.Warning
                StatusPanel.Icon.PULSE -> JolliMemoryIcons.Pulse
                StatusPanel.Icon.BOOK -> JolliMemoryIcons.Book
                StatusPanel.Icon.GLOBE -> JolliMemoryIcons.Globe
            }
            iconLabel.icon = if (isSelected) whiteIcon(baseIcon) else baseIcon

            textLabel.text = value.label
            textLabel.font = list.font
            descLabel.text = "  ${value.description}"
            descLabel.font = list.font
            descLabel.foreground = if (isSelected) list.selectionForeground else Color.GRAY

            panel.removeAll()
            val left = JPanel(BorderLayout()).apply {
                isOpaque = false
                add(iconLabel, BorderLayout.WEST)
                add(Box.createHorizontalStrut(8).let { JPanel().apply { isOpaque = false; add(it) } }, BorderLayout.CENTER)
            }
            val center = JPanel(BorderLayout()).apply {
                isOpaque = false
                add(textLabel, BorderLayout.WEST)
                add(descLabel, BorderLayout.CENTER)
            }
            panel.add(left, BorderLayout.WEST)
            panel.add(center, BorderLayout.CENTER)

            panel.background = if (isSelected) list.selectionBackground else list.background
            textLabel.foreground = if (isSelected) list.selectionForeground else list.foreground
            panel.toolTipText = value.tooltip

            // Show hand cursor for clickable items
            if (value.onClick != null) {
                descLabel.foreground = if (isSelected) list.selectionForeground else Color(0x4A90D9)
            }

            return panel
        }
    }
}
