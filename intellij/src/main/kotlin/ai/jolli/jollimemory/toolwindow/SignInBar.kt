package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.services.JolliAuthService
import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Disposer
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Component
import java.awt.Dimension
import java.awt.FlowLayout
import javax.swing.Box
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.SwingUtilities

/**
 * Sign-in / signed-in banner shared between the JolliMemory tool window and the
 * settings dialog. Subscribes to JolliAuthService for live updates and disposes
 * its listener when [Disposer.dispose] is called on this component.
 *
 * @param showSettingsHint when true, renders the
 *   "Or configure API keys in Settings > Tools > Jolli Memory" footnote below the
 * @param onSignInError invoked on the EDT when JolliAuthService.login() fails.
 *   The tool window shows an IDE notification; the settings dialog can use this
 *   hook for its own surfacing.
 */
class SignInBar(
    private val onSignInError: (String) -> Unit = {},
) : JPanel(BorderLayout()), Disposable {

    private val signInBanner: JPanel = JPanel(BorderLayout()).apply {
        border = JBUI.Borders.empty(10, 12)
    }

    private val signedInBar: JPanel = JPanel(FlowLayout(FlowLayout.LEFT, 8, 4)).apply {
        add(JBLabel(JolliMemoryIcons.Check))
        add(JBLabel("Signed in"))
        add(JButton("Sign Out").apply {
            putClientProperty("JButton.buttonType", "default")
            addActionListener { JolliAuthService.signOut() }
        })
    }

    private val signInButton: JButton = JButton("Sign In").apply {
        putClientProperty("JButton.buttonType", "default")
        addActionListener { handleSignInClicked() }
    }

    private val authListenerDisposable: Disposable

    init {
        buildBannerContents()

        // Stack: banner (signed-out) on top, signed-in bar below. Visibility is
        // toggled in syncBanner() so only one is visible at a time.
        add(JPanel(BorderLayout()).apply {
            add(signInBanner, BorderLayout.NORTH)
            add(signedInBar, BorderLayout.SOUTH)
        }, BorderLayout.CENTER)

        syncBanner()
        authListenerDisposable = JolliAuthService.addAuthListener {
            SwingUtilities.invokeLater { syncBanner() }
        }
    }

    /** Re-syncs the banner from outside (e.g. when a parent's status listener fires). */
    fun refresh() {
        SwingUtilities.invokeLater { syncBanner() }
    }

    private fun buildBannerContents() {
        signInBanner.add(Box.createVerticalBox().apply {
            add(JBLabel("<html><b>Sign up or Sign In to Jolli</b></html>"))
            add(Box.createVerticalStrut(4))
            add(JBLabel("<html><span style='color:gray'>Sign in to enable Jolli cloud sync</span></html>"))
            add(Box.createVerticalStrut(8))
            add(signInButton.apply {
                alignmentX = Component.LEFT_ALIGNMENT
                maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
            })
        }, BorderLayout.CENTER)
    }

    private fun handleSignInClicked() {
        signInButton.isEnabled = false
        signInButton.text = "Signing in..."
        JolliAuthService.login(
            onSuccess = { _ ->
                SwingUtilities.invokeLater {
                    signInButton.isEnabled = true
                    signInButton.text = "Sign In"
                    syncBanner()
                }
            },
            onError = { msg ->
                SwingUtilities.invokeLater {
                    signInButton.isEnabled = true
                    signInButton.text = "Sign In"
                    onSignInError(msg)
                }
            },
        )
    }

    private fun syncBanner() {
        val signedIn = JolliAuthService.isSignedIn()
        signInBanner.isVisible = !signedIn
        signedInBar.isVisible = signedIn
    }

    override fun dispose() {
        Disposer.dispose(authListenerDisposable)
    }
}
