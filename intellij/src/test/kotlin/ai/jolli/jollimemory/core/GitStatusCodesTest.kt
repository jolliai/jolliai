package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

/**
 * Locks down [GitStatusCodes], whose entire reason to exist is that matching the
 * wrong spelling of a status code fails SILENTLY.
 *
 * Two spellings reach it: git's raw two-column porcelain (`??`, `AM`, `RM`) and
 * the ONE-character form every producer in this plugin collapses to
 * (`getChangedFiles` keeps the index column only when it is neither blank nor
 * `?`; `readChangesFromClm` writes `"?"` outright). A predicate that covers one
 * and not the other returns a confident, wrong answer — which is how Discard
 * Changes came to no-op on untracked files, and how the confirmation prompt came
 * to promise a rename would be left in place while the button deleted it.
 *
 * Pure string tests: no Project, no VFS, no JVM globals, so this runs under the
 * default parallel-tests policy.
 */
class GitStatusCodesTest {

    @Test
    fun `untracked is recognised in both the collapsed and raw spellings`() {
        GitStatusCodes.isUntracked("?") shouldBe true
        GitStatusCodes.isUntracked("??") shouldBe true
    }

    @Test
    fun `untracked does not swallow unrelated codes`() {
        for (code in listOf("M", "A", "D", "R", "C", " ", "")) {
            GitStatusCodes.isUntracked(code) shouldBe false
        }
    }

    @Test
    fun `index-added covers the plain and the modified-since forms`() {
        GitStatusCodes.isIndexAdded("A") shouldBe true
        GitStatusCodes.isIndexAdded("AM") shouldBe true
        GitStatusCodes.isIndexAdded("AD") shouldBe true
    }

    @Test
    fun `index-added rejects a modification`() {
        GitStatusCodes.isIndexAdded("M") shouldBe false
        GitStatusCodes.isIndexAdded("MM") shouldBe false
    }

    @Test
    fun `renames and copies are recognised in both spellings`() {
        for (code in listOf("R", "C", "RM", "RD", "CM", "CD")) {
            GitStatusCodes.isRenamedOrCopied(code) shouldBe true
        }
    }

    @Test
    fun `renames and copies do not swallow unrelated codes`() {
        for (code in listOf("M", "A", "D", "?", "??", " ", "")) {
            GitStatusCodes.isRenamedOrCopied(code) shouldBe false
        }
    }

    @Test
    fun `every code whose discard removes the file is reported as a delete`() {
        // The prompt says "delete" for exactly the rows FileDiscardService revert
        // by removing the file at THIS path: untracked and index-added have no
        // HEAD version, a rename revert removes the new path, a copy revert
        // removes the copy. Omitting R and C is what told the user their file
        // would stay put while the button made it disappear.
        for (code in listOf("?", "??", "A", "AM", "AD", "R", "RM", "C", "CM")) {
            GitStatusCodes.discardDeletesFile(code) shouldBe true
        }
    }

    @Test
    fun `a plain modification or deletion is restored in place, not deleted`() {
        for (code in listOf("M", "MM", "D", " ", "")) {
            GitStatusCodes.discardDeletesFile(code) shouldBe false
        }
    }
}
