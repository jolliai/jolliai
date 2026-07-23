package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.*
import ai.jolli.jollimemory.core.ConversationOverlayStore.EntryIdentity
import ai.jolli.jollimemory.core.ConversationOverlayStore.OverlayEditRule
import ai.jolli.jollimemory.core.ConversationOverlayStore.OverlayKey
import com.intellij.icons.AllIcons
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.EditorTextField
import com.intellij.util.ui.JBUI
import java.awt.*
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.beans.PropertyChangeListener
import javax.swing.*

/**
 * Editor tab that renders a conversation transcript with inline edit/delete
 * capability, matching VS Code's ConversationDetailsPanel behavior.
 *
 * Opens as a non-modal editor tab — users can keep working, switch tabs,
 * and have multiple conversations open simultaneously.
 */
class ConversationFileEditor(
	private val project: Project,
	private val file: ConversationVirtualFile,
) : UserDataHolderBase(), FileEditor {

	private val item = file.item
	private val cwd = file.cwd

	/** Raw entries from the source transcript (pre-overlay). Used for identity derivation. */
	private var rawEntries: List<TranscriptEntry> = emptyList()

	/** Entries after overlay is applied (what the user sees). */
	private var displayEntries: List<TranscriptEntry> = emptyList()

	/** Pending edits: display-index → new content. */
	private val editedContent = mutableMapOf<Int, String>()

	/** Pending deletions: set of display-indices marked for removal. */
	private val deletedIndices = mutableSetOf<Int>()

	private val rootPanel = JPanel(BorderLayout())
	private val entriesPanel = JPanel().apply {
		layout = BoxLayout(this, BoxLayout.Y_AXIS)
	}
	private lateinit var scrollPane: JBScrollPane
	private val saveButton = JButton("Save All").apply { isEnabled = false }
	private val cancelButton = JButton("Cancel").apply { isEnabled = false }
	private val markAllDeletedButton = JButton("Mark All as Deleted").apply { isEnabled = true }
	private val statusLabel = JBLabel("").apply { foreground = JBColor.GRAY }

	/** Callback fired after a successful save or hide so the sidebar can refresh. */
	var onSaved: (() -> Unit)? = null

	init {
		buildUI()
		loadTranscript()
	}

	// ── FileEditor interface ────────────────────────────────────────────

	override fun getComponent(): JComponent = rootPanel
	override fun getPreferredFocusedComponent(): JComponent = rootPanel
	override fun getName(): String = "Conversation"
	override fun setState(state: FileEditorState) {}
	override fun isModified(): Boolean = editedContent.isNotEmpty() || deletedIndices.isNotEmpty()
	override fun isValid(): Boolean = true
	override fun addPropertyChangeListener(listener: PropertyChangeListener) {}
	override fun removePropertyChangeListener(listener: PropertyChangeListener) {}
	override fun getFile() = file
	override fun dispose() {}

	// ── UI construction ─────────────────────────────────────────────────

	private fun buildUI() {
		// Header
		val header = JPanel(BorderLayout()).apply {
			border = JBUI.Borders.empty(12, 16, 8, 16)
			val titleLabel = JBLabel(item.title).apply {
				font = font.deriveFont(Font.BOLD, font.size2D + 2f)
			}
			val sourceLabel = JBLabel("${item.source.name}  ·  ${item.messageCount} messages").apply {
				foreground = JBColor.GRAY
			}
			val headerLeft = JPanel().apply {
				layout = BoxLayout(this, BoxLayout.Y_AXIS)
				isOpaque = false
				add(titleLabel)
				add(Box.createVerticalStrut(JBUI.scale(4)))
				add(sourceLabel)
			}
			add(headerLeft, BorderLayout.CENTER)
		}

		// Scrollable transcript
		scrollPane = JBScrollPane(entriesPanel).apply {
			border = JBUI.Borders.empty()
			verticalScrollBarPolicy = ScrollPaneConstants.VERTICAL_SCROLLBAR_AS_NEEDED
		}

		// Footer
		val footer = JPanel(FlowLayout(FlowLayout.RIGHT, JBUI.scale(8), JBUI.scale(4))).apply {
			border = JBUI.Borders.empty(4, 16, 8, 16)
		}

		markAllDeletedButton.addActionListener { doMarkAllDeleted() }
		cancelButton.addActionListener { doCancel() }
		saveButton.addActionListener { doSave() }

		footer.add(statusLabel)
		footer.add(Box.createHorizontalGlue())
		footer.add(markAllDeletedButton)
		footer.add(cancelButton)
		footer.add(saveButton)

		rootPanel.add(header, BorderLayout.NORTH)
		rootPanel.add(scrollPane, BorderLayout.CENTER)
		rootPanel.add(footer, BorderLayout.SOUTH)
	}

	// ── Data loading ────────────────────────────────────────────────────

	private fun loadTranscript() {
		ApplicationManager.getApplication().executeOnPooledThread {
			val source = item.source
			val raw = TranscriptMessageCounter.loadUnreadTranscript(source, item.transcriptPath, cwd)
			val view = ConversationOverlayStore.loadView(OverlayKey(cwd, source, item.sessionId), raw)

			SwingUtilities.invokeLater {
				rawEntries = view.rawWithDeletesOnly
				displayEntries = view.displayed
				editedContent.clear()
				deletedIndices.clear()
				renderEntries()
				updateFooter()
				scrollPane.verticalScrollBar.value = 0
			}
		}
	}

	// ── Rendering ───────────────────────────────────────────────────────

	private fun renderEntries() {
		val scrollPos = scrollPane.verticalScrollBar.value

		entriesPanel.removeAll()
		if (displayEntries.isEmpty()) {
			entriesPanel.add(JBLabel("No transcript entries.").apply {
				border = JBUI.Borders.empty(16)
				foreground = JBColor.GRAY
			})
		} else {
			for ((i, entry) in displayEntries.withIndex()) {
				entriesPanel.add(createEntryRow(i, entry))
				entriesPanel.add(JSeparator().apply {
					maximumSize = Dimension(Int.MAX_VALUE, 1)
				})
			}
		}
		entriesPanel.add(Box.createVerticalGlue())
		entriesPanel.revalidate()
		entriesPanel.repaint()

		// Restore scroll position after rebuild
		SwingUtilities.invokeLater {
			scrollPane.verticalScrollBar.value = scrollPos
		}
	}

	private fun createEntryRow(index: Int, entry: TranscriptEntry): JPanel {
		val isDeleted = index in deletedIndices
		val displayContent = editedContent[index] ?: entry.content

		val row = JPanel(BorderLayout()).apply {
			border = JBUI.Borders.empty(8, 16)
			maximumSize = Dimension(Int.MAX_VALUE, Int.MAX_VALUE)
		}

		// Role label — "human" → "You"
		val roleName = if (entry.role == "human") "You" else entry.role.replaceFirstChar { it.uppercase() }
		val roleColor = if (entry.role == "human") {
			JBColor(Color(37, 99, 235), Color(96, 165, 250))
		} else {
			JBColor(Color(5, 150, 105), Color(52, 211, 153))
		}
		val roleLabel = JBLabel(roleName).apply {
			foreground = roleColor
			font = font.deriveFont(Font.BOLD, font.size2D - 1f)
		}

		// Content area — click to edit
		val contentLabel = JTextArea(displayContent).apply {
			isEditable = false
			isOpaque = false
			lineWrap = true
			wrapStyleWord = true
			border = JBUI.Borders.emptyTop(4)
			font = roleLabel.font.deriveFont(Font.PLAIN, roleLabel.font.size2D)
			if (isDeleted) {
				foreground = JBColor.GRAY
			}
			cursor = if (isDeleted) Cursor.getDefaultCursor() else Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
		}

		if (!isDeleted) {
			contentLabel.addMouseListener(object : MouseAdapter() {
				override fun mouseClicked(e: MouseEvent) {
					startEditing(index, entry, row)
				}
			})
		}

		// Delete/restore button
		val deleteBtn = JLabel(
			if (isDeleted) AllIcons.Actions.Undo else AllIcons.Actions.GC,
		).apply {
			cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
			toolTipText = if (isDeleted) "Restore" else "Delete"
			border = JBUI.Borders.emptyRight(8)
		}
		deleteBtn.addMouseListener(object : MouseAdapter() {
			override fun mouseClicked(e: MouseEvent) {
				if (isDeleted) {
					deletedIndices.remove(index)
				} else {
					deletedIndices.add(index)
				}
				renderEntries()
				updateFooter()
			}
		})

		// Format timestamp to h:mm a
		val formattedTime = entry.timestamp?.let { formatTimestamp(it) }

		// Top row: [delete btn] [role label] ... [timestamp]
		val leftHeader = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(4), 0)).apply {
			isOpaque = false
			add(deleteBtn)
			add(roleLabel)
		}
		val topRow = JPanel(BorderLayout()).apply {
			isOpaque = false
			add(leftHeader, BorderLayout.WEST)
			if (formattedTime != null) {
				add(JBLabel(formattedTime).apply {
					foreground = JBColor.GRAY
					font = font.deriveFont(font.size2D - 2f)
				}, BorderLayout.EAST)
			}
		}

		val leftContent = JPanel(BorderLayout()).apply {
			isOpaque = false
			add(topRow, BorderLayout.NORTH)
			add(contentLabel, BorderLayout.CENTER)
		}

		row.add(leftContent, BorderLayout.CENTER)

		return row
	}

	/** Parses an ISO-8601 or epoch-millis timestamp into local "h:mm a" format. */
	private fun formatTimestamp(ts: String): String {
		return try {
			val instant = try {
				java.time.Instant.parse(ts)
			} catch (_: Exception) {
				java.time.Instant.ofEpochMilli(ts.toLong())
			}
			val local = instant.atZone(java.time.ZoneId.systemDefault())
			local.format(java.time.format.DateTimeFormatter.ofPattern("h:mm a"))
		} catch (_: Exception) {
			ts
		}
	}

	private fun startEditing(index: Int, entry: TranscriptEntry, row: JPanel) {
		val currentContent = editedContent[index] ?: entry.content
		val editorField = EditorTextField(currentContent, project, null).apply {
			setOneLineMode(false)
			border = JBUI.Borders.empty(4)
		}

		// Replace row content with editor
		row.removeAll()
		row.add(editorField, BorderLayout.CENTER)
		row.revalidate()
		row.repaint()
		editorField.requestFocusInWindow()

		// Enable cancel immediately so user can back out
		cancelButton.isEnabled = true

		editorField.addFocusListener(object : java.awt.event.FocusAdapter() {
			override fun focusLost(e: java.awt.event.FocusEvent) {
				val newValue = editorField.text
				if (newValue != entry.content) {
					editedContent[index] = newValue
				} else {
					editedContent.remove(index)
				}
				renderEntries()
				updateFooter()
			}
		})
	}

	// ── Footer state ────────────────────────────────────────────────────

	private fun updateFooter() {
		val pendingCount = editedContent.size + deletedIndices.size
		val hasPending = pendingCount > 0
		saveButton.isEnabled = hasPending
		saveButton.text = if (hasPending) "Save All ($pendingCount)" else "Save All"
		cancelButton.isEnabled = hasPending
		markAllDeletedButton.isEnabled = deletedIndices.size < displayEntries.size

		val parts = mutableListOf<String>()
		if (editedContent.isNotEmpty()) parts.add("${editedContent.size} modified")
		if (deletedIndices.isNotEmpty()) parts.add("${deletedIndices.size} deleted")
		statusLabel.text = parts.joinToString(", ")
	}

	// ── Actions ─────────────────────────────────────────────────────────

	private fun doMarkAllDeleted() {
		for (i in displayEntries.indices) {
			deletedIndices.add(i)
		}
		renderEntries()
		updateFooter()
	}

	private fun doCancel() {
		editedContent.clear()
		deletedIndices.clear()
		renderEntries()
		updateFooter()
	}

	/**
	 * Saves pending edits/deletes as an overlay, auto-hides if all entries
	 * deleted, and refreshes the sidebar.
	 */
	fun doSave() {
		if (editedContent.isEmpty() && deletedIndices.isEmpty()) return

		val source = item.source
		val key = OverlayKey(cwd, source, item.sessionId)

		// Build identity-based rules from raw entries (pre-edit content)
		val newDeletes = mutableListOf<EntryIdentity>()
		val newEdits = mutableListOf<OverlayEditRule>()

		for (idx in deletedIndices) {
			if (idx < rawEntries.size) {
				val raw = rawEntries[idx]
				newDeletes.add(EntryIdentity(raw.role, raw.content, raw.timestamp))
			}
		}
		for ((idx, newContent) in editedContent) {
			// Delete wins over edit
			if (idx in deletedIndices) continue
			if (idx < rawEntries.size) {
				val raw = rawEntries[idx]
				newEdits.add(OverlayEditRule(raw.role, raw.content, raw.timestamp, newContent))
			}
		}

		saveButton.isEnabled = false
		saveButton.text = "Saving…"

		ApplicationManager.getApplication().executeOnPooledThread {
			try {
				ConversationOverlayStore.mergeAndSave(key, newDeletes, newEdits)

				// Check if all entries are now deleted (auto-hide)
				val raw = TranscriptMessageCounter.loadUnreadTranscript(source, item.transcriptPath, cwd)
				val remaining = ConversationOverlayStore.loadView(key, raw).displayed

				SwingUtilities.invokeLater {
					if (remaining.isEmpty()) {
						// Auto-hide: dismiss the conversation and close the tab
						ApplicationManager.getApplication().executeOnPooledThread {
							ConversationOverlayStore.hideConversation(cwd, source, item.sessionId)
							SwingUtilities.invokeLater {
								FileEditorManager.getInstance(project).closeFile(file)
								onSaved?.invoke()
							}
						}
					} else {
						// Reload to show updated state
						loadTranscript()
						onSaved?.invoke()
					}
				}
			} catch (e: Exception) {
				SwingUtilities.invokeLater {
					saveButton.isEnabled = true
					saveButton.text = "Save All"
					statusLabel.text = "Save failed: ${e.message}"
				}
			}
		}
	}

	companion object {
		private fun escapeHtml(text: String): String = text
			.replace("&", "&amp;")
			.replace("<", "&lt;")
			.replace(">", "&gt;")
	}
}
