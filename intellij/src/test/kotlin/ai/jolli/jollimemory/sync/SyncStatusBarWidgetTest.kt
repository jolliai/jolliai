package ai.jolli.jollimemory.sync

import com.intellij.openapi.project.Project
import io.mockk.mockk
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.parallel.Execution
import org.junit.jupiter.api.parallel.ExecutionMode
import org.junit.jupiter.api.parallel.Isolated

/**
 * Unit tests for the status-bar widget's render states, focused on
 * [SyncStatusBarWidget.clearFailureStatus] — the fix for a terminal failure
 * badge lingering on the status bar after sync stops with no round to clear it.
 *
 * The widget's `Project` is only touched by the click consumer, so a mock is
 * enough to drive the pure state → text mapping. `statusBar` stays null
 * (install() is never called), so `updateWidget` is a no-op.
 */
// MockK stays here because IntelliJ's Project is a huge platform interface a
// hand-written fake cannot reasonably cover. MockK's recorder is process-global
// and its instrumentation window raced with concurrent tests even under a
// shared "mockk" ResourceLock (stubs silently vanished — see GitCommands.kt),
// so mockk users now run @Isolated: the rest of the test plan is suspended
// while this class executes. Temporary guard — remove when migrated off MockK.
@Isolated
// MockK's recorder is JVM-global; @Nested classes are scheduled as independent
// parallel units, so intra-class concurrency corrupts stubbing too. SAME_THREAD
// is inherited by all nested classes and serializes this whole file.
@Execution(ExecutionMode.SAME_THREAD)
class SyncStatusBarWidgetTest {

	private fun widget(): SyncStatusBarWidget = SyncStatusBarWidget(mockk<Project>(relaxed = true))

	private fun failureDetail(code: SyncErrorCode = SyncErrorCode.PUSH_REJECTED) =
		SyncStatusDetail(failed = true, failedCode = code, lastError = "boom")

	@Test
	fun `clearFailureStatus resets a terminal failure to neutral`() {
		val w = widget()
		w.setSyncState(SyncState.OFFLINE, failureDetail())
		assertEquals("✗ Push rejected", w.getText())

		val cleared = w.clearFailureStatus()

		assertTrue(cleared)
		assertEquals("Jolli Memory", w.getText())
		assertEquals("Jolli Memory — click to open sidebar", w.getTooltipText())
	}

	@Test
	fun `clearFailureStatus leaves a healthy SYNCED state untouched`() {
		val w = widget()
		w.setSyncState(SyncState.SYNCED)
		assertEquals("✓ Jolli Memory", w.getText())

		val cleared = w.clearFailureStatus()

		assertFalse(cleared)
		assertEquals("✓ Jolli Memory", w.getText())
	}

	@Test
	fun `clearFailureStatus is a no-op for an already-neutral OFFLINE state`() {
		val w = widget()
		w.setSyncState(SyncState.OFFLINE, null)
		assertEquals("Jolli Memory", w.getText())

		val cleared = w.clearFailureStatus()

		assertFalse(cleared)
		assertEquals("Jolli Memory", w.getText())
	}

	@Test
	fun `clearFailureStatus does not disturb CONFLICTS state`() {
		val w = widget()
		w.setSyncState(SyncState.CONFLICTS, SyncStatusDetail(conflictCount = 3))
		assertEquals("⚠ 3 conflicts", w.getText())

		val cleared = w.clearFailureStatus()

		assertFalse(cleared)
		assertEquals("⚠ 3 conflicts", w.getText())
	}

	// ── autoClearableSyncState ───────────────────────────────────────────

	@Test
	fun `finished states are auto-clearable`() {
		assertTrue(autoClearableSyncState(SyncState.SYNCED))
		assertTrue(autoClearableSyncState(SyncState.CONFLICTS))
		assertTrue(autoClearableSyncState(SyncState.OFFLINE))
	}

	@Test
	fun `in-progress SYNCING is never auto-cleared`() {
		assertFalse(autoClearableSyncState(SyncState.SYNCING))
	}
}
