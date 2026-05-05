package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.JolliMemoryConfig
import ai.jolli.jollimemory.services.JolliAuthService
import com.intellij.openapi.Disposable
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.openapi.util.Disposer
import com.intellij.ui.DocumentAdapter
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPasswordField
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import java.awt.CardLayout
import java.awt.Dimension
import java.awt.event.ItemEvent
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultComboBoxModel
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingUtilities
import javax.swing.event.DocumentEvent

/**
 * Self-contained "AI summarization provider" picker shared between the settings
 * dialog and the tool window.
 *
 * Owns:
 *   - Provider dropdown ("(Select a provider)" / Jolli / Anthropic)
 *   - Conditional Anthropic API key field (shown only under Anthropic)
 *   - Inline warning text reflecting the current invalid state, if any
 *   - JolliAuthService listener that auto-switches None → Jolli when the user signs in
 *   - DocumentListener on the Anthropic field that fires state changes on each keystroke
 *   - Masked-key display + change detection for the Anthropic field
 *
 * Does NOT persist config — callers read state via [getProvider] and
 * [getEffectiveAnthropicKey] and write to disk on their own schedule (Apply
 * button, immediate save, etc).
 *
 * Use [addStateChangeListener] to react when the configuration validity transitions
 * (selection change, auth change, key field edit). Toolwindow callers can use
 * [isFullyConfigured] to decide whether to show or hide the section.
 */
class AiProviderSelector : JPanel(), Disposable {

    private val providerCombo = ComboBox(
        DefaultComboBoxModel(arrayOf(PROVIDER_NONE, PROVIDER_JOLLI, PROVIDER_ANTHROPIC))
    ).apply {
        maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
    }
    private val anthropicKeyField = JBPasswordField()
    private val cardLayout = CardLayout()
    private val cardPanel = JPanel(cardLayout)
    private val warningLabel = JBLabel().apply {
        border = JBUI.Borders.empty(4, 0)
        isVisible = false
    }

    private val stateListeners = mutableListOf<() -> Unit>()
    private val authListenerDisposable: Disposable

    /** Full (unmasked) saved Anthropic key — used to detect "value unchanged from masked display". */
    private var savedAnthropicKey: String = ""
    private var maskedAnthropicKey: String = ""

    /** Suppresses listener fanout while the component is updating its own selection. */
    private var suppressEvents: Boolean = false

    init {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
        alignmentX = LEFT_ALIGNMENT

        cardPanel.add(buildAnthropicCard(), CARD_ANTHROPIC)
        cardPanel.add(JPanel(), CARD_EMPTY)

        add(FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("AI summarization provider:"), providerCombo, 1, false)
            .addComponent(cardPanel)
            .panel)
        add(warningLabel)
        add(Box.createVerticalStrut(2))

        providerCombo.addItemListener { event ->
            if (event.stateChange == ItemEvent.SELECTED && !suppressEvents) {
                applySelection(event.item as String)
                fireStateChanged()
            }
        }

        anthropicKeyField.document.addDocumentListener(object : DocumentAdapter() {
            override fun textChanged(e: DocumentEvent) {
                if (!suppressEvents) {
                    refreshWarning()
                    fireStateChanged()
                }
            }
        })

