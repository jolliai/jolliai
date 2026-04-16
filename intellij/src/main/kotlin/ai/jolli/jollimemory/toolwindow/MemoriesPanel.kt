package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.core.SummaryIndexEntry
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.icons.AllIcons
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Cursor
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Toolkit
import java.awt.datatransfer.StringSelection
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.time.Duration
import java.time.Instant
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JLabel
import javax.swing.JOptionPane
import javax.swing.JPanel
import javax.swing.SwingConstants
import javax.swing.SwingUtilities

/**
 * Memories panel — lists all commit summaries from the JolliMemory orphan branch index.
 * Matches VS Code MemoriesTreeProvider: flat list of all memories across all branches,
 * sorted by commit date (newest first), with search/filter and pagination.
 *
 * Each memory renders as:
 *   [eye-icon] <commit message>         <relative date> [copy-icon]
 *
 * Hover tooltip shows branch, date, topics, and diff stats.
 * Click to view the commit summary. "Load More" item at the bottom for pagination.
 *
 * Uses independent JPanel instances per row (like ChangesPanel) instead of a
 * JBList cell renderer, which eliminates hover-shift artifacts caused by the
 * rubber-stamp rendering pattern.
 */
class MemoriesPanel(
    private val project: Project,
    private val service: JolliMemoryService,
) : JPanel(BorderLayout()), Disposable {

    companion object {
        /** Number of entries loaded per batch. */
        private const val PAGE_SIZE = 10
        /** Upper bound for entries loaded during search. */
        private const val MAX_SEARCH_ENTRIES = 500
    }

    private val listPanel = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
    }
    private val emptyLabel = JBLabel(
        "<html><center>No memories yet.<br/><br/>" +
            "Memories appear after AI-assisted commits<br/>are summarized by JolliMemory.</center></html>",
        SwingConstants.CENTER,
    )

    private var entries: List<SummaryIndexEntry> = emptyList()
    private var totalCount = 0
    private var loadedCount = PAGE_SIZE
    private var filter = ""
    private var loaded = false
    private val statusListener: () -> Unit = { SwingUtilities.invokeLater { refresh() } }

    init {
        border = JBUI.Borders.empty(8)

        service.addStatusListener(statusListener)
        ApplicationManager.getApplication().executeOnPooledThread { refreshFromIndex() }
    }

    fun refresh() {
        ApplicationManager.getApplication().executeOnPooledThread { refreshFromIndex() }
    }

    /** Loads the next page of entries. */
    fun loadMore() {
        loadedCount += PAGE_SIZE
        refresh()
    }

    /** Sets or clears the search filter. */
    fun setFilter(text: String) {
        filter = text.trim()
        // Reset pagination when filter changes
        loadedCount = PAGE_SIZE
        refresh()
    }

    /** Returns the current filter text. */
    fun getFilter(): String = filter

    private fun refreshFromIndex() {
        val status = service.getStatus()
        if (status == null) {
            SwingUtilities.invokeLater { showInitializing() }
            return
        }
        if (!status.enabled) {
            SwingUtilities.invokeLater { showDisabled() }
            return
        }

        try {
            val result = service.listMemoryEntries(
                count = if (filter.isNotEmpty()) MAX_SEARCH_ENTRIES else loadedCount,
                filter = filter.ifEmpty { null },
            )
            entries = result.first
            totalCount = result.second
        } catch (_: Exception) {
            entries = emptyList()
            totalCount = 0
        }
        loaded = true
        SwingUtilities.invokeLater { updateList() }
    }

    private fun showInitializing() {
        removeAll()
        emptyLabel.text = "<html><center>Initializing Jolli Memory...</center></html>"
        add(emptyLabel, BorderLayout.CENTER)
        revalidate(); repaint()
    }

    private fun showDisabled() {
        removeAll()
        val wrapper = javax.swing.Box.createVerticalBox().apply {
            add(JBLabel(
                "<html>" +
                    "Every commit deserves a Memory.<br/><br/>" +
                    "Jolli Memory automatically captures your AI conversations " +
                    "and generates structured summaries for each commit — so you " +
                    "always remember why.<br/><br/>" +
                    "Summaries are stored locally alongside your project. The original " +
                    "AI conversation is never stored — only the distilled summary." +
                    "</html>",
            ).apply { alignmentX = Component.LEFT_ALIGNMENT })
            add(javax.swing.Box.createVerticalStrut(12))
            add(javax.swing.JButton("Enable Jolli Memory").apply {
                putClientProperty("JButton.buttonType", "default")
                alignmentX = Component.LEFT_ALIGNMENT
                maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
                addActionListener { onEnableToggle(this) }
            })
        }
        add(wrapper, BorderLayout.NORTH)
        revalidate(); repaint()
    }

    /** Handles enable/disable toggle from the inline button. */
    private fun onEnableToggle(button: javax.swing.JButton) {
        val status = service.getStatus()

        if (status?.enabled == true) {
            button.isEnabled = false
            button.text = "Disabling..."
            ApplicationManager.getApplication().executeOnPooledThread {
                service.uninstall()
                SwingUtilities.invokeLater {
                    button.isEnabled = true
                    refresh()
                }
            }
            return
        }

        button.isEnabled = false
        button.text = "Enabling..."
        ApplicationManager.getApplication().executeOnPooledThread {
            if (status == null) {
                service.initialize()
            }
            service.install()
            SwingUtilities.invokeLater {
                button.isEnabled = true
                refresh()
            }
        }
    }

    private fun updateList() {
        removeAll()
        listPanel.removeAll()

        if (entries.isEmpty()) {
            if (filter.isNotEmpty()) {
                emptyLabel.text = "<html><center>No memories matching \"${escapeHtml(filter)}\".</center></html>"
            } else {
                emptyLabel.text = "<html><center>No memories yet.<br/><br/>" +
                    "Memories appear after AI-assisted commits<br/>are summarized by JolliMemory.</center></html>"
            }
            add(emptyLabel, BorderLayout.CENTER)
        } else {
            for (entry in entries) {
                listPanel.add(createMemoryRow(entry))
            }
            // Show "Load More" when more entries exist and no active filter
            if (filter.isEmpty() && loadedCount < totalCount) {
                listPanel.add(createLoadMoreRow())
            }
            // Push rows to the top when the list is shorter than the viewport
            listPanel.add(Box.createVerticalGlue())

            add(JBScrollPane(listPanel).apply {
                horizontalScrollBarPolicy = JBScrollPane.HORIZONTAL_SCROLLBAR_NEVER
            }, BorderLayout.CENTER)
        }
        revalidate(); repaint()
    }

    // ─── Row creation ─────────────────────────────────────────────────────────

    /**
     * Creates an independent JPanel for a single memory entry:
     *   [eye-icon] <message>         <relative date> [copy-icon]
     *
     * Layout: BorderLayout
     *   CENTER = eye icon + message (GridBagLayout, message fills remaining space)
     *   EAST   = date + copy icon (FlowLayout.RIGHT)
     *
     * Click on the row opens the summary; click on the copy icon copies the recall prompt.
     */
    private fun createMemoryRow(entry: SummaryIndexEntry): JPanel {
        val iconLabel = JLabel(JolliMemoryIcons.Eye)

        val messageLabel = JLabel(entry.commitMessage).apply {
            minimumSize = Dimension(0, preferredSize.height)
        }

        val dateLabel = JLabel(formatShortRelativeDate(entry.commitDate)).apply {
            foreground = Color.GRAY
        }

        val copyLabel = JLabel(AllIcons.Actions.Copy).apply {
            toolTipText = "Copy recall prompt"
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    copyRecallPrompt(entry)
                }
            })
        }

        // Left side: eye icon + message
        val leftPanel = JPanel(GridBagLayout()).apply {
            isOpaque = false
            val gbc = GridBagConstraints().apply {
                gridy = 0
                anchor = GridBagConstraints.WEST
                fill = GridBagConstraints.NONE
                weighty = 1.0
            }

            gbc.gridx = 0; gbc.weightx = 0.0; gbc.insets = JBUI.insetsRight(6)
            add(iconLabel, gbc)

            gbc.gridx = 1; gbc.weightx = 1.0; gbc.fill = GridBagConstraints.HORIZONTAL
            gbc.insets = JBUI.emptyInsets()
            add(messageLabel, gbc)
        }

        // Right side: date + copy icon
        val rightPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply {
            isOpaque = false
            add(dateLabel)
            add(Box.createHorizontalStrut(JBUI.scale(8)))
            add(copyLabel)
        }

        val row = JPanel(BorderLayout()).apply {
            isOpaque = true
            border = JBUI.Borders.empty(4, 8)
            alignmentX = Component.LEFT_ALIGNMENT
            add(leftPanel, BorderLayout.CENTER)
            add(rightPanel, BorderLayout.EAST)
            toolTipText = buildTooltipHtml(entry)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        }

        // Click anywhere on the row (except the copy icon) opens the summary
        val summaryClickListener = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 1) viewSummary(entry)
            }
        }
        for (child in listOf(iconLabel, messageLabel, dateLabel, leftPanel, row)) {
            child.addMouseListener(summaryClickListener)
        }

        // Constrain row height so BoxLayout doesn't stretch rows apart
        row.maximumSize = Dimension(Int.MAX_VALUE, row.preferredSize.height)
        return row
    }

    /** Creates a "Load More" row that triggers pagination when clicked. */
    private fun createLoadMoreRow(): JPanel {
        val label = JLabel("Load More").apply {
            foreground = Color(0x589DF6) // Link blue
            icon = AllIcons.General.ArrowDown
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        }

        val row = JPanel(BorderLayout()).apply {
            isOpaque = true
            border = JBUI.Borders.empty(4, 8)
            alignmentX = Component.LEFT_ALIGNMENT
            add(label, BorderLayout.WEST)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        }

        val clickListener = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 1) loadMore()
            }
        }
        label.addMouseListener(clickListener)
        row.addMouseListener(clickListener)

        row.maximumSize = Dimension(Int.MAX_VALUE, row.preferredSize.height)
        return row
    }

    // ─── Actions ──────────────────────────────────────────────────────────────

    /**
     * Copies the recall prompt to clipboard for use in Claude Code.
     * Matches VS Code's copyRecallPrompt: fetches the full summary to verify
     * it exists, then builds the recall prompt from the summary's branch name.
     */
    private fun copyRecallPrompt(entry: SummaryIndexEntry) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val summary = service.getSummary(entry.commitHash)
            SwingUtilities.invokeLater {
                if (summary == null) {
                    JOptionPane.showMessageDialog(
                        this, "No summary found for this commit.",
                        "Copy Recall Prompt", JOptionPane.WARNING_MESSAGE,
                    )
                    return@invokeLater
                }
                val prompt = "Use the Skill tool to execute the \"jolli-recall\" skill with args \"${summary.branch}\"."
                val clipboard = Toolkit.getDefaultToolkit().systemClipboard
                clipboard.setContents(StringSelection(prompt), null)
                com.intellij.openapi.ui.Messages.showInfoMessage(
                    project,
                    "Recall prompt copied \u2014 paste it into Claude Code.",
                    "Copy Recall Prompt",
                )
            }
        }
    }

    /** Opens the commit summary in an editor tab. */
    private fun viewSummary(entry: SummaryIndexEntry) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val summary = service.getSummary(entry.commitHash)
            SwingUtilities.invokeLater {
                if (summary != null) {
                    val vFile = SummaryVirtualFile(summary)
                    FileEditorManager.getInstance(project).openFile(vFile, true)
                } else {
                    JOptionPane.showMessageDialog(
                        this, "No summary found for ${entry.commitHash.take(8)}",
                        "Commit Memory", JOptionPane.INFORMATION_MESSAGE,
                    )
                }
            }
        }
    }

    override fun dispose() {
        service.removeStatusListener(statusListener)
    }

    // ─── Utility functions ──────────────────────────────────────────────────────

    /** Builds HTML tooltip matching VS Code's MarkdownString tooltip layout. */
    private fun buildTooltipHtml(entry: SummaryIndexEntry): String {
        val shortHash = entry.commitHash.take(8)
        val relDate = formatRelativeDate(entry.commitDate)
        val topicCount = entry.topicCount ?: 0

        val absDate = try {
            val instant = Instant.parse(entry.commitDate)
            val zdt = instant.atZone(java.time.ZoneId.systemDefault())
            java.time.format.DateTimeFormatter.ofPattern("MMMM d, yyyy h:mm a").format(zdt)
        } catch (_: Exception) {
            entry.commitDate.take(19)
        }

        val sb = StringBuilder("<html><div style='padding:2px 4px'>")
        sb.append("<p><b>${escapeHtml(entry.commitMessage)}</b></p>")
        sb.append("<p><code>$shortHash</code> on <code>${escapeHtml(entry.branch)}</code></p>")

        // Detail line: date + topics + diff stats
        val detailParts = mutableListOf<String>()
        if (topicCount > 0) {
            detailParts.add("$topicCount topic${if (topicCount != 1) "s" else ""}")
        }
        if (entry.diffStats != null) {
            val ds = entry.diffStats
            detailParts.add("${ds.filesChanged} file${if (ds.filesChanged != 1) "s" else ""}, +${ds.insertions} \u2212${ds.deletions}")
        }
        val detailLine = absDate + if (detailParts.isNotEmpty()) " \u00b7 ${detailParts.joinToString(" \u00b7 ")}" else ""
        sb.append("<p>$detailLine</p>")

        sb.append("</div></html>")
        return sb.toString()
    }

    /** Returns a short relative date like "1d ago", "3h ago". */
    private fun formatShortRelativeDate(isoDate: String): String {
        return try {
            val then = Instant.parse(isoDate)
            val now = Instant.now()
            val duration = Duration.between(then, now)
            val minutes = duration.toMinutes()
            val hours = duration.toHours()
            val days = duration.toDays()
            when {
                minutes < 1 -> "now"
                minutes < 60 -> "${minutes}m ago"
                hours < 24 -> "${hours}h ago"
                days < 30 -> "${days}d ago"
                days < 365 -> "${days / 30}mo ago"
                else -> "${days / 365}y ago"
            }
        } catch (_: Exception) {
            isoDate.take(10)
        }
    }

    /** Returns a full relative date like "2 days ago". */
    private fun formatRelativeDate(isoDate: String): String {
        return try {
            val then = Instant.parse(isoDate)
            val now = Instant.now()
            val duration = Duration.between(then, now)
            val minutes = duration.toMinutes()
            val hours = duration.toHours()
            val days = duration.toDays()
            when {
                minutes < 1 -> "just now"
                minutes < 60 -> "$minutes minute${if (minutes != 1L) "s" else ""} ago"
                hours < 24 -> "$hours hour${if (hours != 1L) "s" else ""} ago"
                days < 30 -> "$days day${if (days != 1L) "s" else ""} ago"
                days < 365 -> "${days / 30} month${if (days / 30 != 1L) "s" else ""} ago"
                else -> "${days / 365} year${if (days / 365 != 1L) "s" else ""} ago"
            }
        } catch (_: Exception) {
            isoDate.take(10)
        }
    }
}

private fun escapeHtml(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
