package ai.jolli.jollimemory

import com.intellij.util.ui.JBUI
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test
import java.awt.Color
import java.awt.Graphics2D
import java.awt.image.BufferedImage
import javax.swing.Icon

/**
 * Verifies [PulseStatusIcon] paints the health dot at the pixel the design mockup
 * pins it to. Regression guards:
 *   - iconWidth/iconHeight forward to the body icon (title-bar layout depends on
 *     these matching what the platform allocates)
 *   - the dot ends up in the bottom-right corner painted with the requested color
 *
 * Uses a synthetic transparent body icon so the assertion doesn't depend on the
 * real pulse SVG's rendered pixels — the composite formula (body + dot) is what
 * matters, not the body itself.
 */
class PulseStatusIconTest {

    private class BlankIcon(private val w: Int, private val h: Int) : Icon {
        override fun getIconWidth(): Int = w
        override fun getIconHeight(): Int = h
        override fun paintIcon(c: java.awt.Component?, g: java.awt.Graphics, x: Int, y: Int) {
            // Deliberately paints nothing so [PulseStatusIconTest] observes the DOT
            // color in isolation without the body's own pixels leaking in.
        }
    }

    /**
     * A 16x16 body at the JVM's current IDE scale — the size the real IconLoader SVG
     * body reports. Scaling the stand-in too keeps the body and the dot in the same
     * coordinate space, so the geometry assertions below stay in-bounds and meaningful
     * at whatever scale the test JVM happens to report.
     */
    private fun scaledBody(): BlankIcon = BlankIcon(JBUI.scale(16), JBUI.scale(16))

    private fun paintToImage(icon: Icon): BufferedImage {
        val img = BufferedImage(icon.iconWidth, icon.iconHeight, BufferedImage.TYPE_INT_ARGB)
        val g = img.createGraphics() as Graphics2D
        try {
            icon.paintIcon(null, g, 0, 0)
        } finally {
            g.dispose()
        }
        return img
    }

    @Test
    fun `iconWidth and iconHeight forward to the body icon`() {
        val icon = PulseStatusIcon(BlankIcon(16, 16), Color.RED)
        icon.iconWidth shouldBe 16
        icon.iconHeight shouldBe 16
    }

    @Test
    fun `dot paints in the bottom-right corner with the requested color`() {
        val body = scaledBody()
        val expected = Color(0x3F, 0xB9, 0x50) // matches PulseStatusGreen
        val img = paintToImage(PulseStatusIcon(body, expected))

        // Derive the sample point from the SCALED constants rather than hard-coding
        // `width - 3`. The dot is sized with JBUI.scale because the real body icon is
        // an IconLoader SVG that grows with the IDE scale; reproducing the production
        // formula here keeps this assertion pointed at the ellipse's center on a
        // non-1.0-scale JVM instead of at a pixel outside it.
        val dotSize = JBUI.scale(PulseStatusIcon.DOT_SIZE)
        val nudge = JBUI.scale(PulseStatusIcon.DOT_NUDGE)
        val cx = img.width - dotSize + nudge + dotSize / 2
        val cy = img.height - dotSize + nudge + dotSize / 2
        val sampled = Color(img.getRGB(cx, cy), true)
        sampled.red shouldBe expected.red
        sampled.green shouldBe expected.green
        sampled.blue shouldBe expected.blue
        sampled.alpha shouldBe 255
    }

    @Test
    fun `top-left corner is transparent (no dot leakage across the icon)`() {
        val body = scaledBody()
        val img = paintToImage(PulseStatusIcon(body, Color.RED))
        // Body is blank + dot is bottom-right only, so top-left must be untouched.
        val topLeftAlpha = Color(img.getRGB(0, 0), true).alpha
        topLeftAlpha shouldBe 0
    }
}
