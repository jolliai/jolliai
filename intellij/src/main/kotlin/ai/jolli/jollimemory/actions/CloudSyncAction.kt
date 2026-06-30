package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.services.JolliAuthService
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.sync.SyncActivation
import com.intellij.ide.ActivityTracker
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Component
import java.awt.Dimension
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.SwingUtilities

/**
 * Tool window title bar action that shows cloud sync status.
 *
 * - Not signed in: red cloud icon. Click → popup with sign-in prompt.
 * - Signed in: normal cloud icon. Click → popup with sign-out option.
 *
 * Listens to [JolliAuthService] auth changes to update the icon via
 * [ActivityTracker], which triggers IntelliJ to re-call [update].
 */
class CloudSyncAction : AnAction() {

	private val log = JmLogger.create("CloudSyncAction")

	/** Captured from the last [actionPerformed] for use in panel builders. */
	private var lastProject: Project? = null

	init {
		JolliAuthService.addAuthListener {
			ActivityTracker.getInstance().inc()
		}
	}

	override fun update(e: AnActionEvent) {
		val signedIn = JolliAuthService.isSignedIn()
		if (signedIn) {
			e.presentation.icon = JolliMemoryIcons.CloudUpload
			e.presentation.text = "Cloud sync enabled"
		} else {
			e.presentation.icon = JolliMemoryIcons.CloudRed
			e.presentation.text = "Cloud sync disabled"
		}
	}

	override fun actionPerformed(e: AnActionEvent) {
		val component = e.inputEvent?.component ?: return
		lastProject = e.project
		val signedIn = JolliAuthService.isSignedIn()

		val panel = if (signedIn) buildSignedInPanel() else buildSignedOutPanel()

		JBPopupFactory.getInstance()
			.createComponentPopupBuilder(panel, null)
			.setRequestFocus(true)
			.createPopup()
			.showUnderneathOf(component)
	}

	private fun buildSignedOutPanel(): JPanel {
		val signInButton = JButton("Sign In / Sign Up").apply {
			alignmentX = Component.LEFT_ALIGNMENT
			maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
		}

		val panel = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			border = JBUI.Borders.empty(12)
			add(JBLabel("<html><b>Cloud sync disabled</b></html>").apply {
				alignmentX = Component.LEFT_ALIGNMENT
			})
			add(Box.createVerticalStrut(4))
			add(JBLabel("<html><span style='color:gray'>Sign in to Jolli to enable cloud sync</span></html>").apply {
				alignmentX = Component.LEFT_ALIGNMENT
			})
			add(Box.createVerticalStrut(8))
			add(signInButton)
		}

		signInButton.addActionListener {
			signInButton.isEnabled = false
			signInButton.text = "Signing in..."
			JolliAuthService.login(
				// User-initiated sign-in: mint a fresh key so a revoked same-tenant key recovers.
				forceFreshApiKey = true,
				onSuccess = { _ ->
					SwingUtilities.invokeLater {
						// Popup will be stale after sign-in; close the parent popup
						SwingUtilities.getWindowAncestor(panel)?.dispose()
					}
				},
				onError = { msg ->
					SwingUtilities.invokeLater {
						signInButton.isEnabled = true
						signInButton.text = "Sign In / Sign Up"
						com.intellij.notification.Notifications.Bus.notify(
							com.intellij.notification.Notification(
								"JolliMemory",
								"Sign In Failed",
								msg,
								com.intellij.notification.NotificationType.ERROR,
							)
						)
					}
				},
			)
		}

		return panel
	}

	private fun buildSignedInPanel(): JPanel {
		val syncNowButton = JButton("Sync Now").apply {
			alignmentX = Component.LEFT_ALIGNMENT
			maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
		}
		val signOutButton = JButton("Sign Out").apply {
			alignmentX = Component.LEFT_ALIGNMENT
			maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
		}

		val panel = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			border = JBUI.Borders.empty(12)
			add(JBLabel("<html><b>Cloud sync enabled</b></html>").apply {
				alignmentX = Component.LEFT_ALIGNMENT
			})
			add(Box.createVerticalStrut(4))
			add(JBLabel("<html><span style='color:gray'>Signed in to Jolli</span></html>").apply {
				alignmentX = Component.LEFT_ALIGNMENT
			})
			add(Box.createVerticalStrut(8))
			add(syncNowButton)
			add(Box.createVerticalStrut(4))
			add(signOutButton)
		}

		syncNowButton.addActionListener {
			log.info("Sync Now button clicked")
			val project = lastProject
			SwingUtilities.getWindowAncestor(panel)?.dispose()
			if (project != null) {
				// Lazy-build the orchestrator if needed (parity with the KB toolbar
				// "Sync to Personal Space" button) so a Sign-in-then-Sync without a
				// reconcile in between still actually syncs — and the toolbar/status
				// bar indicators get state changes to display.
				ApplicationManager.getApplication().executeOnPooledThread {
					val svc = project.service<JolliMemoryService>()
					if (!svc.isSyncBuilt()) {
						SyncActivation.reconcileSync(project, svc)
					}
					svc.requestManualSync()
				}
			}
		}

		signOutButton.addActionListener {
			JolliAuthService.signOut()
			SwingUtilities.getWindowAncestor(panel)?.dispose()
		}

		return panel
	}
}
