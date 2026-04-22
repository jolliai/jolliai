package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.JolliMemoryConfig
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPasswordField
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultComboBoxModel
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JSeparator
import com.intellij.openapi.ui.ComboBox

/**
 * Full settings dialog matching the VS Code Jolli Memory Settings webview.
 *
 * Sections:
 *   1. AI Configuration — Anthropic API Key, Model, Max Tokens
 *   2. Integrations — Jolli API Key, Claude/Codex/Gemini toggles
 *   3. Files — Exclude Patterns
 *
 * Reads config from the global config directory and writes back on OK.
 */
class SettingsDialog(
    private val project: Project,
    private val service: JolliMemoryService,
) : DialogWrapper(project) {

    // ── AI Configuration ───────────────────────────────────────────────────
    private val apiKeyField = JBPasswordField()
    private val modelCombo = ComboBox(DefaultComboBoxModel(arrayOf("haiku", "sonnet", "opus"))).apply {
        maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
    }
    private val maxTokensField = JBTextField()

    // ── Integrations ───────────────────────────────────────────────────────
    private val jolliApiKeyField = JBPasswordField()
    private val claudeEnabledCheckbox = JBCheckBox("Claude Code — Session tracking via Stop hook", true)
    private val codexEnabledCheckbox = JBCheckBox("Codex CLI — Session discovery via filesystem scan", true)
    private val geminiEnabledCheckbox = JBCheckBox("Gemini CLI — Session tracking via AfterAgent hook", true)

    // ── Files ──────────────────────────────────────────────────────────────
    private val excludePatternsField = JBTextField()

    /** Full (unmasked) API keys loaded from config — used to detect unchanged masked values. */
    private var fullApiKey: String = ""
    private var fullJolliApiKey: String = ""
    private var maskedApiKey: String = ""
    private var maskedJolliApiKey: String = ""

    init {
        title = "Jolli Memory Settings"
        setOKButtonText("Apply Changes")
        init()
        loadSettings()
    }

    override fun createCenterPanel(): JComponent {
        val panel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(8, 12)
        }

        // ── AI Configuration Section ───────────────────────────────────────
        panel.add(createSectionHeader("AI Configuration"))
        panel.add(createStretchedFormPanel(FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Anthropic API Key:"), apiKeyField, 1, false)
            .addTooltip("sk-ant-... — get yours at console.anthropic.com")
            .addLabeledComponent(JBLabel("Model:"), modelCombo, 1, false)
            .addTooltip("Haiku = fastest, Sonnet = balanced (default), Opus = most capable")
            .addLabeledComponent(JBLabel("Max Tokens:"), maxTokensField, 1, false)
            .addTooltip("Default: 8192")
            .panel))
        panel.add(Box.createVerticalStrut(12))
        panel.add(createSeparator())
        panel.add(Box.createVerticalStrut(12))

        // ── Integrations Section ───────────────────────────────────────────
        panel.add(createSectionHeader("Integrations"))
        panel.add(createStretchedFormPanel(FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Jolli API Key:"), jolliApiKeyField, 1, false)
            .addTooltip("sk-jol-... — for pushing memories to Jolli Space")
            .addComponent(claudeEnabledCheckbox, 8)
            .addComponent(codexEnabledCheckbox, 4)
            .addComponent(geminiEnabledCheckbox, 4)
            .panel))
        panel.add(Box.createVerticalStrut(12))
        panel.add(createSeparator())
        panel.add(Box.createVerticalStrut(12))

        // ── Files Section ──────────────────────────────────────────────────
        panel.add(createSectionHeader("Files"))
        panel.add(createStretchedFormPanel(FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Exclude Patterns:"), excludePatternsField, 1, false)
            .addTooltip("Comma-separated globs, e.g. **/*.vsix, docs/*.md")
            .panel))

        return JPanel(BorderLayout()).apply {
            add(panel, BorderLayout.NORTH)
            preferredSize = Dimension(520, preferredSize.height)
        }
    }

    override fun doValidate(): ValidationInfo? {
        val apiKeyText = String(apiKeyField.password)
        if (apiKeyText.isNotBlank() && apiKeyText != maskedApiKey &&
            !apiKeyText.startsWith("sk-ant-")
        ) {
            return ValidationInfo("Anthropic API Key should start with sk-ant-", apiKeyField)
        }

        val jolliKeyText = String(jolliApiKeyField.password)
        if (jolliKeyText.isNotBlank() && jolliKeyText != maskedJolliApiKey &&
            !jolliKeyText.startsWith("sk-jol-")
        ) {
            return ValidationInfo("Jolli API Key should start with sk-jol-", jolliApiKeyField)
        }

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
            return ValidationInfo("At least one integration must be enabled", claudeEnabledCheckbox)
        }

        return null
    }

    override fun doOKAction() {
        // Resolve API keys: if value matches the masked string, keep the original
        val apiKeyText = String(apiKeyField.password)
        val resolvedApiKey = if (apiKeyText == maskedApiKey) fullApiKey else apiKeyText

        val jolliKeyText = String(jolliApiKeyField.password)
        val resolvedJolliApiKey = if (jolliKeyText == maskedJolliApiKey) fullJolliApiKey else jolliKeyText

        val maxTokensText = maxTokensField.text.trim()
        val maxTokens = if (maxTokensText.isNotBlank()) maxTokensText.toIntOrNull() else null

        val excludePatterns = excludePatternsField.text
            .split(",")
            .map { it.trim() }
            .filter { it.isNotEmpty() }

        // Always save to global config directory, preserving fields not managed by this dialog
        val configDir = SessionTracker.getGlobalConfigDir()
        val existing = SessionTracker.loadConfigFromDir(configDir)
        val config = existing.copy(
            apiKey = resolvedApiKey.ifBlank { null },
            model = (modelCombo.selectedItem as String).let { if (it == "sonnet") null else it },
            maxTokens = maxTokens,
            jolliApiKey = resolvedJolliApiKey.ifBlank { null },
            claudeEnabled = claudeEnabledCheckbox.isSelected,
            codexEnabled = codexEnabledCheckbox.isSelected,
            geminiEnabled = geminiEnabledCheckbox.isSelected,
            excludePatterns = if (excludePatterns.isNotEmpty()) excludePatterns else null,
        )
        SessionTracker.saveConfigToDir(config, configDir)

        super.doOKAction()
    }

    /** Loads settings from the global config directory and populates the form. */
    private fun loadSettings() {
        val configDir = SessionTracker.getGlobalConfigDir()
        val config = SessionTracker.loadConfigFromDir(configDir)
        populateFields(config)
    }

    /** Fills all form fields from a config object, masking API keys. */
    private fun populateFields(config: JolliMemoryConfig) {
        fullApiKey = config.apiKey ?: ""
        fullJolliApiKey = config.jolliApiKey ?: ""
        maskedApiKey = maskApiKey(fullApiKey)
        maskedJolliApiKey = maskApiKey(fullJolliApiKey)

        apiKeyField.text = maskedApiKey
        modelCombo.selectedItem = config.model ?: "sonnet"
        maxTokensField.text = if (config.maxTokens != null) config.maxTokens.toString() else ""

        jolliApiKeyField.text = maskedJolliApiKey
        claudeEnabledCheckbox.isSelected = config.claudeEnabled != false
        codexEnabledCheckbox.isSelected = config.codexEnabled != false
        geminiEnabledCheckbox.isSelected = config.geminiEnabled != false

        excludePatternsField.text = config.excludePatterns?.joinToString(", ") ?: ""
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

    /** Creates a horizontal separator line. */
    private fun createSeparator(): JComponent {
        return JSeparator().apply {
            alignmentX = JComponent.LEFT_ALIGNMENT
            maximumSize = Dimension(Int.MAX_VALUE, 1)
        }
    }

    companion object {
        /**
         * Masks an API key for display.
         * Keys with a recognized prefix (sk-ant-, sk-jol-) are always masked.
         * Other keys are masked when longer than 16 chars: first 12 + **** + last 4.
         */
        fun maskApiKey(key: String): String {
            if (key.isEmpty()) return ""
            val hasKnownPrefix = key.startsWith("sk-ant-") || key.startsWith("sk-jol-")
            if (!hasKnownPrefix && key.length <= 16) return key
            val prefixLen = minOf(12, key.length - 4)
            return "${key.substring(0, prefixLen)}****${key.substring(key.length - 4)}"
        }
    }
}
