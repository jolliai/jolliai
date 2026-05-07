package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.FolderStorage
import ai.jolli.jollimemory.core.JolliMemoryConfig
import ai.jolli.jollimemory.core.KBPathResolver
import ai.jolli.jollimemory.core.MetadataManager
import ai.jolli.jollimemory.core.MigrationEngine
import ai.jolli.jollimemory.core.OrphanBranchStorage
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.services.JolliMemoryService
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
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultComboBoxModel
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JSeparator

/**
 * Full settings dialog opened from the gear icon on the MEMORIES panel toolbar.
 *
 * Sections (top to bottom):
 *   1. Sign-in bar (mirrors the tool window banner; settings hint dropped)
 *   2. General — AI provider selector (own component, see [AiProviderSelector]) +
 *      excluded patterns
 *   3. AI Configuration — model + max tokens (hidden when provider == "jolli")
 *   4. Enabled Platforms — Claude / Codex / Gemini toggles
 *   5. Knowledge Base — folder path, sort order, migrate button
 *
 * Reads/writes the global config (`config-intellij.json` after namespacing).
 */
class SettingsDialog(
    private val project: Project,
    private val service: JolliMemoryService,
) : DialogWrapper(project) {

    // ── Sign-in bar ────────────────────────────────────────────────────────
    private val signInBar = SignInBar()

    // ── General ────────────────────────────────────────────────────────────
    private val providerSelector = AiProviderSelector()
    private val excludePatternsField = JBTextField()

    // ── AI Configuration ───────────────────────────────────────────────────
    private val modelCombo = ComboBox(DefaultComboBoxModel(arrayOf("haiku", "sonnet", "opus"))).apply {
        maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
    }
    private val maxTokensField = JBTextField()
    private lateinit var aiConfigSection: JComponent

    // ── Enabled Platforms ──────────────────────────────────────────────────
    private val claudeEnabledCheckbox = JBCheckBox("Claude Code — Session tracking via Stop hook", true)
    private val codexEnabledCheckbox = JBCheckBox("Codex CLI — Session discovery via filesystem scan", true)
    private val geminiEnabledCheckbox = JBCheckBox("Gemini CLI — Session tracking via AfterAgent hook", true)

    // ── Knowledge Base ────────────────────────────────────────────────────
    private val kbPathField = TextFieldWithBrowseButton().apply {
        addBrowseFolderListener(
            project,
            FileChooserDescriptorFactory.createSingleFolderDescriptor()
                .withTitle("Knowledge Base Folder")
                .withDescription("Select the root folder for your local Knowledge Base"),
        )
    }
    private val kbSortCombo = ComboBox(DefaultComboBoxModel(arrayOf("date", "name"))).apply {
        maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
    }
    private var defaultKBPath: String = ""

    init {
        title = "Jolli Memory Settings"
        setOKButtonText("Apply Changes")
        init()
        loadSettings()
        // Tie sub-components' lifecycles to the dialog so their auth listeners are removed on close.
        Disposer.register(disposable, signInBar)
        Disposer.register(disposable, providerSelector)
    }

    override fun createCenterPanel(): JComponent {
        val panel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(8, 12)
        }

        // ── Sign-in bar ────────────────────────────────────────────────────
        signInBar.alignmentX = JComponent.LEFT_ALIGNMENT
        panel.add(signInBar)
        panel.add(Box.createVerticalStrut(8))
        panel.add(createSeparator())
        panel.add(Box.createVerticalStrut(12))

        // ── General Section ────────────────────────────────────────────────
        panel.add(createSectionHeader("General"))
        panel.add(createStretchedFormPanel(providerSelector))
        panel.add(createStretchedFormPanel(FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Excluded patterns:"), excludePatternsField, 1, false)
            .addTooltip("Select files for jolli memory to ignore (comma-separated globs, e.g. **/*.vsix, docs/*.md)")
            .panel))

        panel.add(Box.createVerticalStrut(12))
        panel.add(createSeparator())
        panel.add(Box.createVerticalStrut(12))

        // ── AI Configuration Section ───────────────────────────────────────
        aiConfigSection = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            alignmentX = JComponent.LEFT_ALIGNMENT
            add(createSectionHeader("AI Configuration"))
            add(createStretchedFormPanel(FormBuilder.createFormBuilder()
                .addLabeledComponent(JBLabel("Model:"), modelCombo, 1, false)
                .addTooltip("Haiku = fastest, Sonnet = balanced (default), Opus = most capable")
                .addLabeledComponent(JBLabel("Max Tokens:"), maxTokensField, 1, false)
                .addTooltip("Default: 8192")
                .panel))
            add(Box.createVerticalStrut(12))
            add(createSeparator())
            add(Box.createVerticalStrut(12))
        }
        panel.add(aiConfigSection)

        // ── Enabled Platforms Section ──────────────────────────────────────
        panel.add(createSectionHeader("Enabled Platforms"))
        panel.add(createStretchedFormPanel(FormBuilder.createFormBuilder()
            .addComponent(claudeEnabledCheckbox, 4)
            .addComponent(codexEnabledCheckbox, 4)
            .addComponent(geminiEnabledCheckbox, 4)
            .panel))

        panel.add(Box.createVerticalStrut(12))
        panel.add(createSeparator())
        panel.add(Box.createVerticalStrut(12))

        // ── Knowledge Base Section ─────────────────────────────────────────
        panel.add(createSectionHeader("Knowledge Base"))
        panel.add(createStretchedFormPanel(FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Folder Path:"), kbPathField, 1, false)
            .addTooltip("Parent folder for all KB data. Each repo gets its own subfolder. Default: ~/Documents/jolli/")
            .addLabeledComponent(JBLabel("Sort Order:"), kbSortCombo, 1, false)
            .addTooltip("How files are sorted in the Knowledge Base explorer")
            .addComponent(createMigrateButton(), 12)
            .panel))

        // Hide AI Configuration whenever provider isn't Anthropic.
        providerSelector.addStateChangeListener {
            aiConfigSection.isVisible = providerSelector.getProvider() == "anthropic"
            pack()
        }

        return JPanel(BorderLayout()).apply {
            add(panel, BorderLayout.NORTH)
            preferredSize = Dimension(560, preferredSize.height)
        }
    }

    override fun doValidate(): ValidationInfo? {
        providerSelector.validateInput()?.let { return it }

        val maxTokensText = maxTokensField.text.trim()
        if (maxTokensText.isNotBlank()) {
            val parsed = maxTokensText.toIntOrNull()
            if (parsed == null || parsed < 1) {
                return ValidationInfo("Max Tokens must be a positive integer", maxTokensField)
            }
        }

        if (!claudeEnabledCheckbox.isSelected && !codexEnabledCheckbox.isSelected &&
            !geminiEnabledCheckbox.isSelected
        ) {
            return ValidationInfo("At least one platform must be enabled", claudeEnabledCheckbox)
        }

        return null
    }

    override fun doOKAction() {
        val provider = providerSelector.getProvider()
        val resolvedApiKey = providerSelector.getEffectiveAnthropicKey()

        val maxTokensText = maxTokensField.text.trim()
        val maxTokens = if (maxTokensText.isNotBlank()) maxTokensText.toIntOrNull() else null

        val excludePatterns = excludePatternsField.text
            .split(",")
            .map { it.trim() }
            .filter { it.isNotEmpty() }

        val kbPath = kbPathField.text.trim()
        val kbSort = kbSortCombo.selectedItem as String

        val configDir = SessionTracker.getGlobalConfigDir()
        val existing = SessionTracker.loadConfigFromDir(configDir)
        val config = existing.copy(
            apiKey = resolvedApiKey.ifBlank { null },
            model = (modelCombo.selectedItem as String).let { if (it == "sonnet") null else it },
            maxTokens = maxTokens,
            claudeEnabled = claudeEnabledCheckbox.isSelected,
            codexEnabled = codexEnabledCheckbox.isSelected,
            geminiEnabled = geminiEnabledCheckbox.isSelected,
            excludePatterns = if (excludePatterns.isNotEmpty()) excludePatterns else null,
            aiProvider = provider,
            knowledgeBasePath = kbPath.ifBlank { null },
            knowledgeBaseSort = kbSort,
        )
        SessionTracker.saveConfigToDir(config, configDir)

        // Initialize KB folder + auto-migrate data from orphan branch
        val projectPath = service.mainRepoRoot ?: project.basePath
        if (projectPath != null) {
            val repoName = KBPathResolver.extractRepoName(projectPath)
            val remoteUrl = KBPathResolver.getRemoteUrl(projectPath)
            val kbRoot = KBPathResolver.resolve(repoName, remoteUrl, config.knowledgeBasePath)
            KBPathResolver.initializeKBFolder(kbRoot, repoName, remoteUrl)

            // Auto-migrate if orphan branch has data
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

    /** Loads settings from the global config directory and populates the form. */
    private fun loadSettings() {
        val configDir = SessionTracker.getGlobalConfigDir()
        val config = SessionTracker.loadConfigFromDir(configDir)
        populateFields(config)
    }

    /** Fills all form fields from a config object. */
    private fun populateFields(config: JolliMemoryConfig) {
        providerSelector.loadFromConfig(config)
        modelCombo.selectedItem = config.model ?: "sonnet"
        maxTokensField.text = if (config.maxTokens != null) config.maxTokens.toString() else ""
        excludePatternsField.text = config.excludePatterns?.joinToString(", ") ?: ""

        claudeEnabledCheckbox.isSelected = config.claudeEnabled != false
        codexEnabledCheckbox.isSelected = config.codexEnabled != false
        geminiEnabledCheckbox.isSelected = config.geminiEnabled != false

        // Apply current visibility for AI Configuration section.
        aiConfigSection.isVisible = providerSelector.getProvider() == "anthropic"

        // KB fields — compute default path for placeholder
        val projectPath = service.mainRepoRoot ?: project.basePath ?: ""
        if (projectPath.isNotBlank()) {
            val repoName = KBPathResolver.extractRepoName(projectPath)
            val remoteUrl = KBPathResolver.getRemoteUrl(projectPath)
            defaultKBPath = KBPathResolver.resolve(repoName, remoteUrl).toString()
        }
        kbPathField.text = config.knowledgeBasePath ?: ""
        (kbPathField.textField as? JBTextField)?.emptyText?.setText(
            if (defaultKBPath.isNotBlank()) defaultKBPath else "~/Documents/jolli/"
        )
        kbSortCombo.selectedItem = config.knowledgeBaseSort ?: "date"
    }

    /** Creates a bold section header label. */
    private fun createSectionHeader(text: String): JComponent {
        return JBLabel(text).apply {
            font = font.deriveFont(java.awt.Font.BOLD, font.size + 1f)
            border = JBUI.Borders.emptyBottom(4)
            alignmentX = JComponent.LEFT_ALIGNMENT
        }
    }

    /** Wraps a form panel so it stretches to fill the full dialog width. */
    private fun createStretchedFormPanel(formPanel: JPanel): JComponent {
        return JPanel(BorderLayout()).apply {
            add(formPanel, BorderLayout.CENTER)
            alignmentX = JComponent.LEFT_ALIGNMENT
            maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
        }
    }

    /** Creates the "Migrate to Knowledge Base" button. */
    private fun createMigrateButton(): JComponent {
        return JButton("Migrate to Knowledge Base").apply {
            toolTipText = "Migrate existing memories from git storage to the Knowledge Base folder"
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
                    text = "Migrate to Knowledge Base"
                }
            }
        }
    }

    /** Creates a horizontal separator line. */
    private fun createSeparator(): JComponent {
        return JSeparator().apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            maximumSize = Dimension(Int.MAX_VALUE, 1)
        }
    }
}
