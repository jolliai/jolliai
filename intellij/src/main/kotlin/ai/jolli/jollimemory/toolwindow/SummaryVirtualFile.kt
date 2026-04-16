package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.CommitSummary
import com.intellij.testFramework.LightVirtualFile

/**
 * Lightweight virtual file that carries a CommitSummary.
 * Used to open commit memories as editor tabs in the main editor area.
 */
class SummaryVirtualFile(
    val summary: CommitSummary,
) : LightVirtualFile(
    "\u2728 ${summary.commitHash.take(8)} — ${summary.commitMessage.take(50)}",
    "",
) {
    /** Stable identity so the same commit always reuses the same tab. */
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is SummaryVirtualFile) return false
        return summary.commitHash == other.summary.commitHash
    }

    override fun hashCode(): Int = summary.commitHash.hashCode()

    override fun isWritable(): Boolean = false
}
