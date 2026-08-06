package ai.jolli.jollimemory

import com.intellij.util.ui.JBUI
import java.awt.Color
import java.awt.Component
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import javax.swing.Icon

/**
 * Tool window title-bar Status glyph — mirrors the design mockup's
 * `<button id="btn-status">` composed of a `codicon-pulse` plus a small
 * `.status-dot` overlay at the bottom-right.
 *
 * Only the dot color varies with the health state (green/yellow/red); the pulse
 * body stays theme-adaptive gray so it reads on both light and dark IDE themes.
 *
 * Kept small and pure so it's cheap to construct three color variants once in
 * [JolliMemoryIcons] and hand them back from `statusCircleIcon` per tick.
 */
class PulseStatusIcon(
    private val body: Icon,
    private val dotColor: Color,
) : Icon {

    override fun getIconWidth(): Int = body.iconWidth
    override fun getIconHeight(): Int = body.iconHeight

    override fun paintIcon(c: Component?, g: Graphics, x: Int, y: Int) {
        body.paintIcon(c, g, x, y)

        val g2 = g.create() as Graphics2D
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            // Design mock: 7px dot pinned to the bottom-right of a 16px glyph
            // (`.status-dot { right: 3px; bottom: 3px; width: 7px }` on a
            // slightly-padded `.icon-btn`). Nudging the dot 1px past the icon
            // edge here keeps the same visual weight when the platform hands
            // us a 16px paint slot with no button padding of its own.
            //
            // Both the size and the nudge go through [JBUI.scale] because [body]
            // is an IconLoader SVG: it grows with the IDE scale (presentation
            // mode, a bigger UI font), so iconWidth/iconHeight below are already
            // scaled. Bare pixels here would keep the dot at 7px on a 32px glyph
            // and drift off the mock's proportions. Scaled per paint rather than
            // cached in the companion — [JolliMemoryIcons] holds these icons as
            // long-lived vals, so a class-load-time value would freeze the scale
            // that was in effect at startup.
            val dotSize = JBUI.scale(DOT_SIZE)
            val nudge = JBUI.scale(DOT_NUDGE)
            val dx = x + iconWidth - dotSize + nudge
            val dy = y + iconHeight - dotSize + nudge
            g2.color = dotColor
            g2.fillOval(dx, dy, dotSize, dotSize)
        } finally {
            g2.dispose()
        }
    }

    companion object {
        /** Unscaled dot diameter, in the design mock's 16px-glyph coordinate space. */
        const val DOT_SIZE = 7

        /** Unscaled overhang past the glyph's bottom-right corner. See [paintIcon]. */
        const val DOT_NUDGE = 1
    }
}
