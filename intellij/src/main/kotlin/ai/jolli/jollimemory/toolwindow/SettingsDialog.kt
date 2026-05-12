package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.FolderStorage
import ai.jolli.jollimemory.core.JolliMemoryConfig
import ai.jolli.jollimemory.core.KBPathResolver
import ai.jolli.jollimemory.core.MetadataManager
import ai.jolli.jollimemory.core.MigrationEngine
import ai.jolli.jollimemory.core.OrphanBranchStorage
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.services.JolliAuthService
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.TextFieldWithBrowseButton
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.openapi.util.Disposer
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPasswordField
import com.intellij.ui.components.JBTabbedPane
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.CardLayout
import java.awt.Dimension
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultComboBoxModel
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingUtilities

/**
 * Settings dialog with four tabs:
 *
 *   1. AI Summary — provider selection (Anthropic direct vs Jolli proxy),
 *      with contextual Anthropic settings or Jolli sign-in prompt
 *   2. Sync to Jolli — cloud push settings, login-dependent
 *   3. Memory Bank — local storage folder, sort order, migration
 *   4. General — enabled platforms, exclude patterns, pause toggle
 */
class SettingsDialog(
    private val project: Project,
    private val service: JolliMemoryService,
) : DialogWrapper(project) {

    // ── Tab 1: AI Summary ──────────────────────────────────────────────────
    private val providerCombo = ComboBox(DefaultComboBoxModel(arrayOf("Anthropic", "Jolli"))).apply {
        maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
    }
    private val anthropicKeyField = JBPasswordField()
    private val modelCombo = ComboBox(DefaultComboBoxModel(arrayOf(
        "haiku — fastest, cheapest",
        "sonnet — balanced (default)",
        "opus — most detailed",
    ))).apply {
        maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
        setMinimumAndPreferredWidth(250)
    }
    private val maxTokensField = JBTextField()
    private val anthropicCardLayout = CardLayout()
    private val anthropicCardPanel = JPanel(anthropicCardLayout)
    private lateinit var signInForSummaryButton: JButton

    // ── Tab 2: Sync to Jolli ───────────────────────────────────────────────
    private val syncCardLayout = CardLayout()
    private val syncCardPanel = JPanel(syncCardLayout)
    private lateinit var signInForSyncButton: JButton

    // ── Tab 3: Memory Bank ─────────────────────────────────────────────────
    private val kbPathField = TextFieldWithBrowseButton().apply {
        addBrowseFolderListener(
            project,
            FileChooserDescriptorFactory.createSingleFolderDescriptor()
                .withTitle("Memory Bank Folder")
                .withDescription("Select the root folder for your local Memory Bank"),
        )
    }
    private val kbSortCombo = ComboBox(DefaultComboBoxModel(arrayOf("date", "name"))).apply {
        maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
    }
    private var defaultKBPath: String = ""

    // ── Tab 4: General ─────────────────────────────────────────────────────
    private val claudeEnabledCheckbox = JBCheckBox("Claude Code — Session tracking via Stop hook", true)
    private val codexEnabledCheckbox = JBCheckBox("Codex CLI — Session discovery via filesystem scan", true)
    private val geminiEnabledCheckbox = JBCheckBox("Gemini CLI — Session tracking via AfterAgent hook", true)
    private val openCodeEnabledCheckbox = JBCheckBox("OpenCode — Session discovery via SQLite database scan", true)
    private val cursorEnabledCheckbox = JBCheckBox("Cursor IDE — Composer session discovery via SQLite database scan", true)
    private val excludePatternsField = JBTextField()
    private val pauseCheckbox = JBCheckBox("Pause Jolli Memory (temporarily disable hooks without losing configuration)")

    // ── State ──────────────────────────────────────────────────────────────
    private var savedAnthropicKey: String = ""
    private var maskedAnthropicKey: String = ""
    private var jolliApiKeyFieldRef: JBTextField? = null
    private var jolliSiteLabelRef: JBLabel? = null
    private var advancedLinkRef: JBLabel? = null
    private var advancedPanelRef: JPanel? = null
    private var anthropicWarningRef: JBLabel? = null
    private var syncApiKeyFieldRef: JBTextField? = null
    private var syncAdvancedPanelRef: JPanel? = null
    private val authListenerDisposable: Disposable

    init {
        title = "Jolli Memory Settings"
        setOKButtonText("Apply Changes")
        init()
        loadSettings()

        authListenerDisposable = JolliAuthService.addAuthListener {
            SwingUtilities.invokeLater {
                refreshJolliFields()
                syncProviderCard()
                syncSyncCard()
            }
        }
        Disposer.register(disposable, Disposable { Disposer.dispose(authListenerDisposable) })
    }

    override fun createCenterPanel(): JComponent {
        val tabbedPane = JBTabbedPane()
        tabbedPane.addTab("AI Agents", buildAgentsTab())
        tabbedPane.addTab("AI Summary", buildAiSummaryTab())
        tabbedPane.addTab("Sync to Jolli", buildSyncTab())
        tabbedPane.addTab("Memory Bank", buildMemoryBankTab())
        tabbedPane.addTab("Others", buildGeneralTab())

        // Restore last selected tab and track changes
        tabbedPane.selectedIndex = lastSelectedTab.coerceIn(0, tabbedPane.tabCount - 1)
        tabbedPane.addChangeListener { lastSelectedTab = tabbedPane.selectedIndex }

        // Initial card states
        syncProviderCard()
        syncSyncCard()

        return JPanel(BorderLayout()).apply {
            add(tabbedPane, BorderLayout.CENTER)
            preferredSize = Dimension(480, 360)
        }
    }

    // ── Tab builders ───────────────────────────────────────────────────────

    private fun buildAgentsTab(): JComponent {
        val panel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(12)
        }

        panel.add(JBLabel("<html><span style='color:gray'>Choose which AI agents to track.</span></html>").apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            border = JBUI.Borders.emptyBottom(8)
        })

        panel.add(createStretchedFormPanel(FormBuilder.createFormBuilder()
            .addComponent(claudeEnabledCheckbox, 4)
            .addComponent(codexEnabledCheckbox, 4)
            .addComponent(geminiEnabledCheckbox, 4)
            .addComponent(openCodeEnabledCheckbox, 4)
            .addComponent(cursorEnabledCheckbox, 4)
            .panel))

        return wrapTabContent(panel)
    }

    private fun buildAiSummaryTab(): JComponent {
        val panel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(12)
        }

        panel.add(createStretchedFormPanel(FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Provider:"), providerCombo, 1, false)
            .addTooltip("Choose how AI summaries are generated for each commit")
            .panel))

        // Anthropic card: warning + key + model + max tokens
        val anthropicWarning = JBLabel(
            "<html><span style='color:#D29922'>\u26A0</span> API key is empty. AI summaries won't work without it.</html>"
        ).apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            border = JBUI.Borders.emptyBottom(6)
            isVisible = false
        }
        this.anthropicWarningRef = anthropicWarning
        val anthropicContent = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            alignmentX = JComponent.LEFT_ALIGNMENT
            add(Box.createVerticalStrut(8))
            add(anthropicWarning)
            add(JBLabel("<html><span style='color:gray'>Calls go directly to Anthropic.</span></html>").apply {
                alignmentX = JComponent.LEFT_ALIGNMENT
                border = JBUI.Borders.emptyBottom(6)
            })
            add(createStretchedFormPanel(FormBuilder.createFormBuilder()
                .addLabeledComponent(JBLabel("API Key:"), anthropicKeyField, 1, false)
                .addTooltip("Your Anthropic API key (sk-ant-...). Get one at console.anthropic.com")
                .addLabeledComponent(JBLabel("Model:"), modelCombo, 1, false)
                .addLabeledComponent(JBLabel("Max Output Tokens:"), maxTokensField, 1, false)
                .addTooltip("Max length of the generated summary. Default: 8192")
                .panel))
        }

        // Jolli signed-in card
        signInForSummaryButton = JButton("Sign In to Jolli").apply {
            putClientProperty("JButton.buttonType", "default")
            alignmentX = JComponent.LEFT_ALIGNMENT
            maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
            addActionListener { handleSignIn(this) }
        }
        val jolliSiteLabel = JBLabel().apply { alignmentX = JComponent.LEFT_ALIGNMENT }
        val jolliApiKeyField = JBTextField().apply {
            isEditable = true
            alignmentX = JComponent.LEFT_ALIGNMENT
            maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
        }
        val advancedPanel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            alignmentX = JComponent.LEFT_ALIGNMENT
            isVisible = false
            add(Box.createVerticalStrut(6))
            add(createStretchedFormPanel(FormBuilder.createFormBuilder()
                .addLabeledComponent(JBLabel("Jolli API Key:"), jolliApiKeyField, 1, false)
                .addTooltip("sk-jol-... — auto-filled on sign-in, or paste a new one")
                .panel))
        }
        val advancedLink = JBLabel("<html><a href='#'>Advanced</a></html>").apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
            addMouseListener(object : java.awt.event.MouseAdapter() {
                override fun mouseClicked(e: java.awt.event.MouseEvent) {
                    advancedPanel.isVisible = !advancedPanel.isVisible
                    text = if (advancedPanel.isVisible) "<html><a href='#'>Hide Advanced</a></html>"
                        else "<html><a href='#'>Advanced</a></html>"
                    advancedPanel.revalidate()
                    advancedPanel.repaint()
                }
            })
        }

        // Save references for populateFields(), doOKAction, and syncProviderCard
        this.jolliApiKeyFieldRef = jolliApiKeyField
        this.jolliSiteLabelRef = jolliSiteLabel
        this.advancedLinkRef = advancedLink
        this.advancedPanelRef = advancedPanel

        val jolliSignedInContent = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            alignmentX = JComponent.LEFT_ALIGNMENT
            add(Box.createVerticalStrut(8))
            add(jolliSiteLabel)
        }
        val reSignInButton = JButton("Sign Out & Re-login").apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            addActionListener {
                JolliAuthService.signOut()
                // After sign-out, the auth listener will flip to the sign-in card
            }
        }
        val jolliNoKeyContent = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            alignmentX = JComponent.LEFT_ALIGNMENT
            add(Box.createVerticalStrut(8))
            add(JBLabel("<html><span style='color:#D29922'>\u26A0</span> Signed in but Jolli API Key is missing.<br/>" +
                "Enter your key below, or sign out and sign in again.</html>").apply {
                alignmentX = JComponent.LEFT_ALIGNMENT
            })
            add(Box.createVerticalStrut(6))
            add(reSignInButton)
        }
        val jolliSignedOutContent = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            alignmentX = JComponent.LEFT_ALIGNMENT
            add(Box.createVerticalStrut(8))
            add(JBLabel("<html><span style='color:gray'>Sign in to use Jolli for AI summarization</span></html>").apply {
                alignmentX = JComponent.LEFT_ALIGNMENT
            })
            add(Box.createVerticalStrut(6))
            add(signInForSummaryButton)
        }

        // Update Anthropic warning as user types
        anthropicKeyField.document.addDocumentListener(object : javax.swing.event.DocumentListener {
            private fun update() {
                val hasKey = String(anthropicKeyField.password).isNotBlank() ||
                    !System.getenv("ANTHROPIC_API_KEY").isNullOrBlank()
                anthropicWarningRef?.isVisible = !hasKey
            }
            override fun insertUpdate(e: javax.swing.event.DocumentEvent) = update()
            override fun removeUpdate(e: javax.swing.event.DocumentEvent) = update()
            override fun changedUpdate(e: javax.swing.event.DocumentEvent) = update()
        })

        anthropicCardPanel.add(anthropicContent, CARD_ANTHROPIC)
        anthropicCardPanel.add(jolliSignedInContent, CARD_JOLLI_OK)
        anthropicCardPanel.add(jolliNoKeyContent, CARD_JOLLI_NOKEY)
        anthropicCardPanel.add(jolliSignedOutContent, CARD_JOLLI_SIGNIN)
        anthropicCardPanel.alignmentX = JComponent.LEFT_ALIGNMENT
        panel.add(anthropicCardPanel)

        // Advanced panel — always below the card, visible for both OK and NoKey states
        panel.add(advancedLink)
        panel.add(advancedPanel)

        providerCombo.addItemListener { syncProviderCard() }

        return wrapTabContent(panel)
    }

    private fun buildSyncTab(): JComponent {
        val panel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(12)
        }

        signInForSyncButton = JButton("Sign In to Jolli").apply {
            putClientProperty("JButton.buttonType", "default")
            alignmentX = JComponent.LEFT_ALIGNMENT
            maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
            addActionListener { handleSignIn(this) }
        }

        val syncSignedOut = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            alignmentX = JComponent.LEFT_ALIGNMENT
            add(JBLabel("<html><span style='color:gray'>Sign in to push memories to Jolli cloud.</span></html>").apply {
                alignmentX = JComponent.LEFT_ALIGNMENT
            })
            add(Box.createVerticalStrut(6))
            add(signInForSyncButton)
        }
        val syncSignedIn = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            alignmentX = JComponent.LEFT_ALIGNMENT
            add(JBLabel("<html><span style='color:#3FB950'>\u2713</span> Signed in — ready to push memories</html>").apply {
                alignmentX = JComponent.LEFT_ALIGNMENT
            })
            add(Box.createVerticalStrut(6))
            add(JButton("Sign Out").apply {
                alignmentX = JComponent.LEFT_ALIGNMENT
                addActionListener { JolliAuthService.signOut() }
            })
        }

        // Sync no-key: re-login button + advanced API key field
        val syncReLoginButton = JButton("Sign Out & Re-login").apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            addActionListener {
                JolliAuthService.signOut()
            }
        }
        val syncApiKeyField = JBTextField().apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
        }
        this.syncApiKeyFieldRef = syncApiKeyField

        val syncAdvancedPanel = JPanel().also { this.syncAdvancedPanelRef = it }.apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            alignmentX = JComponent.LEFT_ALIGNMENT
            isVisible = false
            add(Box.createVerticalStrut(6))
            add(createStretchedFormPanel(FormBuilder.createFormBuilder()
                .addLabeledComponent(JBLabel("Jolli API Key:"), syncApiKeyField, 1, false)
                .addTooltip("sk-jol-... — paste your Jolli API key here")
                .panel))
        }
        val syncAdvancedLink = JBLabel("<html><a href='#'>Advanced</a></html>").apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
            addMouseListener(object : java.awt.event.MouseAdapter() {
                override fun mouseClicked(e: java.awt.event.MouseEvent) {
                    syncAdvancedPanel.isVisible = !syncAdvancedPanel.isVisible
                    text = if (syncAdvancedPanel.isVisible) "<html><a href='#'>Hide Advanced</a></html>"
                        else "<html><a href='#'>Advanced</a></html>"
                    syncAdvancedPanel.revalidate()
                    syncAdvancedPanel.repaint()
                }
            })
        }

        val syncNoKey = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            alignmentX = JComponent.LEFT_ALIGNMENT
            add(JBLabel("<html><span style='color:#D29922'>\u26A0</span> Signed in but Jolli API Key is missing.<br/>" +
                "Re-login to get the key automatically, or enter it manually.</html>").apply {
                alignmentX = JComponent.LEFT_ALIGNMENT
            })
            add(Box.createVerticalStrut(6))
            add(syncReLoginButton)
            add(Box.createVerticalStrut(4))
            add(syncAdvancedLink)
            add(syncAdvancedPanel)
        }

        syncCardPanel.add(syncSignedOut, CARD_SYNC_SIGNEDOUT)
        syncCardPanel.add(syncNoKey, CARD_SYNC_NOKEY)
        syncCardPanel.add(syncSignedIn, CARD_SYNC_SIGNEDIN)
        syncCardPanel.alignmentX = JComponent.LEFT_ALIGNMENT
        panel.add(syncCardPanel)

        return wrapTabContent(panel)
    }

    private fun buildMemoryBankTab(): JComponent {
        val panel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(12)
        }

        panel.add(createStretchedFormPanel(FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Folder Path:"), kbPathField, 1, false)
            .addTooltip("Root folder for all memory data. Each repo gets its own subfolder. Default: ~/Documents/jolli/")
            .addLabeledComponent(JBLabel("Sort Order:"), kbSortCombo, 1, false)
            .addTooltip("How files are sorted in the Memory Bank explorer")
            .addComponent(createMigrateButton(), 12)
            .panel))

        return wrapTabContent(panel)
    }

    private fun buildGeneralTab(): JComponent {
        val panel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(12)
        }

        panel.add(JBLabel("<html><b>Exclude Patterns</b></html>").apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            border = JBUI.Borders.emptyBottom(2)
        })
        panel.add(JBLabel("<html><span style='color:gray'>Hide files from the Changes panel and AI commits.</span></html>").apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            border = JBUI.Borders.emptyBottom(4)
        })
        panel.add(createStretchedFormPanel(FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Patterns:"), excludePatternsField, 1, false)
            .addTooltip("Comma-separated globs, e.g. **/*.vsix, dist/**, node_modules/*")
            .panel))

        panel.add(Box.createVerticalStrut(12))
        panel.add(createStretchedFormPanel(FormBuilder.createFormBuilder()
            .addComponent(pauseCheckbox, 4)
            .addTooltip("Uninstalls hooks while preserving all settings. Unpause to re-enable.")
            .panel))

        return wrapTabContent(panel)
    }

    /** Wraps tab content so it aligns to the top instead of centering vertically. */
    private fun wrapTabContent(content: JPanel): JComponent {
        return JPanel(BorderLayout()).apply {
            add(content, BorderLayout.NORTH)
        }
    }

    // ── Card sync logic ────────────────────────────────────────────────────

    /** Reloads Jolli API key and site label from config (e.g. after sign-in/sign-out). */
    private fun refreshJolliFields() {
        val config = SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir())
        val jolliKey = config.jolliApiKey ?: ""
        jolliApiKeyFieldRef?.text = jolliKey
        syncApiKeyFieldRef?.text = jolliKey
        val meta = if (jolliKey.isNotBlank()) ai.jolli.jollimemory.services.JolliApiClient.parseJolliApiKey(jolliKey) else null
        val siteDisplay = meta?.u?.removePrefix("https://")?.removePrefix("http://") ?: ""
        jolliSiteLabelRef?.text = if (siteDisplay.isNotBlank()) {
            "<html><span style='color:#3FB950'>\u2713</span> Signed in to <b>$siteDisplay</b> — using Jolli to generate summaries</html>"
        } else {
            "<html><span style='color:#3FB950'>\u2713</span> Using Jolli to generate summaries</html>"
        }
    }

    /** Checks if a Jolli API key exists in config (the actual credential for API calls). */
    private fun hasJolliApiKey(): Boolean {
        val config = SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir())
        return !config.jolliApiKey.isNullOrBlank()
    }

    private fun syncProviderCard() {
        val provider = providerCombo.selectedItem as String
        if (provider == "Anthropic") {
            anthropicCardLayout.show(anthropicCardPanel, CARD_ANTHROPIC)
            val hasKey = getEffectiveAnthropicKey().isNotBlank() ||
                !System.getenv("ANTHROPIC_API_KEY").isNullOrBlank()
            anthropicWarningRef?.isVisible = !hasKey
            advancedLinkRef?.isVisible = false
            advancedPanelRef?.isVisible = false
        } else if (hasJolliApiKey()) {
            anthropicCardLayout.show(anthropicCardPanel, CARD_JOLLI_OK)
            advancedLinkRef?.isVisible = true
        } else if (JolliAuthService.isSignedIn()) {
            anthropicCardLayout.show(anthropicCardPanel, CARD_JOLLI_NOKEY)
            // Auto-show Advanced so user can enter the missing key
            advancedLinkRef?.isVisible = false
            advancedPanelRef?.isVisible = true
        } else {
            anthropicCardLayout.show(anthropicCardPanel, CARD_JOLLI_SIGNIN)
            advancedLinkRef?.isVisible = false
            advancedPanelRef?.isVisible = false
        }
        anthropicCardPanel.revalidate()
        anthropicCardPanel.repaint()
    }

    private fun syncSyncCard() {
        val signedIn = JolliAuthService.isSignedIn()
        val hasKey = hasJolliApiKey()
        if (signedIn && hasKey) {
            syncCardLayout.show(syncCardPanel, CARD_SYNC_SIGNEDIN)
        } else if (signedIn && !hasKey) {
            syncCardLayout.show(syncCardPanel, CARD_SYNC_NOKEY)
        } else {
            syncCardLayout.show(syncCardPanel, CARD_SYNC_SIGNEDOUT)
        }
        syncCardPanel.revalidate()
        syncCardPanel.repaint()
    }

    private fun handleSignIn(button: JButton) {
        button.isEnabled = false
        button.text = "Signing in..."
        JolliAuthService.login(
            onSuccess = { _ ->
                SwingUtilities.invokeLater {
                    button.isEnabled = true
                    button.text = "Sign In to Jolli"
                    syncProviderCard()
                    syncSyncCard()
                }
            },
            onError = { msg ->
                SwingUtilities.invokeLater {
                    button.isEnabled = true
                    button.text = "Sign In to Jolli"
                    com.intellij.notification.Notifications.Bus.notify(
                        com.intellij.notification.Notification(
                            "JolliMemory", "Sign In Failed", msg,
                            com.intellij.notification.NotificationType.ERROR,
                        )
                    )
                }
            },
        )
    }

    // ── Validation & save ──────────────────────────────────────────────────

    override fun doValidate(): ValidationInfo? {
        val provider = providerCombo.selectedItem as String
        if (provider == "Anthropic") {
            val typed = String(anthropicKeyField.password)
            // Only validate format if the user typed something new (not blank, not the masked display)
            if (typed.isNotBlank() && typed != maskedAnthropicKey && !typed.startsWith("sk-ant-")) {
                return ValidationInfo("Anthropic API Key should start with sk-ant-", anthropicKeyField)
            }
        } else if (provider == "Jolli" && !JolliAuthService.isSignedIn()) {
            return ValidationInfo("Sign in to Jolli first to use it as AI provider", providerCombo)
        }

        val maxTokensText = maxTokensField.text.trim()
        if (maxTokensText.isNotBlank()) {
            val parsed = maxTokensText.toIntOrNull()
            if (parsed == null || parsed < 1) {
                return ValidationInfo("Max Tokens must be a positive integer", maxTokensField)
            }
        }

        if (!claudeEnabledCheckbox.isSelected && !codexEnabledCheckbox.isSelected &&
            !geminiEnabledCheckbox.isSelected && !openCodeEnabledCheckbox.isSelected &&
            !cursorEnabledCheckbox.isSelected
        ) {
            return ValidationInfo("At least one platform must be enabled", claudeEnabledCheckbox)
        }

        return null
    }

    override fun doOKAction() {
        val provider = if ((providerCombo.selectedItem as String) == "Anthropic") "anthropic" else "jolli"
        // Always preserve the Anthropic key even when Jolli is selected,
        // so switching back to Anthropic doesn't lose the saved key.
        val resolvedApiKey = getEffectiveAnthropicKey()

        val maxTokensText = maxTokensField.text.trim()
        val maxTokens = if (maxTokensText.isNotBlank()) maxTokensText.toIntOrNull() else null

        val excludePatterns = excludePatternsField.text
            .split(",")
            .map { it.trim() }
            .filter { it.isNotEmpty() }

        // Save the default path explicitly if user hasn't set a custom one
        val kbPath = kbPathField.text.trim().ifBlank { KBPathResolver.KB_PARENT.toString() }
        val kbSort = kbSortCombo.selectedItem as String

        val configDir = SessionTracker.getGlobalConfigDir()
        // Only read Jolli API key from fields whose Advanced panel is visible (user interacted).
        // If Advanced is hidden, the field still has the value from populateFields — ignore it.
        val aiSummaryKeyVisible = advancedPanelRef?.isVisible == true
        val syncKeyVisible = syncAdvancedPanelRef?.isVisible == true
        val aiSummaryKey = if (aiSummaryKeyVisible) jolliApiKeyFieldRef?.text?.trim() ?: "" else ""
        val syncKey = if (syncKeyVisible) syncApiKeyFieldRef?.text?.trim() ?: "" else ""

        val preExisting = SessionTracker.loadConfigFromDir(configDir)
        val jolliApiKeyText: String
        val jolliKeyCleared: Boolean
        if (aiSummaryKeyVisible || syncKeyVisible) {
            // User opened Advanced — use the visible field's value
            jolliApiKeyText = syncKey.ifBlank { aiSummaryKey }
            jolliKeyCleared = jolliApiKeyText.isBlank() && !preExisting.jolliApiKey.isNullOrBlank()
        } else {
            // Advanced never opened — keep existing config value
            jolliApiKeyText = preExisting.jolliApiKey ?: ""
            jolliKeyCleared = false
        }
        if (jolliKeyCleared) {
            JolliAuthService.signOut()
        }

        // Re-load after potential sign-out so authToken change is reflected
        val existing = SessionTracker.loadConfigFromDir(configDir)
        val config = existing.copy(
            apiKey = resolvedApiKey.ifBlank { null },
            jolliApiKey = if (jolliKeyCleared) null else jolliApiKeyText.ifBlank { null },
            model = (modelCombo.selectedItem as String).substringBefore(" ").let { if (it == "sonnet") null else it },
            maxTokens = maxTokens,
            claudeEnabled = claudeEnabledCheckbox.isSelected,
            codexEnabled = codexEnabledCheckbox.isSelected,
            geminiEnabled = geminiEnabledCheckbox.isSelected,
            openCodeEnabled = openCodeEnabledCheckbox.isSelected,
            cursorEnabled = cursorEnabledCheckbox.isSelected,
            excludePatterns = if (excludePatterns.isNotEmpty()) excludePatterns else null,
            aiProvider = provider,
            knowledgeBasePath = kbPath,
            knowledgeBaseSort = kbSort,
            paused = if (pauseCheckbox.isSelected) true else null,
        )
        SessionTracker.saveConfigToDir(config, configDir)

        // Check if any LLM credential is available (matches LlmClient fallback chain)
        val hasCredentials = !config.apiKey.isNullOrBlank() ||
            !System.getenv("ANTHROPIC_API_KEY").isNullOrBlank() ||
            !config.jolliApiKey.isNullOrBlank()

        // Handle pause toggle or credential removal, then always refresh status
        val wasPaused = existing.paused == true
        val nowPaused = pauseCheckbox.isSelected
        ApplicationManager.getApplication().executeOnPooledThread {
            if (!hasCredentials || (nowPaused && !wasPaused)) {
                service.uninstall()
            } else if (!nowPaused && wasPaused) {
                if (!service.isInitialized) service.initialize()
                service.install()
            }
            service.refreshStatus()
        }

        // Initialize Memory Bank folder + auto-migrate data from orphan branch
        val projectPath = service.mainRepoRoot ?: project.basePath
        if (projectPath != null) {
            val repoName = KBPathResolver.extractRepoName(projectPath)
            val remoteUrl = KBPathResolver.getRemoteUrl(projectPath)
            val kbRoot = KBPathResolver.resolve(repoName, remoteUrl, config.knowledgeBasePath)
            KBPathResolver.initializeKBFolder(kbRoot, repoName, remoteUrl)

            val gitOps = GitOps(projectPath)
            val orphan = OrphanBranchStorage(gitOps)
            if (orphan.exists()) {
                val mm = MetadataManager(kbRoot.resolve(".jolli"))
                val folder = FolderStorage(kbRoot, mm)
                folder.ensure()
                val engine = MigrationEngine(orphan, folder, mm)
                engine.runMigration()
            }
        }

        super.doOKAction()
    }

    private fun getEffectiveAnthropicKey(): String {
        val typed = String(anthropicKeyField.password)
        return if (typed == maskedAnthropicKey) savedAnthropicKey else typed
    }

    private fun loadSettings() {
        val configDir = SessionTracker.getGlobalConfigDir()
        val config = SessionTracker.loadConfigFromDir(configDir)
        populateFields(config)
    }

    private fun populateFields(config: JolliMemoryConfig) {
        // AI Summary
        savedAnthropicKey = config.apiKey ?: ""
        maskedAnthropicKey = AiProviderSelector.maskApiKey(savedAnthropicKey)
        anthropicKeyField.text = maskedAnthropicKey

        val provider = when (config.aiProvider?.lowercase()) {
            "jolli" -> "Jolli"
            "anthropic" -> "Anthropic"
            else -> if (JolliAuthService.isSignedIn()) "Jolli" else "Anthropic"
        }
        providerCombo.selectedItem = provider

        val modelAlias = config.model ?: "sonnet"
        for (i in 0 until modelCombo.itemCount) {
            if ((modelCombo.getItemAt(i) as String).startsWith(modelAlias)) {
                modelCombo.selectedIndex = i
                break
            }
        }
        maxTokensField.text = if (config.maxTokens != null) config.maxTokens.toString() else ""

        // Jolli API Key + site label (both AI Summary and Sync tabs share the same config value)
        val jolliKey = config.jolliApiKey ?: ""
        jolliApiKeyFieldRef?.text = jolliKey
        syncApiKeyFieldRef?.text = jolliKey
        val meta = if (jolliKey.isNotBlank()) ai.jolli.jollimemory.services.JolliApiClient.parseJolliApiKey(jolliKey) else null
        val siteDisplay = meta?.u?.removePrefix("https://")?.removePrefix("http://") ?: ""
        jolliSiteLabelRef?.text = if (siteDisplay.isNotBlank()) {
            "<html><span style='color:#3FB950'>\u2713</span> Signed in to <b>$siteDisplay</b> — using Jolli to generate summaries</html>"
        } else {
            "<html><span style='color:#3FB950'>\u2713</span> Using Jolli to generate summaries</html>"
        }

        // General
        excludePatternsField.text = config.excludePatterns?.joinToString(", ") ?: ""
        claudeEnabledCheckbox.isSelected = config.claudeEnabled != false
        codexEnabledCheckbox.isSelected = config.codexEnabled != false
        geminiEnabledCheckbox.isSelected = config.geminiEnabled != false
        openCodeEnabledCheckbox.isSelected = config.openCodeEnabled != false
        cursorEnabledCheckbox.isSelected = config.cursorEnabled != false
        pauseCheckbox.isSelected = config.paused == true

        // Memory Bank
        val projectPath = service.mainRepoRoot ?: project.basePath ?: ""
        if (projectPath.isNotBlank()) {
            val repoName = KBPathResolver.extractRepoName(projectPath)
            val remoteUrl = KBPathResolver.getRemoteUrl(projectPath)
            defaultKBPath = KBPathResolver.resolve(repoName, remoteUrl).toString()
        }
        kbPathField.text = config.knowledgeBasePath ?: KBPathResolver.KB_PARENT.toString()
        kbSortCombo.selectedItem = config.knowledgeBaseSort ?: "date"

        // Sync card states after all fields are populated
        syncProviderCard()
        syncSyncCard()
    }

    private fun createStretchedFormPanel(formPanel: JPanel): JComponent {
        return JPanel(BorderLayout()).apply {
            add(formPanel, BorderLayout.CENTER)
            alignmentX = JComponent.LEFT_ALIGNMENT
            maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
        }
    }

    private fun createMigrateButton(): JComponent {
        return JButton("Migrate to Memory Bank").apply {
            toolTipText = "Migrate existing memories from git storage to the Memory Bank folder"
            addActionListener {
                isEnabled = false
                text = "Migrating..."
                try {
                    val projectPath = service.mainRepoRoot ?: project.basePath ?: ""
                    if (projectPath.isBlank()) {
                        Messages.showWarningDialog(project, "No project path available.", "Migration")
                        return@addActionListener
                    }

                    val gitOps = GitOps(projectPath)
                    val orphan = OrphanBranchStorage(gitOps)
                    if (!orphan.exists()) {
                        Messages.showInfoMessage(project, "No git storage found — nothing to migrate.", "Migration")
                        return@addActionListener
                    }

                    val config = SessionTracker.loadConfig()
                    val repoName = KBPathResolver.extractRepoName(projectPath)
                    val remoteUrl = KBPathResolver.getRemoteUrl(projectPath)
                    val kbRoot = KBPathResolver.resolve(repoName, remoteUrl, config.knowledgeBasePath)
                    val mm = MetadataManager(kbRoot.resolve(".jolli"))
                    val folder = FolderStorage(kbRoot, mm)
                    folder.ensure()

                    val engine = MigrationEngine(orphan, folder, mm)
                    val result = engine.runMigration()

                    if (result.status == "completed") {
                        Messages.showInfoMessage(project,
                            "Migration completed: ${result.migratedEntries} memories migrated to\n$kbRoot",
                            "Migration")
                    } else {
                        Messages.showErrorDialog(project,
                            "Migration finished with status: ${result.status}\n" +
                                "${result.migratedEntries}/${result.totalEntries} entries processed.",
                            "Migration")
                    }
                } catch (e: Exception) {
                    Messages.showErrorDialog(project,
                        "Migration failed: ${e.message}",
                        "Migration")
                } finally {
                    isEnabled = true
                    text = "Migrate to Memory Bank"
                }
            }
        }
    }

    companion object {
        /** Remembers last selected tab across dialog open/close within the same IDE session. */
        private var lastSelectedTab = 0

        private const val CARD_ANTHROPIC = "card.anthropic"
        private const val CARD_JOLLI_OK = "card.jolli.ok"
        private const val CARD_JOLLI_NOKEY = "card.jolli.nokey"
        private const val CARD_JOLLI_SIGNIN = "card.jolli.signin"
        private const val CARD_SYNC_SIGNEDOUT = "card.sync.out"
        private const val CARD_SYNC_NOKEY = "card.sync.nokey"
        private const val CARD_SYNC_SIGNEDIN = "card.sync.in"
    }
}
