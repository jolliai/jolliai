package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class RepoMappingTest {

	@Test
	fun `parseRepoMapping parses valid mapping`() {
		val raw = """{"version":1,"mappings":[{"repoIdentity":"id1","folder":"folder1"}]}"""
		val result = parseRepoMapping(raw)
		assertNotNull(result)
		assertEquals(1, result!!.mappings.size)
		assertEquals("id1", result.mappings[0].repoIdentity)
		assertEquals("folder1", result.mappings[0].folder)
	}

	@Test
	fun `parseRepoMapping returns null on bad version`() {
		assertNull(parseRepoMapping("""{"version":2,"mappings":[]}"""))
	}

	@Test
	fun `parseRepoMapping returns null on invalid json`() {
		assertNull(parseRepoMapping("not json"))
	}

	@Test
	fun `parseRepoMapping returns null on missing mappings`() {
		assertNull(parseRepoMapping("""{"version":1}"""))
	}

	@Test
	fun `serializeRepoMapping produces canonical json with trailing newline`() {
		val mapping = RepoMappingFile(1, listOf(RepoMappingEntry("id1", "f1")))
		val serialized = serializeRepoMapping(mapping)
		assertTrue(serialized.endsWith("\n"))
		assertTrue(serialized.contains("\"repoIdentity\""))
	}

	@Test
	fun `mergeRepoMapping unions by repoIdentity`() {
		val local = RepoMappingFile(1, listOf(RepoMappingEntry("id1", "f1")))
		val remote = RepoMappingFile(1, listOf(RepoMappingEntry("id2", "f2")))
		val (merged, conflicts) = mergeRepoMapping(local, remote)
		assertEquals(2, merged.mappings.size)
		assertTrue(conflicts.isEmpty())
	}

	@Test
	fun `mergeRepoMapping remote overrides local on same identity`() {
		val local = RepoMappingFile(1, listOf(RepoMappingEntry("id1", "old-folder")))
		val remote = RepoMappingFile(1, listOf(RepoMappingEntry("id1", "new-folder")))
		val (merged, _) = mergeRepoMapping(local, remote)
		assertEquals(1, merged.mappings.size)
		assertEquals("new-folder", merged.mappings[0].folder)
	}

	@Test
	fun `mergeRepoMapping detects folder collisions`() {
		val local = RepoMappingFile(1, listOf(RepoMappingEntry("id1", "shared-folder")))
		val remote = RepoMappingFile(1, listOf(RepoMappingEntry("id2", "shared-folder")))
		val (merged, conflicts) = mergeRepoMapping(local, remote)
		assertEquals(2, merged.mappings.size)
		assertEquals(1, conflicts.size)
		assertEquals("shared-folder", conflicts[0].folder)
		assertEquals(listOf("id1", "id2"), conflicts[0].identities)
	}

	@Test
	fun `mergeRepoMapping output sorted by repoIdentity`() {
		val local = RepoMappingFile(1, listOf(RepoMappingEntry("zzz", "f1")))
		val remote = RepoMappingFile(1, listOf(RepoMappingEntry("aaa", "f2")))
		val (merged, _) = mergeRepoMapping(local, remote)
		assertEquals("aaa", merged.mappings[0].repoIdentity)
		assertEquals("zzz", merged.mappings[1].repoIdentity)
	}

	@Test
	fun `mergeRepoMapping folds an SSH-style remote row into the https row for the same repo`() {
		// Local stored its identity via https; another client pushed the SCP/SSH
		// form. They are the same repo and must collapse to one row, not survive
		// as a duplicate (split Memory Bank).
		val local = RepoMappingFile(1, listOf(RepoMappingEntry("https://github.com/jolliai/jolli", "jolli")))
		val remote = RepoMappingFile(1, listOf(RepoMappingEntry("git@github.com:jolliai/jolli", "jolli")))
		val (merged, conflicts) = mergeRepoMapping(local, remote)
		assertEquals(1, merged.mappings.size)
		assertEquals("https://github.com/jolliai/jolli", merged.mappings[0].repoIdentity)
		assertEquals("jolli", merged.mappings[0].folder)
		assertTrue(conflicts.isEmpty())
	}

	@Test
	fun `mergeRepoMapping leaves bare non-URL identities untouched`() {
		// A remote-less fallback identity (folder/repo name) never went through
		// transport folding at compute time, so it must NOT be re-normalized
		// (e.g. `foo.git` must not have its suffix stripped into `foo`).
		val local = RepoMappingFile(1, listOf(RepoMappingEntry("foo.git", "foo-git")))
		val remote = RepoMappingFile(1, listOf(RepoMappingEntry("foo", "foo")))
		val (merged, _) = mergeRepoMapping(local, remote)
		assertEquals(2, merged.mappings.size)
		assertEquals(setOf("foo", "foo.git"), merged.mappings.map { it.repoIdentity }.toSet())
	}

	@Test
	fun `canonicalizeRepoIdentity folds SSH and SCP forms but preserves bare names`() {
		assertEquals("https://github.com/jolliai/jolli", canonicalizeRepoIdentity("git@github.com:jolliai/jolli"))
		assertEquals("https://github.com/jolliai/jolli", canonicalizeRepoIdentity("git@github.com:jolliai/jolli.git"))
		assertEquals("https://github.com/jolliai/jolli", canonicalizeRepoIdentity("https://github.com/jolliai/jolli"))
		// Bare identities are passed through verbatim (gating).
		assertEquals("foo.git", canonicalizeRepoIdentity("foo.git"))
		assertEquals("my-repo", canonicalizeRepoIdentity("my-repo"))
	}
}
