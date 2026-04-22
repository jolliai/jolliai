package ai.jolli.jollimemory.settings

import ai.jolli.jollimemory.core.JolliMemoryConfig
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliAuthService
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPasswordField
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingUtilities

/**
 * Settings page for JolliMemory — IntelliJ Preferences > Tools > JolliMemory.
 *
 * Reads/writes to .jolli/jollimemory/config.json (same file used by hooks).
 *
 * Settings:
 *   - Anthropic API Key (for AI summary generation)
 *   - Model (alias: haiku, sonnet, opus; or full model ID)
 *   - Jolli API Key (for Push to Jolli feature)
 */
class JolliMemoryConfigurable(private val project: Project) : Configurable {

    private var apiKeyField: JBPasswordField? = null
    private var modelField: JBTextField? = null
    private var jolliApiKeyField: JBPasswordField? = null
    private var jolliApiKeyLabel: JBLabel? = null
    private var accountStatusLabel: JBLabel? = null
    private var accountButton: JButton? = null

    private var savedApiKey: String? = null
    private var savedModel: String? = null
    private var savedJolliApiKey: String? = null

    override fun getDisplayName(): String = "Jolli Memory"

    override fun createComponent(): JComponent {
        apiKeyField = JBPasswordField()
        modelField = JBTextField()
        jolliApiKeyField = JBPasswordField()
        jolliApiKeyLabel = JBLabel("Jolli API Key:")
        accountStatusLabel = JBLabel()
        accountButton = JButton()

        // Load current values first so updateAccountUI can check the API key field
        loadFromConfig()
        updateAccountUI()

        val privacyNotice = JBLabel(
            "<html>By providing an API key, you consent to sending code diffs and AI session " +
            "transcripts to third-party AI providers (e.g., Anthropic). " +
            "<a href=\"https://github.com/Jolli-sample-repos/privacy/blob/main/privacy.md\">Privacy Policy</a></html>"
        ).apply {
            setCopyable(true)
        }

        return FormBuilder.createFormBuilder()
            .addComponent(privacyNotice)
            .addSeparator()
            .addLabeledComponent(JBLabel("Account:"), accountPanel(), 1, false)
            .addTooltip("Sign in with your Jolli account for Personal Space sync")
            .addSeparator()
            .addLabeledComponent(JBLabel("Anthropic API Key:"), apiKeyField!!, 1, false)
            .addTooltip("Required for AI commit summaries. Get yours at console.anthropic.com")
            .addLabeledComponent(JBLabel("Model:"), modelField!!, 1, false)
            .addTooltip("Alias (haiku, sonnet, opus) or full model ID. Default: sonnet")
            .addSeparator()
            .addLabeledComponent(jolliApiKeyLabel!!, jolliApiKeyField!!, 1, false)
            .addTooltip("For pushing summaries to Jolli Space (sk-jol-...). Fallback if not signed in.")
            .addComponentFillVertically(JPanel(), 0)
            .panel
    }

    private fun accountPanel(): JPanel {
        return JPanel(java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 4, 0)).apply {
            add(accountStatusLabel)
            add(accountButton)
        }
    }

    private fun updateAccountUI() {
        if (JolliAuthService.isSignedIn()) {
            accountStatusLabel?.text = "Signed in"
            accountButton?.text = "Sign Out"
            accountButton?.actionListeners?.forEach { accountButton?.removeActionListener(it) }
            accountButton?.addActionListener {
                JolliAuthService.signOut()
                updateAccountUI()
            }
            jolliApiKeyLabel?.text = "Jolli API Key (optional — auto-managed via account):"
            jolliApiKeyField?.toolTipText = "Optional. Your account key is used automatically. Enter a manual key here to override it."
        } else {
            accountStatusLabel?.text = "Not signed in"
            accountButton?.text = "Sign In"
            accountButton?.actionListeners?.forEach { accountButton?.removeActionListener(it) }
            accountButton?.addActionListener {
                accountButton?.isEnabled = false
                accountButton?.text = "Signing in..."
                JolliAuthService.login(
                    onSuccess = { _ ->
                        SwingUtilities.invokeLater {
                            loadFromConfig()
                            updateAccountUI()
                        }
                    },
                    onError = { msg ->
                        SwingUtilities.invokeLater {
                            updateAccountUI()
                            com.intellij.openapi.ui.Messages.showErrorDialog(msg, "Jolli Sign In")
                        }
                    },
                )
            }
            jolliApiKeyLabel?.text = "Jolli API Key:"
            jolliApiKeyField?.toolTipText = null
        }
    }

    override fun isModified(): Boolean {
        return getApiKeyFieldText() != (savedApiKey ?: "") ||
            (modelField?.text ?: "") != (savedModel ?: "") ||
            getJolliApiKeyFieldText() != (savedJolliApiKey ?: "")
    }

    override fun apply() {
        val cwd = project.getService(ai.jolli.jollimemory.services.JolliMemoryService::class.java).mainRepoRoot ?: project.basePath ?: return
        val apiKey = getApiKeyFieldText().ifBlank { null }
        val model = modelField?.text?.trim()?.ifBlank { null }
        val jolliApiKey = getJolliApiKeyFieldText().ifBlank { null }

        val globalDir = SessionTracker.getGlobalConfigDir()
        val existing = SessionTracker.loadConfigFromDir(globalDir)
        val merged = existing.copy(
            apiKey = apiKey,
            model = model,
            jolliApiKey = jolliApiKey,
        )
        SessionTracker.saveConfigToDir(merged, globalDir)

        // Update saved values
        savedApiKey = apiKey ?: ""
        savedModel = model ?: ""
        savedJolliApiKey = jolliApiKey ?: ""
    }

    override fun reset() {
        loadFromConfig()
    }

    private fun loadFromConfig() {
        val cwd = project.getService(ai.jolli.jollimemory.services.JolliMemoryService::class.java).mainRepoRoot ?: project.basePath ?: return
        val config = SessionTracker.loadConfig(cwd)

        savedApiKey = config.apiKey ?: ""
        savedModel = config.model ?: ""
        savedJolliApiKey = config.jolliApiKey ?: ""

        apiKeyField?.text = savedApiKey
        modelField?.text = savedModel
        jolliApiKeyField?.text = savedJolliApiKey
    }

    private fun getApiKeyFieldText(): String {
        return String(apiKeyField?.password ?: charArrayOf())
    }

    private fun getJolliApiKeyFieldText(): String {
        return String(jolliApiKeyField?.password ?: charArrayOf())
    }
}
