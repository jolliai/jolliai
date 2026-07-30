package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.JmLogger
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project

/**
 * Opens or reuses a single memory tab across all commit-viewing entry points.
 *
 * WHY: opening a new [SummaryFileEditor] tab per memory forces JCEF's native
 * peer through a fresh NSView attach on macOS, which reliably produces the
 * "top-white / small-center-dot" half-render state for 1-3 seconds. Reusing
 * the same open tab keeps the JBCefBrowser attached to the same Swing
 * component tree — swapping content becomes a plain [com.intellij.ui.jcef.JBCefBrowser.loadHTML]
 * against an already-stable native view.
 *
 * CONTRACT: at most one live [SummaryFileEditor] per project. Every entry
 * point that used to call
 *   `FileEditorManager.openFile(SummaryVirtualFile(summary, ...), true)`
 * should call this helper instead.
 *
 * FIRST-OPEN COST: the first memory of a session still creates a new tab
 * and pays the NSView attach cost — [SummaryPanel.scheduleSwingSizeShake]
 * compresses that to ~500 ms. Every subsequent open goes through the reuse
 * path and is effectively instant.
 */
object MemoryTabOpener {

    /**
     * If a memory tab is already open in [project], swap its content to
     * [summary]/[readOnly] and activate it. Otherwise open a new memory tab.
     */
    fun openOrReuse(project: Project, summary: CommitSummary, readOnly: Boolean = false) {
        val fm = FileEditorManager.getInstance(project)
        val existing = findExisting(fm.allEditors)
        if (existing != null) {
            val file = existing.file as? SummaryVirtualFile
            if (file != null) {
                log.info("openOrReuse: REUSE existing tab (hash=%s → %s)",
                    file.summary.commitHash.take(8), summary.commitHash.take(8))
                file.updateSummary(summary, readOnly)
                existing.updateSummary(summary, readOnly)
                // openFile on an already-open file just activates the tab —
                // no editor recreation, no NSView re-attach.
                fm.openFile(file, true)
                return
            }
            log.warn("openOrReuse: existing SummaryFileEditor found but its file is not a SummaryVirtualFile — falling back to new tab")
        }
        log.info("openOrReuse: no existing memory tab, opening new (hash=%s, readOnly=%s)",
            summary.commitHash.take(8), readOnly)
        // First memory of the session (or the previous tab was closed): open a
        // brand-new tab. First-attach NSView cost is absorbed here; the
        // subsequent shake in SummaryPanel compresses the visible white.
        fm.openFile(SummaryVirtualFile(summary, readOnly), true)
    }

    /**
     * Returns the currently-open memory editor if any. Used by callers that
     * want to also trigger the inline share overlay after opening — the
     * previous openFile-then-cast pattern still works because reuse keeps the
     * same editor instance alive.
     */
    fun findExistingEditor(project: Project): SummaryFileEditor? {
        val fm = FileEditorManager.getInstance(project)
        return findExisting(fm.allEditors)
    }

    private fun findExisting(editors: Array<FileEditor>): SummaryFileEditor? =
        editors.filterIsInstance<SummaryFileEditor>().firstOrNull()

    private val log = JmLogger.create("MemoryTabOpener")
}
