package ai.jolli.jollimemory.toolwindow

import com.intellij.testFramework.LightVirtualFile

/**
 * Virtual file backing the "Working Memory" review editor tab — the draft the
 * next commit will save. There is one logical Working Memory per project, so all
 * instances are equal and reopening reuses the same tab.
 */
class WorkingMemoryVirtualFile : LightVirtualFile("✨ Working Memory", "") {
    override fun equals(other: Any?): Boolean = other is WorkingMemoryVirtualFile
    override fun hashCode(): Int = "jollimemory-working-memory".hashCode()
    override fun isWritable(): Boolean = false
}
