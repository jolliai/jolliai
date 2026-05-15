package ai.jolli.jollimemory.toolwindow.sidebar

import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Cursor
import java.awt.Desktop
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.net.URI
import javax.swing.JPanel
import javax.swing.SwingConstants

/**
 * Simple fallback panel shown when JCEF is not available.
 *
 * JCEF requires the JetBrains Runtime with Chromium support. Some environments
 * (e.g. remote dev, lightweight IDEs, custom JDKs) don't ship it. This panel
 * tells the user what's missing and links to the fix.
 */
class JCEFFallbackPanel : JPanel(BorderLayout()) {

	init {
		border = JBUI.Borders.empty(20)

		val message = JBLabel(
			"<html><center>" +
				"<p><b>JCEF Required</b></p>" +
				"<p>The Jolli Memory sidebar requires JCEF (Java Chromium Embedded Framework),<br>" +
				"which is included in the default JetBrains Runtime.</p>" +
				"<p>Please ensure you are using the bundled JetBrains Runtime<br>" +
				"(Help → About → check Runtime version).</p>" +
				"</center></html>",
			SwingConstants.CENTER,
		)
		add(message, BorderLayout.CENTER)

		val link = JBLabel("<html><a href='#'>Learn more about JCEF</a></html>")
		link.horizontalAlignment = SwingConstants.CENTER
		link.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
		link.addMouseListener(object : MouseAdapter() {
			override fun mouseClicked(e: MouseEvent?) {
				try {
					Desktop.getDesktop().browse(URI("https://plugins.jetbrains.com/docs/intellij/jcef.html"))
				} catch (_: Exception) { /* ignore */ }
			}
		})
		add(link, BorderLayout.SOUTH)
	}
}