        // Auto-switch to Jolli on sign-in if currently None; always refresh warning + fire state on any auth change.
        authListenerDisposable = JolliAuthService.addAuthListener {
            SwingUtilities.invokeLater {
                if (JolliAuthService.isSignedIn() && providerCombo.selectedItem == PROVIDER_NONE) {
                    setSelection(PROVIDER_JOLLI)
                }
                refreshWarning()
                fireStateChanged()
            }
        }
    }

    /**
     * Loads the saved provider + Anthropic key from config and selects the appropriate
     * dropdown item.
     *
     * Selection precedence:
     *   1. config.aiProvider, if set (honor the user's prior choice even if creds went stale)
     *   2. Jolli, if currently signed in
     *   3. Anthropic, if an Anthropic key is saved
     *   4. None (cold-start, shows the warning)
     */
    fun loadFromConfig(config: JolliMemoryConfig) {
        suppressEvents = true
        try {
            savedAnthropicKey = config.apiKey ?: ""
            maskedAnthropicKey = maskApiKey(savedAnthropicKey)
            anthropicKeyField.text = maskedAnthropicKey
        } finally {
            suppressEvents = false
        }

        val resolvedProvider = when (config.aiProvider?.lowercase()) {
            "jolli" -> PROVIDER_JOLLI
            "anthropic" -> PROVIDER_ANTHROPIC
            else -> when {
                JolliAuthService.isSignedIn() -> PROVIDER_JOLLI
                savedAnthropicKey.isNotBlank() -> PROVIDER_ANTHROPIC
                else -> PROVIDER_NONE
            }
        }
        setSelection(resolvedProvider)
    }

    /**
     * Returns the canonical lowercase provider key suitable for persistence,
     * or null if no provider is selected (callers should treat this as "do not save yet").
     */
    fun getProvider(): String? = when (providerCombo.selectedItem as String) {
        PROVIDER_JOLLI -> "jolli"
        PROVIDER_ANTHROPIC -> "anthropic"
        else -> null
    }

    /**
     * Returns the Anthropic key as it should be persisted: the saved value if the field
     * still shows the masked display, otherwise whatever the user typed.
     */
    fun getEffectiveAnthropicKey(): String {
        val typed = String(anthropicKeyField.password)
        return if (typed == maskedAnthropicKey) savedAnthropicKey else typed
    }

    /**
     * Validates the current selection. Returns a ValidationInfo bound to the offending
     * component, or null if everything is valid.
     */
    fun validateInput(): ValidationInfo? {
        when (providerCombo.selectedItem as String) {
            PROVIDER_NONE -> return ValidationInfo(WARNING_NONE, providerCombo)
            PROVIDER_JOLLI -> {
                if (!JolliAuthService.isSignedIn()) {
                    return ValidationInfo(WARNING_JOLLI_SIGNED_OUT, providerCombo)
                }
            }
            PROVIDER_ANTHROPIC -> {
                val resolved = getEffectiveAnthropicKey()
                if (resolved.isBlank()) {
                    return ValidationInfo(WARNING_ANTHROPIC_BLANK, anthropicKeyField)
                }
                val typed = String(anthropicKeyField.password)
                if (typed.isNotBlank() && typed != maskedAnthropicKey && !typed.startsWith("sk-ant-")) {
                    return ValidationInfo(WARNING_ANTHROPIC_PREFIX, anthropicKeyField)
                }
            }
        }
        return null
    }

    /** Returns true when the current selection has all credentials it needs. */
    fun isFullyConfigured(): Boolean = validateInput() == null

    /**
     * Subscribes to state changes. Listener fires whenever any input affecting validity
     * changes: dropdown selection, auth status, or Anthropic key field text.
     */
    fun addStateChangeListener(listener: () -> Unit) {
        stateListeners.add(listener)
    }

    private fun setSelection(item: String) {
        suppressEvents = true
        try {
            providerCombo.selectedItem = item
        } finally {
            suppressEvents = false
        }
        applySelection(item)
    }

    private fun applySelection(item: String) {
        when (item) {
            PROVIDER_ANTHROPIC -> {
                cardLayout.show(cardPanel, CARD_ANTHROPIC)
                cardPanel.isVisible = true
            }
            PROVIDER_JOLLI, PROVIDER_NONE -> {
                cardLayout.show(cardPanel, CARD_EMPTY)
                cardPanel.isVisible = false
            }
        }
        refreshWarning()
        revalidate()
        repaint()
    }

    /** Sets the warning label text + visibility from the current validateInput() result. */
    private fun refreshWarning() {
        val info = validateInput()
        if (info == null) {
            warningLabel.isVisible = false
            warningLabel.text = ""
        } else {
            warningLabel.text = "<html><span style='color:#c0392b'>${info.message}</span></html>"
            warningLabel.isVisible = true
        }
    }

    private fun fireStateChanged() {
        stateListeners.forEach { it() }
    }

    private fun buildAnthropicCard(): JComponent {
        return FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Anthropic API Key:"), anthropicKeyField, 1, false)
            .addTooltip("sk-ant-... — get yours at console.anthropic.com")
            .panel
    }

    override fun dispose() {
        Disposer.dispose(authListenerDisposable)
    }

    companion object {
        const val PROVIDER_NONE = "(Select a provider)"
        const val PROVIDER_JOLLI = "Jolli"
        const val PROVIDER_ANTHROPIC = "Anthropic"
        private const val CARD_ANTHROPIC = "card.anthropic"
        private const val CARD_EMPTY = "card.empty"

        private const val WARNING_NONE = "Select your AI summarization provider to use Jolli Memory"
        private const val WARNING_JOLLI_SIGNED_OUT = "Must be signed into Jolli"
        private const val WARNING_ANTHROPIC_BLANK = "Enter your Anthropic API key"
        private const val WARNING_ANTHROPIC_PREFIX = "Anthropic API Key should start with sk-ant-"

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
