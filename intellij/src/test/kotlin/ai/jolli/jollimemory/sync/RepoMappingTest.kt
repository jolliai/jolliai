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
}
