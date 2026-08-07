package ai.jolli.jollimemory.core

/**
 * Classifies the status code carried on a [ai.jolli.jollimemory.services.FileChange].
 *
 * **Two spellings exist and both must be accepted.** Git's raw porcelain v1 status is
 * two columns (`??` untracked, `AM` added-then-modified, …), but every producer in this
 * plugin collapses a row to ONE character before it reaches a consumer:
 * `JolliMemoryService.getChangedFiles` keeps the index column only when it is neither
 * blank nor `?`, so an untracked row yields `"?"`, and
 * `ChangesPanel.readChangesFromClm` writes `"?"` outright. Nothing here ever emits
 * `"??"` — that spelling only turns up in code that was written against raw git output.
 *
 * Matching one spelling and not the other fails SILENTLY, which is exactly how Discard
 * Changes came to no-op on untracked files: `"?"` missed the `"??"` branch, fell through
 * to `git checkout HEAD -- <path>`, and that command can only fail for a path HEAD has
 * never seen — leaving the file untouched with nothing shown to the user. VS Code does
 * not have this class of bug because it carries git's two raw columns all the way to
 * `bridge.discardFiles` instead of collapsing them.
 *
 * Route every status-code test through here rather than comparing literals inline.
 */
object GitStatusCodes {

    /** Codes meaning "added to the index" — collapsed `"A"`, plus the raw two-column forms. */
    private val INDEX_ADDED = setOf("A", "AM", "AD")

    /** Codes meaning "staged as a rename or a copy" — collapsed, plus the raw two-column forms. */
    private val INDEX_MOVED = setOf("R", "C", "RM", "RD", "CM", "CD")

    /** True when the file is untracked (git's `??`, collapsed to `?` by our producers). */
    fun isUntracked(statusCode: String): Boolean = statusCode == "?" || statusCode == "??"

    /**
     * True when the file is staged as a new addition. Discarding one has to unstage it
     * before deleting, since HEAD has no version to restore.
     */
    fun isIndexAdded(statusCode: String): Boolean = statusCode in INDEX_ADDED

    /**
     * True when the row is a staged rename or copy. HEAD has no version of the path the
     * row NAMES, so reverting one removes that file — a rename additionally brings the
     * content back under its original name, and a copy leaves its source alone.
     */
    fun isRenamedOrCopied(statusCode: String): Boolean = statusCode in INDEX_MOVED

    /**
     * True when discarding [statusCode] DELETES the file at this path rather than
     * restoring it in place. Callers use this to word their confirmation prompt
     * honestly.
     *
     * Renames and copies belong here, and leaving them out is the mistake that is easy
     * to make twice: `FileDiscardService` reverts a rename by removing the NEW path and
     * a copy by removing the copy, so wording either as "discard changes to" tells the
     * user their file stays put while the button makes it disappear. For a rename the
     * content does come back — under the original name, which is why the prompt says
     * what happens to THIS path and the panel refreshes both.
     */
    fun discardDeletesFile(statusCode: String): Boolean =
        isUntracked(statusCode) || isIndexAdded(statusCode) || isRenamedOrCopied(statusCode)
}
