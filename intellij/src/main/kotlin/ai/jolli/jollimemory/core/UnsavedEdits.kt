package ai.jolli.jollimemory.core

import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.vfs.LocalFileSystem
import java.io.File

/**
 * Flushes in-editor edits to disk before a git operation reads the working tree.
 *
 * **Why this is needed at all.** The FILES list is built from `ChangeListManager`,
 * which reports a file as changed while its edits still live only in the editor's
 * document — that is deliberate (`ChangesPanel.readChangesFromClm`: "reflects
 * in-editor edits not yet saved to disk, so the panel updates as the user types").
 * The CLI's discard service, by contrast, resolves every path against one
 * authoritative `git status`. So a row can exist for a file git considers clean.
 *
 * Without this flush that row's Discard reports `not-found` with `ok: true` — the
 * documented meaning of which is "the state you asked for already holds" — so the
 * user gets a confirmation dialog, clicks through an irreversible action, and the
 * edits are still in the editor with nothing shown anywhere. That is the silent
 * success the whole discard rewrite exists to remove, arriving through the one
 * door the CLI cannot see.
 *
 * **Scoped to the requested paths on purpose.** `saveAllDocuments()` would be one
 * line, and would also write every OTHER unsaved editor in the project to disk as
 * a side effect of discarding one file — a surprise the user never asked for, and
 * on a discard of the wrong row an unrecoverable one. Only documents backing the
 * paths being discarded are flushed.
 *
 * Call ON the EDT, before handing the paths to the discard service.
 */
object UnsavedEdits {

    /**
     * Writes any unsaved editor content for [relativePaths] (repo-relative, under
     * [repoRoot]) to disk. Paths with no open document, or no unsaved changes, are
     * skipped — this never touches a file the user is not editing.
     */
    fun flush(repoRoot: String, relativePaths: List<String>) {
        val fileSystem = LocalFileSystem.getInstance()
        val documents = FileDocumentManager.getInstance()
        for (relativePath in relativePaths) {
            // findFileByIoFile, not refreshAndFindFileByIoFile: an unsaved edit
            // means the IDE already knows this file, and a refresh here would be a
            // blocking VFS round-trip on the EDT for nothing.
            val virtualFile = fileSystem.findFileByIoFile(File(repoRoot, relativePath)) ?: continue
            val document = documents.getCachedDocument(virtualFile) ?: continue
            if (documents.isDocumentUnsaved(document)) {
                documents.saveDocument(document)
            }
        }
    }
}
