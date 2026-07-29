package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.JolliMemoryConfig
import ai.jolli.jollimemory.core.KBPathResolver
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.StorageFactory
import ai.jolli.jollimemory.bridge.CliIntegrations
import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.services.JolliAuthService
import ai.jolli.jollimemory.services.JolliMemoryService
import com.google.gson.JsonObject
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
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
import com.intellij.ui.HyperlinkLabel
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
 *   1. AI Summary — provider selection (Anthropic direct, Jolli proxy, or Local Agent),
 *      with contextual Anthropic settings, Jolli sign-in prompt, or agent-tool picker
 *   2. Sync to Jolli — cloud push settings, login-dependent
 *   3. Memory Bank — local storage folder, sort order, migration
 *   4. General — enabled platforms, exclude patterns, pause toggle
 */
class SettingsDialog(
    private val project: Project,
    private val service: JolliMemoryService,
) : DialogWrapper(project) {

    // ── Tab 1: AI Summary ──────────────────────────────────────────────────
    private val providerCombo = ComboBox(DefaultComboBoxModel(arrayOf("Anthropic", "Jolli", PROVIDER_LOCAL_AGENT))).apply {
        maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
    }
    private val anthropicKeyField = JBPasswordField()
    /** Agent tool picker for the Local Agent provider — v1 supports only Claude Code (parity with VS Code). */
    private val localAgentToolCombo = ComboBox(DefaultComboBoxModel(arrayOf("Claude Code"))).apply {
        maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
    }
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
    private val syncTranscriptsCheckbox = JBCheckBox("Sync transcripts", false)
    // Personal Space AUTO-sync (`autoSyncEnabled`) and its paired poll interval are
    // deliberately NOT surfaced yet (not actionable). They are held as plain VALUES
    // rather than as unparented JBCheckBox/JBTextField instances: a widget that is
    // never added to a container still looks live to every reader of this class, so
    // it silently rots (a re-label, a listener, a validation rule — all no-ops that
    // nobody notices). These two fields make the "round-trip only, no UI" contract
    // explicit; populateFields loads them and doOKAction writes them back unchanged.
    private var savedAutoSyncEnabled: Boolean? = null
    private var savedSyncPollIntervalSec: Int? = null
    // Per-repo outbound-push control (spec 306): checked = push this repo to its
    // Jolli Space; unchecked = keep memory local only. Read/written via the CLI
    // bridge (the single source of truth), disabled until the async read lands.
    private val pushEnabledCheckbox = JBCheckBox("Push this repository's memories to Jolli").apply { isEnabled = false }

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
    private val codexEnabledCheckbox = JBCheckBox("Codex — Session discovery via filesystem scan", true)
    private val geminiEnabledCheckbox = JBCheckBox("Gemini — Session tracking via AfterAgent hook", true)
    private val openCodeEnabledCheckbox = JBCheckBox("OpenCode — Session discovery via SQLite database scan", true)
    private val cursorEnabledCheckbox = JBCheckBox("Cursor IDE — Composer session discovery via SQLite database scan", true)
    private val copilotEnabledCheckbox = JBCheckBox("GitHub Copilot — CLI session-store scan + VS Code Chat workspace storage", true)
    private val globalInstructionsCheckbox = JBCheckBox(
        "Let AI assistants use Jolli's skills automatically " +
            "(adds a preference block to ~/.claude/CLAUDE.md, ~/.gemini/GEMINI.md, ~/.codex/AGENTS.md)",
        false,
    )
    private val excludePatternsField = JBTextField()
    private val pauseCheckbox = JBCheckBox("Pause Jolli Memory (temporarily disable hooks without losing configuration)")
    private val telemetryCheckbox =
        JBCheckBox("Send anonymous usage telemetry (content-free — never code, paths, or memory content)", true)
    private val dcoSignoffCheckbox =
        JBCheckBox("Add Signed-off-by (DCO) trailer to commits made by Jolli Memory (commit / amend / squash)", false)

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
    // Per-repo push-control state (spec 306). `pushControlLoaded` gates the
    // doOKAction write until the async bridge read has landed, so merely opening
    // Settings never flips the flag (and never re-triggers the toggle-on drain).
    private var savedPushDisabled: Boolean = false
    private var pushControlLoaded: Boolean = false
    private val authListenerDisposable: Disposable

    init {
        title = "Jolli Memory Settings"
        setOKButtonText("Apply Changes")
        ai.jolli.jollimemory.core.telemetry.Telemetry.track("settings_opened", mapOf("tab" to "general"))
        init()
        loadSettings()
        loadPushControlAsync()

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
            .addComponent(copilotEnabledCheckbox, 4)
            .panel))

        panel.add(JBLabel(
            "<html><span style='color:gray'>Skill preference — steer your AI assistants toward Jolli.</span></html>",
        ).apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            border = JBUI.Borders.empty(12, 0, 4, 0)
        })
        panel.add(createStretchedFormPanel(FormBuilder.createFormBuilder()
            .addComponent(globalInstructionsCheckbox, 4)
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
            .addTooltip("Choose how AI summaries are generated for each commit.")
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
            addActionListener { handleSignIn() }
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

        // Local Agent card: agent-tool picker (v1: Claude Code only). Uses the tool's own
        // subscription sign-in, so no API key is collected here — mirrors the VS Code card.
        val localAgentContent = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            alignmentX = JComponent.LEFT_ALIGNMENT
            add(Box.createVerticalStrut(8))
            add(createStretchedFormPanel(FormBuilder.createFormBuilder()
                .addLabeledComponent(JBLabel("Agent tool:"), localAgentToolCombo, 1, false)
                .addTooltip("Uses your local Claude Code login (subscription). Sign in with the claude CLI if prompted.")
                .panel))
        }

        anthropicCardPanel.add(anthropicContent, CARD_ANTHROPIC)
        anthropicCardPanel.add(jolliSignedInContent, CARD_JOLLI_OK)
        anthropicCardPanel.add(jolliNoKeyContent, CARD_JOLLI_NOKEY)
        anthropicCardPanel.add(jolliSignedOutContent, CARD_JOLLI_SIGNIN)
        anthropicCardPanel.add(localAgentContent, CARD_LOCAL_AGENT)
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
            addActionListener { handleSignIn() }
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

        // Per-repo outbound-push control (spec 306): whether THIS repository's
        // memories are pushed to its bound Jolli Space (auto AND manual). The
        // Personal Space cloud-sync lives on the Memory Bank tab — keeping the two
        // different channels apart avoids the confusion of mixing them here.
        panel.add(Box.createVerticalStrut(12))
        panel.add(javax.swing.JSeparator().apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            maximumSize = Dimension(Int.MAX_VALUE, 1)
        })
        panel.add(Box.createVerticalStrut(8))
        panel.add(JBLabel("<html><b>Push to Jolli Space (this repository)</b></html>").apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            border = JBUI.Borders.emptyBottom(4)
        })
        pushEnabledCheckbox.alignmentX = JComponent.LEFT_ALIGNMENT
        panel.add(pushEnabledCheckbox)
        panel.add(JBLabel(
            "<html><span style='color:gray'>Off = keep recording this repository's memory locally but never push it to its " +
                "Jolli Space (auto or manual). Re-enabling syncs the backlog.</span></html>",
        ).apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            border = JBUI.Borders.emptyTop(2)
        })

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

        // Personal Space AUTO-sync — the "Auto-sync to Personal Space" toggle and its
        // paired "Poll interval" — is intentionally NOT surfaced for now (not yet
        // actionable). Both fields + the startSync wiring remain, so populateFields/
        // doOKAction still round-trip the saved values (an invisible control never
        // changes them) and behavior is unchanged. Only "Sync transcripts" — the
        // content preference, independent of the auto-poll — is shown.
        panel.add(Box.createVerticalStrut(16))
        syncTranscriptsCheckbox.alignmentX = JComponent.LEFT_ALIGNMENT
        panel.add(syncTranscriptsCheckbox)
        panel.add(JBLabel(
            "<html><span style='color:gray'>Include AI session transcripts (not just summaries) when memory syncs to Jolli.</span></html>",
        ).apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            border = JBUI.Borders.emptyTop(2)
        })

        // Historical memory — the re-entry point for the cold-start "build memory" flow.
        // Runs a full-scope back-fill regardless of whether the tool-window card was
        // dismissed; on success BackfillRunner clears the repo-wide dismiss marker, so a
        // dismissed card can resurface. Mirrors the VS Code Memory Bank settings button.
        panel.add(Box.createVerticalStrut(16))
        panel.add(JBLabel("<html><b>Historical memory</b></html>").apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            border = JBUI.Borders.emptyBottom(2)
        })
        panel.add(JBLabel("<html><span style='color:gray'>Build memory for past commits that don't have one yet.</span></html>").apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            border = JBUI.Borders.emptyBottom(4)
        })
        panel.add(JPanel(java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 0, 0)).apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            isOpaque = false
            add(createGenerateMissingButton())
        })

        return wrapTabContent(panel)
    }

    /**
     * "Generate Missing Summaries" — full-scope back-fill (every own commit lacking a
     * summary). Analog of the VS Code Memory Bank settings button. Shares [BackfillRunner]
     * with the tool-window cold-start card, so progress + completion behave identically;
     * an empty hash list maps to the CLI's `--all`. On success the runner clears the card's
     * dismiss marker, which is how a dismissed repo gets the card back.
     */
    private fun createGenerateMissingButton(): JComponent {
        return JButton("Generate Missing Summaries").apply {
            toolTipText = "Generate memory for past commits that don't have one yet (uses on-disk Claude transcripts)"
            addActionListener {
                isEnabled = false
                ai.jolli.jollimemory.backfill.BackfillRunner.run(
                    project = project,
                    service = service,
                    hashes = emptyList(),
                    onComplete = { javax.swing.SwingUtilities.invokeLater { isEnabled = true } },
                )
            }
        }
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
        panel.add(JBLabel("<html><b>Commits</b></html>").apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            border = JBUI.Borders.emptyBottom(2)
        })
        panel.add(createStretchedFormPanel(FormBuilder.createFormBuilder()
            .addComponent(dcoSignoffCheckbox, 4)
            .addTooltip("Adds a Signed-off-by trailer (git commit -s) to commits Jolli makes. Required by many open-source projects' CI. Shared with the VS Code extension via config.json.")
            .panel))

        panel.add(Box.createVerticalStrut(12))
        panel.add(createStretchedFormPanel(FormBuilder.createFormBuilder()
            .addComponent(pauseCheckbox, 4)
            .addTooltip("Uninstalls hooks while preserving all settings. Unpause to re-enable.")
            .panel))

        // Privacy / telemetry consent (JetBrains Marketplace guideline 2.2).
        panel.add(Box.createVerticalStrut(12))
        panel.add(JBLabel("<html><b>Privacy</b></html>").apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            border = JBUI.Borders.emptyBottom(2)
        })
        panel.add(createStretchedFormPanel(FormBuilder.createFormBuilder()
            .addComponent(telemetryCheckbox, 4)
            .addTooltip("Anonymous, opt-out usage data to improve Jolli Memory. Also honors the IDE's data-sharing setting.")
            .panel))
        panel.add(HyperlinkLabel("Privacy & telemetry details").apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            setHyperlinkTarget("https://www.jolli.ai/telemetry")
        })

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
        } else if (provider == PROVIDER_LOCAL_AGENT) {
            anthropicCardLayout.show(anthropicCardPanel, CARD_LOCAL_AGENT)
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

    private fun handleSignIn() {
        // Fire-and-forget: `login()` opens the browser and returns. Success
        // flips the panel via the auth listener; the button stays "Sign In to
        // Jolli" until then. Matches VS Code's `jollimemory.signIn` command.
        JolliAuthService.login(
            // User-initiated sign-in: mint a fresh key so a revoked same-tenant key recovers.
            forceFreshApiKey = true,
            onSuccess = { _ ->
                SwingUtilities.invokeLater {
                    syncProviderCard()
                    syncSyncCard()
                }
            },
            onError = { msg ->
                SwingUtilities.invokeLater {
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
            !cursorEnabledCheckbox.isSelected && !copilotEnabledCheckbox.isSelected
        ) {
            return ValidationInfo("At least one platform must be enabled", claudeEnabledCheckbox)
        }

        return null
    }

    override fun doOKAction() {
        val provider = when (providerCombo.selectedItem as String) {
            "Anthropic" -> "anthropic"
            PROVIDER_LOCAL_AGENT -> "local-agent"
            else -> "jolli"
        }
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
        // Clearing the Jolli API key logically signs the user out. We write the
        // sign-out (authToken = null) into the same EDT save below so it can't
        // race the async `signOut()` call — both `signOut()` and this save do
        // load-modify-write against the same config.json; running them
        // concurrently produced two nondeterministic bugs (users staying signed
        // in when clearing the key; the CLI's stale snapshot clobbering just-
        // saved kbPath/model/sync settings). `signOut()` still fires below, but
        // only AFTER every EDT write lands — its remaining job is telemetry,
        // notifying auth listeners, and rolling back `aiProvider` from "jolli"
        // when appropriate. Those are safe to run last.
        val existing = SessionTracker.loadConfigFromDir(configDir)
        val config = existing.copy(
            // apiKey / aiProvider / localAgentTool / localAgentPath are written separately via
            // saveSharedProviderConfig below. Force-null here so this data-class overwrite
            // doesn't clobber the value that call will restore.
            apiKey = null,
            authToken = if (jolliKeyCleared) null else existing.authToken,
            jolliApiKey = if (jolliKeyCleared) null else jolliApiKeyText.ifBlank { null },
            model = (modelCombo.selectedItem as String).substringBefore(" ").let { if (it == "sonnet") null else it },
            maxTokens = maxTokens,
            claudeEnabled = claudeEnabledCheckbox.isSelected,
            codexEnabled = codexEnabledCheckbox.isSelected,
            geminiEnabled = geminiEnabledCheckbox.isSelected,
            openCodeEnabled = openCodeEnabledCheckbox.isSelected,
            cursorEnabled = cursorEnabledCheckbox.isSelected,
            copilotEnabled = copilotEnabledCheckbox.isSelected,
            excludePatterns = if (excludePatterns.isNotEmpty()) excludePatterns else null,
            aiProvider = null,
            localAgentTool = null,
            localAgentPath = null,
            // dcoSignoff is written separately via saveDcoSignoff below. Force-null here
            // so this data-class overwrite doesn't clobber the value that call will restore.
            dcoSignoff = null,
            knowledgeBasePath = kbPath,
            knowledgeBaseSort = kbSort,
            paused = if (pauseCheckbox.isSelected) true else null,
            // Round-tripped, not edited — see savedAutoSyncEnabled's declaration.
            autoSyncEnabled = savedAutoSyncEnabled,
            syncTranscripts = if (syncTranscriptsCheckbox.isSelected) true else null,
            syncPollIntervalSec = savedSyncPollIntervalSec,
        )
        SessionTracker.saveConfigToDir(config, configDir)
        // Provider routing lives ONLY in the shared config.json (cross-surface, one copy) so the
        // CLI's summary QueueWorker honors the choice made here. The Anthropic key is still
        // preserved across provider switches, but now stored shared so the CLI can read it too.
        // localAgentTool is always "claude-code" (the only supported tool) and localAgentPath is
        // never touched — both mirror how the VS Code settings panel persists this group.
        SessionTracker.saveSharedProviderConfig(
            aiProvider = provider,
            apiKey = resolvedApiKey.ifBlank { null },
            localAgentTool = "claude-code",
        )
        // DCO sign-off is persisted via a JSON-level partial update rather than the
        // data-class overwrite above, so a value the CLI or VS Code just wrote to the
        // same config.json isn't clobbered by our stale in-memory copy.
        SessionTracker.saveDcoSignoff(dcoSignoffCheckbox.isSelected)
        // Telemetry opt-out lives in the shared config.json (machine-global, cross-surface).
        // Apply the choice to the LIVE Telemetry context too, so it takes effect this session
        // (parity with the first-run balloon's "Turn off" and the VS Code toggle) rather than
        // only after the next IDE restart.
        SessionTracker.saveConfigToDir(
            SessionTracker.loadConfigFromDir(configDir).copy(
                telemetry = if (telemetryCheckbox.isSelected) "on" else "off",
            ),
            configDir,
        )
        if (telemetryCheckbox.isSelected) {
            project.basePath?.let { ai.jolli.jollimemory.core.telemetry.TelemetryActivation.bootstrap(it) }
        } else {
            ai.jolli.jollimemory.core.telemetry.Telemetry.shutdown()
        }
        if (provider != null) {
            ai.jolli.jollimemory.core.telemetry.Telemetry.track("ai_provider_selected", mapOf("provider" to provider))
        }

        // After every EDT write to config.json has landed, fire the async
        // sign-out. `authToken` and `jolliApiKey` are already null on disk from
        // the save above, so `clearAuthCredentials` on the pooled thread is
        // idempotent on those fields; its `aiProvider` rollback (if the value
        // was "jolli") then lands last, which is the intended ordering.
        if (jolliKeyCleared) {
            JolliAuthService.signOut()
        }

        // Mirrors cli/src/core/LlmClient.ts resolveLlmCredentialSource so this auto-disable
        // decision matches what the CLI would actually be able to route with. Two subtleties
        // the old any-key OR-check got wrong:
        //   1. Reads `resolvedApiKey` (the key just persisted to shared config.json), NOT
        //      `config.apiKey` — that field is force-nulled above (lines 777/788) because
        //      Anthropic credentials live only in the shared config now. The old check
        //      always saw null there.
        //   2. Branches on the selected `provider`: local-agent needs no key at all (OAuth
        //      through the agent tool itself), and Anthropic must not accept a lone Jolli
        //      key (the CLI would fail at generation time).
        val envAnthropicKey = System.getenv("ANTHROPIC_API_KEY")
        val savedJolliKey = if (jolliKeyCleared) null else jolliApiKeyText.ifBlank { null }
        val savedAnthropicKey = resolvedApiKey.ifBlank { null }
        val hasCredentials = when (provider) {
            "local-agent" -> true
            "jolli" -> !savedJolliKey.isNullOrBlank()
            "anthropic" -> !savedAnthropicKey.isNullOrBlank() || !envAnthropicKey.isNullOrBlank()
            else -> !savedAnthropicKey.isNullOrBlank() ||
                !envAnthropicKey.isNullOrBlank() ||
                !savedJolliKey.isNullOrBlank()
        }

        // Snapshot the inputs needed off the EDT, then close the dialog immediately. All
        // the heavy work (git subprocesses, hook install/uninstall, Memory Bank init +
        // migration) runs in ONE ordered background task so the IDE never freezes and the
        // enable/disable and migration steps can't race each other.
        val wasPaused = existing.paused == true
        val nowPaused = pauseCheckbox.isSelected
        val projectPath = service.mainRepoRoot ?: project.basePath
        val kbCustomPath = config.knowledgeBasePath
        // Per-repo outbound-push toggle (spec 306) — snapshot for the off-EDT write below.
        val pushControlWasLoaded = pushControlLoaded
        val pushDisabledNow = !pushEnabledCheckbox.isSelected
        val pushDisabledWas = savedPushDisabled

        // Resolve the tri-state global-instructions consent. Checked → "enabled". Unchecked
        // is an explicit opt-out ("disabled") ONLY when it was previously enabled; otherwise
        // (undecided, or already disabled) leave it unchanged so merely opening Settings never
        // silently opts a fresh user out. null means "no change to persist".
        val prevGlobalInstructions = existing.globalInstructions
        val newGlobalInstructions: String? = when {
            globalInstructionsCheckbox.isSelected -> "enabled"
            prevGlobalInstructions == "enabled" -> "disabled"
            else -> null
        }

        super.doOKAction()

        ProgressManager.getInstance().run(
            object : Task.Backgroundable(project, "Applying Jolli Memory settings…", false) {
                override fun run(indicator: ProgressIndicator) {
                    indicator.isIndeterminate = true

                    // 1. Enable / disable hooks (was already off-EDT; now ordered before migration).
                    if (!hasCredentials || (nowPaused && !wasPaused)) {
                        indicator.text = "Disabling Jolli Memory…"
                        service.uninstall()
                        ai.jolli.jollimemory.core.telemetry.Telemetry.track("surface_disabled", mapOf("trigger" to "settings"))
                    } else if (!nowPaused && wasPaused) {
                        indicator.text = "Enabling Jolli Memory…"
                        if (!service.isInitialized) service.initialize()
                        service.install()
                        ai.jolli.jollimemory.core.telemetry.Telemetry.track("surface_enabled", mapOf("trigger" to "settings"))
                    }

                    // 2. Initialize Memory Bank folder + auto-migrate data from the orphan branch.
                    if (projectPath != null) {
                        indicator.text = "Initializing Memory Bank…"
                        val repoName = KBPathResolver.extractRepoName(projectPath)
                        val remoteUrl = KBPathResolver.getRemoteUrl(projectPath)
                        val kbRoot = KBPathResolver.resolve(repoName, remoteUrl, kbCustomPath)
                        KBPathResolver.initializeKBFolder(kbRoot, repoName, remoteUrl)

                        // Migrate orphan-branch data into the Memory Bank folder via the
                        // bundled CLI; it no-ops when there is no orphan branch and runs
                        // the idempotent reconcile once migration has completed.
                        indicator.text = "Migrating memories to Memory Bank…"
                        CliIntegrations.migrateMemoryBank(projectPath)

                        // Re-point the SummaryReader's folder attachment at the new
                        // kbRoot / storageMode. Without this, changing the Memory Bank
                        // path (or toggling storageMode to "orphan") in Settings keeps
                        // reads served from the previous folder for the rest of the
                        // session — [JolliMemoryService.initialize] is gated by
                        // `isInitialized`, so it will not re-run.
                        service.refreshFolderReader()
                    }

                    // 2b. Apply the global-instructions consent: persist a fresh decision to
                    // the shared config, then let the bundled CLI write or remove the
                    // skill-preference block. `enable --integrations-only` runs the same
                    // syncGlobalInstructions as VS Code — it reads the just-persisted value
                    // and never prompts (undecided is a no-op, "disabled" heals stale blocks).
                    // Unconditional so unrelated saves (e.g. a claudeEnabled flip) also heal.
                    if (newGlobalInstructions != null && newGlobalInstructions != prevGlobalInstructions) {
                        indicator.text = "Updating AI assistant instructions…"
                        SessionTracker.saveGlobalInstructions(newGlobalInstructions)
                    }
                    if (projectPath != null) {
                        try {
                            ai.jolli.jollimemory.bridge.CliIntegrations.enableIntegrations(projectPath)
                        } catch (e: Exception) {
                            // Fail-soft — instruction sync must never break settings save.
                        }
                    }

                    // 2c. Persist the per-repo outbound-push toggle (spec 306) via the CLI
                    // bridge — the single source of truth. Only when it actually changed, so
                    // merely re-saving Settings never re-triggers the toggle-on drain.
                    if (pushControlWasLoaded && pushDisabledNow != pushDisabledWas && projectPath != null) {
                        indicator.text = "Updating outbound push setting…"
                        try {
                            val body = JsonObject()
                                .apply { addProperty("disabled", pushDisabledNow) }
                                .toString()
                            val res = CliIntegrations.runIdeBridge(projectPath, "push-control-set", body)
                            // The ENABLE path may have rebuilt an unreadable push-control
                            // store from empty, which drops EVERY other repo's opt-out. The
                            // store contract requires callers to surface that — reporting a
                            // bare success would hide a machine-wide settings reset behind
                            // one checkbox. Parity with the CLI's note and VS Code's status.
                            val obj = res.takeIf { it.isJsonObject }?.asJsonObject
                            val recovered = obj?.get("recoveredFromCorrupt")
                                ?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean }
                                ?.asBoolean == true
                            if (recovered) {
                                val preservedAt = obj?.get("preservedAt")
                                    ?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }
                                    ?.asString
                                LOG.warn(
                                    "push-control-set rebuilt an unreadable store from empty; " +
                                        "other repos' opt-outs were reset" +
                                        (preservedAt?.let { " (previous file kept at $it)" } ?: ""),
                                )
                                SwingUtilities.invokeLater {
                                    com.intellij.notification.Notifications.Bus.notify(
                                        com.intellij.notification.Notification(
                                            "JolliMemory",
                                            "Outbound push setting file was rebuilt",
                                            "The setting file was unreadable and has been rebuilt from scratch, so every " +
                                                "other repository's outbound-push opt-out was reset to ON. Re-apply the " +
                                                "ones you want off." +
                                                (preservedAt?.let { " The unreadable file was kept at $it." } ?: ""),
                                            com.intellij.notification.NotificationType.WARNING,
                                        )
                                    )
                                }
                            }
                        } catch (e: Exception) {
                            // Unlike the old silent swallow, surface the failure: the
                            // dialog has already closed, so the user would otherwise
                            // believe the toggle saved. Log it and warn (parity with VS
                            // Code's "Couldn't update…"); the real state is re-read on the
                            // next Settings open.
                            LOG.warn("push-control-set failed; outbound-push setting was NOT saved", e)
                            SwingUtilities.invokeLater {
                                com.intellij.notification.Notifications.Bus.notify(
                                    com.intellij.notification.Notification(
                                        "JolliMemory",
                                        "Couldn't update outbound push",
                                        "The setting wasn't saved (${e.message}). It will be re-read next time you open Settings.",
                                        com.intellij.notification.NotificationType.WARNING,
                                    )
                                )
                            }
                        }
                    }

                    // 3. Refresh status once, after everything settled.
                    service.refreshStatus()
                }
            },
        )
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

    /**
     * Reads THIS repo's push-disabled flag via the `push-control-get` bridge OFF
     * the EDT (spec 306), then sets the checkbox on the EDT.
     *
     * On a bridge error we must NOT assert a state: the previous code defaulted to
     * "push enabled" (checked) AND marked the row loaded, which (a) mis-reported an
     * actually push-disabled repo as syncing, and (b) made the toggle un-writable —
     * doOKAction only writes when `pushDisabledNow != savedPushDisabled`, and a
     * checked box against `savedPushDisabled=false` never differs. Instead leave the
     * checkbox DISABLED and `pushControlLoaded=false` (so doOKAction skips the write)
     * and explain via a tooltip; the state is re-read next time Settings opens.
     *
     * A MALFORMED reply (non-object body, or `pushDisabled` missing / not a boolean)
     * is treated as the same "unknown" as an exception — same orientation as
     * [JolliShareService.defaultOutboundPushAllowed]'s fail-closed. Defaulting it to
     * `false` would assert "push is on" for a repo that may be opted out.
     *
     * A reply carrying `pushDisabledError` is the THIRD state and also lands in
     * "unknown", even though `pushDisabled` parses fine (it is `true`): the bridge
     * could not read the machine-global push-control store and failed closed, so that
     * `true` is not this repo's recorded choice. Rendering it as an unchecked box would
     * claim the user turned THIS repo off when the condition is machine-wide and the
     * user chose nothing. Leaving the toggle unwritable matters twice over here —
     * enabling is the one direction that rebuilds an unreadable store from empty and
     * drops every other repo's opt-out, so that recovery must stay behind
     * `jolli push-control`, which explains what it destroys. The tooltip therefore
     * names the store's path and points at that command, never at `--enable`.
     */
    private fun loadPushControlAsync() {
        val cwd = service.mainRepoRoot ?: project.basePath
        if (cwd == null) {
            // No repo root at all (a project with no content root). Explain the
            // permanently-disabled checkbox rather than leaving it inert and unlabelled —
            // the two failure branches below both set a tooltip, so this one must too.
            pushEnabledCheckbox.toolTipText = "This project has no repository, so there is nothing to push."
            return
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            // Set when the reply says the store itself is unreadable — checked BEFORE
            // the flag, because the flag it accompanies is a fail-closed `true` rather
            // than this repo's recorded choice.
            var storeError: String? = null
            val disabled: Boolean? = try {
                val res = CliIntegrations.runIdeBridge(cwd, "push-control-get")
                val body = res.takeIf { it.isJsonObject }?.asJsonObject
                storeError = body?.get("pushDisabledError")
                    ?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }
                    ?.asString
                val flag = body?.get("pushDisabled")
                if (flag != null && flag.isJsonPrimitive && flag.asJsonPrimitive.isBoolean) {
                    flag.asBoolean
                } else {
                    LOG.warn("push-control-get returned a malformed reply ($res); leaving the toggle disabled")
                    null
                }
            } catch (e: Exception) {
                LOG.warn("push-control-get failed; leaving the toggle disabled (state unknown)", e)
                null
            }
            SwingUtilities.invokeLater {
                if (storeError != null) {
                    // Store unreadable: fail-closed for every repo on this machine, so
                    // this repo's own state is UNKNOWN. Same unwritable treatment as a
                    // failed read, plus the store's path and the non-destructive repair
                    // route (deliberately not `--enable`, which rebuilds the store from
                    // empty and drops every repo's opt-out).
                    pushControlLoaded = false
                    pushEnabledCheckbox.isEnabled = false
                    pushEnabledCheckbox.toolTipText =
                        "Couldn't read this machine's outbound-push setting ($storeError), " +
                        "so this repository's state is unknown. Run `jolli push-control` to repair it."
                } else if (disabled == null) {
                    // Read failed — keep the checkbox unloaded + disabled so we never
                    // claim a state we don't have, and so doOKAction won't write.
                    pushControlLoaded = false
                    pushEnabledCheckbox.isEnabled = false
                    pushEnabledCheckbox.toolTipText =
                        "Couldn't read this repository's push setting — reopen Settings to retry."
                } else {
                    savedPushDisabled = disabled
                    pushControlLoaded = true
                    pushEnabledCheckbox.isSelected = !disabled
                    pushEnabledCheckbox.isEnabled = true
                    pushEnabledCheckbox.toolTipText = null
                }
            }
        }
    }

    private fun populateFields(config: JolliMemoryConfig) {
        // AI Summary
        savedAnthropicKey = config.apiKey ?: ""
        maskedAnthropicKey = AiProviderSelector.maskApiKey(savedAnthropicKey)
        anthropicKeyField.text = maskedAnthropicKey

        val provider = when (config.aiProvider?.lowercase()) {
            "jolli" -> "Jolli"
            "anthropic" -> "Anthropic"
            "local-agent" -> PROVIDER_LOCAL_AGENT
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
        // Tri-state consent: checked only when explicitly "enabled". "disabled" and
        // undecided (null) both render unchecked — see doOKAction for how each is persisted.
        globalInstructionsCheckbox.isSelected = config.globalInstructions == "enabled"
        openCodeEnabledCheckbox.isSelected = config.openCodeEnabled != false
        cursorEnabledCheckbox.isSelected = config.cursorEnabled != false
        copilotEnabledCheckbox.isSelected = config.copilotEnabled != false
        dcoSignoffCheckbox.isSelected = config.dcoSignoff == true
        pauseCheckbox.isSelected = config.paused == true
        // Telemetry: on unless the shared opt-out flag says "off" (default on).
        telemetryCheckbox.isSelected = config.telemetry != "off"

        // Memory Bank
        val projectPath = service.mainRepoRoot ?: project.basePath ?: ""
        if (projectPath.isNotBlank()) {
            val repoName = KBPathResolver.extractRepoName(projectPath)
            val remoteUrl = KBPathResolver.getRemoteUrl(projectPath)
            defaultKBPath = KBPathResolver.resolve(repoName, remoteUrl).toString()
        }
        kbPathField.text = config.knowledgeBasePath ?: KBPathResolver.KB_PARENT.toString()
        kbSortCombo.selectedItem = config.knowledgeBaseSort ?: "date"

        // Sync settings. autoSyncEnabled / syncPollIntervalSec have no control on any
        // tab; snapshot them verbatim so doOKAction writes back exactly what was read.
        savedAutoSyncEnabled = config.autoSyncEnabled
        savedSyncPollIntervalSec = config.syncPollIntervalSec
        syncTranscriptsCheckbox.isSelected = config.syncTranscripts == true

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
            val button = this
            addActionListener {
                val projectPath = service.mainRepoRoot ?: project.basePath ?: ""
                if (projectPath.isBlank()) {
                    Messages.showWarningDialog(project, "No project path available.", "Migration")
                    return@addActionListener
                }
                // Every step below shells out to the CLI at least once. Running them on
                // the EDT — as the previous inline `try { … }` did — can stall the IDE
                // for several seconds whenever the daemon is unavailable and each call
                // falls back to a cold-start Node spawn. Move the whole flow onto a
                // background task, mirroring [doOKAction]'s migration branch; the
                // button's enabled state and label are reset from the EDT once the task
                // finishes (or fails), so a mid-flight click can't fire another round.
                button.isEnabled = false
                button.text = "Migrating..."
                ProgressManager.getInstance().run(
                    object : Task.Backgroundable(project, "Migrating memories to Memory Bank…", false) {
                        override fun run(indicator: ProgressIndicator) {
                            indicator.isIndeterminate = true
                            try {
                                indicator.text = "Checking git storage…"
                                val gitOps = GitOps(projectPath)
                                val storage = StorageFactory.create(gitOps, projectPath)
                                if (!storage.exists()) {
                                    SwingUtilities.invokeLater {
                                        Messages.showInfoMessage(project, "No git storage found — nothing to migrate.", "Migration")
                                    }
                                    return
                                }

                                indicator.text = "Reading configuration…"
                                val config = SessionTracker.loadConfig()
                                val repoName = KBPathResolver.extractRepoName(projectPath)
                                val remoteUrl = KBPathResolver.getRemoteUrl(projectPath)

                                // Enumerate every folder that currently holds this repo, then
                                // archive the whole pile FIRST — the canonical base `<repo>` slot
                                // included — so migration lands back on the base name instead of
                                // climbing to an ever-higher `<repo>-N`. Safe to archive up front:
                                // the migration SOURCE is the orphan branch (system of record), not
                                // these folders, so a crash mid-migrate self-heals on the next
                                // activation, which re-migrates into the now-free base slot.
                                // archiveKBFolder MOVES each folder into the hidden .jolli/archive/
                                // (not an in-place identity rewrite, which left them visible and
                                // still git-tracked). Mirrors the VS Code rebuildKnowledgeBase flow.
                                val staleFolders = KBPathResolver.findRepoFolders(repoName, remoteUrl, config.knowledgeBasePath)
                                for (stale in staleFolders) {
                                    indicator.text = "Archiving $stale…"
                                    KBPathResolver.archiveKBFolder(stale, config.knowledgeBasePath)
                                }

                                // With the pile archived, the base slot is free; resolve to it
                                // (falling back to a fresh -N only if some folder survived archiving).
                                indicator.text = "Initializing Memory Bank…"
                                val kbRoot = KBPathResolver.resolve(repoName, remoteUrl, config.knowledgeBasePath)
                                KBPathResolver.initializeKBFolder(kbRoot, repoName, remoteUrl)

                                // Run the migration through the bundled CLI. The CLI resolves the
                                // same freshly-archived base folder from the shared config and
                                // copies the orphan-branch data onto disk.
                                indicator.text = "Migrating memories…"
                                val result = CliIntegrations.migrateMemoryBank(projectPath)

                                SwingUtilities.invokeLater {
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
                                }
                            } catch (e: Exception) {
                                SwingUtilities.invokeLater {
                                    Messages.showErrorDialog(project,
                                        "Migration failed: ${e.message}",
                                        "Migration")
                                }
                            } finally {
                                SwingUtilities.invokeLater {
                                    button.isEnabled = true
                                    button.text = "Migrate to Memory Bank"
                                }
                            }
                        }
                    },
                )
            }
        }
    }

    companion object {
        private val LOG = Logger.getInstance(SettingsDialog::class.java)

        /** Remembers last selected tab across dialog open/close within the same IDE session. */
        private var lastSelectedTab = 0

        private const val CARD_ANTHROPIC = "card.anthropic"
        private const val CARD_JOLLI_OK = "card.jolli.ok"
        private const val CARD_JOLLI_NOKEY = "card.jolli.nokey"
        private const val CARD_JOLLI_SIGNIN = "card.jolli.signin"
        private const val CARD_LOCAL_AGENT = "card.localagent"

        /** Display label for the local-agent provider — must match the VS Code settings dropdown text. */
        private const val PROVIDER_LOCAL_AGENT = "Local Agent (subscription)"
        private const val CARD_SYNC_SIGNEDOUT = "card.sync.out"
        private const val CARD_SYNC_NOKEY = "card.sync.nokey"
        private const val CARD_SYNC_SIGNEDIN = "card.sync.in"
    }
}
