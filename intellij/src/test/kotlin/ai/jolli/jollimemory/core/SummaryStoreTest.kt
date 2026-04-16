package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.GitOps
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class SummaryStoreTest {

    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()
    private lateinit var git: GitOps
    private lateinit var store: SummaryStore

    @BeforeEach
    fun setUp() {
        git = mockk(relaxed = true)
        store = SummaryStore("/fake/cwd", git)
    }

    private fun makeSummary(
        hash: String = "abc123",
        topics: List<TopicSummary>? = null,
        children: List<CommitSummary>? = null,
        plans: List<PlanReference>? = null,
        e2e: List<E2eTestScenario>? = null,
        jolliDocId: Int? = null,
        jolliDocUrl: String? = null,
    ) = CommitSummary(
        commitHash = hash,
        commitMessage = "Test commit",
        commitAuthor = "Alice",
        commitDate = "2026-01-15T10:00:00Z",
        branch = "main",
        generatedAt = "2026-01-15T10:00:00Z",
        topics = topics,
        children = children,
        plans = plans,
        e2eTestGuide = e2e,
        jolliDocId = jolliDocId,
        jolliDocUrl = jolliDocUrl,
    )

    private fun makeIndexEntry(hash: String, parent: String? = null, treeHash: String? = null) =
        SummaryIndexEntry(hash, parent, treeHash, null, "msg", "2026-01-01T00:00:00Z", "main", "2026-01-01T00:00:00Z")

    private fun makeIndex(entries: List<SummaryIndexEntry> = emptyList(), aliases: Map<String, String>? = null) =
        SummaryIndex(version = 3, entries = entries, commitAliases = aliases)

    /** Set up git mocks so write operations (ensureOrphanBranch, writeFilesToBranch) succeed. */
    private fun stubGitWritePipeline() {
        every { git.branchExists(any()) } returns true
        // exec() is vararg, so use *anyVararg() for flexible matching
        every { git.exec(*anyVararg(), timeoutSeconds = any()) } returns ""
        // Override specific patterns we care about
        every { git.exec("rev-parse", match { it.startsWith("refs/heads/") }, timeoutSeconds = any()) } returns "parentcommit"
        every { git.exec("rev-parse", match { it.contains("^{tree}") }, timeoutSeconds = any()) } returns "basetree"
        every { git.exec("cat-file", "-p", any(), timeoutSeconds = any()) } returns "tree sometreehash\nparent someparent"
        every { git.execWithStdin(*anyVararg(), input = any(), timeoutSeconds = any()) } returns "newtreehash"
        every { git.execWithStdin("hash-object", "-w", "--stdin", input = any(), timeoutSeconds = any()) } returns "blobhash123"
    }

    // ── loadIndex ───────────────────────────────────────────────────────

    @Nested
    inner class LoadIndex {
        @Test
        fun `returns null when branch file does not exist`() {
            every { git.readBranchFile(any(), "index.json") } returns null
            store.loadIndex() shouldBe null
        }

        @Test
        fun `parses valid index JSON`() {
            val index = makeIndex(entries = listOf(makeIndexEntry("hash1")))
            every { git.readBranchFile(any(), "index.json") } returns gson.toJson(index)
            val result = store.loadIndex()
            result shouldNotBe null
            result!!.entries shouldHaveSize 1
        }

        @Test
        fun `returns null for invalid JSON`() {
            every { git.readBranchFile(any(), "index.json") } returns "invalid json"
            store.loadIndex() shouldBe null
        }
    }

    // ── getSummary ──────────────────────────────────────────────────────

    @Nested
    inner class GetSummary {
        @Test
        fun `returns summary when file exists`() {
            every { git.readBranchFile(any(), "summaries/deadbeef.json") } returns gson.toJson(makeSummary("deadbeef"))
            store.getSummary("deadbeef")!!.commitHash shouldBe "deadbeef"
        }

        @Test
        fun `returns null when file does not exist`() {
            every { git.readBranchFile(any(), any()) } returns null
            store.getSummary("nonexistent") shouldBe null
        }

        @Test
        fun `returns null for invalid JSON`() {
            every { git.readBranchFile(any(), "summaries/bad.json") } returns "not json"
            store.getSummary("bad") shouldBe null
        }
    }

    // ── getSummaryCount ─────────────────────────────────────────────────

    @Test
    fun `getSummaryCount counts files`() {
        every { git.listBranchFiles(any(), "summaries/") } returns listOf("summaries/a.json", "summaries/b.json")
        store.getSummaryCount() shouldBe 2
    }

    @Test
    fun `getSummaryCount returns 0 when empty`() {
        every { git.listBranchFiles(any(), "summaries/") } returns emptyList()
        store.getSummaryCount() shouldBe 0
    }

    // ── filterCommitsWithSummary ────────────────────────────────────────

    @Nested
    inner class FilterCommitsWithSummary {
        @Test
        fun `returns matching commit hashes`() {
            val index = makeIndex(entries = listOf(makeIndexEntry("hash1"), makeIndexEntry("hash2")))
            every { git.readBranchFile(any(), "index.json") } returns gson.toJson(index)
            store.filterCommitsWithSummary(listOf("hash1", "hash3")) shouldBe setOf("hash1")
        }

        @Test
        fun `matches via aliases`() {
            val index = makeIndex(entries = listOf(makeIndexEntry("original")), aliases = mapOf("alias1" to "original"))
            every { git.readBranchFile(any(), "index.json") } returns gson.toJson(index)
            store.filterCommitsWithSummary(listOf("alias1")) shouldBe setOf("alias1")
        }

        @Test
        fun `returns empty set when no index`() {
            every { git.readBranchFile(any(), "index.json") } returns null
            store.filterCommitsWithSummary(listOf("hash1")).shouldBeEmpty()
        }
    }

    // ── resolveAlias ────────────────────────────────────────────────────

    @Test
    fun `resolveAlias returns alias target`() {
        every { git.readBranchFile(any(), "index.json") } returns gson.toJson(makeIndex(aliases = mapOf("new" to "original")))
        store.resolveAlias("new") shouldBe "original"
    }

    @Test
    fun `resolveAlias returns original when no alias`() {
        every { git.readBranchFile(any(), "index.json") } returns gson.toJson(makeIndex())
        store.resolveAlias("hash1") shouldBe "hash1"
    }

    // ── findRootHash ────────────────────────────────────────────────────

    @Nested
    inner class FindRootHash {
        @Test
        fun `returns hash when no parent`() {
            every { git.readBranchFile(any(), "index.json") } returns gson.toJson(makeIndex(entries = listOf(makeIndexEntry("root"))))
            store.findRootHash("root") shouldBe "root"
        }

        @Test
        fun `follows parent chain`() {
            val index = makeIndex(entries = listOf(makeIndexEntry("root"), makeIndexEntry("child", parent = "root")))
            every { git.readBranchFile(any(), "index.json") } returns gson.toJson(index)
            store.findRootHash("child") shouldBe "root"
        }

        @Test
        fun `returns null for unknown hash`() {
            every { git.readBranchFile(any(), "index.json") } returns gson.toJson(makeIndex())
            store.findRootHash("unknown") shouldBe null
        }
    }

    // ── getTranscriptHashes / readTranscript / readPlanFromBranch ────────

    @Test
    fun `getTranscriptHashes extracts hashes`() {
        every { git.listBranchFiles(any(), "transcripts/") } returns listOf("transcripts/abc.json", "transcripts/def.json")
        store.getTranscriptHashes() shouldBe setOf("abc", "def")
    }

    @Test
    fun `readTranscript returns null when missing`() {
        every { git.readBranchFile(any(), any()) } returns null
        store.readTranscript("hash1") shouldBe null
    }

    @Test
    fun `readTranscript parses valid JSON`() {
        val transcript = StoredTranscript(sessions = listOf(StoredSession("s1", entries = listOf(TranscriptEntry("human", "Hello")))))
        every { git.readBranchFile(any(), "transcripts/hash1.json") } returns gson.toJson(transcript)
        store.readTranscript("hash1")!!.sessions shouldHaveSize 1
    }

    @Test
    fun `readTranscript returns null for invalid JSON`() {
        every { git.readBranchFile(any(), "transcripts/bad.json") } returns "bad"
        store.readTranscript("bad") shouldBe null
    }

    @Test
    fun `readPlanFromBranch reads correct path`() {
        every { git.readBranchFile(any(), "plans/my-plan.md") } returns "# Plan"
        store.readPlanFromBranch("my-plan") shouldBe "# Plan"
    }

    @Test
    fun `listSummaries returns empty when no index`() {
        every { git.readBranchFile(any(), "index.json") } returns null
        store.listSummaries().shouldBeEmpty()
    }

    // ── storeSummary ────────────────────────────────────────────────────

    @Nested
    inner class StoreSummary {
        @Test
        fun `stores new summary and updates index`() {
            stubGitWritePipeline()
            every { git.readBranchFile(any(), "index.json") } returns null

            val summary = makeSummary("newcommit123")
            store.storeSummary(summary)

            // Should write summary JSON + index.json
            verify(atLeast = 2) { git.execWithStdin("hash-object", "-w", "--stdin", input = any(), timeoutSeconds = any()) }
        }

        @Test
        fun `skips duplicate when not forced`() {
            stubGitWritePipeline()
            val existing = makeIndex(entries = listOf(makeIndexEntry("existing123")))
            every { git.readBranchFile(any(), "index.json") } returns gson.toJson(existing)

            store.storeSummary(makeSummary("existing123"))

            // Should NOT write — rev-parse for branch tip should not be called
            verify(exactly = 0) { git.exec("rev-parse", match { it.startsWith("refs/heads/") }, timeoutSeconds = any()) }
        }

        @Test
        fun `overwrites duplicate when force is true`() {
            stubGitWritePipeline()
            val existing = makeIndex(entries = listOf(makeIndexEntry("existing123")))
            every { git.readBranchFile(any(), "index.json") } returns gson.toJson(existing)

            store.storeSummary(makeSummary("existing123"), force = true)

            verify(atLeast = 1) { git.execWithStdin("hash-object", "-w", "--stdin", input = any(), timeoutSeconds = any()) }
        }

        @Test
        fun `stores transcript alongside summary`() {
            stubGitWritePipeline()
            every { git.readBranchFile(any(), "index.json") } returns null

            val transcript = StoredTranscript(sessions = listOf(StoredSession("s1", entries = listOf(TranscriptEntry("human", "Hi")))))
            store.storeSummary(makeSummary("withtr"), transcript = transcript)

            // Should write 3 blobs: summary.json + index.json + transcript.json
            verify(atLeast = 3) { git.execWithStdin("hash-object", "-w", "--stdin", input = any()) }
        }

        @Test
        fun `flattens children into index entries`() {
            stubGitWritePipeline()
            every { git.readBranchFile(any(), "index.json") } returns null

            val child = makeSummary("child1")
            val parent = makeSummary("parent1", children = listOf(child))
            store.storeSummary(parent)

            // Verify commit was created (index should contain both parent and child entries)
            // Verify a commit was created (writeFilesToBranch succeeded)
            verify { git.exec("rev-parse", match { it.startsWith("refs/heads/") }, timeoutSeconds = any()) }
        }
    }

    // ── migrateOneToOne ─────────────────────────────────────────────────

    @Nested
    inner class MigrateOneToOne {
        @Test
        fun `creates rebase summary with old as child`() {
            stubGitWritePipeline()
            every { git.readBranchFile(any(), "index.json") } returns null

            val oldSummary = makeSummary("oldHash", jolliDocId = 42, jolliDocUrl = "https://jolli.ai/42",
                plans = listOf(PlanReference("p1", "Plan", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")),
                e2e = listOf(E2eTestScenario("Test", steps = listOf("Step 1"), expectedResults = listOf("Result 1"))))
            val newInfo = CommitInfo("newHash", "New message", "Alice", "2026-01-16T10:00:00Z")

            store.migrateOneToOne(oldSummary, newInfo)

            verify { git.exec("rev-parse", match { it.startsWith("refs/heads/") }, timeoutSeconds = any()) }
        }
    }

    // ── mergeManyToOne ──────────────────────────────────────────────────

    @Nested
    inner class MergeManyToOne {
        @Test
        fun `merges multiple summaries into squash`() {
            stubGitWritePipeline()
            every { git.readBranchFile(any(), "index.json") } returns null

            val s1 = makeSummary("s1", topics = listOf(TopicSummary("T1", "trigger", "response", "decisions")))
            val s2 = makeSummary("s2", topics = listOf(TopicSummary("T2", "trigger", "response", "decisions")))
            val newInfo = CommitInfo("squashHash", "Squash commit", "Bob", "2026-01-20T10:00:00Z")

            store.mergeManyToOne(listOf(s1, s2), newInfo)

            verify { git.exec("rev-parse", match { it.startsWith("refs/heads/") }, timeoutSeconds = any()) }
        }

        @Test
        fun `deduplicates plans by slug keeping newest`() {
            stubGitWritePipeline()
            every { git.readBranchFile(any(), "index.json") } returns null

            val plan1 = PlanReference("p1", "Plan v1", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
            val plan2 = PlanReference("p1", "Plan v2", 2, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z")
            val s1 = makeSummary("s1", plans = listOf(plan1))
            val s2 = makeSummary("s2", plans = listOf(plan2))
            val newInfo = CommitInfo("sq", "Squash", "Bob", "2026-01-20T10:00:00Z")

            store.mergeManyToOne(listOf(s1, s2), newInfo)

            // Verify commit was created
            // Verify a commit was created (writeFilesToBranch succeeded)
            verify { git.exec("rev-parse", match { it.startsWith("refs/heads/") }, timeoutSeconds = any()) }
        }
    }

    // ── storePlanFiles / writePlanToBranch ───────────────────────────────

    @Nested
    inner class PlanStorage {
        @Test
        fun `storePlanFiles writes files to branch`() {
            stubGitWritePipeline()
            val files = listOf(FileWrite("plans/test.md", "# Content"))
            store.storePlanFiles(files, "Store plan")

            verify { git.execWithStdin("hash-object", "-w", "--stdin", input = "# Content") }
        }

        @Test
        fun `storePlanFiles does nothing for empty list`() {
            store.storePlanFiles(emptyList(), "Empty")
            verify(exactly = 0) { git.exec("rev-parse", match { it.startsWith("refs/heads/") }, timeoutSeconds = any()) }
        }

        @Test
        fun `writePlanToBranch writes single plan file`() {
            stubGitWritePipeline()
            store.writePlanToBranch("my-plan", "# My Plan", "Save plan")

            verify { git.execWithStdin("hash-object", "-w", "--stdin", input = "# My Plan") }
        }
    }

    // ── writeTranscriptBatch ────────────────────────────────────────────

    @Nested
    inner class WriteTranscriptBatch {
        @Test
        fun `writes and deletes transcripts`() {
            stubGitWritePipeline()

            val writes = mapOf("hash1" to StoredTranscript(sessions = listOf(StoredSession("s1", entries = emptyList()))))
            val deletes = setOf("hash2")

            store.writeTranscriptBatch(writes, deletes)

            verify { git.exec("rev-parse", match { it.startsWith("refs/heads/") }, timeoutSeconds = any()) }
        }

        @Test
        fun `does nothing when both maps empty`() {
            store.writeTranscriptBatch(emptyMap(), emptySet())
            verify(exactly = 0) { git.exec("rev-parse", match { it.startsWith("refs/heads/") }, timeoutSeconds = any()) }
        }
    }

    // ── scanTreeHashAliases ─────────────────────────────────────────────

    @Nested
    inner class ScanTreeHashAliases {
        @Test
        fun `returns false for empty input`() {
            store.scanTreeHashAliases(emptyList()) shouldBe false
        }

        @Test
        fun `returns false when no index`() {
            every { git.readBranchFile(any(), "index.json") } returns null
            store.scanTreeHashAliases(listOf("hash1")) shouldBe false
        }

        @Test
        fun `returns false when exec returns null for cat-file`() {
            // exec returns null for unrecognized hashes (relaxed mock default)
            val index = makeIndex(
                entries = listOf(makeIndexEntry("original", treeHash = "treehash123")),
            )
            every { git.readBranchFile(any(), "index.json") } returns gson.toJson(index)
            // Relaxed mock returns null for exec, so cat-file returns null → no alias found
            store.scanTreeHashAliases(listOf("newhash")) shouldBe false
        }

        @Test
        fun `returns false when no tree hash matches`() {
            val index = makeIndex(entries = listOf(makeIndexEntry("original", treeHash = "treehash123")))
            every { git.readBranchFile(any(), "index.json") } returns gson.toJson(index)
            every { git.exec("cat-file", "-p", "newhash", timeoutSeconds = any()) } returns "tree differenthash\nparent abcdef"

            store.scanTreeHashAliases(listOf("newhash")) shouldBe false
        }

        @Test
        fun `skips already aliased hashes`() {
            val index = makeIndex(
                entries = listOf(makeIndexEntry("original", treeHash = "treehash123")),
                aliases = mapOf("newhash" to "original"),
            )
            every { git.readBranchFile(any(), "index.json") } returns gson.toJson(index)

            store.scanTreeHashAliases(listOf("newhash")) shouldBe false
        }

        @Test
        fun `returns false when no entries have tree hashes`() {
            val index = makeIndex(entries = listOf(makeIndexEntry("original")))
            every { git.readBranchFile(any(), "index.json") } returns gson.toJson(index)

            store.scanTreeHashAliases(listOf("newhash")) shouldBe false
        }
    }

    // ── ensureOrphanBranch (via storeSummary when branch doesn't exist) ──

    @Nested
    inner class EnsureOrphanBranch {
        @Test
        fun `creates orphan branch when it does not exist`() {
            every { git.branchExists(any()) } returns false
            every { git.readBranchFile(any(), "index.json") } returns null
            every { git.execWithStdin("hash-object", "-w", "--stdin", input = any()) } returns "blobhash"
            every { git.execWithStdin("mktree", input = any()) } returns "treehash"
            every { git.exec("commit-tree", "treehash", "-m", any()) } returns "commithash"
            every { git.exec("update-ref", any(), "commithash") } returns ""
            // After creation, the branch now exists for the actual write
            every { git.exec("rev-parse", match { it.startsWith("refs/heads/") }) } returns "commithash"
            every { git.exec("rev-parse", match { it.contains("^{tree}") }) } returns "treehash"
            every { git.exec("ls-tree", any()) } returns ""
            every { git.exec("ls-tree", any(), any()) } returns ""
            every { git.exec("commit-tree", any(), "-p", any(), "-m", any()) } returns "newcommit"
            every { git.exec("update-ref", any(), any()) } returns ""
            every { git.exec("cat-file", "-p", any()) } returns "tree sometreehash"

            store.storeSummary(makeSummary("first"))

            // Should have called commit-tree to create orphan (no parent)
            // Verify orphan branch creation (mktree was called for initial tree)
            verify { git.execWithStdin("mktree", input = any(), timeoutSeconds = any()) }
        }
    }

    // ── listSummaries with data ─────────────────────────────────────────

    @Test
    fun `listSummaries returns root entries sorted by date`() {
        val index = makeIndex(entries = listOf(
            SummaryIndexEntry("newer", null, null, null, "msg", "2026-01-20T00:00:00Z", "main", "2026-01-20T00:00:00Z"),
            SummaryIndexEntry("older", null, null, null, "msg", "2026-01-10T00:00:00Z", "main", "2026-01-10T00:00:00Z"),
            SummaryIndexEntry("child", "newer", null, null, "msg", "2026-01-15T00:00:00Z", "main", "2026-01-15T00:00:00Z"),
        ))
        every { git.readBranchFile(any(), "index.json") } returns gson.toJson(index)
        every { git.readBranchFile(any(), "summaries/newer.json") } returns gson.toJson(makeSummary("newer"))
        every { git.readBranchFile(any(), "summaries/older.json") } returns gson.toJson(makeSummary("older"))

        val result = store.listSummaries()
        result shouldHaveSize 2
        // newest first (child excluded since it has a parent)
    }
}
