package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class PorcelainParserTest {

	@Test
	fun `empty input returns empty list`() {
		assertEquals(emptyList<PorcelainEntry>(), parsePorcelainZ(""))
	}

	@Test
	fun `parses simple modified entry`() {
		// " M src/foo.kt" — worktree modified, not staged
		val entries = parsePorcelainZ(" M src/foo.kt\u0000")
		assertEquals(1, entries.size)
		val e = entries[0]
		assertEquals(PorcelainStatus.UNCHANGED, e.indexStatus)
		assertEquals(PorcelainStatus.M, e.worktreeStatus)
		assertEquals("src/foo.kt", e.path)
		assertNull(e.oldPath)
	}

	@Test
	fun `parses added entry`() {
		val entries = parsePorcelainZ("A  src/new.kt\u0000")
		assertEquals(1, entries.size)
		assertEquals(PorcelainStatus.A, entries[0].indexStatus)
		assertEquals(PorcelainStatus.UNCHANGED, entries[0].worktreeStatus)
		assertEquals("src/new.kt", entries[0].path)
	}

	@Test
	fun `parses deleted entry`() {
		val entries = parsePorcelainZ("D  old.kt\u0000")
		assertEquals(1, entries.size)
		assertEquals(PorcelainStatus.D, entries[0].indexStatus)
		assertTrue(isDeletion(entries[0]))
	}

	@Test
	fun `parses worktree deletion`() {
		val entries = parsePorcelainZ(" D old.kt\u0000")
		assertEquals(1, entries.size)
		assertEquals(PorcelainStatus.D, entries[0].worktreeStatus)
		assertTrue(isDeletion(entries[0]))
	}

	@Test
	fun `non-deletion entry returns false for isDeletion`() {
		val entries = parsePorcelainZ("M  src/foo.kt\u0000")
		assertFalse(isDeletion(entries[0]))
	}

	@Test
	fun `parses rename with oldPath pairing`() {
		// "R  new-name.kt\0old-name.kt\0"
		val entries = parsePorcelainZ("R  new-name.kt\u0000old-name.kt\u0000")
		assertEquals(1, entries.size)
		assertEquals(PorcelainStatus.R, entries[0].indexStatus)
		assertEquals("new-name.kt", entries[0].path)
		assertEquals("old-name.kt", entries[0].oldPath)
	}

	@Test
	fun `parses copy entry with oldPath`() {
		val entries = parsePorcelainZ("C  copy.kt\u0000original.kt\u0000")
		assertEquals(1, entries.size)
		assertEquals(PorcelainStatus.C, entries[0].indexStatus)
		assertEquals("copy.kt", entries[0].path)
		assertEquals("original.kt", entries[0].oldPath)
	}

	@Test
	fun `parses untracked entry`() {
		val entries = parsePorcelainZ("?? untracked.txt\u0000")
		assertEquals(1, entries.size)
		assertEquals(PorcelainStatus.UNTRACKED, entries[0].indexStatus)
		assertEquals(PorcelainStatus.UNTRACKED, entries[0].worktreeStatus)
	}

	@Test
	fun `parses ignored entry`() {
		val entries = parsePorcelainZ("!! ignored.txt\u0000")
		assertEquals(1, entries.size)
		assertEquals(PorcelainStatus.IGNORED, entries[0].indexStatus)
		assertEquals(PorcelainStatus.IGNORED, entries[0].worktreeStatus)
	}

	@Test
	fun `records shorter than 3 chars are silently dropped`() {
		val entries = parsePorcelainZ("AB\u0000M  valid.kt\u0000")
		assertEquals(1, entries.size)
		assertEquals("valid.kt", entries[0].path)
	}

	@Test
	fun `multiple entries parsed correctly`() {
		val input = "M  a.kt\u0000 D b.kt\u0000A  c.kt\u0000"
		val entries = parsePorcelainZ(input)
		assertEquals(3, entries.size)
		assertEquals("a.kt", entries[0].path)
		assertEquals("b.kt", entries[1].path)
		assertEquals("c.kt", entries[2].path)
	}

	@Test
	fun `unknown status character maps to OTHER`() {
		val entries = parsePorcelainZ("X  weird.kt\u0000")
		assertEquals(1, entries.size)
		assertEquals(PorcelainStatus.OTHER, entries[0].indexStatus)
	}

	@Test
	fun `type changed entry`() {
		val entries = parsePorcelainZ("T  changed.kt\u0000")
		assertEquals(1, entries.size)
		assertEquals(PorcelainStatus.TYPE_CHANGED, entries[0].indexStatus)
	}

	@Test
	fun `unmerged entry`() {
		val entries = parsePorcelainZ("UU conflict.kt\u0000")
		assertEquals(1, entries.size)
		assertEquals(PorcelainStatus.UNMERGED, entries[0].indexStatus)
		assertEquals(PorcelainStatus.UNMERGED, entries[0].worktreeStatus)
	}
}
