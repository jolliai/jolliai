package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class AllowListTest {

	private val optsOn = AllowListOpts(syncTranscripts = true)
	private val optsOff = AllowListOpts(syncTranscripts = false)

	// ── Content area ─────────────────────────────────────────────────

	@Test
	fun `allows md files`() {
		assertTrue(isAllowedPath("repo/main/summary.md", optsOn))
	}

	@Test
	fun `allows json files`() {
		assertTrue(isAllowedPath("repo/data.json", optsOn))
	}

	@Test
	fun `rejects txt files`() {
		assertFalse(isAllowedPath("repo/readme.txt", optsOn))
	}

	@Test
	fun `rejects files with no extension`() {
		assertFalse(isAllowedPath("repo/Makefile", optsOn))
	}

	// ── .jolli/ subtree ──────────────────────────────────────────────

	@Test
	fun `allows aggregate files`() {
		assertTrue(isAllowedPath(".jolli/index.json", optsOn))
		assertTrue(isAllowedPath(".jolli/manifest.json", optsOn))
		assertTrue(isAllowedPath(".jolli/branches.json", optsOn))
		assertTrue(isAllowedPath(".jolli/catalog.json", optsOn))
		assertTrue(isAllowedPath(".jolli/repos.json", optsOn))
		assertTrue(isAllowedPath(".jolli/config.json", optsOn))
	}

	@Test
	fun `rejects unknown files under jolli root`() {
		assertFalse(isAllowedPath(".jolli/unknown.json", optsOn))
	}

	@Test
	fun `allows summaries with valid hash`() {
		assertTrue(isAllowedPath(".jolli/summaries/abc1234.json", optsOn))
	}

	@Test
	fun `rejects summaries with short hash`() {
		assertFalse(isAllowedPath(".jolli/summaries/abc.json", optsOn))
	}

	@Test
	fun `allows transcripts when enabled`() {
		assertTrue(isAllowedPath(".jolli/transcripts/abc1234.json", optsOn))
	}

	@Test
	fun `rejects transcripts when disabled`() {
		assertFalse(isAllowedPath(".jolli/transcripts/abc1234.json", optsOff))
	}

	@Test
	fun `allows plans`() {
		assertTrue(isAllowedPath(".jolli/plans/MyPlan.md", optsOn))
	}

	@Test
	fun `allows plan-progress`() {
		assertTrue(isAllowedPath(".jolli/plan-progress/MyPlan.json", optsOn))
	}

	@Test
	fun `allows notes`() {
		assertTrue(isAllowedPath(".jolli/notes/my-note.md", optsOn))
	}

	// ── Dot-prefixed rejection ───────────────────────────────────────

	@Test
	fun `rejects dot-prefixed directories`() {
		assertFalse(isAllowedPath(".git/config", optsOn))
		assertFalse(isAllowedPath(".vscode/settings.json", optsOn))
	}

	@Test
	fun `rejects dot-prefixed files`() {
		assertFalse(isAllowedPath(".DS_Store", optsOn))
		assertFalse(isAllowedPath(".gitignore", optsOn)) // AllowList doesn't know about root gitignore
	}

	// ── Empty / bare ─────────────────────────────────────────────────

	@Test
	fun `rejects empty path`() {
		assertFalse(isAllowedPath("", optsOn))
	}

	@Test
	fun `rejects bare jolli directory`() {
		assertFalse(isAllowedPath(".jolli", optsOn))
	}

	// ── Backslash separator ──────────────────────────────────────────

	@Test
	fun `handles backslash separators`() {
		assertTrue(isAllowedPath(".jolli\\summaries\\abc1234.json", optsOn))
	}
}
