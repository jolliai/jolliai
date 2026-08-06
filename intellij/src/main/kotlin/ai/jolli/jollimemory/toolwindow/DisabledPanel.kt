package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Component
import java.awt.FlowLayout
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JPanel

/**
 * Panel shown when the user has explicitly turned Jolli Memory off (spec 306's
 * `manuallyDisabled` opt-out). Mirrors VS Code's `.disabled-panel` in
 * `SidebarHtmlBuilder.ts` — a stripped-down "Get started" page with just a
 * title, subtitle, and Enable button. Deliberately distinct from
 * [OnboardingPanel]: this appears when the user has creds but chose to
 * disable, so the multi-option "Choose how you'd like to set it up" card
 * would just re-ask a question they've already answered.
 *
 * The [onEnable] callback fires when the user clicks Enable. The panel
 * itself is stateless — the factory owns the flag / installer sequencing
 * and hides this card on success.
 */
class DisabledPanel(
    private val onEnable: () -> Unit,
) : JPanel(BorderLayout()) {

    init {
        border = JBUI.Borders.empty(16, 16)

        val content = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            alignmentX = LEFT_ALIGNMENT
        }

        // Header row: sparkle icon + bold title
        content.add(JPanel(FlowLayout(FlowLayout.LEFT, 6, 0)).apply {
            alignmentX = LEFT_ALIGNMENT
            add(JBLabel(JolliMemoryIcons.Sparkle))
            add(JBLabel("Get started with Jolli Memory").apply {
                font = JBUI.Fonts.label(14f).asBold()
            })
        })
        content.add(Box.createVerticalStrut(6))

        // Subtitle — verbatim copy from VS Code's `.disabled-panel` so the two
        // surfaces read identically. Change only in lockstep with
        // `SidebarHtmlBuilder.ts` (search: "Enable Jolli Memory to get started").
        content.add(JBLabel(
            "<html><span style='color:gray'>Jolli Memory automatically captures your work context " +
                "and surfaces relevant memories as you code. Enable Jolli Memory to get started.</span></html>",
        ).apply {
            alignmentX = LEFT_ALIGNMENT
        })

        content.add(Box.createVerticalStrut(16))

        content.add(JButton("Enable Jolli Memory").apply {
            alignmentX = Component.LEFT_ALIGNMENT
            addActionListener { onEnable() }
        })

        add(content, BorderLayout.NORTH)
    }
}
