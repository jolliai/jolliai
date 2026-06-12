package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class VaultPathClassifierTest {

	// ── Root-level ───────────────────────────────────────────────────

	@Test
	fun `classifies root gitignore`() {
		assertEquals(OwnedPathKind.ROOT_GITIGNORE, classifyVaultPath(".gitignore"))
	}

	@Test
	fun `classifies root repos json`() {
		assertEquals(OwnedPathKind.ROOT_REPOS, classifyVaultPath(".jolli/repos.json"))
	}

	// ── Per-repo aggregates ──────────────────────────────────────────

	@Test
	fun `classifies repo config`() {
		assertEquals(OwnedPathKind.REPO_CONFIG, classifyVaultPath("my-repo/.jolli/config.json"))
	}

	@Test
	fun `classifies repo index`() {
		assertEquals(OwnedPathKind.REPO_INDEX, classifyVaultPath("my-repo/.jolli/index.json"))
	}

	@Test
	fun `classifies repo manifest`() {
		assertEquals(OwnedPathKind.REPO_MANIFEST, classifyVaultPath("my-repo/.jolli/manifest.json"))
	}

	@Test
	fun `classifies repo branches`() {
		assertEquals(OwnedPathKind.REPO_BRANCHES, classifyVaultPath("my-repo/.jolli/branches.json"))
	}

	@Test
	fun `classifies repo catalog`() {
		assertEquals(OwnedPathKind.REPO_CATALOG, classifyVaultPath("my-repo/.jolli/catalog.json"))
	}

	@Test
	fun `classifies repo migration`() {
		assertEquals(OwnedPathKind.REPO_MIGRATION, classifyVaultPath("my-repo/.jolli/migration.json"))
	}

	@Test
	fun `rejects shadow-status json`() {
		assertNull(classifyVaultPath("my-repo/.jolli/shadow-status.json"))
	}

	// ── Per-repo content ─────────────────────────────────────────────

	@Test
	fun `classifies summary`() {
		assertEquals(OwnedPathKind.SUMMARY, classifyVaultPath("my-repo/.jolli/summaries/abc1234.json"))
	}

	@Test
	fun `classifies summary with full SHA-1`() {
		val hash = "a".repeat(40)
		assertEquals(OwnedPathKind.SUMMARY, classifyVaultPath("my-repo/.jolli/summaries/$hash.json"))
	}

	@Test
	fun `rejects summary with too-short hash`() {
		assertNull(classifyVaultPath("my-repo/.jolli/summaries/abc12.json"))
	}

	@Test
	fun `classifies transcript`() {
		assertEquals(OwnedPathKind.TRANSCRIPT, classifyVaultPath("my-repo/.jolli/transcripts/abc1234.json"))
	}

	@Test
	fun `classifies plan`() {
		assertEquals(OwnedPathKind.PLAN, classifyVaultPath("my-repo/.jolli/plans/MyPlan.md"))
	}

	@Test
	fun `classifies plan-progress`() {
		assertEquals(OwnedPathKind.PLAN_PROGRESS, classifyVaultPath("my-repo/.jolli/plan-progress/MyPlan.json"))
	}

	@Test
	fun `classifies note`() {
		assertEquals(OwnedPathKind.NOTE, classifyVaultPath("my-repo/.jolli/notes/my-note.md"))
	}

	// ── Visible markdown ─────────────────────────────────────────────

	@Test
	fun `classifies visible summary`() {
		assertEquals(
			OwnedPathKind.VISIBLE_SUMMARY,
			classifyVaultPath("my-repo/main/fix-bug-a1b2c3d4.md"),
		)
	}

	@Test
	fun `classifies visible plan`() {
		assertEquals(
			OwnedPathKind.VISIBLE_PLAN,
			classifyVaultPath("my-repo/main/plan--MyPlan.md"),
		)
	}

	@Test
	fun `classifies visible note`() {
		assertEquals(
			OwnedPathKind.VISIBLE_NOTE,
			classifyVaultPath("my-repo/main/note--my-note.md"),
		)
	}

	@Test
	fun `visible summary with wrong hex length falls through to user-content`() {
		// The hex part must be exactly 8 chars to be a VISIBLE_SUMMARY, so this
		// fails the strict catalogue check. But the vault is a general working
		// tree, not just a FolderStorage drop, so a safe-segmented .md path
		// rides the user-content fallthrough rather than being rejected.
		// Matches the CLI source of truth (`short-1a2b.md` -> "user-content").
		assertEquals(
			OwnedPathKind.USER_CONTENT,
			classifyVaultPath("my-repo/main/fix-bug-a1b2c3.md"),
		)
	}

	// ── Fallthrough (user-content) ───────────────────────────────────

	@Test
	fun `safe path falls through to user-content`() {
		assertEquals(OwnedPathKind.USER_CONTENT, classifyVaultPath("my-repo/hello.md"))
	}

	@Test
	fun `multi-segment safe path is user-content`() {
		assertEquals(OwnedPathKind.USER_CONTENT, classifyVaultPath("my-repo/notes/a.md"))
	}

	// ── Rejections (null) ────────────────────────────────────────────

	@Test
	fun `rejects empty string`() {
		assertNull(classifyVaultPath(""))
	}

	@Test
	fun `rejects leading slash`() {
		assertNull(classifyVaultPath("/foo/bar.md"))
	}

	@Test
	fun `rejects dot-slash prefix`() {
		assertNull(classifyVaultPath("./foo/bar.md"))
	}

	@Test
	fun `rejects double-dot traversal`() {
		assertNull(classifyVaultPath("my-repo/../etc/passwd"))
	}

	@Test
	fun `rejects backslash`() {
		assertNull(classifyVaultPath("my-repo\\.jolli\\config.json"))
	}

	@Test
	fun `rejects dot-prefixed segment`() {
		assertNull(classifyVaultPath(".hidden/file.md"))
	}

	@Test
	fun `rejects DS_Store`() {
		assertNull(classifyVaultPath(".DS_Store"))
	}

	@Test
	fun `rejects dot-vscode dir`() {
		assertNull(classifyVaultPath(".vscode/settings.json"))
	}

	@Test
	fun `rejects shadow-status in fallthrough`() {
		// Even as a safe-segmented leaf, shadow-status.json is blocked.
		assertNull(classifyVaultPath("my-repo/shadow-status.json"))
	}
}
