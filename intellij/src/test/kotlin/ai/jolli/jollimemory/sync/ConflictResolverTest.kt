package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

class ConflictResolverTest {

	@TempDir
	lateinit var tempDir: Path

	// ── isAggregatePath ────────────────────────────────────────────────

	@Test
	fun `isAggregatePath matches repo-prefixed aggregate files`() {
		assertTrue(isAggregatePath("myrepo/.jolli/manifest.json"))
		assertTrue(isAggregatePath("myrepo/.jolli/index.json"))
		assertTrue(isAggregatePath("myrepo/.jolli/branches.json"))
		assertTrue(isAggregatePath("myrepo/.jolli/catalog.json"))
	}

	@Test
	fun `isAggregatePath matches repos json`() {
		assertTrue(isAggregatePath(".jolli/repos.json"))
	}

	@Test
	fun `isAggregatePath rejects non-aggregate files`() {
		assertFalse(isAggregatePath("myrepo/.jolli/summaries/abc.json"))
		assertFalse(isAggregatePath("manifest.json"))
		assertFalse(isAggregatePath("myrepo/manifest.json"))
	}

	// ── isMemoryBankAppendOnlyPath ─────────────────────────────────────

	@Test
	fun `isMemoryBankAppendOnlyPath accepts 3-segment md paths`() {
		assertTrue(isMemoryBankAppendOnlyPath("repo/main/summary-abc123.md"))
		assertTrue(isMemoryBankAppendOnlyPath("repo/feature-x/plan--task.md"))
	}

	@Test
	fun `isMemoryBankAppendOnlyPath rejects short paths`() {
		assertFalse(isMemoryBankAppendOnlyPath("notes.md"))
		assertFalse(isMemoryBankAppendOnlyPath("repo/notes.md"))
	}

	@Test
	fun `isMemoryBankAppendOnlyPath rejects jolli paths`() {
		assertFalse(isMemoryBankAppendOnlyPath("repo/.jolli/something/file.md"))
	}

	@Test
	fun `isMemoryBankAppendOnlyPath rejects non-md`() {
		assertFalse(isMemoryBankAppendOnlyPath("repo/main/data.json"))
	}

	// ── unionMarkdown ──────────────────────────────────────────────────

	@Test
	fun `unionMarkdown appends with separator`() {
		val result = unionMarkdown("# Ours\nContent A", "# Theirs\nContent B")
		assertTrue(result.contains("Content A"))
		assertTrue(result.contains("Content B"))
		assertTrue(result.contains("---"))
		assertTrue(result.contains("Synced from another device"))
	}

	@Test
	fun `unionMarkdown idempotent when ours contains theirs`() {
		val ours = "# Title\nPart A\nPart B"
		val theirs = "Part A"
		assertEquals(ours, unionMarkdown(ours, theirs))
	}

	@Test
	fun `unionMarkdown idempotent when theirs contains ours`() {
		val ours = "Part A"
		val theirs = "# Title\nPart A\nPart B"
		assertEquals(theirs, unionMarkdown(ours, theirs))
	}

	// ── normalizeForCompare ────────────────────────────────────────────

	@Test
	fun `normalizeForCompare strips CRLF trailing whitespace trailing newlines`() {
		assertEquals(
			normalizeForCompare("hello  \r\nworld\t \n\n"),
			normalizeForCompare("hello\nworld\n"),
		)
	}

	@Test
	fun `normalizeForCompare makes identical content match`() {
		val a = "line1  \nline2\n\n"
		val b = "line1\r\nline2"
		assertEquals(normalizeForCompare(a), normalizeForCompare(b))
	}

	// ── classifyDeleteVsModify ─────────────────────────────────────────

	@Test
	fun `classifyDeleteVsModify respects delete when base matches present`() {
		val result = classifyDeleteVsModify("unchanged content", "unchanged content", "mine-deleted")
		assertTrue(result is SafeHeuristicResult.Delete)
		assertEquals("respect-mine-deleted", (result as SafeHeuristicResult.Delete).via)
	}

	@Test
	fun `classifyDeleteVsModify accepts add when base is null`() {
		val result = classifyDeleteVsModify(null, "new content", "theirs-deleted")
		assertTrue(result is SafeHeuristicResult.Merged)
		assertEquals("new content", (result as SafeHeuristicResult.Merged).merged)
	}

