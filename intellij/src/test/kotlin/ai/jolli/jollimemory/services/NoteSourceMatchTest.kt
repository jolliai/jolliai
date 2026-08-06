package ai.jolli.jollimemory.services

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

/**
 * Locks down [noteSourceWasSaved], the membership test that decides whether a
 * batch of saved `.md` files touched a note's source file.
 *
 * Every case here is a string comparison with `caseSensitive` passed explicitly,
 * so the Windows and macOS behaviours are both reachable from a Linux runner —
 * which is the point: the bug this guards shipped precisely because the platform
 * where it fails is not the platform the suite runs on.
 *
 * Pure string classification: no Project, no VFS, no JVM globals, so this runs
 * under the default parallel-tests policy.
 */
class NoteSourceMatchTest {

    // What IntelliJ's VFS reports: forward slashes on every OS, including Windows.
    private val vfsWindows = "C:/Users/dev/notes/design.md"
    private val vfsPosix = "/home/dev/notes/design.md"

    // What the CLI stored: `File.absolutePath` / `uri.fsPath`, i.e. OS-native.
    private val nativeWindows = "C:\\Users\\dev\\notes\\design.md"

    @Test
    fun `windows native note path matches the forward-slashed VFS path`() {
        noteSourceWasSaved(
            notePaths = listOf(nativeWindows),
            touched = setOf(vfsWindows),
            caseSensitive = false,
        ) shouldBe true
    }

    @Test
    fun `windows path with a differently-cased drive letter still matches`() {
        // VS Code's `uri.fsPath` lower-cases the drive letter, so a note added
        // there and edited in this IDE differs by case alone.
        noteSourceWasSaved(
            notePaths = listOf("c:\\Users\\dev\\notes\\design.md"),
            touched = setOf(vfsWindows),
            caseSensitive = false,
        ) shouldBe true
    }

    @Test
    fun `posix paths match unchanged on a case-sensitive filesystem`() {
        noteSourceWasSaved(
            notePaths = listOf(vfsPosix),
            touched = setOf(vfsPosix),
            caseSensitive = true,
        ) shouldBe true
    }

    @Test
    fun `case difference does NOT match on a case-sensitive filesystem`() {
        // Two genuinely distinct files on Linux — folding here would be a false
        // positive, so the case-sensitive branch must stay strict.
        noteSourceWasSaved(
            notePaths = listOf("/home/dev/notes/Design.md"),
            touched = setOf(vfsPosix),
            caseSensitive = true,
        ) shouldBe false
    }

    @Test
    fun `case difference DOES match on a case-insensitive filesystem`() {
        noteSourceWasSaved(
            notePaths = listOf("/Users/dev/notes/Design.md"),
            touched = setOf("/Users/dev/notes/design.md"),
            caseSensitive = false,
        ) shouldBe true
    }

    @Test
    fun `an unrelated markdown save does not match`() {
        noteSourceWasSaved(
            notePaths = listOf(nativeWindows),
            touched = setOf("C:/Users/dev/README.md"),
            caseSensitive = false,
        ) shouldBe false
    }

    @Test
    fun `matches when the note is one of several in the batch`() {
        noteSourceWasSaved(
            notePaths = listOf("/home/dev/other.md", vfsPosix),
            touched = setOf("/home/dev/README.md", vfsPosix),
            caseSensitive = true,
        ) shouldBe true
    }

    @Test
    fun `a snippet note with no backing file is skipped, not matched`() {
        // `NoteInfo.filePath` is nullable — a snippet whose file was cleaned up
        // reports null, and a null must never be treated as a wildcard.
        noteSourceWasSaved(
            notePaths = listOf(null),
            touched = setOf(vfsPosix),
            caseSensitive = true,
        ) shouldBe false
    }

    @Test
    fun `an empty touched set short-circuits to false`() {
        noteSourceWasSaved(
            notePaths = listOf(vfsPosix),
            touched = emptySet(),
            caseSensitive = true,
        ) shouldBe false
    }

    @Test
    fun `no notes means nothing to match`() {
        noteSourceWasSaved(
            notePaths = emptyList(),
            touched = setOf(vfsPosix),
            caseSensitive = true,
        ) shouldBe false
    }
}
