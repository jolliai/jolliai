package ai.jolli.jollimemory.settings

import ai.jolli.jollimemory.core.JolliMemoryConfig
import ai.jolli.jollimemory.core.SessionTracker
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPasswordField
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

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

    private var savedApiKey: String? = null
    private var savedModel: String? = null
    private var savedJolliApiKey: String? = null

    override fun getDisplayName(): String = "Jolli Memory"

    override fun createComponent(): JComponent {
        apiKeyField = JBPasswordField()
        modelField = JBTextField()
        jolliApiKeyField = JBPasswordField()

        // Load current values
        loadFromConfig()

        return FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Anthropic API Key:"), apiKeyField!!, 1, false)
            .addTooltip("Required for AI commit summaries. Get yours at console.anthropic.com")
            .addLabeledComponent(JBLabel("Model:"), modelField!!, 1, false)
            .addTooltip("Alias (haiku, sonnet, opus) or full model ID. Default: sonnet")
            .addSeparator()
            .addLabeledComponent(JBLabel("Jolli API Key:"), jolliApiKeyField!!, 1, false)
            .addTooltip("For pushing summaries to Jolli Space (sk-jol-...)")
            .addComponentFillVertically(JPanel(), 0)
            .panel
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

        val update = JolliMemoryConfig(
            apiKey = apiKey,
            model = model,
            jolliApiKey = jolliApiKey,
        )
        SessionTracker.saveConfig(update, cwd)

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
