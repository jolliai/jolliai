package ai.jolli.jollimemory.toolwindow

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test
import java.awt.Container
import javax.swing.JButton

/**
 * Behavioural tests for [DisabledPanel] — the "Get started with Jolli Memory"
 * card shown when the user has explicitly turned Jolli off. The card is
 * stateless; we assert it exposes exactly one Enable button and that clicking it
 * fires the [onEnable] callback the factory passes in (that callback drives the
 * optimistic UI flip + off-EDT install).
 */
class DisabledPanelTest {

    /** Recursively finds the first JButton in the container tree. */
    private fun findButton(root: Container): JButton? {
        for (c in root.components) {
            if (c is JButton) return c
            if (c is Container) findButton(c)?.let { return it }
        }
        return null
    }

    @Test
    fun `panel exposes an Enable button that fires the onEnable callback`() {
        var fired = 0
        val panel = DisabledPanel(onEnable = { fired++ })
        val button = checkNotNull(findButton(panel)) { "DisabledPanel must expose an Enable button" }
        button.text shouldBe "Enable Jolli Memory"
        button.doClick()
        fired shouldBe 1
    }

    @Test
    fun `enable button reuses the same callback on repeated clicks`() {
        var fired = 0
        val panel = DisabledPanel(onEnable = { fired++ })
        val button = checkNotNull(findButton(panel))
        button.doClick()
        button.doClick()
        button.doClick()
        fired shouldBe 3
    }
}