	@Test
	fun `classifyDeleteVsModify returns null on genuine conflict`() {
		val result = classifyDeleteVsModify("base version", "modified version", "mine-deleted")
		assertNull(result)
	}

	// ── Tier 2.7 heuristics (via ConflictResolver.trySafeHeuristics) ──

	@Nested
	inner class SafeHeuristics {

		private fun makeResolver(): ConflictResolver {
			val runner = ScriptedRunner()
			val client = SyncGitClient(
				vaultRoot = tempDir.toString(),
				credentials = fakeCreds(),
				processRunner = runner,
			)
			return ConflictResolver(
				client = client,
				ai = null,
				ui = object : ConflictUi {
					override fun promptBinaryPick(path: String, oursOid: String?, theirsOid: String?) = Tier3Pick.MINE
				},
			)
		}

		@Test
		fun `empty ours picks theirs via trySafeHeuristics`() {
			val resolver = makeResolver()
			val result = resolver.trySafeHeuristics("file.md", null, "  \n  ", "real content")
			assertTrue(result is SafeHeuristicResult.Merged)
			assertEquals("real content", (result as SafeHeuristicResult.Merged).merged)
			assertEquals("empty-mine", result.via)
		}

		@Test
		fun `empty theirs picks ours`() {
			val resolver = makeResolver()
			val result = resolver.trySafeHeuristics("file.md", null, "real content", "  ")
			assertTrue(result is SafeHeuristicResult.Merged)
			assertEquals("real content", (result as SafeHeuristicResult.Merged).merged)
			assertEquals("empty-theirs", result.via)
		}

		@Test
		fun `identical after normalize picks ours`() {
			val resolver = makeResolver()
			val result = resolver.trySafeHeuristics("file.md", null, "hello  \n", "hello\r\n")
			assertTrue(result is SafeHeuristicResult.Merged)
			assertEquals("hello  \n", (result as SafeHeuristicResult.Merged).merged)
			assertEquals("identical-after-normalize", result.via)
		}

		@Test
		fun `append-only md path unions`() {
			val resolver = makeResolver()
			val result = resolver.trySafeHeuristics("repo/main/summary.md", null, "A content", "B content")
			assertTrue(result is SafeHeuristicResult.Merged)
			val merged = (result as SafeHeuristicResult.Merged).merged
			assertTrue(merged.contains("A content"))
			assertTrue(merged.contains("B content"))
			assertEquals("memory-bank-summary-union", result.via)
		}

		@Test
		fun `genuinely different non-md content returns null`() {
			val resolver = makeResolver()
			val result = resolver.trySafeHeuristics("file.txt", null, "version A", "version B")
			assertNull(result)
		}
	}

	// ── Full resolveAll with scripted ProcessRunner ────────────────────

	@Test
	fun `policy MINE resolves without UI via checkoutOurs`() {
		val gitCmds = mutableListOf<List<String>>()
		val runner = ScriptedRunner { args ->
			gitCmds.add(args)
			conflictingStages(args)
		}
		val client = SyncGitClient(
			vaultRoot = tempDir.toString(),
			credentials = fakeCreds(),
			processRunner = runner,
		)
		val resolver = ConflictResolver(
			client = client,
			ai = null,
			ui = object : ConflictUi {
				override fun promptBinaryPick(path: String, oursOid: String?, theirsOid: String?): Tier3Pick {
					throw AssertionError("UI should not be called with MINE policy")
				}
			},
			writeFile = { _, _ -> },
			policy = ConflictPolicy.MINE,
		)

		val report = resolver.resolveAll(listOf("file.md"))
		assertTrue(report.rebaseAdvanced)
		assertEquals(1, report.binaryPicked.size)
		assertEquals("mine", report.binaryPicked[0].pick)
		// checkoutOurs calls `git checkout --theirs` (rebase swap)
		assertTrue(gitCmds.any { it.contains("--theirs") })
	}

	@Test
	fun `skip causes rebaseAbort`() {
		val gitCmds = mutableListOf<List<String>>()
		val runner = ScriptedRunner { args ->
			gitCmds.add(args)
			conflictingStages(args)
		}
		val client = SyncGitClient(
			vaultRoot = tempDir.toString(),
			credentials = fakeCreds(),
			processRunner = runner,
		)
		val resolver = ConflictResolver(
			client = client,
			ai = null,
			ui = object : ConflictUi {
				override fun promptBinaryPick(path: String, oursOid: String?, theirsOid: String?) = Tier3Pick.SKIP
			},
			writeFile = { _, _ -> },
			policy = ConflictPolicy.PROMPT,
		)

		val report = resolver.resolveAll(listOf("file.md"))
		assertFalse(report.rebaseAdvanced)
		assertEquals(1, report.skipped.size)
		assertTrue(gitCmds.any { it.contains("--abort") })
	}

