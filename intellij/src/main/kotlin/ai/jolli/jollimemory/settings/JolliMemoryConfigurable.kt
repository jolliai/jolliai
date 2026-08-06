package ai.jolli.jollimemory.settings

import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.toolwindow.SettingsDialog
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.FlowLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * IntelliJ **Preferences → Tools → Jolli Memory** entry.
 *
 * This page used to be a second full settings form. It is now a discovery bridge
 * only — it keeps the "Jolli Memory" name findable from Search Everywhere (`⇧⇧`)
 * and from Preferences → Tools, and offers a single button that opens the real
 * dialog. Every field it used to carry now lives in the tool window's
 * [SettingsDialog] (title-bar gear icon) — with ONE deliberate exception.
 *
 * **`slack.workspaceUrl` was dropped, not moved.** It has no field in
 * [SettingsDialog] and no equivalent in the VS Code settings UI either, so it is
 * now configurable only via `jolli configure --set slack.workspaceUrl=<origin>`.
 * The value itself is still live and still read by the CLI
 * (`ReferenceExtractor` → `ClaudeEnvelopeParser` / `CodexSlackBinding`), where it
 * reconstructs a thread permalink for a Slack reference whose transcript never
 * had one pasted in; without it such a reference has no URL and
 * `slackDefinition` voids it rather than storing something un-clickable. An
 * already-configured value survives a [SettingsDialog] save untouched, because
 * that save is an `existing.copy(...)` that never names the `slack` field. Do not
 * "restore" this docstring to a blanket "every editable field lives in
 * SettingsDialog" claim — that was the wording that made the removal look like a
 * de-duplication.
 *
 * Kept intentionally stateless: `isModified()` always returns false and `apply()`
 * is a no-op, so IntelliJ's OK/Apply buttons on the Preferences dialog never do
 * anything of their own — the *real* Save happens inside [SettingsDialog].
 */
class JolliMemoryConfigurable(private val project: Project) : Configurable {

    override fun getDisplayName(): String = "Jolli Memory"

    override fun createComponent(): JComponent {
        val panel = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(12)
        }

        val message = JBLabel(
            "<html>Jolli Memory settings live in the tool window. " +
                "Use the button below (or click the gear icon in the Jolli Memory " +
                "tool window's header) to open the full settings dialog.</html>",
        ).apply {
            border = JBUI.Borders.emptyBottom(12)
        }

        val openButton = JButton("Open Jolli Memory settings…").apply {
            addActionListener {
                val service = project.getService(JolliMemoryService::class.java)
                SettingsDialog(project, service).show()
            }
        }

        val buttonRow = JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply {
            add(openButton)
        }

        panel.add(message, BorderLayout.NORTH)
        panel.add(buttonRow, BorderLayout.CENTER)
        return panel
    }

    override fun isModified(): Boolean = false

    override fun apply() {
        // No-op: nothing on this page persists directly. All state changes flow
        // through [SettingsDialog] and are applied when the user clicks OK there.
    }
}
