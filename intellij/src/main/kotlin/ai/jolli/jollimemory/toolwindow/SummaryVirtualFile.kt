package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.CommitSummary
import com.intellij.testFramework.LightVirtualFile

/**
 * Lightweight virtual file that carries a MUTABLE CommitSummary reference.
 *
 * WHY MUTABLE: [MemoryTabOpener] reuses a single memory tab across memory
 * switches instead of opening a new tab per commit. Opening a new tab would
 * force the JCEF native peer through a fresh NSView attach — the macOS-specific
 * "first-paint half-renders" trauma we're actively working around. Reusing the
 * same VirtualFile keeps the same [SummaryFileEditor], the same [SummaryPanel],
 * the same pooled JBCefBrowser attached to the same Swing component tree —
 * only the DOM inside Chromium changes.
 *
 * WHY IDENTITY EQUALS (not commit-hash based): [MemoryTabOpener] guarantees at
 * most one live instance per project via its lookup-then-create flow, so we do
 * NOT want IntelliJ's tab manager to dedupe two instances that happen to carry
 * the same commit hash — that would trigger a tab reopen and defeat the reuse.
 * Identity equals + identity hashCode + a single owner (MemoryTabOpener) keeps
 * the file's identity stable even as its underlying summary swaps around.
 */
class SummaryVirtualFile(
    initialSummary: CommitSummary,
    initialReadOnly: Boolean = false,
) : LightVirtualFile(nameFor(initialSummary), "") {

    @Volatile
    var summary: CommitSummary = initialSummary
        private set

    @Volatile
    var readOnly: Boolean = initialReadOnly
        private set

    /**
     * Swap the underlying summary (and readOnly mode) in place. Called by
     * [MemoryTabOpener] when the user clicks a different memory while a tab
     * is already open.
     *
     * NO RENAME: we deliberately do NOT call [rename] here — that fires a VFS
     * rename event which [com.intellij.openapi.fileEditor.impl.FileEditorManagerImpl]
     * listens for and interprets as "close the old editor, open a new one at
     * the new name". That would defeat the whole reuse. Tab title stays as
     * whatever [getName] computes from the CURRENT `summary` (see the override
     * below) — most IntelliJ tab paths re-query [getName] on refresh, so titles
     * usually update; when they don't, users see a stale title for a session
     * but content is correct.
     */
    fun updateSummary(newSummary: CommitSummary, newReadOnly: Boolean) {
        summary = newSummary
        readOnly = newReadOnly
    }

    /**
     * Computed from the current [summary] rather than the constructor-time
     * name field, so a [updateSummary] swap can propagate to any UI that
     * re-queries `getName()` on refresh.
     */
    override fun getName(): String = nameFor(summary)

    /**
     * [LightVirtualFile] derives [getPath] from the constructor-time name, so
     * after [updateSummary] the two would diverge. Delegate to [getName] so
     * VFS-aware plugins that display the path see the current summary's title.
     */
    override fun getPath(): String = name

    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = System.identityHashCode(this)
    override fun isWritable(): Boolean = false

    companion object {
        private fun nameFor(s: CommitSummary): String =
            "✨ ${s.commitHash.take(8)} — ${s.commitMessage.take(50)}"
    }
}