	@Test
	fun `aggregate paths resolve via tier 1-5`() {
		val writes = mutableMapOf<String, String>()
		val gitCmds = mutableListOf<List<String>>()
		val manifestOurs = """{"version":1,"files":[{"path":"a.json","fileId":"f1","type":"commit","fingerprint":"fp","title":"t","source":{"commitHash":"c1","branch":"main","generatedAt":"2024-01-01T00:00:00Z"}}]}"""
		val manifestTheirs = """{"version":1,"files":[{"path":"b.json","fileId":"f2","type":"commit","fingerprint":"fp","title":"t","source":{"commitHash":"c2","branch":"main","generatedAt":"2024-01-02T00:00:00Z"}}]}"""

		val runner = ScriptedRunner { args ->
			// Respond to `git show :<stage>:<path>`
			val showArg = args.find { it.startsWith(":") }
			if (args.contains("show") && showArg != null) {
				if (showArg == ":2:repo/.jolli/manifest.json") {
					return@ScriptedRunner ExecResult(manifestOurs, "", 0)
				}
				if (showArg == ":3:repo/.jolli/manifest.json") {
					return@ScriptedRunner ExecResult(manifestTheirs, "", 0)
				}
				// Stage 1 (base) — not found
				return@ScriptedRunner ExecResult("", "not found", 1)
			}
			gitCmds.add(args)
			ExecResult("", "", 0)
		}
		val client = SyncGitClient(
			vaultRoot = tempDir.toString(),
			credentials = fakeCreds(),
			processRunner = runner,
		)
		val resolver = ConflictResolver(
			client = client,
			ai = null,
			ui = object : ConflictUi {
				override fun promptBinaryPick(path: String, oursOid: String?, theirsOid: String?): Tier3Pick {
					throw AssertionError("UI should not be called for aggregate paths")
				}
			},
			writeFile = { path, content -> writes[path] = content },
			policy = ConflictPolicy.PROMPT,
		)

		val report = resolver.resolveAll(listOf("repo/.jolli/manifest.json"))
		assertTrue(report.rebaseAdvanced)
		assertEquals(1, report.aggregateMerged.size)
		val mergedContent = writes.values.first()
		assertTrue(mergedContent.contains("f1"))
		assertTrue(mergedContent.contains("f2"))
	}

	// ── Helpers ────────────────────────────────────────────────────────

	companion object {
		fun fakeCreds() = GitCredentials(
			gitUrl = "https://example.com/repo.git",
			token = "ghs_test",
			expiresAt = System.currentTimeMillis() + 3_600_000L,
			repoFullName = "test/vault",
			defaultBranch = "main",
			githubRepoCreated = false,
			alreadyVaultBound = true,
			lockOwnerToken = "lock-123",
		)
	}

	/**
	 * A [ProcessRunner] that delegates to a handler function.
	 */
	/**
	 * Scripts `git show :2:<path>` / `:3:<path>` to return distinct, non-empty
	 * index-stage content so a path is a genuine conflict that reaches Tier 3.
	 * Returning empty stdout (the bare default) makes ours == theirs == "", which
	 * Tier 2.7's "identical-after-normalize" rule resolves before Tier 3 runs.
	 * All other git commands succeed with empty output.
	 */
	private fun conflictingStages(args: List<String>): ExecResult {
		// `git show :<stage>:<path>` — scan for the stage token rather than a
		// fixed index: run() prepends git-hardening `-c` flags before the args.
		if (args.contains("show")) {
			if (args.any { it.startsWith(":2:") }) return ExecResult("ours content\n", "", 0)
			if (args.any { it.startsWith(":3:") }) return ExecResult("theirs content\n", "", 0)
		}
		return ExecResult("", "", 0)
	}

	private class ScriptedRunner(
		private val handler: (List<String>) -> ExecResult = { ExecResult("", "", 0) },
	) : ProcessRunner {
		override fun exec(
			command: List<String>,
			cwd: String?,
			env: Map<String, String>,
			timeoutMs: Long?,
		): ExecResult {
			val gitArgs = command.drop(1) // drop "git"
			return handler(gitArgs)
		}
	}
}
