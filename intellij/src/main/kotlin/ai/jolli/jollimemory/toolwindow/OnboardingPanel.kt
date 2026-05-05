package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliAuthService
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Disposer
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPasswordField
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Component
import java.awt.Dimension
import java.awt.FlowLayout
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.JSeparator
import javax.swing.SwingUtilities

/**
 * Onboarding screen shown when Jolli Memory is not yet configured
 * (no Anthropic API key and not signed in to Jolli).
 *
 * Presents two options:
 *   1. Enter an Anthropic API key (inline field + save)
 *   2. Sign in to Jolli (OAuth flow)
 *
 * The panel manages its own sign-in button state ("Signing in..." feedback)
 * via a [JolliAuthService] listener. The actual view flip (onboarding → main)
 * is handled by the factory's auth listener — this panel only calls
 * [onApiKeySaved] for the Anthropic key path.
 */
class OnboardingPanel(
	private val service: JolliMemoryService,
	private val onApiKeySaved: () -> Unit,
	private val onSignInError: (String) -> Unit,
) : JPanel(BorderLayout()), Disposable {

	private lateinit var signInButton: JButton
	private val authListenerDisposable: Disposable

	init {
		border = JBUI.Borders.empty(16, 16)

		val content = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
		}

		// ── Header ──────────────────────────────────────────────
		content.add(createHeader())
		content.add(Box.createVerticalStrut(12))
		content.add(createDivider())
		content.add(Box.createVerticalStrut(16))

		// ── Option 1: Anthropic API Key (top) ───────────────────
		content.add(createAnthropicSection())
		content.add(Box.createVerticalStrut(14))

		// ── OR separator ────────────────────────────────────────
		content.add(createOrSeparator())
		content.add(Box.createVerticalStrut(14))

		// ── Option 2: Sign in to Jolli (bottom) ─────────────────
		content.add(createJolliSection())

		add(content, BorderLayout.NORTH)

		// Auth listener: only resets sign-in button state.
		// The factory's own auth listener handles the card flip.
		authListenerDisposable = JolliAuthService.addAuthListener {
			SwingUtilities.invokeLater {
				signInButton.isEnabled = true
				signInButton.text = "Sign In / Sign Up"
			}
		}
	}

	private fun createHeader(): JPanel = JPanel().apply {
		layout = BoxLayout(this, BoxLayout.Y_AXIS)
		alignmentX = LEFT_ALIGNMENT

		add(JPanel(FlowLayout(FlowLayout.LEFT, 6, 0)).apply {
			alignmentX = LEFT_ALIGNMENT
			add(JBLabel(JolliMemoryIcons.JolliLogo))
			add(JBLabel("<html><b style='font-size:14pt'>Get started with Jolli Memory</b></html>"))
		})
		add(Box.createVerticalStrut(4))
		add(JBLabel(
			"<html><span style='color:gray'>Jolli Memory automatically captures your work context " +
				"and surfaces relevant memories as you code. Choose how you'd like to set it up.</span></html>",
		).apply {
			alignmentX = LEFT_ALIGNMENT
		})
	}

	private fun createDivider(): JSeparator = JSeparator().apply {
		alignmentX = LEFT_ALIGNMENT
		maximumSize = Dimension(Int.MAX_VALUE, 1)
	}

	private fun createAnthropicSection(): JPanel {
		val section = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			alignmentX = LEFT_ALIGNMENT
		}

		// Card
		val card = createOptionCard(
			icon = JolliMemoryIcons.Lock,
			title = "Use your Anthropic API key",
			description = "Connect your own Anthropic API key for AI summarization. Memories are stored locally only.",
		)
		section.add(card)
		section.add(Box.createVerticalStrut(8))

		// Inline key field (initially hidden)
		val keyField = JBPasswordField().apply {
			alignmentX = LEFT_ALIGNMENT
			maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
		}
		val warningLabel = JBLabel().apply {
			alignmentX = LEFT_ALIGNMENT
			isVisible = false
		}
		val saveButton = createBlueButton("Save")
		val inlinePanel = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			alignmentX = LEFT_ALIGNMENT
			isVisible = false
			add(JBLabel("Anthropic API Key:").apply { alignmentX = LEFT_ALIGNMENT })
			add(Box.createVerticalStrut(4))
			add(keyField)
			add(warningLabel)
			add(Box.createVerticalStrut(6))
			add(saveButton)
		}

		// Configure button
		val configureButton = createBlueButton("Configure API Key").apply {
			addActionListener {
				inlinePanel.isVisible = true
				this.isVisible = false
				keyField.requestFocusInWindow()
			}
		}

		saveButton.addActionListener {
			val key = String(keyField.password).trim()
			if (key.isBlank()) {
				warningLabel.text = "<html><span style='color:#c0392b'>Enter your Anthropic API key</span></html>"
				warningLabel.isVisible = true
				return@addActionListener
			}
			if (!key.startsWith("sk-ant-")) {
				warningLabel.text = "<html><span style='color:#c0392b'>Anthropic API Key should start with sk-ant-</span></html>"
				warningLabel.isVisible = true
				return@addActionListener
			}
			warningLabel.isVisible = false

			val configDir = SessionTracker.getGlobalConfigDir()
			val existing = SessionTracker.loadConfigFromDir(configDir)
			val updated = existing.copy(
				apiKey = key,
				aiProvider = "anthropic",
			)
			SessionTracker.saveConfigToDir(updated, configDir)
			service.refreshStatus()
			onApiKeySaved()
		}

		section.add(configureButton)
		section.add(inlinePanel)

		return section
	}

	private fun createOrSeparator(): JPanel = JPanel(java.awt.GridBagLayout()).apply {
		alignmentX = LEFT_ALIGNMENT
		val gbc = java.awt.GridBagConstraints()
		gbc.gridy = 0
		gbc.fill = java.awt.GridBagConstraints.HORIZONTAL

		gbc.gridx = 0
		gbc.weightx = 1.0
		add(JSeparator(), gbc)

		gbc.gridx = 1
		gbc.weightx = 0.0
		gbc.insets = java.awt.Insets(0, 10, 0, 10)
		add(JBLabel("<html><span style='color:gray'>OR</span></html>"), gbc)

		gbc.gridx = 2
		gbc.weightx = 1.0
		gbc.insets = java.awt.Insets(0, 0, 0, 0)
		add(JSeparator(), gbc)
	}

	private fun createJolliSection(): JPanel {
		val section = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			alignmentX = LEFT_ALIGNMENT
		}

		val card = createOptionCard(
			icon = JolliMemoryIcons.JolliLogo,
			title = "Sign in to Jolli",
			description = "Use your Jolli account for AI summarization. Memories are stored locally, with the option to push to Jolli cloud.",
		)
		section.add(card)
		section.add(Box.createVerticalStrut(8))

		signInButton = createBlueButton("Sign In / Sign Up").apply {
			addActionListener { handleSignInClicked() }
		}
		section.add(signInButton)

		return section
	}

	private fun handleSignInClicked() {
		signInButton.isEnabled = false
		signInButton.text = "Signing in..."
		JolliAuthService.login(
			onSuccess = { result ->
				// Save aiProvider to config so isConfigured() picks it up
				val configDir = SessionTracker.getGlobalConfigDir()
				val existing = SessionTracker.loadConfigFromDir(configDir)
				if (existing.aiProvider.isNullOrBlank() || existing.aiProvider == "anthropic") {
					val updated = existing.copy(aiProvider = "jolli")
					SessionTracker.saveConfigToDir(updated, configDir)
				}
				service.refreshStatus()
				// Button state reset handled by auth listener
			},
			onError = { msg ->
				SwingUtilities.invokeLater {
					signInButton.isEnabled = true
					signInButton.text = "Sign In / Sign Up"
					onSignInError(msg)
				}
			},
		)
	}

	private fun createOptionCard(icon: javax.swing.Icon, title: String, description: String): JPanel = object : JPanel() {
		init { isOpaque = false }
		override fun paintComponent(g: java.awt.Graphics) {
			val g2 = g.create() as java.awt.Graphics2D
			g2.setRenderingHint(java.awt.RenderingHints.KEY_ANTIALIASING, java.awt.RenderingHints.VALUE_ANTIALIAS_ON)
			g2.color = java.awt.Color(0x2D, 0x2D, 0x2D)
			g2.fillRoundRect(0, 0, width, height, 12, 12)
			g2.color = javax.swing.UIManager.getColor("Separator.separatorColor") ?: java.awt.Color(0x3C, 0x3C, 0x3C)
			g2.drawRoundRect(0, 0, width - 1, height - 1, 12, 12)
			g2.dispose()
		}
	}.apply {
		layout = BorderLayout(10, 0)
		alignmentX = LEFT_ALIGNMENT
		border = JBUI.Borders.empty(10, 12)

		add(JBLabel(icon).apply {
			verticalAlignment = javax.swing.SwingConstants.TOP
			border = JBUI.Borders.emptyTop(2)
		}, BorderLayout.WEST)

		add(JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			isOpaque = false
			add(JBLabel("<html><b>$title</b></html>").apply { alignmentX = Component.LEFT_ALIGNMENT })
			add(Box.createVerticalStrut(2))
			add(JBLabel("<html><span style='color:gray'>$description</span></html>").apply {
				alignmentX = Component.LEFT_ALIGNMENT
			})
		}, BorderLayout.CENTER)
	}

	private fun createBlueButton(text: String): JButton = object : JButton(text) {
		init {
			alignmentX = LEFT_ALIGNMENT
			maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
			foreground = java.awt.Color.WHITE
			isOpaque = false
			isContentAreaFilled = false
			isFocusPainted = false
			isBorderPainted = false
			border = BorderFactory.createEmptyBorder(6, 12, 6, 12)
		}
		override fun paintComponent(g: java.awt.Graphics) {
			val g2 = g.create() as java.awt.Graphics2D
			g2.setRenderingHint(java.awt.RenderingHints.KEY_ANTIALIASING, java.awt.RenderingHints.VALUE_ANTIALIAS_ON)
			g2.color = if (model.isRollover) java.awt.Color(0x2D, 0x65, 0xD8) else java.awt.Color(0x35, 0x74, 0xF0)
			g2.fillRoundRect(0, 0, width, height, 8, 8)
			g2.dispose()
			super.paintComponent(g)
		}
	}

	override fun dispose() {
		Disposer.dispose(authListenerDisposable)
	}
}
