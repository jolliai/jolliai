package ai.jolli.jollimemory

import com.intellij.icons.AllIcons
import com.intellij.openapi.util.IconLoader
import javax.swing.Icon

/**
 * Custom icons for the JolliMemory plugin.
 * These match the VSCode codicons used in the VSCode extension for visual consistency.
 */
object JolliMemoryIcons {
    /** Green checkmark — matches VSCode codicon "check" (green). */
    val Check: Icon = IconLoader.getIcon("/icons/check.svg", JolliMemoryIcons::class.java)

    /** Red X — matches VSCode codicon "x" (red). */
    val X: Icon = IconLoader.getIcon("/icons/x.svg", JolliMemoryIcons::class.java)

    /** Yellow warning triangle — matches VSCode codicon "warning" (yellow). */
    val Warning: Icon = IconLoader.getIcon("/icons/warning.svg", JolliMemoryIcons::class.java)

    /** Green pulse/heartbeat — matches VSCode codicon "pulse" (green). */
    val Pulse: Icon = IconLoader.getIcon("/icons/pulse.svg", JolliMemoryIcons::class.java)

    /** Green book — matches VSCode codicon "book" (green). */
    val Book: Icon = IconLoader.getIcon("/icons/book.svg", JolliMemoryIcons::class.java)

    /** Green globe — matches VSCode codicon "globe" (green). */
    val Globe: Icon = IconLoader.getIcon("/icons/globe.svg", JolliMemoryIcons::class.java)

    /** Sparkle — matches VSCode codicon "sparkle" for AI commit. */
    val Sparkle: Icon = IconLoader.getIcon("/icons/sparkle.svg", JolliMemoryIcons::class.java)

    /** Git merge — matches VSCode codicon "git-merge" for squash. */
    val GitMerge: Icon = IconLoader.getIcon("/icons/git-merge.svg", JolliMemoryIcons::class.java)

    /** Cloud upload — matches VSCode codicon "cloud-upload" for push. */
    val CloudUpload: Icon = IconLoader.getIcon("/icons/cloud-upload.svg", JolliMemoryIcons::class.java)

    /** Eye — matches VSCode codicon "eye" for view summary. */
    val Eye: Icon = IconLoader.getIcon("/icons/eye.svg", JolliMemoryIcons::class.java)

    /** Select/deselect all — uses IntelliJ platform icon for crisp rendering. */
    val CheckAll: Icon = AllIcons.Actions.Selectall

    /** Refresh — uses IntelliJ platform icon for crisp rendering. */
    val Refresh: Icon = AllIcons.Actions.Refresh

    /** Lock (green) — matches VSCode codicon "lock" for committed plans. */
    val Lock: Icon = IconLoader.getIcon("/icons/lock.svg", JolliMemoryIcons::class.java)

    /** File text — matches VSCode codicon "file-text" for uncommitted plans. */
    val FileText: Icon = IconLoader.getIcon("/icons/file-text.svg", JolliMemoryIcons::class.java)

    /** Note — matches VSCode codicon "note" for markdown notes. */
    val Note: Icon = IconLoader.getIcon("/icons/note.svg", JolliMemoryIcons::class.java)

    /** Note with plus — used for the "Add Note" toolbar action. */
    val NoteAdd: Icon = IconLoader.getIcon("/icons/note-add.svg", JolliMemoryIcons::class.java)

    /** Comment — matches VSCode codicon "comment" for text snippet notes. */
    val Comment: Icon = IconLoader.getIcon("/icons/comment.svg", JolliMemoryIcons::class.java)

    /** Discard — matches VSCode codicon "discard" for reverting file changes. */
    val Discard: Icon = IconLoader.getIcon("/icons/discard.svg", JolliMemoryIcons::class.java)

    /** Trash — matches VSCode codicon "trash" for delete/remove actions. */
    val Trash: Icon = IconLoader.getIcon("/icons/trash.svg", JolliMemoryIcons::class.java)

    /** Green circle — status indicator for healthy/enabled state. */
    val CircleGreen: Icon = IconLoader.getIcon("/icons/circle-green.svg", JolliMemoryIcons::class.java)

    /** Yellow circle — status indicator for warnings/partial issues. */
    val CircleYellow: Icon = IconLoader.getIcon("/icons/circle-yellow.svg", JolliMemoryIcons::class.java)

    /** Red circle — status indicator for errors/failed state. */
    val CircleRed: Icon = IconLoader.getIcon("/icons/circle-red.svg", JolliMemoryIcons::class.java)
}
