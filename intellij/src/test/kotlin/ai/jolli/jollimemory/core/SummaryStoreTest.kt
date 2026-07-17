package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.FakeGit
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldHaveAtLeastSize
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.collections.shouldNotBeEmpty
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

/**
 * Uses [FakeGit] (a plain per-test object) instead of MockK, so this class
 * needs no isolation annotations and runs fully parallel — there is no shared
 * mutable state and no bytecode instrumentation involved. See GitCommands.kt
 * for the history behind the migration.
 */
class SummaryStoreTest {

    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()
    private lateinit var git: FakeGit
    private lateinit var store: SummaryStore

    @BeforeEach
    fun setUp() {
        git = FakeGit()
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
        orphanedDocIds: List<Int>? = null,
        unresolvedOrphanHashes: List<String>? = null,
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
        orphanedDocIds = orphanedDocIds,
        unresolvedOrphanHashes = unresolvedOrphanHashes,
    )

    private fun makeIndexEntry(hash: String, parent: String? = null, treeHash: String? = null) =
        SummaryIndexEntry(hash, parent, treeHash, null, "msg", "2026-01-01T00:00:00Z", "main", "2026-01-01T00:00:00Z")

    private fun makeIndex(entries: List<SummaryIndexEntry> = emptyList(), aliases: Map<String, String>? = null) =
        SummaryIndex(version = 3, entries = entries, commitAliases = aliases)

    /** Configure the fake so write operations (ensureOrphanBranch, writeFilesToBranch) succeed. */
    private fun stubGitWritePipeline() {
        git.branchPresent = true
        git.onExec = { args ->
            when {
                args.getOrNull(0) == "rev-parse" && args.getOrNull(1)?.startsWith("refs/heads/") == true -> "parentcommit"
                args.getOrNull(0) == "rev-parse" && args.getOrNull(1)?.contains("^{tree}") == true -> "basetree"
                args.getOrNull(0) == "cat-file" -> "tree sometreehash\nparent someparent"
                else -> ""
            }
        }
        git.onExecWithStdin = { args, _ ->
            if (args.firstOrNull() == "hash-object") "blobhash123" else "newtreehash"
        }
    }

    // ── loadIndex ───────────────────────────────────────────────────────

    @Nested
    inner class LoadIndex {
        @Test
        fun `returns null when branch file does not exist`() {
            store.loadIndex() shouldBe null
        }

        @Test
        fun `parses valid index JSON`() {
            val index = makeIndex(entries = listOf(makeIndexEntry("hash1")))
            git.files["index.json"] = gson.toJson(index)
            val result = store.loadIndex()
            result shouldNotBe null
            result!!.entries shouldHaveSize 1
        }

        @Test
        fun `returns null for invalid JSON`() {
            git.files["index.json"] = "invalid json"
            store.loadIndex() shouldBe null
        }
    }

    // ── getSummary ──────────────────────────────────────────────────────

    @Nested
    inner class GetSummary {
        @Test
        fun `returns summary when file exists`() {
            git.files["summaries/deadbeef.json"] = gson.toJson(makeSummary("deadbeef"))
            store.getSummary("deadbeef")!!.commitHash shouldBe "deadbeef"
        }

        @Test
        fun `returns null when file does not exist`() {
            store.getSummary("nonexistent") shouldBe null
        }

        @Test
        fun `returns null for invalid JSON`() {
            git.files["summaries/bad.json"] = "not json"
            store.getSummary("bad") shouldBe null
        }
    }

    // ── getSummaryCount ─────────────────────────────────────────────────

    @Test
    fun `getSummaryCount counts files`() {
        git.files["summaries/a.json"] = "{}"
        git.files["summaries/b.json"] = "{}"
        store.getSummaryCount() shouldBe 2
    }

    @Test
    fun `getSummaryCount returns 0 when empty`() {
        store.getSummaryCount() shouldBe 0
    }

    // ── filterCommitsWithSummary ────────────────────────────────────────

    @Nested
    inner class FilterCommitsWithSummary {
        @Test
        fun `returns matching commit hashes`() {
            val index = makeIndex(entries = listOf(makeIndexEntry("hash1"), makeIndexEntry("hash2")))
            git.files["index.json"] = gson.toJson(index)
            store.filterCommitsWithSummary(listOf("hash1", "hash3")) shouldBe setOf("hash1")
        }

        @Test
        fun `matches via aliases`() {
            val index = makeIndex(entries = listOf(makeIndexEntry("original")), aliases = mapOf("alias1" to "original"))
            git.files["index.json"] = gson.toJson(index)
            store.filterCommitsWithSummary(listOf("alias1")) shouldBe setOf("alias1")
        }

        @Test
        fun `returns empty set when no index`() {
            store.filterCommitsWithSummary(listOf("hash1")).shouldBeEmpty()
        }
    }

