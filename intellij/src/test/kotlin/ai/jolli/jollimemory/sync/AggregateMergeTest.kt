package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class AggregateMergeTest {

	// ── mergeManifest ──────────────────────────────────────────────────

	@Test
	fun `mergeManifest unions by fileId`() {
		val local = listOf(
			ManifestEntry("a.json", "f1", "commit", "fp1", "title1",
				ManifestSource("c1", "main", "2024-01-01T00:00:00Z")),
		)
		val remote = listOf(
			ManifestEntry("b.json", "f2", "commit", "fp2", "title2",
				ManifestSource("c2", "main", "2024-01-02T00:00:00Z")),
		)
		val merged = mergeManifest(local, remote)
		assertEquals(2, merged.size)
		assertEquals("f1", merged[0].fileId)
		assertEquals("f2", merged[1].fileId)
	}

	@Test
	fun `mergeManifest newer generatedAt wins on same fileId`() {
		val local = listOf(
			ManifestEntry("a.json", "f1", "commit", "fp1", "old",
				ManifestSource("c1", "main", "2024-01-01T00:00:00Z")),
		)
		val remote = listOf(
			ManifestEntry("a.json", "f1", "commit", "fp1", "new",
				ManifestSource("c1", "main", "2024-01-02T00:00:00Z")),
		)
		val merged = mergeManifest(local, remote)
		assertEquals(1, merged.size)
		assertEquals("new", merged[0].title)
	}

	@Test
	fun `mergeManifest ties keep local`() {
		val local = listOf(
			ManifestEntry("a.json", "f1", "commit", "fp1", "local",
				ManifestSource("c1", "main", "2024-01-01T00:00:00Z")),
		)
		val remote = listOf(
			ManifestEntry("a.json", "f1", "commit", "fp1", "remote",
				ManifestSource("c1", "main", "2024-01-01T00:00:00Z")),
		)
		val merged = mergeManifest(local, remote)
		assertEquals("local", merged[0].title)
	}

	@Test
	fun `mergeManifest output sorted by fileId`() {
		val local = listOf(
			ManifestEntry("z.json", "z1", "commit", "fp", "z",
				ManifestSource("c1", "main", "2024-01-01T00:00:00Z")),
		)
		val remote = listOf(
			ManifestEntry("a.json", "a1", "commit", "fp", "a",
				ManifestSource("c1", "main", "2024-01-01T00:00:00Z")),
		)
		val merged = mergeManifest(local, remote)
		assertEquals("a1", merged[0].fileId)
		assertEquals("z1", merged[1].fileId)
	}

	// ── mergeIndex ─────────────────────────────────────────────────────

	@Test
	fun `mergeIndex unions by commitHash`() {
		val local = listOf(indexEntry("aaa", parent = null, generatedAt = "2024-01-01T00:00:00Z"))
		val remote = listOf(indexEntry("bbb", parent = null, generatedAt = "2024-01-01T00:00:00Z"))
		val merged = mergeIndex(local, remote)
		assertEquals(2, merged.size)
	}

	@Test
	fun `mergeIndex parent trumps no-parent`() {
		val local = listOf(indexEntry("aaa", parent = null, generatedAt = "2024-01-02T00:00:00Z"))
		val remote = listOf(indexEntry("aaa", parent = "ppp", generatedAt = "2024-01-01T00:00:00Z"))
		val merged = mergeIndex(local, remote)
		assertEquals(1, merged.size)
		assertEquals("ppp", merged[0].parentCommitHash)
	}

	@Test
	fun `mergeIndex both have parent newer wins`() {
		val local = listOf(indexEntry("aaa", parent = "p1", generatedAt = "2024-01-01T00:00:00Z"))
		val remote = listOf(indexEntry("aaa", parent = "p2", generatedAt = "2024-01-02T00:00:00Z"))
		val merged = mergeIndex(local, remote)
		assertEquals("p2", merged[0].parentCommitHash)
	}

	@Test
	fun `mergeIndex sorted by commitHash`() {
		val local = listOf(indexEntry("zzz", parent = null, generatedAt = "2024-01-01T00:00:00Z"))
		val remote = listOf(indexEntry("aaa", parent = null, generatedAt = "2024-01-01T00:00:00Z"))
		val merged = mergeIndex(local, remote)
		assertEquals("aaa", merged[0].commitHash)
		assertEquals("zzz", merged[1].commitHash)
	}

	// ── mergeBranches ──────────────────────────────────────────────────

	@Test
	fun `mergeBranches unions and remote overrides`() {
		val local = listOf(
			BranchEntry("main-folder", "main", "2024-01-01T00:00:00Z"),
			BranchEntry("dev-folder", "dev", "2024-01-01T00:00:00Z"),
		)
		val remote = listOf(
			BranchEntry("main-updated", "main", "2024-01-02T00:00:00Z"),
			BranchEntry("feat-folder", "feat", "2024-01-01T00:00:00Z"),
		)
		val merged = mergeBranches(local, remote)
		assertEquals(3, merged.size)
		// Remote overrides local for "main"
		val mainEntry = merged.first { it.branch == "main" }
		assertEquals("main-updated", mainEntry.folder)
	}

	@Test
	fun `mergeBranches sorted by branch`() {
		val local = listOf(BranchEntry("z", "z-branch", "2024-01-01T00:00:00Z"))
		val remote = listOf(BranchEntry("a", "a-branch", "2024-01-01T00:00:00Z"))
		val merged = mergeBranches(local, remote)
		assertEquals("a-branch", merged[0].branch)
		assertEquals("z-branch", merged[1].branch)
	}

	// ── mergeCatalog ───────────────────────────────────────────────────

	@Test
	fun `mergeCatalog unions and remote overrides`() {
		val local = listOf(CatalogEntry("aaa", "local recap", "", emptyList()))
		val remote = listOf(
			CatalogEntry("aaa", "remote recap", "", emptyList()),
			CatalogEntry("bbb", "new recap", "", emptyList()),
		)
		val merged = mergeCatalog(local, remote)
		assertEquals(2, merged.size)
		assertEquals("remote recap", merged.first { it.commitHash == "aaa" }.recap)
	}

	// ── canonicalBranchFolder ──────────────────────────────────────────

	@Test
	fun `canonicalBranchFolder slugifies`() {
		assertEquals("feature-foo", canonicalBranchFolder("feature/foo"))
		assertEquals("main", canonicalBranchFolder("main"))
		assertEquals("branch", canonicalBranchFolder("///"))
		assertEquals("branch", canonicalBranchFolder(""))
	}

	// ── tryAggregateMerge ──────────────────────────────────────────────

	@Test
	fun `tryAggregateMerge merges manifest json`() {
		val ours = """{"version":1,"files":[{"path":"a.json","fileId":"f1","type":"commit","fingerprint":"fp","title":"t","source":{"commitHash":"c1","branch":"main","generatedAt":"2024-01-01T00:00:00Z"}}]}"""
		val theirs = """{"version":1,"files":[{"path":"b.json","fileId":"f2","type":"commit","fingerprint":"fp","title":"t","source":{"commitHash":"c2","branch":"main","generatedAt":"2024-01-02T00:00:00Z"}}]}"""
		val result = tryAggregateMerge("repo/.jolli/manifest.json", ours, theirs)
		assertNotNull(result)
		assertTrue(result!!.contains("f1"))
		assertTrue(result.contains("f2"))
	}

	@Test
	fun `tryAggregateMerge returns null on invalid json`() {
		val result = tryAggregateMerge("repo/.jolli/manifest.json", "not json", "{}")
		assertNull(result)
	}

	// ── isAggregatePath ────────────────────────────────────────────────

	@Test
	fun `isAggregatePath recognizes aggregate files`() {
		assertTrue(isAggregatePath("repo/.jolli/manifest.json"))
		assertTrue(isAggregatePath("repo/.jolli/index.json"))
		assertTrue(isAggregatePath("repo/.jolli/branches.json"))
		assertTrue(isAggregatePath("repo/.jolli/catalog.json"))
		assertTrue(isAggregatePath(".jolli/repos.json"))
		assertFalse(isAggregatePath("repo/.jolli/summaries/abc.json"))
		assertFalse(isAggregatePath("manifest.json"))
	}

	// ── emptyAggregateEnvelope ─────────────────────────────────────────

	@Test
	fun `emptyAggregateEnvelope returns valid empty envelopes`() {
		assertTrue(emptyAggregateEnvelope(".jolli/repos.json").contains("mappings"))
		assertTrue(emptyAggregateEnvelope("repo/.jolli/manifest.json").contains("files"))
		assertTrue(emptyAggregateEnvelope("repo/.jolli/index.json").contains("entries"))
		assertTrue(emptyAggregateEnvelope("repo/.jolli/branches.json").contains("mappings"))
		assertTrue(emptyAggregateEnvelope("repo/.jolli/catalog.json").contains("entries"))
	}

	// ── helpers ────────────────────────────────────────────────────────

	private fun indexEntry(hash: String, parent: String?, generatedAt: String) =
		IndexEntry(hash, parent, "tree", "commit", "msg", "2024-01-01T00:00:00Z", "main", generatedAt)
}
