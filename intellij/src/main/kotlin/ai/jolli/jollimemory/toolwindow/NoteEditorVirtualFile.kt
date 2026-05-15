package ai.jolli.jollimemory.toolwindow

import com.intellij.testFramework.LightVirtualFile

/**
 * Marker virtual file for the "Add Text Snippet" creation flow. Opens as a
 * dedicated editor tab via [NoteEditorProvider]. Each instance is its own
 * draft — identity equality (default) means a second "Add Text Snippet" click
 * opens a new tab rather than reusing one.
 */
class NoteEditorVirtualFile : LightVirtualFile("New Note", "") {
    override fun isWritable(): Boolean = false
}