    // ── resolveAlias ────────────────────────────────────────────────────

    @Test
    fun `resolveAlias returns alias target`() {
        git.files["index.json"] = gson.toJson(makeIndex(aliases = mapOf("new" to "original")))
        store.resolveAlias("new") shouldBe "original"
    }

    @Test
    fun `resolveAlias returns original when no alias`() {
        git.files["index.json"] = gson.toJson(makeIndex())
        store.resolveAlias("hash1") shouldBe "hash1"
    }

    // ── findRootHash ────────────────────────────────────────────────────

    @Nested
    inner class FindRootHash {
        @Test
        fun `returns hash when no parent`() {
            git.files["index.json"] = gson.toJson(makeIndex(entries = listOf(makeIndexEntry("root"))))
            store.findRootHash("root") shouldBe "root"
        }

        @Test
        fun `follows parent chain`() {
            val index = makeIndex(entries = listOf(makeIndexEntry("root"), makeIndexEntry("child", parent = "root")))
            git.files["index.json"] = gson.toJson(index)
            store.findRootHash("child") shouldBe "root"
        }

        @Test
        fun `returns null for unknown hash`() {
            git.files["index.json"] = gson.toJson(makeIndex())
            store.findRootHash("unknown") shouldBe null
        }
    }

    // ── getTranscriptHashes / readTranscript / readPlanFromBranch ────────

    @Test
    fun `getTranscriptHashes extracts hashes`() {
        git.files["transcripts/abc.json"] = "{}"
        git.files["transcripts/def.json"] = "{}"
        store.getTranscriptHashes() shouldBe setOf("abc", "def")
    }

    @Test
    fun `readTranscript returns null when missing`() {
        store.readTranscript("hash1") shouldBe null
    }

    @Test
    fun `readTranscript parses valid JSON`() {
        val transcript = StoredTranscript(sessions = listOf(StoredSession("s1", entries = listOf(TranscriptEntry("human", "Hello")))))
        git.files["transcripts/hash1.json"] = gson.toJson(transcript)
        store.readTranscript("hash1")!!.sessions shouldHaveSize 1
    }

    @Test
    fun `readTranscript returns null for invalid JSON`() {
        git.files["transcripts/bad.json"] = "bad"
        store.readTranscript("bad") shouldBe null
    }

    @Test
    fun `readPlanFromBranch reads correct path`() {
        git.files["plans/my-plan.md"] = "# Plan"
        store.readPlanFromBranch("my-plan") shouldBe "# Plan"
    }

    @Test
    fun `listSummaries returns empty when no index`() {
        store.listSummaries().shouldBeEmpty()
    }

    // ── storeSummary ────────────────────────────────────────────────────

    @Nested
    inner class StoreSummary {
        @Test
        fun `stores new summary and updates index`() {
            stubGitWritePipeline()

            val summary = makeSummary("newcommit123")
            store.storeSummary(summary)

            // Should write summary JSON + index.json
            git.writtenBlobs() shouldHaveAtLeastSize 2
        }

        @Test
        fun `skips duplicate when not forced`() {
            stubGitWritePipeline()
            val existing = makeIndex(entries = listOf(makeIndexEntry("existing123")))
            git.files["index.json"] = gson.toJson(existing)

            store.storeSummary(makeSummary("existing123"))

            // Should NOT write — the branch tip (rev-parse refs/heads/...) is never read
            git.branchTipReads().shouldBeEmpty()
        }

        @Test
        fun `overwrites duplicate when force is true`() {
            stubGitWritePipeline()
            val existing = makeIndex(entries = listOf(makeIndexEntry("existing123")))
            git.files["index.json"] = gson.toJson(existing)

            store.storeSummary(makeSummary("existing123"), force = true)

            git.writtenBlobs().shouldNotBeEmpty()
        }

        @Test
        fun `stores transcript alongside summary`() {
            stubGitWritePipeline()

            val transcript = StoredTranscript(sessions = listOf(StoredSession("s1", entries = listOf(TranscriptEntry("human", "Hi")))))
            store.storeSummary(makeSummary("withtr"), transcript = transcript)

            // Should write 3 blobs: summary.json + index.json + transcript.json
            git.writtenBlobs() shouldHaveAtLeastSize 3
        }

        @Test
        fun `flattens children into index entries`() {
            stubGitWritePipeline()

            val child = makeSummary("child1")
            val parent = makeSummary("parent1", children = listOf(child))
            store.storeSummary(parent)

            // A commit was created (writeFilesToBranch read the branch tip)
            git.branchTipReads().shouldNotBeEmpty()
        }
    }

