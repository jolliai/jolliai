package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.JolliMemoryConfig
import ai.jolli.jollimemory.core.KBPathResolver
import ai.jolli.jollimemory.core.LocalAgentTools
import ai.jolli.jollimemory.core.LocalAgentToolOption
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
import com.intellij.ui.JBColor
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
 *   4. General — enabled platforms, exclude patterns
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
    /**
     * Agent tool picker for the Local Agent provider. The initial model holds the
     * FULL static baseline ([LocalAgentTools.DEFAULT_TOOLS] — claude-code / codex /
     * cursor-agent / opencode / kimi), so the picker always offers every backend
     * exactly like VS Code, even before (or without) a successful bridge fetch. The
     * async `jolli ide-bridge local-agent-tools` fetch (see [LocalAgentTools.load])
     * then overrides it on the EDT — authoritative when reachable (picks up ordering
     * and any brand-new backend), but a failure keeps the full baseline rather than
     * collapsing to Claude Code alone.
     */
    private val localAgentToolCombo = ComboBox(
        DefaultComboBoxModel(LocalAgentTools.DEFAULT_TOOLS.map { it.label }.toTypedArray()),
    ).apply {
        maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
    }

    /**
     * Current tool list backing [localAgentToolCombo]. The combo model itself
     * stores labels (for display); this array preserves the parallel `id`
     * values so save-time can persist the CLI-side identifier (e.g. `codex`),
     * not the human label (`Codex`).
     */
    private var localAgentTools: List<LocalAgentToolOption> = LocalAgentTools.DEFAULT_TOOLS

    /**
     * Status line rendered under [localAgentToolCombo]. Mirrors the same line
     * VS Code shows in its settings webview: empty while the selected tool
     * probes clean, "Checking…" while a probe is in flight, and a red
     * "<Tool> not found on this machine. Install it, or pick another tool."
     * when the CLI's `local-agent-usable` bridge action reports the pick
     * cannot run. Kept a JBLabel (not an inline error) so the layout height
     * stays stable across states — a single space keeps a line's worth of
     * vertical room reserved on first render.
     */
    private val localAgentStatusLabel = JBLabel(" ").apply {
        alignmentX = JComponent.LEFT_ALIGNMENT
    }

    /**
     * ID of the tool the most recent probe was fired for. The probe reply is
     * discarded when this no longer matches — e.g. the user switched from
     * Codex to Cursor before Codex's probe returned; without this guard the
     * stale Codex verdict would overwrite the fresh Cursor "Checking…" line.
     */
    private var localAgentProbeTool: String? = null

    /**
     * Tri-state verdict: null = no evidence either way (initial state, probe in
     * flight, OR probe landed on a permissively-unknown outcome — see the
     * unknown-action / unknown-tool branches in [probeLocalAgentUsableAsync]);
     * false = the last probe confirmed unavailable; true = confirmed usable.
     *
     * Both [doValidate] and [doOKAction] gate strictly on `== false`, so `null`
     * is deliberately permissive at both chokepoints. This is the "we couldn't
     * verify, don't block the user" contract — matches VS Code's `updateApplyBtn`
     * where `localAgentBlocks()` is false while the probe result is null.
     *
     * "In flight" vs "landed as null" is distinguished by [localAgentProbeInFlight]
     * — [awaitLocalAgentProbe] short-circuits when the latter is false so an
     * unknown verdict can't leave the user stuck in an 8 s modal.
     *
     * @Volatile because [awaitLocalAgentProbe]'s modal-progress task polls this
     * from a pooled thread while the probe's `invokeLater` writes it on the EDT.
     * Volatile gives us cross-thread visibility without wrapping in an atomic.
     */
    @Volatile
    private var localAgentAvailable: Boolean? = null

    /**
     * True from the moment [probeLocalAgentUsableAsync] hands work to the pool
     * thread until its `invokeLater` reply lands (regardless of outcome). Lets
     * [awaitLocalAgentProbe] tell "probe is genuinely running, worth waiting
     * up to 8 s" apart from "no probe fired (early return) or already resolved"
     * — both of the latter leave [localAgentAvailable] null, so waiting on
     * that alone can't distinguish them.
     *
     * @Volatile for the same reason as [localAgentAvailable].
     */
    @Volatile
    private var localAgentProbeInFlight: Boolean = false
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
    private val devinEnabledCheckbox = JBCheckBox("Devin — Session discovery via Devin CLI's global SQLite store (~/.local/share/devin/cli/sessions.db)", true)
    private val copilotEnabledCheckbox = JBCheckBox("GitHub Copilot — CLI session-store scan + VS Code Chat workspace storage", true)
    private val clineEnabledCheckbox = JBCheckBox("Cline — Cline CLI (~/.cline/data/sessions) + Cline VS Code extension (globalStorage)", true)
    private val antigravityEnabledCheckbox = JBCheckBox("Antigravity — Session discovery via Antigravity's per-conversation store (~/.gemini/antigravity*)", true)
    private val kimiEnabledCheckbox = JBCheckBox("Kimi Code — Session discovery via Kimi Code CLI's store (~/.kimi-code/sessions)", true)
    private val globalInstructionsCheckbox = JBCheckBox(
        "Let AI assistants use Jolli's skills automatically " +
            "(adds a preference block to ~/.claude/CLAUDE.md, ~/.gemini/GEMINI.md, ~/.codex/AGENTS.md)",
        false,
    )
    private val excludePatternsField = JBTextField()
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
        refreshLocalAgentToolCombo()

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
            .addComponent(devinEnabledCheckbox, 4)
            .addComponent(copilotEnabledCheckbox, 4)
            .addComponent(clineEnabledCheckbox, 4)
            .addComponent(antigravityEnabledCheckbox, 4)
            .addComponent(kimiEnabledCheckbox, 4)
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

        // Local Agent card: agent-tool picker (contents fetched from the CLI-side
        // LOCAL_AGENT_TOOLS map via `refreshLocalAgentToolCombo`, so new backends
        // added to that map appear here automatically). Uses the tool's own
        // subscription sign-in, so no API key is collected here — mirrors the VS Code card.
        //
        // [localAgentStatusLabel] sits directly under the combo and carries the
        // same "not found on this machine" line the VS Code webview shows when
        // the selected tool cannot run.
        val localAgentContent = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            alignmentX = JComponent.LEFT_ALIGNMENT
            add(Box.createVerticalStrut(8))
            add(createStretchedFormPanel(FormBuilder.createFormBuilder()
                .addLabeledComponent(JBLabel("Agent tool:"), localAgentToolCombo, 1, false)
                .addTooltip("Uses your local agent's own login (subscription). Sign in with the corresponding CLI if prompted.")
                .panel))
            add(Box.createVerticalStrut(4))
            add(localAgentStatusLabel)
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

        providerCombo.addItemListener {
            syncProviderCard()
            // Switching TO local-agent must re-verify the current pick (a stale
            // "unavailable" verdict from a previous provider selection must not
            // silently keep OK disabled, and a never-probed pick must not
            // silently pass). Matches VS Code's aiProviderSelect change handler.
            if (it.stateChange == java.awt.event.ItemEvent.SELECTED &&
                providerCombo.selectedItem == PROVIDER_LOCAL_AGENT
            ) {
                probeLocalAgentUsableAsync()
            }
        }
        // Tool-combo edits trigger a fresh probe so the status line follows the
        // dropdown. Guarded on SELECTED so we don't fire twice per user click.
        localAgentToolCombo.addItemListener {
            if (it.stateChange == java.awt.event.ItemEvent.SELECTED &&
                providerCombo.selectedItem == PROVIDER_LOCAL_AGENT
            ) {
                probeLocalAgentUsableAsync()
            }
        }

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
        } else if (provider == PROVIDER_LOCAL_AGENT && localAgentAvailable == false) {
            // Only a confirmed-unavailable verdict blocks Apply — the null state
            // (probe still in flight, or never fired) is deliberately permissive
            // so the user can commit their pick without waiting on the daemon.
            // Matches VS Code's `updateApplyBtn`, whose `localAgentBlocks()` is
            // false while the probe result is null.
            val toolLabel = currentSelectedLocalAgentToolId()
                ?.let { toolId -> localAgentTools.firstOrNull { it.id == toolId }?.label ?: toolId }
                ?: "The selected tool"
            return ValidationInfo(
                "$toolLabel not found on this machine. Install it, or pick another tool.",
                localAgentToolCombo,
            )
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
            !cursorEnabledCheckbox.isSelected && !devinEnabledCheckbox.isSelected &&
            !copilotEnabledCheckbox.isSelected && !clineEnabledCheckbox.isSelected &&
            !antigravityEnabledCheckbox.isSelected && !kimiEnabledCheckbox.isSelected
        ) {
            return ValidationInfo("At least one platform must be enabled", claudeEnabledCheckbox)
        }

        return null
    }

    override fun doOKAction() {
        // Hold OK when a local-agent probe is still in flight. Mirrors VS Code's
        // `pendingApply` mechanism (SettingsScriptBuilder.ts:672–698) — without
        // it, a click landing in the ~500 ms – 2 s daemon cold-spawn window
        // would save `aiProvider=local-agent` against a tool that nobody has
        // verified. [doValidate] blocks a CONFIRMED unavailable pick but
        // deliberately lets `null` (checking…) through so OK doesn't gray out
        // mid-probe; this is the second gate at the actual save chokepoint.
        if (providerCombo.selectedItem == PROVIDER_LOCAL_AGENT && localAgentAvailable == null) {
            if (!awaitLocalAgentProbe()) {
                // Watchdog fired or user canceled the modal — do NOT persist.
                // Show the same wording VS Code shows on `pendingApplyTimer`
                // (SettingsScriptBuilder.ts:689) so the two UIs read the same.
                val toolLabel = currentSelectedLocalAgentToolId()
                    ?.let { id -> localAgentTools.firstOrNull { it.id == id }?.label ?: id }
                    ?: "the selected tool"
                localAgentStatusLabel.text =
                    "Couldn't verify $toolLabel — nothing was saved. Click Apply to try again."
                localAgentStatusLabel.foreground = JBColor.RED
                return
            }
            // Verdict landed during the wait. `false` will surface as a red
            // ValidationInfo through the alarm the probe's `invokeLater`
            // scheduled — return without calling super so the dialog stays
            // open. `true` falls through to the regular save below.
            if (localAgentAvailable == false) return
        }

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
            devinEnabled = devinEnabledCheckbox.isSelected,
            copilotEnabled = copilotEnabledCheckbox.isSelected,
            clineEnabled = clineEnabledCheckbox.isSelected,
            antigravityEnabled = antigravityEnabledCheckbox.isSelected,
            kimiEnabled = kimiEnabledCheckbox.isSelected,
            excludePatterns = if (excludePatterns.isNotEmpty()) excludePatterns else null,
            aiProvider = null,
            localAgentTool = null,
            localAgentPath = null,
            // dcoSignoff is written separately via saveDcoSignoff below. Force-null here
            // so this data-class overwrite doesn't clobber the value that call will restore.
            dcoSignoff = null,
            // Memory Bank folder writes go to `localFolder` — the canonical
            // cross-surface key shared with CLI + VS Code. IntelliJ used to
            // write a separate `knowledgeBasePath` key here, which drifted from
            // `localFolder` and made the two IDE surfaces read different folders
            // for the same repo. The DTO field now carries
            // `@SerializedName(alternate = ["knowledgeBasePath"])` so a legacy
            // config that only has the old key is transparently picked up on
            // read; serialization always writes `localFolder`, so the legacy key
            // self-heals on the next save.
            localFolder = kbPath.ifBlank { null },
            knowledgeBaseSort = kbSort,
            // Preserve any existing `paused` state — the checkbox that edited
            // it was removed; disable is now driven by `manuallyDisabled` in
            // .jolli/profile.json (spec 306), surfaced via the STATUS header
            // Disable icon and the Disabled card, not this dialog.
            paused = existing.paused,
            // Round-tripped, not edited — see savedAutoSyncEnabled's declaration.
            autoSyncEnabled = savedAutoSyncEnabled,
            syncTranscripts = if (syncTranscriptsCheckbox.isSelected) true else null,
            syncPollIntervalSec = savedSyncPollIntervalSec,
        )
        SessionTracker.saveConfigToDir(config, configDir)
        // Provider routing lives ONLY in the shared config.json (cross-surface, one copy) so the
        // CLI's summary QueueWorker honors the choice made here. The Anthropic key is still
        // preserved across provider switches, but now stored shared so the CLI can read it too.
        // localAgentTool is the CLI-side id (e.g. `codex`, not the human label `Codex`); map the
        // combo selection back through `localAgentTools` — falling back to the fallback id when
        // no row matches (async fetch never landed, or user chose a stale option). localAgentPath
        // is never touched — both mirror how the VS Code settings panel persists this group.
        val selectedLabel = localAgentToolCombo.selectedItem as? String
        val selectedToolId = localAgentTools.firstOrNull { it.label == selectedLabel }?.id
            ?: LocalAgentTools.FALLBACK.id
        SessionTracker.saveSharedProviderConfig(
            aiProvider = provider,
            apiKey = resolvedApiKey.ifBlank { null },
            localAgentTool = selectedToolId,
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

        // Snapshot the PRE-SAVE credential state under the same lens as [hasCredentials]
        // so an unchanged "still has creds" save is a no-op — we only install when the
        // user transitions from "no creds" → "has creds" via this save. Without this,
        // a plain Settings save on a healthy repo would trigger a redundant install.
        // Credentials removed via a previous save leave `manuallyDisabled=true` on disk
        // (via [service.uninstall]'s `persistManualDisable`); re-adding them here needs
        // an explicit install so the user doesn't have to hunt for the DisabledPanel's
        // Enable button afterwards — mirrors the retired pause-checkbox's `!nowPaused
        // && wasPaused` re-enable branch.
        val existingProvider = existing.aiProvider?.lowercase()
        val existingAnthropicKey = existing.apiKey?.ifBlank { null }
        val existingJolliKey = existing.jolliApiKey?.ifBlank { null }
        val wasHasCredentials = when (existingProvider) {
            "local-agent" -> true
            "jolli" -> !existingJolliKey.isNullOrBlank()
            "anthropic" -> !existingAnthropicKey.isNullOrBlank() || !envAnthropicKey.isNullOrBlank()
            else -> !existingAnthropicKey.isNullOrBlank() ||
                !envAnthropicKey.isNullOrBlank() ||
                !existingJolliKey.isNullOrBlank()
        }

        // Snapshot the inputs needed off the EDT, then close the dialog immediately. All
        // the heavy work (git subprocesses, hook install/uninstall, Memory Bank init +
        // migration) runs in ONE ordered background task so the IDE never freezes and the
        // enable/disable and migration steps can't race each other.
        val projectPath = service.mainRepoRoot ?: project.basePath
        val kbCustomPath = config.localFolder
        // Per-repo outbound-push toggle (spec 306) — snapshot for the off-EDT write below.
        val pushControlWasLoaded = pushControlLoaded
        val pushDisabledNow = !pushEnabledCheckbox.isSelected
        val pushDisabledWas = savedPushDisabled
        // Snapshot the per-agent toggles on the EDT so the sync-agent-hooks bridge
        // call further down runs off-EDT without reading Swing state from a pool
        // thread. `config` above already captured these via its data-class copy,
        // but keeping named locals here makes the off-EDT call site self-evident
        // and mirrors how [pushDisabledNow] is handled.
        val claudeEnabledNow = claudeEnabledCheckbox.isSelected
        val geminiEnabledNow = geminiEnabledCheckbox.isSelected
        // Prior on-disk values — default `undefined → enabled` matches
        // [SessionTracker.isSourceEnabled] and the checkbox init at
        // [`refreshUiFromConfig`]. Used below to gate step 2b on an actual toggle
        // transition so unrelated saves (excludePatterns, localFolder, …) don't
        // trigger the manual-disable balloon in a paused repo — VS Code parity.
        val wasClaudeEnabled = existing.claudeEnabled != false
        val wasGeminiEnabled = existing.geminiEnabled != false

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

                    // 1. Auto-disable hooks when the resolved provider has no credentials.
                    // The former Pause checkbox was removed from this dialog; enable/disable
                    // is driven by `manuallyDisabled` in .jolli/profile.json (spec 306),
                    // surfaced via the STATUS header Disable icon and the Disabled card.
                    if (!hasCredentials) {
                        indicator.text = "Disabling Jolli Memory…"
                        service.uninstall()
                        ai.jolli.jollimemory.core.telemetry.Telemetry.track("surface_disabled", mapOf("trigger" to "settings"))
                    } else if (!wasHasCredentials) {
                        // Credentials went from empty → present via this save. A previous
                        // credential-removal save left `manuallyDisabled=true` on disk
                        // (via [service.uninstall] with `persistManualDisable`), so re-enable
                        // here — `enableFull` sends `clearManualDisableOnSuccess=true`,
                        // which clears the opt-out and routes the tool window back to
                        // CARD_MAIN without a separate DisabledPanel Enable click.
                        // Mirrors the retired pause-checkbox's `!nowPaused && wasPaused`
                        // re-enable branch.
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
                        // Fire-and-forget on a pooled thread — VS Code parity: silent,
                        // and a large first-install migration never blocks the save task
                        // for minutes. The config was persisted above, so the CLI reads
                        // the fresh `localFolder`.
                        //
                        // No reader re-point is needed any more: reads go through the
                        // bridge-backed storage stack, which resolves the Memory Bank
                        // path per call (cutover gate G.3 retired the folder reader and
                        // its stale-attachment failure mode).
                        service.migrateMemoryBankAsync()
                    }

                    // 2b. Agent hook sync — install or remove the Claude Stop and Gemini
                    // AfterAgent hooks in every worktree based on the per-agent toggles,
                    // over the CLI daemon (~5-20 ms). Direct parity with VS Code's
                    // SettingsWebviewPanel.syncHooks: it reuses the SAME installer helpers
                    // (installClaudeHook / removeClaudeHook / installGeminiHook /
                    // removeGeminiHook, [ClaudeHookInstaller.ts]/[GeminiHookInstaller.ts])
                    // via the `sync-agent-hooks` ide-bridge action, so a toggle flip takes
                    // effect immediately for every worktree instead of only the current
                    // one (previous behavior via `enable --integrations-only`).
                    //
                    // Gated on a per-agent TOGGLE TRANSITION so unrelated saves
                    // (excludePatterns, localFolder, model, …) never trigger the
                    // manual-disable "Re-enable Jolli Memory" balloon in a paused
                    // repo — same transition-gated pattern as steps 2c / 2d.
                    // Hook-drift healing on unrelated saves is already handled at
                    // startup by [JolliMemoryService.initialize] on every window
                    // open, so gating this call trades a rare daemon round-trip
                    // for a real bug: the pre-fix behavior fired the balloon on
                    // any Apply in a manually-disabled repo, indistinguishable
                    // from a save failure and lobbying the user to undo the
                    // opt-out they set. VS Code has the same fix in its
                    // [SettingsWebviewPanel.syncHooks] call site.
                    //
                    // Also skipped when this same Apply ran step 1's auto-disable
                    // (`justAutoDisabled`). Step 1 already ran `service.uninstall()`
                    // → `jolli disable` → wrote the machine-owned manually-disabled
                    // flag, so the CLI-side handler would immediately return
                    // `manuallyDisabled=true` and the branch below would post the
                    // paused balloon three seconds after the save. VS Code side-steps
                    // this because [SettingsHtmlBuilder.ts]'s Disable command lives on
                    // a separate surface and never chains with syncHooks. Steps
                    // 2c / 2d still run below regardless, so any global-
                    // instructions or push-control transition on the same Apply
                    // is still honored.
                    //
                    // The predicate mirrors step 1's branch EXACTLY (`!hasCredentials`,
                    // unconditional) — not the narrower credential-removal transition
                    // `!hasCredentials && wasHasCredentials`. Step 1 disables on every
                    // credential-less save, including one where credentials were
                    // already absent, so gating on the transition let precisely that
                    // case fall through to the balloon this comment exists to prevent.
                    val justAutoDisabled = !hasCredentials
                    val toggleChanged =
                        claudeEnabledNow != wasClaudeEnabled || geminiEnabledNow != wasGeminiEnabled
                    if (projectPath != null && !justAutoDisabled && toggleChanged) {
                        indicator.text = "Syncing agent hooks…"
                        try {
                            val hookResult = CliIntegrations.syncAgentHooks(
                                projectPath,
                                claudeEnabled = claudeEnabledNow,
                                geminiEnabled = geminiEnabledNow,
                            )
                            if (hookResult.manuallyDisabled) {
                                // The repo carries the machine-owned manual-disable opt-out —
                                // the CLI-side handler refused to touch hooks on any worktree,
                                // and no worktree/failure detail arrived. Config was still
                                // persisted just above (so the startup self-heal can honor the
                                // fresh flags after a re-enable), but silently returning would
                                // let the user believe their toggle flip took effect — indistin-
                                // guishable from the "worked" case. Surface the state with a
                                // NotificationAction that lifts the opt-out in place via
                                // service.install() (the CLI's `enable`), so re-enable is one
                                // click away from the dialog they just left. VS Code parity:
                                // its SettingsWebviewPanel.notifyManuallyDisabled routes to the
                                // jollimemory.enableJolliMemory command with the same intent.
                                LOG.info("Agent hook sync skipped — repo manually disabled; toggles saved, hooks unchanged")
                                val paused = com.intellij.notification.Notification(
                                    "JolliMemory",
                                    "Jolli Memory is paused for this repo",
                                    "Your Claude/Gemini toggles were saved, but the Stop/AfterAgent hooks won't install until you re-enable Jolli Memory.",
                                    com.intellij.notification.NotificationType.INFORMATION,
                                ).addAction(
                                    com.intellij.notification.NotificationAction.createSimpleExpiring(
                                        "Re-enable Jolli Memory",
                                    ) {
                                        // install() re-runs `jolli enable`, which clears the
                                        // opt-out and reinstalls hooks per-worktree. Must be
                                        // off the EDT — same threading contract as the
                                        // enable/disable branch in this Task.Backgroundable.
                                        com.intellij.openapi.application.ApplicationManager.getApplication()
                                            .executeOnPooledThread {
                                                try {
                                                    if (!service.isInitialized) service.initialize()
                                                    service.install()
                                                    ai.jolli.jollimemory.core.telemetry.Telemetry.track(
                                                        "surface_enabled",
                                                        mapOf("trigger" to "manually_disabled_notification"),
                                                    )
                                                } catch (e: Exception) {
                                                    LOG.warn("Re-enable from manual-disable notification failed: ${e.message}")
                                                }
                                            }
                                    },
                                )
                                com.intellij.notification.Notifications.Bus.notify(paused, project)
                            } else if (hookResult.failures.isNotEmpty()) {
                                // config.json has already been persisted above with the new
                                // claudeEnabled/geminiEnabled, but the hook block failed to
                                // reach disk for one or more worktrees. Without a visible
                                // hint the user would think tracking is on while the Stop /
                                // AfterAgent hook is missing and nothing gets captured. VS
                                // Code surfaces this by throwing from `syncHooks` so the
                                // panel posts "Failed to save settings"; we take the same
                                // stance by showing a balloon that names which
                                // integrations / worktrees failed.
                                val summary = hookResult.failures.joinToString(", ") {
                                    "${it.integration}@${it.worktree}: ${it.message}"
                                }
                                LOG.warn("Agent hook sync completed with ${hookResult.failures.size} failure(s): $summary")
                                com.intellij.notification.Notifications.Bus.notify(
                                    com.intellij.notification.Notification(
                                        "JolliMemory",
                                        "Agent hook sync had ${hookResult.failures.size} failure(s)",
                                        "Session tracking may not activate for the affected integrations until the next Settings save or IDE restart. Details: $summary",
                                        com.intellij.notification.NotificationType.WARNING,
                                    ),
                                    project,
                                )
                            }
                        } catch (e: Exception) {
                            // The bridge call itself failed (daemon unreachable / one-shot
                            // spawn crashed / JSON parse error). claudeEnabled /
                            // geminiEnabled are already persisted to config.json above and
                            // the CLI hook run-time re-reads those flags on every
                            // invocation, so on-disk hooks stay in whatever shape the
                            // previous save left them until the next Apply or the
                            // startup self-heal in initialize(). Not throwing keeps that
                            // recovery path open, but the user needs to know the current
                            // toggle didn't reach disk.
                            LOG.warn("Agent hook sync failed (non-fatal): ${e.message}")
                            com.intellij.notification.Notifications.Bus.notify(
                                com.intellij.notification.Notification(
                                    "JolliMemory",
                                    "Agent hook sync failed",
                                    "Settings were saved but the Claude/Gemini hook state on disk was not updated: ${e.message ?: e.javaClass.simpleName}. Re-open Settings and click Apply again, or restart the IDE to let the startup self-heal retry.",
                                    com.intellij.notification.NotificationType.WARNING,
                                ),
                                project,
                            )
                        }
                    }

                    // 2c. Apply the global-instructions consent: persist a fresh decision to
                    // the shared config, then let the bundled CLI write or remove the
                    // skill-preference block. `enable --integrations-only` runs the same
                    // syncGlobalInstructions as VS Code — it reads the just-persisted value
                    // and never prompts (undecided is a no-op, "disabled" heals stale blocks).
                    // Gated on an actual transition to match VS Code's own gate (its
                    // SettingsWebviewPanel calls syncGlobalInstructions() only when the
                    // checkbox toggled). MCP registration and skill drift are healed
                    // separately at startup via the plugin-version stamp + mcpRegistrationStale
                    // probe in [JolliMemoryService.initialize], so skipping the subprocess on
                    // an untransitioned save saves 500 ms – 2 s of cold Node spawn per Apply.
                    if (newGlobalInstructions != null && newGlobalInstructions != prevGlobalInstructions) {
                        indicator.text = "Updating AI assistant instructions…"
                        SessionTracker.saveGlobalInstructions(newGlobalInstructions)
                        if (projectPath != null) {
                            try {
                                CliIntegrations.enableIntegrations(projectPath)
                            } catch (e: Exception) {
                                // Fail-soft — instruction sync must never break settings save.
                            }
                        }
                    }

                    // 2d. Persist the per-repo outbound-push toggle (spec 306) via the CLI
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

    /**
     * Fetches the CLI's `LOCAL_AGENT_TOOLS` map over `jolli ide-bridge` on a
     * pooled thread, then re-populates [localAgentToolCombo] on the EDT with
     * the returned entries. Off-EDT because the daemon fast path is ~5-20 ms
     * but the one-shot spawn fallback (unbound daemon) can hit 500 ms-2 s — the
     * dialog is already visible at this point and IntelliJ's slow-EDT floor is
     * 300 ms, so we must not block. On any failure the fallback singleton the
     * combo was initialised with stays in place.
     */
    private fun refreshLocalAgentToolCombo() {
        val currentId = SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir()).localAgentTool
            ?: LocalAgentTools.FALLBACK.id
        // Restore the saved selection SYNCHRONOUSLY from the static baseline
        // (`localAgentTools` is DEFAULT_TOOLS here), so a reopened dialog shows the
        // saved tool immediately. The previous code applied the selection ONLY in
        // the async callback below — so a slow / hung / failed ide-bridge fetch left
        // the combo on its default (Claude, index 0) and a saved non-Claude tool
        // (e.g. kimi) looked "forgotten" even though it was persisted correctly.
        applyLocalAgentSelection(localAgentTools, currentId)
        val projectDir = service.mainRepoRoot ?: project.basePath ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            val tools = LocalAgentTools.load(projectDir)
            ApplicationManager.getApplication().invokeLater {
                localAgentTools = tools
                localAgentToolCombo.model = DefaultComboBoxModel(tools.map { it.label }.toTypedArray())
                applyLocalAgentSelection(tools, currentId)
                // Fire a probe once the combo lands on its persisted selection.
                // The [localAgentToolCombo] itemListener already probes on user
                // clicks, but assigning the same index it currently holds is a
                // no-op for the listener, so an already-selected tool would
                // never verify itself. Only when local-agent is the active
                // provider — no point probing a card the user cannot see.
                if (providerCombo.selectedItem == PROVIDER_LOCAL_AGENT) {
                    probeLocalAgentUsableAsync()
                }
            }
        }
    }

    /** Selects the combo row whose tool id matches [currentId], else the first. */
    private fun applyLocalAgentSelection(tools: List<LocalAgentToolOption>, currentId: String) {
        localAgentToolCombo.selectedIndex = tools.indexOfFirst { it.id == currentId }.takeIf { it >= 0 } ?: 0
    }

    /**
     * Verifies the currently-selected agent tool actually runs on this machine
     * by asking the CLI over the `local-agent-usable` ide-bridge action.
     * Mirrors VS Code's `probeLocalAgent` (`SettingsScriptBuilder.ts`) — the
     * same UX shows the same wording, and [doValidate] blocks Apply while an
     * unavailable pick is selected.
     *
     * Off-EDT because the daemon fast path is ~5-20 ms but the one-shot spawn
     * fallback can hit hundreds of milliseconds; the dialog is already visible
     * and IntelliJ's slow-EDT floor is 300 ms, so the wait must not block.
     *
     * Stale-reply guard: [localAgentProbeTool] pins the id the current probe
     * was fired for. When the invokeLater lands it drops the verdict if the
     * user has since switched off this tool, so a slow Codex answer cannot
     * overwrite a fresh Cursor "Checking…" line.
     */
    private fun probeLocalAgentUsableAsync() {
        val tool = currentSelectedLocalAgentToolId() ?: return
        // Coalesce redundant probes for the SAME tool. On dialog open, three
        // triggers can fire in ~ms succession for a saved local-agent config:
        // the providerCombo item listener (populateFields sets it → SELECTED),
        // the localAgentToolCombo item listener (applyLocalAgentSelection sets
        // it → SELECTED, when savedId ≠ ctor-default claude-code), and
        // refreshLocalAgentToolCombo's trailing explicit call. Without this
        // guard the same tool gets probed 2-3 times per open, and on a machine
        // with a cold daemon each probe is one node cold-start.
        //
        // Skip when the same tool is either still in flight OR already carries
        // a verdict — the FIRST caller does the work and later callers reuse
        // its result. `probeTool != tool` (user picked a different tool)
        // always falls through and re-probes. Overrides don't change during
        // the dialog's lifetime (`localAgentPath` is edited only at save), so
        // a settled verdict for `tool` remains accurate until the pick moves.
        if (localAgentProbeTool == tool && (localAgentProbeInFlight || localAgentAvailable != null)) {
            return
        }
        // Resolve the repo root BEFORE mutating any UI — otherwise a null
        // `mainRepoRoot` (no worktree open) would leave the status label
        // stuck on "Checking…" forever.
        val projectDir = service.mainRepoRoot ?: project.basePath ?: return
        localAgentProbeTool = tool
        localAgentAvailable = null
        localAgentProbeInFlight = true
        localAgentStatusLabel.text = "Checking…"
        localAgentStatusLabel.foreground = JBColor.foreground()
        // Refresh the OK button through DialogWrapper's validation pass so the
        // "Checking…" state doesn't inherit a stale ValidationInfo from before.
        initValidation()
        ApplicationManager.getApplication().executeOnPooledThread {
            // `Boolean?` return: null means "we couldn't verify — do not claim
            // either verdict, be permissive downstream". See the catch below.
            val available: Boolean? = try {
                val body = JsonObject().apply { addProperty("tool", tool) }
                val res = CliIntegrations.runIdeBridge(projectDir, "local-agent-usable", body.toString())
                val obj = res.takeIf { it.isJsonObject }?.asJsonObject
                obj?.get("available")
                    ?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean }
                    ?.asBoolean
                    // Malformed reply: treat as unavailable — the "unknown ≡ not
                    // usable" contract matches the CLI-side catch below and
                    // VS Code's `handleProbeLocalAgent`. See the bridge action.
                    ?: run {
                        LOG.warn("local-agent-usable returned a malformed reply ($res)")
                        false
                    }
            } catch (e: com.intellij.openapi.progress.ProcessCanceledException) {
                // IntelliJ contract: PCE must never be swallowed by a generic
                // Exception catch. Propagate so the pool-thread task unwinds
                // cleanly on cancel.
                throw e
            } catch (e: Exception) {
                val msg = e.message.orEmpty()
                when {
                    // Old CLI without this PR — the `local-agent-usable` action
                    // was added in the same change as this Kotlin caller.
                    // Users on a stale global `@jolli.ai/cli` install (that
                    // outranks the plugin's own bundle via `cli` tie-break in
                    // SOURCE_PREFERENCE_ORDER) hit this path. Reporting the
                    // tool as "not found on this machine" would misdirect the
                    // user: the tool may be perfectly installed — the CLI
                    // just doesn't yet know how to answer. Return null and
                    // let the caller be permissive.
                    "Unknown IDE bridge action" in msg -> {
                        LOG.info(
                            "local-agent-usable: resolved CLI predates this action; " +
                                "treating $tool as unknown/permissive"
                        )
                        null
                    }
                    // Kotlin's LocalAgentTools.DEFAULT_TOOLS mirror is ahead of
                    // the resolved CLI's LOCAL_AGENT_TOOLS map. The CLI raises
                    // this loudly by design — it's a caller bug worth ERROR
                    // level for us — but the user cannot act on it and it is
                    // NOT a fact about their environment, so still permissive.
                    "Unknown local agent tool" in msg -> {
                        LOG.error(
                            "local-agent-usable: CLI does not recognize tool id \"$tool\" " +
                                "(Kotlin DEFAULT_TOOLS / CLI LOCAL_AGENT_TOOLS drift?)",
                            e,
                        )
                        null
                    }
                    // Everything else (config unreadable, discovery threw, IO
                    // error) keeps the "unknown ≡ not usable" contract — same
                    // as the CLI's own catch and the VS Code sibling.
                    else -> {
                        LOG.warn("local-agent-usable probe failed for $tool", e)
                        false
                    }
                }
            }
            SwingUtilities.invokeLater {
                // Drop when the dialog was closed (Cancel / window close) while
                // the probe was in flight. `initValidation()` on a disposed
                // DialogWrapper is a documented no-op, but skipping the whole
                // body keeps us from touching the label at all.
                if (isDisposed) return@invokeLater
                // Drop the stale reply if the user has since switched off this tool.
                if (localAgentProbeTool != tool) return@invokeLater
                // Write order is load-bearing: `available` MUST be set before
                // `probeInFlight` flips to false. [awaitProbeSettlement] polls
                // `probeInFlight` first and returns as soon as it reads false;
                // [doOKAction] then reads `available`. Both fields are @Volatile,
                // so the volatile happens-before guarantees that a reader
                // observing `probeInFlight = false` also sees the fresh write to
                // `available`. Reversing these two lines opens a window where
                // the reader sees a settled probe but stale `available`.
                localAgentAvailable = available
                localAgentProbeInFlight = false
                when (available) {
                    // Confirmed usable OR permissive-unknown: keep the status
                    // line empty. Rendering red text for `null` would be a
                    // factual lie ("not found on this machine") when we in
                    // fact have no evidence of any such condition.
                    true, null -> {
                        localAgentStatusLabel.text = " "
                        localAgentStatusLabel.foreground = JBColor.foreground()
                    }
                    false -> {
                        val label = localAgentTools.firstOrNull { it.id == tool }?.label ?: tool
                        localAgentStatusLabel.text =
                            "$label not found on this machine. Install it, or pick another tool."
                        localAgentStatusLabel.foreground = JBColor.RED
                    }
                }
                initValidation()
            }
        }
    }

    /**
     * Blocks OK with a cancelable modal progress until the in-flight probe
     * returns or the 8 s watchdog trips — the same 8 s VS Code's
     * `pendingApplyTimer` arms (SettingsScriptBuilder.ts:685). Returns true
     * when a verdict landed inside the window OR when no probe is in flight
     * to wait for; false on cancel or timeout.
     *
     * The no-in-flight fast path exists because `localAgentAvailable == null`
     * (the state that got us here from [doOKAction]) has three sources:
     *   1. Probe genuinely running — wait for it.
     *   2. Probe never fired — [probeLocalAgentUsableAsync] can early-return
     *      when there is no project root, or [refreshLocalAgentToolCombo]'s
     *      up-stack guard swallowed the trigger.
     *   3. Probe already landed on a permissive-unknown outcome — the
     *      unknown-action / unknown-tool branches in
     *      [probeLocalAgentUsableAsync] write `available = null`.
     * (2) and (3) both leave [localAgentProbeInFlight] false, so waiting
     * 8 s can only ever time out — the user then sees "Couldn't verify …"
     * with no way to self-heal short of jiggling the combo. Short-circuit
     * them to true here so the save proceeds — matches the "null is
     * permissive" contract already used by [doValidate].
     *
     * Does NOT relaunch a probe. The pool-thread task from
     * [probeLocalAgentUsableAsync] runs on independently; its
     * `SwingUtilities.invokeLater` reply pumps while the modal is up, so
     * [localAgentProbeInFlight] flips on the EDT. The polling task here
     * runs on a separate pooled thread, so both @Volatile fields it reads
     * ([localAgentProbeInFlight] and [localAgentAvailable]) must be
     * @Volatile to make the EDT writes visible across threads.
     */
    private fun awaitLocalAgentProbe(): Boolean {
        val toolId = currentSelectedLocalAgentToolId() ?: return true
        if (!localAgentProbeInFlight) return true
        val toolLabel = localAgentTools.firstOrNull { it.id == toolId }?.label ?: toolId
        val landed = java.util.concurrent.atomic.AtomicBoolean(false)
        try {
            ProgressManager.getInstance().runProcessWithProgressSynchronously({
                val indicator = ProgressManager.getInstance().progressIndicator
                // Poll body lives in [awaitProbeSettlement], a top-level pure function
                // so it can be unit-tested without spinning up IntelliJ's progress
                // subsystem. See LocalAgentProbePollTest.
                landed.set(
                    awaitProbeSettlement(
                        now = { System.currentTimeMillis() },
                        sleepMillis = { ms -> Thread.sleep(ms) },
                        inFlight = { localAgentProbeInFlight },
                        isCanceled = { indicator?.isCanceled == true },
                        deadlineMillis = 8000L,
                    ),
                )
            }, "Checking $toolLabel…", true, project)
        } catch (e: com.intellij.openapi.progress.ProcessCanceledException) {
            // User canceled the modal — leave `landed` false so doOKAction
            // reports "nothing was saved" and the dialog stays open.
        }
        return landed.get()
    }

    /**
     * The id (e.g. `codex`) of the tool the combo currently displays. Returns
     * null when the combo has no valid selection (should not happen once
     * [refreshLocalAgentToolCombo] has landed, but the probe guards on this so
     * an intermediate state never fires a bogus `local-agent-usable` request).
     */
    private fun currentSelectedLocalAgentToolId(): String? {
        val idx = localAgentToolCombo.selectedIndex
        if (idx < 0 || idx >= localAgentTools.size) return null
        return localAgentTools[idx].id
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
        devinEnabledCheckbox.isSelected = config.devinEnabled != false
        copilotEnabledCheckbox.isSelected = config.copilotEnabled != false
        clineEnabledCheckbox.isSelected = config.clineEnabled != false
        antigravityEnabledCheckbox.isSelected = config.antigravityEnabled != false
        kimiEnabledCheckbox.isSelected = config.kimiEnabled != false
        dcoSignoffCheckbox.isSelected = config.dcoSignoff == true
        // Telemetry: on unless the shared opt-out flag says "off" (default on).
        telemetryCheckbox.isSelected = config.telemetry != "off"

        // Memory Bank
        val projectPath = service.mainRepoRoot ?: project.basePath ?: ""
        if (projectPath.isNotBlank()) {
            val repoName = KBPathResolver.extractRepoName(projectPath)
            val remoteUrl = KBPathResolver.getRemoteUrl(projectPath)
            defaultKBPath = KBPathResolver.resolve(repoName, remoteUrl).toString()
        }
        kbPathField.text = config.localFolder ?: KBPathResolver.KB_PARENT.toString()
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
                // Silent pooled-thread run — VS Code parity: rebuildKnowledgeBase shows
                // no progress indicator; the result dialog below is the feedback
                // (the analog of VS Code's inline button-state message). The
                // migration lock serializes with background migrations (startup /
                // Settings save) that would otherwise race on migration.json.
                com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
                    try {
                        service.withMigrationLock {
                            val gitOps = GitOps(projectPath)
                            val storage = StorageFactory.create(gitOps, projectPath)
                            if (!storage.exists()) {
                                SwingUtilities.invokeLater {
                                    Messages.showInfoMessage(project, "No git storage found — nothing to migrate.", "Migration")
                                }
                                return@withMigrationLock
                            }

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
                            val staleFolders = KBPathResolver.findRepoFolders(repoName, remoteUrl, config.localFolder)
                            for (stale in staleFolders) {
                                KBPathResolver.archiveKBFolder(stale, config.localFolder)
                            }

                            // With the pile archived, the base slot is free; resolve to it
                            // (falling back to a fresh -N only if some folder survived archiving).
                            val kbRoot = KBPathResolver.resolve(repoName, remoteUrl, config.localFolder)
                            KBPathResolver.initializeKBFolder(kbRoot, repoName, remoteUrl)

                            // Run the migration through the bundled CLI. The CLI resolves the
                            // same freshly-archived base folder from the shared config and
                            // copies the orphan-branch data onto disk.
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

/**
 * Pure poll loop that awaits an async probe reply. Extracted from
 * [SettingsDialog.awaitLocalAgentProbe] so its "wait until settled OR deadline
 * OR cancel" semantics can be unit-tested without the IntelliJ progress
 * subsystem — every side-effecting dependency (clock, sleep, in-flight flag,
 * cancel signal) is injected as a lambda, and the function itself has no
 * global state.
 *
 * Returns `true` when [inFlight] is observed as false inside the window;
 * `false` on deadline or when [isCanceled] reads true. The function body itself
 * never throws — but it does not catch exceptions from the injected lambdas.
 * In production `sleepMillis = { Thread.sleep(it) }`, which throws
 * `InterruptedException` if the thread is interrupted; IntelliJ's cancellation
 * goes through the polled [isCanceled] rather than an interrupt, so this is
 * theoretical, but callers must not assume settlement on any exceptional exit.
 *
 * The [pollIntervalMillis] default matches what the production caller uses.
 */
internal fun awaitProbeSettlement(
    now: () -> Long,
    sleepMillis: (Long) -> Unit,
    inFlight: () -> Boolean,
    isCanceled: () -> Boolean,
    deadlineMillis: Long,
    pollIntervalMillis: Long = 50L,
): Boolean {
    val deadline = now() + deadlineMillis
    while (now() < deadline && !isCanceled()) {
        if (!inFlight()) return true
        sleepMillis(pollIntervalMillis)
    }
    return false
}
