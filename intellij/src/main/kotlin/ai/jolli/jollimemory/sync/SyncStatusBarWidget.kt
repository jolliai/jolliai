package ai.jolli.jollimemory.sync

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.util.Consumer
import java.awt.event.MouseEvent

/**
 * Status bar widget showing the current Memory Bank sync state.
 *
 * Four-state machine driven by [setSyncState]:
 * - **SYNCED** — "✓ Jolli Memory"
 * - **SYNCING** — "⟳ Syncing…"
 * - **CONFLICTS** — "⚠ N conflicts"
 * - **OFFLINE** — terminal error text or neutral fallback
 *
 * Port of the sync state machine from `vscode/src/util/StatusBarManager.ts`.
 */
class SyncStatusBarWidget(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation {

	companion object {
		const val ID = "JolliSyncStatus"
	}

	private var statusBar: StatusBar? = null
	@Volatile
	private var currentState: SyncState = SyncState.SYNCED
	@Volatile
	private var currentDetail: SyncStatusDetail? = null
	@Volatile
	private var displayText: String = "Jolli Memory"
	@Volatile
	private var tooltipText: String = "Jolli Memory — click to open sidebar"

	fun setSyncState(state: SyncState, detail: SyncStatusDetail? = null) {
		currentState = state
		currentDetail = detail

		when (state) {
			SyncState.SYNCED -> {
				displayText = "✓ Jolli Memory"
				tooltipText = "Memory Bank in sync"
			}
			SyncState.SYNCING -> {
				displayText = "⟳ Syncing…"
				tooltipText = "Memory Bank sync in progress"
			}
			SyncState.CONFLICTS -> {
				val count = detail?.conflictCount
				displayText = if (count != null) "⚠ $count conflicts" else "⚠ Conflicts"
				tooltipText = if (count != null) "$count items need your attention" else "Conflicts need your attention"
			}
			SyncState.OFFLINE -> {
				if (detail?.failed == true && detail.failedCode != null) {
					val visual = terminalCodeVisual(detail.failedCode, detail)
					displayText = visual.text
					tooltipText = visual.headline
				} else {
					displayText = "Jolli Memory"
					tooltipText = "Jolli Memory — click to open sidebar"
				}
			}
		}

		statusBar?.updateWidget(ID)
	}

	// ── StatusBarWidget ──────────────────────────────────────────────────

	override fun ID(): String = ID

	override fun install(statusBar: StatusBar) {
		this.statusBar = statusBar
	}

	override fun dispose() {
		statusBar = null
	}

	// ── StatusBarWidget.TextPresentation ─────────────────────────────────

	override fun getText(): String = displayText

	override fun getTooltipText(): String = tooltipText

	override fun getAlignment(): Float = java.awt.Component.LEFT_ALIGNMENT

	override fun getClickConsumer(): Consumer<MouseEvent> = Consumer {
		val tw = ToolWindowManager.getInstance(project).getToolWindow("JOLLI")
		tw?.show()
	}

	// ── Terminal error visuals ───────────────────────────────────────────

	private data class TerminalVisual(val text: String, val headline: String)

	private fun terminalCodeVisual(code: SyncErrorCode, detail: SyncStatusDetail): TerminalVisual {
		return when (code) {
			SyncErrorCode.VAULT_LOCKED -> {
				val headline = if (detail.selfLocked) {
					"Your previous sync failed — waiting for lock to expire"
				} else {
					"Personal Space is being synced by another device"
				}
				TerminalVisual("⚠ Personal Space busy", headline)
			}
			SyncErrorCode.LOCALFOLDER_INVALID -> {
				TerminalVisual("✗ Memory Bank folder invalid", "Update the Memory Bank folder in Settings")
			}
			SyncErrorCode.PUSH_REJECTED -> {
				TerminalVisual("✗ Push rejected", "Memory Bank sync failed")
			}
			else -> {
				TerminalVisual("✗ Sync failed", "Memory Bank sync failed")
			}
		}
	}
}