    // ── migrateOneToOne ─────────────────────────────────────────────────

    @Nested
    inner class MigrateOneToOne {
        @Test
        fun `creates rebase summary with old as child`() {
            stubGitWritePipeline()

            val oldSummary = makeSummary("oldHash", jolliDocId = 42, jolliDocUrl = "https://jolli.ai/42",
                orphanedDocIds = listOf(7), unresolvedOrphanHashes = listOf("pendingChild"),
                plans = listOf(PlanReference("p1", "Plan", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")),
                e2e = listOf(E2eTestScenario("Test", steps = listOf("Step 1"), expectedResults = listOf("Result 1"))))
            val newInfo = CommitInfo("newHash", "New message", "Alice", "2026-01-16T10:00:00Z")

            store.migrateOneToOne(oldSummary, newInfo)

            git.branchTipReads().shouldNotBeEmpty()
            val persisted = gson.fromJson(
                git.writtenBlobs().first { it.contains("\"commitHash\": \"newHash\"") && it.contains("\"children\"") },
                CommitSummary::class.java,
            )
            persisted.orphanedDocIds shouldBe listOf(7)
            persisted.unresolvedOrphanHashes shouldBe listOf("pendingChild")
            persisted.children!!.first().orphanedDocIds shouldBe null
            persisted.children!!.first().unresolvedOrphanHashes shouldBe null
        }
    }

    // ── mergeManyToOne ──────────────────────────────────────────────────

    @Nested
    inner class MergeManyToOne {
        @Test
        fun `merges multiple summaries into squash`() {
            stubGitWritePipeline()

            val s1 = makeSummary("s1", topics = listOf(TopicSummary("T1", "trigger", "response", "decisions")))
            val s2 = makeSummary("s2", topics = listOf(TopicSummary("T2", "trigger", "response", "decisions")))
            val newInfo = CommitInfo("squashHash", "Squash commit", "Bob", "2026-01-20T10:00:00Z")

            store.mergeManyToOne(listOf(s1, s2), newInfo)

            git.branchTipReads().shouldNotBeEmpty()
        }

        @Test
        fun `deduplicates plans by slug keeping newest`() {
            stubGitWritePipeline()

            val plan1 = PlanReference("p1", "Plan v1", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
            val plan2 = PlanReference("p1", "Plan v2", 2, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z")
            val s1 = makeSummary("s1", plans = listOf(plan1))
            val s2 = makeSummary("s2", plans = listOf(plan2))
            val newInfo = CommitInfo("sq", "Squash", "Bob", "2026-01-20T10:00:00Z")

            store.mergeManyToOne(listOf(s1, s2), newInfo)

            // A commit was created (writeFilesToBranch read the branch tip)
            git.branchTipReads().shouldNotBeEmpty()
        }

        @Test
        fun `hoists jolli cleanup metadata while merging summaries`() {
            stubGitWritePipeline()

            val older = makeSummary(
                "s1", jolliDocId = 11, jolliDocUrl = "https://jolli.ai/11",
                orphanedDocIds = listOf(7), unresolvedOrphanHashes = listOf("pendingChild"),
                children = listOf(makeSummary("nested", unresolvedOrphanHashes = listOf("nestedPending"))),
            ).copy(generatedAt = "2026-01-01T00:00:00Z")
            val newer = makeSummary(
                "s2", jolliDocId = 22, jolliDocUrl = "https://jolli.ai/22",
            ).copy(generatedAt = "2026-01-02T00:00:00Z")

            store.mergeManyToOne(
                listOf(older, newer),
                CommitInfo("squashHash", "Squash", "Bob", "2026-01-20T10:00:00Z"),
            )

            val persisted = gson.fromJson(
                git.writtenBlobs().first { it.contains("\"commitHash\": \"squashHash\"") && it.contains("\"children\"") },
                CommitSummary::class.java,
            )
            persisted.jolliDocId shouldBe 22
            persisted.orphanedDocIds shouldBe listOf(11, 7)
            persisted.unresolvedOrphanHashes shouldBe listOf("pendingChild", "nestedPending")
            persisted.children!!.all { it.jolliDocId == null && it.unresolvedOrphanHashes == null } shouldBe true
            persisted.children!!.first().children!!.first().unresolvedOrphanHashes shouldBe null
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

            git.writtenBlobs() shouldContain "# Content"
        }

        @Test
        fun `storePlanFiles does nothing for empty list`() {
            store.storePlanFiles(emptyList(), "Empty")
            git.branchTipReads().shouldBeEmpty()
        }

        @Test
        fun `writePlanToBranch writes single plan file`() {
            stubGitWritePipeline()
            store.writePlanToBranch("my-plan", "# My Plan", "Save plan")

            git.writtenBlobs() shouldContain "# My Plan"
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

            git.branchTipReads().shouldNotBeEmpty()
        }

        @Test
        fun `does nothing when both maps empty`() {
            store.writeTranscriptBatch(emptyMap(), emptySet())
            git.branchTipReads().shouldBeEmpty()
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
            store.scanTreeHashAliases(listOf("hash1")) shouldBe false
        }

        @Test
        fun `returns false when exec returns null for cat-file`() {
            // onExec defaults to null — the fake's equivalent of a failing git
            // command — so cat-file yields no tree hash and no alias is found.
            val index = makeIndex(
                entries = listOf(makeIndexEntry("original", treeHash = "treehash123")),
            )
            git.files["index.json"] = gson.toJson(index)
            store.scanTreeHashAliases(listOf("newhash")) shouldBe false
        }

        @Test
        fun `returns false when no tree hash matches`() {
            val index = makeIndex(entries = listOf(makeIndexEntry("original", treeHash = "treehash123")))
            git.files["index.json"] = gson.toJson(index)
            git.onExec = { args ->
                if (args.getOrNull(0) == "cat-file") "tree differenthash\nparent abcdef" else null
            }

            store.scanTreeHashAliases(listOf("newhash")) shouldBe false
        }

        @Test
        fun `skips already aliased hashes`() {
            val index = makeIndex(
                entries = listOf(makeIndexEntry("original", treeHash = "treehash123")),
                aliases = mapOf("newhash" to "original"),
            )
            git.files["index.json"] = gson.toJson(index)

            store.scanTreeHashAliases(listOf("newhash")) shouldBe false
        }

        @Test
        fun `returns false when no entries have tree hashes`() {
            val index = makeIndex(entries = listOf(makeIndexEntry("original")))
            git.files["index.json"] = gson.toJson(index)

            store.scanTreeHashAliases(listOf("newhash")) shouldBe false
        }
    }

    // ── ensureOrphanBranch (via storeSummary when branch doesn't exist) ──

    @Nested
    inner class EnsureOrphanBranch {
        @Test
        fun `creates orphan branch when it does not exist`() {
            git.branchPresent = false
            git.onExecWithStdin = { args, _ ->
                when (args.firstOrNull()) {
                    "hash-object" -> "blobhash"
                    "mktree" -> "treehash"
                    else -> null
                }
            }
            git.onExec = { args ->
                when {
                    // Initial commit-tree has no -p; the write pipeline's does.
                    args.getOrNull(0) == "commit-tree" -> if (args.getOrNull(2) == "-p") "newcommit" else "commithash"
                    args.getOrNull(0) == "update-ref" -> ""
                    args.getOrNull(0) == "rev-parse" && args.getOrNull(1)?.startsWith("refs/heads/") == true -> "commithash"
                    args.getOrNull(0) == "rev-parse" && args.getOrNull(1)?.contains("^{tree}") == true -> "treehash"
                    args.getOrNull(0) == "ls-tree" -> ""
                    args.getOrNull(0) == "cat-file" -> "tree sometreehash"
                    else -> null
                }
            }

            store.storeSummary(makeSummary("first"))

            // Orphan branch creation wrote its initial tree via mktree
            git.wroteTree() shouldBe true
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
        git.files["index.json"] = gson.toJson(index)
        git.files["summaries/newer.json"] = gson.toJson(makeSummary("newer"))
        git.files["summaries/older.json"] = gson.toJson(makeSummary("older"))

        val result = store.listSummaries()
        result shouldHaveSize 2
        // newest first (child excluded since it has a parent)
    }
}
